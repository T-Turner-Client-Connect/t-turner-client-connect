"use server";
import { revalidatePath } from "next/cache";
import { run, str, type ActionState } from "@/lib/action";
import { requirePortalUser } from "@/lib/portal/session";
import { ValidationError } from "@/lib/services/clients";
import { submitHoursByPortal } from "@/lib/services/payroll-taxes";

/** A business's own hours for one open pay cycle. The service re-checks access to this client and cycle. */
export async function submitPortalHoursAction(clientId: string, cycleId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requirePortalUser();
  return run(async () => {
    let raw: unknown;
    try {
      raw = JSON.parse(str(fd, "hours") || "{}");
    } catch {
      throw new ValidationError("The hours form couldn't be read. Reload the page and try again.");
    }
    await submitHoursByPortal(user.id, clientId, cycleId, raw);
    revalidatePath("/client/payroll");
    return "Thank you — your hours were sent to the office.";
  });
}
