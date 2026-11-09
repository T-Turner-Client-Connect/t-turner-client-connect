"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { run, str, type ActionState } from "@/lib/action";
import { ValidationError } from "@/lib/services/clients";
import { mark8879Sent, recordSigned8879, sendAutoSummaryForApproval, uploadPreparedReturn } from "@/lib/services/auto-tax-summary";

const refresh = () => {
  revalidatePath("/clients", "layout");
  revalidatePath("/taxes/returns");
  revalidatePath("/taxes/8879");
  revalidatePath("/client/taxes/summary");
};

async function fileOf(fd: FormData, what: string) {
  const f = fd.get("file");
  if (!(f instanceof File) || f.size === 0) throw new ValidationError(`Choose the ${what} PDF.`);
  return { bytes: new Uint8Array(await f.arrayBuffer()), name: f.name };
}

/** Upload the prepared return (or a signed 8879) for the automatic summary. */
export async function uploadAutoSummaryAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const { bytes, name } = await fileOf(fd, "prepared return");
    const r = await uploadPreparedReturn(actor, { clientId, taxYear: Number(str(fd, "taxYear")), bytes, originalName: name });
    refresh();
    if (r.outcome === "FORM_8879") return r.flags.length ? `Saved as the signed Form 8879, but flagged for Tabitha: ${r.flags.join(" ")}` : "Saved as the signed Form 8879 (staff only). It matches the approved summary.";
    if (r.outcome === "HELD") return `Held — not sent. ${r.issues.length} thing(s) couldn't be confirmed; see the list below.`;
    if (r.outcome === "AUTO_SENT") return "Every check passed and the summary was sent to the client's portal automatically (sign-in notice only, no figures).";
    return `Every check passed. ${r.waitingReason ?? "It's ready for Tabitha's “Send for approval”."}`;
  });
}

export async function sendAutoSummaryAction(summaryId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await sendAutoSummaryForApproval(actor, summaryId);
    refresh();
    return "Sent to the client's portal for approval. They were notified by email (no figures in the email).";
  });
}

export async function mark8879SentAction(summaryId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await mark8879Sent(actor, summaryId);
    refresh();
    return "Marked as sent from TaxAct. The client's page now shows the 8879 as sent (no message is sent from here).";
  });
}

export async function upload8879Action(clientId: string, taxYear: number, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const { bytes, name } = await fileOf(fd, "signed Form 8879");
    const r = await recordSigned8879(actor, { clientId, taxYear, bytes, originalName: name, manual: fd.get("manual") === "on" });
    refresh();
    return r.flags.length ? `Saved (staff only), but flagged for Tabitha: ${r.flags.join(" ")}` : "Signed Form 8879 saved (staff only) and linked to the filing.";
  });
}
