import Link from "next/link";
import clsx from "clsx";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui";
import { appointmentDetail, officeDate, officeTime } from "@/lib/services/appointments";
import { NOTICE_LABELS } from "@/lib/services/appointment-notices";
import { MEETING_TYPES, serviceNames, STATUS_LABELS } from "@/lib/appointments/services";
import { formatPhone } from "@/lib/normalize";
import { fmtChicago } from "@/lib/tz";
import { assignStaffAction, ownerApproveAction, ownerDeclineAction, ownerProposeAction, ownerStatusAction, staffNotesAction } from "@/app/actions/appointments";
import { STATUS_CHIP } from "./calendar-views";

const when = (d: Date) => fmtChicago(d, { weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) + " CT";

const NOTICE_TONE: Record<string, string> = { SENT: "text-emerald-700", PENDING: "text-amber-700", SKIPPED: "text-slate-500", FAILED: "text-red-700" };

/** One appointment with its history and notification record. Owner actions only when `owner`. */
export async function AppointmentDetail({ id, owner, staff, closeHref }: { id: string; owner: boolean; staff: { id: string; name: string }[]; closeHref: string }) {
  const a = await appointmentDetail(id);
  if (!a) return <p className="text-sm text-slate-600">Appointment not found.</p>;
  const info = (a.bookingInfo ?? null) as null | { legalName?: string; phone?: string; email?: string; clientKind?: string; businessName?: string | null; smsConsent?: boolean; changed?: string[] };
  const open = ["REQUESTED", "CONFIRMED", "RESCHEDULE_REQUESTED", "PROPOSED"].includes(a.status);
  const staffName = staff.find((s) => s.id === a.staffId)?.name ?? "—";
  return (
    <section className="min-w-0 space-y-4 rounded-2xl border-2 border-gold-300 bg-white p-4 shadow-sm sm:p-5" data-testid="appointment-detail">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-gold-700">Appointment</p>
          <h2 className="font-serif text-xl font-bold text-navy-900">
            <Link href={`/clients/${a.client.id}?tab=appointments`} className="underline decoration-gold-500 underline-offset-4">{a.client.displayName}</Link>
          </h2>
          <p className="text-sm text-navy-800">{when(a.startsAt)} · {a.durationMin ?? 60} min · {serviceNames(a.services).join(", ") || a.title}</p>
          {a.pendingStartsAt && <p className="text-sm font-semibold text-amber-800">{a.pendingBy === "OWNER" ? "Proposed" : "Requested"} new time: {when(a.pendingStartsAt)}</p>}
        </div>
        <div className="flex items-center gap-2">
          <span className={clsx("rounded-full px-2.5 py-0.5 text-xs font-semibold", STATUS_CHIP[a.status])}>{STATUS_LABELS[a.status]}</span>
          <Link href={closeHref} className="text-sm font-semibold text-navy-900 underline">Close</Link>
        </div>
      </div>

      <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div><dt className="inline font-semibold">Booked: </dt><dd className="inline">{a.source === "PORTAL" ? "Client portal" : "Staff"} · {when(a.createdAt)}</dd></div>
        <div><dt className="inline font-semibold">Staff: </dt><dd className="inline">{staffName}</dd></div>
        <div><dt className="inline font-semibold">Meeting: </dt><dd className="inline">{a.meetingType && a.meetingType in MEETING_TYPES ? MEETING_TYPES[a.meetingType as keyof typeof MEETING_TYPES] : a.location ?? "—"}</dd></div>
        {info && (
          <>
            <div><dt className="inline font-semibold">Legal name: </dt><dd className="inline">{info.legalName}</dd></div>
            <div><dt className="inline font-semibold">Phone: </dt><dd className="inline">{info.phone ? formatPhone(info.phone) : "—"} {info.smsConsent ? "(texts OK)" : "(no texts)"}</dd></div>
            <div><dt className="inline font-semibold">Email: </dt><dd className="inline [overflow-wrap:anywhere]">{info.email}</dd></div>
            <div><dt className="inline font-semibold">Client: </dt><dd className="inline">{info.clientKind === "NEW" ? "New client" : "Existing client"}</dd></div>
            {info.businessName && <div><dt className="inline font-semibold">Business: </dt><dd className="inline">{info.businessName}</dd></div>}
          </>
        )}
      </dl>
      {info?.changed?.length ? <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">The client changed {info.changed.join(", ")} on this booking. The client record was not updated — review and update it if needed.</p> : null}
      {a.clientNotes && (
        <div className="rounded-lg bg-ivory-100 px-3 py-2 text-sm"><p className="font-semibold">Client&apos;s reason</p><p className="whitespace-pre-wrap">{a.clientNotes}</p></div>
      )}

      {owner && open && (
        <div className="space-y-3 rounded-xl bg-navy-50 p-3">
          <div className="flex flex-wrap gap-2">
            {(a.status === "REQUESTED" || a.status === "RESCHEDULE_REQUESTED") && (
              <ActionForm action={ownerApproveAction.bind(null, a.id)}><Button type="submit" variant="gold" data-testid="approve">Approve</Button></ActionForm>
            )}
            {a.status === "CONFIRMED" && new Date() > a.startsAt && (
              <>
                <ActionForm action={ownerStatusAction.bind(null, a.id, "COMPLETED")}><Button type="submit" variant="secondary">Mark completed</Button></ActionForm>
                <ActionForm action={ownerStatusAction.bind(null, a.id, "NO_SHOW")}><Button type="submit" variant="secondary">No-show</Button></ActionForm>
              </>
            )}
            <ActionForm action={ownerStatusAction.bind(null, a.id, "CANCELLED")} confirm="Cancel this appointment? The client will be told."><Button type="submit" variant="danger">Cancel appointment</Button></ActionForm>
          </div>
          {(a.status === "REQUESTED" || a.status === "RESCHEDULE_REQUESTED" || a.status === "PROPOSED") && (
            <ActionForm action={ownerDeclineAction.bind(null, a.id)} className="flex flex-wrap items-end gap-2">
              <label className="min-w-0 flex-1 text-sm"><span className="font-semibold">Decline {a.status === "REQUESTED" ? "request" : "new time"}</span><input name="note" className="input mt-1" placeholder="Note for the history (optional)" maxLength={500} /></label>
              <Button type="submit" variant="secondary">Decline</Button>
            </ActionForm>
          )}
          <ActionForm action={ownerProposeAction.bind(null, a.id)} className="flex flex-wrap items-end gap-2">
            <label className="text-sm"><span className="font-semibold">Propose a new time</span><input type="date" name="date" required className="input mt-1" defaultValue={officeDate(a.startsAt)} /></label>
            <label className="text-sm"><span className="sr-only">Time</span><input type="time" name="time" required step={900} className="input" defaultValue={officeTime(a.startsAt)} /></label>
            <Button type="submit" variant="secondary">Propose</Button>
          </ActionForm>
          {staff.length > 1 && (
            <ActionForm action={assignStaffAction.bind(null, a.id)} className="flex flex-wrap items-end gap-2">
              <label className="text-sm"><span className="font-semibold">Assigned staff</span>
                <select name="staffId" className="input mt-1" defaultValue={a.staffId ?? ""}>{staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
              </label>
              <Button type="submit" variant="secondary">Assign</Button>
            </ActionForm>
          )}
        </div>
      )}

      <ActionForm action={staffNotesAction.bind(null, a.id)} className="space-y-2">
        <label className="block text-sm"><span className="font-semibold">Staff-only notes</span> <span className="text-xs text-slate-500">(never shown to the client)</span>
          <textarea name="staffNotes" rows={3} className="input mt-1" defaultValue={a.staffNotes ?? ""} maxLength={4000} />
        </label>
        <Button type="submit" variant="secondary">Save notes</Button>
      </ActionForm>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="min-w-0">
          <h3 className="font-semibold text-navy-900">History</h3>
          <ol className="mt-1 space-y-1 text-xs text-slate-700" data-testid="appointment-events">
            {a.events.map((e) => (
              <li key={e.id}>{when(e.createdAt)} — <strong>{e.action.replace(/_/g, " ")}</strong> by {e.actorType.toLowerCase()}{e.toStatus && e.fromStatus !== e.toStatus ? ` (${e.fromStatus ? `${STATUS_LABELS[e.fromStatus] ?? e.fromStatus} → ` : ""}${STATUS_LABELS[e.toStatus] ?? e.toStatus})` : ""}</li>
            ))}
          </ol>
        </div>
        <div className="min-w-0">
          <h3 className="font-semibold text-navy-900">Confirmations &amp; reminders</h3>
          {a.notices.length ? (
            <ul className="mt-1 space-y-1 text-xs" data-testid="appointment-notices">
              {a.notices.map((n) => (
                <li key={n.id} className="[overflow-wrap:anywhere]">
                  {when(n.createdAt)} — {NOTICE_LABELS[n.kind] ?? n.kind} · {n.audience === "OWNER" ? "owner" : "client"} {n.channel === "SMS" ? "text" : "email"} · <strong className={NOTICE_TONE[n.status]}>{n.status}</strong>
                  {n.statusDetail ? <span className="text-slate-500"> — {n.statusDetail}</span> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-xs text-slate-500">No messages for this appointment.</p>
          )}
        </div>
      </div>
    </section>
  );
}
