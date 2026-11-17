"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { run, type ActionState } from "@/lib/action";
import { checkAllAccounts, decideAccountOwnership } from "@/lib/services/account-ownership";
import { isPrimaryOwner } from "@/lib/auth/permissions";
import { ValidationError } from "@/lib/services/clients";

export async function checkAllAccountsAction(_prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    if (!(await isPrimaryOwner(actor.id))) throw new ValidationError("Only Tabitha runs this check.");
    const r = await checkAllAccounts({ budgetMs: 20_000, actor, staleHours: 0 });
    revalidatePath("/owner/account-verification");
    return `Checked ${r.checked} account${r.checked === 1 ? "" : "s"}: ${r.inQuestion} in question.${r.more ? " More remain; run it again or let the hourly check finish." : ""}`;
  });
}

export async function decideAccountAction(accountId: string, decision: "VERIFIED" | "IN_QUESTION" | "RECHECK", _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const r = await decideAccountOwnership(actor, accountId, decision);
    revalidatePath("/owner/account-verification");
    return r.note ?? "Saved.";
  });
}

export async function uploadBankingListAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const f = fd.get("file");
    if (!(f instanceof File) || !f.size) throw new ValidationError("Choose the banking list PDF.");
    if (f.size > 5_000_000) throw new ValidationError("That file is too large.");
    const { importBankingList } = await import("@/lib/services/bank-reference");
    const r = await importBankingList(actor, new Uint8Array(await f.arrayBuffer()));
    revalidatePath("/owner/account-verification");
    const fixed = r.applied.reduce((n, a) => n + a.corrected.length, 0);
    const flagged = r.applied.reduce((n, a) => n + a.inQuestion.length + a.flagged.length, 0);
    const verified = r.applied.reduce((n, a) => n + a.verified, 0);
    return `Read the list for ${r.matched} client${r.matched === 1 ? "" : "s"}: ${fixed} account${fixed === 1 ? "" : "s"} corrected or added; ${verified} verified from statements; ${flagged} flagged.${r.unmatched.length ? ` Not matched to a bookkeeping client: ${r.unmatched.join("; ")}.` : ""}`;
  });
}
