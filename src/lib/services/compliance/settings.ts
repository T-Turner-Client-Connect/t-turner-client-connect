import "server-only";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { ownerAudit } from "@/lib/auth/owner";
import type { Actor } from "@/lib/auth/actor";
import { ValidationError } from "@/lib/services/clients";
import { assertComplianceOwner } from "./access";

/** The office-wide settings row. Both safety switches default OFF. */
export async function complianceSettings() {
  const found = await prisma.complianceSettings.findUnique({ where: { id: "default" } });
  if (found) return found;
  return prisma.complianceSettings.create({ data: { id: "default" } }).catch(() => prisma.complianceSettings.findUniqueOrThrow({ where: { id: "default" } }));
}

export type SwitchKey = "clientNotificationsAuthorized" | "staffEmailReminders";
export const SWITCH_LABELS: Record<SwitchKey, { label: string; off: string }> = {
  clientNotificationsAuthorized: {
    label: "Compliance client notifications authorized",
    off: "No client email, text or portal notice is sent from the Tax & Compliance Center. Each would-be notice is recorded as HELD. Each entity also needs its own switch.",
  },
  staffEmailReminders: {
    label: "Compliance staff email reminders",
    off: "Staff reminders appear in Client Connect (tasks, the Tax Due Board) but are not emailed. Emails are recorded as HELD.",
  },
};

/** Owner only, audited (both logs). */
export async function setComplianceSwitch(actor: Actor, key: SwitchKey, on: boolean) {
  await assertComplianceOwner(actor);
  if (!(key in SWITCH_LABELS)) throw new ValidationError("Unknown switch.");
  await complianceSettings();
  await prisma.complianceSettings.update({ where: { id: "default" }, data: { [key]: on, updatedById: actor.id } });
  await audit(prisma, { actorId: actor.id, action: `compliance.switch.${key}.${on ? "on" : "off"}`, entityType: "ComplianceSettings", entityId: "default" });
  await ownerAudit(actor.id, `compliance.switch.${key}.${on ? "on" : "off"}`, "ComplianceSettings", "default");
}

export async function updateReminderSettings(actor: Actor, input: { reminderDays: number[]; prepTaskDays: number; defaultPrepLeadDays: number; approvalEscalationDays: number; approvalReminderEveryDays: number }) {
  await assertComplianceOwner(actor);
  const days = [...new Set(input.reminderDays.filter((d) => Number.isInteger(d)))].sort((a, b) => b - a);
  if (!days.length || days.some((d) => d < 0 || d > 120)) throw new ValidationError("Reminder days must be whole numbers from 0 to 120.");
  for (const [k, v, max] of [["prep task", input.prepTaskDays, 120], ["prep lead", input.defaultPrepLeadDays, 60], ["approval escalation", input.approvalEscalationDays, 60], ["approval reminder", input.approvalReminderEveryDays, 30]] as const) {
    if (!Number.isInteger(v) || v < (k === "approval reminder" ? 1 : 0) || v > max) throw new ValidationError(`The ${k} setting must be a whole number up to ${max}.`);
  }
  await complianceSettings();
  await prisma.complianceSettings.update({ where: { id: "default" }, data: { reminderDays: days, prepTaskDays: input.prepTaskDays, defaultPrepLeadDays: input.defaultPrepLeadDays, approvalEscalationDays: input.approvalEscalationDays, approvalReminderEveryDays: input.approvalReminderEveryDays, updatedById: actor.id } });
  await audit(prisma, { actorId: actor.id, action: "compliance.reminder_settings_saved", entityType: "ComplianceSettings", entityId: "default", details: { reminderDays: days, prepTaskDays: input.prepTaskDays } });
}
