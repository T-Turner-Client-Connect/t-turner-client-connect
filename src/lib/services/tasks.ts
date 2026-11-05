import "server-only";
import { z } from "zod";
import type { TaskPriority } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { ValidationError } from "./clients";
import { recordStaffAppointmentCreated, staffCancelAppointment } from "./appointments";

const taskSchema = z.object({
  title: z.string().trim().min(1, "Give the task a title.").max(200),
  details: z.string().trim().max(5000).optional(),
  dueAt: z.date().nullable().optional(),
  remindAt: z.date().nullable().optional(),
  priority: z.enum(["LOW", "NORMAL", "HIGH"]).default("NORMAL"),
  assigneeId: z.string().nullable().optional(),
  clientId: z.string().nullable().optional(),
});

export type TaskInput = z.input<typeof taskSchema>;

export async function saveTask(actor: Actor, taskId: string | null, input: TaskInput) {
  const parsed = taskSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? "Check the form.");
  const v = parsed.data;
  if (v.assigneeId && !(await prisma.user.count({ where: { id: v.assigneeId, active: true } }))) {
    throw new ValidationError("Choose an active staff member.");
  }
  if (v.clientId && !(await prisma.client.count({ where: { id: v.clientId } }))) throw new ValidationError("Client not found.");
  const data = {
    title: v.title,
    details: v.details || null,
    dueAt: v.dueAt ?? null,
    remindAt: v.remindAt ?? null,
    priority: v.priority as TaskPriority,
    assigneeId: v.assigneeId || null,
    clientId: v.clientId || null,
  };
  return prisma.$transaction(async (tx) => {
    const task = taskId ? await tx.task.update({ where: { id: taskId }, data }) : await tx.task.create({ data: { ...data, createdById: actor.id } });
    await audit(tx, { actorId: actor.id, action: taskId ? "task.updated" : "task.created", entityType: "Task", entityId: task.id, clientId: task.clientId });
    return task;
  });
}

export async function setTaskDone(actor: Actor, taskId: string, done: boolean) {
  // A Tax & Compliance preparation task stays open until its filing period is completed
  // (filed with evidence, or not required with evidence) — it closes itself then.
  if (done) {
    const period = await prisma.complianceFilingPeriod.findUnique({ where: { prepTaskId: taskId }, select: { filingStatus: true } });
    if (period && !["SUBMITTED", "ACCEPTED", "NOT_REQUIRED"].includes(period.filingStatus)) {
      throw new ValidationError("This preparation task closes by itself once the filing is recorded with its evidence in Tax & Compliance.");
    }
  }
  return prisma.$transaction(async (tx) => {
    const task = await tx.task.update({ where: { id: taskId }, data: { status: done ? "DONE" : "OPEN", completedAt: done ? new Date() : null } });
    await audit(tx, { actorId: actor.id, action: done ? "task.completed" : "task.reopened", entityType: "Task", entityId: taskId, clientId: task.clientId });
    return task;
  });
}

export async function addAppointment(actor: Actor, input: { clientId: string; title: string; startsAt: Date | null; location?: string; staffId?: string | null }) {
  if (!input.title.trim() || !input.startsAt) throw new ValidationError("Add a title, date and time.");
  if (!(await prisma.client.count({ where: { id: input.clientId } }))) throw new ValidationError("Choose a client.");
  const a = await prisma.appointment.create({
    data: {
      clientId: input.clientId,
      title: input.title.trim().slice(0, 200),
      startsAt: input.startsAt,
      // Staff-added appointments are one hour unless changed on the appointment calendar.
      endsAt: new Date(input.startsAt.getTime() + 60 * 60_000),
      durationMin: 60,
      status: "CONFIRMED",
      source: "STAFF",
      confirmedAt: new Date(),
      location: input.location?.trim() || null,
      staffId: input.staffId || actor.id,
      createdById: actor.id,
    },
  });
  await recordStaffAppointmentCreated(a.id, actor);
  await audit(prisma, { actorId: actor.id, action: "appointment.created", entityType: "Appointment", entityId: a.id, clientId: input.clientId });
  return a;
}

export async function cancelAppointment(actor: Actor, appointmentId: string) {
  const a = await staffCancelAppointment(actor, appointmentId);
  await audit(prisma, { actorId: actor.id, action: "appointment.cancelled", entityType: "Appointment", entityId: appointmentId, clientId: a.clientId });
}
