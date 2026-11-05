import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Button, Card, Field, Notice, PageHeader } from "@/components/ui";
import { correctAccessReviewAction } from "@/app/actions/access-review";
import { assertOwner, requireOffice } from "@/lib/auth/owner";
import { getAccessReview } from "@/lib/services/access-review";
import { fmtDateTime } from "@/lib/format";

export const metadata = { title: "Edit access review" };

/**
 * Correct a completed access review (owner only). Only the vendor answers, the summary and the
 * findings can change; each save is kept as a numbered revision with the reason, and the
 * completion date (and so the 90-day schedule) never moves.
 */
export default async function EditAccessReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { actor, access } = await requireOffice();
  if (!access.isOwner) notFound();
  await assertOwner(actor).catch(() => notFound());
  const { id } = await params;
  const r = await getAccessReview(actor, id);
  if (!r) notFound();
  const action = correctAccessReviewAction.bind(null, r.id);

  return (
    <>
      <PageHeader
        title="Edit access review"
        subtitle={`Completed ${fmtDateTime(r.completedAt)} by ${r.reviewerName}.${r.lastCorrection ? ` Last updated ${fmtDateTime(r.lastCorrection.editedAt)} by ${r.lastCorrection.editedByName} (revision ${r.revision}).` : ""}`}
      />
      <div className="mb-4">
        <Link href={`/owner/access-review/reviews/${r.id}`} className="text-sm font-semibold text-navy-900 underline decoration-gold-500 underline-offset-4">← Back to the record</Link>
      </div>
      <Notice tone="info" title="What a correction changes">
        You can correct the vendor answers, the summary and the findings. The staff snapshot, the completion date and the reviewer stay exactly as recorded, the next review stays due 90 days after the original completion, and the values before your change are kept in the record&apos;s correction history.
      </Notice>

      <Card className="mt-5" title="Correct this review">
        <ActionForm action={action}>
          <input type="hidden" name="expectedRevision" value={r.revision} />
          <ul className="divide-y divide-ivory-200 rounded-xl border border-ivory-200" data-testid="edit-vendor-checklist">
            {r.vendors.map((v) => (
              <li key={v.key} className="grid gap-2 p-3 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] lg:items-center">
                <input type="hidden" name="vendorKey" value={v.key} />
                <p className="min-w-0 font-semibold text-navy-900">{v.label}</p>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                  <label className="inline-flex min-h-10 items-center gap-2"><input type="checkbox" name={`appropriate:${v.key}`} defaultChecked={v.appropriate} className="size-4 accent-navy-900" /> Access still appropriate</label>
                  <label className="inline-flex min-h-10 items-center gap-2"><input type="checkbox" name={`twoStep:${v.key}`} defaultChecked={v.twoStep} className="size-4 accent-navy-900" /> Two-step verification on</label>
                </div>
                <input name={`note:${v.key}`} defaultValue={v.note} maxLength={1000} placeholder="Note (optional)" aria-label={`${v.label} note`} className="input" />
              </li>
            ))}
          </ul>
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <Field label="Summary (required)">
              <textarea name="summary" required minLength={3} maxLength={5000} rows={4} defaultValue={r.summary} className="input" />
            </Field>
            <Field label="Findings and changes made">
              <textarea name="findings" maxLength={10000} rows={4} defaultValue={r.findings ?? ""} className="input" />
            </Field>
          </div>
          <div className="mt-4">
            <Field label="Reason for correction (required)" hint="A short note kept with this revision, e.g. “GitHub two-step was confirmed after the review.”">
              <input name="reason" required minLength={3} maxLength={500} className="input" data-testid="correction-reason" />
            </Field>
          </div>
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <Link href={`/owner/access-review/reviews/${r.id}`} className="inline-flex min-h-10 items-center rounded-lg px-4 py-2 text-sm font-semibold text-navy-900 hover:bg-navy-50">Cancel</Link>
            <Button type="submit" data-testid="save-correction">Save correction</Button>
          </div>
        </ActionForm>
      </Card>
    </>
  );
}
