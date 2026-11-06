import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { assertOwner, ownerAudit } from "@/lib/auth/owner";
import type { Actor } from "@/lib/auth/actor";
import { storage, type Driver } from "@/lib/storage";
import { currentFileKeyVersion, decryptBytes, encryptBytes, fileKeyVersionOf, looksEncrypted } from "@/lib/crypto";
import { fileInventory, normalizeGroupOrder, sortByGroup, totalsByGroup, type FileGroup, type InventoryItem } from "@/lib/doc-security/inventory";
import { ValidationError } from "./clients";

/**
 * Moving EXISTING files to encrypted storage. Never automatic: it runs only when the owner starts
 * a batch in Owner's Office → File encryption, or from scripts/encrypt-files.ts. Per file:
 *   a. read the stored bytes;  b. encrypt;  c. write to a NEW storage key (the original is never
 *   overwritten);  d. read the new copy back, decrypt it and check its sha256 against the recorded
 *   sha256;  e. in one transaction point the record at the new key and mark it encrypted;
 *   f. record the original key in PendingOriginalRemoval.
 * Originals are never deleted here. The owner removes them separately (removeEligibleOriginals),
 * only after 30 days AND a successful backup that holds the encrypted copy. A failure leaves the
 * original and the record untouched; the file is retried on the next batch.
 *
 * Mode REKEY does the same for files encrypted with an older key (after a key rotation).
 */

export type Operator = { actor: Actor } | { cli: string };
export type EncryptionMode = "ENCRYPT" | "REKEY";

const MAX_ATTEMPTS = 5;
export const ORIGINAL_HOLD_DAYS = 30;

async function authorize(op: Operator) {
  if ("actor" in op) await assertOwner(op.actor);
}

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function needsWork(i: InventoryItem, mode: EncryptionMode, current: string) {
  if (mode === "ENCRYPT") return !i.encrypted;
  // REKEY: encrypted, but not known to be on the current key. (Sign-up files and receipts carry the key
  // version only in their header, so they are checked when read.)
  return i.encrypted && i.keyVersion !== current;
}

/** Files that still need the job, in the owner's group order. */
export async function encryptionCandidates(mode: EncryptionMode = "ENCRYPT", order?: string[] | null) {
  const current = currentFileKeyVersion();
  const inv = await fileInventory();
  return sortByGroup(inv.filter((i) => needsWork(i, mode, current)), normalizeGroupOrder(order));
}

/** Dry run: what a run would move, by category, without reading or writing a single file. */
export async function encryptionDryRun(op: Operator, mode: EncryptionMode = "ENCRYPT", order?: string[] | null) {
  await authorize(op);
  const items = await encryptionCandidates(mode, order);
  const all = await fileInventory();
  const groups = totalsByGroup(items);
  return {
    mode,
    order: normalizeGroupOrder(order),
    files: items.length,
    bytes: items.reduce((n, i) => n + (i.sizeBytes ?? 0), 0),
    unknownSize: items.filter((i) => i.sizeBytes == null).length,
    groups,
    alreadyEncrypted: all.filter((i) => i.encrypted).length,
    totalFiles: all.length,
  };
}

export async function currentJob(mode?: EncryptionMode) {
  return prisma.fileEncryptionJob.findFirst({ where: { status: { in: ["RUNNING", "PAUSED"] }, ...(mode ? { mode } : {}) }, orderBy: { startedAt: "desc" } });
}

/** Starts (or resumes) a job. Only the owner (or the CLI). */
export async function startEncryptionJob(op: Operator, mode: EncryptionMode = "ENCRYPT", order?: string[] | null) {
  await authorize(op);
  const existing = await currentJob(mode);
  const groupOrder = normalizeGroupOrder(order);
  if (existing) {
    return prisma.fileEncryptionJob.update({ where: { id: existing.id }, data: { status: "RUNNING", ...(order ? { groupOrder } : {}) } });
  }
  const items = await encryptionCandidates(mode, groupOrder);
  const job = await prisma.fileEncryptionJob.create({
    data: { mode, groupOrder, startedById: "actor" in op ? op.actor.id : null, source: "actor" in op ? "PAGE" : "CLI", totalFiles: items.length, totalBytes: BigInt(items.reduce((n, i) => n + (i.sizeBytes ?? 0), 0)) },
  });
  const details = { mode, files: items.length, order: groupOrder };
  await audit(prisma, { actorId: "actor" in op ? op.actor.id : null, action: "files.encryption_job_started", entityType: "FileEncryptionJob", entityId: job.id, details });
  if ("actor" in op) await ownerAudit(op.actor.id, "files.encryption_job_started", "FileEncryptionJob", job.id, details);
  return job;
}

export async function pauseEncryptionJob(op: Operator, jobId: string) {
  await authorize(op);
  await prisma.fileEncryptionJob.updateMany({ where: { id: jobId, status: "RUNNING" }, data: { status: "PAUSED" } });
}

type ItemResult = { ok: true; bytes: number } | { ok: false; error: string };

/** New key in the same store as the original (client documents stay in the client-document store). */
function newKeyFor(oldKey: string) {
  const top = oldKey.split("/")[0];
  return `${top}/enc/${randomUUID()}`;
}

async function migrateOne(item: InventoryItem, mode: EncryptionMode, jobId: string, store: Driver): Promise<ItemResult> {
  // a. Read.
  const stored = await store.get(item.storageKey);
  if (!stored) return { ok: false, error: "The original file couldn't be read from storage." };
  let plain: Uint8Array;
  if (mode === "REKEY" || looksEncrypted(stored)) {
    // REKEY, or a sign-up file / receipt already written encrypted (the flag was missing).
    plain = decryptBytes(stored);
    if (mode === "REKEY" && fileKeyVersionOf(stored) === currentFileKeyVersion()) {
      await markEncrypted(item, item.storageKey, currentFileKeyVersion(), null);
      return { ok: true, bytes: 0 };
    }
    if (mode === "ENCRYPT" && looksEncrypted(stored)) {
      await markEncrypted(item, item.storageKey, fileKeyVersionOf(stored), null);
      return { ok: true, bytes: 0 };
    }
  } else {
    plain = stored;
  }
  const expected = item.sha256 ?? sha(plain);
  if (item.sha256 && sha(plain) !== item.sha256) {
    return { ok: false, error: "The stored file doesn't match its recorded fingerprint (sha256). Left as it is for review." };
  }
  // b–c. Encrypt and write to a new key. The original is never overwritten.
  const newKey = newKeyFor(item.storageKey);
  if (await store.get(newKey)) return { ok: false, error: "Key collision; will retry." };
  await store.put(newKey, encryptBytes(plain));
  // d. Read back, decrypt, verify.
  const back = await store.get(newKey);
  let verified = false;
  try {
    verified = !!back && sha(decryptBytes(back)) === expected;
  } catch {
    verified = false;
  }
  if (!verified) {
    // Only the new, never-referenced copy is removed. The original stays exactly as it was.
    await store.remove(newKey).catch(() => {});
    return { ok: false, error: "The encrypted copy didn't verify after writing (sha256 mismatch). The original is untouched." };
  }
  // e–f. Swap the record to the new key and remember the original, in one transaction.
  const keyVersion = currentFileKeyVersion();
  try {
    await prisma.$transaction(async (tx) => {
      let n = 0;
      if (item.sourceType === "StoredFile") {
        n = (await tx.storedFile.updateMany({ where: { id: item.sourceId, storageKey: item.storageKey }, data: { storageKey: newKey, encrypted: true, keyVersion, ...(item.sha256 ? {} : { sha256: expected }) } })).count;
      } else if (item.sourceType === "OnboardingFile") {
        n = (await tx.onboardingFile.updateMany({ where: { id: item.sourceId, storageKey: item.storageKey, movedDocumentId: null }, data: { storageKey: newKey, encrypted: true } })).count;
      } else {
        n = (await tx.expense.updateMany({ where: { id: item.sourceId, receiptKey: item.storageKey }, data: { receiptKey: newKey, receiptEncrypted: true } })).count;
      }
      if (n !== 1) throw new Error("The record changed while the file was being encrypted; will retry.");
      await tx.pendingOriginalRemoval.create({ data: { sourceType: item.sourceType, sourceId: item.sourceId, originalKey: item.storageKey, replacementKey: newKey, sha256: expected, reason: mode === "REKEY" ? "KEY_ROTATION" : "ENCRYPTION_MIGRATION", jobId } });
    });
  } catch (err) {
    await store.remove(newKey).catch(() => {});
    return { ok: false, error: err instanceof Error ? err.message.slice(0, 300) : "Couldn't update the record." };
  }
  return { ok: true, bytes: plain.length };
}

async function markEncrypted(item: InventoryItem, key: string, keyVersion: string | null, sha256: string | null) {
  if (item.sourceType === "StoredFile") await prisma.storedFile.update({ where: { id: item.sourceId }, data: { encrypted: true, keyVersion, ...(sha256 ? { sha256 } : {}) } });
  else if (item.sourceType === "OnboardingFile") await prisma.onboardingFile.update({ where: { id: item.sourceId }, data: { encrypted: true } });
  else await prisma.expense.update({ where: { id: item.sourceId }, data: { receiptEncrypted: true } });
  void key;
}

/**
 * One batch: up to `limit` files or `budgetMs`, whichever comes first. Safe to run again at any
 * time: it picks up whatever is still to do (failed files are retried, up to MAX_ATTEMPTS).
 */
export async function runEncryptionBatch(op: Operator, opts: { jobId?: string; limit?: number; budgetMs?: number; store?: Driver } = {}) {
  await authorize(op);
  const job = opts.jobId ? await prisma.fileEncryptionJob.findUnique({ where: { id: opts.jobId } }) : (await currentJob()) ?? (await prisma.fileEncryptionJob.findFirst({ where: { status: "COMPLETED" }, orderBy: { startedAt: "desc" } }));
  if (!job) throw new ValidationError("Start the encryption job first (dry run, then Start).");
  if (job.status === "COMPLETED") return { job, processed: 0, migrated: 0, failed: 0, remaining: 0 };
  if (job.status === "PAUSED") throw new ValidationError("The job is paused. Resume it first.");
  const store = opts.store ?? storage;
  const mode = job.mode as EncryptionMode;
  const limit = opts.limit ?? 25;
  const deadline = Date.now() + (opts.budgetMs ?? 15_000);
  const failed = await prisma.fileEncryptionItem.findMany({ where: { jobId: job.id, status: "FAILED" } });
  const failedBy = new Map(failed.map((f) => [`${f.sourceType}:${f.sourceId}`, f]));
  // Files that failed too often wait for the owner; fresh files come first, then retries.
  const candidates = (await encryptionCandidates(mode, job.groupOrder)).filter((c) => (failedBy.get(`${c.sourceType}:${c.sourceId}`)?.attempts ?? 0) < MAX_ATTEMPTS);
  const ordered = [...candidates.filter((c) => !failedBy.has(`${c.sourceType}:${c.sourceId}`)), ...candidates.filter((c) => failedBy.has(`${c.sourceType}:${c.sourceId}`))];
  let processed = 0, migrated = 0, failures = 0, bytes = 0;
  for (const item of ordered) {
    if (processed >= limit || Date.now() > deadline) break;
    processed++;
    let r: ItemResult;
    try {
      r = await migrateOne(item, mode, job.id, store);
    } catch (err) {
      r = { ok: false, error: err instanceof Error ? err.message.slice(0, 300) : "Unexpected error" };
    }
    const where = { jobId_sourceType_sourceId: { jobId: job.id, sourceType: item.sourceType, sourceId: item.sourceId } };
    if (r.ok) {
      migrated++;
      bytes += r.bytes;
      const after = item.sourceType === "StoredFile" ? (await prisma.storedFile.findUnique({ where: { id: item.sourceId }, select: { storageKey: true } }))?.storageKey : null;
      await prisma.fileEncryptionItem.upsert({ where, create: { jobId: job.id, sourceType: item.sourceType, sourceId: item.sourceId, group: item.group, status: "MIGRATED", oldKey: item.storageKey, newKey: after ?? null, sizeBytes: r.bytes }, update: { status: "MIGRATED", attempts: { increment: 1 }, newKey: after ?? null, lastError: null, sizeBytes: r.bytes } });
    } else {
      failures++;
      await prisma.fileEncryptionItem.upsert({ where, create: { jobId: job.id, sourceType: item.sourceType, sourceId: item.sourceId, group: item.group, status: "FAILED", oldKey: item.storageKey, lastError: r.error }, update: { status: "FAILED", attempts: { increment: 1 }, lastError: r.error } });
    }
  }
  const remaining = (await encryptionCandidates(mode, job.groupOrder)).length;
  const stillFailing = await prisma.fileEncryptionItem.count({ where: { jobId: job.id, status: "FAILED" } });
  const done = remaining === 0;
  const updated = await prisma.fileEncryptionJob.update({
    where: { id: job.id },
    data: {
      batches: { increment: 1 },
      lastBatchAt: new Date(),
      doneFiles: await prisma.fileEncryptionItem.count({ where: { jobId: job.id, status: "MIGRATED" } }),
      doneBytes: { increment: BigInt(bytes) },
      failedFiles: stillFailing,
      lastError: failures ? (await prisma.fileEncryptionItem.findFirst({ where: { jobId: job.id, status: "FAILED" }, orderBy: { updatedAt: "desc" } }))?.lastError ?? null : job.lastError,
      ...(done ? { status: "COMPLETED", finishedAt: new Date() } : {}),
    },
  });
  await audit(prisma, { actorId: "actor" in op ? op.actor.id : null, action: "files.encryption_batch", entityType: "FileEncryptionJob", entityId: job.id, details: { processed, migrated, failed: failures, remaining } });
  return { job: updated, processed, migrated, failed: failures, remaining };
}

/** Progress and failures for the status page. */
export async function encryptionStatus() {
  const jobs = await prisma.fileEncryptionJob.findMany({ orderBy: { startedAt: "desc" }, take: 10 });
  const failures = await prisma.fileEncryptionItem.findMany({ where: { status: "FAILED" }, orderBy: { updatedAt: "desc" }, take: 50 });
  const pending = await prisma.pendingOriginalRemoval.findMany({ where: { removedAt: null }, orderBy: { createdAt: "asc" }, take: 500 });
  const eligible = await eligibleOriginals();
  const inv = await fileInventory();
  return {
    jobs,
    failures,
    pendingOriginals: pending.length,
    eligibleOriginals: eligible.length,
    oldestPendingAt: pending[0]?.createdAt ?? null,
    encrypted: inv.filter((i) => i.encrypted).length,
    plaintext: inv.filter((i) => !i.encrypted).length,
    byGroup: totalsByGroup(inv).map((g) => ({ ...g, plaintext: inv.filter((i) => i.group === g.group && !i.encrypted).length })),
  };
}

/**
 * Originals that may now be removed: replaced at least 30 days ago AND the encrypted copy is in a
 * successful backup (BackupFileIndex row from a SUCCEEDED run, not pruned).
 */
export async function eligibleOriginals(now = new Date()) {
  const cutoff = new Date(now.getTime() - ORIGINAL_HOLD_DAYS * 24 * 60 * 60 * 1000);
  const rows = await prisma.pendingOriginalRemoval.findMany({ where: { removedAt: null, createdAt: { lte: cutoff } } });
  if (!rows.length) return [];
  const backed = await backedUpKeys(rows.map((r) => r.replacementKey));
  return rows.filter((r) => backed.has(r.replacementKey));
}

/** Storage keys held by at least one successful backup. */
export async function backedUpKeys(keys: string[]) {
  if (!keys.length) return new Set<string>();
  const idx = await prisma.backupFileIndex.findMany({ where: { storageKey: { in: keys }, prunedAt: null }, select: { storageKey: true, firstRunId: true } });
  const ok = new Set((await prisma.backupRun.findMany({ where: { id: { in: [...new Set(idx.map((i) => i.firstRunId))] }, status: "SUCCEEDED" }, select: { id: true } })).map((r) => r.id));
  return new Set(idx.filter((i) => ok.has(i.firstRunId)).map((i) => i.storageKey));
}

/** Owner-only, separate action: removes eligible originals and records each removal. */
export async function removeEligibleOriginals(op: Operator, opts: { store?: Driver; limit?: number } = {}) {
  await authorize(op);
  const store = opts.store ?? storage;
  const rows = (await eligibleOriginals()).slice(0, opts.limit ?? 200);
  let removed = 0;
  for (const r of rows) {
    // Never remove a key a record still points at.
    const inUse = (await prisma.storedFile.count({ where: { storageKey: r.originalKey } })) + (await prisma.onboardingFile.count({ where: { storageKey: r.originalKey } })) + (await prisma.expense.count({ where: { receiptKey: r.originalKey } }));
    if (inUse) continue;
    await store.remove(r.originalKey);
    await prisma.pendingOriginalRemoval.update({ where: { id: r.id }, data: { removedAt: new Date(), removedById: "actor" in op ? op.actor.id : null } });
    removed++;
  }
  const details = { removed, eligible: rows.length };
  await audit(prisma, { actorId: "actor" in op ? op.actor.id : null, action: "files.originals_removed", entityType: "PendingOriginalRemoval", entityId: "batch", details });
  if ("actor" in op) await ownerAudit(op.actor.id, "files.originals_removed", "PendingOriginalRemoval", "batch", details);
  return { removed };
}

export type { FileGroup };
