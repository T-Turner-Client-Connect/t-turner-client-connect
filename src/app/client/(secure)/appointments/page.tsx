import { AppointmentsView, firstBookableMonth } from "@/components/portal/appointments-view";
import { portalViewer } from "@/lib/portal/viewer";
import { bookingProfile, clientAppointmentsFor, monthAvailability, officeDate, portalAppointments, previewBookingProfile } from "@/lib/services/appointments";
import { previewAvailabilityAction, previewBookAction, previewReschedulePickAction } from "@/app/actions/preview";
import { answerProposalAction, availabilityAction, bookAppointmentAction, cancelAppointmentByClientAction, rescheduleAppointmentAction } from "@/app/actions/appointments";

export const metadata = { title: "Schedule an Appointment" };

export default async function AppointmentsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const v = await portalViewer("appointments", sp.account);
  const { user, current, readOnly } = v;
  if (!current) return null;
  const clientId = current.clientId;
  const q = sp.account ? `?account=${sp.account}` : "";
  const now = new Date();
  const today = officeDate(now);
  const [list, profile] = await Promise.all([
    user ? portalAppointments(user.id, clientId, now) : clientAppointmentsFor(clientId, now),
    user ? bookingProfile(user.id, clientId) : previewBookingProfile(clientId),
  ]);
  const moving = sp.reschedule ? list.upcoming.find((a) => a.id === sp.reschedule && a.canChange && (a.status === "CONFIRMED" || a.status === "REQUESTED")) : undefined;
  const initial = await firstBookableMonth((y, m) => monthAvailability(y, m, now, moving?.id), today);

  return (
    <AppointmentsView
      clientId={clientId}
      accountQuery={q}
      initial={initial}
      today={today}
      profile={profile}
      list={list}
      moving={moving}
      appointmentsHref={(extra) => `/client/appointments${q}${extra ? `${q ? "&" : "?"}${extra}` : ""}`}
      // View as Client: months can be browsed; booking, answering, cancelling and rescheduling
      // show but are off (the stand-ins save nothing).
      actions={{
        loadMonth: readOnly ? previewAvailabilityAction : availabilityAction,
        book: readOnly ? previewBookAction : bookAppointmentAction,
        reschedulePick: readOnly ? previewReschedulePickAction : rescheduleAppointmentAction,
        answer: (id, yes) => v.act(answerProposalAction, id, yes),
        cancel: (id) => v.act(cancelAppointmentByClientAction, id),
      }}
      readOnly={readOnly}
    />
  );
}
