"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { run, str, type ActionState } from "@/lib/action";
import { commitImport, discardImport, setRowDecision, stageImport, type StageInput } from "@/lib/services/imports";

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
    await commitImport(actor, batchId, str(fd, "mode") === "overwrite" ? "overwrite" : "fill_blanks");
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
