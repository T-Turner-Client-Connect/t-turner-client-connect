import Link from "next/link";
import { requireUser } from "@/lib/auth/session";
import { ownerAccessFor } from "@/lib/auth/owner";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/ui";
import { CalendarViews, viewRange, type View } from "@/components/appointments/calendar-views";
import { AppointmentDetail } from "@/components/appointments/appointment-detail";
import { calendarAppointments, officeDate } from "@/lib/services/appointments";
import { atOffice, timeLabel } from "@/lib/appointments/availability";

export const metadata = { title: "Appointments" };

/** Staff Appointment Calendar: every appointment (portal and staff-added) from the same table. */
export default async function StaffAppointmentsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const today = officeDate(new Date());
  const view: View = sp.view === "month" || sp.view === "day" ? sp.view : "week";
  const anchor = sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : today;
  const [from, to] = viewRange(view, anchor);
  const [appts, rules, staff, owner] = await Promise.all([
    calendarAppointments(atOffice(from, "00:00"), atOffice(to, "00:00")),
    prisma.appointmentDateRule.findMany({ where: { date: { gte: from, lt: to }, kind: "BLOCK", staffId: null } }),
    prisma.user.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    ownerAccessFor(user.id),
  ]);
  const blocked: Record<string, string> = {};
  for (const r of rules) blocked[r.date] = `${r.label || "Blocked"}${r.startTime ? ` ${timeLabel(r.startTime)}–${timeLabel(r.endTime!)}` : ""}`;
  return (
    <div className="space-y-4">
      <PageHeader
        title="Appointments"
        subtitle="Client bookings and staff-added appointments. Times are Central Time."
        actions={owner?.scope === "FULL" ? <Link href="/owner/appointments" className="rounded-lg bg-navy-900 px-4 py-2 text-sm font-semibold text-white">Manage availability &amp; requests</Link> : undefined}
      />
      {sp.appt && <AppointmentDetail id={sp.appt} owner={false} staff={staff} closeHref={`/appointments?view=${view}&date=${anchor}`} />}
      <CalendarViews view={view} anchor={anchor} appts={appts} base="/appointments" today={today} blocked={blocked} />
      <p className="text-xs text-slate-600">Approving, declining or proposing times is done by the owner in the Owner&apos;s Office. Staff can add notes to any appointment.</p>
    </div>
  );
}
