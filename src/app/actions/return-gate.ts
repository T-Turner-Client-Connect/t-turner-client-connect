"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { run, str, type ActionState } from "@/lib/action";
import { discardHeldReturn, verifyHeldReturn } from "@/lib/services/return-gate";

/** Tabitha or an Admin records what is printed on a held return; it's accepted only if that is this client and year. */
export async function verifyHeldReturnAction(clientId: string, holdId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await verifyHeldReturn(actor, holdId, {
      year: Number(str(fd, "year")),
      first: str(fd, "first"),
      last: str(fd, "last"),
      businessName: str(fd, "businessName"),
      ein: str(fd, "ein"),
      nameChange: fd.get("nameChange") === "on",
      note: str(fd, "note"),
    });
    revalidatePath(`/clients/${clientId}`);
    return "Verified. Upload the same return again in Finish & Send (or where it was uploaded); it will now be accepted.";
  });
}

export async function discardHeldReturnAction(clientId: string, holdId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await discardHeldReturn(actor, holdId, str(fd, "reason"));
    revalidatePath(`/clients/${clientId}`);
    return "Removed. The held file is deleted.";
  });
}
