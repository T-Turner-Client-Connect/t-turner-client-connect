"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { run, str, type ActionState } from "@/lib/action";
import { commitImport, discardImport, saveRowEdits, setRowApprovals, setRowDecision, stageImport, type StageInput } from "@/lib/services/imports";
import { TEXT_EDIT_FIELDS } from "@/lib/import/edits";

export async function stageImportAction(input: StageInput): Promise<{ error?: string; ok?: string; batchId?: string } | null> {
  const actor = await requireUser();
  let batchId = "";
  const result = await run(async () => {
    batchId = (await stageImport(actor, input)).id;
  });
  return result?.ok ? { ...result, batchId } : result;
}

export async function setRowDecisionAction(rowId: string, decision: string): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await setRowDecision(actor, rowId, decision);
  });
}

export async function commitImportAction(batchId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  const result = await run(async () => {
    // Values already on file change only where staff approved them in the comparison.
    await commitImport(actor, batchId, "fill_blanks", {
      addressNeeded: fd.get("addressNeeded") === "1" ? "flag" : "require",
      filingStatusNeeded: fd.get("filingStatusNeeded") === "1" ? "flag" : "require",
    });
  });
  if (result?.ok) {
    revalidatePath("/clients");
    redirect(`/imports/${batchId}`);
  }
  return result;
}

export async function discardImportAction(batchId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  const result = await run(async () => {
    await discardImport(actor, batchId);
  });
  if (result?.ok) redirect("/imports");
  return result;
}

export async function setRowApprovalsAction(rowId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const fields = await setRowApprovals(actor, rowId, fd.getAll("field").map(String), fd.getAll("scope").map(String));
    revalidatePath("/imports");
    return fields.length ? `Approved: ${fields.length} correction(s).` : "No corrections approved — Client Connect keeps its values.";
  });
}

/** Saves the address / contact / return type entered on one preview row. */
export async function saveRowEditsAction(rowId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const values = Object.fromEntries(TEXT_EDIT_FIELDS.map((f) => [f, str(fd, f)]));
    const { missing } = await saveRowEdits(actor, rowId, {
      values,
      mailingSameAsAddress: fd.get("mailingSameAsAddress") === "1",
      returnType: str(fd, "returnType"),
      useImported: fd.getAll("useImported").map(String),
    });
    revalidatePath("/imports/[id]", "page");
    return missing.length ? `Saved. Still missing: ${missing.join(", ").toLowerCase()}.` : "Saved. This row is complete.";
  });
}
