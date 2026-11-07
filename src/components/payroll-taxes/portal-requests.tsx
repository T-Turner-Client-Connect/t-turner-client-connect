import Link from "next/link";
import { CalendarClock, ClipboardCheck, FileText } from "lucide-react";
import { HoursForm } from "@/components/payroll-taxes/hours-form";
import { fmtDay, fmtWhen, VersionTag } from "@/components/payroll-taxes/bits";
import { submitPortalHoursAction } from "@/app/actions/payroll-taxes-portal";
import { previewFormAction } from "@/app/actions/preview";
import { PreviewDisabled } from "@/components/portal/preview-off";
import type { portalPayrollRequests } from "@/lib/services/payroll-taxes";

type Requests = NonNullable<Awaited<ReturnType<typeof portalPayrollRequests>>>;

/** "Payroll requests" on the client's Payroll page: only this business, only this login's items. */
/** `readOnly` (View as Client): the hours form shows, disabled, posting only to the preview stand-in. */
export function PortalPayrollRequests({ clientId, r, linkFor, readOnly }: { clientId: string; r: Requests; linkFor: (id: string) => string; readOnly?: boolean }) {
  return (
    <section className="mb-6 space-y-4 rounded-2xl border border-navy-100 bg-white p-5" data-testid="payroll-requests">
      <h2 className="flex items-center gap-2 font-serif text-2xl font-bold text-navy-900"><ClipboardCheck className="size-6 text-gold-600" aria-hidden /> Payroll requests</h2>
      {!r.hours.length && !r.awaiting.length && <p className="text-sm text-slate-700" data-testid="nothing-open">Nothing is waiting on you right now. We&apos;ll let you know when the next payroll needs your hours or approval.</p>}

      {r.hours.map((h) => (
        <div key={h.cycleId} className="rounded-xl border border-gold-300 bg-gold-50/40 p-4" data-testid="hours-request">
          <p className="font-semibold text-navy-900">Hours for pay date {fmtDay(h.payDate)} <span className="font-normal text-slate-600">(period {fmtDay(h.periodStart)} – {fmtDay(h.periodEnd)})</span></p>
          <p className="mb-3 text-sm text-slate-700">Please send them by <strong>{fmtDay(h.hoursDue)}</strong>.{h.submittedAt && ` You sent hours on ${fmtWhen(h.submittedAt)} — you can update them until the office prepares the payroll.`}</p>
          <PreviewDisabled readOnly={readOnly}><HoursForm action={readOnly ? previewFormAction : submitPortalHoursAction.bind(null, clientId, h.cycleId)} initial={h.submission} submitLabel={h.submittedAt ? "Update hours" : "Send hours"} /></PreviewDisabled>
        </div>
      ))}

      {r.awaiting.length > 0 && (
        <div className="rounded-xl border border-navy-100 p-4" data-testid="awaiting-approval">
          <p className="mb-2 font-semibold text-navy-900">Waiting for your approval</p>
          <ul className="space-y-2 text-sm">
            {r.awaiting.map((a) => (
              <li key={a.cycleId} className="flex flex-wrap items-center justify-between gap-2">
                <span>Pay date {fmtDay(a.payDate)} <VersionTag n={a.version} /> · due {fmtDay(a.approvalDue)}</span>
                <Link href="/client/payroll-approval" className="rounded-lg bg-navy-900 px-3 py-1.5 text-sm font-semibold text-white">Review and approve</Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {r.deadlines.length > 0 && (
        <div>
          <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-navy-900"><CalendarClock className="size-4" aria-hidden /> Upcoming payroll deadlines</p>
          <ul className="grid gap-2 text-sm sm:grid-cols-2" data-testid="portal-deadlines">
            {r.deadlines.map((d) => <li key={d.cycleId} className="rounded-lg bg-ivory-100 px-3 py-2">Pay date <strong>{fmtDay(d.payDate)}</strong> · hours by {fmtDay(d.hoursDue)} · approval by {fmtDay(d.approvalDue)}</li>)}
          </ul>
        </div>
      )}

      {r.documents.length > 0 && (
        <div>
          <p className="mb-2 text-sm font-semibold text-navy-900">Payroll documents from the office</p>
          <ul className="space-y-1 text-sm">{r.documents.map((doc) => <li key={doc.id}><a href={linkFor(doc.id)} className="inline-flex items-center gap-1.5 font-semibold text-navy-900 underline"><FileText className="size-4" aria-hidden /> {doc.title}</a></li>)}</ul>
        </div>
      )}
    </section>
  );
}
