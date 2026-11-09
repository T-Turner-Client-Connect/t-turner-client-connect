import Link from "next/link";
import { CalendarCheck2, CalendarClock, History } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { AppointmentBooking } from "@/components/portal/appointment-booking";
import type { BookingProfile, ClientAppointment, MonthAvailability } from "@/lib/services/appointments";
import { durationLabel, MEETING_TYPES, serviceNames, STATUS_LABELS } from "@/lib/appointments/services";
import { BUSINESS, SMS_CONSENT_TEXT } from "@/lib/business";
import { fmtChicago } from "@/lib/tz";
import type { BookResult } from "@/app/actions/appointments";

type FormAction = (prev: { error?: string; ok?: string; at?: number } | null, fd: FormData) => Promise<{ error?: string; ok?: string; at?: number } | null>;
type List = { upcoming: ClientAppointment[]; past: ClientAppointment[]; settings: { cancelCutoffHours: number; rescheduleNeedsApproval: boolean; requireApproval: boolean; meetingTypes: string[] } };

/**
 * The client's Appointments page (booking + upcoming + past), shared by the portal and the staff
 * View as Client preview. `readOnly` (the preview): everything can be browsed and clicked through,
 * but booking, accepting, declining and cancelling are turned off; the actions passed in refuse.
 */
export type AppointmentsActions = {
  loadMonth: (clientId: string, year: number, month: number, rescheduleId?: string) => Promise<MonthAvailability | { error: string }>;
  book: (clientId: string, payload: { services: string[]; date: string; time: string; info: Record<string, unknown> }) => Promise<BookResult>;
  reschedulePick: (clientId: string, appointmentId: string, date: string, time: string) => Promise<{ error?: string; ok?: string }>;
  answer: (appointmentId: string, accept: boolean) => FormAction;
  cancel: (appointmentId: string) => FormAction;
};

const when = (d: Date) => `${fmtChicago(d, { weekday: "short", month: "short", day: "numeric", year: "numeric" })} at ${fmtChicago(d, { hour: "numeric", minute: "2-digit" })} CT`;

const TONE: Record<string, string> = {
  CONFIRMED: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  REQUESTED: "bg-amber-50 text-amber-800 ring-amber-200",
  RESCHEDULE_REQUESTED: "bg-amber-50 text-amber-800 ring-amber-200",
  PROPOSED: "bg-gold-100 text-navy-900 ring-gold-300",
};

const OFF = <span className="block w-full text-xs font-semibold text-slate-600" data-testid="preview-off">Turned off in View as Client</span>;

function Upcoming({ items, rescheduleHref, phone, actions, readOnly }: { items: ClientAppointment[]; rescheduleHref: (id: string) => string; phone: string; actions: AppointmentsActions; readOnly?: boolean }) {
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
          <fieldset disabled={readOnly} className="flex flex-wrap gap-2 disabled:opacity-70">
            {a.status === "PROPOSED" && (
              <>
                <ActionForm action={actions.answer(a.id, true)}><button className="rounded-full bg-gradient-to-b from-gold-300 to-gold-500 px-4 py-2 text-sm font-bold text-navy-950">Accept new time</button></ActionForm>
                <ActionForm action={actions.answer(a.id, false)} confirm="Decline the proposed time?"><button className="rounded-full border-2 border-gold-500 px-4 py-2 text-sm font-semibold text-navy-900">Decline</button></ActionForm>
              </>
            )}
            {a.canChange && (a.status === "CONFIRMED" || a.status === "REQUESTED") && (
              readOnly ? <span className="rounded-full border-2 border-gold-500 px-4 py-2 text-sm font-semibold text-navy-900 opacity-70" data-testid="reschedule-link">Reschedule</span>
                : <Link href={rescheduleHref(a.id)} className="rounded-full border-2 border-gold-500 px-4 py-2 text-sm font-semibold text-navy-900 hover:bg-gold-50" data-testid="reschedule-link">Reschedule</Link>
            )}
            {a.canChange && (
              <ActionForm action={actions.cancel(a.id)} confirm="Cancel this appointment? Its time will be released.">
                <button className="rounded-full px-4 py-2 text-sm font-semibold text-red-700 ring-1 ring-red-200 hover:bg-red-50" data-testid="cancel-appointment">Cancel</button>
              </ActionForm>
            )}
            {readOnly && (a.status === "PROPOSED" || a.canChange) && OFF}
          </fieldset>
        </li>
      ))}
    </ul>
  );
}

export function AppointmentsView({ clientId, accountQuery, initial, today, profile, list, moving, actions, appointmentsHref, readOnly }: {
  clientId: string;
  accountQuery: string;
  initial: MonthAvailability;
  today: string;
  profile: BookingProfile;
  list: List;
  moving?: ClientAppointment;
  actions: AppointmentsActions;
  /** The page's own address (portal: /client/appointments?account=…; preview: …?view=appointments), plus extra query. */
  appointmentsHref: (extra?: string) => string;
  readOnly?: boolean;
}) {
  return (
    <div className="relative -mx-4 -mt-6 overflow-hidden bg-navy-950 px-4 pb-10 pt-8 text-white sm:-mx-6 sm:px-8" data-testid="appointments-page">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,rgb(30_64_175/0.35),transparent_55%),radial-gradient(ellipse_at_bottom_left,rgb(200_157_41/0.12),transparent_50%)]" aria-hidden />
      <div className="relative space-y-8">
        <AppointmentBooking
          key={moving?.id ?? "new"}
          clientId={clientId}
          accountQuery={accountQuery}
          initial={initial}
          today={today}
          profile={profile}
          meetingTypes={list.settings.meetingTypes}
          requireApproval={list.settings.requireApproval}
          smsConsentText={SMS_CONSENT_TEXT.SERVICE}
          officePhone={BUSINESS.officePhoneDisplay}
          reschedule={moving ? { id: moving.id, services: moving.services, durationMin: moving.durationMin, current: when(moving.startsAt) } : undefined}
          loadMonth={actions.loadMonth}
          book={actions.book}
          reschedulePick={actions.reschedulePick}
          readOnly={readOnly}
        />

        <section id="upcoming" className="rounded-3xl border border-gold-500/40 bg-white p-5 text-navy-900 sm:p-7">
          <h2 className="flex items-center gap-3 font-serif text-xl sm:text-xl font-bold">
            <CalendarCheck2 className="size-7 text-gold-600" aria-hidden />
            Your Upcoming Appointments
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            You can reschedule or cancel online until {list.settings.cancelCutoffHours} hours before your appointment.
            {list.settings.rescheduleNeedsApproval ? " New times for confirmed appointments are confirmed by our office." : ""} Need help? Call {BUSINESS.officePhoneDisplay}.
          </p>
          <Upcoming items={list.upcoming} rescheduleHref={(id) => appointmentsHref(`reschedule=${id}`)} phone={`Call ${BUSINESS.officePhoneDisplay}.`} actions={actions} readOnly={readOnly} />
          {moving && (
            <p className="mt-2 flex items-center gap-2 text-sm text-navy-800"><CalendarClock className="size-4 text-gold-600" aria-hidden />Rescheduling {when(moving.startsAt)} — choose a new time above. <Link href={appointmentsHref()} className="font-semibold underline decoration-gold-500">Stop rescheduling</Link></p>
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

/** First month to show: this month, or next month when this one has nothing left to book. */
export async function firstBookableMonth(monthAvailability: (y: number, m: number) => Promise<MonthAvailability>, today: string) {
  const [y, m] = today.split("-").map(Number);
  let initial = await monthAvailability(y, m);
  if (!Object.keys(initial.days).length) {
    const next = await monthAvailability(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1);
    if (next.published && Object.keys(next.days).length) initial = next;
  }
  return initial;
}
