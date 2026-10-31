"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { requirePortalUser } from "@/lib/portal/session";
import { run, str, type ActionState } from "@/lib/action";
import { ValidationError } from "@/lib/services/clients";
import { bulkUploadReturns, confirmIntake, discardIntake, emailMyCopy, fileReturn, releaseReturn, submitReturnForRelease } from "@/lib/services/tax-returns";

const refresh = () => {
  revalidatePath("/taxes/returns");
  revalidatePath("/clients", "layout");
};
const fields = (fd: FormData, clientId?: string) => ({
  clientId: clientId ?? str(fd, "clientId"),
  taxYear: Number(str(fd, "taxYear")),
  returnType: str(fd, "returnType"),
  jurisdiction: str(fd, "jurisdiction"),
  filingType: (str(fd, "filingType") === "AMENDED" ? "AMENDED" : "ORIGINAL") as "ORIGINAL" | "AMENDED",
});

export async function fileReturnAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const f = fd.get("file");
    if (!(f instanceof File) || f.size === 0) throw new ValidationError("Choose the return PDF.");
    await fileReturn(actor, { ...fields(fd, clientId), bytes: new Uint8Array(await f.arrayBuffer()), originalName: f.name });
    refresh();
    return "Filed as a staff-only draft. Send it for review; Tabitha releases it to the client.";
  });
}

export async function bulkReturnsAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const files = fd.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
    const out = await bulkUploadReturns(actor, await Promise.all(files.map(async (f) => ({ bytes: new Uint8Array(await f.arrayBuffer()), originalName: f.name }))));
    refresh();
    const dup = out.filter((o) => o.duplicate).length;
    return `${out.length - dup} added to the review queue${dup ? `; ${dup} skipped as duplicates (already queued or already filed)` : ""}. Nothing is filed to a client until you confirm each one.`;
  });
}

export async function confirmIntakeAction(intakeId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await confirmIntake(actor, intakeId, fields(fd));
    refresh();
    return "Filed to the client as a staff-only draft.";
  });
}

export async function discardIntakeAction(intakeId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await discardIntake(actor, intakeId, str(fd, "reason"));
    refresh();
    return "Removed from the queue.";
  });
}

export async function returnStepAction(documentId: string, step: "submit" | "release", _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    if (step === "submit") await submitReturnForRelease(actor, documentId);
    else await releaseReturn(actor, documentId);
    refresh();
    return step === "submit" ? "Sent to Tabitha for review." : "Released to the client's portal.";
  });
}

export async function emailMyCopyAction(clientId: string, documentId: string, _prev: ActionState): Promise<ActionState> {
  const user = await requirePortalUser();
  return run(async () => {
    const r = await emailMyCopy(user, clientId, documentId);
    revalidatePath("/client/taxes/filings");
    if (!r.ok) throw new ValidationError(r.message);
    return r.message;
  });
}
