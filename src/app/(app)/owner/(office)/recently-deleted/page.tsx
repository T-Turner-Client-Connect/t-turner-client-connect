import { notFound } from "next/navigation";
import clsx from "clsx";
import { Trash2 } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { EmptyState, PageHeader } from "@/components/ui";
import { fmtBytes, securityCard } from "@/components/owner/doc-security-bits";
import { requireOffice } from "@/lib/auth/owner";
import { PERMANENT_DELETE_PHRASE, recentlyDeleted } from "@/lib/services/recently-deleted";
import { CATEGORY_LABELS } from "@/lib/services/documents";
import { deletePermanentlyAction, restoreDocumentAction } from "@/app/actions/doc-security";
import { fmtDate, fmtDateTime } from "@/lib/format";

export const metadata = { title: "Recently deleted" };

export default async function RecentlyDeletedPage() {
  const { actor, access } = await requireOffice();
  if (!access.isOwner) notFound();
  const docs = await recentlyDeleted(actor);

  return (
    <>
      <PageHeader title="Recently deleted" subtitle="Deleted documents wait here for 30 days. Clients and staff no longer see them. After 30 days, and only once a successful backup holds the file, the nightly purge removes the file and keeps the record and its history." />
      {docs.length === 0 ? (
        <EmptyState title="Nothing recently deleted">When an Admin deletes a document it appears here, and you can restore it for 30 days.</EmptyState>
      ) : (
        <ul className="space-y-4" data-testid="recently-deleted">
          {docs.map((d) => {
            const daysLeft = d.daysLeft;
            return (
              <li key={d.id} className={securityCard}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="flex items-center gap-2 break-words font-serif text-lg font-bold text-navy-900"><Trash2 className="size-5 shrink-0 text-gold-600" aria-hidden /> {d.title}</h2>
                    <p className="mt-0.5 text-sm text-slate-700">
                      {d.client.displayName} · {CATEGORY_LABELS[d.category]}{d.year ? ` · ${d.year}` : ""} · {fmtBytes(d.file.sizeBytes)}
                    </p>
                    <p className="mt-1 text-sm text-navy-900">
                      Deleted {fmtDateTime(d.deletedAt)} by {d.deletedByName ?? "staff"}{d.deletionReason ? `: “${d.deletionReason}”` : ""}
                    </p>
                    <p className="mt-1 text-xs text-slate-600">
                      {daysLeft ? `Kept until ${fmtDate(d.purgeAfter)} (${daysLeft} day${daysLeft === 1 ? "" : "s"} left)` : "30 days have passed"} ·{" "}
                      <span className={clsx("font-semibold", d.backedUp ? "text-emerald-700" : "text-amber-800")}>{d.backedUp ? "In a successful backup" : "Not in a backup yet — it won't be purged until it is"}</span>
                    </p>
                  </div>
                  <ActionForm action={restoreDocumentAction.bind(null, d.id)} confirm={`Restore “${d.title}”? It goes back to the client's file with the visibility it had before.`}>
                    <button type="submit" className="inline-flex min-h-10 items-center rounded-lg bg-navy-900 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-navy-800">Restore</button>
                  </ActionForm>
                </div>
                <details className="mt-3 border-t border-ivory-200 pt-3">
                  <summary className="cursor-pointer text-sm font-semibold text-red-800">Delete permanently now</summary>
                  <ActionForm action={deletePermanentlyAction.bind(null, d.id)} className="mt-2 grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                    <label className="block text-sm">
                      <span className="mb-1 block font-semibold text-navy-900">Reason</span>
                      <input name="reason" required minLength={3} maxLength={500} className="input w-full" placeholder="e.g. Client asked for it to be destroyed" />
                    </label>
                    <label className="block text-sm">
                      <span className="mb-1 block font-semibold text-navy-900">Type {PERMANENT_DELETE_PHRASE}</span>
                      <input name="confirm" required className="input w-full" autoComplete="off" />
                    </label>
                    <button type="submit" className="inline-flex min-h-10 items-center rounded-lg border border-red-200 bg-white px-4 py-2 text-sm font-semibold text-red-700 hover:bg-red-50">Delete permanently</button>
                  </ActionForm>
                  <p className="mt-2 text-xs text-slate-600">The file is removed now. The record and audit trail stay. Copies already in backups are removed only as the retention policy allows.</p>
                </details>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
