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
