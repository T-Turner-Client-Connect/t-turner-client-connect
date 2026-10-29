"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { dateOrNull, run, str, type ActionState } from "@/lib/action";
import { saveTask, setTaskDone } from "@/lib/services/tasks";

export async function saveTaskAction(taskId: string | null, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const task = await saveTask(actor, taskId, {
      title: str(fd, "title"),
      details: str(fd, "details"),
      dueAt: dateOrNull(fd, "dueAt"),
      remindAt: dateOrNull(fd, "remindAt"),
      priority: (str(fd, "priority") || "NORMAL") as "LOW" | "NORMAL" | "HIGH",
      assigneeId: str(fd, "assigneeId") || null,
      clientId: str(fd, "clientId") || null,
    });
    revalidatePath("/tasks");
    revalidatePath("/");
    if (task.clientId) revalidatePath(`/clients/${task.clientId}`);
    return taskId ? "Task updated." : "Task added.";
  });
}

export async function setTaskDoneAction(taskId: string, done: boolean) {
  const actor = await requireUser();
  await setTaskDone(actor, taskId, done);
  revalidatePath("/tasks");
  revalidatePath("/");
}
