import "server-only";
import { createHash } from "node:crypto";
import type { Prisma, TaxReturnSummary, TaxSummaryItem } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import type { PortalActor } from "@/lib/portal/session";
import { requireClientAccess } from "@/lib/portal/access";
import { BUSINESS_RETURN } from "@/lib/tax/accepted";
import { ValidationError } from "./clients";
import { isReportApprover } from "./bookkeeping-clients";
import { queuePortalNotification } from "./notifications";

/**
 * Tax Return Summary & Approval — the stage BEFORE filing.
 *
 * 1. The office prepares the return in TaxAct and enters its key figures here.
 * 2. The summary is sent to the client's portal (with an email notice that
 *    only says something is waiting — never figures).
 * 3. The client approves it for filing with an electronic signature, or
 *    requests changes. A joint return also needs the spouse's own signature.
 * 4. Requested changes put the summary on hold until the office sends an
 *    updated version. Any change to the figures is a new version and
 *    invalidates every earlier approval.
 * 5. Approved → "Client approved — ready for owner filing". Only Tabitha
 *    submits through TaxAct; approval never files anything.
 *
 * This approval does not replace Form 8879 or any state e-file
 * authorization; those are obtained and kept separately.
 */

export const FILING_STATUSES = {
  SINGLE: "Single",
  MFJ: "Married filing jointly",
  MFS: "Married filing separately",
  HOH: "Head of household",
  QSS: "Qualifying surviving spouse",
} as const;
export type FilingStatusCode = keyof typeof FILING_STATUSES;

export const SUMMARY_STATUS = {
  DRAFT: { label: "Draft (office only)", tone: "gray" },
  SENT: { label: "Sent — waiting for client approval", tone: "gold" },
  CHANGES_REQUESTED: { label: "On hold — client requested changes", tone: "red" },
  CLIENT_APPROVED: { label: "Client approved — ready for owner filing", tone: "green" },
  SUPERSEDED: { label: "Replaced by a newer version", tone: "gray" },
  WITHDRAWN: { label: "Withdrawn", tone: "gray" },
} as const;

export const NOT_8879 =
  "This summary approval does not replace IRS Form 8879 (IRS e-file Signature Authorization) or any required state e-file authorization. Those are signed and kept separately.";

export const consentText = (role: "TAXPAYER" | "SPOUSE", name: string, year: number) =>
  `I, ${name}, have reviewed this ${year} tax return summary. To the best of my knowledge the information is correct and complete, and I approve T. Turner & Associates to file my ${year} tax return based on it. I understand that typing my name below is my electronic signature${role === "SPOUSE" ? " as the spouse on this joint return" : ""}, and that this does not replace IRS Form 8879 or any state e-file authorization.`;

export type StateResult = { state: string; resultCents: number };
export type Dependent = { name: string; relationship: string };
export type SummaryInput = {
  clientId: string;
  taxYear: number;
  filingType?: "ORIGINAL" | "AMENDED";
  filingStatus: string;
  taxpayerName: string;
  spouseName?: string | null;
  dependents: Dependent[];
  wagesCents: number;
  otherIncomeCents: number;
  totalIncomeCents: number;
  agiCents: number;
  deductionType: string;
  deductionCents: number;
  taxableIncomeCents: number;
  federalResultCents: number;
  stateResults: StateResult[];
  depositBankName?: string | null;
  depositAccountType?: string | null;
  depositRoutingLast4?: string | null;
  depositAccountLast4?: string | null;
  officeNote?: string | null;
};

const ACTIVE = ["DRAFT", "SENT", "CHANGES_REQUESTED", "CLIENT_APPROVED"] as const;
const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z]/g, "");
const needsSpouse = (s: { filingStatus: string }) => s.filingStatus === "MFJ";

function clean(input: SummaryInput) {
  const thisYear = new Date().getFullYear();
  if (!Number.isInteger(input.taxYear) || input.taxYear < 2000 || input.taxYear > thisYear) throw new ValidationError("Choose the tax year.");
  if (!(input.filingStatus in FILING_STATUSES)) throw new ValidationError("Choose the filing status.");
  const taxpayerName = input.taxpayerName.trim();
  if (taxpayerName.length < 2) throw new ValidationError("Enter the taxpayer's name as it appears on the return.");
  const spouseName = input.spouseName?.trim() || null;
  if (input.filingStatus === "MFJ" && !spouseName) throw new ValidationError("A joint return needs the spouse's name.");
  for (const k of ["wagesCents", "otherIncomeCents", "totalIncomeCents", "agiCents", "deductionCents", "taxableIncomeCents", "federalResultCents"] as const) {
    if (!Number.isInteger(input[k])) throw new ValidationError("Enter every amount as dollars and cents.");
  }
  for (const k of ["wagesCents", "totalIncomeCents", "deductionCents", "taxableIncomeCents"] as const) {
    if (input[k] < 0) throw new ValidationError("Wages, total income, deductions and taxable income can't be negative.");
  }
  if (input.deductionType !== "STANDARD" && input.deductionType !== "ITEMIZED") throw new ValidationError("Choose standard or itemized deductions.");
  const stateResults = input.stateResults.map((s) => ({ state: s.state.trim().toUpperCase(), resultCents: s.resultCents }));
  for (const s of stateResults) {
    if (!/^[A-Z]{2}$/.test(s.state) || !Number.isInteger(s.resultCents)) throw new ValidationError("Each state needs its two-letter code and its refund or amount owed.");
  }
  if (new Set(stateResults.map((s) => s.state)).size !== stateResults.length) throw new ValidationError("Each state can be listed once.");
  const dependents = input.dependents.map((d) => ({ name: d.name.trim(), relationship: d.relationship.trim() })).filter((d) => d.name);
  const last4 = (v: string | null | undefined, label: string) => {
    const t = (v ?? "").replace(/\D/g, "");
    if (!t) return null;
    // Only the last four digits are ever stored or shown.
    if (t.length < 4) throw new ValidationError(`Enter at least the last four digits of the ${label}.`);
    return t.slice(-4);
  };
  const depositRoutingLast4 = last4(input.depositRoutingLast4, "routing number");
  const depositAccountLast4 = last4(input.depositAccountLast4, "account number");
  const depositAccountType = input.depositAccountType === "CHECKING" || input.depositAccountType === "SAVINGS" ? input.depositAccountType : null;
  const hasDeposit = !!(depositRoutingLast4 || depositAccountLast4);
  if (hasDeposit && !(depositRoutingLast4 && depositAccountLast4 && depositAccountType)) throw new ValidationError("For direct deposit, enter the account type and the last four digits of both the routing and account numbers.");
  const data = {
    clientId: input.clientId,
    taxYear: input.taxYear,
    filingType: input.filingType === "AMENDED" ? "AMENDED" : "ORIGINAL",
    filingStatus: input.filingStatus,
    taxpayerName,
    // Spouse details appear only on a joint or separate return; never assumed.
    spouseName: input.filingStatus === "MFJ" || input.filingStatus === "MFS" ? spouseName : null,
    dependents,
    wagesCents: input.wagesCents,
    otherIncomeCents: input.otherIncomeCents,
    totalIncomeCents: input.totalIncomeCents,
    agiCents: input.agiCents,
    deductionType: input.deductionType,
    deductionCents: input.deductionCents,
    taxableIncomeCents: input.taxableIncomeCents,
    federalResultCents: input.federalResultCents,
    stateResults,
    depositBankName: hasDeposit ? input.depositBankName?.trim() || null : null,
    depositAccountType: hasDeposit ? depositAccountType : null,
    depositRoutingLast4,
    depositAccountLast4,
    officeNote: input.officeNote?.trim().slice(0, 1000) || null,
  };
  return { ...data, figuresHash: figuresHash(data) };
}

const FIGURE_KEYS = [
  "clientId", "taxYear", "filingType", "filingStatus", "taxpayerName", "spouseName", "dependents", "wagesCents", "otherIncomeCents", "totalIncomeCents", "agiCents",
  "deductionType", "deductionCents", "taxableIncomeCents", "federalResultCents", "stateResults", "depositBankName", "depositAccountType", "depositRoutingLast4", "depositAccountLast4",
] as const;
const canon = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v ?? null;

type HashItem = { id: string; status: string; section: string; formType: string; payerName: string; recipient: string; returnAmounts: unknown; sortOrder: number };
/** Hash of everything the client approves — totals and every verified item; a signature is only valid for the hash it signed. */
export function figuresHash(s: Record<string, unknown>, items: HashItem[] = []) {
  const verified = items
    .filter((i) => i.status === "VERIFIED")
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
    .map((i) => canon({ section: i.section, formType: i.formType, payerName: i.payerName, recipient: i.recipient, returnAmounts: i.returnAmounts }));
  return createHash("sha256").update(JSON.stringify([...FIGURE_KEYS.map((k) => [k, canon(s[k])]), ["items", verified]])).digest("hex");
}

async function loadSummary(id: string) {
  const s = await prisma.taxReturnSummary.findUnique({ where: { id }, include: { signatures: true, items: true } });
  if (!s) throw new ValidationError("Summary not found.");
  return s;
}

/** The office enters the figures from the return prepared in TaxAct. Starts as a Draft. */
export async function createSummary(actor: Actor, input: SummaryInput) {
  const client = await prisma.client.findUnique({ where: { id: input.clientId } });
  if (!client || client.archivedAt) throw new ValidationError("Client not found.");
  const data = clean(input);
  const open = await prisma.taxReturnSummary.findFirst({ where: { clientId: data.clientId, taxYear: data.taxYear, filingType: data.filingType, status: { in: [...ACTIVE] } } });
  if (open) throw new ValidationError(`There is already a ${data.taxYear} summary for this client (${SUMMARY_STATUS[open.status].label}). Edit or revise that one.`);
  const s = await prisma.taxReturnSummary.create({ data: { ...data, dependents: data.dependents as Prisma.InputJsonValue, stateResults: data.stateResults as Prisma.InputJsonValue, preparedById: actor.id } });
  await audit(prisma, { actorId: actor.id, action: "tax.summary_created", entityType: "TaxReturnSummary", entityId: s.id, clientId: s.clientId, details: { taxYear: s.taxYear, version: s.version } });
  return s;
}

/** A Draft can be edited freely; once sent, figures are locked (use Revise). */
export async function updateSummaryDraft(actor: Actor, id: string, input: Omit<SummaryInput, "clientId" | "taxYear" | "filingType">) {
  const s = await loadSummary(id);
  if (s.status !== "DRAFT") throw new ValidationError("This summary was already sent, so its figures are locked. Use “Revise figures” to make a new version — the client will need to approve again.");
  const data = clean({ ...input, clientId: s.clientId, taxYear: s.taxYear, filingType: s.filingType as "ORIGINAL" | "AMENDED" });
  await prisma.taxReturnSummary.update({ where: { id }, data: { ...data, dependents: data.dependents as Prisma.InputJsonValue, stateResults: data.stateResults as Prisma.InputJsonValue } });
  await audit(prisma, { actorId: actor.id, action: "tax.summary_edited", entityType: "TaxReturnSummary", entityId: id, clientId: s.clientId });
}

/** Sends the summary to the client's portal and emails a sign-in notice (no figures in the email). */
export async function sendSummary(actor: Actor, id: string) {
  const s = await loadSummary(id);
  if (s.status !== "DRAFT") throw new ValidationError("Only a draft can be sent.");
  const grants = await prisma.portalAccess.findMany({ where: { clientId: s.clientId, revokedAt: null, canViewTax: true } });
  if (!grants.length) throw new ValidationError("This client has no portal login with tax access yet, so the summary can't be sent. Invite them to the portal first.");
  // Only staff-verified information goes to the client, reconciled against the prepared return.
  const { reconcile, sendBlockers } = await import("./tax-summary-items");
  await reconcile(id);
  const blockers = await sendBlockers(id);
  if (blockers.length) throw new ValidationError(`Not ready to send: ${blockers.join(" · ")}`);
  if (!s.items.some((i) => i.status === "VERIFIED")) throw new ValidationError("Not ready to send: no verified items. Every W-2, 1099 and other entry on the return must be listed and verified.");
  const fresh = await loadSummary(id);
  await prisma.taxReturnSummary.update({ where: { id }, data: { status: "SENT", sentAt: new Date(), sentById: actor.id, figuresHash: figuresHash(fresh, fresh.items) } });
  await audit(prisma, { actorId: actor.id, action: "tax.summary_sent", entityType: "TaxReturnSummary", entityId: id, clientId: s.clientId, details: { version: s.version } });
  for (const g of grants) await queuePortalNotification(g.portalUserId, "TAX_SUMMARY_READY", `TAX_SUMMARY_READY:${id}`);
}

/**
 * Figures changed (client correction or anything else): the current version
 * is replaced by a new Draft and every approval on it is invalidated. The
 * new version must be sent and approved again.
 */
export async function reviseSummary(actor: Actor, id: string, reason: string) {
  const s = await loadSummary(id);
  if (!["SENT", "CHANGES_REQUESTED", "CLIENT_APPROVED"].includes(s.status)) throw new ValidationError("Only a sent summary can be revised. Edit the draft instead.");
  if (reason.trim().length < 3) throw new ValidationError("Say what is changing.");
  const filing = await prisma.filingRecord.findFirst({ where: { clientId: s.clientId, taxYear: s.taxYear, filingType: s.filingType as "ORIGINAL" | "AMENDED", filingStatus: { not: "NOT_SUBMITTED" } } });
  if (filing) throw new ValidationError("This return has already been submitted. Changes after filing need an amended return (start an Amended summary).");
  const now = new Date();
  const {
    id: _id, status: _st, version, createdAt: _c, updatedAt: _u, sentAt: _sa, sentById: _sb, approvedAt: _aa, invalidatedAt: _ia, invalidatedReason: _ir,
    changesRequestedAt: _cra, changesRequestNote: _crn, changesRequestedBy: _crb, signatures: _sig, replacesId: _r, preparedById: _p, items, changesRequestItems: _cri, returnTotals, ...copy
  } = s;
  void [_id, _st, _c, _u, _sa, _sb, _aa, _ia, _ir, _cra, _crn, _crb, _sig, _r, _p, _cri];
  const [, , next] = await prisma.$transaction([
    prisma.taxSummarySignature.updateMany({ where: { summaryId: id, invalidatedAt: null }, data: { invalidatedAt: now } }),
    prisma.taxReturnSummary.update({ where: { id }, data: { status: "SUPERSEDED", invalidatedAt: now, invalidatedReason: reason.trim().slice(0, 300) } }),
    prisma.taxReturnSummary.create({
      data: {
        ...copy, dependents: copy.dependents as Prisma.InputJsonValue, stateResults: copy.stateResults as Prisma.InputJsonValue, returnTotals: (returnTotals ?? undefined) as Prisma.InputJsonValue | undefined,
        version: version + 1, replacesId: id, status: "DRAFT", preparedById: actor.id,
        // Items carry over with their verification; anything staff change must be verified again.
        items: {
          create: items.map(({ id: _i, summaryId: _s, createdAt: _ca, updatedAt: _ua, ...it }) => {
            void [_i, _s, _ca, _ua];
            return { ...it, documentAmounts: (it.documentAmounts ?? undefined) as Prisma.InputJsonValue | undefined, returnAmounts: (it.returnAmounts ?? undefined) as Prisma.InputJsonValue | undefined };
          }),
        },
      },
    }),
  ]);
  await audit(prisma, {
    actorId: actor.id, action: "tax.summary_revised", entityType: "TaxReturnSummary", entityId: next.id, clientId: s.clientId,
    details: { replaces: id, fromVersion: version, previousStatus: s.status, approvalsInvalidated: s.signatures.filter((g) => !g.invalidatedAt).length, reason: reason.trim() },
  });
  return next;
}

export async function withdrawSummary(actor: Actor, id: string) {
  const s = await loadSummary(id);
  if (!["DRAFT", "SENT", "CHANGES_REQUESTED"].includes(s.status)) throw new ValidationError("An approved summary can't be withdrawn; revise it instead.");
  await prisma.taxReturnSummary.update({ where: { id }, data: { status: "WITHDRAWN", invalidatedAt: new Date(), invalidatedReason: "Withdrawn by the office" } });
  await audit(prisma, { actorId: actor.id, action: "tax.summary_withdrawn", entityType: "TaxReturnSummary", entityId: id, clientId: s.clientId });
}

// --- Client side --------------------------------------------------------------------

/** Summaries the client can see: sent, on hold, or approved (never drafts or replaced versions). */
const CLIENT_ITEMS = { where: { status: "VERIFIED" }, orderBy: [{ sortOrder: "asc" as const }] };

export async function portalSummaries(user: PortalActor, clientId: string) {
  await requireClientAccess(user.id, clientId, "tax");
  return prisma.taxReturnSummary.findMany({
    where: { clientId, status: { in: ["SENT", "CHANGES_REQUESTED", "CLIENT_APPROVED"] } },
    include: { signatures: { where: { invalidatedAt: null } }, items: CLIENT_ITEMS },
    orderBy: [{ taxYear: "desc" }, { version: "desc" }],
  });
}

/** Read-only, for the owner's View as Client. */
export async function previewSummaries(clientId: string) {
  return prisma.taxReturnSummary.findMany({
    where: { clientId, status: { in: ["SENT", "CHANGES_REQUESTED", "CLIENT_APPROVED"] } },
    include: { signatures: { where: { invalidatedAt: null } }, items: CLIENT_ITEMS },
    orderBy: [{ taxYear: "desc" }, { version: "desc" }],
  });
}

export function requiredRoles(s: { filingStatus: string }) {
  return needsSpouse(s) ? (["TAXPAYER", "SPOUSE"] as const) : (["TAXPAYER"] as const);
}

/**
 * Approve for filing: the typed full name is the electronic signature and
 * must match the name on the summary. On a joint return the spouse signs
 * separately; the summary is approved only when every required signature is
 * in, all against the same figures.
 */
export async function approveSummary(
  user: PortalActor,
  clientId: string,
  id: string,
  input: { role: "TAXPAYER" | "SPOUSE"; signerName: string; agreed: boolean; ipAddress?: string | null; userAgent?: string | null },
) {
  await requireClientAccess(user.id, clientId, "tax");
  const s = await loadSummary(id);
  if (s.clientId !== clientId) throw new ValidationError("Summary not found.");
  if (s.status !== "SENT") throw new ValidationError(s.status === "CLIENT_APPROVED" ? "This summary is already approved." : "This summary isn't waiting for approval.");
  if (input.role === "SPOUSE" && !needsSpouse(s)) throw new ValidationError("Only a joint return needs the spouse's approval.");
  if (!input.agreed) throw new ValidationError("Check the box to confirm you reviewed the summary and approve filing.");
  const expected = input.role === "SPOUSE" ? s.spouseName : s.taxpayerName;
  if (!norm(input.signerName) || norm(input.signerName) !== norm(expected)) {
    throw new ValidationError(`Type your full name exactly as shown (${expected}) to sign.`);
  }
  if (s.signatures.some((g) => g.role === input.role && !g.invalidatedAt)) throw new ValidationError(input.role === "SPOUSE" ? "The spouse has already signed." : "The taxpayer has already signed.");
  const current = figuresHash(s, s.items);
  if (current !== s.figuresHash) throw new ValidationError("These figures changed. Please wait for the updated summary from our office.");
  const text = consentText(input.role, expected!, s.taxYear);
  await prisma.taxSummarySignature.deleteMany({ where: { summaryId: id, role: input.role, invalidatedAt: { not: null } } });
  await prisma.taxSummarySignature.create({
    data: { summaryId: id, role: input.role, signerName: input.signerName.trim(), portalUserId: user.id, ipAddress: input.ipAddress ?? null, userAgent: input.userAgent?.slice(0, 300) ?? null, consentText: text, figuresHash: s.figuresHash },
  });
  const signed = new Set([...s.signatures.filter((g) => !g.invalidatedAt).map((g) => g.role), input.role]);
  const complete = requiredRoles(s).every((r) => signed.has(r));
  if (complete) await prisma.taxReturnSummary.update({ where: { id }, data: { status: "CLIENT_APPROVED", approvedAt: new Date() } });
  await audit(prisma, {
    actorId: null, action: complete ? "tax.summary_client_approved" : "tax.summary_signed", entityType: "TaxReturnSummary", entityId: id, clientId,
    details: { role: input.role, portalUserId: user.id, version: s.version, figuresHash: s.figuresHash, ip: input.ipAddress ?? null },
  });
  return { complete };
}

/** Request changes: the summary goes on hold, signatures so far are invalidated, and the office gets a secure message. */
export async function requestSummaryChanges(user: PortalActor, clientId: string, id: string, note: string, flagged: { itemId: string; note: string }[] = []) {
  await requireClientAccess(user.id, clientId, "tax");
  const s = await loadSummary(id);
  const flags = flagged
    .map((f) => ({ ...f, item: s.items.find((i) => i.id === f.itemId && i.status === "VERIFIED") }))
    .filter((f) => f.item)
    .map((f) => ({ itemId: f.itemId, label: `${f.item!.formType} — ${f.item!.payerName}`, note: f.note.trim().slice(0, 500) }));
  const text = [note.trim(), ...flags.map((f) => `• ${f.label}: ${f.note || "marked incorrect"}`)].filter(Boolean).join("\n");
  if (text.length < 3) throw new ValidationError("Mark the item that's wrong, or tell us what is missing or needs to change.");
  if (s.clientId !== clientId) throw new ValidationError("Summary not found.");
  if (s.status !== "SENT") throw new ValidationError(s.status === "CLIENT_APPROVED" ? "This summary is already approved. Send us a message if something is wrong." : "This summary isn't waiting for your review.");
  const now = new Date();
  await prisma.$transaction([
    prisma.taxSummarySignature.updateMany({ where: { summaryId: id, invalidatedAt: null }, data: { invalidatedAt: now } }),
    prisma.taxReturnSummary.update({ where: { id }, data: { status: "CHANGES_REQUESTED", changesRequestedAt: now, changesRequestNote: text.slice(0, 2000), changesRequestedBy: user.id, changesRequestItems: flags as unknown as Prisma.InputJsonValue } }),
  ]);
  await audit(prisma, { actorId: null, action: "tax.summary_changes_requested", entityType: "TaxReturnSummary", entityId: id, clientId, details: { portalUserId: user.id, version: s.version } });
  const { portalSendMessage } = await import("./messaging");
  await portalSendMessage(user, { clientId, subject: `Changes requested: ${s.taxYear} tax return summary`, body: text.slice(0, 2000) }).catch(() => {
    // A login without message permission still records the request on the summary.
  });
}

// --- Owner filing gate ----------------------------------------------------------------


/**
 * Whether a filing needs an approved summary before Tabitha records it as
 * submitted: individual federal returns (1040 family) and state returns of
 * individual clients, original or amended. Extensions and business returns don't.
 */
export async function summaryRequirement(filing: { clientId: string; taxYear: number; returnType: string; jurisdiction: string; filingType: string }) {
  if (filing.filingType === "EXTENSION" || BUSINESS_RETURN.test(filing.returnType)) return { required: false as const };
  if (filing.jurisdiction !== "FEDERAL") {
    const c = await prisma.client.findUnique({ where: { id: filing.clientId }, select: { clientType: true } });
    if (c?.clientType !== "INDIVIDUAL") return { required: false as const };
  }
  const approved = await prisma.taxReturnSummary.findFirst({
    where: { clientId: filing.clientId, taxYear: filing.taxYear, filingType: filing.filingType, status: "CLIENT_APPROVED" },
    include: { signatures: { where: { invalidatedAt: null } } },
    orderBy: { version: "desc" },
  });
  const valid = approved && requiredRoles(approved).every((r) => approved.signatures.some((g) => g.role === r && g.figuresHash === approved.figuresHash)) ? approved : null;
  return { required: true as const, approved: valid };
}

/**
 * Recording a return as submitted is Tabitha's alone. She confirms Form
 * 8879 / the state authorization is signed and kept, and an approved
 * summary must be on file — unless she records why she's filing without one.
 */
export async function assertOwnerMaySubmit(
  actor: Actor,
  filing: { clientId: string; taxYear: number; returnType: string; jurisdiction: string; filingType: string; method: string },
  input: { form8879Confirmed: boolean; overrideReason?: string | null },
) {
  if (!(await isReportApprover(actor))) throw new ForbiddenError("Only Tabitha can authorize and submit a tax return. Record Submitted after she files it in TaxAct.");
  if (filing.filingType === "EXTENSION") return { summaryId: null, override: null };
  // A signed 8879 on file that matches the approved summary satisfies this; the checkbox is the fallback.
  if (filing.method === "ELECTRONIC" && !input.form8879Confirmed && !(await (await import("./auto-tax-summary")).signed8879OnFile(filing))) {
    throw new ValidationError("Confirm the signed IRS Form 8879 (or the state e-file authorization) is on file. The client's summary approval does not replace it.");
  }
  const req = await summaryRequirement(filing);
  if (!req.required) return { summaryId: null, override: null };
  if (req.approved) return { summaryId: req.approved.id, override: null };
  const reason = input.overrideReason?.trim();
  if (!reason || reason.length < 5) {
    throw new ValidationError(`There's no client-approved ${filing.taxYear} tax summary for this return. Send the summary for approval first, or record why you are filing without it.`);
  }
  return { summaryId: null, override: reason.slice(0, 300) };
}

export function money(cents: number) {
  return (Math.abs(cents) / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}
export function resultLabel(cents: number) {
  if (cents > 0) return { label: `Refund ${money(cents)}`, tone: "green" as const };
  if (cents < 0) return { label: `Amount owed ${money(cents)}`, tone: "red" as const };
  return { label: "No refund, nothing owed", tone: "gray" as const };
}
export const maskedAccount = (last4: string | null) => (last4 ? `•••• ${last4}` : "—");

export type SummaryWithSigs = TaxReturnSummary & { items?: TaxSummaryItem[]; signatures: { role: string; signerName: string; signedAt: Date; portalUserId: string | null; invalidatedAt: Date | null; figuresHash: string }[] };
