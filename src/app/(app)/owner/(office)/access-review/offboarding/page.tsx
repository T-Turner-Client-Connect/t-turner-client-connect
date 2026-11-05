import { notFound } from "next/navigation";
import clsx from "clsx";
import { CheckCircle2, Circle, UserMinus } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { AccessReviewNav } from "@/components/owner/access-review-nav";
import { Badge, Button, Card, EmptyState, Field, Notice, PageHeader } from "@/components/ui";
import { offboardStaffAction, offboardingItemAction } from "@/app/actions/access-review";
import { requireOffice } from "@/lib/auth/owner";
import { offboardingBoard } from "@/lib/services/access-review";
import { offboardingChecklist } from "@/lib/access-review";
import { chicagoToday } from "@/lib/dates";
import { labelOf } from "@/lib/permissions";
import { fmtDate, fmtDateTime } from "@/lib/format";

export const metadata = { title: "Offboarding" };

const grantLabel = (k: string) => (k.startsWith("legacy:") ? `Older grant: ${k.slice(7)}` : labelOf(k));

export default async function OffboardingPage() {
  const { actor, access } = await requireOffice();
  if (!access.isOwner) notFound();
  const { candidates, history } = await offboardingBoard(actor);
  const checklist = offboardingChecklist();

  return (
    <>
      <PageHeader title="Access review" subtitle="Offboard staff who leave or change jobs: their Client Connect access ends at once, and everything outside Client Connect becomes a checklist for you." />
      <AccessReviewNav current="offboarding" />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card title={<span className="flex items-center gap-2"><UserMinus className="size-5 text-gold-600" aria-hidden /> Offboard a staff member</span>}>
          {candidates.length === 0 ? (
            <p className="text-sm text-slate-600">There are no other active staff accounts.</p>
          ) : (
            <ActionForm action={offboardStaffAction} resetOnSuccess confirm="Offboard this staff member now? Their Client Connect account is deactivated immediately, every session ends and all permission grants are removed.">
              <div className="space-y-3">
                <Field label="Staff member">
                  <select name="userId" required className="input" defaultValue="">
                    <option value="" disabled>Choose…</option>
                    {candidates.map((c) => (
                      <option key={c.id} value={c.id}>{c.name} ({c.email}) · {c.role === "ADMIN" ? "Admin" : "Staff"}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Reason (required)" hint="Kept on this record only — never on the tasks or the shared activity log.">
                  <textarea name="reason" required minLength={3} maxLength={2000} rows={3} className="input" placeholder="e.g. Left the firm; last day Friday." />
                </Field>
                <Field label="Effective date (required)" hint="Client Connect access ends now regardless; the checklist tasks are due on this date.">
                  <input type="date" name="effectiveDate" required defaultValue={chicagoToday()} className="input" />
                </Field>
                <Button type="submit" variant="danger" data-testid="offboard-submit">Offboard now</Button>
              </div>
            </ActionForm>
          )}
          <p className="mt-4 text-xs text-slate-600">For a transfer (new job, same firm), change their role in Settings → Team and their grants in Settings → Staff Access &amp; Permissions instead; both changes appear in the access review.</p>
        </Card>

        <Card title="What happens">
          <ul className="list-disc space-y-1 pl-5 text-sm text-navy-900">
            <li><strong>Automatic, in Client Connect:</strong> the account is deactivated and every signed-in session ends; all Staff Access &amp; Permissions grants and older per-person grants are removed (each recorded in the permission history); open invitations and password-reset links are cancelled; they come off the appointment calendar.</li>
            <li><strong>Checklist, outside Client Connect:</strong> one high-priority task for you per line below. Client Connect can&apos;t change these systems for you.</li>
          </ul>
          <ol className="mt-3 list-decimal space-y-0.5 pl-5 text-xs text-slate-700">
            {checklist.map((c) => <li key={c.key}>{c.label}</li>)}
          </ol>
        </Card>
      </div>

      <Card className="mt-5" title="Offboarding history">
        {history.length === 0 ? (
          <EmptyState title="Nobody has been offboarded">Each offboarding appears here with its checklist.</EmptyState>
        ) : (
          <ul className="space-y-4" data-testid="offboarding-history">
            {history.map((o) => (
              <li key={o.id} className="rounded-xl border border-ivory-200 p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-semibold text-navy-900">{o.userName} <span className="font-normal text-slate-600">· {o.userEmail} · {o.userRole === "ADMIN" ? "Admin" : "Staff"}</span></p>
                    <p className="text-sm text-slate-700">Effective {fmtDate(o.effectiveDate)} · recorded {fmtDateTime(o.createdAt)} by {o.offboardedByName}</p>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700"><span className="font-semibold">Reason:</span> {o.reason}</p>
                    <p className="mt-1 text-xs text-slate-600">
                      {o.sessionsEnded} session{o.sessionsEnded === 1 ? "" : "s"} ended · {o.removedGrants.length ? `removed: ${o.removedGrants.map(grantLabel).join("; ")}` : "no grants to remove"}
                    </p>
                  </div>
                  <Badge tone={o.done === o.total ? "green" : "amber"}>{o.done} of {o.total} done</Badge>
                </div>
                <ul className="mt-3 divide-y divide-ivory-200 rounded-lg border border-ivory-200">
                  {o.items.map((i) => (
                    <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                      <span className={clsx("flex min-w-0 flex-1 items-start gap-2", i.done && "text-slate-600")}>
                        {i.done ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-700" aria-hidden /> : <Circle className="mt-0.5 size-4 shrink-0 text-gold-600" aria-hidden />}
                        <span>{i.label}{i.done && i.completedAt ? <span className="block text-xs">Done {fmtDateTime(i.completedAt)}</span> : null}<span className="sr-only">{i.done ? " (done)" : " (not done)"}</span></span>
                      </span>
                      {i.missing ? (
                        <span className="text-xs text-slate-600">Task deleted</span>
                      ) : (
                        <ActionForm action={offboardingItemAction.bind(null, i.id, !i.done)} showSuccess={false}>
                          <button type="submit" className="min-h-10 rounded-lg border border-ivory-200 px-3 text-xs font-semibold text-navy-900 hover:border-navy-700">{i.done ? "Reopen" : "Mark done"}</button>
                        </ActionForm>
                      )}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {history.some((o) => o.done < o.total) && (
        <div className="mt-4">
          <Notice tone="warn">Open checklist items also appear on Tasks, assigned to you.</Notice>
        </div>
      )}
    </>
  );
}
