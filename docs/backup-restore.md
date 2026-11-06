# Document security, backups and restore

This covers client document encryption, the 30-day "Recently deleted" list, the independent
nightly backups, restore testing and key management. Everything in
the Owner's Office pages described here is **owner only** (the primary owner, Tabitha). No
permission grant opens them.

| Owner's Office tab | What it does |
|---|---|
| **Backups** | The "Nightly backups" switch, settings checklist, backup runs, restore tests, key escrow and rotation |
| **Recently deleted** | Deleted documents, kept 30 days: Restore, or Delete permanently now |
| **File encryption** | Dry run, the encryption job (in batches), failures, and originals waiting for removal |

---

## 1. Encryption at rest

* Every file the app stores is encrypted with AES-256-GCM before it reaches Netlify Blobs. That
  covers every document category (bank statements, payroll registers, signed contracts and
  agreements, tax returns, identity documents, client uploads, Jotform attachments, statement
  retrieval, nonprofit portfolio files), sign-up uploads held before an account exists, flyers and
  consent evidence, and the owner's receipts. A test (`tests/doc-security.test.ts`) fails if any
  `storage.put` in `src/` writes bytes that aren't encrypted.
* Format `TCE2` = magic(4) + key id(4) + IV(12) + GCM tag(16) + ciphertext: **36 bytes of
  overhead per file.** Measured locally, encryption takes about 1 ms per MB. Files written before
  this release are plaintext (`encrypted=false`) and still open. Older encrypted identity
  documents (`TCE1`, 32 bytes of overhead) also still open.
* `StoredFile.keyVersion` records which key wrote the file. It holds a fingerprint
  (`k` + 8 hex characters), never the key.
* Keys are derived from `APP_ENCRYPTION_KEY` (the "file", "enc" and "sign" subkeys). During a
  rotation, `APP_ENCRYPTION_KEY_PREVIOUS` is tried automatically for files and for MFA secrets.

### Encrypting existing files (migration runbook)

The job **never runs on deploy**. It runs only when the owner starts it in Owner's Office → File
encryption, or from the CLI.

1. **Dry run.** Open File encryption. The table shows the file count and bytes by record type, in
   processing order. Nothing is read or changed to build it. CLI equivalent: `npm run files:encrypt`.
2. **Choose the order.** By default, records that exist only in Client Connect go first: bank
   statements, nonprofit documents, bookkeeping records, payroll registers, then correspondence
   attachments. You can change the order on the page or with `--order`.
3. **Start.** Each batch handles up to 50 files, or about 15 seconds of work. For each file:
   1. read the stored bytes;
   2. encrypt them;
   3. write them to a **new** key (the original is never overwritten);
   4. read the new copy back, decrypt it, and check its sha256 against the recorded sha256;
   5. in one transaction, point the record at the new key and set `encrypted=true`;
   6. record the original key in `PendingOriginalRemoval`.

   If a file fails (the original can't be read, the fingerprint doesn't match, or the new copy
   doesn't verify), the original and the record stay untouched. The failure is listed and the file
   is retried on the next batch, up to 5 attempts.
4. **Keep pressing "Run a batch"** until nothing is left. The job can be paused at any time and
   resumes where it stopped. CLI equivalent: `npm run files:encrypt -- --run --yes`. Use the page
   for production: the CLI needs Netlify Blobs access and is meant for local and staging databases.
5. **Originals.** Originals are removed only by a separate owner action ("Remove eligible
   originals", typed confirmation). It is allowed only for files moved **at least 30 days ago**
   whose encrypted copy is in a **successful backup**.

Re-encrypting after a key rotation uses the same job in mode "Re-encrypt to the current key"
(`--mode REKEY`).

---

## 2. Recoverable deletion (30 days)

* An Admin's **Delete** no longer removes the file. The document disappears from every staff and
  client list at once (existing `deletedAt` filters), goes to **Recently deleted**, and gets
  `purgeAfter` set to deletion time + 30 days. The visibility it had before deletion is recorded.
* **Restore** (owner only) puts the document back with its earlier visibility. It is recorded in
  the audit log, the document access log (`RESTORE`) and the owner log.
* **Delete permanently now** (owner only) needs the typed phrase `DELETE PERMANENTLY` and a
  reason. It removes the file now, along with any plaintext original the encryption job kept,
  and keeps the record and its history.
* The **nightly purge** runs after each successful backup. It removes bytes only for documents
  past `purgeAfter` whose file is confirmed in at least one successful backup. Each purge is
  logged (`document.purged`, access-log `PURGE`). If backups are off, nothing is ever purged.
* Copies of purged files stay in the backup bucket for as long as a retained backup lists them,
  which can be up to 7 years through the year-end backups. See "Decisions" below.
* Malware-infected files are still destroyed at once (unchanged). Deletions made before this
  release had already removed their files, so they don't appear in Recently deleted.

---

## 3. Nightly backups

### What is backed up

* **Database:** every table, meaning every Prisma model plus Prisma's implicit join tables such
  as `_MessageAttachments`. Rows are exported in primary-key order as NDJSON chunks of 2,000 rows,
  then gzip-compressed and encrypted. Migration bookkeeping tables are left out.
* **Documents:** incremental. Only stored files not already in `BackupFileIndex` (by storage key
  and sha256) are uploaded. Records that exist only in Client Connect go first.
* **Manifest** (one per night, encrypted). It records the backup format, the last migration
  name, a schema fingerprint, the app key version and the backup key id, the row count and sha256
  of every chunk (plaintext and object), and the **full list of files at that point**. Any night
  can be restored on its own.

### Encryption

Every object in the bucket is sealed with AES-256-GCM under `BACKUP_ENCRYPTION_KEY`
(`TCB1` + key id + IV + tag, 36 bytes of overhead). This key is separate from the app key. The
app refuses to run a backup if the two keys are the same, and neither key is ever stored in the
bucket. Documents are encrypted twice: the app key inside, the backup key outside.

Bucket layout:

```
runs/<YYYY-MM-DD>_<runId>/db/<Table>/<00000>.ndjson.gz.tcb
runs/<YYYY-MM-DD>_<runId>/manifest.json.tcb
files/<sha256(storage key)>.tcb
```

### Schedule and time limits

* `netlify/functions/backup-nightly.mts` is a scheduled function. It runs at 07:00–10:00 UTC,
  which covers 2:00 AM Central in both CST and CDT, and then starts the **background function**
  `backup-runner-background.mts` (up to 15 minutes) with `CRON_SECRET`.
* The background function calls `POST /api/cron/backup` (also protected by `CRON_SECRET`) in a
  loop. Each call does about 15 seconds of work and saves a resumable cursor (`BackupRun.phase` +
  `cursor`), so it fits any function time limit. A run that is cut off resumes on the next hourly
  call. A lease keeps two callers from working on the same run.
* The site starts a run only after 2:00 AM office time, and only if none has run that day. A
  failed night gets one more attempt.
* Backups run only when **every BACKUP_\* setting is present and the owner's "Nightly backups"
  switch is on**.

### Retention

| Kept | How long |
|---|---|
| Every nightly backup | 35 days |
| The last backup of each month | 12 months |
| The last backup of each year | 7 years |

Pruning runs after each successful backup. It deletes only objects outside this policy. It never
deletes the newest successful backup, and never deletes an object before its lock date. File
objects are deleted only when no retained night lists them.

### Object Lock (ransomware and accident protection)

* Every object is written with `ObjectLockMode` and `ObjectLockRetainUntilDate` (backup date +
  36 days). Month-end and year-end backups have their locks extended to 12 months and 7 years.
  Locks on live file objects are rolled forward each night.
* `BACKUP_OBJECT_LOCK_MODE` = `GOVERNANCE` (the default) or `COMPLIANCE`. Use `OFF` only for a
  provider without per-object locks (see below).
* **Owner setup at the provider (required):**
  * **AWS S3:** create the bucket with **Versioning** and **Object Lock** enabled. A default
    retention of 35 days in COMPLIANCE mode is recommended.
  * **Backblaze B2:** create the bucket with **Object Lock** enabled (B2 enables versioning
    automatically). It is reached through its S3 endpoint (`https://s3.<region>.backblazeb2.com`).
  * **Cloudflare R2:** R2 has **bucket-level lock rules** but no per-object lock headers. Set an R2
    lock rule of at least 35 days on the bucket, enable versioning if your plan has it, and set
    `BACKUP_OBJECT_LOCK_MODE=OFF`.
* **Credentials are write-only.** The app's key should be able to `PutObject`, `GetObject`,
  `ListBucket` and `PutObjectRetention`, and `DeleteObject` only for pruning. It must **not** have
  `s3:BypassGovernanceRetention`, `PutBucketObjectLockConfiguration`, `PutBucketVersioning`,
  `DeleteObjectVersion` or any bucket-policy permission. With locks and versioning on, those
  credentials can't delete or overwrite a locked object, even if they're stolen. Example AWS
  policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["s3:PutObject", "s3:GetObject", "s3:PutObjectRetention", "s3:DeleteObject"], "Resource": "arn:aws:s3:::YOUR-BUCKET/*" },
    { "Effect": "Allow", "Action": ["s3:ListBucket"], "Resource": "arn:aws:s3:::YOUR-BUCKET" },
    { "Effect": "Deny", "Action": ["s3:BypassGovernanceRetention", "s3:DeleteObjectVersion", "s3:PutBucketObjectLockConfiguration", "s3:PutBucketVersioning", "s3:PutBucketPolicy", "s3:DeleteBucket"], "Resource": ["arn:aws:s3:::YOUR-BUCKET", "arn:aws:s3:::YOUR-BUCKET/*"] }
  ]
}
```

On B2, create an application key limited to the bucket, with `writeFiles`, `readFiles`,
`listFiles` and `writeFileRetentions`. Leave out `bypassGovernance` and `deleteFiles` if you
accept that pruning will leave old objects for the provider's lifecycle rules.

### Records and alerts

* Each run records its start and finish times, rows, files (and how many were new), bytes
  uploaded, result and error. They appear on the Backups page.
* The owner gets a **high-priority task**, plus an email if email is configured, when a nightly
  backup fails or when no backup has succeeded in 48 hours. Each alert is sent at most once a day.

---

## 4. Restore

### Restore test (verify), each quarter

The app creates a quarterly task, "Quarterly restore test: run restore-verify". A passed test
closes it. If the last passed test is more than 100 days old, the owner gets a high-priority alert.
The Backups page shows the last successful test and the next due date. Every test is recorded in
`RestoreTest` (date, backup used, mode, result) for the WISP.

* **From the Backups page:** "Verify the latest backup" downloads the newest successful backup,
  decrypts it, checks every database chunk and every file against the manifest's sha256, and
  restores the files into a throwaway in-memory store. It restores the database into
  `RESTORE_SCRATCH_DATABASE_URL` if that is set (never the live database). Otherwise it counts
  rows from the decrypted chunks. It then opens sample documents (decrypt + sha256), always
  including one from each record type that exists only in Client Connect.
* **From the CLI (the full check):**

```bash
createdb crm_restore_check            # an EMPTY local database; migrations are applied automatically
BACKUP_S3_ENDPOINT=… BACKUP_S3_REGION=… BACKUP_S3_BUCKET=… \
BACKUP_S3_ACCESS_KEY_ID=… BACKUP_S3_SECRET_ACCESS_KEY=… \
BACKUP_ENCRYPTION_KEY=… APP_ENCRYPTION_KEY=… \
npm run backup -- verify --scratch-database-url postgresql://…@localhost:5432/crm_restore_check \
  --scratch-dir ./restore-check-files [--backup latest|<manifest key>] [--sample 10]
```

Verify refuses any database that isn't local, and any database that is the app's own.

### Full restore (disaster recovery), step by step

1. **Stop writes.** Put the site in maintenance (or pause deploys) so nothing writes to the old
   database.
2. **Get the keys from escrow:** `BACKUP_ENCRYPTION_KEY` and `APP_ENCRYPTION_KEY`, plus
   `APP_ENCRYPTION_KEY_PREVIOUS` if a rotation was in progress. Without the app key, documents
   can't be recovered.
3. **List backups** (works without the app database):
   `npm run backup -- list` → choose a manifest key (the newest is first).
4. **Prepare an empty target database** with the schema at the backup's migration. A new Netlify
   Database branch, or a new Postgres, migrated to the "last migration" printed in the report.
   The restore refuses any database that holds records (users, clients, documents, files, audit
   log, contacts, invoices, journal entries). Default rows the migrations insert are replaced by
   the backup's rows.
5. **Run the restore:**

```bash
npm run backup -- full --backup <manifest key> \
  --database-url "<target database URL>" --blob-dir ./restored-blobs --confirm-restore \
  [--i-understand-this-overwrites-production]   # only if the target is the production database
```

   A production target (`NETLIFY_DB_URL`, `PRODUCTION_DATABASE_URL`, or any non-local host) is
   refused unless `--i-understand-this-overwrites-production` is passed **and** the database is
   empty. The report lists chunks and files checked, row counts per table, and the sample
   documents opened.
6. **Upload the files** in `./restored-blobs` to Netlify Blobs under the same keys. Keys starting
   `client_document/` go to the `client-connect-documents` store, `owner_private/` to
   `client-connect-owner`, and everything else to `client-connect-files`. Use
   `netlify blobs:set <store> <key> --input <file>` for each file, or a short script using
   `@netlify/blobs` with the site ID and a personal access token. The restore never overwrites an
   existing file.
7. **Set the keys in Netlify** (the same `APP_ENCRYPTION_KEY` as before), redeploy, sign in, and
   open a few documents from each category.
8. **Record it:** run `verify` against a scratch copy, or note the full restore in the WISP log.

### Restore drill (local, fictional data)

```bash
createdb crm_drill && DATABASE_URL=postgresql://…/crm_drill npm run db:migrate:local
createdb crm_drill_scratch
export DATABASE_URL=postgresql://…/crm_drill APP_ENCRYPTION_KEY=<drill key> BACKUP_ENCRYPTION_KEY=<different drill key>
npm run drill:seed                                    # fictional clients + documents in every category
npm run files:encrypt && npm run files:encrypt -- --run --yes
npm run backup -- backup --target-dir ./drill-bucket  # a local folder that behaves like a bucket
npm run backup -- verify --target-dir ./drill-bucket \
  --scratch-database-url postgresql://…/crm_drill_scratch --scratch-dir ./drill-restored
```

`tests/backup.test.ts` → "full recovery" runs the same thing automatically on every test run.

---

## 5. Keys

* `APP_ENCRYPTION_KEY` and `BACKUP_ENCRYPTION_KEY` live **only** in Netlify's environment
  (Functions scope, marked secret) and in the owner's offline escrow. Never put them in the
  bucket, in email, or in the repository.
* **Restores need BOTH keys.** The backup key opens the backup. The documents inside are still
  encrypted with the app key. **If APP_ENCRYPTION_KEY is lost, the documents can't be recovered
  from any backup.**

### Offline escrow checklist

* [ ] Two sealed copies of both keys (printed, or an encrypted password-manager export).
* [ ] Held in two separate places, for example the office safe and a bank safe-deposit box.
* [ ] Each envelope dated and signed across the seal. Neither is kept with the bucket credentials.
* [ ] Redone after every key rotation. Old envelopes are kept until every backup that needs the
      old key has aged out (up to 7 years), then destroyed.
* [ ] Recorded on the Backups page: "Key escrow confirmed on [date]" (owner attestation).

### Rotating the app key

1. Generate a new random value (32+ characters). Put it in escrow **first**.
2. In Netlify, move the current value to `APP_ENCRYPTION_KEY_PREVIOUS` and set the new value as
   `APP_ENCRYPTION_KEY`. Redeploy. Everything still opens, and new files use the new key.
3. Owner's Office → File encryption → mode **Re-encrypt to the current key**: run batches until
   nothing is left (`npm run files:encrypt -- --mode REKEY --run --yes` on a local copy).
4. MFA secrets encrypted with the old key still open through the previous key. To retire it,
   staff re-enroll two-step verification, or keep the previous key set.
5. After a successful backup and a passed restore test, remove `APP_ENCRYPTION_KEY_PREVIOUS`.
   Older backups still hold files encrypted with the old key: **keep its escrow copy** until those
   backups age out.

Rotating the backup key: set a new `BACKUP_ENCRYPTION_KEY`. New backups use it. Older backups
still need the old key, so keep it in escrow until they age out. The manifest records the backup
key id, so the right envelope can be found.

---

## 6. Settings the owner adds in Netlify

| Variable | Notes |
|---|---|
| `BACKUP_S3_ENDPOINT` | e.g. `https://s3.us-east-1.amazonaws.com`, `https://s3.us-west-004.backblazeb2.com`, `https://<account>.r2.cloudflarestorage.com` |
| `BACKUP_S3_REGION` | e.g. `us-east-1` (`auto` for R2) |
| `BACKUP_S3_BUCKET` | The bucket name (versioning + Object Lock on) |
| `BACKUP_S3_ACCESS_KEY_ID` / `BACKUP_S3_SECRET_ACCESS_KEY` | Write-only credentials (above) |
| `BACKUP_ENCRYPTION_KEY` | 32+ random characters, different from `APP_ENCRYPTION_KEY` |
| `BACKUP_OBJECT_LOCK_MODE` | Optional: `GOVERNANCE` (default), `COMPLIANCE`, or `OFF` (R2) |
| `RESTORE_SCRATCH_DATABASE_URL` | Optional: a scratch database for page-run restore checks |
| `APP_ENCRYPTION_KEY_PREVIOUS` | Only during a key rotation |

The Backups page shows which of these are set, never their values.

---

## 7. Estimating storage and cost

Run `npm run storage:report` against a **local** copy (it refuses production). It prints the
document count and bytes by record type, the database size, the measured export compression
ratio, the per-file encryption overhead, and the projection below.

```
Backup storage ≈ D + x·7 + 365·c·y          documents (stored once, incremental)
               + 54 · r · S                 database copies (35 daily + 12 month-end + 7 year-end)
               + 54 · F · m                 manifests
               + 72 · F                     encryption overhead (36 app + 36 backup bytes per file)

D = document bytes today          c = new document bytes per day     y = years ahead
x = bytes deleted per year (kept while a year-end backup lists them, up to 7 years)
S = database size (pg_database_size)          r = compressed export ÷ S (measured; ~0.1–0.3)
F = number of files                           m = manifest bytes per file per copy (~100–150)
```

Monthly cost ≈ total GB × price per GB-month (roughly: Backblaze B2 $0.006, Cloudflare R2 $0.015,
AWS S3 Standard $0.023, storage only; check current prices). Example: 50 GB of documents, a 2 GB
database with r = 0.2, 100,000 files, 1 GB deleted a year → 50 + 7 + 21.6 + 0.7 + 0.007 ≈ 79 GB
at seven years of deletions, or about $0.47/month on B2 and $1.82/month on S3.
