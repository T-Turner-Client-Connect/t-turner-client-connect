"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { clientIp, requireUser } from "@/lib/auth/session";
import { requirePortalUser } from "@/lib/portal/session";
import { run, str, type ActionState } from "@/lib/action";
import { ValidationError } from "@/lib/services/clients";
import {
  approveSummary,
  createSummary,
  requestSummaryChanges,
  reviseSummary,
  sendSummary,
  updateSummaryDraft,
  withdrawSummary,
  type SummaryInput,
} from "@/lib/services/tax-summary";

const refresh = () => {
  revalidatePath("/clients", "layout");
  revalidatePath("/taxes/returns");
};

/** "$1,234.56" → 123456 cents. Blank is 0. */
export async function parseCents(raw: string, label: string): Promise<number> {
  const t = raw.replace(/[$,\s]/g, "");
  if (!t) return 0;
  if (!/^-?\d+(\.\d{1,2})?$/.test(t)) throw new ValidationError(`Enter ${label} as dollars and cents, e.g. 1,234.56.`);
  return Math.round(Number(t) * 100);
}

async function resultCents(fd: FormData, kindKey: string, amountKey: string, label: string) {
  const amount = Math.abs(await parseCents(str(fd, amountKey), label));
  const kind = str(fd, kindKey);
  if (amount === 0 || kind === "EVEN") return 0;
  if (kind !== "REFUND" && kind !== "OWED") throw new ValidationError(`Choose refund or amount owed for ${label}.`);
  return kind === "OWED" ? -amount : amount;
}

async function readFigures(fd: FormData): Promise<Omit<SummaryInput, "clientId" | "taxYear" | "filingType">> {
  const dependents = [];
  for (let i = 0; i < 8; i++) {
    const name = str(fd, `depName_${i}`).trim();
    if (name) dependents.push({ name, relationship: str(fd, `depRel_${i}`).trim() });
  }
  const stateResults = [];
  for (let i = 0; i < 4; i++) {
    const state = str(fd, `state_${i}`).trim();
    if (state) stateResults.push({ state, resultCents: await resultCents(fd, `stateKind_${i}`, `stateAmount_${i}`, `the ${state.toUpperCase()} result`) });
  }
  return {
    filingStatus: str(fd, "filingStatus"),
    taxpayerName: str(fd, "taxpayerName"),
    spouseName: str(fd, "spouseName") || null,
    dependents,
    wagesCents: await parseCents(str(fd, "wages"), "wages"),
    otherIncomeCents: await parseCents(str(fd, "otherIncome"), "other income"),
    totalIncomeCents: await parseCents(str(fd, "totalIncome"), "total income"),
    agiCents: await parseCents(str(fd, "agi"), "adjusted gross income"),
    deductionType: str(fd, "deductionType"),
    deductionCents: await parseCents(str(fd, "deduction"), "the deduction"),
    taxableIncomeCents: await parseCents(str(fd, "taxableIncome"), "taxable income"),
    federalResultCents: await resultCents(fd, "federalKind", "federalAmount", "the federal result"),
    stateResults,
    depositBankName: str(fd, "depositBankName") || null,
    depositAccountType: str(fd, "depositAccountType") || null,
    depositRoutingLast4: str(fd, "depositRouting") || null,
    depositAccountLast4: str(fd, "depositAccount") || null,
    officeNote: str(fd, "officeNote") || null,
  };
}

export async function createSummaryAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await createSummary(actor, { clientId, taxYear: Number(str(fd, "taxYear")), filingType: str(fd, "filingType") === "AMENDED" ? "AMENDED" : "ORIGINAL", ...(await readFigures(fd)) });
    refresh();
    return "Summary saved as a draft. Check the figures against TaxAct, then send it to the client.";
  });
}

export async function updateSummaryAction(id: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await updateSummaryDraft(actor, id, await readFigures(fd));
    refresh();
    return "Draft updated.";
  });
}

export async function summaryStepAction(id: string, step: "send" | "withdraw", _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    if (step === "send") await sendSummary(actor, id);
    else await withdrawSummary(actor, id);
    refresh();
    return step === "send" ? "Sent to the client's portal for approval. They were notified by email (no figures in the email)." : "Withdrawn.";
  });
}

export async function reviseSummaryAction(id: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await reviseSummary(actor, id, str(fd, "reason"));
    refresh();
    return "New draft version created. Any earlier approval no longer counts — update the figures and send it again.";
  });
}

// --- Client portal --------------------------------------------------------------------

export async function approveSummaryAction(clientId: string, id: string, role: "TAXPAYER" | "SPOUSE", _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requirePortalUser();
  return run(async () => {
    const r = await approveSummary(user, clientId, id, {
      role,
      signerName: str(fd, "signerName"),
      agreed: fd.get("agree") === "on",
      ipAddress: await clientIp(),
      userAgent: (await headers()).get("user-agent"),
    });
    revalidatePath("/client/taxes/summary");
    revalidatePath("/client");
    return r.complete ? "Thank you — your return is approved for filing. Our office will let you know once it's filed and accepted." : "Signed. The spouse's separate approval is still needed before we can file.";
  });
}

export async function requestSummaryChangesAction(clientId: string, id: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requirePortalUser();
  return run(async () => {
    const flagged = fd.getAll("wrongItem").filter((v): v is string => typeof v === "string").map((itemId) => ({ itemId, note: str(fd, `itemNote_${itemId}`) }));
    await requestSummaryChanges(user, clientId, id, str(fd, "note"), flagged);
    revalidatePath("/client/taxes/summary");
    revalidatePath("/client");
    return "Thank you — we've received your request. Your return is on hold until our office reviews it and sends you an updated summary.";
  });
}

// --- Line items (staff) ---------------------------------------------------------------

async function readItem(fd: FormData) {
  const amounts = [];
  for (let i = 0; i < 6; i++) {
    const label = str(fd, `amtLabel_${i}`).trim();
    if (!label) continue;
    amounts.push({ key: str(fd, `amtKey_${i}`), label, cents: await parseCents(str(fd, `amt_${i}`), label) });
  }
  return { section: str(fd, "section"), formType: str(fd, "formType"), payerName: str(fd, "payerName"), recipient: str(fd, "recipient") || "TAXPAYER", returnAmounts: amounts, note: str(fd, "note") || null };
}

export async function attachReturnAction(summaryId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const f = fd.get("file");
    if (!(f instanceof File) || f.size === 0) throw new ValidationError("Choose the prepared return PDF from TaxAct.");
    const { attachPreparedReturn } = await import("@/lib/services/tax-summary-items");
    const r = await attachPreparedReturn(actor, summaryId, new Uint8Array(await f.arrayBuffer()), f.name);
    refresh();
    return `Prepared return saved (staff only). ${r.created} item(s) proposed from the return and ${r.documents} uploaded document(s). Nothing is final until staff verify each item.`;
  });
}

export async function extractAgainAction(summaryId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const { runExtraction } = await import("@/lib/services/tax-summary-items");
    const r = await runExtraction(actor, summaryId);
    refresh();
    return `Re-read the return and ${r.documents} document(s): ${r.created} new proposal(s). Verified and staff-entered items were kept.`;
  });
}

export async function addItemAction(summaryId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const { addItem } = await import("@/lib/services/tax-summary-items");
    await addItem(actor, summaryId, await readItem(fd));
    refresh();
    return "Item added. Verify it against the return.";
  });
}

export async function updateItemAction(itemId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const { updateItem } = await import("@/lib/services/tax-summary-items");
    await updateItem(actor, itemId, await readItem(fd), str(fd, "reason"));
    refresh();
    return "Corrected (recorded in the audit trail). Verify it again.";
  });
}

export async function itemStepAction(itemId: string, step: "verify" | "exclude", _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const { verifyItem, excludeItem } = await import("@/lib/services/tax-summary-items");
    if (step === "verify") await verifyItem(actor, itemId, str(fd, "note") || null);
    else await excludeItem(actor, itemId, str(fd, "reason"));
    refresh();
    return step === "verify" ? "Verified against the return." : "Excluded from this return.";
  });
}

export async function resolveCheckAction(checkId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const { resolveCheck } = await import("@/lib/services/tax-summary-items");
    await resolveCheck(actor, checkId, str(fd, "note"));
    refresh();
    return "Resolved.";
  });
}
