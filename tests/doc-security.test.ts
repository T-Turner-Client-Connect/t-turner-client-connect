import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { ForbiddenError } from "@/lib/auth/actor";
import { createClient } from "@/lib/services/clients";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { deleteDocument, portalDocuments, portalUploadDocument, readDocumentBytes, staffUploadDocument } from "@/lib/services/documents";
import { ensureClientPerson, uploadIdentityDocument } from "@/lib/services/identity";
import { bulkUploadReturns } from "@/lib/services/tax-returns";
import { readStoredFile, saveUpload } from "@/lib/services/files";
import { createExpense, readReceipt } from "@/lib/services/owner-expenses";
import { storage } from "@/lib/storage";
import { currentFileKeyVersion, decryptBytes, decryptSecret, encryptBytes, encryptSecret, fileKeyVersionOf, looksEncrypted } from "@/lib/crypto";
import { encryptionCandidates, encryptionDryRun, eligibleOriginals, removeEligibleOriginals, runEncryptionBatch, startEncryptionJob } from "@/lib/services/file-encryption";
import { deletePermanentlyNow, purgeExpiredDeletions, recentlyDeleted, restoreDeletedDocument, PERMANENT_DELETE_PHRASE } from "@/lib/services/recently-deleted";
import { setNightlyBackups, runRestoreVerification, confirmKeyEscrow } from "@/lib/services/backups";
import { MemoryTarget, setBackupTargetForTests } from "@/lib/backup/target";
import { runBackupToCompletion } from "@/lib/backup/runner";

let seq = 0;
const pdf = (tag = "") => new TextEncoder().encode(`%PDF-1.4\n% fictional document ${tag} ${seq++} ${Math.random()}\n`);
const PNG = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0, seq++ % 255, 0, 0, 0]);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const KEY_A = "test-only-encryption-key-0123456789abcdef";
const KEY_B = "rotated-test-only-key-fedcba9876543210-new";

function backupEnv() {
  vi.stubEnv("BACKUP_S3_ENDPOINT", "https://s3.example.test");
  vi.stubEnv("BACKUP_S3_REGION", "us-east-1");
  vi.stubEnv("BACKUP_S3_BUCKET", "fictional-backups");
  vi.stubEnv("BACKUP_S3_ACCESS_KEY_ID", "test-access-key");
  vi.stubEnv("BACKUP_S3_SECRET_ACCESS_KEY", "test-secret-key");
  vi.stubEnv("BACKUP_ENCRYPTION_KEY", "backup-only-test-key-0123456789abcdefXYZ");
}

beforeEach(async () => {
  await resetDb();
  vi.stubEnv("APP_ENCRYPTION_KEY", KEY_A);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setBackupTargetForTests(null);
});

async function office() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const admin = await makeUser("ADMIN", "Second Admin");
  const daria = await makeUser("STAFF", "Daria");
  const client = await createClient(tabitha, { businessName: "Pretend Bakery LLC (fictional)", clientType: "BUSINESS", status: "ACTIVE" });
  const { token } = await invitePortalUser(tabitha, client.id, { email: "owner@bakery.example", name: "Pat Pretend", role: "OWNER" });
  const u = await acceptPortalInvite(token!, "Client-Pass-12345");
  return { tabitha, admin, daria, client, portal: { id: u.id, name: u.name, email: u.email } };
}

/** A file written the old way: plaintext bytes, encrypted=false (as before this release). */
async function legacyDocument(clientId: string, actorId: string, bytes: Uint8Array, extra: { category?: "BOOKKEEPING" | "TAXES" | "OTHER" | "PAYROLL"; docType?: string | null } = {}) {
  const storageKey = `client_document/legacy-${seq++}-${Date.now()}`;
  await storage.put(storageKey, bytes);
  const file = await prisma.storedFile.create({ data: { kind: "CLIENT_DOCUMENT", storageKey, originalName: "old.pdf", title: "old", mimeType: "application/pdf", sizeBytes: bytes.length, sha256: sha(bytes), uploadedById: actorId, encrypted: false } });
  const doc = await prisma.document.create({ data: { clientId, category: extra.category ?? "OTHER", docType: extra.docType ?? null, title: "Old file", visibility: "STAFF_ONLY", fileId: file.id, scanStatus: "CLEAN", uploadedByStaffId: actorId } });
  return { file, doc, storageKey };
}

describe("encryption at rest", () => {
  it("every upload path stores encrypted bytes and records encrypted=true with a key version", async () => {
    const o = await office();
    const bank = await staffUploadDocument(o.tabitha, { clientId: o.client.id, category: "BOOKKEEPING", docType: "BANK_STATEMENT", visibility: "STAFF_ONLY", bytes: pdf("bank"), originalName: "oct-statement.pdf" });
    const payroll = await staffUploadDocument(o.tabitha, { clientId: o.client.id, category: "BOOKKEEPING", docType: "PAYROLL_REPORT", visibility: "STAFF_ONLY", bytes: pdf("payroll"), originalName: "register.pdf" });
    const contract = await staffUploadDocument(o.tabitha, { clientId: o.client.id, category: "CONTRACTS", visibility: "STAFF_ONLY", bytes: pdf("contract"), originalName: "signed.pdf" });
    const tax = await staffUploadDocument(o.tabitha, { clientId: o.client.id, category: "TAXES", visibility: "STAFF_ONLY", bytes: pdf("w2"), originalName: "w2.pdf" });
    const mine = await portalUploadDocument(o.portal, { clientId: o.client.id, bytes: pdf("client"), originalName: "receipt.pdf" });
    const me = await ensureClientPerson(o.client.id);
    // A business account's own record takes identity documents from our office only (owner logins
    // file their own per owner), so the identity upload path is exercised through staff.
    await expect(uploadIdentityDocument({ portal: o.portal }, { clientId: o.client.id, personId: me.id, type: "SOCIAL_SECURITY_CARD", bytes: pdf("ss"), originalName: "ss.pdf" })).rejects.toThrow(/each owner separately/);
    const id = await uploadIdentityDocument({ staff: o.tabitha }, { clientId: o.client.id, personId: me.id, type: "SOCIAL_SECURITY_CARD", bytes: pdf("ss"), originalName: "ss.pdf" });
    const [ret] = await bulkUploadReturns(o.tabitha, [{ bytes: pdf("return"), originalName: "1120s.pdf" }]);
    const evidence = await saveUpload(o.tabitha, { kind: "CONSENT_EVIDENCE", bytes: PNG(), originalName: "signed.png" });
    const original = pdf("receipt");
    const expense = await createExpense(o.tabitha, { spentOn: "2026-10-03", vendor: "Pretend Supply", category: "Software", amountCents: 1000, receipt: { bytes: original, originalName: "r.pdf" } });

    const intakeFileId = (await prisma.returnIntake.findUniqueOrThrow({ where: { id: ret.intakeId! } })).fileId;
    const docIds = [bank.id, payroll.id, contract.id, tax.id, mine.id, id.documentId!];
    const files = await prisma.storedFile.findMany({ where: { OR: [{ document: { id: { in: docIds } } }, { id: evidence.id }, { id: intakeFileId }] } });
    expect(files).toHaveLength(8);
    for (const f of files) {
      expect(f.encrypted).toBe(true);
      expect(f.keyVersion).toBe(currentFileKeyVersion());
      const stored = (await storage.get(f.storageKey))!;
      expect(looksEncrypted(stored)).toBe(true);
      // Stored bytes are ciphertext: they never contain the PDF header.
      expect(Buffer.from(stored).includes(Buffer.from("%PDF"))).toBe(false);
      if (f.sha256) expect(sha(decryptBytes(stored))).toBe(f.sha256);
    }
    // The owner's receipt is encrypted too, and still opens.
    const row = await prisma.expense.findUniqueOrThrow({ where: { id: expense.id } });
    expect(row.receiptEncrypted).toBe(true);
    expect(looksEncrypted((await storage.get(row.receiptKey!))!)).toBe(true);
    expect(sha((await readReceipt(o.tabitha, expense.id))!.bytes)).toBe(sha(original));
    expect((await readStoredFile(evidence.id))!.bytes[0]).toBe(0x89);
  });

  it("every storage.put in the app writes encrypted bytes (no plaintext path can be added unnoticed)", () => {
    const root = path.resolve(import.meta.dirname, "../src");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = path.join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(n)) files.push(p);
      }
    };
    walk(root);
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/\b(?:storage|store)\.put\(([^;]+)\);/g)) {
        // Writes that copy already-sealed bytes (restore) or encrypt inline are fine.
        const arg = m[1].trim();
        if (!arg.includes("encryptBytes(") && !arg.endsWith(", stored")) offenders.push(`${path.relative(root, f)}: ${m[0].slice(0, 100)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("older plaintext files still open (encrypted=false)", async () => {
    const o = await office();
    const bytes = pdf("legacy");
    const { file } = await legacyDocument(o.client.id, o.tabitha.id, bytes);
    expect(sha((await readDocumentBytes(file))!)).toBe(sha(bytes));
  });

  it("key rotation: files and secrets written with the previous key still open; new writes use the new key", async () => {
    const plain = pdf("rotate");
    const old = encryptBytes(plain);
    const oldSecret = encryptSecret("JBSWY3DPEHPK3PXP");
    const oldVersion = fileKeyVersionOf(old);
    vi.stubEnv("APP_ENCRYPTION_KEY", KEY_B);
    expect(() => decryptBytes(old)).toThrow(/key that isn't configured/);
    vi.stubEnv("APP_ENCRYPTION_KEY_PREVIOUS", KEY_A);
    expect(sha(decryptBytes(old))).toBe(sha(plain));
    expect(decryptSecret(oldSecret)).toBe("JBSWY3DPEHPK3PXP");
    const fresh = encryptBytes(plain);
    expect(fileKeyVersionOf(fresh)).not.toBe(oldVersion);
    expect(fileKeyVersionOf(fresh)).toBe(currentFileKeyVersion());
  });

  it("re-encrypt job (REKEY) moves files to the current key; afterwards the previous key can go", async () => {
    const o = await office();
    const bytes = pdf("rekey");
    const doc = await staffUploadDocument(o.tabitha, { clientId: o.client.id, category: "OTHER", visibility: "STAFF_ONLY", bytes, originalName: "a.pdf" });
    vi.stubEnv("APP_ENCRYPTION_KEY", KEY_B);
    vi.stubEnv("APP_ENCRYPTION_KEY_PREVIOUS", KEY_A);
    expect((await encryptionCandidates("REKEY")).map((c) => c.documentId)).toEqual([doc.id]);
    await startEncryptionJob({ actor: o.tabitha }, "REKEY");
    const r = await runEncryptionBatch({ actor: o.tabitha });
    expect(r).toMatchObject({ migrated: 1, failed: 0, remaining: 0 });
    vi.stubEnv("APP_ENCRYPTION_KEY_PREVIOUS", "");
    const f = await prisma.storedFile.findFirstOrThrow({ where: { document: { id: doc.id } } });
    expect(f.keyVersion).toBe(currentFileKeyVersion());
    expect(sha((await readDocumentBytes(f))!)).toBe(sha(bytes));
    expect(await prisma.pendingOriginalRemoval.count({ where: { reason: "KEY_ROTATION" } })).toBe(1);
  });
});

describe("encrypting existing files (owner-started job)", () => {
  it("dry run reports counts and bytes by category, Client-Connect-only records first, and changes nothing", async () => {
    const o = await office();
    const a = await legacyDocument(o.client.id, o.tabitha.id, pdf("tax"), { category: "TAXES" });
    const b = await legacyDocument(o.client.id, o.tabitha.id, pdf("bank"), { category: "BOOKKEEPING", docType: "BANK_STATEMENT" });
    const c = await legacyDocument(o.client.id, o.tabitha.id, pdf("payroll"), { category: "PAYROLL" });
    await staffUploadDocument(o.tabitha, { clientId: o.client.id, category: "OTHER", visibility: "STAFF_ONLY", bytes: pdf("new"), originalName: "n.pdf" });
    const dry = await encryptionDryRun({ actor: o.tabitha });
    expect(dry.files).toBe(3);
    expect(dry.bytes).toBe(a.file.sizeBytes + b.file.sizeBytes + c.file.sizeBytes);
    expect(dry.groups.map((g) => g.group)).toEqual(["BANK_STATEMENTS", "PAYROLL", "TAX"]);
    expect(dry.alreadyEncrypted).toBe(1);
    // The owner can choose a different order.
    const custom = await encryptionDryRun({ actor: o.tabitha }, "ENCRYPT", ["TAX"]);
    expect(custom.order[0]).toBe("TAX");
    // Nothing moved.
    expect(await prisma.storedFile.count({ where: { encrypted: false } })).toBe(3);
    expect(await prisma.fileEncryptionJob.count()).toBe(0);
  });

  it("copy → verify → swap: new key, encrypted, original kept untouched and recorded; resumable in batches", async () => {
    const o = await office();
    const docs = [];
    for (let i = 0; i < 5; i++) docs.push(await legacyDocument(o.client.id, o.tabitha.id, pdf(`batch${i}`), { category: i % 2 ? "BOOKKEEPING" : "TAXES" }));
    await startEncryptionJob({ actor: o.tabitha });
    const first = await runEncryptionBatch({ actor: o.tabitha }, { limit: 2 });
    expect(first).toMatchObject({ processed: 2, migrated: 2, remaining: 3 });
    // Bookkeeping (only in Client Connect) went first.
    const movedFirst = await prisma.storedFile.findMany({ where: { encrypted: true }, include: { document: true } });
    expect(movedFirst.every((f) => f.document?.category === "BOOKKEEPING")).toBe(true);
    // A later batch picks up where it stopped.
    const second = await runEncryptionBatch({ actor: o.tabitha }, { limit: 10 });
    expect(second).toMatchObject({ migrated: 3, remaining: 0 });
    expect((await prisma.fileEncryptionJob.findFirstOrThrow()).status).toBe("COMPLETED");
    for (const d of docs) {
      const f = await prisma.storedFile.findUniqueOrThrow({ where: { id: d.file.id } });
      expect(f.storageKey).not.toBe(d.storageKey);
      expect(f.encrypted).toBe(true);
      expect(sha((await readDocumentBytes(f))!)).toBe(d.file.sha256);
      // The original is still there, byte for byte, and recorded for later removal.
      expect(sha((await storage.get(d.storageKey))!)).toBe(d.file.sha256);
      expect(await prisma.pendingOriginalRemoval.count({ where: { originalKey: d.storageKey, replacementKey: f.storageKey, removedAt: null } })).toBe(1);
    }
    // Running again does nothing.
    expect((await runEncryptionBatch({ actor: o.tabitha })).processed).toBe(0);
  });

  it("a hash mismatch leaves the original and the record untouched, and is retried", async () => {
    const o = await office();
    const d = await legacyDocument(o.client.id, o.tabitha.id, pdf("corrupt"));
    // The recorded fingerprint doesn't match the stored bytes (corruption, or a tampered file).
    await prisma.storedFile.update({ where: { id: d.file.id }, data: { sha256: "0".repeat(64) } });
    await startEncryptionJob({ actor: o.tabitha });
    const r = await runEncryptionBatch({ actor: o.tabitha });
    expect(r).toMatchObject({ migrated: 0, failed: 1, remaining: 1 });
    const f = await prisma.storedFile.findUniqueOrThrow({ where: { id: d.file.id } });
    expect(f).toMatchObject({ storageKey: d.storageKey, encrypted: false });
    expect(await storage.get(d.storageKey)).not.toBeNull();
    expect(await prisma.pendingOriginalRemoval.count()).toBe(0);
    const item = await prisma.fileEncryptionItem.findFirstOrThrow();
    expect(item).toMatchObject({ status: "FAILED", attempts: 1 });
    expect(item.lastError).toMatch(/fingerprint/);
    // A read-back that doesn't verify also leaves everything as it was.
    await prisma.storedFile.update({ where: { id: d.file.id }, data: { sha256: d.file.sha256 } });
    const realGet = storage.get.bind(storage);
    const spy = vi.spyOn(storage, "get").mockImplementation(async (k: string) => {
      const b = await realGet(k);
      return k.includes("/enc/") && b ? new Uint8Array(b.map((x, i) => (i === b.length - 1 ? x ^ 1 : x))) : b;
    });
    const r2 = await runEncryptionBatch({ actor: o.tabitha });
    spy.mockRestore();
    expect(r2.failed).toBe(1);
    expect((await prisma.storedFile.findUniqueOrThrow({ where: { id: d.file.id } })).storageKey).toBe(d.storageKey);
    expect((await prisma.fileEncryptionItem.findFirstOrThrow()).attempts).toBe(2);
    // Retried and fixed on the next batch.
    const r3 = await runEncryptionBatch({ actor: o.tabitha });
    expect(r3).toMatchObject({ migrated: 1, remaining: 0 });
  });

  it("originals are never deleted by the job; removal needs 30 days AND a successful backup holding the encrypted copy", async () => {
    const o = await office();
    backupEnv();
    setBackupTargetForTests(new MemoryTarget());
    const d = await legacyDocument(o.client.id, o.tabitha.id, pdf("orig"));
    await startEncryptionJob({ actor: o.tabitha });
    await runEncryptionBatch({ actor: o.tabitha });
    expect(await eligibleOriginals()).toHaveLength(0);
    // 31 days later, but no backup yet: still not eligible.
    const later = new Date(Date.now() + 31 * 86_400_000);
    expect(await eligibleOriginals(later)).toHaveLength(0);
    await runBackupToCompletion();
    expect(await eligibleOriginals(later)).toHaveLength(1);
    expect(await eligibleOriginals()).toHaveLength(0); // backed up, but not 30 days yet
    // Only the owner removes them.
    await expect(removeEligibleOriginals({ actor: o.admin })).rejects.toBeInstanceOf(ForbiddenError);
    vi.useFakeTimers({ now: later, toFake: ["Date"] });
    expect(await removeEligibleOriginals({ actor: o.tabitha })).toEqual({ removed: 1 });
    expect(await storage.get(d.storageKey)).toBeNull();
    const f = await prisma.storedFile.findUniqueOrThrow({ where: { id: d.file.id } });
    expect(sha((await readDocumentBytes(f))!)).toBe(d.file.sha256);
  });
});

describe("30-day recoverable deletion", () => {
  it("delete keeps the bytes, hides the document from staff and client lists, and the owner restores it (audited)", async () => {
    const o = await office();
    const doc = await staffUploadDocument(o.tabitha, { clientId: o.client.id, category: "TAXES", visibility: "PUBLISHED", bytes: pdf("restore"), originalName: "w2.pdf" });
    await prisma.document.update({ where: { id: doc.id }, data: { scanStatus: "CLEAN" } });
    expect((await portalDocuments(o.portal, o.client.id)).map((d) => d.id)).toContain(doc.id);
    await deleteDocument(o.admin, doc.id, "Uploaded to the wrong client");
    const after = await prisma.document.findUniqueOrThrow({ where: { id: doc.id }, include: { file: true } });
    expect(after.deletedAt).not.toBeNull();
    expect(after.purgeAfter!.getTime() - after.deletedAt!.getTime()).toBe(30 * 86_400_000);
    expect(await storage.get(after.file.storageKey)).not.toBeNull();
    expect((await portalDocuments(o.portal, o.client.id)).map((d) => d.id)).not.toContain(doc.id);
    // Only the owner sees Recently deleted and restores.
    await expect(recentlyDeleted(o.admin)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(restoreDeletedDocument(o.admin, doc.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await recentlyDeleted(o.tabitha)).map((d) => d.id)).toEqual([doc.id]);
    await restoreDeletedDocument(o.tabitha, doc.id);
    const back = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
    expect(back).toMatchObject({ deletedAt: null, visibility: "PUBLISHED", purgeAfter: null });
    expect((await portalDocuments(o.portal, o.client.id)).map((d) => d.id)).toContain(doc.id);
    expect(await prisma.auditLog.count({ where: { entityId: doc.id, action: "document.restored" } })).toBe(1);
    expect(await prisma.documentAccessLog.count({ where: { documentId: doc.id, action: "RESTORE" } })).toBe(1);
    expect(await prisma.ownerAuditLog.count({ where: { entityId: doc.id, action: "document.restored" } })).toBe(1);
  });

  it("nightly purge removes bytes only after 30 days AND once a successful backup holds the file", async () => {
    const o = await office();
    backupEnv();
    setBackupTargetForTests(new MemoryTarget());
    const doc = await staffUploadDocument(o.tabitha, { clientId: o.client.id, category: "OTHER", visibility: "STAFF_ONLY", bytes: pdf("purge"), originalName: "p.pdf" });
    const key = (await prisma.storedFile.findFirstOrThrow({ where: { document: { id: doc.id } } })).storageKey;
    await deleteDocument(o.tabitha, doc.id, "Duplicate");
    // Before 30 days: nothing purged.
    expect(await purgeExpiredDeletions(new Date(Date.now() + 29 * 86_400_000))).toEqual({ purged: 0, waitingForBackup: 0 });
    // After 30 days but never backed up: waits.
    const day31 = new Date(Date.now() + 31 * 86_400_000);
    expect(await purgeExpiredDeletions(day31)).toEqual({ purged: 0, waitingForBackup: 1 });
    expect(await storage.get(key)).not.toBeNull();
    await runBackupToCompletion();
    expect(await purgeExpiredDeletions(day31)).toEqual({ purged: 1, waitingForBackup: 0 });
    expect(await storage.get(key)).toBeNull();
    const row = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
    expect(row.purgedAt).not.toBeNull();
    expect(await prisma.auditLog.count({ where: { entityId: doc.id, action: "document.purged" } })).toBe(1);
    expect(await prisma.documentAccessLog.count({ where: { documentId: doc.id, action: "PURGE" } })).toBe(1);
    await expect(restoreDeletedDocument(o.tabitha, doc.id)).rejects.toThrow(/removed permanently/);
  });

  it("delete permanently now: owner only, typed confirmation and a reason, audited", async () => {
    const o = await office();
    const doc = await staffUploadDocument(o.tabitha, { clientId: o.client.id, category: "OTHER", visibility: "STAFF_ONLY", bytes: pdf("now"), originalName: "x.pdf" });
    const key = (await prisma.storedFile.findFirstOrThrow({ where: { document: { id: doc.id } } })).storageKey;
    await expect(deletePermanentlyNow(o.tabitha, doc.id, PERMANENT_DELETE_PHRASE, "Client request")).rejects.toThrow(/Recently deleted/);
    await deleteDocument(o.tabitha, doc.id, "Client asked");
    await expect(deletePermanentlyNow(o.admin, doc.id, PERMANENT_DELETE_PHRASE, "Client request")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(deletePermanentlyNow(o.tabitha, doc.id, "delete", "Client request")).rejects.toThrow(/Type DELETE PERMANENTLY/);
    await expect(deletePermanentlyNow(o.tabitha, doc.id, PERMANENT_DELETE_PHRASE, " ")).rejects.toThrow(/Record why/);
    await deletePermanentlyNow(o.tabitha, doc.id, PERMANENT_DELETE_PHRASE, "Client requested destruction in writing");
    expect(await storage.get(key)).toBeNull();
    expect(await prisma.auditLog.count({ where: { entityId: doc.id, action: "document.purged_now" } })).toBe(1);
    expect(await prisma.ownerAuditLog.count({ where: { entityId: doc.id, action: "document.purged_now" } })).toBe(1);
  });
});

describe("owner-only controls", () => {
  it("only the owner can migrate, restore, permanently delete, toggle backups or confirm key escrow", async () => {
    const o = await office();
    backupEnv();
    for (const who of [o.admin, o.daria]) {
      await expect(encryptionDryRun({ actor: who })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(startEncryptionJob({ actor: who })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(runEncryptionBatch({ actor: who })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(setNightlyBackups(who, true)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(runRestoreVerification(who)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(confirmKeyEscrow(who, { checked: true })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(deletePermanentlyNow(who, "x", PERMANENT_DELETE_PHRASE, "reason")).rejects.toBeInstanceOf(ForbiddenError);
    }
    await setNightlyBackups(o.tabitha, true);
    expect((await prisma.integrationSettings.findUniqueOrThrow({ where: { id: "default" } })).nightlyBackupsEnabled).toBe(true);
    await confirmKeyEscrow(o.tabitha, { checked: true, note: "Office safe + bank box" });
    expect((await prisma.integrationSettings.findUniqueOrThrow({ where: { id: "default" } })).keyEscrowConfirmedAt).not.toBeNull();
  });
});
