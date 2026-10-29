"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { run, str, type ActionState } from "@/lib/action";
import { addProspect, moveProspect, removeProspect, saveStage } from "@/lib/services/pipelines";
import { cancelReminders, runAutomations, updateRule } from "@/lib/services/automations";
import { assertAdmin } from "@/lib/auth/actor";

const intOr = (v: string, d: number | null) => (/^-?\d+$/.test(v) ? Number(v) : d);

export async function addProspectAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await addProspect(actor, str(fd, "clientId"), str(fd, "stageId"));
    revalidatePath("/workflows");
    return "Added to the pipeline.";
  });
}

export async function moveProspectAction(cardId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await moveProspect(actor, cardId, str(fd, "stageId"));
    revalidatePath("/workflows");
  });
}

export async function removeProspectAction(cardId: string) {
  const actor = await requireUser();
  await removeProspect(actor, cardId);
  revalidatePath("/workflows");
}

export async function saveStageAction(stageId: string | null, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await saveStage(actor, stageId, str(fd, "name"));
    revalidatePath("/workflows");
    return "Stage saved.";
  });
}

export async function updateRuleAction(ruleId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await updateRule(actor, ruleId, {
      enabled: str(fd, "enabled") === "true",
      offsetDays: intOr(str(fd, "offsetDays"), 0)!,
      repeatEveryDays: intOr(str(fd, "repeatEveryDays"), null),
      maxReminders: intOr(str(fd, "maxReminders"), 1)!,
    });
    revalidatePath("/workflows");
    return "Automation updated.";
  });
}

export async function runAutomationsNowAction(_prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    assertAdmin(actor);
    const summary = await runAutomations();
    revalidatePath("/workflows");
    return `Run complete: ${Object.entries(summary).map(([k, v]) => `${k.toLowerCase().replace(/_/g, " ")}: ${v}`).join(", ")}.`;
  });
}

export async function cancelReminderAction(ruleId: string, targetKey: string, clientId: string | null) {
  const actor = await requireUser();
  await cancelReminders(actor, ruleId, targetKey, clientId);
  revalidatePath("/workflows");
}
