"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { run, str, type ActionState } from "@/lib/action";
import { approveCoethaProposal, decideCoethaProposals, rejectCoethaProposal, runCoetha } from "@/lib/services/coetha";
import { setOwnerSwitch, type OwnerSwitch } from "@/lib/services/owner-switches";

const refresh = (clientId: string) => {
  revalidatePath(`/bookkeeping/${clientId}/coetha`);
  revalidatePath(`/bookkeeping/${clientId}/books`);
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
    const label = which === "liveBanking" ? "Live bank connections" : "Coetha AI";
    return `${label} turned ${on ? "on" : "off"}.`;
  });
}
