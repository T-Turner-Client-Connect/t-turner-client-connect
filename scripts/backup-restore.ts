/**
 * Backup & restore from the command line. See docs/backup-restore.md for the full runbook.
 *
 *   npm run backup -- list                                   backups in the bucket (newest first)
 *   npm run backup -- verify --scratch-database-url URL      restore-verify into a SCRATCH database
 *        [--backup latest|<manifest key>] [--scratch-dir DIR] [--sample 10]
 *   npm run backup -- full --database-url URL --blob-dir DIR --confirm-restore
 *        [--backup <manifest key>] [--i-understand-this-overwrites-production]
 *   npm run backup -- backup                                 one backup now (local drills)
 *
 * Where backups are read from: the BACKUP_S3_* bucket, or --target-dir DIR (a local folder that
 * behaves like a bucket, for drills). Keys come from the environment: BACKUP_ENCRYPTION_KEY to open
 * backups, APP_ENCRYPTION_KEY to open the documents inside them. Secret values are never printed.
 *
 * Safety:
 *  - verify only ever restores into a scratch database (localhost, not the app's database);
 *  - full refuses a non-empty database, and refuses the production database unless
 *    --i-understand-this-overwrites-production is passed AND it is empty;
 *  - nothing here deletes a backup object or an existing file.
 */
import path from "node:path";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { backupTarget, setBackupTargetOverride, type BackupTarget } from "@/lib/backup/target";
import { FolderTarget } from "@/lib/backup/folder-target";
import { assertScratchTarget, fullRestore, isProductionDatabaseUrl, listBackups, PRODUCTION_FLAG, verifyBackupInto, type RestoreReport } from "@/lib/backup/restore";
import { listTables } from "@/lib/backup/db";
import { createLocalStorage, createMemoryStorage } from "@/lib/storage";

type Args = { _: string[]; [k: string]: string | boolean | string[] };
function parse(argv: string[]): Args {
  const out: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[k] = next;
        i++;
      } else out[k] = true;
    } else (out._ as string[]).push(a);
  }
  return out;
}

const say = (s: string) => process.stdout.write(`${s}\n`);
const fail = (s: string): never => {
  process.stderr.write(`✖ ${s}\n`);
  process.exit(1);
};

function target(args: Args): BackupTarget {
  if (typeof args["target-dir"] === "string") {
    const t = new FolderTarget(path.resolve(args["target-dir"]));
    setBackupTargetOverride(t);
    return t;
  }
  return backupTarget();
}

async function pickManifest(t: BackupTarget, which: unknown) {
  const all = await listBackups(t);
  if (!all.length) fail("No backups found in the target.");
  if (!which || which === "latest" || which === true) return all[0];
  const hit = all.find((b) => b.key === which || b.runId === which || b.prefix === which);
  return hit ?? fail(`Backup not found: ${String(which)}`);
}

function printReport(r: RestoreReport) {
  say(`\n${r.mode === "FULL" ? "Full restore" : "Restore verification"} of backup ${r.backupDate} (run ${r.runId})`);
  say(`  last migration in backup: ${r.lastMigration ?? "unknown"}`);
  say(`  database chunks checked:  ${r.chunksChecked}  (tables ${r.tables}, rows ${r.rows})`);
  say(`  files checked:            ${r.filesChecked}  (${(r.fileBytes / 1048576).toFixed(2)} MB as stored)`);
  say(`  database:                 ${r.database}`);
  const diffs = r.rowCounts.filter((c) => c.expected !== c.restored);
  say(`  row counts:               ${r.rowCounts.length - diffs.length}/${r.rowCounts.length} tables match`);
  for (const s of r.samples) say(`  sample ${s.ok ? "OK  " : "FAIL"} ${String(s.group ?? "-").padEnd(16)} ${s.storageKey}${s.detail ? ` (${s.detail})` : ""}`);
  for (const p of r.problems) say(`  problem: ${p}`);
  say(r.ok ? "\n✓ PASSED" : "\n✖ FAILED");
}

async function prepareScratch(url: string) {
  const db = new PrismaClient({ datasourceUrl: url });
  if ((await listTables(db)).length === 0) {
    say("Scratch database has no tables: applying migrations (local databases only)…");
    execFileSync("node", ["scripts/migrate-local.mjs"], { stdio: "inherit", env: { ...process.env, DATABASE_URL: url } });
  }
  return db;
}

async function record(report: RestoreReport | null, mode: "VERIFY" | "FULL", manifestKey: string, startedAt: Date, error?: string) {
  // Recorded in the app database (DATABASE_URL) for the WISP, when one is configured.
  if (!process.env.DATABASE_URL && !process.env.NETLIFY_DB_URL) return say("(Not recorded: no DATABASE_URL for the app database.)");
  const { recordRestoreTest } = await import("@/lib/services/backups");
  const t = await recordRestoreTest({ manifestKey, mode, source: "CLI", startedAt, report, error: error ?? null });
  say(`Recorded restore test ${t.id} (${t.status}).`);
}

async function main() {
  const args = parse(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd || args.help) {
    say("Commands: list | verify | full | backup. See docs/backup-restore.md.");
    return;
  }
  const t = target(args);

  if (cmd === "list") {
    for (const b of await listBackups(t)) say(`${b.backupDate}  ${b.runId}  ${b.key}`);
    return;
  }

  if (cmd === "backup") {
    const { runBackupToCompletion } = await import("@/lib/backup/runner");
    const url = process.env.DATABASE_URL ?? "";
    if (isProductionDatabaseUrl(url) && !args["target-dir"]) fail("From the command line, `backup` is for local drills (use the nightly schedule for production).");
    const r = await runBackupToCompletion({ trigger: "MANUAL" });
    say(`Backup ${r.state}: ${r.run.backupDate} run ${r.run.id} · tables ${r.run.tables} · rows ${r.run.rows} · files ${r.run.files} (${r.run.filesUploaded} new) · ${r.run.bytesUploaded} bytes uploaded${r.error ? ` · ${r.error}` : ""}`);
    return;
  }

  if (cmd === "verify") {
    const url = typeof args["scratch-database-url"] === "string" ? args["scratch-database-url"] : "";
    if (!url) fail("Pass --scratch-database-url (an empty local database). Verify never restores into production.");
    try {
      assertScratchTarget(url);
    } catch (err) {
      fail((err as Error).message);
    }
    const m = await pickManifest(t, args.backup);
    const db = await prepareScratch(url);
    const store = typeof args["scratch-dir"] === "string" ? createLocalStorage(path.resolve(args["scratch-dir"])) : createMemoryStorage();
    const startedAt = new Date();
    try {
      const r = await verifyBackupInto({ target: t, manifestKey: m.key, db, store, sampleSize: Number(args.sample ?? 10) });
      printReport(r);
      await record(r, "VERIFY", m.key, startedAt);
      if (!r.ok) process.exitCode = 2;
    } catch (err) {
      await record(null, "VERIFY", m.key, startedAt, (err as Error).message);
      fail((err as Error).message);
    } finally {
      await db.$disconnect();
    }
    return;
  }

  if (cmd === "full") {
    const url = typeof args["database-url"] === "string" ? args["database-url"] : "";
    if (!url) fail("Pass --database-url (the EMPTY database to restore into).");
    if (!args["confirm-restore"]) fail("Pass --confirm-restore to run a full restore.");
    if (typeof args["blob-dir"] !== "string") fail("Pass --blob-dir DIR (files are written there; upload them to Netlify Blobs as described in docs/backup-restore.md).");
    const production = isProductionDatabaseUrl(url);
    if (production && !args[PRODUCTION_FLAG.slice(2)]) fail(`That looks like the production database. Refusing without ${PRODUCTION_FLAG} (and it must be empty).`);
    const m = await pickManifest(t, args.backup);
    const db = production ? new PrismaClient({ datasourceUrl: url }) : await prepareScratch(url);
    const startedAt = new Date();
    try {
      const r = await fullRestore({ target: t, manifestKey: m.key, db, targetUrl: url, store: createLocalStorage(path.resolve(String(args["blob-dir"]))), iUnderstandThisOverwritesProduction: !!args[PRODUCTION_FLAG.slice(2)] });
      printReport(r);
      if (!r.ok) process.exitCode = 2;
    } catch (err) {
      fail((err as Error).message);
    } finally {
      await db.$disconnect();
    }
    void startedAt;
    return;
  }
  fail(`Unknown command: ${cmd}`);
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (err) => fail(err instanceof Error ? err.message : String(err)),
);
