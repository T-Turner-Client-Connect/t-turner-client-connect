import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { isAdmin, type Actor } from "@/lib/auth/actor";
import { storage } from "@/lib/storage";
import { decryptBytes, decryptSecret, encryptBytes } from "@/lib/crypto";
import { pdfToPages } from "@/lib/tax/return-parser/parse";
import { checkIdentity, familyOf, MSG, readReturn, type Expected, type Person, type Verdict } from "@/lib/tax/return-identity";
import { ValidationError } from "./clients";

/**
 * The tax return upload gate. Every path that puts a completed return into a client's records calls
 * checkReturnUpload first, with the client, year and form staff selected:
 *   VERIFIED  → the caller saves it as usual.
 *   REJECTED  → nothing is saved; staff correct the selection or upload the right file (no override).
 *   UNCERTAIN → the file is held, encrypted, outside every client record (not in the Tax Center,
 *               Document Vault, Audit Center or return delivery) until an authorized reviewer
 *               establishes a verified match. It is then accepted when uploaded again.
 */

export type ReturnCheck = {
  clientId: string; taxYear: number; jurisdiction: string; filingType: "ORIGINAL" | "AMENDED"; returnType?: string | null;
  /**
   * Tabitha or an Admin who opened the return and confirmed it is this client's return for this
   * year: how they checked. Used only when the reader is UNCERTAIN (never for a rejection), and
   * recorded as a verification, so the return is saved in the same upload instead of being held.
   */
  confirmation?: string | null;
};

/** Held files that nobody reviews are removed after this many days. */
export const HOLD_DAYS = 7;

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** Tests of other features may replace the reader (their placeholder PDFs have no return text). */
let override: ((bytes: Uint8Array, c: ReturnCheck) => Promise<Verdict["result"]>) | null = null;
export function setReturnGate(fn: typeof override) {
  override = fn;
}

export async function expectedFor(c: ReturnCheck): Promise<Expected> {
  const [client, kase, aliases, profile] = await Promise.all([
    prisma.client.findUnique({ where: { id: c.clientId } }),
    prisma.taxPrepCase.findUnique({ where: { clientId_taxYear: { clientId: c.clientId, taxYear: c.taxYear } } }),
    prisma.clientNameAlias.findMany({ where: { clientId: c.clientId } }),
    prisma.bookkeepingProfile.findUnique({ where: { clientId: c.clientId }, select: { einEncrypted: true } }),
  ]);
  if (!client) throw new ValidationError("Client not found.");
  const person = (first?: string | null, last?: string | null): Person | null => (first?.trim() && last?.trim() ? { first: first.trim(), last: last.trim() } : null);
  const family = c.jurisdiction === "FEDERAL" ? familyOf(c.returnType, c.filingType) : null;
  // A business, estate, trust or nonprofit return (by the client type or the selected form).
  const businessReturn = client.clientType !== "INDIVIDUAL" || (family !== null && family !== "1040" && family !== "1040-X");
  let ein: string | null = null;
  if (businessReturn && profile?.einEncrypted) {
    try {
      ein = decryptSecret(profile.einEncrypted).replace(/\D/g, "");
    } catch {
      ein = null;
    }
  }
  return {
    taxYear: c.taxYear,
    jurisdiction: c.jurisdiction,
    filingType: c.filingType,
    returnType: c.returnType ?? null,
    taxpayer: businessReturn ? null : person(kase?.primaryFirstName, kase?.primaryLastName) ?? person(client.firstName, client.lastName),
    spouse: businessReturn ? null : person(kase?.spouseFirstName, kase?.spouseLastName) ?? person(client.spouseFirstName, client.spouseLastName),
    aliases: aliases.map((a) => ({ first: a.first, last: a.last })),
    business: businessReturn ? { name: client.businessName || client.displayName, ein } : null,
  };
}

/**
 * The values typed into a fillable PDF's form fields (a return printed with its fields still live).
 * The page text alone doesn't include them, so names and years in fields would otherwise be missed.
 */
async function formFieldText(bytes: Uint8Array): Promise<string> {
  try {
    const { PDFDocument, PDFTextField } = await import("pdf-lib");
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    return doc.getForm().getFields()
      .map((f) => (f instanceof PDFTextField ? f.getText() ?? "" : ""))
      .map((v) => v.trim())
      .filter(Boolean)
      .join("\n");
  } catch {
    return "";
  }
}

async function verdictFor(bytes: Uint8Array, c: ReturnCheck): Promise<Verdict> {
  const pages = await pdfToPages(bytes);
  const fields = await formFieldText(bytes);
  // Field values go after the first page's printed text (the name and year search covers them).
  const all = pages?.length && fields ? pages.map((p, i) => (i === 0 ? { ...p, text: `${p.text}\n${fields}` } : p)) : pages;
  return checkIdentity(all ? readReturn(all) : null, await expectedFor(c));
}

/**
 * Checks one return before it is saved. Throws on a rejection or a hold (with the message staff see);
 * returns normally only for a verified match.
 */
export async function checkReturnUpload(actor: Actor, c: ReturnCheck, file: { bytes: Uint8Array; originalName: string }) {
  const digest = sha(file.bytes);
  // A file an authorized reviewer already matched to this client, year and return.
  const approved = await prisma.returnVerification.findUnique({ where: { clientId_taxYear_jurisdiction_filingType_sha256: { clientId: c.clientId, taxYear: c.taxYear, jurisdiction: c.jurisdiction, filingType: c.filingType, sha256: digest } } });
  if (approved) return { result: "VERIFIED" as const, reviewed: true };
  if (override) {
    const r = await override(file.bytes, c);
    if (r === "VERIFIED") return { result: r, reviewed: false };
    if (r === "REJECTED") throw new ValidationError(MSG.WRONG_TAXPAYER);
    return hold(actor, c, file, digest, [{ code: "TEST_HOLD", message: MSG.NOT_VERIFIABLE }], null);
  }
  const v = await verdictFor(file.bytes, c);
  if (v.result === "VERIFIED") return { result: v.result, reviewed: false };
  if (v.result === "UNCERTAIN" && c.confirmation?.trim() && canReviewHolds(actor)) {
    const note = c.confirmation.trim();
    if (note.length < 10) throw new ValidationError("Say how you confirmed the return (for example, “Opened the PDF: Jane Doe, 2023 Form 1040”).");
    await prisma.returnVerification.upsert({
      where: { clientId_taxYear_jurisdiction_filingType_sha256: { clientId: c.clientId, taxYear: c.taxYear, jurisdiction: c.jurisdiction, filingType: c.filingType, sha256: digest } },
      create: { clientId: c.clientId, taxYear: c.taxYear, jurisdiction: c.jurisdiction, filingType: c.filingType, sha256: digest, verifiedById: actor.id, note: note.slice(0, 500) },
      update: {},
    });
    await audit(prisma, { actorId: actor.id, action: "tax.return_upload_confirmed", entityType: "Client", entityId: c.clientId, clientId: c.clientId, details: { clientId: c.clientId, taxYear: c.taxYear, jurisdiction: c.jurisdiction, filingType: c.filingType, sha256: digest, codes: v.reasons.map((r) => r.code), note: note.slice(0, 500) } });
    return { result: "VERIFIED" as const, reviewed: true };
  }
  if (v.result === "REJECTED") {
    await audit(prisma, { actorId: actor.id, action: "tax.return_upload_rejected", entityType: "Client", entityId: c.clientId, clientId: c.clientId, details: { ...c, code: v.reason.code, sha256: digest } });
    throw new ValidationError(v.reason.message);
  }
  return hold(actor, c, file, digest, v.reasons, v.read ? { year: v.read.year, name: v.read.taxpayer ? `${v.read.taxpayer.first} ${v.read.taxpayer.last}` : v.read.businessName } : null);
}

async function hold(actor: Actor, c: ReturnCheck, file: { bytes: Uint8Array; originalName: string }, digest: string, reasons: { code: string; message: string }[], read: { year: number | null; name: string | null } | null): Promise<never> {
  const existing = await prisma.returnUploadHold.findFirst({ where: { clientId: c.clientId, taxYear: c.taxYear, jurisdiction: c.jurisdiction, filingType: c.filingType, sha256: digest, status: "PENDING" } });
  if (!existing) {
    const storageKey = `return-holds/${randomUUID()}`;
    await storage.put(storageKey, encryptBytes(file.bytes));
    const h = await prisma.returnUploadHold.create({
      data: {
        clientId: c.clientId, taxYear: c.taxYear, jurisdiction: c.jurisdiction, filingType: c.filingType, returnType: c.returnType ?? null,
        storageKey, sha256: digest, originalName: file.originalName.slice(0, 200), reasons, readYear: read?.year ?? null, readName: read?.name?.slice(0, 120) ?? null,
        uploadedById: actor.id, expiresAt: new Date(Date.now() + HOLD_DAYS * 86_400_000),
      },
    });
    await audit(prisma, { actorId: actor.id, action: "tax.return_upload_held", entityType: "ReturnUploadHold", entityId: h.id, clientId: c.clientId, details: { ...c, codes: reasons.map((r) => r.code) } });
  }
  const why = reasons.map((r) => r.message).join(" ") || MSG.NOT_VERIFIABLE;
  const head = reasons.some((r) => r.code === "UNREADABLE") ? MSG.NOT_VERIFIABLE : "Not saved yet — the return couldn't be confirmed automatically.";
  const next = canReviewHolds(actor)
    ? "You can confirm it yourself: open the PDF, check the name and year, type how you checked under “I checked this return” and upload again — or verify it under Returns held for verification."
    : "Tabitha or an Admin can confirm it (Taxes tab → Returns held for verification).";
  throw Object.assign(new ValidationError(`${head} ${why === MSG.NOT_VERIFIABLE ? "" : why} ${next}`.replace(/\s+/g, " ").trim()), {
    next: { href: `/clients/${c.clientId}?tab=taxes&taxYear=${c.taxYear}#held-returns`, label: "Returns held for verification" },
  });
}

/** Who may establish a verified match for a held return: Tabitha and Admins. */
export const canReviewHolds = (actor: Actor) => isAdmin(actor);

export async function heldReturns(clientId: string) {
  return prisma.returnUploadHold.findMany({ where: { clientId, status: "PENDING", expiresAt: { gt: new Date() } }, orderBy: { createdAt: "desc" } });
}

/**
 * The reviewer opens the held file, reads it, and types what is printed on it. A match is recorded
 * only when what they read is this client, this year and this form; a legitimate name change is
 * confirmed (with a reason) and remembered for the client. A positive mismatch can't be verified.
 */
export async function verifyHeldReturn(actor: Actor, holdId: string, input: { year: number; first?: string; last?: string; businessName?: string; ein?: string; nameChange?: boolean; note: string }) {
  if (!canReviewHolds(actor)) throw new ValidationError("Only Tabitha or an Admin can verify a held return.");
  const h = await prisma.returnUploadHold.findUnique({ where: { id: holdId } });
  if (!h || h.status !== "PENDING") throw new ValidationError("That return is no longer waiting for verification.");
  const note = input.note.trim();
  if (note.length < 10) throw new ValidationError("Say how you verified the return (what you checked).");
  const c: ReturnCheck = { clientId: h.clientId, taxYear: h.taxYear, jurisdiction: h.jurisdiction, filingType: h.filingType as "ORIGINAL" | "AMENDED", returnType: h.returnType };
  if (input.year !== h.taxYear) throw new ValidationError(MSG.WRONG_YEAR(input.year, h.taxYear));
  const exp = await expectedFor(c);
  if (exp.business) {
    const ein = (input.ein ?? "").replace(/\D/g, "");
    if (ein.length !== 9) throw new ValidationError("Enter the 9-digit EIN printed on the return.");
    if (exp.business.ein && ein !== exp.business.ein) throw new ValidationError(MSG.WRONG_EIN);
    const printed = (input.businessName ?? "").trim();
    if (!printed) throw new ValidationError("Enter the business, estate or trust name printed on the return.");
  } else {
    const first = (input.first ?? "").trim(), last = (input.last ?? "").trim();
    if (!first || !last) throw new ValidationError("Enter the taxpayer's first and last name as printed on the return.");
    const same = [exp.taxpayer, exp.spouse, ...(exp.aliases ?? [])].some((p) => p && p.first.toLowerCase().split(" ")[0] === first.toLowerCase().split(" ")[0] && p.last.toLowerCase() === last.toLowerCase());
    if (!same) {
      const lastSame = [exp.taxpayer, exp.spouse].some((p) => p && p.last.toLowerCase() === last.toLowerCase());
      const firstSame = [exp.taxpayer, exp.spouse].some((p) => p && p.first.toLowerCase().split(" ")[0] === first.toLowerCase().split(" ")[0]);
      // Only a confirmed legal name change (or nickname/initial) of THIS client can be accepted.
      if (!(input.nameChange && (lastSame || firstSame))) throw new ValidationError(MSG.WRONG_TAXPAYER);
      await prisma.clientNameAlias.create({ data: { clientId: h.clientId, first, last, note: note.slice(0, 300), addedById: actor.id } });
    }
  }
  await prisma.$transaction([
    prisma.returnVerification.upsert({
      where: { clientId_taxYear_jurisdiction_filingType_sha256: { clientId: h.clientId, taxYear: h.taxYear, jurisdiction: h.jurisdiction, filingType: h.filingType, sha256: h.sha256 } },
      create: { clientId: h.clientId, taxYear: h.taxYear, jurisdiction: h.jurisdiction, filingType: h.filingType, sha256: h.sha256, holdId: h.id, verifiedById: actor.id, note: note.slice(0, 500), nameChange: !!input.nameChange },
      update: {},
    }),
    prisma.returnUploadHold.update({ where: { id: h.id }, data: { status: "VERIFIED", reviewedById: actor.id, reviewedAt: new Date(), reviewNote: note.slice(0, 500) } }),
  ]);
  await storage.remove(h.storageKey).catch(() => {});
  await audit(prisma, { actorId: actor.id, action: "tax.return_hold_verified", entityType: "ReturnUploadHold", entityId: h.id, clientId: h.clientId, details: { taxYear: h.taxYear, jurisdiction: h.jurisdiction, filingType: h.filingType, nameChange: !!input.nameChange } });
}

export async function discardHeldReturn(actor: Actor, holdId: string, reason: string) {
  if (!canReviewHolds(actor)) throw new ValidationError("Only Tabitha or an Admin can remove a held return.");
  const h = await prisma.returnUploadHold.findUnique({ where: { id: holdId } });
  if (!h || h.status !== "PENDING") throw new ValidationError("That return is no longer waiting for verification.");
  if (reason.trim().length < 3) throw new ValidationError("Say why it's being removed.");
  await prisma.returnUploadHold.update({ where: { id: h.id }, data: { status: "DISCARDED", reviewedById: actor.id, reviewedAt: new Date(), reviewNote: reason.trim().slice(0, 500) } });
  await storage.remove(h.storageKey).catch(() => {});
  await audit(prisma, { actorId: actor.id, action: "tax.return_hold_discarded", entityType: "ReturnUploadHold", entityId: h.id, clientId: h.clientId, details: { reason: reason.trim().slice(0, 200) } });
}

/** The held file, for the reviewer only (logged). */
export async function heldReturnBytes(actor: Actor, holdId: string) {
  if (!canReviewHolds(actor)) throw new ValidationError("Only Tabitha or an Admin can open a held return.");
  const h = await prisma.returnUploadHold.findUnique({ where: { id: holdId } });
  if (!h || h.status !== "PENDING") throw new ValidationError("That return is no longer waiting for verification.");
  const stored = await storage.get(h.storageKey);
  if (!stored) throw new ValidationError("The held file is no longer available. Upload it again.");
  await audit(prisma, { actorId: actor.id, action: "tax.return_hold_opened", entityType: "ReturnUploadHold", entityId: h.id, clientId: h.clientId });
  return { bytes: decryptBytes(stored), originalName: h.originalName };
}

/** Removes held files nobody reviewed in time (secure temporary-file policy). */
export async function purgeExpiredHolds(now = new Date()) {
  const old = await prisma.returnUploadHold.findMany({ where: { status: "PENDING", expiresAt: { lte: now } } });
  for (const h of old) {
    await storage.remove(h.storageKey).catch(() => {});
    await prisma.returnUploadHold.update({ where: { id: h.id }, data: { status: "EXPIRED" } });
  }
  return old.length;
}
