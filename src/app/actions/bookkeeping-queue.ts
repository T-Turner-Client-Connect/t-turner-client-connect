"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { run, str, type ActionState } from "@/lib/action";

/** Tabitha assigns months of bookkeeping to Coetha, for every active bookkeeping client or one. */
export async function assignBookkeepingAction(clientId: string | null, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const { assignBookkeeping } = await import("@/lib/services/bookkeeping-queue");
    const r = await assignBookkeeping(actor, { from: str(fd, "from"), to: str(fd, "to"), clientIds: clientId ? [clientId] : undefined });
    revalidatePath("/owner/office-files");
    const months = r.queued.reduce((n, q) => n + q.months.length, 0);
    return `Assigned to Coetha: ${months} month${months === 1 ? "" : "s"} for ${r.queued.length} client${r.queued.length === 1 ? "" : "s"}. She works through them in the background and saves her progress after every step.${r.blocked.length ? ` Not queued: ${r.blocked.map((b) => `${b.client} (${b.why})`).join("; ")}.` : ""}`;
  });
}

/** One prior financial package (the page sends each file on its own; 6 MB request limit). */
export async function uploadPriorPackageAction(fd: FormData): Promise<{ ok: boolean; message: string }> {
  const actor = await requireUser();
  const f = fd.get("file");
  if (!(f instanceof File) || !f.size) return { ok: false, message: "No file." };
  try {
    const { uploadPriorPackage } = await import("@/lib/services/bookkeeping-queue");
    const r = await uploadPriorPackage(actor, { bytes: new Uint8Array(await f.arrayBuffer()), originalName: f.name });
    revalidatePath("/owner/office-files");
    return r.matched ? { ok: true, message: `${f.name}: ${r.client} — queued for Coetha` } : { ok: false, message: `${f.name}: not matched (${r.why}). Upload it from that client's Ask Coetha page instead.` };
  } catch (err) {
    return { ok: false, message: `${f.name}: ${err instanceof Error ? err.message : "couldn't be saved"}` };
  }
}
