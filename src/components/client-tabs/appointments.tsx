import Link from "next/link";
import clsx from "clsx";
import { prisma } from "@/lib/prisma";
import { Card } from "@/components/ui";
import { STATUS_CHIP } from "@/components/appointments/calendar-views";
import { NOTICE_LABELS } from "@/lib/services/appointment-notices";
import { serviceNames, STATUS_LABELS } from "@/lib/appointments/services";
import { fmtChicago, utcToChicagoLocal } from "@/lib/tz";

const when = (d: Date) => fmtChicago(d, { weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) + " CT";

/** Client profile → Appointments: the same rows the client and the calendars show, with message history. */
export async function AppointmentsTab({ clientId }: { clientId: string }) {
  const appts = await prisma.appointment.findMany({ where: { clientId }, include: { notices: { orderBy: { createdAt: "asc" } } }, orderBy: { startsAt: "desc" }, take: 50 });
  return (
    <Card title="Appointments">
      {appts.length ? (
        <ul className="divide-y divide-ivory-200" data-testid="client-appointments">
          {appts.map((a) => (
            <li key={a.id} className="py-3">
              <div className="flex flex-wrap items-center gap-3">
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold text-navy-900">{when(a.startsAt)}</span>
                  <span className="block text-sm text-slate-600">{serviceNames(a.services).join(", ") || a.title} · {a.durationMin ?? 60} min · {a.source === "PORTAL" ? "Booked in the portal" : "Added by staff"}</span>
                </span>
                <span className={clsx("rounded-full px-2.5 py-0.5 text-xs font-semibold", STATUS_CHIP[a.status])}>{STATUS_LABELS[a.status]}</span>
                <Link href={`/appointments?view=day&date=${utcToChicagoLocal(a.startsAt).slice(0, 10)}&appt=${a.id}`} className="text-sm font-semibold text-navy-900 underline decoration-gold-500">Open</Link>
              </div>
              {a.notices.length > 0 && (
                <details className="mt-1 text-xs">
                  <summary className="cursor-pointer text-slate-600">Notification history ({a.notices.length})</summary>
                  <ul className="mt-1 space-y-0.5">
                    {a.notices.map((n) => (
                      <li key={n.id}>{when(n.createdAt)} — {NOTICE_LABELS[n.kind] ?? n.kind} · {n.audience.toLowerCase()} {n.channel === "SMS" ? "text" : "email"} · <strong>{n.status}</strong>{n.statusDetail ? ` — ${n.statusDetail}` : ""}</li>
                    ))}
                  </ul>
                </details>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-slate-600">No appointments yet.</p>
      )}
    </Card>
  );
}
