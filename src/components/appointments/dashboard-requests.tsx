import Link from "next/link";
import { CalendarClock } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui";
import { ownerApproveAction, ownerDeclineAction } from "@/app/actions/appointments";
import { MEETING_TYPES, serviceNames } from "@/lib/appointments/services";
import { fmtChicago } from "@/lib/tz";
import type { pendingRequests } from "@/lib/services/appointments";

type Req = Awaited<ReturnType<typeof pendingRequests>>[number];

/** Owner-only: appointment requests waiting for a decision, with Accept / Decline right on the dashboard. */
export function DashboardAppointmentRequests({ requests }: { requests: Req[] }) {
  const waiting = requests.filter((a) => a.status === "REQUESTED" || a.status === "RESCHEDULE_REQUESTED");
  if (!waiting.length) return null;
  return (
    <section className="mb-4 rounded-2xl border-2 border-gold-500 bg-white p-4 shadow-sm" data-testid="dashboard-appointment-requests">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-serif text-lg font-bold text-navy-900">
          <CalendarClock className="size-5 text-gold-600" aria-hidden />
          Appointment requests waiting for you ({waiting.length})
        </h2>
        <Link href="/owner/appointments?section=requests" className="text-sm font-semibold text-navy-900 underline decoration-gold-500">Open the calendar</Link>
      </div>
      <ul className="mt-3 divide-y divide-ivory-200">
        {waiting.map((a) => {
          const when = a.status === "RESCHEDULE_REQUESTED" && a.pendingStartsAt ? a.pendingStartsAt : a.startsAt;
          return (
            <li key={a.id} className="flex flex-col gap-3 py-3 lg:flex-row lg:items-center lg:justify-between" data-testid={`dash-appt-${a.id}`}>
              <div className="min-w-0">
                <p className="font-semibold text-navy-900">
                  <Link href={`/clients/${a.client.id}`} className="underline decoration-gold-500">{a.client.displayName}</Link>
                  {a.status === "RESCHEDULE_REQUESTED" && <span className="ml-2 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-800 ring-1 ring-amber-200">Wants to reschedule</span>}
                </p>
                <p className="text-sm text-slate-700">
                  {fmtChicago(when, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} CT · {serviceNames(a.services).join(", ") || a.title}
                  {a.durationMin ? ` · ${a.durationMin} min` : ""}
                  {a.meetingType && MEETING_TYPES[a.meetingType as keyof typeof MEETING_TYPES] ? ` · ${MEETING_TYPES[a.meetingType as keyof typeof MEETING_TYPES]}` : ""}
                </p>
                {a.clientNotes && <p className="truncate text-sm text-slate-500">“{a.clientNotes}”</p>}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <ActionForm action={ownerApproveAction.bind(null, a.id)}>
                  <Button type="submit" variant="gold" data-testid="dash-accept">Accept</Button>
                </ActionForm>
                <ActionForm action={ownerDeclineAction.bind(null, a.id)} confirm="Decline this request? The client will be told.">
                  <Button type="submit" variant="secondary" data-testid="dash-decline">Decline</Button>
                </ActionForm>
                <Link href={`/owner/appointments?section=requests&appt=${a.id}`} className="text-sm font-semibold text-navy-900 underline decoration-gold-500">Propose another time</Link>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
