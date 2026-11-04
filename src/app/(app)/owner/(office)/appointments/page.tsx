import Link from "next/link";
import clsx from "clsx";
import { CalendarDays, CalendarRange, ClipboardCheck, Settings2, Users } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { Button, Card } from "@/components/ui";
import { CalendarViews, viewRange, type View } from "@/components/appointments/calendar-views";
import { AppointmentDetail } from "@/components/appointments/appointment-detail";
import { requireOffice } from "@/lib/auth/owner";
import { prisma } from "@/lib/prisma";
import { appointmentSettings, calendarAppointments, officeDate, pendingRequests } from "@/lib/services/appointments";
import { atOffice, dateLabel, monthDates, timeLabel } from "@/lib/appointments/availability";
import { MEETING_TYPES, serviceNames, STATUS_LABELS } from "@/lib/appointments/services";
import { formatPhone } from "@/lib/normalize";
import { fmtChicago } from "@/lib/tz";
import { addDateRuleAction, appointmentSettingsAction, monthSettingsAction, publishMonthAction, removeDateRuleAction, staffAvailabilityAction } from "@/app/actions/appointments";

export const metadata = { title: "Appointment Calendar" };

const WEEKDAYS = [[1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"], [7, "Sun"]] as const;
const REASONS = { HOLIDAY: "Holiday", VACATION: "Vacation", PERSONAL: "Personal day", CLOSURE: "Office closure", OTHER: "Other" } as const;

function DayBoxes({ selected }: { selected: number[] }) {
  return (
    <fieldset className="flex flex-wrap gap-2">
      <legend className="mb-1 text-sm font-semibold">Weekdays open</legend>
      {WEEKDAYS.map(([n, label]) => (
        <label key={n} className="flex items-center gap-1.5 rounded-lg border border-ivory-200 px-2.5 py-1.5 text-sm">
          <input type="checkbox" name="weekdays" value={n} defaultChecked={selected.includes(n)} className="accent-[#0A1A44]" />
          {label}
        </label>
      ))}
    </fieldset>
  );
}

export default async function OwnerAppointmentsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requireOffice("appointments");
  const sp = await searchParams;
  const section = (["calendar", "requests", "availability", "settings"] as const).find((s) => s === sp.section) ?? "calendar";
  const today = officeDate(new Date());
  const view: View = sp.view === "week" || sp.view === "day" ? sp.view : "month";
  const anchor = sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : today;
  const staff = await prisma.user.findMany({ where: { active: true }, select: { id: true, name: true, email: true }, orderBy: { name: "asc" } });
  const requests = await pendingRequests();
  const tabs = [
    { key: "calendar", label: "Calendar", icon: CalendarDays },
    { key: "requests", label: `Requests${requests.length ? ` (${requests.length})` : ""}`, icon: ClipboardCheck },
    { key: "availability", label: "Monthly availability", icon: CalendarRange },
    { key: "settings", label: "Booking settings & staff", icon: Settings2 },
  ] as const;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-serif text-3xl font-bold text-navy-900">Appointment <em className="font-normal italic text-gold-600">Calendar</em></h1>
          <p className="text-sm text-slate-600">Publish each month before clients can book it. Every booking waits for your approval while that setting is on.</p>
        </div>
      </div>
      <nav className="flex flex-wrap gap-1 rounded-xl bg-white p-1 shadow-sm ring-1 ring-ivory-200" aria-label="Appointment sections">
        {tabs.map((t) => (
          <Link key={t.key} href={`/owner/appointments?section=${t.key}`} aria-current={section === t.key ? "page" : undefined} className={clsx("flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold", section === t.key ? "bg-navy-900 text-white" : "text-navy-900 hover:bg-navy-50")}>
            <t.icon className="size-4" aria-hidden />{t.label}
          </Link>
        ))}
      </nav>

      {section === "calendar" && <CalendarSection view={view} anchor={anchor} today={today} appt={sp.appt} staff={staff} />}
      {section === "requests" && (
        <div className="space-y-4">
          {sp.appt && <AppointmentDetail id={sp.appt} owner staff={staff} closeHref="/owner/appointments?section=requests" />}
          <Card title="Waiting for you">
            {requests.length ? (
              <ul className="divide-y divide-ivory-200" data-testid="request-list">
                {requests.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center gap-3 py-3">
                    <span className="min-w-0 flex-1">
                      <span className="block font-semibold text-navy-900">{a.client.displayName}</span>
                      <span className="block text-sm text-slate-600">{fmtChicago(a.startsAt, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} CT · {serviceNames(a.services).join(", ") || a.title}</span>
                      {a.pendingStartsAt && <span className="block text-sm text-amber-800">New time: {fmtChicago(a.pendingStartsAt, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} CT</span>}
                    </span>
                    <span className="rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-800 ring-1 ring-amber-200">{STATUS_LABELS[a.status]}</span>
                    <Link href={`/owner/appointments?section=requests&appt=${a.id}`} className="text-sm font-semibold text-navy-900 underline decoration-gold-500">Review</Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-slate-600">No requests are waiting.</p>
            )}
          </Card>
        </div>
      )}
      {section === "availability" && <AvailabilitySection month={sp.month} today={today} staff={staff} />}
      {section === "settings" && <SettingsSection staff={staff} />}
    </div>
  );
}

async function CalendarSection({ view, anchor, today, appt, staff }: { view: View; anchor: string; today: string; appt?: string; staff: { id: string; name: string }[] }) {
  const [from, to] = viewRange(view, anchor);
  const [appts, rules, month] = await Promise.all([
    calendarAppointments(atOffice(from, "00:00"), atOffice(to, "00:00")),
    prisma.appointmentDateRule.findMany({ where: { date: { gte: from, lt: to }, kind: "BLOCK", staffId: null } }),
    prisma.appointmentMonth.findUnique({ where: { year_month: { year: Number(anchor.slice(0, 4)), month: Number(anchor.slice(5, 7)) } } }),
  ]);
  const blocked: Record<string, string> = {};
  for (const r of rules) blocked[r.date] = `${r.label || REASONS[r.reason as keyof typeof REASONS] || "Blocked"}${r.startTime ? ` ${timeLabel(r.startTime)}–${timeLabel(r.endTime!)}` : ""}`;
  const base = "/owner/appointments?section=calendar";
  return (
    <div className="space-y-4">
      {appt && <AppointmentDetail id={appt} owner staff={staff} closeHref={`${base}&view=${view}&date=${anchor}`} />}
      <CalendarViews view={view} anchor={anchor} appts={appts} base={base} today={today} blocked={blocked} published={month ? !!month.publishedAt : false} />
    </div>
  );
}

async function AvailabilitySection({ month, today, staff }: { month?: string; today: string; staff: { id: string; name: string }[] }) {
  const ym = month && /^\d{4}-\d{2}$/.test(month) ? month : today.slice(0, 7);
  const [y, m] = ym.split("-").map(Number);
  const settings = await appointmentSettings();
  const row = await prisma.appointmentMonth.findUnique({ where: { year_month: { year: y, month: m } } });
  const cfg = row ?? { weekdays: settings.weekdays, openTime: settings.openTime, closeTime: settings.closeTime, maxPerDay: settings.maxPerDay, publishedAt: null };
  const dates = monthDates(y, m);
  const rules = await prisma.appointmentDateRule.findMany({ where: { date: { gte: dates[0], lte: dates.at(-1)! } }, orderBy: [{ date: "asc" }, { startTime: "asc" }] });
  const label = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, 1)));
  const shift = (n: number) => {
    const d = new Date(Date.UTC(y, m - 1 + n, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  };
  const staffName = (id: string | null) => (id ? staff.find((s) => s.id === id)?.name ?? "Staff" : "Whole office");
  return (
    <div className="space-y-4" data-testid="availability-section">
      <div className="flex flex-wrap items-center gap-3">
        <Link href={`/owner/appointments?section=availability&month=${shift(-1)}`} className="rounded-lg px-3 py-1.5 text-sm font-semibold text-navy-900 ring-1 ring-ivory-200 hover:bg-white">← {shift(-1)}</Link>
        <h2 className="font-serif text-xl font-bold text-navy-900">{label}</h2>
        <Link href={`/owner/appointments?section=availability&month=${shift(1)}`} className="rounded-lg px-3 py-1.5 text-sm font-semibold text-navy-900 ring-1 ring-ivory-200 hover:bg-white">{shift(1)} →</Link>
        <span className={clsx("rounded-full px-3 py-1 text-xs font-bold", cfg.publishedAt ? "bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200" : "bg-slate-100 text-slate-600 ring-1 ring-slate-200")} data-testid="publish-state">
          {cfg.publishedAt ? `Published ${fmtChicago(cfg.publishedAt, { month: "short", day: "numeric" })}` : "Not published — clients can't book this month"}
        </span>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={`${label}: days & hours`}>
          <ActionForm action={monthSettingsAction.bind(null, y, m)} className="space-y-3">
            <DayBoxes selected={cfg.weekdays} />
            <div className="flex flex-wrap gap-3">
              <label className="text-sm"><span className="font-semibold">Opens</span><input type="time" name="openTime" defaultValue={cfg.openTime} className="input mt-1" required /></label>
              <label className="text-sm"><span className="font-semibold">Closes</span><input type="time" name="closeTime" defaultValue={cfg.closeTime} className="input mt-1" required /></label>
              <label className="text-sm"><span className="font-semibold">Max appointments / day</span><input type="number" name="maxPerDay" min={1} max={50} defaultValue={cfg.maxPerDay} className="input mt-1 w-28" required /></label>
            </div>
            <Button type="submit" variant="secondary">Save {label}</Button>
          </ActionForm>
          <div className="mt-4 border-t border-ivory-200 pt-4">
            <ActionForm action={publishMonthAction.bind(null, y, m, !cfg.publishedAt)} confirm={cfg.publishedAt ? `Unpublish ${label}? Clients won't be able to book new times. Existing appointments stay.` : `Publish ${label}? Open times become bookable by clients.`}>
              <Button type="submit" variant={cfg.publishedAt ? "danger" : "gold"} data-testid="publish-month">{cfg.publishedAt ? `Unpublish ${label}` : `Publish ${label}`}</Button>
            </ActionForm>
            <p className="mt-2 text-xs text-slate-600">Nothing in a month is bookable until you publish it. Next month is never opened automatically.</p>
          </div>
        </Card>
        <Card title="Block time or add special availability">
          <ActionForm action={addDateRuleAction} className="space-y-3" resetOnSuccess>
            <div className="flex flex-wrap gap-3 text-sm">
              <label className="flex items-center gap-2"><input type="radio" name="kind" value="BLOCK" defaultChecked />Block (closed)</label>
              <label className="flex items-center gap-2"><input type="radio" name="kind" value="SPECIAL" />Special availability</label>
            </div>
            <div className="flex flex-wrap gap-3">
              <label className="text-sm"><span className="font-semibold">From</span><input type="date" name="dateFrom" required className="input mt-1" defaultValue={`${ym}-01` < today ? today : `${ym}-01`} /></label>
              <label className="text-sm"><span className="font-semibold">To (optional)</span><input type="date" name="dateTo" className="input mt-1" /></label>
            </div>
            <div className="flex flex-wrap gap-3">
              <label className="text-sm"><span className="font-semibold">Start time</span><input type="time" name="startTime" className="input mt-1" /></label>
              <label className="text-sm"><span className="font-semibold">End time</span><input type="time" name="endTime" className="input mt-1" /></label>
            </div>
            <p className="text-xs text-slate-600">Leave the times empty to block the whole day. Special availability needs its hours (it opens the date even if it&apos;s normally closed).</p>
            <div className="flex flex-wrap gap-3">
              <label className="text-sm"><span className="font-semibold">Reason</span>
                <select name="reason" className="input mt-1">{Object.entries(REASONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
              </label>
              <label className="text-sm"><span className="font-semibold">Applies to</span>
                <select name="staffId" className="input mt-1"><option value="">Whole office</option>{staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
              </label>
              <label className="text-sm"><span className="font-semibold">Day limit (special)</span><input type="number" name="maxPerDay" min={1} max={50} className="input mt-1 w-24" /></label>
            </div>
            <label className="block text-sm"><span className="font-semibold">Label (optional)</span><input name="label" maxLength={120} className="input mt-1" placeholder="e.g. Thanksgiving" /></label>
            <Button type="submit">Add</Button>
          </ActionForm>
        </Card>
      </div>
      <Card title={`Blocks & special dates in ${label}`}>
        {rules.length ? (
          <ul className="divide-y divide-ivory-200 text-sm" data-testid="rule-list">
            {rules.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 py-2">
                <span className={clsx("rounded-full px-2 py-0.5 text-xs font-bold", r.kind === "BLOCK" ? "bg-slate-100 text-slate-700" : "bg-gold-100 text-gold-800")}>{r.kind === "BLOCK" ? "Blocked" : "Special"}</span>
                <span className="min-w-0 flex-1">{dateLabel(r.date)} · {r.startTime ? `${timeLabel(r.startTime)}–${timeLabel(r.endTime!)}` : "All day"} · {r.label || (r.reason ? REASONS[r.reason as keyof typeof REASONS] : "Extra hours")} · {staffName(r.staffId)}{r.maxPerDay ? ` · limit ${r.maxPerDay}` : ""}</span>
                <ActionForm action={removeDateRuleAction.bind(null, r.id)}><Button type="submit" variant="ghost">Remove</Button></ActionForm>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-slate-600">No blocks or special dates this month.</p>
        )}
      </Card>
    </div>
  );
}

async function SettingsSection({ staff }: { staff: { id: string; name: string; email: string }[] }) {
  const s = await appointmentSettings();
  const rows = await prisma.appointmentStaff.findMany();
  return (
    <div className="grid gap-4 lg:grid-cols-2" data-testid="settings-section">
      <Card title="Booking settings">
        <ActionForm action={appointmentSettingsAction} className="space-y-3">
          <p className="text-xs text-slate-600">Defaults copied into each month when you first open it.</p>
          <DayBoxes selected={s.weekdays} />
          <div className="flex flex-wrap gap-3">
            <label className="text-sm"><span className="font-semibold">Opens</span><input type="time" name="openTime" defaultValue={s.openTime} className="input mt-1" /></label>
            <label className="text-sm"><span className="font-semibold">Closes</span><input type="time" name="closeTime" defaultValue={s.closeTime} className="input mt-1" /></label>
            <label className="text-sm"><span className="font-semibold">Max / day</span><input type="number" name="maxPerDay" min={1} max={50} defaultValue={s.maxPerDay} className="input mt-1 w-24" /></label>
            <label className="text-sm"><span className="font-semibold">Start times every</span>
              <select name="slotStepMin" defaultValue={String(s.slotStepMin)} className="input mt-1"><option value="15">15 min</option><option value="30">30 min</option><option value="60">60 min</option></select>
            </label>
          </div>
          <div className="flex flex-wrap gap-3">
            <label className="text-sm"><span className="font-semibold">Minimum notice (hours)</span><input type="number" name="minNoticeHours" min={0} max={336} defaultValue={s.minNoticeHours} className="input mt-1 w-28" /></label>
            <label className="text-sm"><span className="font-semibold">Client change deadline (hours before)</span><input type="number" name="cancelCutoffHours" min={0} max={168} defaultValue={s.cancelCutoffHours} className="input mt-1 w-28" data-testid="cutoff-hours" /></label>
          </div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="requireApproval" defaultChecked={s.requireApproval} />Every new booking needs my approval (the time is held meanwhile)</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="rescheduleNeedsApproval" defaultChecked={s.rescheduleNeedsApproval} />Reschedules of confirmed appointments need my approval</label>
          <fieldset className="flex flex-wrap gap-3 text-sm"><legend className="mb-1 font-semibold">Ways to meet</legend>
            {Object.entries(MEETING_TYPES).map(([k, v]) => <label key={k} className="flex items-center gap-2"><input type="checkbox" name="meetingTypes" value={k} defaultChecked={s.meetingTypes.includes(k)} />{v}</label>)}
          </fieldset>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="remind24h" defaultChecked={s.remind24h} />Client reminder 24 hours before</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="remind2h" defaultChecked={s.remind2h} />Client reminder 2 hours before</label>
          <div className="flex flex-wrap gap-3">
            <label className="min-w-0 flex-1 text-sm"><span className="font-semibold">Booking alert email</span><input type="email" name="alertEmail" defaultValue={s.alertEmail} className="input mt-1" /></label>
            <label className="text-sm"><span className="font-semibold">Booking alert text</span><input name="alertPhone" defaultValue={formatPhone(s.alertPhone)} className="input mt-1" /></label>
          </div>
          <p className="text-xs text-slate-600">Alert texts go out through the staff text-alert path (Settings → Staff alerts) only while it is turned on; otherwise they are recorded as pending setup.</p>
          <Button type="submit">Save booking settings</Button>
        </ActionForm>
      </Card>
      <Card title={<span className="flex items-center gap-2"><Users className="size-5 text-gold-600" aria-hidden />Staff availability</span>}>
        <p className="mb-3 text-xs text-slate-600">Only staff switched on here take client bookings. With nobody switched on, every booking goes to you.</p>
        <ul className="space-y-4">
          {staff.map((u) => {
            const r = rows.find((x) => x.userId === u.id);
            return (
              <li key={u.id} className="rounded-xl border border-ivory-200 p-3">
                <ActionForm action={staffAvailabilityAction.bind(null, u.id)} className="space-y-2">
                  <label className="flex items-center gap-2 font-semibold"><input type="checkbox" name="active" defaultChecked={r?.active ?? false} />{u.name}</label>
                  <DayBoxes selected={r?.weekdays ?? [1, 2, 3, 4, 5]} />
                  <div className="flex flex-wrap items-end gap-3">
                    <label className="text-sm"><span className="font-semibold">From</span><input type="time" name="startTime" defaultValue={r?.startTime ?? ""} className="input mt-1" /></label>
                    <label className="text-sm"><span className="font-semibold">To</span><input type="time" name="endTime" defaultValue={r?.endTime ?? ""} className="input mt-1" /></label>
                    <Button type="submit" variant="secondary">Save</Button>
                  </div>
                  <p className="text-xs text-slate-500">Leave the times empty to use office hours.</p>
                </ActionForm>
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}
