import { gunzipSync } from "node:zlib";
import type { PrismaClient } from "@prisma/client";
import type { Driver } from "@/lib/storage";
import { openStoredBytes } from "@/lib/crypto";
import { ONLY_IN_CLIENT_CONNECT } from "@/lib/doc-security/inventory";
import { openBackup, sha256Hex } from "./crypto";
import { countRows, databaseIsEmpty, loadTables, schemaFingerprint } from "./db";
import { MANIFEST_NAME, type Manifest } from "./manifest";
import type { BackupTarget } from "./target";

/**
 * Restoring a backup. Two modes:
 *  - VERIFY: download a backup, decrypt it, check every database chunk and every file against the
 *    manifest's sha256, load it into a SCRATCH database and a scratch file store (never production),
 *    then compare row counts and open sample documents (decrypt + sha256). Restore tests are recorded.
 *  - FULL: disaster recovery into an EMPTY database (docs/backup-restore.md). A production target
 *    is refused unless the caller passes the explicit production flag AND the database is empty.
 */

export type BackupListing = { key: string; prefix: string; backupDate: string; runId: string };

/** Backups present in the bucket, newest first (works without the app database — for disaster recovery). */
export async function listBackups(target: BackupTarget): Promise<BackupListing[]> {
  const objs = await target.list("runs/");
  return objs
    .filter((o) => o.key.endsWith(`/${MANIFEST_NAME}`))
    .map((o) => {
      const prefix = o.key.slice(0, -MANIFEST_NAME.length);
      const m = /^runs\/(\d{4}-\d{2}-\d{2})_([^/]+)\/$/.exec(prefix);
      return { key: o.key, prefix, backupDate: m?.[1] ?? "", runId: m?.[2] ?? "" };
    })
    .sort((a, b) => (a.backupDate === b.backupDate ? (a.runId < b.runId ? 1 : -1) : a.backupDate < b.backupDate ? 1 : -1));
}

export async function loadManifest(target: BackupTarget, key: string, expectedSha256?: string | null): Promise<Manifest> {
  const sealed = await target.get(key);
  if (!sealed) throw new Error(`Manifest not found: ${key}`);
  if (expectedSha256 && sha256Hex(sealed) !== expectedSha256) throw new Error("The manifest doesn't match the fingerprint recorded when it was written.");
  const m = JSON.parse(Buffer.from(gunzipSync(openBackup(sealed))).toString("utf8")) as Manifest;
  if (m.format !== "tturner-backup/1") throw new Error(`Unknown backup format: ${m.format}`);
  return m;
}

export type RestoreReport = {
  ok: boolean;
  mode: "VERIFY" | "FULL";
  manifestKey: string;
  backupDate: string;
  runId: string;
  lastMigration: string | null;
  tables: number;
  rows: number;
  chunksChecked: number;
  filesChecked: number;
  fileBytes: number;
  rowCounts: { table: string; expected: number; restored: number | null }[];
  samples: { group: string | null; storageKey: string; documentId: string | null; ok: boolean; detail?: string }[];
  problems: string[];
  database: "restored" | "not restored (no scratch database)";
};

export type RestoreOptions = {
  target: BackupTarget;
  manifestKey: string;
  expectedManifestSha256?: string | null;
  // Where the database goes. VERIFY: a scratch database. FULL: the recovery target.
  db?: PrismaClient | null;
  // Where files go. VERIFY: a scratch store (folder or memory). FULL: the recovery store.
  store: Driver;
  // Extra random documents to open, beyond one from each "only in Client Connect" group.
  sampleSize?: number;
  // Stop after this time (page runs); a CLI run checks everything.
  deadline?: number;
};

async function restoreInto(mode: "VERIFY" | "FULL", o: RestoreOptions): Promise<RestoreReport> {
  const m = await loadManifest(o.target, o.manifestKey, o.expectedManifestSha256);
  const report: RestoreReport = {
    ok: false, mode, manifestKey: o.manifestKey, backupDate: m.backupDate, runId: m.runId, lastMigration: m.lastMigration,
    tables: m.tables.length, rows: m.totals.rows, chunksChecked: 0, filesChecked: 0, fileBytes: 0, rowCounts: [], samples: [], problems: [],
    database: o.db ? "restored" : "not restored (no scratch database)",
  };
  const late = () => !!o.deadline && Date.now() > o.deadline;
  // Tables a fresh migration already filled with default rows (replaced by the backup's rows).
  let prefilled = new Set<string>();

  if (o.db) {
    const fp = await schemaFingerprint(o.db);
    if (fp !== m.schemaFingerprint) {
      report.problems.push(`The target database's schema doesn't match the backup (backup was taken at migration ${m.lastMigration ?? "unknown"}). Migrate the target to that version first.`);
      return report;
    }
    const empty = await databaseIsEmpty(o.db);
    if (!empty.empty) {
      report.problems.push(`The target database isn't empty (${empty.nonEmpty.slice(0, 5).join(", ")}${empty.nonEmpty.length > 5 ? "…" : ""}). Restores only go into an empty database.`);
      return report;
    }
    prefilled = new Set(empty.prefilled);
  }

  // 1. Database chunks: object hash → decrypt → content hash → row count.
  const data: { table: string; lines: string[] }[] = [];
  for (const t of m.tables) {
    const lines: string[] = [];
    for (const ch of t.chunks) {
      if (late()) break;
      const sealed = await o.target.get(ch.key);
      if (!sealed) {
        report.problems.push(`Missing database chunk ${ch.key}`);
        continue;
      }
      if (sha256Hex(sealed) !== ch.objectSha256) report.problems.push(`Database chunk changed since backup: ${ch.key}`);
      const nd = gunzipSync(openBackup(sealed));
      if (sha256Hex(nd) !== ch.sha256) report.problems.push(`Database chunk content doesn't match the manifest: ${ch.key}`);
      const got = Buffer.from(nd).toString("utf8").split("\n").filter(Boolean);
      if (got.length !== ch.rows) report.problems.push(`Row count differs in ${ch.key}: ${got.length} vs ${ch.rows}`);
      lines.push(...got);
      report.chunksChecked++;
    }
    data.push({ table: t.name, lines });
  }

  // 2. Files: object hash → decrypt (backup key) → stored-bytes hash → write to the target store.
  for (const f of m.files) {
    if (late()) break;
    const sealed = await o.target.get(f.objectKey);
    if (!sealed) {
      report.problems.push(`Missing file object for ${f.storageKey}`);
      continue;
    }
    if (sha256Hex(sealed) !== f.objectSha256) report.problems.push(`File object changed since backup: ${f.storageKey}`);
    const stored = openBackup(sealed);
    if (sha256Hex(stored) !== f.storedSha256) {
      report.problems.push(`File doesn't match the manifest: ${f.storageKey}`);
      continue;
    }
    const existing = await o.store.get(f.storageKey);
    // Never overwrite: an identical file already there is fine; a different one is a problem.
    if (existing && sha256Hex(existing) !== f.storedSha256) report.problems.push(`A different file already exists at ${f.storageKey}; left as it is.`);
    else if (!existing) await o.store.put(f.storageKey, stored);
    report.filesChecked++;
    report.fileBytes += stored.length;
  }
  if (late()) report.problems.push("Stopped at the time limit before every chunk and file was checked. Run the full check with scripts/backup-restore.ts.");

  // 3. Database load and row counts.
  if (o.db) {
    await loadTables(o.db, data, prefilled);
    for (const t of m.tables) report.rowCounts.push({ table: t.name, expected: t.rows, restored: await countRows(o.db, t.name) });
    // A pre-filled table may keep extra default rows the live database had removed: every backup row must be there.
    for (const rc of report.rowCounts) if (prefilled.has(rc.table) && rc.restored !== null && rc.restored >= rc.expected) rc.restored = rc.expected;
  } else {
    for (const t of m.tables) report.rowCounts.push({ table: t.name, expected: t.rows, restored: data.find((d) => d.table === t.name)?.lines.length ?? 0 });
  }
  for (const rc of report.rowCounts) if (rc.restored !== rc.expected) report.problems.push(`Row count for ${rc.table}: restored ${rc.restored}, backup says ${rc.expected}`);

  // 4. Sample documents: at least one from each "only in Client Connect" group, plus random others.
  const docsByFile = new Map<string, string>();
  if (o.db) {
    const rows = await o.db.document.findMany({ select: { id: true, fileId: true } });
    for (const r of rows) docsByFile.set(r.fileId, r.id);
  }
  const picks: typeof m.files = [];
  for (const g of ONLY_IN_CLIENT_CONNECT) {
    const f = m.files.find((x) => x.group === g);
    if (f) picks.push(f);
  }
  const rest = m.files.filter((f) => !picks.includes(f));
  for (let i = 0; i < (o.sampleSize ?? 10) && rest.length; i++) picks.push(rest.splice(Math.floor(Math.random() * rest.length), 1)[0]);
  for (const f of picks) {
    const docId = f.sourceType === "StoredFile" ? docsByFile.get(f.sourceId) ?? null : null;
    try {
      const stored = await o.store.get(f.storageKey);
      if (!stored) throw new Error("not in the restored store");
      // Decrypt with the app key (APP_ENCRYPTION_KEY — restores need it too) and compare to the original's hash.
      let plain: Uint8Array;
      if (o.db && f.sourceType === "StoredFile") {
        const sf = await o.db.storedFile.findUnique({ where: { id: f.sourceId } });
        if (!sf) throw new Error("file record missing in the restored database");
        if (sf.storageKey !== f.storageKey) throw new Error("restored record points at a different key");
        plain = sf.encrypted ? (await import("@/lib/crypto")).decryptBytes(stored) : stored;
      } else {
        plain = openStoredBytes(stored);
      }
      const ok = !f.plainSha256 || sha256Hex(plain) === f.plainSha256;
      report.samples.push({ group: f.group, storageKey: f.storageKey, documentId: docId, ok, ...(ok ? {} : { detail: "sha256 differs" }) });
      if (!ok) report.problems.push(`Sample document ${f.storageKey} opened but its sha256 differs.`);
    } catch (err) {
      report.samples.push({ group: f.group, storageKey: f.storageKey, documentId: docId, ok: false, detail: (err as Error).message });
      report.problems.push(`Sample document ${f.storageKey} didn't open: ${(err as Error).message}`);
    }
  }
  const missingGroups = ONLY_IN_CLIENT_CONNECT.filter((g) => m.files.some((f) => f.group === g) && !report.samples.some((s) => s.group === g));
  if (missingGroups.length) report.problems.push(`No sample opened for: ${missingGroups.join(", ")}`);
  report.ok = report.problems.length === 0;
  return report;
}

export async function verifyBackupInto(o: RestoreOptions) {
  return restoreInto("VERIFY", o);
}

/** Is this connection string the live database? (the app's own URL, PRODUCTION_DATABASE_URL, or any non-local host). */
export function isProductionDatabaseUrl(url: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const norm = (u?: string) => (u ?? "").trim().replace(/\/+$/, "");
  const known = [env.NETLIFY_DB_URL, env.PRODUCTION_DATABASE_URL].map(norm).filter(Boolean);
  if (known.includes(norm(url))) return true;
  try {
    const host = new URL(url).hostname;
    return !["localhost", "127.0.0.1", "::1"].includes(host);
  } catch {
    return true;
  }
}

export const PRODUCTION_FLAG = "--i-understand-this-overwrites-production";

export class RestoreRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestoreRefused";
  }
}

/**
 * Full restore (disaster recovery). The target must be empty. A production target also needs
 * `iUnderstandThisOverwritesProduction` (the CLI flag of the same name).
 */
export async function fullRestore(o: RestoreOptions & { db: PrismaClient; targetUrl: string; iUnderstandThisOverwritesProduction?: boolean; env?: NodeJS.ProcessEnv }) {
  const production = isProductionDatabaseUrl(o.targetUrl, o.env);
  if (production && !o.iUnderstandThisOverwritesProduction) throw new RestoreRefused(`Refusing to restore into the production database without ${PRODUCTION_FLAG}.`);
  const empty = await databaseIsEmpty(o.db);
  if (!empty.empty) throw new RestoreRefused(`Refusing to restore: the target database isn't empty (${empty.nonEmpty.slice(0, 5).join(", ")}). A restore never overwrites existing records.`);
  return restoreInto("FULL", o);
}

/** Verify mode never touches production, even with the flag. */
export function assertScratchTarget(url: string, env: NodeJS.ProcessEnv = process.env) {
  if (isProductionDatabaseUrl(url, env)) throw new RestoreRefused("Verify mode restores only into a scratch database (localhost, not the app's own database).");
}
