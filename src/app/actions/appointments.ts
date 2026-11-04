"use server";

import { revalidatePath } from "next/cache";
import { run, str, type ActionState } from "@/lib/action";
import { requireUser } from "@/lib/auth/session";
import { requirePortalUser } from "@/lib/portal/session";
import { requireClientAccess } from "@/lib/portal/access";
import {
  addDateRule,
  bookAppointment,
  clientAnswerProposal,
  clientCancelAppointment,
  clientRescheduleAppointment,
  monthAvailability,
  officeDate,
  officeTime,
  ownerApprove,
  ownerAssignStaff,
  ownerDecline,
  ownerPropose,
  ownerSetStatus,
  removeDateRule,
  saveStaffAvailability,
  saveStaffNotes,
  setMonthPublished,
  updateAppointmentSettings,
  updateMonth,
  type BookingInfoInput,
  type MonthAvailability,
} from "@/lib/services/appointments";
import { prisma } from "@/lib/prisma";

function refresh() {
  revalidatePath("/client/appointments");
  revalidatePath("/owner/appointments");
  revalidatePath("/appointments");
  revalidatePath("/tasks");
}

// --- Client portal -----------------------------------------------------------

export async function availabilityAction(clientId: string, year: number, month: number, rescheduleId?: string): Promise<MonthAvailability | { error: string }> {
  const user = await requirePortalUser();
  try {
    await requireClientAccess(user.id, clientId);
    if (rescheduleId) {
      const a = await prisma.appointment.findUnique({ where: { id: rescheduleId }, select: { clientId: true } });
      if (a?.clientId !== clientId) return { error: "Appointment not found." };
    }
    return await monthAvailability(year, month, new Date(), rescheduleId);
  } catch {
    return { error: "We couldn't load available times. Please try again." };
  }
}

export type BookResult = { error?: string; ok?: { id: string; status: string; date: string; time: string; durationMin: number; textNote: string | null } };

export async function bookAppointmentAction(clientId: string, payload: { services: string[]; date: string; time: string; info: BookingInfoInput }): Promise<BookResult> {
  const user = await requirePortalUser();
  let result: BookResult["ok"];
  const state = await run(async () => {
    const a = await bookAppointment(user, { clientId, services: payload.services, date: payload.date, time: payload.time, info: payload.info });
    const sms = await prisma.appointmentNotice.findFirst({ where: { appointmentId: a.id, audience: "CLIENT", channel: "SMS" }, select: { status: true } });
    result = {
      id: a.id,
      status: a.status,
      date: officeDate(a.startsAt),
      time: officeTime(a.startsAt),
      durationMin: a.durationMin ?? 60,
      textNote: payload.info.smsConsent ? (sms?.status === "SENT" ? "A text is on its way to your mobile phone." : "Texts are not being sent right now; your confirmation will arrive by email.") : null,
    };
    refresh();
  });
  if (state?.error) return { error: state.error };
  return { ok: result };
}

export async function rescheduleAppointmentAction(clientId: string, appointmentId: string, date: string, time: string): Promise<{ error?: string; ok?: string }> {
  const user = await requirePortalUser();
  const state = await run(async () => {
    await requireClientAccess(user.id, clientId);
    const r = await clientRescheduleAppointment(user, appointmentId, { date, time });
    refresh();
    return r.pending ? "Your reschedule request was sent. Your current time stays reserved until the office confirms the new one." : "Your appointment was moved to the new time.";
  });
  return state?.error ? { error: state.error } : { ok: state?.ok };
}

export async function cancelAppointmentByClientAction(appointmentId: string, _prev: ActionState, _fd: FormData): Promise<ActionState> {
  const user = await requirePortalUser();
  return run(async () => {
    await clientCancelAppointment(user, appointmentId);
    refresh();
    return "Your appointment was cancelled.";
  });
}

export async function answerProposalAction(appointmentId: string, accept: boolean, _prev: ActionState, _fd: FormData): Promise<ActionState> {
  const user = await requirePortalUser();
  return run(async () => {
    await clientAnswerProposal(user, appointmentId, accept);
    refresh();
    return accept ? "You accepted the new time — your appointment is confirmed." : "You declined the proposed time.";
  });
}

// --- Owner's Office ------------------------------------------------------------

export async function ownerApproveAction(appointmentId: string, _prev: ActionState, _fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await ownerApprove(actor, appointmentId);
    refresh();
    return "Approved. The client's confirmation is on its way.";
  });
}

export async function ownerDeclineAction(appointmentId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await ownerDecline(actor, appointmentId, str(fd, "note"));
    refresh();
    return "Declined. The client has been told.";
  });
}

export async function ownerProposeAction(appointmentId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await ownerPropose(actor, appointmentId, { date: str(fd, "date"), time: str(fd, "time") });
    refresh();
    return "New time proposed. The client will accept or decline it in the portal.";
  });
}

export async function ownerStatusAction(appointmentId: string, status: "CANCELLED" | "COMPLETED" | "NO_SHOW", _prev: ActionState, _fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await ownerSetStatus(actor, appointmentId, status);
    refresh();
    return status === "CANCELLED" ? "Appointment cancelled." : status === "COMPLETED" ? "Marked completed." : "Marked as a no-show.";
  });
}

export async function staffNotesAction(appointmentId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await saveStaffNotes(actor, appointmentId, str(fd, "staffNotes"));
    refresh();
    return "Staff notes saved.";
  });
}

export async function assignStaffAction(appointmentId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await ownerAssignStaff(actor, appointmentId, str(fd, "staffId"));
    refresh();
    return "Staff member assigned.";
  });
}

const days = (fd: FormData) => fd.getAll("weekdays").map((v) => Number(v));
const int = (fd: FormData, k: string) => Number.parseInt(str(fd, k), 10);

export async function appointmentSettingsAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await updateAppointmentSettings(actor, {
      weekdays: days(fd),
      openTime: str(fd, "openTime"),
      closeTime: str(fd, "closeTime"),
      slotStepMin: int(fd, "slotStepMin"),
      maxPerDay: int(fd, "maxPerDay"),
      minNoticeHours: int(fd, "minNoticeHours"),
      cancelCutoffHours: int(fd, "cancelCutoffHours"),
      rescheduleNeedsApproval: fd.get("rescheduleNeedsApproval") === "on",
      requireApproval: fd.get("requireApproval") === "on",
      meetingTypes: fd.getAll("meetingTypes").map(String),
      alertEmail: str(fd, "alertEmail"),
      alertPhone: str(fd, "alertPhone"),
      remind24h: fd.get("remind24h") === "on",
      remind2h: fd.get("remind2h") === "on",
    });
    refresh();
    return "Booking settings saved.";
  });
}

export async function monthSettingsAction(year: number, month: number, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await updateMonth(actor, year, month, { weekdays: days(fd), openTime: str(fd, "openTime"), closeTime: str(fd, "closeTime"), maxPerDay: int(fd, "maxPerDay") });
    refresh();
    return "Month saved.";
  });
}

export async function publishMonthAction(year: number, month: number, publish: boolean, _prev: ActionState, _fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await setMonthPublished(actor, year, month, publish);
    refresh();
    return publish ? "Published — clients can now book open times in this month." : "Unpublished — clients can no longer book this month. Existing appointments are unchanged.";
  });
}

export async function addDateRuleAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const kind = str(fd, "kind") === "SPECIAL" ? "SPECIAL" : "BLOCK";
    const n = await addDateRule(actor, {
      dateFrom: str(fd, "dateFrom"),
      dateTo: str(fd, "dateTo") || undefined,
      kind,
      reason: str(fd, "reason"),
      label: str(fd, "label"),
      startTime: str(fd, "startTime") || undefined,
      endTime: str(fd, "endTime") || undefined,
      staffId: str(fd, "staffId") || null,
      maxPerDay: str(fd, "maxPerDay") ? int(fd, "maxPerDay") : null,
    });
    refresh();
    return kind === "BLOCK" ? `Blocked ${n} day${n === 1 ? "" : "s"}.` : `Special availability added for ${n} day${n === 1 ? "" : "s"}.`;
  });
}

export async function removeDateRuleAction(ruleId: string, _prev: ActionState, _fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await removeDateRule(actor, ruleId);
    refresh();
    return "Removed.";
  });
}

export async function staffAvailabilityAction(userId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await saveStaffAvailability(actor, userId, { active: fd.get("active") === "on", weekdays: days(fd), startTime: str(fd, "startTime") || undefined, endTime: str(fd, "endTime") || undefined });
    refresh();
    return "Staff availability saved.";
  });
}
