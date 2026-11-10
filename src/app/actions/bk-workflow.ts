"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { dateOrNull, run, str, type ActionState } from "@/lib/action";
import { ValidationError } from "@/lib/services/clients";
import { approveReconciliation, decideSharedCard, enterStatementBalances, monitorConnectionAccount, registerAccount, updateRegistryAccount } from "@/lib/services/bank-accounts";
import { discardDraftRequest, requestHistoricalRecords, requestYearEndDocuments, sendClientRequest, staffUploadForRequest, staffUploadStatement } from "@/lib/services/client-requests";

import { runWorkflowMonitor } from "@/lib/services/monthly-workflow";
import { readAfterUpload, readStatementTransactions, statementReadMessage } from "@/lib/services/statement-import";
import { setTaxClassification } from "@/lib/services/tax-classification";
import { releaseInterimStatement, revokeInterimStatement } from "@/lib/services/client-statements";

async function optionalFile(fd: FormData, key: string) {
  const f = fd.get(key);
  return f instanceof File && f.size > 0 ? { bytes: new Uint8Array(await f.arrayBuffer()), originalName: f.name } : null;
}

const refresh = (clientId: string) => {
  for (const p of ["", "/close", "/statements", "/banking", "/banking/reconciliation", "/records", "/year-end", "/coetha"]) revalidatePath(`/bookkeeping/${clientId}${p}`);
  revalidatePath("/owner/coetha-review");
};
const intOrNull = (v: string) => (v.trim() ? Number(v) : null);

export async function registerAccountAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const a = await registerAccount(actor, clientId, {
      institution: str(fd, "institution"), accountType: str(fd, "accountType"), nickname: str(fd, "nickname"), last4: str(fd, "last4"),
      openingBalance: str(fd, "openingBalance"), openingBalanceDate: str(fd, "openingBalanceDate") || null, statementDay: intOrNull(str(fd, "statementDay")),
      gl: str(fd, "gl") || "NEW", parentAccountId: str(fd, "parentAccountId") || null, cardholderLabel: str(fd, "cardholderLabel"),
    });
    refresh(clientId);
    return `Added ${a.nickname || a.institution}${a.last4 ? ` ••${a.last4}` : ""}.${a.ledgerAccountId ? " A GL account was assigned." : a.parentAccountId ? " It's an employee card on the shared account." : ""}`;
  });
}

export async function updateRegistryAccountAction(clientId: string, id: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await updateRegistryAccount(actor, clientId, id, {
      nickname: str(fd, "nickname"), statementDay: intOrNull(str(fd, "statementDay")), monitored: fd.get("monitored") === "on",
      ...(str(fd, "gl") ? { gl: str(fd, "gl") } : {}), ...(fd.has("openingBalance") ? { openingBalance: str(fd, "openingBalance"), openingBalanceDate: str(fd, "openingBalanceDate") || null } : {}),
    });
    refresh(clientId);
    return "Saved.";
  });
}

export async function monitorAccountAction(clientId: string, connectionAccountId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const v = str(fd, "registryId");
    await monitorConnectionAccount(actor, clientId, connectionAccountId, v === "" ? null : v);
    refresh(clientId);
    return v ? "Coetha now monitors this account." : "This account is no longer retrieved.";
  });
}

export async function sharedCardAction(clientId: string, connectionAccountId: string, decision: "CONFIRM" | "SEPARATE", _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await decideSharedCard(actor, clientId, connectionAccountId, decision);
    refresh(clientId);
    return decision === "CONFIRM" ? "Confirmed: one shared credit account." : "Marked as a separate account.";
  });
}

export async function statementBalancesAction(clientId: string, registryId: string, year: number, month: number, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const r = await enterStatementBalances(actor, clientId, registryId, year, month, { beginning: str(fd, "beginning"), ending: str(fd, "ending") });
    refresh(clientId);
    return r?.status === "READY" ? "Balanced — ready for Tabitha's approval." : "Saved. Coetha updated the reconciliation.";
  });
}

export async function approveReconciliationAction(clientId: string, reconciliationId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await approveReconciliation(actor, clientId, reconciliationId);
    refresh(clientId);
    return "Reconciliation approved.";
  });
}

export async function runMonitorAction(clientId: string, year: number, month: number, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const r = await runWorkflowMonitor(actor, clientId, year, month);
    refresh(clientId);
    return `Coetha checked the month: ${r.drafted} request${r.drafted === 1 ? "" : "s"} drafted${r.sent ? `, ${r.sent} sent automatically` : ""}, ${r.recommendations} new recommendation${r.recommendations === 1 ? "" : "s"} for Tabitha.`;
  });
}

export async function historicalRequestAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const r = await requestHistoricalRecords(actor, clientId, { docType: str(fd, "docType"), bookkeepingAccountId: str(fd, "accountId") || null, start: str(fd, "start"), end: str(fd, "end"), dueAt: dateOrNull(fd, "dueAt"), note: str(fd, "note") });
    refresh(clientId);
    return r.received ? "We already have those records, so nothing was requested." : r.created ? "Request sent to the client." : "That request already exists.";
  });
}

export async function sendRequestAction(clientId: string, requestId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await sendClientRequest(actor, clientId, requestId);
    refresh(clientId);
    return "Sent to the client.";
  });
}

export async function discardRequestAction(clientId: string, requestId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await discardDraftRequest(actor, clientId, requestId);
    refresh(clientId);
    return "Draft discarded.";
  });
}

export async function yearEndRequestAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const forms = fd.getAll("forms").filter((v): v is string => typeof v === "string");
    const out = await requestYearEndDocuments(actor, clientId, forms, { send: true });
    refresh(clientId);
    return `${out.length} year-end request${out.length === 1 ? "" : "s"} sent.`;
  });
}

export async function releaseInterimAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await releaseInterimStatement(actor, clientId, { from: str(fd, "from"), asOf: str(fd, "asOf"), purpose: str(fd, "purpose") });
    refresh(clientId);
    return "Interim statement released to the client's portal.";
  });
}

export async function revokeInterimAction(clientId: string, id: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await revokeInterimStatement(actor, clientId, id);
    refresh(clientId);
    return "Withdrawn.";
  });
}

export async function taxClassificationAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await setTaxClassification(actor, clientId, { classification: str(fd, "classification"), basis: str(fd, "basis") || null, fiscalYearEnd: intOrNull(str(fd, "fiscalYearEnd")), taxYear: intOrNull(str(fd, "taxYear")) });
    refresh(clientId);
    revalidatePath(`/bookkeeping/${clientId}/profile`);
    return "Tax classification saved.";
  });
}

export async function uploadForRequestAction(clientId: string, requestId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const file = await optionalFile(fd, "file");
    if (!file) throw new ValidationError("Choose the file to upload.");
    await staffUploadForRequest(actor, clientId, requestId, file);
    refresh(clientId);
    return "Uploaded and filed to that account and period. Coetha will pick it up.";
  });
}

export async function uploadStatementAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const file = await optionalFile(fd, "file");
    if (!file) throw new ValidationError("Choose the statement file.");
    const doc = await staffUploadStatement(actor, clientId, { accountId: str(fd, "accountId"), month: str(fd, "month"), ...file });
    // Read its transactions straight away (imported only if they match the statement to the cent).
    const read = /\.pdf$/i.test(file.originalName) ? await readAfterUpload(actor, clientId, doc.id) : "";
    refresh(clientId);
    revalidatePath(`/bookkeeping/${clientId}/books`);
    return `Statement uploaded and filed to that account and month.${read ? ` ${read}` : ""}`;
  });
}

/** Reads every statement already on file for one account (no re-upload), oldest month first. */
export async function readAllStatementsAction(clientId: string, registryId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const { readStatementsOnFile } = await import("@/lib/services/statement-import");
    const r = await readStatementsOnFile(actor, clientId, registryId, { postOpening: fd.get("postOpening") === "on" });
    refresh(clientId);
    revalidatePath(`/bookkeeping/${clientId}/books`);
    revalidatePath(`/bookkeeping/${clientId}/banking/reconciliation`);
    if (!r.results.length) throw new ValidationError("There are no statements on file for this account yet.");
    const ok = r.results.filter((x) => x.ok);
    const lines = r.results.map((x) => `${x.month}: ${x.ok ? `${x.added} added` : `not imported (${x.message.replace(/^The statement was filed, but /, "")})`}`);
    return `${ok.length} of ${r.results.length} statements read. ${lines.join(" · ")}${r.opening ? ` ${r.opening}` : ""}`;
  });
}

/** "Read transactions from statement": reads a statement PDF already on file. */
export async function readStatementAction(clientId: string, documentId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const r = await readStatementTransactions(actor, clientId, documentId);
    refresh(clientId);
    revalidatePath(`/bookkeeping/${clientId}/books`);
    if (!r.ok) throw new ValidationError(statementReadMessage(r));
    return statementReadMessage(r);
  });
}

/** Posts the opening balance from the earliest statement's beginning balance (Tabitha or an Admin; once). */
export async function postOpeningFromStatementAction(clientId: string, ledgerAccountId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const { postOpeningFromStatement } = await import("@/lib/services/cash-proof");
    const r = await postOpeningFromStatement(actor, clientId, ledgerAccountId);
    refresh(clientId);
    revalidatePath(`/bookkeeping/${clientId}/banking/reconciliation`);
    revalidatePath(`/bookkeeping/${clientId}/books`);
    return `${r.corrected ? "Opening corrected with an adjusting entry (the original stays in the history): " : "Opening balance "}$${(r.cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })} ${r.corrected ? "recorded on the bank account" : "posted"} on ${r.date}.`;
  });
}
