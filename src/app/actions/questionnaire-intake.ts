"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/services/clients";
import { requireUser } from "@/lib/auth/session";
import { run, str, type ActionState } from "@/lib/action";
import { buildFollowUp, dismissInboxItem, fileInboxItem, importRecentSubmissions, reassignSubmission, requestMissingItems, reviewSubmission, sendQuestionnaire, setJotformAutoFile, testJotformConnection } from "@/lib/services/questionnaire-intake";
import { ValidationError } from "@/lib/services/clients";
import { linkSubmission } from "@/lib/services/tax-center";
import { assertAdmin } from "@/lib/auth/actor";

const refresh = (clientId: string) => {
  revalidatePath(`/clients/${clientId}/questionnaires`);
  revalidatePath(`/clients/${clientId}`);
};

export async function sendQuestionnaireAction(clientId: string, taxYear: number, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const r = await sendQuestionnaire(actor, clientId, taxYear);
    refresh(clientId);
    return `${taxYear} questionnaire ${r.sendCount > 1 ? "resent" : "sent"} to ${r.sentTo}.`;
  });
}

export async function linkFoundSubmissionAction(clientId: string, taxYear: number, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const r = await linkSubmission(actor, { clientId, taxYear, submissionId: str(fd, "submissionId"), confirmed: fd.get("confirmed") === "on", matchNote: str(fd, "matchNote") });
    refresh(clientId);
    return `Linked. ${r.imported} file(s) saved to the ${taxYear} vault${r.skipped.length ? `; ${r.skipped.length} couldn't be saved` : ""}. Review the answers below.`;
  });
}

export async function reviewSubmissionAction(clientId: string, rowId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const applied = await reviewSubmission(actor, rowId, fd.getAll("apply").map(String));
    refresh(clientId);
    return applied.length ? `Reviewed. Updated: ${applied.join(", ")}.` : "Reviewed. Client record unchanged.";
  });
}

export async function buildFollowUpAction(clientId: string, rowId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const items = await buildFollowUp(actor, rowId);
    refresh(clientId);
    return `Coetha prepared ${items.length} item(s); ${items.filter((i) => i.status === "MISSING").length} missing.`;
  });
}

export async function requestMissingAction(clientId: string, rowId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await requestMissingItems(actor, rowId, fd.getAll("item").map(String));
    refresh(clientId);
    return "Document request created in the client's portal.";
  });
}

export async function testJotformAction(_prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  assertAdmin(actor);
  const r = await testJotformConnection();
  return r.ok ? { ok: r.detail, at: Date.now() } : { error: r.detail };
}

export async function fileInboxAction(inboxId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  let done: { clientId: string; taxYear: number } | null = null;
  const result = await run(async () => {
    let clientId = str(fd, "clientId");
    if (clientId === "__new") {
      // Create the client from what staff typed (prefilled from the submission).
      const c = await createClient(actor, {
        firstName: str(fd, "newFirstName"),
        lastName: str(fd, "newLastName"),
        email: str(fd, "newEmail"),
        phone: str(fd, "newPhone"),
        clientType: "INDIVIDUAL",
        status: "ACTIVE",
        services: "Tax Preparation",
      });
      clientId = c.id;
    }
    const taxYear = Number(str(fd, "taxYear"));
    await fileInboxItem(actor, inboxId, {
      clientId,
      taxYear,
      yearConfirmed: fd.get("yearConfirmed") === "on",
      fileIndexes: fd.getAll("file").map((v) => Number(v)).filter((n) => Number.isInteger(n)),
      note: str(fd, "note"),
    });
    done = { clientId, taxYear };
  });
  if (result?.ok && done) {
    const d = done as { clientId: string; taxYear: number };
    revalidatePath("/taxes/questionnaires");
    refresh(d.clientId);
    redirect(`/clients/${d.clientId}/questionnaires?year=${d.taxYear}`);
  }
  return result;
}

export async function importRecentAction(_prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const r = await importRecentSubmissions(actor);
    revalidatePath("/taxes/questionnaires");
    return `Checked ${r.seen} submission(s) in Jotform; ${r.added} new one(s) added to the inbox. Nothing was filed.`;
  });
}

export async function dismissInboxAction(inboxId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await dismissInboxItem(actor, inboxId, str(fd, "note"));
    revalidatePath("/taxes/questionnaires");
    return "Dismissed.";
  });
}

export async function setJotformAutoFileAction(on: boolean, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await setJotformAutoFile(actor, on);
    revalidatePath("/taxes/questionnaires");
    return on ? "Automatic filing is ON for verified, signed questionnaire links." : "Automatic filing is OFF. Every questionnaire waits here for staff.";
  });
}

export async function reassignSubmissionAction(fromClientId: string, rowId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const clientId = str(fd, "clientId") || fromClientId;
    await reassignSubmission(actor, rowId, { clientId, taxYear: Number(str(fd, "taxYear")), note: str(fd, "note") });
    refresh(fromClientId);
    refresh(clientId);
    return "Moved. The questionnaire and its files now belong to the chosen client and year.";
  });
}
