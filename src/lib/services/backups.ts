import "server-only";
import type { Prisma } from "@prisma/client";
import { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { assertOwner, ownerAudit } from "@/lib/auth/owner";
import type { Actor } from "@/lib/auth/actor";
import { sendEmail } from "@/lib/email";
import { previousKeyConfigured } from "@/lib/crypto";
import { createMemoryStorage } from "@/lib/storage";
import { backupEnvComplete, backupTarget, BACKUP_ENV, lockModeFromEnv } from "@/lib/backup/target";
import { backupSwitchOn, officeDate, startBackupRun, stepBackupRun } from "@/lib/backup/runner";
import { assertScratchTarget, verifyBackupInto, type RestoreReport } from "@/lib/backup/restore";
import { heartbeat } from "./documents";
import { ValidationError } from "./clients";

/**
 * Owner's Office → Backups: the "Nightly backups" switch, the settings checklist (names only,
 * never values), runs, restore tests, key-escrow attestation, and the alerts that tell the owner
 * when something is wrong. Only the primary owner changes anything here.
 */

export const RESTORE_TEST_EVERY_DAYS = 90;
export const RESTORE_TEST_STALE_DAYS = 100;
const DAY = 86_400_000;

/** Which settings this deployment can see — set / not set only. */
export function backupSettingsChecklist(env: NodeJS.ProcessEnv = process.env) {
  const set = (k: string) => !!env[k]?.trim();
  const rows: { name: string; set: boolean; note: string }[] = [
    ...BACKUP_ENV.map((name) => ({ name, set: set(name), note: name === "BACKUP_ENCRYPTION_KEY" ? "Separate from APP_ENCRYPTION_KEY; never stored in the bucket." : "Backup bucket (S3-compatible)." })),
    { name: "BACKUP_OBJECT_LOCK_MODE", set: set("BACKUP_OBJECT_LOCK_MODE"), note: `Object Lock mode for each backup object (now: ${lockModeFromEnv(env)}).` },
    { name: "APP_ENCRYPTION_KEY", set: set("APP_ENCRYPTION_KEY"), note: "Encrypts documents. Restores need it too." },
    { name: "APP_ENCRYPTION_KEY_PREVIOUS", set: set("APP_ENCRYPTION_KEY_PREVIOUS"), note: "Only during a key rotation." },
    { name: "CRON_SECRET", set: set("CRON_SECRET"), note: "Lets the nightly schedule start the backup." },
    { name: "RESTORE_SCRATCH_DATABASE_URL", set: set("RESTORE_SCRATCH_DATABASE_URL"), note: "Optional: a scratch database for restore checks from this page." },
  ];
  const keysDiffer = !!env.BACKUP_ENCRYPTION_KEY && env.BACKUP_ENCRYPTION_KEY !== env.APP_ENCRYPTION_KEY;
  return { rows, ready: backupEnvComplete(env), keysDiffer, previousKey: previousKeyConfigured() };
}

export async function setNightlyBackups(actor: Actor, on: boolean) {
  await assertOwner(actor);
  if (on && !backupEnvComplete()) throw new ValidationError("Add every BACKUP_* setting in Netlify first (see the checklist).");
  const before = await backupSwitchOn();
  const data = { nightlyBackupsEnabled: on, nightlyBackupsChangedById: actor.id, nightlyBackupsChangedAt: new Date(), updatedById: actor.id };
  await prisma.integrationSettings.upsert({ where: { id: "default" }, create: { id: "default", ...data }, update: data });
  const details = { switch: "Nightly backups", from: before, to: on };
  await audit(prisma, { actorId: actor.id, action: `backups.nightly_${on ? "on" : "off"}`, entityType: "IntegrationSettings", entityId: "default", details });
  await ownerAudit(actor.id, `backups.nightly_${on ? "on" : "off"}`, "IntegrationSettings", "default", details);
}

/** The owner's attestation that both keys are held offline (two sealed copies, stored separately). */
export async function confirmKeyEscrow(actor: Actor, input: { checked: boolean; note?: string }) {
  await assertOwner(actor);
  if (!input.checked) throw new ValidationError("Tick the box to confirm both keys are in escrow.");
  const data = { keyEscrowConfirmedAt: new Date(), keyEscrowConfirmedById: actor.id, keyEscrowNote: input.note?.trim().slice(0, 300) || null, updatedById: actor.id };
  await prisma.integrationSettings.upsert({ where: { id: "default" }, create: { id: "default", ...data }, update: data });
  await audit(prisma, { actorId: actor.id, action: "backups.key_escrow_confirmed", entityType: "IntegrationSettings", entityId: "default", details: { note: data.keyEscrowNote } });
  await ownerAudit(actor.id, "backups.key_escrow_confirmed", "IntegrationSettings", "default", { note: data.keyEscrowNote });
}

export async function backupOverview(now = new Date()) {
  const s = await prisma.integrationSettings.findUnique({ where: { id: "default" } });
  const runs = await prisma.backupRun.findMany({ orderBy: { startedAt: "desc" }, take: 30 });
  const lastSuccess = await prisma.backupRun.findFirst({ where: { status: "SUCCEEDED" }, orderBy: { finishedAt: "desc" } });
  const tests = await prisma.restoreTest.findMany({ orderBy: { startedAt: "desc" }, take: 20 });
  const lastPassed = await prisma.restoreTest.findFirst({ where: { status: "PASSED" }, orderBy: { startedAt: "desc" } });
  const files = await prisma.backupFileIndex.aggregate({ where: { prunedAt: null }, _count: true, _sum: { sizeBytes: true } });
  const nextDue = lastPassed ? new Date(lastPassed.startedAt.getTime() + RESTORE_TEST_EVERY_DAYS * DAY) : null;
  return {
    switchOn: s?.nightlyBackupsEnabled === true,
    switchChangedAt: s?.nightlyBackupsChangedAt ?? null,
    escrow: { at: s?.keyEscrowConfirmedAt ?? null, note: s?.keyEscrowNote ?? null },
    settings: backupSettingsChecklist(),
    runs,
    lastSuccess,
    staleBackup: !lastSuccess?.finishedAt || now.getTime() - lastSuccess.finishedAt.getTime() > 48 * 3600_000,
    tests,
    lastPassedTest: lastPassed,
    nextTestDue: nextDue,
    testOverdue: !lastPassed || now.getTime() - lastPassed.startedAt.getTime() > RESTORE_TEST_STALE_DAYS * DAY,
    filesInBucket: files._count,
    fileBytesInBucket: files._sum.sizeBytes ?? 0,
  };
}

/** Owner: start a backup now. Works for ~15 seconds here; the schedule finishes anything left. */
export async function runBackupNow(actor: Actor) {
  await assertOwner(actor);
  if (!backupEnvComplete()) throw new ValidationError("Backup storage isn't configured yet (see the checklist).");
  const run = await startBackupRun({ trigger: "MANUAL", startedById: actor.id });
  await ownerAudit(actor.id, "backups.run_now", "BackupRun", run.id);
  return stepBackupRun(run.id, { budgetMs: 15_000 });
}

export async function recordRestoreTest(input: { backupRunId?: string | null; manifestKey: string; mode: "VERIFY" | "FULL"; source: "PAGE" | "CLI"; startedById?: string | null; startedAt: Date; report?: RestoreReport | null; error?: string | null }) {
  const passed = !!input.report?.ok && !input.error;
  const result = input.report ? { ...input.report, rowCounts: input.report.rowCounts.filter((r) => r.expected !== r.restored).slice(0, 50), tablesCompared: input.report.rowCounts.length } : null;
  const t = await prisma.restoreTest.create({
    data: { backupRunId: input.backupRunId ?? null, manifestKey: input.manifestKey, mode: input.mode, source: input.source, status: passed ? "PASSED" : "FAILED", startedById: input.startedById ?? null, startedAt: input.startedAt, finishedAt: new Date(), result: (result ?? undefined) as Prisma.InputJsonValue | undefined, error: input.error ?? (input.report && !input.report.ok ? input.report.problems.slice(0, 5).join(" · ").slice(0, 1000) : null) },
  });
  await audit(prisma, { actorId: input.startedById ?? null, action: `backups.restore_test_${passed ? "passed" : "failed"}`, entityType: "RestoreTest", entityId: t.id, details: { mode: input.mode, source: input.source, manifestKey: input.manifestKey } });
  // A passed test closes the quarterly reminder task.
  if (passed) await prisma.task.updateMany({ where: { title: RESTORE_TASK_TITLE, status: "OPEN" }, data: { status: "DONE", completedAt: new Date() } }).catch(() => {});
  return t;
}

/**
 * Owner: verify the newest successful backup from this page. Files go to a throwaway in-memory
 * store; the database goes to RESTORE_SCRATCH_DATABASE_URL when set (never the live database),
 * otherwise rows are counted from the decrypted chunks. The CLI does the same with a full scratch database.
 */
export async function runRestoreVerification(actor: Actor, runId?: string) {
  await assertOwner(actor);
  const run = runId ? await prisma.backupRun.findFirst({ where: { id: runId, status: "SUCCEEDED" } }) : await prisma.backupRun.findFirst({ where: { status: "SUCCEEDED" }, orderBy: { finishedAt: "desc" } });
  if (!run?.manifestKey) throw new ValidationError("There's no successful backup to check yet.");
  const startedAt = new Date();
  const scratchUrl = process.env.RESTORE_SCRATCH_DATABASE_URL?.trim();
  let scratch: PrismaClient | null = null;
  try {
    if (scratchUrl) {
      assertScratchTarget(scratchUrl);
      scratch = new PrismaClient({ datasourceUrl: scratchUrl });
    }
    const report = await verifyBackupInto({ target: backupTarget(), manifestKey: run.manifestKey, expectedManifestSha256: run.manifestSha256, db: scratch, store: createMemoryStorage(), sampleSize: 10, deadline: Date.now() + 22_000 });
    return { report, test: await recordRestoreTest({ backupRunId: run.id, manifestKey: run.manifestKey, mode: "VERIFY", source: "PAGE", startedById: actor.id, startedAt, report }) };
  } catch (err) {
    const error = (err as Error).message.slice(0, 500);
    return { report: null, test: await recordRestoreTest({ backupRunId: run.id, manifestKey: run.manifestKey, mode: "VERIFY", source: "PAGE", startedById: actor.id, startedAt, error }) };
  } finally {
    await scratch?.$disconnect();
  }
}

export const BACKUP_FAILED_TITLE = "Nightly backup failed";
export const BACKUP_STALE_TITLE = "No successful backup in 48 hours";
export const RESTORE_TASK_TITLE = "Quarterly restore test: run restore-verify";
export const RESTORE_STALE_TITLE = "Restore test is more than 100 days old";

async function ownerUser() {
  const o = await prisma.ownerAccess.findFirst({ where: { isPrimary: true, revokedAt: null }, select: { user: { select: { id: true, email: true, active: true } } } });
  return o?.user?.active ? o.user : null;
}

async function alertOwner(title: string, details: string, priority: "HIGH" | "NORMAL", dueAt: Date | null = null) {
  const owner = await ownerUser();
  if (!owner) return false;
  // One open task per kind of alert.
  if (!(await prisma.task.count({ where: { title, status: "OPEN" } }))) {
    await prisma.task.create({ data: { title, details, priority, assigneeId: owner.id, createdById: owner.id, dueAt: dueAt ?? new Date() } });
  }
  if (priority === "HIGH") {
    // Email only if configured; never includes data, only that something needs attention.
    await sendEmail({ to: owner.email, subject: `Client Connect: ${title}`, text: `${details}\n\nOpen Owner's Office → Backups for details.`, idempotencyKey: `backup-alert:${title}:${officeDate()}` }).catch(() => null);
  }
  return true;
}

/** Called by every scheduled backup tick. Safe to call often: each alert is sent at most once a day. */
export async function checkBackupAlerts(now = new Date()) {
  const active = backupEnvComplete() && (await backupSwitchOn());
  const sent: string[] = [];
  if (active) {
    for (const r of await prisma.backupRun.findMany({ where: { status: "FAILED", alertedAt: null } })) {
      await alertOwner(BACKUP_FAILED_TITLE, `The backup started ${r.startedAt.toISOString()} failed: ${r.error ?? "unknown error"}`, "HIGH");
      await prisma.backupRun.update({ where: { id: r.id }, data: { alertedAt: now } });
      sent.push("failed");
    }
    const s = await prisma.integrationSettings.findUnique({ where: { id: "default" }, select: { nightlyBackupsChangedAt: true } });
    const since = s?.nightlyBackupsChangedAt ?? now;
    const last = await prisma.backupRun.findFirst({ where: { status: "SUCCEEDED" }, orderBy: { finishedAt: "desc" } });
    const lastAt = last?.finishedAt ?? null;
    const stale = now.getTime() - (lastAt ?? since).getTime() > 48 * 3600_000;
    if (stale && (await onceADay("backup:stale-alert", now))) {
      await alertOwner(BACKUP_STALE_TITLE, lastAt ? `The last successful backup finished ${lastAt.toISOString()}.` : "No backup has succeeded since nightly backups were turned on.", "HIGH");
      sent.push("stale");
    }
  }
  // Restore testing: a quarterly reminder, and a high-priority alert past 100 days.
  if (active || (await prisma.backupRun.count({ where: { status: "SUCCEEDED" } }))) {
    const lastTest = await prisma.restoreTest.findFirst({ where: { status: "PASSED" }, orderBy: { startedAt: "desc" } });
    const quarter = `${now.getUTCFullYear()}-Q${Math.floor(now.getUTCMonth() / 3) + 1}`;
    const testedThisQuarter = !!lastTest && `${lastTest.startedAt.getUTCFullYear()}-Q${Math.floor(lastTest.startedAt.getUTCMonth() / 3) + 1}` === quarter;
    const beat = await prisma.systemHeartbeat.findUnique({ where: { key: "restore-test:reminder" } });
    if (!testedThisQuarter && (beat?.detail as { quarter?: string } | null)?.quarter !== quarter) {
      const qEnd = new Date(Date.UTC(now.getUTCFullYear(), Math.floor(now.getUTCMonth() / 3) * 3 + 3, 0));
      await alertOwner(RESTORE_TASK_TITLE, "Once a quarter, run a restore check: Owner's Office → Backups → Verify the latest backup (or scripts/backup-restore.ts verify into a scratch database). The result is recorded for the WISP.", "NORMAL", qEnd);
      await heartbeat("restore-test:reminder", { quarter });
      sent.push("quarterly");
    }
    const stale = !lastTest || now.getTime() - lastTest.startedAt.getTime() > RESTORE_TEST_STALE_DAYS * DAY;
    if (stale && (await prisma.backupRun.count({ where: { status: "SUCCEEDED", finishedAt: { lt: new Date(now.getTime() - 7 * DAY) } } })) && (await onceADay("restore-test:stale-alert", now, 7))) {
      await alertOwner(RESTORE_STALE_TITLE, lastTest ? `The last passed restore test was ${lastTest.startedAt.toISOString().slice(0, 10)}.` : "No restore test has passed yet.", "HIGH");
      sent.push("restore-stale");
    }
  }
  return sent;
}

async function onceADay(key: string, now: Date, days = 1) {
  const b = await prisma.systemHeartbeat.findUnique({ where: { key } });
  if (b && now.getTime() - b.at.getTime() < days * DAY) return false;
  await prisma.systemHeartbeat.upsert({ where: { key }, create: { key, at: now, detail: {} }, update: { at: now } });
  return true;
}
