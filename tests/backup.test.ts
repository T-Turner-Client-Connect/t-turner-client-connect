import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { makeUser, prisma, resetDb } from "./db";
import { createScratchDb, scratchUrl, wipe } from "./scratch-db";
import { createClient } from "@/lib/services/clients";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { portalUploadDocument, readDocumentBytes, staffUploadDocument, deleteDocument } from "@/lib/services/documents";
import { ensureClientPerson, uploadIdentityDocument } from "@/lib/services/identity";
import { storage, createLocalStorage, createMemoryStorage } from "@/lib/storage";
import { decryptBytes, looksEncrypted } from "@/lib/crypto";
import { openBackup, sealBackup } from "@/lib/backup/crypto";
import { LockedObjectError, MemoryTarget, setBackupTargetForTests } from "@/lib/backup/target";
import { backupTick, pruneBackups, runBackupToCompletion, startBackupRun, stepBackupRun } from "@/lib/backup/runner";
import { classifyRuns } from "@/lib/backup/retention";
import { listTables } from "@/lib/backup/db";
import { fullRestore, isProductionDatabaseUrl, listBackups, loadManifest, verifyBackupInto, assertScratchTarget } from "@/lib/backup/restore";
import { BACKUP_FAILED_TITLE, BACKUP_STALE_TITLE, checkBackupAlerts, recordRestoreTest, RESTORE_STALE_TITLE, RESTORE_TASK_TITLE, setNightlyBackups } from "@/lib/services/backups";
import { runEncryptionBatch, startEncryptionJob } from "@/lib/services/file-encryption";
import { estimateBackupStorage } from "@/lib/backup/estimate";
import { ONLY_IN_CLIENT_CONNECT } from "@/lib/doc-security/inventory";
import { setReturnGate } from "@/lib/services/return-gate";

// Placeholder PDFs here carry no return text; the return upload gate itself is tested in return-gate.test.ts.
beforeEach(() => setReturnGate(async () => "VERIFIED"));
afterEach(() => setReturnGate(null));

let seq = 0;
const pdf = (tag = "") => new TextEncoder().encode(`%PDF-1.4\n% fictional ${tag} ${seq++} ${Math.random()}\n`);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const BACKUP_KEY = "backup-only-test-key-0123456789abcdefXYZ";

let scratch: PrismaClient;
beforeAll(async () => {
  scratch = await createScratchDb();
}, 300_000);
afterAll(async () => {
  await scratch?.$disconnect();
});

let target: MemoryTarget;
function backupEnv() {
  vi.stubEnv("BACKUP_S3_ENDPOINT", "https://s3.example.test");
  vi.stubEnv("BACKUP_S3_REGION", "us-east-1");
  vi.stubEnv("BACKUP_S3_BUCKET", "fictional-backups");
  vi.stubEnv("BACKUP_S3_ACCESS_KEY_ID", "test-access-key");
  vi.stubEnv("BACKUP_S3_SECRET_ACCESS_KEY", "test-secret-key");
  vi.stubEnv("BACKUP_ENCRYPTION_KEY", BACKUP_KEY);
}
beforeEach(async () => {
  await resetDb();
  await wipe(scratch);
  backupEnv();
  target = new MemoryTarget();
  setBackupTargetForTests(target);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  setBackupTargetForTests(null);
});

async function office() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const client = await createClient(tabitha, { businessName: "Pretend Lantern Works LLC", clientType: "BUSINESS", status: "ACTIVE" });
  return { tabitha, client };
}

/** A file stored the old way (plaintext), as production holds today. */
async function legacy(clientId: string, actorId: string, category: "TAXES" | "BOOKKEEPING" | "PAYROLL" | "OTHER", docType: string | null, year: number) {
  const bytes = pdf(`legacy-${category}-${docType}`);
  const storageKey = `client_document/legacy-${seq++}-${Date.now()}`;
  await storage.put(storageKey, bytes);
  const file = await prisma.storedFile.create({ data: { kind: "CLIENT_DOCUMENT", storageKey, originalName: "old.pdf", title: "old", mimeType: "application/pdf", sizeBytes: bytes.length, sha256: sha(bytes), uploadedById: actorId } });
  const doc = await prisma.document.create({ data: { clientId, category, docType, year, title: `Legacy ${category} ${docType ?? ""}`, visibility: "STAFF_ONLY", fileId: file.id, scanStatus: "CLEAN", uploadedByStaffId: actorId } });
  await prisma.documentAccessLog.create({ data: { documentId: doc.id, action: "UPLOAD", staffUserId: actorId } });
  await prisma.auditLog.create({ data: { actorId, action: "document.uploaded", entityType: "Document", entityId: doc.id, clientId } });
  return doc;
}

describe("nightly backup", () => {
  it("is off unless every BACKUP_* setting is present AND the owner's switch is on", async () => {
    const o = await office();
    expect(await backupTick()).toMatchObject({ state: "idle", reason: /switched off/ });
    vi.stubEnv("BACKUP_S3_BUCKET", "");
    expect(await backupTick()).toMatchObject({ state: "idle", reason: /isn't configured/ });
    await expect(setNightlyBackups(o.tabitha, true)).rejects.toThrow(/BACKUP_\*/);
    backupEnv();
    await setNightlyBackups(o.tabitha, true);
    // Not due before 2:00 AM Central (07:30 UTC in November = 1:30 AM CST).
    expect(await backupTick({ now: new Date("2026-11-05T07:30:00Z") })).toMatchObject({ state: "idle", reason: /Nothing due/ });
    const r = await backupTick({ now: new Date("2026-11-05T08:05:00Z") });
    expect(["progress", "done"]).toContain(r.state);
    expect(await prisma.backupRun.count({ where: { backupDate: "2026-11-05", trigger: "NIGHTLY" } })).toBe(1);
  });

  it("exports every table to encrypted, compressed NDJSON chunks with a manifest of sha256s — sealed with the backup key, not the app key", async () => {
    const o = await office();
    await staffUploadDocument(o.tabitha, { clientId: o.client.id, category: "TAXES", visibility: "STAFF_ONLY", bytes: pdf("w2"), originalName: "w2.pdf" });
    const r = await runBackupToCompletion();
    expect(r.state).toBe("done");
    expect(r.run.status).toBe("SUCCEEDED");
    const [b] = await listBackups(target);
    const m = await loadManifest(target, b.key, r.run.manifestSha256);
    // Every Prisma model's table is in the backup.
    const modelTables = Prisma.dmmf.datamodel.models.map((x) => x.dbName ?? x.name);
    for (const t of modelTables) expect(m.tables.map((x) => x.name)).toContain(t);
    // Prisma's implicit many-to-many tables (message attachments) are data too.
    expect(m.tables.map((x) => x.name)).toContain("_MessageAttachments");
    expect(m.tables.some((x) => /migration/i.test(x.name))).toBe(false);
    expect(m.tables.map((t) => t.name).sort()).toEqual((await listTables(prisma)).sort());
    // The newest migration in the tree (this PR's is 20261107650000_document_security until a later one lands).
    expect(m.lastMigration).toBe(readdirSync(path.join(process.cwd(), "netlify/database/migrations")).sort().at(-1));
    expect(m.lastMigration! >= "20261107650000_document_security").toBe(true);
    for (const t of m.tables) {
      // The backup's own bookkeeping tables change while it runs; every other table matches exactly.
      if (!t.name.startsWith("Backup")) expect(t.rows).toBe(Number((await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint n FROM "${t.name}"`))[0].n));
      for (const c of t.chunks) {
        const obj = target.objects.get(c.key)!;
        expect(sha(obj.body)).toBe(c.objectSha256);
        expect(Buffer.from(obj.body.subarray(0, 4)).toString()).toBe("TCB1");
        // The app key can't open a backup object.
        expect(() => decryptBytes(obj.body)).toThrow();
        const nd = gunzipSync(openBackup(obj.body));
        expect(sha(nd)).toBe(c.sha256);
        expect(Buffer.from(nd).toString().trim().split("\n")).toHaveLength(c.rows);
      }
    }
    // Wrong backup key: refused.
    vi.stubEnv("BACKUP_ENCRYPTION_KEY", "a-different-backup-key-0123456789abcdef");
    expect(() => openBackup(target.objects.get(m.tables[0].chunks[0]?.key ?? b.key)!.body)).toThrow(/different BACKUP_ENCRYPTION_KEY/);
    backupEnv();
    // Documents: backup key outside, app key inside.
    const f = m.files[0];
    const inner = openBackup(target.objects.get(f.objectKey)!.body);
    expect(looksEncrypted(inner)).toBe(true);
    expect(sha(decryptBytes(inner))).toBe(f.plainSha256);
    // Never the app key as the backup key.
    vi.stubEnv("BACKUP_ENCRYPTION_KEY", process.env.APP_ENCRYPTION_KEY!);
    expect(() => sealBackup(new Uint8Array(1))).toThrow(/different from APP_ENCRYPTION_KEY/);
  });

  it("documents are incremental; each manifest lists the full set; records only in Client Connect go first", async () => {
    const o = await office();
    await staffUploadDocument(o.tabitha, { clientId: o.client.id, category: "TAXES", visibility: "STAFF_ONLY", bytes: pdf("tax"), originalName: "t.pdf" });
    await staffUploadDocument(o.tabitha, { clientId: o.client.id, category: "BOOKKEEPING", docType: "BANK_STATEMENT", visibility: "STAFF_ONLY", bytes: pdf("bank"), originalName: "b.pdf" });
    const first = await runBackupToCompletion();
    expect(first.run).toMatchObject({ files: 2, filesUploaded: 2 });
    const idx = await prisma.backupFileIndex.findMany({ orderBy: { firstRunAt: "asc" } });
    expect(idx.map((i) => i.group).sort()).toEqual(["BANK_STATEMENTS", "TAX"]);
    const second = await runBackupToCompletion();
    expect(second.run).toMatchObject({ files: 2, filesUploaded: 0 });
    await staffUploadDocument(o.tabitha, { clientId: o.client.id, category: "PAYROLL", visibility: "STAFF_ONLY", bytes: pdf("pay"), originalName: "p.pdf" });
    const third = await runBackupToCompletion();
    expect(third.run).toMatchObject({ files: 3, filesUploaded: 1 });
    const m = await loadManifest(target, third.run.manifestKey!);
    expect(m.files).toHaveLength(3);
    expect(m.files[0].group).toBe("BANK_STATEMENTS");
    expect(target.objects.size).toBeGreaterThan(0);
  });

  it("resumes from its cursor when a step is cut short", async () => {
    const o = await office();
    for (let i = 0; i < 3; i++) await staffUploadDocument(o.tabitha, { clientId: o.client.id, category: "OTHER", visibility: "STAFF_ONLY", bytes: pdf(`r${i}`), originalName: `r${i}.pdf` });
    const run = await startBackupRun();
    let steps = 0, state = "progress";
    while (state === "progress" && steps < 500) {
      state = (await stepBackupRun(run.id, { budgetMs: 1 })).state;
      steps++;
    }
    expect(state).toBe("done");
    expect(steps).toBeGreaterThan(3);
    expect((await prisma.backupRun.findUniqueOrThrow({ where: { id: run.id } })).files).toBe(3);
  });

  it("retention: daily 35 days, month-end 12 months, year-end 7 years; the latest is always kept", () => {
    const run = (id: string, backupDate: string) => ({ id, backupDate, startedAt: new Date(`${backupDate}T08:00:00Z`) });
    const runs = [run("y2018", "2018-12-31"), run("y2024", "2024-12-31"), run("m-jan", "2026-01-31"), run("jan15", "2026-01-15"), run("m-2025-06", "2025-06-30"), run("m-2025-10", "2025-10-31"), run("y2025", "2025-12-31"), run("oct10", "2026-10-10"), run("oct20", "2026-10-20"), run("nov03", "2026-11-03")];
    const d = classifyRuns(runs, "2026-11-04");
    expect(d.get("nov03")).toMatchObject({ keep: true, cls: "DAILY", latest: true });
    expect(d.get("oct10")).toMatchObject({ keep: true, cls: "DAILY" });
    expect(d.get("oct20")).toMatchObject({ keep: true, cls: "MONTHLY" }); // October's last backup
    expect(d.get("jan15")!.keep).toBe(false);
    expect(d.get("m-jan")).toMatchObject({ keep: true, cls: "MONTHLY" });
    expect(d.get("m-2025-10")).toMatchObject({ keep: false }); // 12 months + 4 days ago
    expect(d.get("y2024")).toMatchObject({ keep: true, cls: "YEARLY" });
    expect(d.get("y2025")).toMatchObject({ keep: true, cls: "YEARLY" });
    expect(d.get("y2018")).toMatchObject({ keep: false, cls: "YEARLY" }); // more than 7 years
    // A lone, very old backup is still kept because it's the latest.
    expect(classifyRuns([run("old", "2020-03-03")], "2026-11-04").get("old")!.keep).toBe(true);
  });

  it("pruning deletes only backups outside the policy, never the latest, and never before the lock date", async () => {
    await office();
    let clock = new Date("2026-08-10T08:00:00Z");
    target = new MemoryTarget("GOVERNANCE", () => clock);
    setBackupTargetForTests(target);
    const old = await runBackupToCompletion({ now: new Date("2026-08-02T08:00:00Z") });
    const mid = await runBackupToCompletion({ now: new Date("2026-08-05T08:00:00Z") });
    const latest = await runBackupToCompletion({ now: new Date("2026-11-03T08:00:00Z") });
    const key = old.run.manifestKey!;
    // A locked object can't be deleted early, even with the app's own credentials.
    await expect(target.delete(key)).rejects.toBeInstanceOf(LockedObjectError);
    // 2026-09-06: the 08-02 daily is past 35 days, but its lock (36 days) still holds → kept.
    clock = new Date("2026-09-06T12:00:00Z");
    let p = await pruneBackups(target, clock);
    expect(p.runsPruned).toBe(0);
    expect(p.keptByLock).toBeGreaterThan(0);
    expect(target.objects.has(key)).toBe(true);
    // August's last backup (08-05) is now its month-end backup: kept 12 months, lock extended to match.
    expect((await prisma.backupRun.findUniqueOrThrow({ where: { id: mid.run.id } })).retention).toBe("MONTHLY");
    expect(target.objects.get(mid.run.manifestKey!)!.lockUntil!.toISOString().slice(0, 10)).toBe("2027-08-05");
    // After the lock date, the 08-02 daily goes; the month-end and the latest stay.
    clock = new Date("2026-11-04T08:00:00Z");
    p = await pruneBackups(target, clock);
    expect(p.runsPruned).toBe(1);
    expect([...target.objects.keys()].some((k) => k.startsWith(old.run.prefix))).toBe(false);
    expect(target.objects.has(mid.run.manifestKey!)).toBe(true);
    expect(target.objects.has(latest.run.manifestKey!)).toBe(true);
    // Even then, the month-end backup can't be deleted early.
    await expect(target.delete(mid.run.manifestKey!)).rejects.toBeInstanceOf(LockedObjectError);
  });

  it("alerts the owner: a failed backup, none successful in 48 hours, and restore tests (quarterly and over 100 days)", async () => {
    const o = await office();
    await setNightlyBackups(o.tabitha, true);
    const run = await startBackupRun();
    // The bucket refuses writes → the run fails and is recorded.
    vi.spyOn(target, "put").mockRejectedValueOnce(new Error("AccessDenied: simulated"));
    const r = await stepBackupRun(run.id);
    expect(r.state).toBe("failed");
    expect((await prisma.backupRun.findUniqueOrThrow({ where: { id: run.id } })).error).toMatch(/simulated/);
    const now = new Date(Date.now() + 49 * 3600_000);
    const sent = await checkBackupAlerts(now);
    expect(sent).toEqual(expect.arrayContaining(["failed", "stale", "quarterly"]));
    const tasks = await prisma.task.findMany({ where: { assigneeId: o.tabitha.id } });
    expect(tasks.find((t) => t.title === BACKUP_FAILED_TITLE)?.priority).toBe("HIGH");
    expect(tasks.find((t) => t.title === BACKUP_STALE_TITLE)?.priority).toBe("HIGH");
    // Once a day, not every tick.
    expect(await checkBackupAlerts(now)).not.toContain("stale");
    // Quarterly restore-test reminder, and the 100-day alert once a backup has existed a week.
    const ok = await runBackupToCompletion();
    expect(ok.run.status).toBe("SUCCEEDED");
    await prisma.backupRun.update({ where: { id: ok.run.id }, data: { finishedAt: new Date(Date.now() - 10 * 86_400_000) } });
    const later = await checkBackupAlerts(new Date());
    expect(later).toEqual(["restore-stale"]); // the quarterly reminder was already sent this quarter
    expect(await prisma.task.count({ where: { title: RESTORE_TASK_TITLE, status: "OPEN" } })).toBe(1);
    expect(await prisma.task.count({ where: { title: RESTORE_STALE_TITLE, priority: "HIGH" } })).toBe(1);
    // A passed test closes the quarterly task.
    await recordRestoreTest({ manifestKey: ok.run.manifestKey!, mode: "VERIFY", source: "CLI", startedAt: new Date(), report: { ok: true, rowCounts: [], problems: [], samples: [] } as never });
    expect(await prisma.task.count({ where: { title: RESTORE_TASK_TITLE, status: "OPEN" } })).toBe(0);
  });
});

describe("restore", () => {
  it("verify restores into a scratch database and store: row counts and document hashes match, one sample per Client-Connect-only group", async () => {
    const o = await office();
    await staffUploadDocument(o.tabitha, { clientId: o.client.id, category: "BOOKKEEPING", docType: "BANK_STATEMENT", visibility: "STAFF_ONLY", bytes: pdf("bank"), originalName: "b.pdf" });
    await staffUploadDocument(o.tabitha, { clientId: o.client.id, category: "OTHER", docType: "NONPROFIT_ITEM", visibility: "STAFF_ONLY", bytes: pdf("np"), originalName: "np.pdf" });
    await staffUploadDocument(o.tabitha, { clientId: o.client.id, category: "BOOKKEEPING", visibility: "STAFF_ONLY", bytes: pdf("bk"), originalName: "bk.pdf" });
    await staffUploadDocument(o.tabitha, { clientId: o.client.id, category: "PAYROLL", visibility: "STAFF_ONLY", bytes: pdf("pay"), originalName: "pay.pdf" });
    for (let i = 0; i < 6; i++) await staffUploadDocument(o.tabitha, { clientId: o.client.id, category: "TAXES", visibility: "STAFF_ONLY", bytes: pdf(`tax${i}`), originalName: `t${i}.pdf` });
    const b = await runBackupToCompletion();
    const r = await verifyBackupInto({ target, manifestKey: b.run.manifestKey!, db: scratch, store: createMemoryStorage(), sampleSize: 2 });
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.rowCounts.every((c) => c.expected === c.restored)).toBe(true);
    expect(r.filesChecked).toBe(10);
    const groups = new Set(r.samples.map((s) => s.group));
    for (const g of ["BANK_STATEMENTS", "NONPROFIT", "BOOKKEEPING", "PAYROLL"]) expect(groups.has(g)).toBe(true);
    expect(r.samples.every((s) => s.ok)).toBe(true);
    // A tampered object is caught.
    await wipe(scratch);
    const m = await loadManifest(target, b.run.manifestKey!);
    const victim = target.objects.get(m.files[0].objectKey)!;
    victim.body = sealBackup(new Uint8Array([1, 2, 3]));
    const bad = await verifyBackupInto({ target, manifestKey: b.run.manifestKey!, db: scratch, store: createMemoryStorage() });
    expect(bad.ok).toBe(false);
    expect(bad.problems.join(" ")).toMatch(/changed since backup|doesn't match/);
  });

  it("verify refuses the production database; full restore refuses a non-empty target, and production without the flag", async () => {
    await office();
    const b = await runBackupToCompletion();
    vi.stubEnv("NETLIFY_DB_URL", "postgresql://app:secret@db.netlify.example:5432/prod");
    expect(isProductionDatabaseUrl("postgresql://app:secret@db.netlify.example:5432/prod")).toBe(true);
    expect(isProductionDatabaseUrl(scratchUrl())).toBe(false);
    expect(() => assertScratchTarget("postgresql://app:secret@db.netlify.example:5432/prod")).toThrow(/scratch database/);
    // The test database itself has data: a full restore into it is refused (it's "production" for this test).
    vi.stubEnv("PRODUCTION_DATABASE_URL", process.env.DATABASE_URL!);
    await expect(fullRestore({ target, manifestKey: b.run.manifestKey!, db: prisma, targetUrl: process.env.DATABASE_URL!, store: createMemoryStorage() })).rejects.toThrow(/--i-understand-this-overwrites-production/);
    await expect(fullRestore({ target, manifestKey: b.run.manifestKey!, db: prisma, targetUrl: process.env.DATABASE_URL!, store: createMemoryStorage(), iUnderstandThisOverwritesProduction: true })).rejects.toThrow(/isn't empty/);
    expect(await prisma.user.count()).toBe(1); // nothing was touched
    // An empty scratch target restores.
    const ok = await fullRestore({ target, manifestKey: b.run.manifestKey!, db: scratch, targetUrl: scratchUrl(), store: createMemoryStorage() });
    expect(ok.ok).toBe(true);
  });

  it("full recovery: every category encrypted, backed up, wiped and restored — every document opens with its records", async () => {
    const o = await office();
    const nonprofit = await createClient(o.tabitha, { businessName: "Pretend Food Pantry (fictional nonprofit)", clientType: "BUSINESS", status: "ACTIVE" });
    const { token } = await invitePortalUser(o.tabitha, o.client.id, { email: "owner@lantern.example", name: "Pat Pretend", role: "OWNER" });
    const u = await acceptPortalInvite(token!, "Client-Pass-12345");
    const portal = { id: u.id, name: u.name, email: u.email };
    // Existing (plaintext) records, as production holds them today…
    await legacy(o.client.id, o.tabitha.id, "TAXES", "FEDERAL_RETURN", 2024);
    await legacy(o.client.id, o.tabitha.id, "BOOKKEEPING", "BANK_STATEMENT", 2026);
    await legacy(nonprofit.id, o.tabitha.id, "OTHER", "NONPROFIT_ITEM", 2025);
    await legacy(o.client.id, o.tabitha.id, "BOOKKEEPING", null, 2026);
    await legacy(o.client.id, o.tabitha.id, "PAYROLL", null, 2026);
    // …and new uploads (encrypted on arrival): identity, a portal upload, a correspondence attachment.
    const me = await ensureClientPerson(o.client.id);
    // Identity documents on a business account's own record are filed by our office.
    await uploadIdentityDocument({ staff: o.tabitha }, { clientId: o.client.id, personId: me.id, type: "SOCIAL_SECURITY_CARD", bytes: pdf("ss"), originalName: "ss.pdf" });
    await portalUploadDocument(portal, { clientId: o.client.id, year: 2025, bytes: pdf("upload"), originalName: "1099.pdf" });
    const letter = await staffUploadDocument(o.tabitha, { clientId: o.client.id, category: "TAXES", visibility: "PUBLISHED", year: 2025, bytes: pdf("letter"), originalName: "irs-letter.pdf" });
    const convo = await prisma.conversation.create({ data: { clientId: o.client.id, subject: "IRS letter" } });
    await prisma.message.create({ data: { conversationId: convo.id, channel: "PORTAL", direction: "OUTBOUND", body: "Attached.", status: "DELIVERED", staffAuthorId: o.tabitha.id, attachments: { connect: { id: letter.id } } } });
    // A deleted document waiting in Recently deleted is backed up too.
    const gone = await staffUploadDocument(o.tabitha, { clientId: o.client.id, category: "OTHER", visibility: "STAFF_ONLY", bytes: pdf("deleted"), originalName: "d.pdf" });
    await deleteDocument(o.tabitha, gone.id, "Duplicate");

    // 1. Encryption migration of the existing files.
    await startEncryptionJob({ actor: o.tabitha });
    expect((await runEncryptionBatch({ actor: o.tabitha }, { limit: 100 })).remaining).toBe(0);
    expect(await prisma.storedFile.count({ where: { encrypted: false } })).toBe(0);
    // 2. Nightly backup.
    const b = await runBackupToCompletion({ trigger: "NIGHTLY" });
    expect(b.run.status).toBe("SUCCEEDED");
    const before = await prisma.document.findMany({ include: { file: true, accessLogs: { orderBy: { id: "asc" } }, messages: { select: { id: true } } }, orderBy: { id: "asc" } });
    const audits = await prisma.auditLog.findMany({ where: { entityType: "Document" }, orderBy: { id: "asc" } });
    const plain = new Map<string, string>();
    for (const d of before) plain.set(d.id, sha((await readDocumentBytes(d.file))!));
    // 3. A brand-new scratch database (migrated from scratch, as in a real recovery) and an empty blob store.
    await scratch.$disconnect();
    scratch = await createScratchDb();
    const dir = mkdtempSync(path.join(tmpdir(), "restore-blobs-"));
    const store = createLocalStorage(dir);
    // 4. Restore from the backup.
    const r = await fullRestore({ target, manifestKey: b.run.manifestKey!, db: scratch, targetUrl: scratchUrl(), store });
    expect(r.problems).toEqual([]);
    for (const g of ONLY_IN_CLIENT_CONNECT) expect(r.samples.some((s) => s.group === g && s.ok)).toBe(true);
    // 5. Every document opens, its sha256 matches, and its records came back with it.
    const after = await scratch.document.findMany({ include: { file: true, accessLogs: { orderBy: { id: "asc" } }, messages: { select: { id: true } }, client: true }, orderBy: { id: "asc" } });
    expect(after).toHaveLength(before.length);
    expect(after.length).toBe(9);
    for (const [i, d] of after.entries()) {
      const was = before[i];
      expect(d).toMatchObject({ id: was.id, clientId: was.clientId, category: was.category, year: was.year, visibility: was.visibility, docType: was.docType, deletedAt: was.deletedAt, purgeAfter: was.purgeAfter });
      expect(d.client.displayName).toBeTruthy();
      expect(d.accessLogs.map((a) => [a.action, a.staffUserId, a.portalUserId])).toEqual(was.accessLogs.map((a) => [a.action, a.staffUserId, a.portalUserId]));
      expect(d.messages).toEqual(was.messages);
      const bytes = await readDocumentBytes(d.file, store);
      expect(bytes).not.toBeNull();
      expect(sha(bytes!)).toBe(plain.get(d.id));
      expect(sha(bytes!)).toBe(d.file.sha256);
    }
    expect((await scratch.auditLog.findMany({ where: { entityType: "Document" }, orderBy: { id: "asc" } })).map((a) => [a.id, a.action, a.entityId])).toEqual(audits.map((a) => [a.id, a.action, a.entityId]));
    expect(await scratch.identityDocument.count()).toBe(await prisma.identityDocument.count());
  }, 60_000); // end-to-end: seeds every category, backs up, wipes and restores (about 3-8 s locally)
});

describe("cost estimate", () => {
  it("documents stored once; 54 database copies", () => {
    const e = estimateBackupStorage({ documentBytes: 50e9, fileCount: 100_000, dbBytes: 2e9, dbCompressedRatio: 0.2, newDocumentBytesPerDay: 0, deletedBytesPerYear: 1e9, manifestBytesPerFile: 120 });
    expect(e.dbCopies).toBe(54);
    expect(Math.round(e.database / 1e9)).toBe(22); // 54 × 0.2 × 2 GB
    expect(Math.round(e.documents / 1e9)).toBe(51);
  });
});

describe("S3-compatible target", () => {
  it("writes each object with Content-MD5 and an Object Lock retain-until date; a refused delete reads as locked", async () => {
    const { S3Target } = await import("@/lib/backup/target");
    vi.stubEnv("BACKUP_OBJECT_LOCK_MODE", "COMPLIANCE");
    const t = new S3Target();
    const calls: { name: string; input: Record<string, unknown> }[] = [];
    // No network: the SDK client is replaced by a recorder (no real provider is ever called in tests).
    (t as unknown as { clientP: Promise<unknown> }).clientP = Promise.resolve({
      send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
        calls.push({ name: cmd.constructor.name, input: cmd.input });
        if (cmd.constructor.name === "DeleteObjectCommand") throw Object.assign(new Error("Access Denied because object protected by object lock."), { name: "AccessDenied" });
        return {};
      },
    });
    const until = new Date("2026-12-10T00:00:00Z");
    await t.put("runs/x/manifest.json.tcb", new Uint8Array([1, 2, 3]), { lockUntil: until });
    expect(calls[0]).toMatchObject({ name: "PutObjectCommand", input: { Bucket: "fictional-backups", Key: "runs/x/manifest.json.tcb", ObjectLockMode: "COMPLIANCE", ObjectLockRetainUntilDate: until } });
    expect(calls[0].input.ContentMD5).toBe(createHash("md5").update(new Uint8Array([1, 2, 3])).digest("base64"));
    await expect(t.delete("runs/x/manifest.json.tcb")).rejects.toBeInstanceOf(LockedObjectError);
    await t.extendLock("runs/x/manifest.json.tcb", new Date("2027-12-10T00:00:00Z"));
    expect(calls.at(-1)).toMatchObject({ name: "PutObjectRetentionCommand", input: { Retention: { Mode: "COMPLIANCE" } } });
  });
});
