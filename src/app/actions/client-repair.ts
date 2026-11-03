"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { run, str, type ActionState } from "@/lib/action";
import { mergeClients } from "@/lib/services/client-merge";
import { repairJointName } from "@/lib/services/client-repair";

export async function mergeClientsAction(keepId: string, dupId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  const result = await run(async () => {
    await mergeClients(actor, keepId, dupId, fd.getAll("useDuplicate").map(String), str(fd, "confirmName"));
  });
  if (result?.ok) {
    revalidatePath("/clients");
    redirect(`/clients/${keepId}`);
  }
  return result;
}

export async function repairJointNameAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await repairJointName(actor, clientId, {
      firstName: str(fd, "firstName"),
      middleName: str(fd, "middleName"),
      lastName: str(fd, "lastName"),
      spouseFirstName: str(fd, "spouseFirstName"),
      spouseMiddleName: str(fd, "spouseMiddleName"),
      spouseLastName: str(fd, "spouseLastName"),
    });
    revalidatePath(`/clients/${clientId}`);
    return "Saved: taxpayer and spouse are now separate on this one client record.";
  });
}
