import "server-only";
import { gzipSync } from "node:zlib";
import type { BackupRun, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { storage, type Driver } from "@/lib/storage";
import { currentFileKeyVersion } from "@/lib/crypto";
import { chicagoParts } from "@/lib/tz";
import { fileInventory, sortByGroup, type InventoryItem } from "@/lib/doc-security/inventory";
import { backupKeyId, sealBackup, sha256Hex } from "./crypto";
import { lastMigrationName, listTables, readChunk, schemaFingerprint } from "./db";
import { MANIFEST_NAME, runPrefix, type FileEntry, type Manifest, type TableEntry } from "./manifest";
import { addDaysUtc, classifyRuns, DAILY_DAYS } from "./retention";
import { backupEnvComplete, backupTarget, LockedObjectError, type BackupTarget } from "./target";

/**
 * The nightly backup, as resumable steps. Each call to stepBackupRun does a bounded amount of work
 * (budgetMs) and saves its cursor, so it fits any function time limit: the background function
 * loops over steps for up to ~14 minutes, and a run that is cut off resumes on the next call.
 *
 * Phases: DB (every table → gzip NDJSON chunks, sealed) → FILES (incremental: only stored files
 * not yet in BackupFileIndex) → MANIFEST (full file list + chunk hashes, sealed) → retention
 * pruning, lock extension and the 30-day purge of deleted documents.
 */

export const CHUNK_ROWS = 2000;
const LEASE_MS = 90_000;

export type StepOptions = { budgetMs?: number; now?: Date; target?: BackupTarget; store?: Driver };

export function officeDate(d = new Date()): string {
  const p = chicagoParts(d);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export async function backupSwitchOn(): Promise<boolean> {
  return (await prisma.integrationSettings.findUnique({ where: { id: "default" }, select: { nightlyBackupsEnabled: true } }))?.nightlyBackupsEnabled === true;
}

/** Backups run only when every BACKUP_* setting is present AND the owner's switch is on. */
export async function backupsActive(): Promise<boolean> {
  return backupEnvComplete() && (await backupSwitchOn());
}

type Cursor = {
  tables?: string[];
  t?: number;
  off?: number;
  chunk?: number;
  done?: TableEntry[];
  missing?: string[];
  prune?: { runsPruned: number; objectsDeleted: number; keptByLock: number; locksExtended: number; purged: number; waitingForBackup: number; error?: string };
};

const cursorOf = (r: BackupRun) => ((r.cursor ?? {}) as Cursor);

export async function startBackupRun(opts: { trigger?: "NIGHTLY" | "MANUAL"; startedById?: string | null; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const backupDate = officeDate(now);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('backup-run-start'))`;
    const running = await tx.backupRun.findFirst({ where: { status: "RUNNING" } });
    if (running) return running;
    const run = await tx.backupRun.create({ data: { trigger: opts.trigger ?? "NIGHTLY", backupDate, prefix: "pending", startedById: opts.startedById ?? null, startedAt: now, heartbeatAt: now } });
    return tx.backupRun.update({ where: { id: run.id }, data: { prefix: runPrefix(backupDate, run.id), cursor: {} } });
  });
}

async function claim(runId: string, now: Date): Promise<boolean> {
  const r = await prisma.backupRun.updateMany({ where: { id: runId, status: "RUNNING", OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] }, data: { leaseUntil: new Date(now.getTime() + LEASE_MS), heartbeatAt: now } });
  return r.count === 1;
}

const lockFor = (backupDate: string) => addDaysUtc(backupDate, DAILY_DAYS + 1);

export type StepResult = { runId: string; state: "progress" | "done" | "failed" | "busy"; phase: string; error?: string };

export async function stepBackupRun(runId: string, opts: StepOptions = {}): Promise<StepResult> {
  const now = opts.now ?? new Date();
  const deadline = Date.now() + (opts.budgetMs ?? 15_000);
  if (!(await claim(runId, now))) {
    const r = await prisma.backupRun.findUnique({ where: { id: runId } });
    return { runId, state: r?.status === "SUCCEEDED" ? "done" : r?.status === "FAILED" ? "failed" : "busy", phase: r?.phase ?? "?" };
  }
  const target = opts.target ?? backupTarget();
  const store = opts.store ?? storage;
  let run = await prisma.backupRun.findUniqueOrThrow({ where: { id: runId } });
  let worked = false;
  try {
    const c = cursorOf(run);
    if (run.phase === "DB") {
      c.tables ??= await listTables(prisma);
      c.t ??= 0;
      c.off ??= 0;
      c.chunk ??= 0;
      c.done ??= [];
      let rowsAdded = 0;
      let first = true;
      // At least one chunk per step, so even a tiny budget always makes progress.
      while (c.t < c.tables.length && (first || Date.now() < deadline)) {
        first = false;
        const table = c.tables[c.t];
        const lines = await readChunk(prisma, table, c.off, CHUNK_ROWS);
        let entry = c.done.find((d) => d.name === table);
        if (!entry) {
          entry = { name: table, rows: 0, chunks: [] };
          c.done.push(entry);
        }
        if (lines.length) {
          const ndjson = Buffer.from(lines.join("\n") + "\n", "utf8");
          const sealed = sealBackup(gzipSync(ndjson));
          const key = `${run.prefix}db/${table}/${String(c.chunk).padStart(5, "0")}.ndjson.gz.tcb`;
          await target.put(key, sealed, { lockUntil: lockFor(run.backupDate) });
          entry.chunks.push({ key, rows: lines.length, sha256: sha256Hex(ndjson), objectSha256: sha256Hex(sealed), bytes: sealed.length });
          entry.rows += lines.length;
          rowsAdded += lines.length;
          c.chunk++;
          c.off += lines.length;
        }
        if (lines.length < CHUNK_ROWS) {
          c.t++;
          c.off = 0;
          c.chunk = 0;
        }
      }
      const finished = c.t >= c.tables.length;
      run = await save(run, c, { phase: finished ? "FILES" : "DB", rows: { increment: BigInt(rowsAdded) }, tables: c.done.length });
      worked = true;
    }
    if (run.phase === "FILES" && (!worked || Date.now() < deadline)) {
      worked = true;
      const { pendingLeft } = await uploadPendingFiles(run, c, target, store, deadline);
      run = await save(run, c, { phase: pendingLeft ? "FILES" : "MANIFEST" });
    }
    if (run.phase === "MANIFEST" && (!worked || Date.now() < deadline)) {
      const ok = await writeManifest(run, c, target, now);
      if (!ok) {
        run = await save(run, c, { phase: "FILES" });
      } else {
        run = await prisma.backupRun.update({ where: { id: run.id }, data: { status: "SUCCEEDED", phase: "PRUNE", finishedAt: new Date(), leaseUntil: null } });
        // Pruning and the purge never turn a finished backup into a failure; problems are recorded.
        c.prune = await afterSuccess(run, target, store, now);
        run = await prisma.backupRun.update({ where: { id: run.id }, data: { phase: "DONE", cursor: c as Prisma.InputJsonValue, prunedAt: new Date() } });
        return { runId, state: "done", phase: "DONE" };
      }
    }
    await prisma.backupRun.update({ where: { id: run.id }, data: { leaseUntil: null, steps: { increment: 1 } } });
    return { runId, state: "progress", phase: run.phase };
  } catch (err) {
    const message = describeError(err);
    await prisma.backupRun.update({ where: { id: run.id }, data: { status: "FAILED", error: message, finishedAt: new Date(), leaseUntil: null } });
    return { runId, state: "failed", phase: run.phase, error: message };
  }
}

function describeError(err: unknown): string {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  // Never echo credentials or URLs with secrets; provider messages are short.
  const clean = msg.replace(/(key|secret|token|password)=[^\s&]+/gi, "$1=…").slice(0, 500);
  if (/ObjectLock|object lock|InvalidRequest/i.test(clean)) return `${clean} — if this provider doesn't support per-object locks, set BACKUP_OBJECT_LOCK_MODE=OFF (and use the provider's bucket lock instead).`;
  return clean;
}

async function save(run: BackupRun, c: Cursor, data: Prisma.BackupRunUpdateInput) {
  return prisma.backupRun.update({ where: { id: run.id }, data: { ...data, cursor: c as Prisma.InputJsonValue, heartbeatAt: new Date() } });
}

export const objectKeyFor = (storageKey: string) => `files/${sha256Hex(storageKey)}.tcb`;

/** Live files not yet in the bucket (or whose index row was pruned), in priority order. */
async function pendingFiles(): Promise<{ live: InventoryItem[]; pending: InventoryItem[] }> {
  const live = sortByGroup(await fileInventory());
  const idx = await prisma.backupFileIndex.findMany({ select: { storageKey: true, prunedAt: true, plainSha256: true } });
  const have = new Map(idx.map((i) => [i.storageKey, i]));
  const pending = live.filter((f) => {
    const i = have.get(f.storageKey);
    // New, pruned, or changed (recorded sha256 no longer matches).
    return !i || i.prunedAt || (!!f.sha256 && !!i.plainSha256 && f.sha256 !== i.plainSha256);
  });
  return { live, pending };
}

async function uploadPendingFiles(run: BackupRun, c: Cursor, target: BackupTarget, store: Driver, deadline: number) {
  const { pending } = await pendingFiles();
  let uploaded = 0, bytes = 0;
  const missing = new Set(c.missing ?? []);
  let left = 0;
  for (const f of pending) {
    if (missing.has(f.storageKey)) continue;
    if (uploaded > 0 && Date.now() > deadline) {
      left++;
      continue;
    }
    const stored = await store.get(f.storageKey);
    if (!stored) {
      missing.add(f.storageKey);
      continue;
    }
    const sealed = sealBackup(stored);
    const objectKey = objectKeyFor(f.storageKey);
    const lockUntil = lockFor(run.backupDate);
    await target.put(objectKey, sealed, { lockUntil });
    const data = { objectKey, storedSha256: sha256Hex(stored), objectSha256: sha256Hex(sealed), plainSha256: f.sha256, sizeBytes: stored.length, sourceType: f.sourceType, sourceId: f.sourceId, group: f.group, firstRunId: run.id, firstRunAt: run.startedAt, goneAt: null, lockedUntil: lockUntil, prunedAt: null };
    await prisma.backupFileIndex.upsert({ where: { storageKey: f.storageKey }, create: { storageKey: f.storageKey, ...data }, update: data });
    uploaded++;
    bytes += sealed.length;
  }
  c.missing = [...missing];
  await prisma.backupRun.update({ where: { id: run.id }, data: { filesUploaded: { increment: uploaded }, bytesUploaded: { increment: BigInt(bytes) } } });
  return { pendingLeft: left };
}

async function writeManifest(run: BackupRun, c: Cursor, target: BackupTarget, now: Date): Promise<boolean> {
  const { live, pending } = await pendingFiles();
  const missing = new Set(c.missing ?? []);
  if (pending.some((p) => !missing.has(p.storageKey))) return false; // new files arrived: upload them first
  const liveKeys = new Set(live.map((l) => l.storageKey));
  // Files no longer in the live set (e.g. purged): kept in the bucket only while a kept backup lists them.
  const gone = await prisma.backupFileIndex.findMany({ where: { goneAt: null, prunedAt: null }, select: { storageKey: true } });
  const goneKeys = gone.filter((g) => !liveKeys.has(g.storageKey)).map((g) => g.storageKey);
  if (goneKeys.length) await prisma.backupFileIndex.updateMany({ where: { storageKey: { in: goneKeys } }, data: { goneAt: now } });
  // A file that came back (e.g. restored) is live again.
  await prisma.backupFileIndex.updateMany({ where: { storageKey: { in: [...liveKeys] }, goneAt: { not: null } }, data: { goneAt: null } });
  const idx = new Map((await prisma.backupFileIndex.findMany({ where: { storageKey: { in: [...liveKeys] } } })).map((i) => [i.storageKey, i]));
  const files: FileEntry[] = live
    .filter((l) => idx.has(l.storageKey))
    .map((l) => {
      const i = idx.get(l.storageKey)!;
      return { storageKey: l.storageKey, objectKey: i.objectKey, sourceType: l.sourceType, sourceId: l.sourceId, group: l.group, storedSha256: i.storedSha256, objectSha256: i.objectSha256, plainSha256: i.plainSha256, sizeBytes: i.sizeBytes };
    });
  const tables = c.done ?? [];
  const manifest: Manifest = {
    format: "tturner-backup/1",
    runId: run.id,
    backupDate: run.backupDate,
    createdAt: new Date().toISOString(),
    lastMigration: lastMigrationName(),
    schemaFingerprint: await schemaFingerprint(prisma),
    appKeyVersion: currentFileKeyVersion(),
    backupKeyId: backupKeyId(),
    tables,
    files,
    totals: { tables: tables.length, rows: tables.reduce((n, t) => n + t.rows, 0), files: files.length, fileBytes: files.reduce((n, f) => n + f.sizeBytes, 0) },
  };
  const sealed = sealBackup(gzipSync(Buffer.from(JSON.stringify(manifest), "utf8")));
  const key = `${run.prefix}${MANIFEST_NAME}`;
  await target.put(key, sealed, { lockUntil: lockFor(run.backupDate) });
  await prisma.backupRun.update({ where: { id: run.id }, data: { manifestKey: key, manifestSha256: sha256Hex(sealed), files: files.length, lastMigration: manifest.lastMigration, lockedUntil: lockFor(run.backupDate), retention: "DAILY" } });
  return true;
}

/** After a successful backup: retention pruning (respecting locks), lock extension, and the 30-day purge. */
async function afterSuccess(run: BackupRun, target: BackupTarget, store: Driver, now: Date) {
  const res = { runsPruned: 0, objectsDeleted: 0, keptByLock: 0, locksExtended: 0, purged: 0, waitingForBackup: 0 } as NonNullable<Cursor["prune"]>;
  try {
    Object.assign(res, await pruneBackups(target, now));
  } catch (err) {
    res.error = describeError(err);
  }
  try {
    const { purgeExpiredDeletions } = await import("@/lib/services/recently-deleted");
    const p = await purgeExpiredDeletions(now, store);
    res.purged = p.purged;
    res.waitingForBackup = p.waitingForBackup;
  } catch (err) {
    res.error = [res.error, describeError(err)].filter(Boolean).join(" · ");
  }
  void run;
  return res;
}

/**
 * Deletes only backup objects outside the policy, never the latest successful backup, and never an
 * object whose lock date hasn't passed (the provider would refuse anyway). Month-end and year-end
 * backups get their locks extended to match their longer retention.
 */
export async function pruneBackups(target: BackupTarget, now = new Date()) {
  const today = officeDate(now);
  const runs = await prisma.backupRun.findMany({ where: { status: "SUCCEEDED", OR: [{ retention: null }, { retention: { not: "PRUNED" } }] }, orderBy: { startedAt: "asc" } });
  const decisions = classifyRuns(runs, today);
  let runsPruned = 0, objectsDeleted = 0, keptByLock = 0, locksExtended = 0;
  for (const r of runs) {
    const d = decisions.get(r.id)!;
    if (d.keep) {
      if (r.retention !== d.cls) {
        // Longer retention → longer lock on this night's database chunks and manifest.
        if (d.cls !== "DAILY") {
          for (const o of await target.list(r.prefix)) {
            await target.extendLock(o.key, d.keepUntil);
            locksExtended++;
          }
        }
        await prisma.backupRun.update({ where: { id: r.id }, data: { retention: d.cls, lockedUntil: d.keepUntil } });
      }
      continue;
    }
    if (r.lockedUntil && r.lockedUntil > now) {
      keptByLock++;
      continue;
    }
    let blocked = false;
    for (const o of await target.list(r.prefix)) {
      try {
        await target.delete(o.key);
        objectsDeleted++;
      } catch (err) {
        if (err instanceof LockedObjectError) {
          blocked = true;
          keptByLock++;
        } else throw err;
      }
    }
    if (!blocked) {
      await prisma.backupRun.update({ where: { id: r.id }, data: { retention: "PRUNED" } });
      runsPruned++;
    }
  }
  // File objects: needed while any kept backup lists them (uploaded before it, gone after it).
  const kept = runs.filter((r) => decisions.get(r.id)!.keep);
  const goneFiles = await prisma.backupFileIndex.findMany({ where: { goneAt: { not: null }, prunedAt: null } });
  for (const f of goneFiles) {
    const needed = kept.some((r) => r.startedAt >= f.firstRunAt && r.startedAt < f.goneAt!);
    if (needed) continue;
    if (f.lockedUntil && f.lockedUntil > now) {
      keptByLock++;
      continue;
    }
    try {
      await target.delete(f.objectKey);
      objectsDeleted++;
      await prisma.backupFileIndex.update({ where: { storageKey: f.storageKey }, data: { prunedAt: now } });
    } catch (err) {
      if (err instanceof LockedObjectError) keptByLock++;
      else throw err;
    }
  }
  // Live files: keep each object locked at least DAILY_DAYS ahead (a few hundred per night, rolling).
  const soon = new Date(now.getTime() + 7 * 86_400_000);
  const toExtend = await prisma.backupFileIndex.findMany({ where: { goneAt: null, prunedAt: null, OR: [{ lockedUntil: null }, { lockedUntil: { lt: soon } }] }, take: 500 });
  const until = new Date(now.getTime() + (DAILY_DAYS + 1) * 86_400_000);
  for (const f of toExtend) {
    await target.extendLock(f.objectKey, until);
    await prisma.backupFileIndex.update({ where: { storageKey: f.storageKey }, data: { lockedUntil: until } });
    locksExtended++;
  }
  return { runsPruned, objectsDeleted, keptByLock, locksExtended };
}

/** Whether tonight's backup is due: after 2:00 AM office time, and no backup started yet today. */
export async function nightlyDue(now = new Date()): Promise<boolean> {
  const p = chicagoParts(now);
  if (p.hour < 2) return false;
  const today = officeDate(now);
  const runs = await prisma.backupRun.findMany({ where: { backupDate: today, trigger: "NIGHTLY" }, select: { status: true } });
  if (runs.some((r) => r.status === "SUCCEEDED" || r.status === "RUNNING")) return false;
  // A failed night gets one more try (at the next scheduled call), then waits for tomorrow.
  return runs.length < 2;
}

/**
 * The scheduler's entry point (POST /api/cron/backup with CRON_SECRET). Steps a running backup,
 * starts tonight's when due, and otherwise checks alerts. Does nothing unless backups are active.
 */
export async function backupTick(opts: StepOptions = {}): Promise<{ state: "idle" | "progress" | "done" | "failed" | "busy"; reason?: string; runId?: string; phase?: string }> {
  const now = opts.now ?? new Date();
  const { checkBackupAlerts } = await import("@/lib/services/backups");
  if (!backupEnvComplete()) {
    await checkBackupAlerts(now).catch(() => {});
    return { state: "idle", reason: "Backup storage isn't configured." };
  }
  if (!(await backupSwitchOn())) {
    await checkBackupAlerts(now).catch(() => {});
    return { state: "idle", reason: "Nightly backups are switched off." };
  }
  let run = await prisma.backupRun.findFirst({ where: { status: "RUNNING" }, orderBy: { startedAt: "desc" } });
  if (run && now.getTime() - run.startedAt.getTime() > 20 * 3600_000) {
    await prisma.backupRun.update({ where: { id: run.id }, data: { status: "FAILED", error: "Didn't finish within 20 hours.", finishedAt: now } });
    run = null;
  }
  if (!run && (await nightlyDue(now))) run = await startBackupRun({ trigger: "NIGHTLY", now });
  if (!run) {
    await checkBackupAlerts(now);
    return { state: "idle", reason: "Nothing due." };
  }
  const r = await stepBackupRun(run.id, opts);
  if (r.state === "failed" || r.state === "done") await checkBackupAlerts(now);
  return r;
}

/** Runs a whole backup in-process (tests, the CLI, local drills). */
export async function runBackupToCompletion(opts: StepOptions & { trigger?: "NIGHTLY" | "MANUAL"; startedById?: string | null; maxSteps?: number } = {}) {
  const run = await startBackupRun({ trigger: opts.trigger ?? "MANUAL", startedById: opts.startedById, now: opts.now });
  for (let i = 0; i < (opts.maxSteps ?? 1000); i++) {
    const r = await stepBackupRun(run.id, opts);
    if (r.state === "done" || r.state === "failed") return { ...r, run: await prisma.backupRun.findUniqueOrThrow({ where: { id: run.id } }) };
  }
  throw new Error("Backup didn't finish within the step limit.");
}
