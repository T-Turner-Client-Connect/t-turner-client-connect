"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { run, str, type ActionState } from "@/lib/action";
import { ValidationError } from "@/lib/services/clients";
import { approveCoethaProposal, decideCoethaProposals, rejectCoethaProposal, runCoetha } from "@/lib/services/coetha";
import { setOwnerSwitch, SWITCH_LABEL, type OwnerSwitch } from "@/lib/services/owner-switches";
import { clearCoethaOptOut, setCoethaOptOut } from "@/lib/services/coetha-opt-out";

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
    const { prisma } = await import("@/lib/prisma");
    const diag = (await prisma.coethaRun.findUnique({ where: { id: r.runId }, select: { error: true } }))?.error;
    return `Coetha prepared ${r.proposals} draft${r.proposals === 1 ? "" : "s"} for Tabitha's review. Nothing was posted.${diag ? ` ${diag}` : r.dropped ? ` (${r.dropped} unusable suggestion${r.dropped === 1 ? " was" : "s were"} dropped.)` : ""}`;
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

// --- Preparing from the business's completed financial statements ----------------------------------

/** Keeps the completed financial statements on file and reads their monthly P&L lines. */
export async function saveReferenceAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const f = fd.get("file");
    if (!(f instanceof File) || f.size === 0) throw new ValidationError("Choose the completed financial statements PDF.");
    const { saveReferenceStatements, prepareFromRecords } = await import("@/lib/services/coetha-records");
    const r = await saveReferenceStatements(actor, clientId, { bytes: new Uint8Array(await f.arrayBuffer()), originalName: f.name });
    // Coetha prepares straight away; nothing is posted.
    const p = await prepareFromRecords(actor, clientId);
    refresh(clientId);
    return `Read ${r.lines} lines for ${r.months[0]} to ${r.months[r.months.length - 1]}. ${preparedText(p)}`;
  });
}

/** Coetha prepares (again) from the statements on file. */
export async function prepareFromRecordsAction(clientId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const { prepareFromRecords } = await import("@/lib/services/coetha-records");
    const p = await prepareFromRecords(actor, clientId);
    refresh(clientId);
    return preparedText(p);
  });
}

/** Approves every draft Coetha prepared from the completed statements that needs no judgment (Tabitha only). */
export async function approveMatchingAction(clientId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const { matchingDraftIds } = await import("@/lib/services/coetha-records");
    const ids = await matchingDraftIds(clientId);
    if (!ids.length) throw new ValidationError("There are no matching drafts waiting.");
    let done = 0;
    const problems: string[] = [];
    for (let i = 0; i < ids.length; i += 200) {
      const results = await decideCoethaProposals(actor, clientId, "APPROVE", ids.slice(i, i + 200).map((id) => ({ id })), "Approved together: matches the completed financial statements.");
      done += results.filter((r) => r.result !== "SKIPPED").length;
      for (const r of results) if (r.result === "SKIPPED" && r.message && !problems.includes(r.message)) problems.push(r.message);
    }
    refresh(clientId);
    return `Approved and posted ${done} of ${ids.length}.${problems.length ? ` Not posted: ${problems.slice(0, 3).join(" ")}` : ""}`;
  });
}

function preparedText(p: { drafts: number; waiting: number; needsJudgment: number; notMatched: number; accountsAdded: string[]; linesNotMatched: string[] }) {
  return `Coetha drafted ${p.drafts} of ${p.waiting} waiting transactions from the completed statements; ${p.needsJudgment} need your judgment and ${p.notMatched} didn't match.${p.accountsAdded.length ? ` Added ${p.accountsAdded.length} account${p.accountsAdded.length === 1 ? "" : "s"} named like the statement lines.` : ""}${p.linesNotMatched.length ? ` Not explained by the bank activity: ${p.linesNotMatched.slice(0, 4).join("; ")}${p.linesNotMatched.length > 4 ? "…" : ""}.` : ""} Nothing was posted.`;
}

/**
 * Approves ONE group of judgment items (one statement line), as the completed statements treated
 * them, only with a note saying how the treatment was verified (Tabitha only).
 */
export async function approveJudgmentGroupAction(clientId: string, line: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const note = str(fd, "verified").trim();
    if (note.length < 10) throw new ValidationError("Say how this treatment was verified (for example, “Confirmed with Cari: personal transfers to her savings”).");
    const { judgmentDraftIds } = await import("@/lib/services/coetha-records");
    const ids = await judgmentDraftIds(clientId, line);
    if (!ids.length) throw new ValidationError("Nothing is waiting in that group.");
    const results = await decideCoethaProposals(actor, clientId, "APPROVE", ids.slice(0, 200).map((id) => ({ id })), `Verified: ${note}`.slice(0, 300));
    refresh(clientId);
    const done = results.filter((r) => r.result !== "SKIPPED").length;
    return `Approved and posted ${done} of ${ids.length} for “${line}”. Your verification note is recorded on each.`;
  });
}

/** Reverses the few postings an earlier version matched by vendor family inside the statement months, then prepares again. */
export async function undoFamilyAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const { undoFamilyPostings, prepareFromRecords } = await import("@/lib/services/coetha-records");
    // Only the entries that were on screen when Tabitha approved.
    const reviewed = fd.getAll("entryId").map(String).filter(Boolean);
    const n = await undoFamilyPostings(actor, clientId, reviewed);
    const p = await prepareFromRecords(actor, clientId);
    refresh(clientId);
    return `Reversed ${n} posting${n === 1 ? "" : "s"}; they're waiting again. ${preparedText(p)}`;
  });
}
