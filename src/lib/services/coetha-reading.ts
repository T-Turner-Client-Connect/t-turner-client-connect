import "server-only";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { storage } from "@/lib/storage";
import { decryptBytes, encryptBytes } from "@/lib/crypto";
import { callDocumentReader, callFindingsReviewer, CoethaModelError } from "@/lib/coetha-model";
import { ValidationError } from "./clients";
import { assertLedger, assertManagedBusiness, ymdOf } from "./ledger";
import { scrub } from "./coetha";

/**
 * Coetha reads documents in the background, so a whole year of scanned checks is no problem.
 *
 * 1. Upload: a file of any size up to MAX_FILE is sent in pieces of chunkSize() bytes (4 MB) (each request
 *    stays well under the hosting's request limit). Pieces are stored encrypted; when all have
 *    arrived the file is put back together, checked (PDF or picture, by its own bytes), virus-
 *    scanned, encrypted and saved as a staff-only bookkeeping document — the same path as every
 *    other document. A file already on file for the business is reused, never stored twice.
 * 2. One reading job per document (unique), so a document is read once. A worker takes a job with
 *    a short lease, reads the next few pages (PAGES_PER_STEP) and saves what it found and its place
 *    in one transaction. If the worker is interrupted, the lease runs out and the next worker
 *    continues from the saved place; findings for a page are replaced, never added twice.
 *    A failed step is retried later (after RETRY_DELAYS); after MAX_ATTEMPTS failures the job
 *    stops as FAILED and staff can press "Try again".
 * 3. Workers: every unit of work (workOnce) is one short step that fits in one web request (the
 *    hosting stops a request after about 30 seconds): two pages, or one answer. The background
 *    function calls it in a loop for up to 13 minutes; the 10-minute scheduled task and the open
 *    page also call it, so reading continues whichever is available. A step that is cut off
 *    counts as an attempt (attempts are counted when a step starts); after two, a step reads one
 *    page; after MAX_ATTEMPTS the job stops as FAILED with "Try again".
 * 4. Each finding (check number, date, payee, amount, memo, details) is de-identified and
 *    matched to this business's bank rows. Nothing is posted, approved or changed.
 * 5. Review: once a document is read, Coetha reviews its checks REVIEW_BATCH at a time (each
 *    batch is one short step) and saves, per check, a group (routine / needs documentation /
 *    owner or personal), a proposed account, why, and the evidence that would settle it. Each
 *    check is reviewed once. The page shows every check in one of five groups (adding "already
 *    posted" and "unmatched", decided from the bank row at the time). Her written answer is a
 *    short summary that points to these saved groups, so a long document never has to be read
 *    again; "Summarize again" writes a new summary from what is saved.
 */

/** Piece size (tests use a smaller one so a multi-piece file stays small). */
export const chunkSize = () => (process.env.VITEST && Number(process.env.COETHA_TEST_CHUNK)) || 4 * 1024 * 1024;
export const MAX_FILE = 60 * 1024 * 1024;
export const PAGES_PER_STEP = 2;
/** Each reading call must finish well inside one web request. */
const READ_TIMEOUT_MS = 22_000;
/** The most raw bytes sent to Coetha in one step (the request grows by a third on the way). */
const MAX_STEP_BYTES = 3 * 1024 * 1024;
export const MAX_ATTEMPTS = 4;
const RETRY_DELAYS = [60_000, 5 * 60_000, 15 * 60_000];
const LEASE_MS = 3 * 60_000;
const PDF_TEXT_MIN = 200;
const MAX_TEXT = 400_000;

const TYPES = ["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp"] as const;
type FileType = (typeof TYPES)[number];

function typeOf(b: Uint8Array): FileType | null {
  const is = (sig: number[]) => sig.every((x, i) => b[i] === x);
  if (is([0x25, 0x50, 0x44, 0x46])) return "application/pdf";
  if (is([0x89, 0x50, 0x4e, 0x47])) return "image/png";
  if (is([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (is([0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (is([0x52, 0x49, 0x46, 0x46]) && String.fromCharCode(...Array.from(b.slice(8, 12))) === "WEBP") return "image/webp";
  return null;
}

async function assertCoethaReader(actor: Actor, clientId: string) {
  await assertLedger(actor, clientId);
  await assertManagedBusiness(clientId);
  if (!(await prisma.ledgerBook.findUnique({ where: { clientId }, select: { clientId: true } }))) throw new ValidationError("Set up this business's books first.");
}

// --- 1. Uploading in pieces -------------------------------------------------------------------

export async function startUpload(actor: Actor, clientId: string, input: { name: string; size: number }) {
  await assertCoethaReader(actor, clientId);
  const size = Math.floor(Number(input.size));
  if (!size || size < 1) throw new ValidationError("The file is empty.");
  if (size > MAX_FILE) throw new ValidationError(`Files can be up to ${MAX_FILE / 1024 / 1024} MB each. Split a larger scan into two files.`);
  const name = String(input.name || "document").replace(/[^\w.\- ()]/g, "_").slice(0, 150);
  const u = await prisma.coethaUpload.create({ data: { clientId, createdById: actor.id, name, size, chunks: Math.ceil(size / chunkSize()) } });
  return { uploadId: u.id, chunks: u.chunks, chunkSize: chunkSize() };
}

async function ownUpload(actor: Actor, uploadId: string) {
  const u = await prisma.coethaUpload.findUnique({ where: { id: uploadId } });
  if (!u || u.createdById !== actor.id) throw new ValidationError("That upload wasn't found. Choose the file again.");
  await assertCoethaReader(actor, u.clientId);
  return u;
}
// Pieces live in the client documents store (encrypted), like the finished file.
const partKey = (uploadId: string, i: number) => `client_document/coetha_upload/${uploadId}/${i}`;

/** Stores one piece (encrypted). Sending the same piece again replaces it. */
export async function putChunk(actor: Actor, uploadId: string, index: number, bytes: Uint8Array) {
  const u = await ownUpload(actor, uploadId);
  if (u.documentId) return { received: u.chunks, chunks: u.chunks };
  if (!Number.isInteger(index) || index < 0 || index >= u.chunks) throw new ValidationError("That piece doesn't belong to this file.");
  const expected = index === u.chunks - 1 ? u.size - chunkSize() * (u.chunks - 1) : chunkSize();
  if (bytes.length !== expected) throw new ValidationError("A piece of the file arrived incomplete. Try again.");
  await storage.put(partKey(u.id, index), encryptBytes(bytes));
  const parts = new Set((u.parts as number[]) ?? []);
  parts.add(index);
  await prisma.coethaUpload.update({ where: { id: u.id }, data: { parts: [...parts].sort((a, b) => a - b) } });
  return { received: parts.size, chunks: u.chunks };
}

/**
 * Puts the file back together, saves it as a staff-only bookkeeping document (or reuses the copy
 * already on file) and queues its reading job. Returns the document and job.
 */
export async function finishUpload(actor: Actor, uploadId: string) {
  const u = await ownUpload(actor, uploadId);
  if (u.documentId) {
    const job = await prisma.coethaDocJob.findUniqueOrThrow({ where: { documentId: u.documentId } });
    return { documentId: u.documentId, jobId: job.id, reused: false, name: u.name };
  }
  const parts = new Set((u.parts as number[]) ?? []);
  for (let i = 0; i < u.chunks; i++) if (!parts.has(i)) throw new ValidationError("Part of the file is missing. Try again.");
  const bytes = new Uint8Array(u.size);
  for (let i = 0; i < u.chunks; i++) {
    const stored = await storage.get(partKey(u.id, i));
    if (!stored) throw new ValidationError("Part of the file is missing. Try again.");
    bytes.set(decryptBytes(stored), i * chunkSize());
  }
  if (!typeOf(bytes)) throw new ValidationError(`“${u.name}” isn't a PDF or a picture (PNG, JPEG, GIF or WebP).`);
  const { sha256Of, staffUploadDocument } = await import("./documents");
  // A file already on file for this business is reused: no second copy, and no second reading.
  const existing = await prisma.document.findFirst({ where: { clientId: u.clientId, deletedAt: null, file: { sha256: sha256Of(bytes) } }, select: { id: true, title: true } });
  let documentId: string;
  let reused = false;
  if (existing) {
    documentId = existing.id;
    reused = true;
  } else {
    const doc = await staffUploadDocument(actor, { clientId: u.clientId, category: "BOOKKEEPING", title: `Sent to Coetha — ${u.name}`.slice(0, 200), visibility: "STAFF_ONLY", bytes, originalName: u.name, notify: false, duplicateChecked: true, maxBytes: MAX_FILE });
    documentId = doc.id;
  }
  const job = await queueJob(actor, u.clientId, documentId, u.name);
  await prisma.coethaUpload.update({ where: { id: u.id }, data: { documentId } });
  for (let i = 0; i < u.chunks; i++) await storage.remove(partKey(u.id, i)).catch(() => {});
  await audit(prisma, { actorId: actor.id, action: "coetha.document_uploaded", entityType: "Document", entityId: documentId, clientId: u.clientId, details: { reused, size: u.size, jobId: job.id } });
  return { documentId, jobId: job.id, reused, name: u.name };
}

/** One job per document: reading a document that is already read (or being read) reuses that job. */
async function queueJob(actor: Actor, clientId: string, documentId: string, name: string) {
  const found = await prisma.coethaDocJob.findUnique({ where: { documentId } });
  if (found) return found;
  try {
    return await prisma.coethaDocJob.create({ data: { clientId, documentId, name: name.slice(0, 200), createdById: actor.id } });
  } catch {
    return prisma.coethaDocJob.findUniqueOrThrow({ where: { documentId } });
  }
}

/** Queues documents already on file (for example a scan sent earlier) for Coetha to read. */
export async function readDocumentsOnFile(actor: Actor, clientId: string, documentIds: string[]) {
  await assertCoethaReader(actor, clientId);
  const docs = await prisma.document.findMany({ where: { id: { in: documentIds }, clientId, deletedAt: null, category: "BOOKKEEPING" }, select: { id: true, title: true, file: { select: { mimeType: true, originalName: true } } } });
  if (docs.length !== new Set(documentIds).size) throw new ValidationError("One of those documents isn't on file for this business.");
  const jobs = [];
  for (const d of docs) {
    if (!d.file || !TYPES.includes(d.file.mimeType as FileType)) throw new ValidationError(`“${d.title}” isn't a PDF or a picture.`);
    jobs.push(await queueJob(actor, clientId, d.id, d.file.originalName || d.title));
  }
  return jobs;
}

/** "Try again" on a failed job: it starts over from its saved place. */
export async function retryJob(actor: Actor, jobId: string) {
  const job = await prisma.coethaDocJob.findUnique({ where: { id: jobId } });
  if (!job) throw new ValidationError("That reading wasn't found.");
  await assertCoethaReader(actor, job.clientId);
  if (job.status !== "FAILED") return job;
  const j = await prisma.coethaDocJob.update({ where: { id: job.id }, data: { status: job.pagesDone > 0 ? "READING" : "QUEUED", attempts: 0, error: null, notBefore: null, leaseUntil: null } });
  // A question that gave up on this file waits for it again.
  const msgs = await prisma.coethaChatMessage.findMany({ where: { clientId: job.clientId, status: "FAILED" }, select: { id: true, jobIds: true } });
  for (const m of msgs) if (Array.isArray(m.jobIds) && (m.jobIds as string[]).includes(job.id)) await prisma.coethaChatMessage.update({ where: { id: m.id }, data: { status: "WAITING" } });
  await audit(prisma, { actorId: actor.id, action: "coetha.document_retry", entityType: "CoethaDocJob", entityId: job.id, clientId: job.clientId });
  return j;
}

// --- 2. Reading, one short step at a time --------------------------------------------------------

/** Takes the next job that is due, holding it with a lease so no other worker reads it at the same time. */
async function claimJob(now: Date, clientId?: string) {
  // A job whose last steps were all cut off (lease ran out MAX_ATTEMPTS times) stops here.
  const stuck = await prisma.coethaDocJob.findMany({ where: { status: { in: ["QUEUED", "READING"] }, attempts: { gte: MAX_ATTEMPTS }, leaseUntil: { lt: now } }, select: { id: true } });
  for (const j of stuck) await prisma.coethaDocJob.updateMany({ where: { id: j.id, leaseUntil: { lt: now } }, data: { status: "FAILED", finishedAt: now, leaseUntil: null, error: "Reading this part kept being interrupted. Try again, or scan it at a lower resolution." } });
  const due = await prisma.coethaDocJob.findMany({
    where: { ...(clientId ? { clientId } : {}), status: { in: ["QUEUED", "READING"] }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }], AND: [{ OR: [{ notBefore: null }, { notBefore: { lte: now } }] }] },
    orderBy: { createdAt: "asc" },
    take: 5,
    select: { id: true, leaseUntil: true },
  });
  for (const d of due) {
    const got = await prisma.coethaDocJob.updateMany({
      where: { id: d.id, status: { in: ["QUEUED", "READING"] }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
      data: { leaseUntil: new Date(now.getTime() + LEASE_MS), status: "READING", attempts: { increment: 1 } },
    });
    if (got.count) return prisma.coethaDocJob.findUniqueOrThrow({ where: { id: d.id } });
  }
  return null;
}

/** The document's bytes, only once its virus scan has passed (or no scanner is set up). */
async function documentBytes(documentId: string) {
  const doc = await prisma.document.findUnique({ where: { id: documentId }, select: { scanStatus: true, deletedAt: true, file: { select: { storageKey: true, encrypted: true, mimeType: true } } } });
  if (!doc || doc.deletedAt || !doc.file) throw new ValidationError("The document is no longer on file.");
  if (doc.scanStatus === "INFECTED") throw new ValidationError("The virus scanner flagged this file; Coetha won't read it.");
  if (doc.scanStatus === "PENDING") return null;
  const { readDocumentBytes } = await import("./documents");
  const bytes = await readDocumentBytes(doc.file);
  if (!bytes) throw new ValidationError("The file couldn't be read from storage.");
  return { bytes, type: (typeOf(bytes) ?? doc.file.mimeType) as FileType };
}

type Item = { page: number; kind: string; checkNumber: string | null; date: string | null; payee: string | null; amount: number | null; memo: string | null; details: string | null };

/** De-identifies what Coetha wrote (long numbers to the last 4; SSN/EIN, emails, phones removed). */
const clean = (s: string | null | undefined, max: number) => (s ? scrub(s, max) || null : null);

/** Saves a batch of pages' findings in place of any saved earlier for those pages (a resumed step never adds twice). */
async function saveBatch(job: { id: string; clientId: string }, firstPage: number, lastPage: number, items: Item[], tokens: { inputTokens: number; outputTokens: number }, pagesDone: number, done: boolean) {
  await prisma.$transaction([
    prisma.coethaDocFinding.deleteMany({ where: { jobId: job.id, page: { gte: firstPage, lte: lastPage } } }),
    prisma.coethaDocFinding.createMany({
      data: items.map((it, k) => ({
        jobId: job.id, clientId: job.clientId,
        page: Math.min(lastPage, Math.max(firstPage, firstPage + Math.max(1, Math.floor(it.page)) - 1)), seq: k,
        kind: ["CHECK", "DEPOSIT", "RECEIPT", "INVOICE", "STATEMENT", "OTHER"].includes(it.kind) ? it.kind : "OTHER",
        checkNumber: it.checkNumber ? String(it.checkNumber).replace(/\D/g, "").slice(0, 10) || null : null,
        date: it.date && /^\d{4}-\d{2}-\d{2}$/.test(it.date) ? it.date : null,
        payee: clean(it.payee, 120), memo: clean(it.memo, 160), details: clean(it.details, 300),
        amountCents: it.amount == null || !Number.isFinite(it.amount) ? null : Math.round(it.amount * 100),
      })),
    }),
    prisma.coethaDocJob.update({
      where: { id: job.id },
      data: { pagesDone, attempts: 0, error: null, notBefore: null, leaseUntil: null, inputTokens: { increment: tokens.inputTokens }, outputTokens: { increment: tokens.outputTokens }, ...(done ? { status: "DONE", finishedAt: new Date() } : {}) },
    }),
  ]);
}

/** A few pages of a scanned PDF as their own small PDF (and how many pages that is). */
async function pagesAsPdf(bytes: Uint8Array, from: number, count: number) {
  const { PDFDocument } = await import("pdf-lib");
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
  for (let n = count; n >= 1; n--) {
    const out = await PDFDocument.create();
    const idx = Array.from({ length: Math.min(n, src.getPageCount() - from) }, (_, i) => from + i);
    for (const p of await out.copyPages(src, idx)) out.addPage(p);
    const b = await out.save();
    if (b.length <= MAX_STEP_BYTES || n === 1) return { bytes: b, pages: idx.length };
  }
  throw new Error("unreachable");
}

/** One step on one job: works out what the document is, or reads its next few pages. */
async function stepJob(job: NonNullable<Awaited<ReturnType<typeof claimJob>>>, pagesPerStep: number) {
  const file = await documentBytes(job.documentId);
  if (!file) {
    // Still being virus-scanned: try again in a minute.
    await prisma.coethaDocJob.update({ where: { id: job.id }, data: { leaseUntil: null, attempts: { decrement: 1 }, notBefore: new Date(Date.now() + 60_000) } });
    return;
  }
  if (!job.kind) {
    if (file.type === "application/pdf") {
      const { pdfLines } = await import("@/lib/statement-pdf");
      const lines = (await pdfLines(file.bytes)) ?? [];
      const text = lines.map((l) => scrub(l, 400)).filter(Boolean).join("\n");
      const { PDFDocument } = await import("pdf-lib");
      const pages = (await PDFDocument.load(file.bytes, { ignoreEncryption: true })).getPageCount();
      if (text.replace(/\s/g, "").length >= PDF_TEXT_MIN) {
        // A PDF with text (a bank statement, an invoice): its de-identified text is what Coetha uses.
        await prisma.coethaDocJob.update({ where: { id: job.id }, data: { kind: "PDF_TEXT", pages, pagesDone: pages, text: text.slice(0, MAX_TEXT), status: "DONE", finishedAt: new Date(), leaseUntil: null, attempts: 0, error: null } });
        return;
      }
      await prisma.coethaDocJob.update({ where: { id: job.id }, data: { kind: "PDF_SCAN", pages, leaseUntil: null, attempts: 0 } });
      return;
    }
    await prisma.coethaDocJob.update({ where: { id: job.id }, data: { kind: "IMAGE", pages: 1, leaseUntil: null, attempts: 0 } });
    return;
  }
  if (job.kind === "IMAGE") {
    if (file.bytes.length > MAX_STEP_BYTES) throw new ValidationError("This picture is over 3 MB. Send a smaller picture (or a PDF scan).");
    const r = await callDocumentReader({ mediaType: file.type, base64: Buffer.from(file.bytes).toString("base64") }, { timeoutMs: READ_TIMEOUT_MS });
    await saveBatch(job, 1, 1, r.output.items, r, 1, true);
    await matchFindings(job.id);
    return;
  }
  // PDF_SCAN: the next few pages.
  const from = job.pagesDone;
  // After an interrupted or failed step, one page at a time.
  const part = await pagesAsPdf(file.bytes, from, Math.min(job.attempts > 1 ? 1 : pagesPerStep, job.pages - from));
  if (part.bytes.length > MAX_STEP_BYTES) throw new ValidationError(`Page ${from + 1} is too large to read (over 3 MB). Scan it at a lower resolution.`);
  const r = await callDocumentReader({ mediaType: "application/pdf", base64: Buffer.from(part.bytes).toString("base64") }, { timeoutMs: READ_TIMEOUT_MS });
  const done = from + part.pages >= job.pages;
  await saveBatch(job, from + 1, from + part.pages, r.output.items, r, from + part.pages, done);
  await matchFindings(job.id);
}

/** A failed step: tried again later; after MAX_ATTEMPTS (counted as steps start) the job stops and shows "Try again". */
async function failStep(jobId: string, err: unknown) {
  const msg = err instanceof ValidationError || err instanceof CoethaModelError ? err.message : "Coetha couldn't read part of this file.";
  const permanent = err instanceof ValidationError;
  const job = await prisma.coethaDocJob.update({ where: { id: jobId }, data: { error: msg.slice(0, 300), leaseUntil: null } });
  if (permanent || job.attempts >= MAX_ATTEMPTS) {
    await prisma.coethaDocJob.update({ where: { id: jobId }, data: { status: "FAILED", finishedAt: new Date() } });
  } else {
    await prisma.coethaDocJob.update({ where: { id: jobId }, data: { notBefore: new Date(Date.now() + RETRY_DELAYS[Math.min(job.attempts - 1, RETRY_DELAYS.length - 1)]) } });
  }
}

// --- 3. Matching to the bank rows (read-only) ----------------------------------------------------

/** Each check (by number and amount, else amount and nearby date) and deposit (amount and date) to this business's bank rows. */
export async function matchFindings(jobId: string) {
  const items = await prisma.coethaDocFinding.findMany({ where: { jobId, kind: { in: ["CHECK", "DEPOSIT"] }, amountCents: { not: null } } });
  for (const f of items) {
    const sign = f.kind === "CHECK" ? -1 : 1;
    const rows = await prisma.bankTransaction.findMany({ where: { clientId: f.clientId, amountCents: sign * f.amountCents! }, select: { id: true, date: true, description: true, status: true } });
    let hit: (typeof rows)[number] | undefined;
    let note: string | null = null;
    if (f.checkNumber) {
      hit = rows.find((r) => new RegExp(`\\bCHECK\\s*#?\\s*0*${f.checkNumber}\\b`, "i").test(r.description));
      if (hit) note = "check number and amount";
    }
    if (!hit && f.date) {
      const d = Date.parse(`${f.date}T00:00:00Z`);
      const near = rows.filter((r) => Math.abs(r.date.getTime() - d) <= 45 * 86_400_000);
      if (near.length === 1) { hit = near[0]; note = "amount and date (within 45 days)"; }
      else if (near.length > 1) note = `${near.length} bank rows have this amount; not matched`;
    }
    if (!hit && !note) note = "no bank row with this amount";
    await prisma.coethaDocFinding.update({ where: { id: f.id }, data: { bankTransactionId: hit?.id ?? null, matchNote: hit ? `${note}: ${ymdOf(hit.date)} ${scrub(hit.description, 60)} (${hit.status === "UNREVIEWED" ? "waiting" : hit.status.toLowerCase()})` : note } });
  }
}

// --- 3b. Review: groups and proposed accounts (proposals only) ------------------------------------

const REVIEW_BATCH = 15;
const REVIEW_TIMEOUT_MS = 22_000;
const MAX_REVIEW_FAILURES = 3;
export const GROUPS = ["ROUTINE", "NEEDS_DOCS", "OWNER_PERSONAL", "UNMATCHED", "POSTED"] as const;
export type GroupKey = (typeof GROUPS)[number] | "PENDING" | "OTHER";
export const GROUP_LABEL: Record<GroupKey, string> = {
  ROUTINE: "Routine checks with strong supporting evidence",
  NEEDS_DOCS: "Checks requiring additional documentation",
  OWNER_PERSONAL: "Owner and personal transactions",
  UNMATCHED: "Unmatched checks",
  POSTED: "Transactions already posted",
  PENDING: "Checks Coetha is still reviewing",
  OTHER: "Other items (deposits, receipts, invoices, statements)",
};

/** Which of the five groups a finding is in, from its saved review and its bank row's status now. */
export function groupOf(f: { kind: string; bankTransactionId: string | null; reviewGroup: string | null }, bankStatus: string | undefined): GroupKey {
  if (f.kind !== "CHECK") return "OTHER";
  if (f.bankTransactionId && bankStatus === "POSTED") return "POSTED";
  if (!f.bankTransactionId) return "UNMATCHED";
  if (f.reviewGroup === "ROUTINE" || f.reviewGroup === "NEEDS_DOCS" || f.reviewGroup === "OWNER_PERSONAL") return f.reviewGroup;
  return "PENDING";
}

/**
 * One review step: the next REVIEW_BATCH checks of a read document that haven't been reviewed.
 * Saves only Coetha's proposals on the findings themselves; the books are not touched.
 */
export async function reviewOnce(clientId?: string) {
  const next = await prisma.coethaDocFinding.findFirst({ where: { ...(clientId ? { clientId } : {}), kind: "CHECK", reviewedAt: null, job: { status: "DONE" } }, orderBy: { createdAt: "asc" }, select: { jobId: true, clientId: true } });
  if (!next) return false;
  const { takeLock, releaseLock } = await import("./coetha-chat");
  const hold = `coetha-review:${next.jobId}`;
  if (!(await takeLock(hold, 60))) return false;
  try {
    const batch = await prisma.coethaDocFinding.findMany({ where: { jobId: next.jobId, kind: "CHECK", reviewedAt: null }, orderBy: [{ page: "asc" }, { seq: "asc" }], take: REVIEW_BATCH });
    if (!batch.length) return false;
    const failures = await prisma.auditLog.count({ where: { action: "coetha.review_failed", entityId: next.jobId } });
    if (failures >= MAX_REVIEW_FAILURES) {
      // Never stuck: after repeated failures the rest are listed for Tabitha's decision without a proposal.
      await prisma.coethaDocFinding.updateMany({ where: { id: { in: batch.map((f) => f.id) } }, data: { reviewedAt: new Date(), reviewGroup: "NEEDS_DOCS", reason: "Coetha couldn't review this check; decide it from the check details and the bank row.", evidenceNeeded: "Invoice, receipt or an explanation of the payment" } });
      return true;
    }
    const accounts = await prisma.ledgerAccount.findMany({ where: { clientId: next.clientId, active: true }, orderBy: { code: "asc" }, select: { code: true, name: true, type: true }, take: 300 });
    const owners = await prisma.businessOwner.findMany({ where: { clientId: next.clientId }, select: { contact: { select: { name: true } } } });
    const rows = await prisma.bankTransaction.findMany({ where: { id: { in: batch.map((f) => f.bankTransactionId).filter((x): x is string => !!x) } }, select: { id: true, status: true } });
    const statusOf = new Map(rows.map((r) => [r.id, r.status]));
    const refs = new Map(batch.map((f, i) => [`F${i + 1}`, f]));
    const input = {
      owners: owners.map((o) => scrub(o.contact.name, 80)).filter(Boolean),
      chartOfAccounts: accounts.map((a) => `${a.code} ${a.name} (${a.type.toLowerCase()})`),
      items: [...refs].map(([ref, f]) => ({
        ref, checkNumber: f.checkNumber, date: f.date, payee: f.payee, amount: f.amountCents == null ? null : f.amountCents / 100,
        memo: f.memo, details: f.details,
        bankMatch: f.bankTransactionId ? `${f.matchNote ?? "matched"} (bank row ${(statusOf.get(f.bankTransactionId) ?? "").toLowerCase() || "unknown"})` : (f.matchNote ?? "not matched"),
      })),
    };
    let r;
    try {
      r = await callFindingsReviewer(input, { timeoutMs: REVIEW_TIMEOUT_MS });
    } catch (err) {
      await audit(prisma, { actorId: null, action: "coetha.review_failed", entityType: "CoethaDocJob", entityId: next.jobId, clientId: next.clientId, details: { code: err instanceof CoethaModelError ? err.code : "ERROR" } });
      return true;
    }
    const codes = new Map(accounts.map((a) => [a.code, `${a.code} ${a.name}`]));
    const now = new Date();
    const got = new Map(r.output.items.map((x) => [x.ref.trim(), x]));
    await prisma.$transaction([...refs].map(([ref, f]) => {
      const x = got.get(ref);
      const data = x
        ? { reviewGroup: x.group, proposedAccount: x.proposedAccount ? codes.get(x.proposedAccount.trim().split(/\s+/)[0]) ?? null : null, reason: clean(x.reason, 400), evidenceNeeded: clean(x.evidenceNeeded, 300), confidence: Math.max(0, Math.min(1, Number(x.confidence) || 0)), reviewedAt: now }
        : { reviewGroup: "NEEDS_DOCS", proposedAccount: null, reason: "Coetha didn't return a review for this check; decide it from the check details.", evidenceNeeded: "Invoice, receipt or an explanation of the payment", confidence: null, reviewedAt: now };
      return prisma.coethaDocFinding.update({ where: { id: f.id }, data });
    }));
    await prisma.coethaDocJob.update({ where: { id: next.jobId }, data: { inputTokens: { increment: r.inputTokens }, outputTokens: { increment: r.outputTokens } } });
    return true;
  } finally {
    await releaseLock(hold);
  }
}

/** Checks in these jobs that Coetha hasn't reviewed yet (her answer waits for them). */
async function unreviewed(jobIds: string[]) {
  return prisma.coethaDocFinding.count({ where: { jobId: { in: jobIds }, kind: "CHECK", reviewedAt: null, job: { status: "DONE" } } });
}

// --- 4. The workers --------------------------------------------------------------------------------

/**
 * One unit of work that fits in one web request: the next step of a due reading job, else one
 * answer to a question whose files are all read. Safe to call from several places at once (each
 * job step is held by its lease; each answer is claimed once). clientId limits it to one business
 * (the open page).
 */
export async function workOnce(opts: { clientId?: string; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const job = await claimJob(now, opts.clientId);
  let did: "read" | "review" | "answer" | null = null;
  if (job) {
    try { await stepJob(job, PAGES_PER_STEP); } catch (err) { await failStep(job.id, err); }
    did = "read";
  } else if (await reviewOnce(opts.clientId)) {
    did = "review";
  } else if (await answerReadyQuestions(1, true, opts.clientId)) {
    did = "answer";
  }
  const where = opts.clientId ? { clientId: opts.clientId } : {};
  const left = await prisma.coethaDocJob.count({ where: { ...where, status: { in: ["QUEUED", "READING"] } } });
  const toReview = await prisma.coethaDocFinding.count({ where: { ...where, kind: "CHECK", reviewedAt: null, job: { status: "DONE" } } });
  const waiting = await prisma.coethaChatMessage.count({ where: { ...where, status: "WAITING" } });
  return { did, more: left > 0 || toReview > 0 || waiting > 0 };
}

/** Units of work until the budget is used (tests and local runs; the hosting calls workOnce per request). */
export async function workReading(budgetMs = 20_000, opts: { clientId?: string; now?: () => Date } = {}) {
  const started = Date.now();
  let units = 0;
  let r = { did: null as "read" | "review" | "answer" | null, more: true };
  while (Date.now() - started < budgetMs) {
    r = await workOnce({ clientId: opts.clientId, now: opts.now?.() });
    if (!r.did) break;
    units++;
  }
  return { units, more: r.more };
}

/** Starts the background function (up to 15 minutes of reading). Without it, the scheduled task and the open page keep reading going. */
export async function kickBackgroundReading() {
  // This deploy's own address (a deploy preview reads with its own code and database); the site's
  // main address only when the deploy address isn't available.
  const url = process.env.DEPLOY_URL || process.env.URL, secret = process.env.CRON_SECRET;
  if (!url || !secret || process.env.VITEST) return false;
  try {
    await fetch(`${url}/.netlify/functions/coetha-reading-background`, { method: "POST", headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(5000) });
    return true;
  } catch {
    return false;
  }
}

// --- 5. Questions that wait for their documents --------------------------------------------------

/** Asks Coetha a question about documents she reads in the background; the answer arrives when they're read. */
export async function askAboutDocuments(actor: Actor, clientId: string, question: string, jobIds: string[]) {
  await assertCoethaReader(actor, clientId);
  const ids = [...new Set(jobIds)];
  if (!ids.length) throw new ValidationError("Add the files first.");
  const jobs = await prisma.coethaDocJob.findMany({ where: { id: { in: ids }, clientId } });
  if (jobs.length !== ids.length) throw new ValidationError("One of the files isn't on file for this business.");
  const { cleanQuestion, assertCanAsk } = await import("./coetha-chat");
  await assertCanAsk(clientId);
  const q = cleanQuestion(question.trim() || `Please read the attached file${ids.length > 1 ? "s" : ""}: list what ${ids.length > 1 ? "they show" : "it shows"}, match each item to the bank rows, and tell me what needs my decision.`);
  const names = jobs.map((j) => j.name);
  const msg = await prisma.coethaChatMessage.create({ data: { clientId, role: "USER", text: q, authorId: actor.id, status: "WAITING", jobIds: ids, attachments: jobs.map((j) => ({ documentId: j.documentId, name: j.name })), documentId: jobs[0].documentId, attachmentName: names[0] } });
  await audit(prisma, { actorId: actor.id, action: "coetha.chat_documents", entityType: "CoethaChatMessage", entityId: msg.id, clientId, details: { jobIds: ids } });
  return msg;
}

/** Answers each waiting question whose documents are all read (or given up on). */
export async function answerReadyQuestions(limit = 1, quick = true, clientId?: string) {
  const waiting = await prisma.coethaChatMessage.findMany({ where: { status: "WAITING", ...(clientId ? { clientId } : {}) }, orderBy: { createdAt: "asc" }, take: 20 });
  let n = 0;
  for (const m of waiting) {
    if (n >= limit) break;
    const ids = (m.jobIds as string[]) ?? [];
    const jobs = await prisma.coethaDocJob.findMany({ where: { id: { in: ids } } });
    if (jobs.some((j) => j.status === "QUEUED" || j.status === "READING")) continue;
    if (await unreviewed(ids)) continue;
    // Only one worker answers it at a time. If that worker is cut off, the hold runs out and the
    // question is answered on a later try; after three tries it stops as FAILED (it can be asked again).
    const { takeLock, releaseLock } = await import("./coetha-chat");
    const hold = `coetha-answer:${m.id}`;
    if (!(await takeLock(hold, 90))) continue;
    try {
      const tries = await prisma.auditLog.count({ where: { action: "coetha.answer_attempt", entityId: m.id } });
      if (tries >= 3) {
        await prisma.coethaChatMessage.update({ where: { id: m.id }, data: { status: "FAILED" } });
        continue;
      }
      await audit(prisma, { actorId: m.authorId, action: "coetha.answer_attempt", entityType: "CoethaChatMessage", entityId: m.id, clientId: m.clientId });
      const asker = m.authorId ? await prisma.user.findUnique({ where: { id: m.authorId }, select: { id: true, role: true, name: true, email: true } }) : null;
      if (!asker) throw new ValidationError("The person who asked no longer has an account.");
      const { answerQuestion } = await import("./coetha-chat");
      await answerQuestion(asker, m.clientId, m.id, await documentsText(jobs), { quick });
      await prisma.coethaChatMessage.update({ where: { id: m.id }, data: { status: "ANSWERED" } });
      n++;
    } catch (err) {
      // The question stays visible with its findings; it can be asked again.
      await prisma.coethaChatMessage.update({ where: { id: m.id }, data: { status: "FAILED" } });
      await audit(prisma, { actorId: m.authorId, action: "coetha.chat_failed", entityType: "CoethaChatMessage", entityId: m.id, clientId: m.clientId, details: { code: err instanceof CoethaModelError ? err.code : "ERROR" } });
    } finally {
      await releaseLock(hold);
    }
  }
  return n;
}

const money = (c: number | null) => (c == null ? "" : ` $${(c / 100).toFixed(2)}`);

/**
 * What Coetha read, for her written answer: the counts in each of the five groups and the checks
 * that need a decision. Every check is saved in its group on the page (and in the spreadsheet), so
 * the answer stays short and is never the only record of what she read.
 */
export async function documentsText(jobs: { id: string; name: string; status: string; kind: string | null; pages: number; error: string | null; text: string | null }[]) {
  const out: string[] = [
    "HOW TO ANSWER: Every check is already saved and shown on the page in five groups (with check details, bank match, proposed account, why, and evidence needed), and staff can download it as a spreadsheet. Do NOT list every check. Write a short summary (under 300 words): the totals per group, then the few decisions Tabitha must make (owner/personal items, checks needing documentation, unmatched checks), naming the check number and amount for each. Propose; never say anything was posted or approved.",
  ];
  let room = 120_000;
  for (const j of jobs) {
    out.push(`\nDocument “${j.name}” (${j.pages} page${j.pages === 1 ? "" : "s"}): ${j.status === "DONE" ? "read" : `not read — ${j.error ?? "failed"}`}.`);
    if (j.kind === "PDF_TEXT" && j.text) {
      const t = j.text.slice(0, Math.max(0, room));
      room -= t.length;
      out.push(`Its text (long numbers shortened to the last 4 digits):\n${t}`);
      continue;
    }
    const f = await prisma.coethaDocFinding.findMany({ where: { jobId: j.id }, orderBy: [{ page: "asc" }, { seq: "asc" }] });
    const rows = await prisma.bankTransaction.findMany({ where: { id: { in: f.map((x) => x.bankTransactionId).filter((x): x is string => !!x) } }, select: { id: true, status: true } });
    const st = new Map(rows.map((r) => [r.id, r.status]));
    const by = new Map<GroupKey, typeof f>();
    for (const x of f) { const g = groupOf(x, x.bankTransactionId ? st.get(x.bankTransactionId) : undefined); by.set(g, [...(by.get(g) ?? []), x]); }
    const checks = f.filter((x) => x.kind === "CHECK");
    out.push(`${checks.length} check${checks.length === 1 ? "" : "s"} found: ${(["ROUTINE", "NEEDS_DOCS", "OWNER_PERSONAL", "UNMATCHED", "POSTED", "PENDING"] as GroupKey[]).filter((g) => by.get(g)?.length).map((g) => `${GROUP_LABEL[g]}: ${by.get(g)!.length}`).join("; ") || "none"}.`);
    if (by.get("OTHER")?.length) out.push(`Other items (not checks): ${by.get("OTHER")!.length}.`);
    for (const g of ["OWNER_PERSONAL", "NEEDS_DOCS", "UNMATCHED", "ROUTINE", "OTHER"] as GroupKey[]) {
      const xs = by.get(g);
      if (!xs?.length) continue;
      out.push(`${GROUP_LABEL[g]}:`);
      for (const x of xs) {
        const line = `- ${x.kind === "CHECK" ? `#${x.checkNumber ?? "?"}` : x.kind.toLowerCase()}${x.date ? ` ${x.date}` : ""}${x.payee ? ` ${x.payee}` : ""}${money(x.amountCents)}${x.memo ? ` memo: ${x.memo}` : ""}${x.proposedAccount ? ` → proposed ${x.proposedAccount}` : ""}${x.reason ? ` (${x.reason})` : ""}${x.evidenceNeeded ? ` needs: ${x.evidenceNeeded}` : ""}${g === "UNMATCHED" && x.matchNote ? ` [${x.matchNote}]` : ""}`;
        if (room - line.length < 0) { out.push("(more items not listed here; all are on the page)"); break; }
        room -= line.length;
        out.push(line);
      }
    }
  }
  return out.join("\n");
}

/** "Summarize again": a new short answer from what Coetha already read and reviewed. Nothing is read again. */
export async function summarizeAgain(actor: Actor, clientId: string, messageId: string) {
  const m = await prisma.coethaChatMessage.findFirst({ where: { id: messageId, clientId, role: "USER" } });
  const ids = (m?.jobIds as string[] | null) ?? [];
  if (!m || !ids.length) throw new ValidationError("That question has no documents to summarize.");
  return askAboutDocuments(actor, clientId, "Summarize again what you read from these documents: the totals in each group and the decisions I need to make.", ids);
}

/** Every finding for the spreadsheet, with its group, proposal and bank match (staff with the books only). */
export async function findingsSheet(actor: Actor, clientId: string, jobId?: string) {
  await assertLedger(actor, clientId);
  const jobs = await prisma.coethaDocJob.findMany({ where: { clientId, ...(jobId ? { id: jobId } : {}) }, select: { id: true, name: true } });
  if (jobId && !jobs.length) throw new ValidationError("That document isn't on file for this business.");
  const name = new Map(jobs.map((j) => [j.id, j.name]));
  const f = await prisma.coethaDocFinding.findMany({ where: { clientId, jobId: { in: jobs.map((j) => j.id) } }, orderBy: [{ jobId: "asc" }, { page: "asc" }, { seq: "asc" }] });
  const rows = await prisma.bankTransaction.findMany({ where: { clientId, id: { in: f.map((x) => x.bankTransactionId).filter((x): x is string => !!x) } }, select: { id: true, status: true } });
  const st = new Map(rows.map((r) => [r.id, r.status]));
  // A cell starting with = + - @ (or a tab/return) would run as a formula in a spreadsheet.
  const cell = (v: unknown) => {
    let t = v == null ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
    return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const head = ["Document", "Page", "Group", "Item", "Check #", "Date", "Payee / from", "Amount", "Memo", "Details", "Bank match", "Proposed account", "Why", "Evidence needed", "Confidence"];
  const lines = [head.map(cell).join(",")];
  for (const x of f) {
    const g = groupOf(x, x.bankTransactionId ? st.get(x.bankTransactionId) : undefined);
    lines.push([name.get(x.jobId), x.page, GROUP_LABEL[g], x.kind.toLowerCase(), x.checkNumber, x.date, x.payee, x.amountCents == null ? "" : (x.amountCents / 100).toFixed(2), x.memo, x.details, x.matchNote, x.proposedAccount, x.reason, x.evidenceNeeded, x.confidence == null ? "" : x.confidence.toFixed(2)].map(cell).join(","));
  }
  await audit(prisma, { actorId: actor.id, action: "coetha.findings_download", entityType: "Client", entityId: clientId, clientId, details: { jobId: jobId ?? null, rows: f.length } });
  return lines.join("\r\n") + "\r\n";
}

// --- 6. What the page shows ------------------------------------------------------------------------

export async function readingView(actor: Actor, clientId: string) {
  await assertLedger(actor, clientId);
  const jobs = await prisma.coethaDocJob.findMany({ where: { clientId }, orderBy: { createdAt: "desc" }, take: 100, select: { id: true, documentId: true, name: true, status: true, kind: true, pages: true, pagesDone: true, attempts: true, error: true, notBefore: true, createdAt: true, _count: { select: { findings: true } } } });
  const raw = await prisma.coethaDocFinding.findMany({ where: { clientId, jobId: { in: jobs.map((j) => j.id) } }, orderBy: [{ page: "asc" }, { seq: "asc" }] });
  const rows = await prisma.bankTransaction.findMany({ where: { clientId, id: { in: raw.map((x) => x.bankTransactionId).filter((x): x is string => !!x) } }, select: { id: true, status: true } });
  const st = new Map(rows.map((r) => [r.id, r.status]));
  const findings = raw.map((f) => ({ ...f, group: groupOf(f, f.bankTransactionId ? st.get(f.bankTransactionId) : undefined) }));
  const order: GroupKey[] = ["ROUTINE", "NEEDS_DOCS", "OWNER_PERSONAL", "UNMATCHED", "POSTED", "PENDING", "OTHER"];
  return {
    jobs: jobs.map((j) => {
      const mine = findings.filter((f) => f.jobId === j.id);
      return { ...j, findings: mine, checks: mine.filter((f) => f.kind === "CHECK").length, groups: order.map((g) => ({ key: g, label: GROUP_LABEL[g], items: mine.filter((f) => f.group === g) })).filter((g) => g.items.length) };
    }),
    active: jobs.some((j) => j.status === "QUEUED" || j.status === "READING") || findings.some((f) => f.group === "PENDING" && !f.reviewedAt),
  };
}
