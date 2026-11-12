import "server-only";
import { createHash } from "node:crypto";
import type { Prisma, TaxReturnSummary } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import { FIELD, FIELDS, FORM_NAMES, type FormCode } from "@/lib/tax/return-parser/line-map";
import { parseReturnPages, pdfToPages, type ParsedReturn, type Person } from "@/lib/tax/return-parser/parse";
import { checkReturn, samePerson, type Expected, type Issue } from "@/lib/tax/return-parser/checks";
import { buildClientSummary, type ClientSummary } from "@/lib/tax/return-parser/summary";
import { ValidationError } from "./clients";
import { isReportApprover } from "./bookkeeping-clients";
import { authorizeDownload, downloadToken, readDocumentBytes, staffUploadDocument } from "./documents";
import { taxSummaryAutoSendOn } from "./owner-switches";
import { createSummary, reviseSummary, sendSummary, updateSummaryDraft, withdrawSummary, type SummaryInput } from "./tax-summary";

/**
 * Automatic Client Tax Summary (phase 1, individual returns).
 *
 * Tabitha (or staff) uploads the prepared return PDF printed from TaxAct. The
 * figures are READ from the forms by line (src/lib/tax/return-parser) — never
 * typed, never guessed, no AI — and checked (return-parser/checks.ts). Then:
 *  - any check fails → nothing is created or sent; the reasons wait for Tabitha;
 *  - every check passes → a Draft TaxReturnSummary (the existing approval
 *    system) is built, with one VERIFIED item per form holding every line read,
 *    so the client's approval signature covers all of it (figuresHash);
 *  - it goes to the client only by Tabitha's one-click "Send for approval", or
 *    automatically when her switch "Send tax summaries automatically" is on,
 *    she uploaded it herself and the client has an active portal login.
 * Each hold and each automatic send is audited.
 *
 * After approval the client signs Form 8879 through TaxAct's own e-signature
 * (no client message from here). Staff mark it sent and upload the signed PDF;
 * it is checked against the approved summary and kept staff-only until the
 * return is delivered (publishSigned8879ForYear).
 */

export const AUTO_PREFIX = "AUTO-";
const AWAITING_OWNER = "AUTO_AWAITING_OWNER";
const FORM_ITEM: Record<FormCode, { formType: string; payerName: string; section: string }> = {
  F1040: { formType: "AUTO-1040", payerName: "Form 1040 (read from the prepared return)", section: "OTHER" },
  S1: { formType: "AUTO-SCH-1", payerName: "Schedule 1 totals (read from the prepared return)", section: "OTHER" },
  S2: { formType: "AUTO-SCH-2", payerName: "Schedule 2 totals (read from the prepared return)", section: "OTHER" },
  S3: { formType: "AUTO-SCH-3", payerName: "Schedule 3 totals (read from the prepared return)", section: "OTHER" },
  SA: { formType: "AUTO-SCH-A", payerName: "Schedule A (read from the prepared return)", section: "DEDUCTION" },
  S8812: { formType: "AUTO-8812", payerName: "Schedule 8812 (read from the prepared return)", section: "CREDIT" },
  AL40: { formType: "AUTO-AL-40", payerName: "Alabama Form 40 (read from the prepared return)", section: "OTHER" },
  ALSA: { formType: "AUTO-AL-SCH-A", payerName: "Alabama Schedule A (read from the prepared return)", section: "DEDUCTION" },
  F8879: { formType: "AUTO-8879", payerName: "Form 8879", section: "OTHER" },
};
const SUMMARY_FORMS: FormCode[] = ["F1040", "S1", "S2", "S3", "SA", "S8812", "AL40", "ALSA"];
/** Problems that mean the file may not be this client's return: nothing is stored. */
const IDENTITY = /^(UNREADABLE|BUSINESS_RETURN|NO_1040|MULTIPLE_RETURNS|YEAR_|NAME_|SPOUSE_|UNSUPPORTED_FORM|PDF_)/;

export type Form8879Meta = {
  summaryId: string | null;
  sentAt: string | null;
  sentById: string | null;
  documentId: string | null;
  signedAt: string | null;
  figuresHash: string | null;
  manual: boolean;
  flags: string[];
  history: { at: string; event: string; by: string | null; documentId?: string | null; note?: string }[];
};
export type AutoMeta = { v: 1; documentId: string; uploadedById: string; uploadedAt: string; pages: Partial<Record<FormCode, number[]>>; form8879?: Form8879Meta };

type Stored = { key: string; label: string; cents: number; line: string };

export const isAutoItem = (i: { formType: string }) => i.formType.startsWith(AUTO_PREFIX);
export function autoMeta(s: { returnTotals: unknown }): AutoMeta | null {
  const m = (s.returnTotals as { autoSummary?: AutoMeta } | null)?.autoSummary;
  return m && m.v === 1 ? m : null;
}
export const isAutoSummary = (s: { returnTotals: unknown }) => !!autoMeta(s);

// --- Who the return should belong to ---------------------------------------------------------

export async function expectedPeople(clientId: string, taxYear: number): Promise<Expected> {
  const [client, kase] = await Promise.all([
    prisma.client.findUnique({ where: { id: clientId } }),
    prisma.taxPrepCase.findUnique({ where: { clientId_taxYear: { clientId, taxYear } } }),
  ]);
  const person = (first?: string | null, last?: string | null): Person | null => (first?.trim() && last?.trim() ? { first: first.trim(), last: last.trim() } : null);
  return {
    taxYear,
    taxpayer: person(kase?.primaryFirstName, kase?.primaryLastName) ?? person(client?.firstName, client?.lastName),
    spouse: person(kase?.spouseFirstName, kase?.spouseLastName) ?? person(client?.spouseFirstName, client?.spouseLastName),
  };
}

async function activePortalLogin(clientId: string) {
  return !!(await prisma.portalAccess.findFirst({ where: { clientId, revokedAt: null, canViewTax: true, portalUser: { active: true, passwordHash: { not: null } } } }));
}

/**
 * Stores a PDF once per client: uploading the very same file again (a re-check,
 * a double click) reuses the document already in Documents › Taxes.
 */
async function storeOnce(actor: Actor, input: { clientId: string; taxYear: number; title: string; docType?: string; bytes: Uint8Array; originalName: string }) {
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const same = await prisma.document.findFirst({ where: { clientId: input.clientId, deletedAt: null, category: "TAXES", file: { sha256 } }, orderBy: { createdAt: "desc" } });
  if (same) return same;
  return staffUploadDocument(actor, { clientId: input.clientId, category: "TAXES", title: input.title, year: input.taxYear, visibility: "STAFF_ONLY", docType: input.docType, bytes: input.bytes, originalName: input.originalName, notify: false });
}

// --- Reading -------------------------------------------------------------------------------------

export async function readReturn(bytes: Uint8Array) {
  if (!(bytes.length > 4 && String.fromCharCode(...bytes.slice(0, 5)) === "%PDF-")) return { parsed: null, issue: { code: "PDF_NOT_PDF", message: "That file isn't a PDF. Upload the return printed to PDF from TaxAct." } };
  const pages = await pdfToPages(bytes);
  if (!pages) return { parsed: null, issue: { code: "PDF_UNREADABLE", message: "The PDF couldn't be opened (damaged or password-protected)." } };
  return { parsed: parseReturnPages(pages), issue: null };
}

function itemsFrom(parsed: ParsedReturn, values: Record<string, number>, lines: Record<string, string>) {
  const out: { form: FormCode; amounts: Stored[] }[] = [];
  for (const form of SUMMARY_FORMS) {
    if (!parsed.forms[form]) continue;
    const amounts = FIELDS.filter((f) => f.form === form && f.id in values).map((f) => ({ key: f.id, label: `${FORM_NAMES[form]}, line ${lines[f.id]} — ${f.label}`, cents: values[f.id], line: lines[f.id] }));
    out.push({ form, amounts });
  }
  return out;
}

function summaryInputFrom(facts: NonNullable<ReturnType<typeof checkReturn>["facts"]>, values: Record<string, number>): Omit<SummaryInput, "clientId" | "taxYear" | "filingType"> {
  const v = (id: string) => values[id] ?? 0;
  return {
    filingStatus: facts.filingStatus,
    taxpayerName: facts.taxpayerName,
    spouseName: facts.spouseName,
    dependents: facts.dependents.map((d) => ({ name: d.name, relationship: d.relationship })),
    wagesCents: v("1040.1z"),
    otherIncomeCents: v("1040.9") - v("1040.1z"),
    totalIncomeCents: v("1040.9"),
    agiCents: v("1040.11"),
    deductionType: facts.federalDeduction,
    deductionCents: v("1040.12"),
    taxableIncomeCents: v("1040.15"),
    federalResultCents: facts.federalResultCents,
    stateResults: facts.alabama ? [{ state: "AL", resultCents: facts.alabama.resultCents }] : [],
    depositBankName: null,
    depositAccountType: facts.deposit?.type ?? null,
    depositRoutingLast4: facts.deposit?.routingLast4 ?? null,
    depositAccountLast4: facts.deposit?.accountLast4 ?? null,
    officeNote: null,
  };
}

async function hold(actor: Actor, clientId: string, taxYear: number, issues: Issue[], extra: Record<string, unknown> = {}) {
  await audit(prisma, { actorId: actor.id, action: "tax.auto_summary_held", entityType: "Client", entityId: clientId, clientId, details: { taxYear, kind: "CHECKS_FAILED", issues, ...extra } as Prisma.InputJsonValue });
  return { outcome: "HELD" as const, summaryId: null as string | null, issues, waitingReason: null as string | null };
}

export type UploadOutcome = { outcome: "HELD" | "READY" | "AUTO_SENT"; summaryId: string | null; issues: Issue[]; waitingReason: string | null };

/**
 * Upload of the prepared return (or of a signed Form 8879, which is routed to
 * recordSigned8879). Runs every check; builds the draft only when all pass.
 */
export async function uploadPreparedReturn(actor: Actor, input: { clientId: string; taxYear: number; bytes: Uint8Array; originalName: string }): Promise<UploadOutcome | { outcome: "FORM_8879"; status: string; flags: string[] }> {
  const client = await prisma.client.findUnique({ where: { id: input.clientId } });
  if (!client || client.archivedAt) throw new ValidationError("Client not found.");
  if (!Number.isInteger(input.taxYear) || input.taxYear < 2000 || input.taxYear > new Date().getFullYear()) throw new ValidationError("Choose the tax year.");
  const { parsed, issue } = await readReturn(input.bytes);
  if (!parsed) return hold(actor, input.clientId, input.taxYear, [issue!], { fileSaved: false });
  // A file that is only a Form 8879 is the signed e-file authorization, not the return.
  if (parsed.forms.F8879 && !parsed.forms.F1040) {
    const r = await recordSigned8879(actor, { clientId: input.clientId, taxYear: input.taxYear, bytes: input.bytes, originalName: input.originalName, parsed });
    return { outcome: "FORM_8879", status: r.status, flags: r.flags };
  }
  const expected = await expectedPeople(input.clientId, input.taxYear);
  const result = checkReturn(parsed, expected);
  const active = await prisma.taxReturnSummary.findFirst({ where: { clientId: input.clientId, taxYear: input.taxYear, filingType: "ORIGINAL", status: { in: ["DRAFT", "SENT", "CHANGES_REQUESTED", "CLIENT_APPROVED"] } }, include: { items: true } });

  if (result.issues.some((i) => IDENTITY.test(i.code))) return hold(actor, input.clientId, input.taxYear, result.issues, { fileSaved: false });
  if (active?.status === "DRAFT" && !isAutoSummary(active)) {
    return hold(actor, input.clientId, input.taxYear, [{ code: "MANUAL_DRAFT", message: `A hand-entered ${input.taxYear} draft summary already exists. Withdraw it in the Tax Return Summary card, then upload again.` }], { fileSaved: false });
  }

  const doc = await storeOnce(actor, { clientId: input.clientId, taxYear: input.taxYear, title: `${input.taxYear} prepared return (TaxAct) — read for the automatic summary, staff only`, bytes: input.bytes, originalName: input.originalName });

  if (result.issues.length || !result.facts) {
    // The earlier automatic draft no longer matches the latest upload: it can't be sent.
    if (active?.status === "DRAFT") await withdrawSummary(actor, active.id);
    return hold(actor, input.clientId, input.taxYear, result.issues, { fileSaved: true, documentId: doc.id, withdrewDraft: active?.status === "DRAFT" ? active.id : null });
  }

  // Build (or rebuild) the draft through the existing summary system.
  const figures = summaryInputFrom(result.facts, result.values);
  let summaryId: string;
  try {
    if (!active) summaryId = (await createSummary(actor, { clientId: input.clientId, taxYear: input.taxYear, filingType: "ORIGINAL", ...figures })).id;
    else {
      summaryId = active.status === "DRAFT" ? active.id : (await reviseSummary(actor, active.id, "A new prepared return was uploaded; the automatic summary was rebuilt from it.")).id;
      await prisma.taxSummaryItem.deleteMany({ where: { summaryId } });
      await prisma.taxSummaryCheck.deleteMany({ where: { summaryId } });
      await updateSummaryDraft(actor, summaryId, figures);
    }
  } catch (e) {
    if (e instanceof ValidationError) return hold(actor, input.clientId, input.taxYear, [{ code: "SUMMARY_LOCKED", message: e.message }], { fileSaved: true, documentId: doc.id });
    throw e;
  }
  const prior = active ? autoMeta(active) : null;
  const meta: AutoMeta = { v: 1, documentId: doc.id, uploadedById: actor.id, uploadedAt: new Date().toISOString(), pages: parsed.forms, ...(prior?.form8879 ? { form8879: prior.form8879 } : {}) };
  let order = 0;
  for (const it of itemsFrom(parsed, result.values, result.lines)) {
    const spec = FORM_ITEM[it.form];
    await prisma.taxSummaryItem.create({
      data: {
        summaryId, section: spec.section, formType: spec.formType, payerName: spec.payerName, recipient: "JOINT", returnAmounts: it.amounts as unknown as Prisma.InputJsonValue,
        source: "RETURN", sourceDocumentId: doc.id, sourcePage: parsed.forms[it.form]?.[0] ?? null, evidence: `Read by form and line from ${FORM_NAMES[it.form]} (page ${(parsed.forms[it.form] ?? []).join(", ")}).`,
        status: "VERIFIED", verifiedById: actor.id, verifiedAt: new Date(), note: "Read automatically from the prepared return; every cross-check passed.", sortOrder: order++,
      },
    });
  }
  await prisma.taxReturnSummary.update({
    where: { id: summaryId },
    data: {
      // Ages come from dates of birth printed with the return, when there are any.
      dependents: result.facts.dependents as unknown as Prisma.InputJsonValue,
      returnDocumentId: doc.id, extractedAt: new Date(), returnTotals: { autoSummary: meta } as unknown as Prisma.InputJsonValue,
    },
  });
  await prisma.taxSummaryCheck.create({ data: { summaryId, code: AWAITING_OWNER, severity: "BLOCKING", message: "Waiting for Tabitha to click “Send for approval” on the automatic summary." } });
  await audit(prisma, { actorId: actor.id, action: "tax.auto_summary_built", entityType: "TaxReturnSummary", entityId: summaryId, clientId: input.clientId, details: { taxYear: input.taxYear, documentId: doc.id, forms: Object.keys(parsed.forms) } });

  // Automatic send: only with Tabitha's switch on, her own upload, and an active portal login.
  const [switchOn, owner, login] = await Promise.all([taxSummaryAutoSendOn(), isReportApprover(actor), activePortalLogin(input.clientId)]);
  const waitingReason = !switchOn
    ? "“Send tax summaries automatically” is off, so it waits for Tabitha's “Send for approval”."
    : !owner
      ? "Uploaded by staff, so it waits for Tabitha's “Send for approval”."
      : !login
        ? "The client has no active portal login yet, so it waits for Tabitha."
        : null;
  if (!waitingReason) {
    try {
      await prisma.taxSummaryCheck.deleteMany({ where: { summaryId, code: AWAITING_OWNER } });
      await sendSummary(actor, summaryId);
      await audit(prisma, { actorId: actor.id, action: "tax.auto_summary_auto_sent", entityType: "TaxReturnSummary", entityId: summaryId, clientId: input.clientId, details: { taxYear: input.taxYear, documentId: doc.id } });
      return { outcome: "AUTO_SENT", summaryId, issues: [], waitingReason: null };
    } catch (e) {
      await prisma.taxSummaryCheck.create({ data: { summaryId, code: AWAITING_OWNER, severity: "BLOCKING", message: "Waiting for Tabitha to click “Send for approval” on the automatic summary." } });
      const msg = e instanceof Error ? e.message : "The automatic send failed.";
      await audit(prisma, { actorId: actor.id, action: "tax.auto_summary_held", entityType: "TaxReturnSummary", entityId: summaryId, clientId: input.clientId, details: { taxYear: input.taxYear, kind: "WAITING_FOR_OWNER", reason: `Automatic send didn't go through: ${msg}` } });
      return { outcome: "READY", summaryId, issues: [], waitingReason: `Automatic send didn't go through: ${msg}` };
    }
  }
  await audit(prisma, { actorId: actor.id, action: "tax.auto_summary_held", entityType: "TaxReturnSummary", entityId: summaryId, clientId: input.clientId, details: { taxYear: input.taxYear, kind: "WAITING_FOR_OWNER", reason: waitingReason } });
  return { outcome: "READY", summaryId, issues: [], waitingReason };
}

/** Line values stored on the summary's automatic items (what the client approves). */
export function storedValues(items: { formType: string; returnAmounts: unknown; status?: string }[]) {
  const values: Record<string, number> = {};
  const lines: Record<string, string> = {};
  for (const it of items) {
    if (!isAutoItem(it) || it.formType === FORM_ITEM.F8879.formType) continue;
    for (const a of (Array.isArray(it.returnAmounts) ? it.returnAmounts : []) as Stored[]) {
      values[a.key] = a.cents;
      lines[a.key] = a.line ?? FIELD[a.key]?.line ?? "";
    }
  }
  return { values, lines };
}

/**
 * Tabitha's one-click "Send for approval". The stored return is read and
 * checked again, and must match the draft exactly (so nothing edited by hand
 * goes out under the automatic summary).
 */
export async function sendAutoSummaryForApproval(actor: Actor, summaryId: string) {
  if (!(await isReportApprover(actor))) throw new ForbiddenError("Only Tabitha can send an automatic tax summary for approval.");
  const s = await prisma.taxReturnSummary.findUnique({ where: { id: summaryId }, include: { items: true } });
  if (!s || !isAutoSummary(s)) throw new ValidationError("Automatic summary not found.");
  if (s.status !== "DRAFT") throw new ValidationError("This summary was already sent.");
  const meta = autoMeta(s)!;
  const doc = await prisma.document.findUnique({ where: { id: meta.documentId }, include: { file: true } });
  const bytes = doc && !doc.deletedAt && doc.clientId === s.clientId ? await readDocumentBytes(doc.file) : null;
  if (!bytes) throw new ValidationError("The uploaded return couldn't be read again. Upload it again.");
  const { parsed } = await readReturn(bytes);
  const result = parsed ? checkReturn(parsed, await expectedPeople(s.clientId, s.taxYear)) : null;
  if (!result || result.issues.length || !result.facts) throw new ValidationError(`Not sent — the return no longer passes every check: ${(result?.issues ?? []).map((i) => i.message).join(" · ") || "couldn't be read"}`);
  const expect = summaryInputFrom(result.facts, result.values);
  const stored = storedValues(s.items);
  const sameValues = JSON.stringify(Object.entries(result.values).sort()) === JSON.stringify(Object.entries(stored.values).sort());
  const cols = ["filingStatus", "taxpayerName", "spouseName", "agiCents", "deductionType", "deductionCents", "taxableIncomeCents", "totalIncomeCents", "wagesCents", "federalResultCents", "depositAccountLast4", "depositRoutingLast4", "depositAccountType"] as const;
  const changed = cols.filter((k) => (expect[k] ?? null) !== (s[k] ?? null));
  if (JSON.stringify(expect.stateResults) !== JSON.stringify(s.stateResults)) changed.push("stateResults" as never);
  if (!sameValues || changed.length || s.items.some((i) => !isAutoItem(i))) throw new ValidationError("Not sent — the draft's figures were changed by hand after they were read from the return. Upload the return again to rebuild it.");
  await prisma.taxSummaryCheck.deleteMany({ where: { summaryId, code: AWAITING_OWNER } });
  try {
    await sendSummary(actor, summaryId);
  } catch (e) {
    await prisma.taxSummaryCheck.create({ data: { summaryId, code: AWAITING_OWNER, severity: "BLOCKING", message: "Waiting for Tabitha to click “Send for approval” on the automatic summary." } });
    throw e;
  }
  await audit(prisma, { actorId: actor.id, action: "tax.auto_summary_sent_by_owner", entityType: "TaxReturnSummary", entityId: summaryId, clientId: s.clientId, details: { taxYear: s.taxYear } });
}

/** The client's plain-language summary for a stored automatic summary. */
export function clientSummaryOf(s: Pick<TaxReturnSummary, "taxYear" | "filingStatus" | "taxpayerName" | "spouseName" | "dependents" | "depositAccountLast4" | "depositAccountType"> & { items?: { formType: string; returnAmounts: unknown }[] }): ClientSummary {
  const { values, lines } = storedValues(s.items ?? []);
  return buildClientSummary({
    taxYear: s.taxYear, filingStatus: s.filingStatus, taxpayerName: s.taxpayerName, spouseName: s.spouseName,
    dependents: (Array.isArray(s.dependents) ? s.dependents : []) as { name: string; relationship?: string; age?: number | null }[],
    values, lines, deposit: s.depositAccountLast4 ? { accountLast4: s.depositAccountLast4, type: s.depositAccountType } : null,
  });
}

// --- Form 8879 -----------------------------------------------------------------------------------

/** Titles always carry the RETURN's tax year, never the year it was signed. */
export const signedDate = (d: Date | string) => new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Chicago" });
export const form8879StaffTitle = (returnYear: number, signedOn: Date | string) => `Form 8879 — Tax Year ${returnYear} (signed ${signedDate(signedOn)})`;
export const form8879VaultTitle = (returnYear: number) => `Form 8879 — Tax Year ${returnYear} (signed)`;
export const form8879Progress = (returnYear: number, signedOn: Date | string) => `8879 signed for Tax Year ${returnYear} on ${signedDate(signedOn)}`;

export const F8879_MISMATCH = "8879 numbers don't match the approved summary";
export type F8879Status = "NONE" | "WAITING" | "SENT" | "SIGNED" | "NEEDS_RESIGN" | "MISMATCH";
export const F8879_LABEL: Record<F8879Status, string> = { NONE: "—", WAITING: "Waiting to send", SENT: "Sent", SIGNED: "Signed ✓", NEEDS_RESIGN: "Needs re-signing", MISMATCH: "Numbers don't match" };

/** Where the 8879 stands for this summary version. */
export function form8879Status(s: { id: string; status: string; figuresHash: string; returnTotals: unknown; taxYear?: number; filingType?: string }): { status: F8879Status; signedAt: string | null; sentAt: string | null; flags: string[] } {
  const m = autoMeta(s)?.form8879;
  const base = { signedAt: m?.signedAt ?? null, sentAt: m?.sentAt ?? null, flags: m?.flags ?? [] };
  if (m?.documentId && m.signedAt) {
    if (m.summaryId !== s.id || m.figuresHash !== s.figuresHash) return { ...base, status: "NEEDS_RESIGN" };
    if (m.flags.length) return { ...base, status: "MISMATCH" };
    return { ...base, status: "SIGNED" };
  }
  if (s.status !== "CLIENT_APPROVED") return { ...base, status: "NONE" };
  // Returns for 2022–2025 were filed before the 8879 rules here: never "waiting to send" (a signed one on file still shows above).
  if (s.taxYear != null && s.taxYear < 2026 && (s.filingType ?? "ORIGINAL") === "ORIGINAL" && !m?.sentAt) return { ...base, status: "NONE" };
  if (m?.sentAt && m.summaryId === s.id) return { ...base, status: "SENT" };
  return { ...base, status: "WAITING" };
}

async function saveMeta(summaryId: string, s: { returnTotals: unknown }, f: Form8879Meta) {
  const meta = autoMeta(s)!;
  await prisma.taxReturnSummary.update({ where: { id: summaryId }, data: { returnTotals: { autoSummary: { ...meta, form8879: f } } as unknown as Prisma.InputJsonValue } });
}
const freshMeta = (prev: Form8879Meta | undefined): Form8879Meta => ({ summaryId: null, sentAt: null, sentById: null, documentId: null, signedAt: null, figuresHash: null, manual: false, flags: [], history: prev?.history ?? [] });

/** Staff: "Mark 8879 sent" — TaxAct's e-signature request went out. No client message from here. */
export async function mark8879Sent(actor: Actor, summaryId: string) {
  const s = await prisma.taxReturnSummary.findUnique({ where: { id: summaryId } });
  if (!s || !isAutoSummary(s)) throw new ValidationError("Automatic summary not found.");
  if (s.status !== "CLIENT_APPROVED") throw new ValidationError("Send the 8879 only after the client approves the summary (both spouses on a joint return).");
  const prev = autoMeta(s)!.form8879;
  const f: Form8879Meta = { ...freshMeta(prev), summaryId, sentAt: new Date().toISOString(), sentById: actor.id };
  // A signature for an earlier version stays in the history; it no longer counts.
  f.history = [...f.history, { at: f.sentAt!, event: prev?.signedAt ? "SENT_FOR_RESIGNING" : "SENT", by: actor.id }];
  await saveMeta(summaryId, s, f);
  await audit(prisma, { actorId: actor.id, action: "tax.form8879_sent", entityType: "TaxReturnSummary", entityId: summaryId, clientId: s.clientId, details: { taxYear: s.taxYear, version: s.version } });
}

/**
 * A signed Form 8879 PDF: tax year and names must match this client (else it
 * is refused and not stored). Stored once, staff-only, in Documents › Taxes for
 * the year and linked to the federal filing. Flagged for Tabitha when it came
 * before approval or its AGI / refund / amount owed differ from the summary.
 * `manual`: Tabitha confirms a file the parser couldn't recognize.
 */
export async function recordSigned8879(actor: Actor, input: { clientId: string; taxYear: number; bytes: Uint8Array; originalName: string; parsed?: ParsedReturn; manual?: boolean }) {
  const parsed = input.parsed ?? (await readReturn(input.bytes)).parsed;
  const is8879 = !!parsed?.forms.F8879;
  if (!is8879 && !input.manual) throw new ValidationError("This file wasn't recognized as a Form 8879. If it is the signed 8879, Tabitha can use “This is the signed 8879”.");
  if (input.manual && !(await isReportApprover(actor))) throw new ForbiddenError("Only Tabitha can mark a file as the signed 8879 by hand.");
  const expected = await expectedPeople(input.clientId, input.taxYear);
  const s = await prisma.taxReturnSummary.findFirst({ where: { clientId: input.clientId, taxYear: input.taxYear, filingType: "ORIGINAL", status: { in: ["DRAFT", "SENT", "CHANGES_REQUESTED", "CLIENT_APPROVED"] } }, include: { items: true }, orderBy: { version: "desc" } });
  if (is8879 && parsed) {
    const ys = parsed.years.F8879 ?? [];
    if (ys.length && (ys.length > 1 || ys[0] !== input.taxYear)) throw new ValidationError(`This Form 8879 is for ${ys.join(", ")}, not ${input.taxYear}. It wasn't saved.`);
    const tp = parsed.form8879?.taxpayer;
    if (!tp) throw new ValidationError("The taxpayer's name on the 8879 couldn't be read. It wasn't saved.");
    if (!expected.taxpayer || !samePerson(tp, expected.taxpayer)) throw new ValidationError(`The name on the 8879 (${tp.first} ${tp.last}) doesn't match this client. It wasn't saved.`);
    const sp = parsed.form8879?.spouse;
    if (s?.filingStatus === "MFJ" && (!sp || !expected.spouse || !samePerson(sp, expected.spouse))) throw new ValidationError("The spouse's name on the 8879 doesn't match the spouse on file. It wasn't saved.");
  }
  const doc = await storeOnce(actor, { clientId: input.clientId, taxYear: input.taxYear, title: form8879StaffTitle(input.taxYear, new Date()), docType: "FORM_8879", bytes: input.bytes, originalName: input.originalName });
  const filing = await prisma.filingRecord.findFirst({ where: { clientId: input.clientId, taxYear: input.taxYear, jurisdiction: "FEDERAL", filingType: "ORIGINAL" } });
  await prisma.document.update({ where: { id: doc.id }, data: { filingDocType: "SIGNED_8879", filingId: filing?.id ?? null } });

  const flags: string[] = [];
  if (!s || !isAutoSummary(s)) flags.push(`${F8879_MISMATCH}: there's no automatic ${input.taxYear} summary for this client yet.`);
  else {
    if (s.status !== "CLIENT_APPROVED") flags.push(`${F8879_MISMATCH}: it was uploaded before the client approved the summary.`);
    if (is8879 && parsed) {
      const r = parsed.readings;
      const val = (id: string) => (r[id]?.status === "found" ? (r[id] as { value: number }).value : r[id]?.status === "blank" ? 0 : null);
      const fed = s.federalResultCents;
      const cmp: [string, number | null, number][] = [
        ["adjusted gross income", val("8879.1"), s.agiCents],
        [fed >= 0 ? "refund" : "amount owed", fed >= 0 ? val("8879.4") : val("8879.5"), Math.abs(fed)],
      ];
      for (const [what, got, want] of cmp) {
        if (got === null) flags.push(`${F8879_MISMATCH}: the ${what} on the 8879 couldn't be read.`);
        else if (got !== want) flags.push(`${F8879_MISMATCH}: ${what} on the 8879 is $${(got / 100).toLocaleString("en-US")}, the summary shows $${(want / 100).toLocaleString("en-US")}.`);
      }
    }
  }
  const now = new Date().toISOString();
  if (s && isAutoSummary(s)) {
    const prev = autoMeta(s)!.form8879;
    const f: Form8879Meta = {
      ...freshMeta(prev), summaryId: s.id, sentAt: prev?.summaryId === s.id ? prev.sentAt : null, sentById: prev?.summaryId === s.id ? prev.sentById : null,
      documentId: doc.id, signedAt: now, figuresHash: s.figuresHash, manual: !!input.manual, flags,
    };
    f.history = [...f.history, { at: now, event: flags.length ? "SIGNED_FLAGGED" : "SIGNED", by: actor.id, documentId: doc.id, note: flags.join(" ") || undefined }];
    await saveMeta(s.id, s, f);
  }
  await audit(prisma, { actorId: actor.id, action: flags.length ? "tax.form8879_flagged" : "tax.form8879_signed", entityType: "Document", entityId: doc.id, clientId: input.clientId, details: { taxYear: input.taxYear, summaryId: s?.id ?? null, flags, manual: !!input.manual, alabamaEfile: !!parsed?.alabamaEfile } });
  return { documentId: doc.id, status: flags.length ? "MISMATCH" : "SIGNED", flags };
}

/**
 * The owner filing gate's "signed Form 8879 is on file": a signed 8879 linked
 * to that year's federal filing and matching the approved summary. (The
 * checkbox remains as the fallback; who may file is unchanged.)
 */
export async function signed8879OnFile(filing: { id?: string; clientId: string; taxYear: number; jurisdiction: string; filingType: string }) {
  if (filing.jurisdiction !== "FEDERAL") return false;
  const s = await prisma.taxReturnSummary.findFirst({ where: { clientId: filing.clientId, taxYear: filing.taxYear, filingType: filing.filingType, status: "CLIENT_APPROVED" }, orderBy: { version: "desc" } });
  if (!s || form8879Status(s).status !== "SIGNED") return false;
  const d = await prisma.document.findUnique({ where: { id: autoMeta(s)!.form8879!.documentId! } });
  if (!d || d.deletedAt || d.clientId !== filing.clientId || d.filingDocType !== "SIGNED_8879" || d.scanStatus === "INFECTED") return false;
  if (d.filingId && filing.id && d.filingId !== filing.id) return false;
  if (!d.filingId && filing.id) await prisma.document.update({ where: { id: d.id }, data: { filingId: filing.id } });
  return true;
}

/**
 * Called when a year's return is delivered to the client: the linked signed
 * 8879 is published to the client's own vault (Taxes › year) next to the
 * return. Same publish rules as other documents: the scan must have passed,
 * it stays in this client's vault only (portal business-access rules apply
 * when it's listed), and only an 8879 that matches the approved summary.
 */
export async function publishSigned8879ForYear(clientId: string, taxYear: number, actorId?: string | null) {
  const released = await prisma.document.count({ where: { clientId, year: taxYear, filingDocType: "RETURN", reviewStatus: "APPROVED", visibility: "PUBLISHED", deletedAt: null } });
  if (!released) return { published: 0 };
  const summaries = await prisma.taxReturnSummary.findMany({ where: { clientId, taxYear, status: "CLIENT_APPROVED" }, orderBy: { version: "desc" } });
  let published = 0;
  for (const s of summaries) {
    if (form8879Status(s).status !== "SIGNED") continue;
    const id = autoMeta(s)!.form8879!.documentId!;
    const d = await prisma.document.findUnique({ where: { id } });
    if (!d || d.clientId !== clientId || d.deletedAt || d.visibility === "PUBLISHED" || d.scanStatus !== "CLEAN") continue;
    await prisma.$transaction([
      prisma.document.update({ where: { id }, data: { visibility: "PUBLISHED", publishedAt: new Date(), title: form8879VaultTitle(taxYear) } }),
      prisma.documentAccessLog.create({ data: { documentId: id, action: "PUBLISH", staffUserId: actorId ?? null } }),
    ]);
    await audit(prisma, { actorId: actorId ?? null, action: "tax.form8879_published", entityType: "Document", entityId: id, clientId, details: { taxYear, summaryId: s.id } });
    published++;
  }
  return { published };
}

// --- Staff views -----------------------------------------------------------------------------------

export type HeldEvent = { at: Date; kind: string; issues: Issue[]; reason: string | null; byId: string | null };

async function lastEvents(where: Prisma.AuditLogWhereInput) {
  return prisma.auditLog.findMany({ where: { ...where, action: { in: ["tax.auto_summary_held", "tax.auto_summary_auto_sent", "tax.auto_summary_sent_by_owner", "tax.auto_summary_built"] } }, orderBy: { createdAt: "desc" }, take: 400 });
}
const eventOf = (e: { createdAt: Date; actorId: string | null; details: unknown }): HeldEvent => {
  const d = (e.details ?? {}) as { kind?: string; issues?: Issue[]; reason?: string };
  return { at: e.createdAt, kind: d.kind ?? "", issues: d.issues ?? [], reason: d.reason ?? null, byId: e.actorId };
};

/** What the client's Taxes tab shows: per year, the latest upload result, the summary and its 8879. */
export async function autoSummaryPanel(clientId: string) {
  const [summaries, events, switchOn] = await Promise.all([
    prisma.taxReturnSummary.findMany({ where: { clientId, status: { in: ["DRAFT", "SENT", "CHANGES_REQUESTED", "CLIENT_APPROVED"] } }, include: { items: true, checks: true, signatures: { where: { invalidatedAt: null } } }, orderBy: [{ taxYear: "desc" }, { version: "desc" }] }),
    lastEvents({ clientId }),
    taxSummaryAutoSendOn(),
  ]);
  const years = [...new Set([...summaries.map((s) => s.taxYear), ...events.map((e) => (e.details as { taxYear?: number } | null)?.taxYear).filter((y): y is number => !!y)])].sort((a, b) => b - a);
  return {
    switchOn,
    years: years.map((year) => {
      const s = summaries.find((x) => x.taxYear === year && isAutoSummary(x)) ?? null;
      const manual = summaries.find((x) => x.taxYear === year && !isAutoSummary(x)) ?? null;
      const last = events.find((e) => (e.details as { taxYear?: number } | null)?.taxYear === year) ?? null;
      const latestHold = last && last.action === "tax.auto_summary_held" ? eventOf(last) : null;
      const held = latestHold?.kind === "CHECKS_FAILED" ? latestHold : null;
      const waiting = s?.status === "DRAFT" ? (latestHold?.kind === "WAITING_FOR_OWNER" ? latestHold.reason : "Waiting for Tabitha's “Send for approval”.") : null;
      return { year, summary: s, manualSummary: manual, held, waiting, model: s ? clientSummaryOf(s) : null, form8879: s ? form8879Status(s) : null, history: s ? autoMeta(s)?.form8879?.history ?? [] : [] };
    }),
  };
}

export type TrackerRow = {
  clientId: string;
  clientName: string;
  taxYear: number;
  /** Client record, Taxes tab, scrolled to this year's summary and 8879 panel. */
  clientHref: string;
  /** Where the 8879 status links: the signed PDF (secure staff link, logged) or the client's panel. */
  statusHref: string | null;
  /** Signed 8879 the viewer may not open (same rule as the Documents tab). */
  noAccess: boolean;
  /** Documents tab, Taxes › that year. */
  recordsHref: string;
  signedOn: Date | null;
  summary: { code: "HELD" | "READY" | "SENT" | "APPROVED" | "QUESTIONS" | "DRAFT"; label: string; reason: string | null };
  form8879: { code: F8879Status; label: string; date: Date | null };
  lastChange: Date;
  needsAction: boolean;
  href: string;
};

export const TRACKER_FILTERS = ["ALL", "ACTION", "HELD", "READY", "SENT", "QUESTIONS", "APPROVED", "8879_WAITING", "8879_SENT", "8879_SIGNED", "8879_RESIGN", "8879_MISMATCH"] as const;
export type TrackerFilter = (typeof TRACKER_FILTERS)[number];

/** Firm-wide "Summaries & 8879s" for one tax year: one row per client, rows needing Tabitha first. */
export async function summaryTracker(viewer: Pick<Actor, "id">, taxYear: number, filter: TrackerFilter = "ALL"): Promise<TrackerRow[]> {
  const [summaries, events] = await Promise.all([
    prisma.taxReturnSummary.findMany({ where: { taxYear, status: { in: ["DRAFT", "SENT", "CHANGES_REQUESTED", "CLIENT_APPROVED"] } }, include: { client: { select: { displayName: true } } }, orderBy: { version: "desc" } }),
    lastEvents({ details: { path: ["taxYear"], equals: taxYear } }),
  ]);
  const rows = new Map<string, TrackerRow>();
  for (const s of summaries) {
    if (rows.has(s.clientId)) continue;
    const f = form8879Status(s);
    const auto = isAutoSummary(s);
    const summary: TrackerRow["summary"] =
      s.status === "DRAFT" ? (auto ? { code: "READY", label: "Ready", reason: "Waiting for your “Send for approval”" } : { code: "DRAFT", label: "Draft (entered by hand)", reason: null })
        : s.status === "SENT" ? { code: "SENT", label: "Sent", reason: "Waiting for the client" }
          : s.status === "CHANGES_REQUESTED" ? { code: "QUESTIONS", label: "Questions", reason: s.changesRequestNote?.slice(0, 120) ?? null }
            : { code: "APPROVED", label: "Approved", reason: null };
    const dates = [s.updatedAt, f.signedAt ? new Date(f.signedAt) : null, f.sentAt ? new Date(f.sentAt) : null].filter((d): d is Date => !!d);
    const panel = `/clients/${s.clientId}?tab=taxes#auto-summary-${taxYear}`;
    let statusHref: string | null = f.status === "NONE" ? null : panel;
    let noAccess = false;
    const docId = autoMeta(s)?.form8879?.documentId;
    if ((f.status === "SIGNED" || f.status === "MISMATCH" || f.status === "NEEDS_RESIGN") && docId) {
      // Exactly the Documents tab's rule: the same secure link, re-checked (and logged) when opened.
      const token = downloadToken(docId, { staffId: viewer.id });
      if (await authorizeDownload(token, { staffId: viewer.id })) statusHref = `/api/documents/${token}`;
      else {
        statusHref = null;
        noAccess = true;
      }
    }
    rows.set(s.clientId, {
      clientId: s.clientId, clientName: s.client.displayName, taxYear, clientHref: panel, statusHref, noAccess,
      recordsHref: `/clients/${s.clientId}?tab=documents#docs-TAXES-${taxYear}`, signedOn: f.signedAt ? new Date(f.signedAt) : null, summary,
      form8879: { code: f.status, label: F8879_LABEL[f.status], date: f.status === "SIGNED" || f.status === "MISMATCH" ? (f.signedAt ? new Date(f.signedAt) : null) : f.status === "SENT" && f.sentAt ? new Date(f.sentAt) : null },
      lastChange: new Date(Math.max(...dates.map((d) => d.getTime()))),
      needsAction: false, href: `/clients/${s.clientId}?tab=taxes`,
    });
  }
  // A held upload newer than the client's summary shows as Held.
  const seen = new Set<string>();
  for (const e of events) {
    if (!e.clientId || seen.has(e.clientId)) continue;
    seen.add(e.clientId);
    if (e.action !== "tax.auto_summary_held") continue;
    const ev = eventOf(e);
    if (ev.kind !== "CHECKS_FAILED") continue;
    const row = rows.get(e.clientId);
    if (row && row.lastChange > e.createdAt) continue;
    const client = row?.clientName ?? (await prisma.client.findUnique({ where: { id: e.clientId }, select: { displayName: true } }))?.displayName ?? "Client";
    rows.set(e.clientId, {
      ...(row ?? { statusHref: null, noAccess: false, signedOn: null }),
      clientId: e.clientId, clientName: client, taxYear, clientHref: `/clients/${e.clientId}?tab=taxes#auto-summary-${taxYear}`, recordsHref: `/clients/${e.clientId}?tab=documents#docs-TAXES-${taxYear}`,
      summary: { code: "HELD", label: "Held", reason: ev.issues[0]?.message ?? "Couldn't be read" },
      form8879: row?.form8879 ?? { code: "NONE", label: F8879_LABEL.NONE, date: null },
      lastChange: e.createdAt, needsAction: true, href: `/clients/${e.clientId}?tab=taxes`,
    });
  }
  const rank = (r: TrackerRow) => {
    const action = ["HELD", "READY", "QUESTIONS"].includes(r.summary.code) || ["WAITING", "NEEDS_RESIGN", "MISMATCH"].includes(r.form8879.code);
    r.needsAction = action;
    return action ? 0 : 1;
  };
  const list = [...rows.values()].sort((a, b) => rank(a) - rank(b) || b.lastChange.getTime() - a.lastChange.getTime());
  const match: Record<TrackerFilter, (r: TrackerRow) => boolean> = {
    ALL: () => true, ACTION: (r) => r.needsAction,
    HELD: (r) => r.summary.code === "HELD", READY: (r) => r.summary.code === "READY", SENT: (r) => r.summary.code === "SENT", QUESTIONS: (r) => r.summary.code === "QUESTIONS", APPROVED: (r) => r.summary.code === "APPROVED",
    "8879_WAITING": (r) => r.form8879.code === "WAITING", "8879_SENT": (r) => r.form8879.code === "SENT", "8879_SIGNED": (r) => r.form8879.code === "SIGNED", "8879_RESIGN": (r) => r.form8879.code === "NEEDS_RESIGN", "8879_MISMATCH": (r) => r.form8879.code === "MISMATCH",
  };
  return list.filter(match[filter] ?? match.ALL);
}
