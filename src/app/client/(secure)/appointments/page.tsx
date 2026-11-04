import Link from "next/link";
import { CalendarCheck2, CalendarClock, History } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { AppointmentBooking } from "@/components/portal/appointment-booking";
import { requirePortalUser } from "@/lib/portal/session";
import { resolveAccount } from "@/lib/portal/account";
import { bookingProfile, monthAvailability, officeDate, portalAppointments, type ClientAppointment } from "@/lib/services/appointments";
import { durationLabel, MEETING_TYPES, serviceNames, STATUS_LABELS } from "@/lib/appointments/services";
import { BUSINESS, SMS_CONSENT_TEXT } from "@/lib/business";
import { fmtChicago } from "@/lib/tz";
import { answerProposalAction, availabilityAction, bookAppointmentAction, cancelAppointmentByClientAction, rescheduleAppointmentAction } from "@/app/actions/appointments";

export const metadata = { title: "Schedule an Appointment" };

const when = (d: Date) => `${fmtChicago(d, { weekday: "short", month: "short", day: "numeric", year: "numeric" })} at ${fmtChicago(d, { hour: "numeric", minute: "2-digit" })} CT`;

const TONE: Record<string, string> = {
  CONFIRMED: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  REQUESTED: "bg-amber-50 text-amber-800 ring-amber-200",
  RESCHEDULE_REQUESTED: "bg-amber-50 text-amber-800 ring-amber-200",
  PROPOSED: "bg-gold-100 text-navy-900 ring-gold-300",
};

function Upcoming({ items, q, phone }: { items: ClientAppointment[]; q: string; phone: string }) {
  if (!items.length) return <p className="py-4 text-sm text-slate-600">You have no upcoming appointments.</p>;
  return (
    <ul className="divide-y divide-gold-100" data-testid="upcoming-list">
      {items.map((a) => (
        <li key={a.id} className="flex flex-col gap-3 py-4 md:flex-row md:items-center" data-testid="upcoming-item">
          <div className="min-w-0 flex-1">
            <p className="font-serif text-lg font-bold text-navy-900">{when(a.startsAt)}</p>
            <p className="text-sm text-navy-800">{serviceNames(a.services).join(", ") || a.title} · {durationLabel(a.durationMin)}{a.meetingType && a.meetingType in MEETING_TYPES ? ` · ${MEETING_TYPES[a.meetingType as keyof typeof MEETING_TYPES]}` : ""}</p>
            <span className={`mt-1 inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ${TONE[a.status] ?? "bg-ivory-100 text-slate-700 ring-ivory-200"}`}>{STATUS_LABELS[a.status]}</span>
            {a.status === "RESCHEDULE_REQUESTED" && a.pendingStartsAt && <p className="mt-1 text-sm text-slate-700">Requested new time: {when(a.pendingStartsAt)} (your current time stays reserved until the office confirms).</p>}
            {a.status === "PROPOSED" && a.pendingStartsAt && <p className="mt-1 text-sm font-semibold text-navy-900">The office proposed: {when(a.pendingStartsAt)}</p>}
            {!a.canChange && a.changeNote && <p className="mt-1 text-xs text-slate-600">{a.changeNote} {phone}</p>}
          </div>
          <div className="flex flex-wrap gap-2">
            {a.status === "PROPOSED" && (
              <>
                <ActionForm action={answerProposalAction.bind(null, a.id, true)}><button className="rounded-full bg-gradient-to-b from-gold-300 to-gold-500 px-4 py-2 text-sm font-bold text-navy-950">Accept new time</button></ActionForm>
                <ActionForm action={answerProposalAction.bind(null, a.id, false)} confirm="Decline the proposed time?"><button className="rounded-full border-2 border-gold-500 px-4 py-2 text-sm font-semibold text-navy-900">Decline</button></ActionForm>
              </>
            )}
            {a.canChange && (a.status === "CONFIRMED" || a.status === "REQUESTED") && (
              <Link href={`/client/appointments${q}${q ? "&" : "?"}reschedule=${a.id}`} className="rounded-full border-2 border-gold-500 px-4 py-2 text-sm font-semibold text-navy-900 hover:bg-gold-50" data-testid="reschedule-link">Reschedule</Link>
            )}
            {a.canChange && (
              <ActionForm action={cancelAppointmentByClientAction.bind(null, a.id)} confirm="Cancel this appointment? Its time will be released.">
                <button className="rounded-full px-4 py-2 text-sm font-semibold text-red-700 ring-1 ring-red-200 hover:bg-red-50" data-testid="cancel-appointment">Cancel</button>
              </ActionForm>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

export default async function AppointmentsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requirePortalUser();
  const sp = await searchParams;
  const { current } = await resolveAccount(user.id, sp.account);
  if (!current) return null;
  const clientId = current.clientId;
  const q = sp.account ? `?account=${sp.account}` : "";
  const now = new Date();
  const today = officeDate(now);
  const [list, profile] = await Promise.all([portalAppointments(user.id, clientId, now), bookingProfile(user.id, clientId)]);
  const moving = sp.reschedule ? list.upcoming.find((a) => a.id === sp.reschedule && a.canChange && (a.status === "CONFIRMED" || a.status === "REQUESTED")) : undefined;

  // Start on this month, or next month when this one has nothing left to book.
  const [y, m] = today.split("-").map(Number);
  let initial = await monthAvailability(y, m, now, moving?.id);
  if (!Object.keys(initial.days).length) {
    const next = await monthAvailability(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, now, moving?.id);
    if (next.published && Object.keys(next.days).length) initial = next;
  }

  return (
    <div className="relative -mx-4 -mt-6 overflow-hidden bg-navy-950 px-4 pb-10 pt-8 text-white sm:-mx-6 sm:px-8" data-testid="appointments-page">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,rgb(30_64_175/0.35),transparent_55%),radial-gradient(ellipse_at_bottom_left,rgb(200_157_41/0.12),transparent_50%)]" aria-hidden />
      <div className="relative space-y-8">
        <AppointmentBooking
          key={moving?.id ?? "new"}
          clientId={clientId}
          accountQuery={q}
          initial={initial}
          today={today}
          profile={profile}
          meetingTypes={list.settings.meetingTypes}
          requireApproval={list.settings.requireApproval}
          smsConsentText={SMS_CONSENT_TEXT.SERVICE}
          officePhone={BUSINESS.officePhoneDisplay}
          reschedule={moving ? { id: moving.id, services: moving.services, durationMin: moving.durationMin, current: when(moving.startsAt) } : undefined}
          loadMonth={availabilityAction}
          book={bookAppointmentAction}
          reschedulePick={rescheduleAppointmentAction}
        />

        <section id="upcoming" className="rounded-3xl border border-gold-500/40 bg-white p-5 text-navy-900 sm:p-7">
          <h2 className="flex items-center gap-3 font-serif text-xl sm:text-[1.375rem] font-bold">
            <CalendarCheck2 className="size-7 text-gold-600" aria-hidden />
            Your Upcoming Appointments
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            You can reschedule or cancel online until {list.settings.cancelCutoffHours} hours before your appointment.
            {list.settings.rescheduleNeedsApproval ? " New times for confirmed appointments are confirmed by our office." : ""} Need help? Call {BUSINESS.officePhoneDisplay}.
          </p>
          <Upcoming items={list.upcoming} q={q} phone={`Call ${BUSINESS.officePhoneDisplay}.`} />
          {moving && (
            <p className="mt-2 flex items-center gap-2 text-sm text-navy-800"><CalendarClock className="size-4 text-gold-600" aria-hidden />Rescheduling {when(moving.startsAt)} — choose a new time above. <Link href={`/client/appointments${q}`} className="font-semibold underline decoration-gold-500">Stop rescheduling</Link></p>
          )}
        </section>

        {list.past.length > 0 && (
          <details className="rounded-3xl border border-gold-500/30 bg-white/95 p-5 text-navy-900 sm:p-7">
            <summary className="flex cursor-pointer items-center gap-3 font-serif text-xl font-bold"><History className="size-6 text-gold-600" aria-hidden />Past &amp; cancelled appointments</summary>
            <ul className="mt-3 divide-y divide-gold-100 text-sm">
              {list.past.map((a) => (
                <li key={a.id} className="flex flex-wrap justify-between gap-2 py-2">
                  <span>{when(a.startsAt)} · {serviceNames(a.services).join(", ") || a.title}</span>
                  <span className="font-semibold text-slate-600">{STATUS_LABELS[a.status]}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}
