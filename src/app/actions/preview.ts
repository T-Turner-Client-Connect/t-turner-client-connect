"use server";

import { requireUser } from "@/lib/auth/session";
import { PREVIEW_OFF } from "@/lib/portal/preview-off";
import { monthAvailability, type MonthAvailability } from "@/lib/services/appointments";

/**
 * View as Client stand-ins for the portal's own actions. The preview renders the client's real
 * pages, but every send, upload, book, pay, sign or accept goes here instead and is refused:
 * nothing is saved, sent or charged. Only staff sessions can call these.
 */
type FormState = { error?: string; ok?: string; at?: number } | null;

/** Any ActionForm in the preview: refuses, saves nothing. */
export async function previewFormAction(_prev: FormState, _fd: FormData): Promise<FormState> {
  await requireUser();
  return { error: PREVIEW_OFF, at: Date.now() };
}

/** Appointment booking / rescheduling in the preview: refuses, books nothing. */
export async function previewBookAction(_clientId: string, _payload: unknown): Promise<{ error: string }> {
  await requireUser();
  return { error: PREVIEW_OFF };
}
export async function previewReschedulePickAction(_clientId: string, _appointmentId: string, _date: string, _time: string): Promise<{ error: string }> {
  await requireUser();
  return { error: PREVIEW_OFF };
}

/** Browsing the office's published availability is read-only, so staff can walk a client through it. */
export async function previewAvailabilityAction(_clientId: string, year: number, month: number): Promise<MonthAvailability | { error: string }> {
  await requireUser();
  return monthAvailability(year, month, new Date());
}
