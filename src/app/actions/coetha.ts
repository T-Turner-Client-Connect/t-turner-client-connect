"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { run, str, type ActionState } from "@/lib/action";
import { approveCoethaProposal, decideCoethaProposals, rejectCoethaProposal, runCoetha } from "@/lib/services/coetha";
import { setOwnerSwitch, SWITCH_LABEL, type OwnerSwitch } from "@/lib/services/owner-switches";
import { clearCoethaOptOut, setCoethaOptOut } from "@/lib/services/coetha-opt-out";
import { askCoetha } from "@/lib/services/coetha-chat";

const refresh = (clientId: string) => {
  revalidatePath(`/bookkeeping/${clientId}/coetha`);
  revalidatePath(`/bookkeeping/${clientId}/books`);
  revalidatePath(`/bookkeeping/${clientId}`);
  revalidatePath("/owner/coetha-review");
};

export async function runCoethaAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const r = await runCoetha(actor, clientId, { trigger: "MANUAL", month: str(fd, "month") || undefined });
    refresh(clientId);
    return `Coetha prepared ${r.proposals} draft${r.proposals === 1 ? "" : "s"} for Tabitha's review. Nothing was posted.${r.dropped ? ` (${r.dropped} unusable suggestion${r.dropped === 1 ? " was" : "s were"} dropped.)` : ""}`;
  });
}

/** Approve one proposal (Tabitha only, enforced in the service). */
export async function approveCoethaAction(clientId: string, proposalId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const r = await approveCoethaProposal(actor, clientId, proposalId, { accountId: str(fd, "accountId") || null, note: str(fd, "note") });
    refresh(clientId);
    if (r.result === "ALREADY_APPROVED") return "Already approved. Nothing was posted again.";
    return r.journalEntryId ? "Approved and posted to the books." : "Approved.";
  });
}

export async function rejectCoethaAction(clientId: string, proposalId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await rejectCoethaProposal(actor, clientId, proposalId, str(fd, "note"));
    refresh(clientId);
    return "Rejected. Nothing was posted.";
  });
}

/** Bulk approve/reject: checked proposals, each with its (possibly edited) category. */
export async function bulkCoethaAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const decision = str(fd, "decision") === "REJECT" ? "REJECT" : "APPROVE";
    const ids = fd.getAll("ids").filter((v): v is string => typeof v === "string");
    const results = await decideCoethaProposals(actor, clientId, decision, ids.map((id) => ({ id, accountId: str(fd, `account:${id}`) || null })));
    refresh(clientId);
    const done = results.filter((r) => r.result !== "SKIPPED").length;
    const skipped = results.filter((r) => r.result === "SKIPPED");
    return `${decision === "APPROVE" ? "Approved" : "Rejected"} ${done} of ${results.length}.${skipped.length ? ` Not done: ${skipped.map((s) => s.message).filter((m, i, a) => a.indexOf(m) === i).join(" ")}` : ""}`;
  });
}

export async function ownerSwitchAction(which: OwnerSwitch, on: boolean, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await setOwnerSwitch(actor, which, on);
    revalidatePath("/owner/automation");
    if (which === "clientRollout") revalidatePath("/owner/client-letters");
    if (which === "clientBankBalances") {
      revalidatePath("/client", "layout");
      revalidatePath("/bookkeeping", "layout");
    }
    const label = SWITCH_LABEL[which];
    return `${label} turned ${on ? "on" : "off"}.`;
  });
}

/** "Client prefers no Coetha": staff who can edit this client's books record it (enforced in the service). */
export async function setCoethaOptOutAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await setCoethaOptOut(actor, clientId, { toldOn: str(fd, "toldOn"), via: str(fd, "via"), note: str(fd, "note") });
    refresh(clientId);
    revalidatePath("/bookkeeping");
    return "Recorded: this client prefers no Coetha. Coetha won't run, draft or request documents for them.";
  });
}

export async function clearCoethaOptOutAction(clientId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await clearCoethaOptOut(actor, clientId);
    refresh(clientId);
    revalidatePath("/bookkeeping");
    return "Cleared. Coetha can work on this client's books again.";
  });
}

/** "Ask Coetha": one question about this client's books (books access enforced in the service). */
export async function askCoethaAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await askCoetha(actor, clientId, str(fd, "question"));
    revalidatePath(`/bookkeeping/${clientId}/coetha/ask`);
    return "Coetha answered below. Nothing in the books was changed.";
  });
}
