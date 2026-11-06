import "server-only";
import type { Prisma, TaxSummaryItem } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { extractPdf, samePayer, type Amount, type ExtractedItem } from "@/lib/tax/extract";
import { ValidationError } from "./clients";
import { readDocumentBytes, staffUploadDocument } from "./documents";

/**
 * Line items on a Tax Return Summary — every W-2, 1099, Schedule C,
 * deduction and credit shown individually — and their reconciliation.
 *
 * Two sources are kept apart on each item:
 *   documentAmounts — read from what the client uploaded (W-2, 1099…)
 *   returnAmounts   — as entered on the prepared return / TaxAct detail
 * An amount on an uploaded document is NEVER assumed to be on the return.
 * Statuses: NEEDS_REVIEW, MISSING (on a document, not found on the return),
 * MISMATCH (document ≠ return), VERIFIED (staff checked it against the
 * return), EXCLUDED (staff: not part of this return, with a reason).
 * Only VERIFIED items reach the client.
 */

export const ITEM_STATUS = {
  VERIFIED: { label: "Verified", tone: "green" },
  NEEDS_REVIEW: { label: "Needs review", tone: "gold" },
  MISSING: { label: "Missing from return", tone: "red" },
  MISMATCH: { label: "Mismatch", tone: "red" },
  EXCLUDED: { label: "Excluded", tone: "gray" },
} as const;
export const OPEN_ITEM = ["NEEDS_REVIEW", "MISSING", "MISMATCH"];

export { FORM_LABELS } from "@/lib/tax/form-labels";
const NOT_TAX_SOURCES: ("IDENTITY" | "BOOKKEEPING" | "CONTRACTS")[] = ["IDENTITY", "BOOKKEEPING", "CONTRACTS"];
const TAX_FORM_DOC_TYPES = ["W2", "W-2", "1099", "1099-R", "1099-NEC", "1099-MISC", "1099-INT", "1099-DIV", "1099-K", "1099-G", "SSA-1099", "1098", "1098-T", "1098-E"];
const SECTIONS = ["INCOME", "ADJUSTMENT", "DEDUCTION", "CREDIT", "PAYMENT", "OTHER"];

const amountsOf = (j: unknown) => (Array.isArray(j) ? (j as Amount[]) : []);
const json = (a: Amount[] | null | undefined) => (a ? (a as unknown as Prisma.InputJsonValue) : undefined);
const fmt = (c: number) => (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

/** Equal on every box both sides have; null when there's nothing to compare. */
export function compareAmounts(doc: Amount[], ret: Amount[]) {
  const common = doc.filter((d) => ret.some((r) => r.key === d.key));
  if (!common.length) return null;
  const diffs = common.filter((d) => ret.find((r) => r.key === d.key)!.cents !== d.cents).map((d) => ({ label: d.label, doc: d.cents, ret: ret.find((r) => r.key === d.key)!.cents }));
  return { equal: diffs.length === 0, diffs };
}

async function draft(summaryId: string) {
  const s = await prisma.taxReturnSummary.findUnique({ where: { id: summaryId } });
  if (!s) throw new ValidationError("Summary not found.");
  if (s.status !== "DRAFT") throw new ValidationError("This summary was already sent, so its items are locked. Use “Revise figures” to make a new version.");
  // An automatic summary holds exactly what was read from the return: rebuild it by uploading the return again.
  if ((s.returnTotals as { autoSummary?: unknown } | null)?.autoSummary) throw new ValidationError("This is an automatic summary read from the uploaded return. Its items can't be edited by hand; upload the corrected return to rebuild it.");
  return s;
}
async function itemInDraft(itemId: string) {
  const it = await prisma.taxSummaryItem.findUnique({ where: { id: itemId } });
  if (!it) throw new ValidationError("Item not found.");
  await draft(it.summaryId);
  return it;
}

// --- Prepared return + extraction ------------------------------------------------------

/** Stores the prepared return PDF from TaxAct (staff only — never delivered from here) and reads it. */
export async function attachPreparedReturn(actor: Actor, summaryId: string, bytes: Uint8Array, originalName: string) {
  const s = await draft(summaryId);
  const doc = await staffUploadDocument(actor, { clientId: s.clientId, category: "TAXES", title: `${s.taxYear} prepared return (TaxAct) — staff reference, not for delivery`, year: s.taxYear, visibility: "STAFF_ONLY", bytes, originalName, notify: false });
  await prisma.taxReturnSummary.update({ where: { id: summaryId }, data: { returnDocumentId: doc.id } });
  await audit(prisma, { actorId: actor.id, action: "tax.summary_return_attached", entityType: "TaxReturnSummary", entityId: summaryId, clientId: s.clientId, details: { documentId: doc.id } });
  return runExtraction(actor, summaryId);
}

async function readDoc(documentId: string) {
  const d = await prisma.document.findUnique({ where: { id: documentId }, include: { file: true } });
  if (!d || d.deletedAt || d.scanStatus === "INFECTED") return null;
  if (d.file.mimeType !== "application/pdf") return { d, result: null as Awaited<ReturnType<typeof extractPdf>> | null, image: true };
  const bytes = await readDocumentBytes(d.file);
  return { d, result: bytes ? await extractPdf(bytes) : null, image: false };
}

/**
 * Reads the prepared return and the client's uploaded tax documents for the
 * year, then reconciles them. Re-running keeps anything staff verified,
 * edited, excluded or added; it replaces only untouched extracted proposals.
 */
export async function runExtraction(actor: Actor, summaryId: string) {
  const s = await draft(summaryId);
  await prisma.taxSummaryItem.deleteMany({ where: { summaryId, source: { not: "STAFF" }, verifiedById: null, note: null, status: { in: OPEN_ITEM } } });
  const kept = await prisma.taxSummaryItem.findMany({ where: { summaryId } });
  const created: TaxSummaryItem[] = [];
  let order = kept.length;
  const add = async (data: Omit<Prisma.TaxSummaryItemUncheckedCreateInput, "summaryId">) => {
    const it = await prisma.taxSummaryItem.create({ data: { ...data, summaryId, sortOrder: order++ } });
    created.push(it);
    return it;
  };
  const alreadyKept = (formType: string, payer: string, documentId?: string | null) =>
    kept.some((k) => k.formType === formType && samePayer(k.payerName, payer) && (!documentId || !k.sourceDocumentId || k.sourceDocumentId === documentId));

  // 1. The prepared return: per-payer detail where printed, plus Form 1040 lines.
  let detailForms: string[] = [];
  const totalsUpdate: Prisma.TaxReturnSummaryUpdateInput = {};
  if (s.returnDocumentId) {
    const r = await readDoc(s.returnDocumentId);
    if (!r?.result?.readable) {
      await setCheck(summaryId, "RETURN_UNREADABLE", "BLOCKING", r?.result?.reason ?? "The prepared return PDF couldn't be read. Enter each item from TaxAct and verify it.");
    } else {
      await clearCheck(summaryId, "RETURN_UNREADABLE");
      const res = r.result;
      detailForms = res.detailForms;
      for (const it of res.items) {
        if (alreadyKept(it.formType, it.payerName)) continue;
        await add({ section: it.section, formType: it.formType, payerName: it.payerName, returnAmounts: json(it.amounts), source: "RETURN", sourceDocumentId: s.returnDocumentId, sourcePage: it.page, evidence: it.evidence, status: "NEEDS_REVIEW", note: it.incomplete.length ? `Not found on the return page: ${it.incomplete.join(", ")}` : null });
      }
      const L = res.returnLines;
      totalsUpdate.returnTotals = L as Prisma.InputJsonValue;
      // Totals are filled only where nothing was entered, and must be confirmed.
      const fill = (field: "wagesCents" | "totalIncomeCents" | "agiCents" | "deductionCents" | "taxableIncomeCents", v: number | undefined) => {
        if (v !== undefined && !s[field]) (totalsUpdate as Record<string, number>)[field] = v;
      };
      fill("wagesCents", L.wages ?? L.w2Wages);
      fill("totalIncomeCents", L.totalIncome);
      fill("agiCents", L.agi);
      fill("deductionCents", L.deduction);
      fill("taxableIncomeCents", L.taxableIncome);
      if (!s.federalResultCents && (L.refund !== undefined || L.owed !== undefined)) totalsUpdate.federalResultCents = (L.refund ?? 0) - (L.owed ?? 0);
      if (!s.depositAccountLast4 && res.deposit?.accountLast4) {
        totalsUpdate.depositAccountLast4 = res.deposit.accountLast4;
        totalsUpdate.depositRoutingLast4 = res.deposit.routingLast4;
      }
      if (Object.keys(L).length) await setCheck(summaryId, "TOTALS_FROM_RETURN", "BLOCKING", `Read ${Object.keys(L).length} line(s) from Form 1040. Confirm the totals (wages, total income, AGI, deduction, taxable income, refund/owed) against TaxAct.`);
      else await setCheck(summaryId, "TOTALS_NOT_FOUND", "BLOCKING", "No Form 1040 lines could be read from the prepared return. Enter the totals from TaxAct.");
    }
  } else {
    await setCheck(summaryId, "RETURN_PDF_MISSING", "BLOCKING", "Upload the prepared return PDF from TaxAct — every item is checked against it.");
  }
  if (Object.keys(totalsUpdate).length) await prisma.taxReturnSummary.update({ where: { id: summaryId }, data: totalsUpdate });

  // 2. The client's uploaded tax documents for the year.
  const docs = await prisma.document.findMany({
    // Every intake source for the year — portal uploads (Client Uploads), Jotform and staff
    // filings (Taxes), anything filed as Other. Only identity, bookkeeping and contracts are out.
    where: { clientId: s.clientId, year: s.taxYear, category: { notIn: NOT_TAX_SOURCES }, deletedAt: null, filingDocType: null, id: { not: s.returnDocumentId ?? "" } },
    select: { id: true, title: true },
  });
  const returnItems = () => [...kept, ...created].filter((i) => i.returnAmounts && i.source !== "DOCUMENT");
  for (const doc of docs) {
    if (kept.some((k) => k.sourceDocumentId === doc.id) || created.some((c) => c.sourceDocumentId === doc.id)) continue;
    const r = await readDoc(doc.id);
    if (!r) continue;
    if (r.image || !r.result?.readable) {
      await add({ section: "OTHER", formType: "UNREADABLE", payerName: doc.title, source: "DOCUMENT", sourceDocumentId: doc.id, status: "NEEDS_REVIEW", note: r.image ? "Photo/image upload — figures can't be read automatically. Open it, enter the item, and verify it against the return." : r.result?.reason ?? "Couldn't be read." });
      continue;
    }
    const found = r.result.items.filter((i) => !["SCH-C"].includes(i.formType));
    if (!found.length) {
      await add({ section: "OTHER", formType: "UNREADABLE", payerName: doc.title, source: "DOCUMENT", sourceDocumentId: doc.id, status: "NEEDS_REVIEW", note: "Text was readable but no supported tax form was recognized. Review it and enter any item manually." });
      continue;
    }
    for (const it of found) await placeDocumentItem(it, doc.id, returnItems(), detailForms, add);
  }
  // Tax forms with no tax year can't be placed on any return: someone must decide.
  const undated = await prisma.document.findMany({ where: { clientId: s.clientId, year: null, category: { notIn: NOT_TAX_SOURCES }, deletedAt: null, filingDocType: null, OR: [{ docType: { in: TAX_FORM_DOC_TYPES } }, { title: { contains: "W-2", mode: "insensitive" } }, { title: { contains: "1099", mode: "insensitive" } }] }, select: { title: true } });
  if (undated.length) await setCheck(summaryId, "UNDATED_TAX_DOCS", "BLOCKING", `${undated.length} tax document(s) have no tax year (${undated.slice(0, 3).map((d) => d.title).join(", ")}${undated.length > 3 ? "…" : ""}). Assign the year in the client's Documents so they're reconciled, or confirm they don't belong to ${s.taxYear}.`);
  else await clearCheck(summaryId, "UNDATED_TAX_DOCS");
  await prisma.taxReturnSummary.update({ where: { id: summaryId }, data: { extractedAt: new Date() } });
  await reconcile(summaryId);
  await audit(prisma, { actorId: actor.id, action: "tax.summary_extracted", entityType: "TaxReturnSummary", entityId: summaryId, clientId: s.clientId, details: { created: created.length, documents: docs.length } });
  return { created: created.length, documents: docs.length };
}

async function placeDocumentItem(
  it: ExtractedItem,
  documentId: string,
  returnItems: TaxSummaryItem[],
  detailForms: string[],
  add: (d: Omit<Prisma.TaxSummaryItemUncheckedCreateInput, "summaryId">) => Promise<TaxSummaryItem>,
) {
  const match = returnItems.find((r) => r.formType === it.formType && samePayer(r.payerName, it.payerName) && !r.documentAmounts);
  const missingFields = it.incomplete.length ? `Couldn't read from the document: ${it.incomplete.join(", ")}.` : null;
  if (match) {
    const cmp = compareAmounts(it.amounts, amountsOf(match.returnAmounts));
    const status = cmp && !cmp.equal ? "MISMATCH" : "NEEDS_REVIEW";
    const note = [cmp && !cmp.equal ? `Document vs return: ${cmp.diffs.map((d) => `${d.label} ${fmt(d.doc)} vs ${fmt(d.ret)}`).join("; ")}` : cmp ? "Document matches the return — verify." : "No common boxes to compare.", missingFields].filter(Boolean).join(" ");
    await prisma.taxSummaryItem.update({ where: { id: match.id }, data: { documentAmounts: json(it.amounts), source: "BOTH", status, note: match.note ? `${match.note} ${note}` : note } });
    match.documentAmounts = it.amounts as never;
    return;
  }
  // No matching entry read from the return: never assume it was included.
  const detail = detailForms.includes(it.formType);
  await add({
    section: it.section, formType: it.formType, payerName: it.payerName, documentAmounts: json(it.amounts), source: "DOCUMENT", sourceDocumentId: documentId, sourcePage: it.page, evidence: it.evidence,
    status: detail ? "MISSING" : "NEEDS_REVIEW",
    note: [detail ? "This uploaded document was not found on the prepared return." : `The prepared return PDF has no per-payer detail for ${it.formType}. Confirm in TaxAct that it was entered, then enter the amounts as reported.`, missingFields].filter(Boolean).join(" "),
  });
}

// --- Reconciliation checks ----------------------------------------------------------------

async function setCheck(summaryId: string, code: string, severity: "BLOCKING" | "WARNING", message: string) {
  const ex = await prisma.taxSummaryCheck.findUnique({ where: { summaryId_code: { summaryId, code } } });
  if (!ex) await prisma.taxSummaryCheck.create({ data: { summaryId, code, severity, message } });
  // New numbers → the earlier resolution no longer applies.
  else if (ex.message !== message) await prisma.taxSummaryCheck.update({ where: { id: ex.id }, data: { message, severity, resolvedAt: null, resolvedById: null, resolutionNote: null } });
}
async function clearCheck(summaryId: string, code: string) {
  await prisma.taxSummaryCheck.deleteMany({ where: { summaryId, code } });
}

const sumKey = (items: TaxSummaryItem[], forms: string[], key: string) =>
  items.filter((i) => forms.includes(i.formType) && i.status !== "EXCLUDED").reduce((n, i) => n + (amountsOf(i.returnAmounts).find((a) => a.key === key)?.cents ?? 0), 0);

/** Item totals vs Form 1040 lines; a return line with no item detail is flagged. */
export async function reconcile(summaryId: string) {
  const s = await prisma.taxReturnSummary.findUniqueOrThrow({ where: { id: summaryId }, include: { items: true } });
  if (s.returnDocumentId) await clearCheck(summaryId, "RETURN_PDF_MISSING");
  const L = (s.returnTotals ?? {}) as Record<string, number>;
  const items = s.items;
  const rules: { code: string; line?: number; got: number; forms: string[]; what: string; severity?: "BLOCKING" | "WARNING" }[] = [
    { code: "W2_WAGES", line: L.w2Wages ?? L.wages, got: sumKey(items, ["W-2"], "wages"), forms: ["W-2"], what: "W-2 wages vs Form 1040 line 1a" },
    { code: "W2_WITHHOLDING", line: L.w2Withholding, got: sumKey(items, ["W-2"], "fedWithheld"), forms: ["W-2"], what: "W-2 federal withholding vs line 25a" },
    {
      code: "1099_WITHHOLDING", line: L.form1099Withholding,
      got: ["1099-R", "1099-NEC", "1099-MISC", "1099-INT", "1099-DIV", "1099-G", "SSA-1099"].reduce((n, f) => n + sumKey(items, [f], "fedWithheld"), 0),
      forms: ["1099-R", "1099-NEC", "1099-MISC", "1099-INT", "1099-DIV", "1099-G", "SSA-1099"], what: "1099 federal withholding vs line 25b",
    },
    { code: "RETIREMENT_TAXABLE", line: L.iraTaxable !== undefined || L.pensionsTaxable !== undefined ? (L.iraTaxable ?? 0) + (L.pensionsTaxable ?? 0) : undefined, got: sumKey(items, ["1099-R"], "taxable"), forms: ["1099-R"], what: "1099-R taxable amounts vs lines 4b + 5b" },
    { code: "INTEREST", line: L.taxableInterest, got: sumKey(items, ["1099-INT"], "interest"), forms: ["1099-INT"], what: "Interest vs line 2b", severity: "WARNING" },
    { code: "DIVIDENDS", line: L.ordinaryDividends, got: sumKey(items, ["1099-DIV"], "ordinary"), forms: ["1099-DIV"], what: "Ordinary dividends vs line 3b", severity: "WARNING" },
  ];
  for (const r of rules) {
    const hasItems = items.some((i) => r.forms.includes(i.formType) && i.status !== "EXCLUDED");
    if (r.line === undefined || (r.line === 0 && !hasItems)) {
      await clearCheck(summaryId, r.code);
      continue;
    }
    if (!hasItems) await setCheck(summaryId, r.code, "BLOCKING", `${r.what}: the return shows ${fmt(r.line)} but no ${r.forms[0]} item is listed. Add the missing item(s).`);
    else if (r.got !== r.line) await setCheck(summaryId, r.code, r.severity ?? "BLOCKING", `${r.what}: items total ${fmt(r.got)}, the return shows ${fmt(r.line)}.`);
    else await clearCheck(summaryId, r.code);
  }
  if (L.ssTaxable !== undefined && L.ssTaxable > 0 && !items.some((i) => i.formType === "SSA-1099" && i.status !== "EXCLUDED")) {
    await setCheck(summaryId, "SSA_MISSING", "BLOCKING", `The return shows taxable Social Security of ${fmt(L.ssTaxable)} but no SSA-1099 item is listed.`);
  } else await clearCheck(summaryId, "SSA_MISSING");
}

// --- Staff edits (audited) --------------------------------------------------------------

export type ItemInput = { section: string; formType: string; payerName: string; recipient: string; returnAmounts: Amount[]; note?: string | null };

function cleanItem(i: ItemInput) {
  if (!SECTIONS.includes(i.section)) throw new ValidationError("Choose the section (income, adjustment, deduction, credit…).");
  if (!i.formType.trim()) throw new ValidationError("Choose the document type.");
  if (i.payerName.trim().length < 2) throw new ValidationError("Enter the payer, employer or description.");
  if (!["TAXPAYER", "SPOUSE", "JOINT"].includes(i.recipient)) throw new ValidationError("Choose whose item it is.");
  const amounts = i.returnAmounts.filter((a) => a.label.trim() && Number.isInteger(a.cents));
  if (!amounts.length) throw new ValidationError("Enter at least one amount as reported on the return.");
  return { section: i.section, formType: i.formType.trim().toUpperCase().replace(/^SCHEDULE C$/, "SCH-C"), payerName: i.payerName.trim().slice(0, 120), recipient: i.recipient, returnAmounts: amounts.map((a) => ({ key: a.key || a.label.toLowerCase().replace(/[^a-z0-9]+/g, "_"), label: a.label.trim(), cents: a.cents })) };
}

export async function addItem(actor: Actor, summaryId: string, input: ItemInput) {
  const s = await draft(summaryId);
  const data = cleanItem(input);
  const count = await prisma.taxSummaryItem.count({ where: { summaryId } });
  const it = await prisma.taxSummaryItem.create({ data: { ...data, returnAmounts: json(data.returnAmounts), summaryId, source: "STAFF", status: "NEEDS_REVIEW", note: input.note?.trim() || "Entered by staff from TaxAct.", sortOrder: count } });
  await audit(prisma, { actorId: actor.id, action: "tax.summary_item_added", entityType: "TaxSummaryItem", entityId: it.id, clientId: s.clientId, details: { summaryId, ...data } });
  await reconcile(summaryId);
  return it;
}

/** Correct an entry (as reported on the return). The before/after is audited, and the item must be verified again. */
export async function updateItem(actor: Actor, itemId: string, input: ItemInput, reason: string) {
  const before = await itemInDraft(itemId);
  if (reason.trim().length < 3) throw new ValidationError("Say why the entry is being corrected.");
  const data = cleanItem(input);
  const cmp = before.documentAmounts ? compareAmounts(amountsOf(before.documentAmounts), data.returnAmounts) : null;
  const status = cmp && !cmp.equal ? "MISMATCH" : "NEEDS_REVIEW";
  await prisma.taxSummaryItem.update({ where: { id: itemId }, data: { ...data, returnAmounts: json(data.returnAmounts), status, verifiedById: null, verifiedAt: null, note: `Corrected by staff: ${reason.trim()}`.slice(0, 500) } });
  const s = await prisma.taxReturnSummary.findUniqueOrThrow({ where: { id: before.summaryId } });
  await audit(prisma, {
    actorId: actor.id, action: "tax.summary_item_corrected", entityType: "TaxSummaryItem", entityId: itemId, clientId: s.clientId,
    details: { reason: reason.trim(), before: { formType: before.formType, payerName: before.payerName, recipient: before.recipient, returnAmounts: before.returnAmounts }, after: data },
  });
  await reconcile(before.summaryId);
}

/**
 * Staff confirm the entry against the prepared return. When the client's
 * document differs from the return, the reason must be written down.
 */
export async function verifyItem(actor: Actor, itemId: string, note?: string | null) {
  const it = await itemInDraft(itemId);
  const ret = amountsOf(it.returnAmounts);
  if (it.formType === "UNREADABLE") throw new ValidationError("Enter this document as an item (type, payer and amounts) first, then verify it.");
  if (!ret.length) throw new ValidationError("Enter the amounts as reported on the return before verifying (Correct entry).");
  if (/^unknown payer$/i.test(it.payerName)) throw new ValidationError("Enter the payer or employer name first.");
  const cmp = it.documentAmounts ? compareAmounts(amountsOf(it.documentAmounts), ret) : null;
  if (cmp && !cmp.equal && !note?.trim()) throw new ValidationError("The client's document differs from the return. Write down why (e.g. corrected W-2 received) to verify.");
  await prisma.taxSummaryItem.update({ where: { id: itemId }, data: { status: "VERIFIED", verifiedById: actor.id, verifiedAt: new Date(), ...(note?.trim() ? { note: note.trim().slice(0, 500) } : {}) } });
  const s = await prisma.taxReturnSummary.findUniqueOrThrow({ where: { id: it.summaryId } });
  await audit(prisma, { actorId: actor.id, action: "tax.summary_item_verified", entityType: "TaxSummaryItem", entityId: itemId, clientId: s.clientId, details: { note: note ?? null, documentDiffers: !!(cmp && !cmp.equal) } });
  await reconcile(it.summaryId);
}

/** Not part of this return (e.g. duplicate upload, belongs to another year) — with a reason. */
export async function excludeItem(actor: Actor, itemId: string, reason: string) {
  const it = await itemInDraft(itemId);
  if (reason.trim().length < 3) throw new ValidationError("Say why this isn't part of the return.");
  await prisma.taxSummaryItem.update({ where: { id: itemId }, data: { status: "EXCLUDED", onReturn: false, verifiedById: actor.id, verifiedAt: new Date(), note: `Excluded: ${reason.trim()}`.slice(0, 500) } });
  const s = await prisma.taxReturnSummary.findUniqueOrThrow({ where: { id: it.summaryId } });
  await audit(prisma, { actorId: actor.id, action: "tax.summary_item_excluded", entityType: "TaxSummaryItem", entityId: itemId, clientId: s.clientId, details: { reason: reason.trim(), formType: it.formType, payerName: it.payerName } });
  await reconcile(it.summaryId);
}

export async function resolveCheck(actor: Actor, checkId: string, note: string) {
  const c = await prisma.taxSummaryCheck.findUnique({ where: { id: checkId } });
  if (!c) throw new ValidationError("Check not found.");
  // Automatic-summary checks clear only by Tabitha's "Send for approval" or a corrected upload.
  if (c.code.startsWith("AUTO_")) throw new ValidationError("This check belongs to the automatic summary and can't be resolved by hand.");
  const s = await draft(c.summaryId);
  if (note.trim().length < 3) throw new ValidationError("Write how it was resolved.");
  await prisma.taxSummaryCheck.update({ where: { id: checkId }, data: { resolvedAt: new Date(), resolvedById: actor.id, resolutionNote: note.trim().slice(0, 500) } });
  await audit(prisma, { actorId: actor.id, action: "tax.summary_check_resolved", entityType: "TaxSummaryCheck", entityId: checkId, clientId: s.clientId, details: { code: c.code, note: note.trim() } });
}

/** What still blocks sending: open items and unresolved blocking checks. */
export async function sendBlockers(summaryId: string) {
  const [items, checks, s] = await Promise.all([
    prisma.taxSummaryItem.findMany({ where: { summaryId, status: { in: OPEN_ITEM } }, select: { formType: true, payerName: true, status: true } }),
    prisma.taxSummaryCheck.findMany({ where: { summaryId, severity: "BLOCKING", resolvedAt: null } }),
    prisma.taxReturnSummary.findUniqueOrThrow({ where: { id: summaryId }, select: { returnDocumentId: true } }),
  ]);
  const out: string[] = [];
  if (!s.returnDocumentId) out.push("Upload the prepared return PDF from TaxAct.");
  if (items.length) out.push(`${items.length} item(s) still need staff verification: ${items.slice(0, 4).map((i) => `${i.formType} ${i.payerName} (${ITEM_STATUS[i.status as keyof typeof ITEM_STATUS].label})`).join("; ")}${items.length > 4 ? "…" : ""}`);
  for (const c of checks) out.push(c.message);
  return out;
}
