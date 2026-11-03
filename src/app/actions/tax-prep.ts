"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { run, str, type ActionState } from "@/lib/action";
import { confirmReturnType, saveTaxPrepCase } from "@/lib/services/tax-prep";

export async function saveTaxPrepCaseAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await saveTaxPrepCase(actor, clientId, {
      taxYear: Number(str(fd, "taxYear")),
      returnType: str(fd, "returnType"),
      otherReturnForm: str(fd, "otherReturnForm"),
      primaryFirstName: str(fd, "primaryFirstName"),
      primaryMiddleName: str(fd, "primaryMiddleName"),
      primaryLastName: str(fd, "primaryLastName"),
      spouseFirstName: str(fd, "spouseFirstName"),
      spouseMiddleName: str(fd, "spouseMiddleName"),
      spouseLastName: str(fd, "spouseLastName"),
      spouseEmail: str(fd, "spouseEmail"),
      spousePhone: str(fd, "spousePhone"),
    });
    revalidatePath(`/clients/${clientId}`);
    return "Tax return type saved and confirmed.";
  });
}

export async function confirmReturnTypeAction(clientId: string, caseId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await confirmReturnType(actor, caseId);
    revalidatePath(`/clients/${clientId}`);
    return "Return type confirmed.";
  });
}
