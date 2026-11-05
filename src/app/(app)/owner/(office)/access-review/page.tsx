import Link from "next/link";
import { notFound } from "next/navigation";
import clsx from "clsx";
import { CalendarClock, History, ShieldCheck } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { AccessReviewNav } from "@/components/owner/access-review-nav";
import { Badge, Button, Card, EmptyState, Field, PageHeader } from "@/components/ui";
import { completeAccessReviewAction } from "@/app/actions/access-review";
import { requireOffice } from "@/lib/auth/owner";
import { accessReviewBoard, type StaffSnapshotRow } from "@/lib/services/access-review";
import { REVIEW_INTERVAL_DAYS, VENDORS } from "@/lib/access-review";
import { fmtDate, fmtDateTime } from "@/lib/format";

export const metadata = { title: "Access review" };

const roleLabel = (r: string) => (r === "ADMIN" ? "Admin" : "Staff");

function Grants({ s }: { s: StaffSnapshotRow }) {
  const all = [...s.grants.map((g) => g.label), ...s.otherGrants];
  if (!all.length) return <span className="text-slate-600">No Owner&apos;s Office permissions</span>;
  return (
    <ul className="flex flex-wrap gap-1">
      {all.map((g) => (
        <li key={g} className="rounded-md bg-navy-50 px-2 py-0.5 text-xs text-navy-900 ring-1 ring-navy-100">{g}</li>
      ))}
    </ul>
  );
}

function YesNo({ ok, yes = "Yes", no = "No" }: { ok: boolean; yes?: string; no?: string }) {
  return <Badge tone={ok ? "green" : "red"}>{ok ? yes : no}</Badge>;
}

export default async function AccessReviewPage() {
  // Tabitha's own review: same rule as the other owner-bound pages (404 for everyone else).
  const { actor, access } = await requireOffice();
  if (!access.isOwner) notFound();
  const board = await accessReviewBoard(actor);
  const { status, last, staff, changes, history } = board;
  const active = staff.filter((s) => s.active);

  return (
    <>
      <PageHeader title="Access review" subtitle="Who can sign in to Client Connect, what each person can open, and the firm's other accounts — reviewed every quarter and kept on file." />
      <AccessReviewNav current="review" />

      <div
        className={clsx("mb-5 flex flex-wrap items-center gap-3 rounded-2xl p-5 sm:p-6", status.due ? "bg-amber-50 ring-1 ring-amber-200" : "bg-navy-900 text-white")}
        data-testid="review-status"
        data-due={status.due ? "true" : "false"}
      >
        <CalendarClock className={clsx("size-7 shrink-0", status.due ? "text-amber-700" : "text-gold-500")} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className={clsx("font-serif text-xl font-bold", status.due ? "text-amber-900" : "text-white")}>
            {!status.dueAt ? "First review due now" : status.overdue ? `Review overdue since ${fmtDate(status.dueAt)}` : status.due ? "Review due today" : `Next review due ${fmtDate(status.dueAt)}`}
          </p>
          <p className={clsx("mt-1 text-sm", status.due ? "text-amber-900" : "text-navy-100")}>
            {last ? `Last completed ${fmtDateTime(last.completedAt)} by ${last.reviewerName}.` : "No access review has been completed yet."} Reviews are due every {REVIEW_INTERVAL_DAYS} days; when one is due you get a high-priority task.
          </p>
        </div>
      </div>

      <Card title={<span className="flex items-center gap-2"><ShieldCheck className="size-5 text-gold-600" aria-hidden /> Staff accounts ({active.length} active, {staff.length - active.length} inactive)</span>}>
        <p className="mb-3 text-sm text-slate-600">Every Client Connect staff account as it stands now. Completing the review saves this table exactly as shown. Permission changes are made in Settings → Staff Access &amp; Permissions; offboard someone who has left from the Offboarding tab.</p>
        {/* Phones: one card per person. */}
        <ul className="space-y-3 md:hidden" data-testid="staff-snapshot-cards">
          {staff.map((s) => (
            <li key={s.id} className={clsx("rounded-xl border border-ivory-200 p-3", !s.active && "bg-slate-50")}>
              <p className="font-semibold text-navy-900">{s.name} {s.isOwner && <Badge tone="gold">Owner</Badge>}</p>
              <p className="break-all text-sm text-slate-600">{s.email}</p>
              <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                <dt className="text-slate-600">Role</dt><dd>{roleLabel(s.role)}</dd>
                <dt className="text-slate-600">Status</dt><dd><YesNo ok={s.active} yes="Active" no="Inactive" /></dd>
                <dt className="text-slate-600">Two-step</dt><dd><YesNo ok={s.twoStep} yes="Enrolled" no="Not enrolled" /></dd>
                <dt className="text-slate-600">Last sign-in</dt><dd>{s.lastLoginAt ? fmtDateTime(new Date(s.lastLoginAt)) : "Never"}</dd>
                <dt className="text-slate-600">Created</dt><dd>{fmtDate(new Date(s.createdAt))}</dd>
              </dl>
              <div className="mt-2"><Grants s={s} /></div>
            </li>
          ))}
        </ul>
        <div className="hidden overflow-x-auto md:block">
          <table className="w-full text-left text-sm" data-testid="staff-snapshot">
            <thead className="border-b border-ivory-200 text-xs uppercase tracking-wide text-slate-600">
              <tr>
                <th className="py-2 pr-3">Name</th>
                <th className="py-2 pr-3">Role</th>
                <th className="py-2 pr-3">Status</th>
                <th className="py-2 pr-3">Permission grants</th>
                <th className="py-2 pr-3">Two-step</th>
                <th className="py-2 pr-3">Last sign-in</th>
                <th className="py-2">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ivory-200">
              {staff.map((s) => (
                <tr key={s.id} className={clsx("align-top", !s.active && "bg-slate-50 text-slate-700")}>
                  <td className="py-2 pr-3">
                    <p className="font-semibold text-navy-900">{s.name} {s.isOwner && <Badge tone="gold">Owner</Badge>}</p>
                    <p className="text-slate-600">{s.email}</p>
                  </td>
                  <td className="py-2 pr-3">{roleLabel(s.role)}</td>
                  <td className="py-2 pr-3"><YesNo ok={s.active} yes="Active" no="Inactive" /></td>
                  <td className="max-w-md py-2 pr-3"><Grants s={s} /></td>
                  <td className="py-2 pr-3"><YesNo ok={s.twoStep} /></td>
                  <td className="whitespace-nowrap py-2 pr-3">{s.lastLoginAt ? fmtDateTime(new Date(s.lastLoginAt)) : "Never"}</td>
                  <td className="whitespace-nowrap py-2">{fmtDate(new Date(s.createdAt))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="mt-5" title={<span className="flex items-center gap-2"><History className="size-5 text-gold-600" aria-hidden /> Access changes {last ? "since the last review" : "on record"}</span>}>
        {changes.length === 0 ? (
          <p className="text-sm text-slate-600">No permission, role or account changes {last ? "since the last review" : "recorded yet"}.</p>
        ) : (
          <ul className="divide-y divide-ivory-200 text-sm" data-testid="access-changes">
            {changes.map((c, i) => (
              <li key={i} className="py-2">
                <span className="font-semibold text-navy-900">{c.userName}</span>: {c.text}
                <span className="block text-xs text-slate-600">{fmtDateTime(new Date(c.at))} · by {c.actorName}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="mt-5" title="Complete this quarter's review">
        <ActionForm action={completeAccessReviewAction} resetOnSuccess>
          <p className="mb-3 text-sm text-slate-600">Sign in to each account yourself and check who has access. Nothing here is sent to these services and no passwords are stored — tick what you confirmed and note anything you changed.</p>
          <ul className="divide-y divide-ivory-200 rounded-xl border border-ivory-200" data-testid="vendor-checklist">
            {VENDORS.map((v) => (
              <li key={v.key} className="grid gap-2 p-3 lg:grid-cols-[minmax(0,1.2fr)_auto_minmax(0,1fr)] lg:items-center">
                <div className="min-w-0">
                  <p className="font-semibold text-navy-900">{v.label}</p>
                  <p className="text-xs text-slate-600">{v.what}</p>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                  <label className="inline-flex min-h-10 items-center gap-2"><input type="checkbox" name={`appropriate:${v.key}`} className="size-4 accent-navy-900" /> Access still appropriate</label>
                  <label className="inline-flex min-h-10 items-center gap-2"><input type="checkbox" name={`twoStep:${v.key}`} className="size-4 accent-navy-900" /> Two-step verification on</label>
                </div>
                <input name={`note:${v.key}`} maxLength={1000} placeholder="Note (optional)" aria-label={`${v.label} note`} className="input" />
              </li>
            ))}
          </ul>
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <Field label="Summary (required)" hint="What you reviewed and your conclusion, e.g. “All four accounts appropriate; two-step on everywhere.”">
              <textarea name="summary" required minLength={3} maxLength={5000} rows={4} className="input" />
            </Field>
            <Field label="Findings and changes made" hint="Access you removed or changed because of this review (optional).">
              <textarea name="findings" maxLength={10000} rows={4} className="input" />
            </Field>
          </div>
          <div className="mt-4 flex justify-end">
            <Button type="submit" data-testid="complete-review">Complete review</Button>
          </div>
        </ActionForm>
      </Card>

      <Card className="mt-5" title="Past reviews">
        {history.length === 0 ? (
          <EmptyState title="No reviews yet">Your completed reviews appear here, each with a printable record.</EmptyState>
        ) : (
          <ul className="divide-y divide-ivory-200" data-testid="review-history">
            {history.map((h) => (
              <li key={h.id} className="flex flex-wrap items-start justify-between gap-2 py-3">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-navy-900">{fmtDateTime(h.completedAt)} · {h.reviewerName}</p>
                  <p className="line-clamp-2 text-sm text-slate-700">{h.summary}</p>
                  <p className="text-xs text-slate-600">{h.staffCount} staff account{h.staffCount === 1 ? "" : "s"} · {h.flagged ? `${h.flagged} vendor account${h.flagged === 1 ? "" : "s"} flagged` : "every vendor account confirmed"}</p>
                </div>
                <Link href={`/owner/access-review/reviews/${h.id}`} className="text-sm font-semibold text-navy-900 underline decoration-gold-500 underline-offset-4">View / print</Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
