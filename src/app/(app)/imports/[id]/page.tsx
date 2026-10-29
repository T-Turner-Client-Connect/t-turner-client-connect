import Link from "next/link";
import { notFound } from "next/navigation";
import type { ImportMatch } from "@prisma/client";
import { ActionForm } from "@/components/action-form";
import { DecisionSelect } from "@/components/decision-select";
import { Badge, Button, buttonClass, Card, Notice, PageHeader } from "@/components/ui";
import { commitImportAction, discardImportAction } from "@/app/actions/imports";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import type { CleanRow } from "@/lib/import/rows";
import { formatPhone } from "@/lib/normalize";
import { fmtDateTime } from "@/lib/format";

export const metadata = { title: "Review import" };

const MATCH_LABEL: Record<ImportMatch, { text: string; tone: "green" | "navy" | "gold" | "red" }> = {
  NEW: { text: "New client", tone: "green" },
  MATCH: { text: "Matches existing", tone: "navy" },
  AMBIGUOUS: { text: "Needs review", tone: "gold" },
  ERROR: { text: "Error", tone: "red" },
};
const PAGE = 100;

export default async function ImportReviewPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ show?: string; page?: string }> }) {
  await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  const batch = await prisma.importBatch.findUnique({ where: { id }, include: { importedBy: { select: { name: true } } } });
  if (!batch) notFound();
  const show = (["NEW", "MATCH", "AMBIGUOUS", "ERROR"] as const).find((m) => m === sp.show);
  const page = Math.max(1, Number(sp.page) || 1);
  const [counts, rows, undecided] = await Promise.all([
    prisma.importRow.groupBy({ by: ["match"], where: { batchId: id }, _count: true }),
    prisma.importRow.findMany({ where: { batchId: id, ...(show ? { match: show } : {}) }, orderBy: { rowNumber: "asc" }, skip: (page - 1) * PAGE, take: PAGE }),
    prisma.importRow.count({ where: { batchId: id, decision: null } }),
  ]);
  const countOf = (m: ImportMatch) => counts.find((c) => c.match === m)?._count ?? 0;
  const total = counts.reduce((n, c) => n + c._count, 0);
  const candidateIds = Array.from(new Set(rows.flatMap((r) => [...r.candidateIds, ...(r.resultClientId ? [r.resultClientId] : [])])));
  const candidates = new Map(
    (await prisma.client.findMany({ where: { id: { in: candidateIds } }, select: { id: true, displayName: true, email: true, phoneNormalized: true, archivedAt: true } })).map((c) => [c.id, c]),
  );
  const open = batch.status === "REVIEW";
  const filtered = show ? countOf(show) : total;

  return (
    <>
      <PageHeader
        title={open ? "Review import" : "Import results"}
        subtitle={`${batch.fileName} · ${batch.source} · ${batch.importedBy.name} · ${fmtDateTime(batch.createdAt)}`}
      />
      {batch.status === "COMMITTED" && (
        <div className="mb-4">
          <Notice tone="success" title="Import complete">
            {batch.createdCount} created, {batch.updatedCount} updated, {batch.skippedCount} skipped on {fmtDateTime(batch.committedAt)}. Imported contacts have no messaging
            permissions until you record them. No messages were sent. The staged contact data has been cleared.
          </Notice>
        </div>
      )}
      {batch.status === "DISCARDED" && <div className="mb-4"><Notice tone="info">This import was discarded. Nothing was changed.</Notice></div>}

      <div className="mb-4 flex flex-wrap gap-2">
        <Link href={`/imports/${id}`} className={buttonClass(!show ? "primary" : "secondary")}>All ({total})</Link>
        {(["AMBIGUOUS", "ERROR", "NEW", "MATCH"] as const).map((m) => (
          <Link key={m} href={`/imports/${id}?show=${m}`} className={buttonClass(show === m ? "primary" : "secondary")}>
            {MATCH_LABEL[m].text} ({countOf(m)})
          </Link>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-2 lg:col-span-2">
          {rows.map((r) => {
            const d = r.data as CleanRow | null;
            const opts = [
              ...(r.match === "ERROR" ? [] : [{ value: "create", label: "Create a new client" }]),
              ...r.candidateIds.map((cid) => ({ value: `update:${cid}`, label: `Update ${candidates.get(cid)?.displayName ?? "existing client"}` })),
              { value: "skip", label: "Skip this row" },
            ];
            const result = r.resultClientId ? candidates.get(r.resultClientId) : null;
            return (
              <div key={r.id} className="rounded-xl border border-navy-100 bg-white p-3 sm:p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs text-slate-500">Row {r.rowNumber}</p>
                    {d ? (
                      <>
                        <p className="font-semibold text-navy-900">{d.displayName}{d.businessName && d.businessName !== d.displayName ? ` · ${d.businessName}` : ""}</p>
                        <p className="text-sm text-slate-700">{[d.email, d.phoneNormalized && formatPhone(d.phoneNormalized), [d.city, d.state].filter(Boolean).join(", ")].filter(Boolean).join(" · ") || "No contact details"}</p>
                      </>
                    ) : result ? (
                      <Link href={`/clients/${result.id}`} className="font-semibold underline">{result.displayName}</Link>
                    ) : (
                      <p className="text-sm text-slate-600">{r.decision === "skip" ? "Skipped" : "—"}</p>
                    )}
                  </div>
                  <Badge tone={MATCH_LABEL[r.match].tone}>{MATCH_LABEL[r.match].text}</Badge>
                </div>
                {(r.errors.length > 0 || r.warnings.length > 0) && (
                  <ul className="mt-2 space-y-0.5 text-sm">
                    {r.errors.map((e) => <li key={e} className="text-red-800">✕ {e}</li>)}
                    {r.warnings.map((w) => <li key={w} className="text-amber-800">! {w}</li>)}
                  </ul>
                )}
                {r.candidateIds.length > 0 && (
                  <ul className="mt-2 space-y-1 text-sm">
                    {r.candidateIds.map((cid) => {
                      const c = candidates.get(cid);
                      return c ? (
                        <li key={cid} className="rounded-md bg-navy-50 px-2 py-1">
                          Existing: <Link className="font-medium underline" href={`/clients/${cid}`} target="_blank">{c.displayName}</Link>
                          <span className="text-slate-600"> · {[c.email, c.phoneNormalized && formatPhone(c.phoneNormalized)].filter(Boolean).join(" · ")}</span>
                          {c.archivedAt && <Badge tone="gray" className="ml-1">Archived</Badge>}
                        </li>
                      ) : null;
                    })}
                  </ul>
                )}
                {open && (
                  <div className="mt-3 max-w-xs">
                    <DecisionSelect rowId={r.id} value={r.decision} options={opts} />
                  </div>
                )}
              </div>
            );
          })}
          {filtered > PAGE && (
            <nav className="flex justify-between pt-2 text-sm" aria-label="Pages">
              {page > 1 ? <Link className={buttonClass("secondary")} href={`/imports/${id}?${show ? `show=${show}&` : ""}page=${page - 1}`}>Previous</Link> : <span />}
              <span>Page {page} of {Math.ceil(filtered / PAGE)}</span>
              {page * PAGE < filtered ? <Link className={buttonClass("secondary")} href={`/imports/${id}?${show ? `show=${show}&` : ""}page=${page + 1}`}>Next</Link> : <span />}
            </nav>
          )}
        </div>

        {open && (
          <div className="space-y-4">
            <Card title="Confirm import">
              <ul className="mb-3 space-y-1 text-sm">
                <li>{countOf("NEW")} new · {countOf("MATCH")} matched · {countOf("AMBIGUOUS")} need review · {countOf("ERROR")} errors</li>
                {undecided > 0 && <li className="font-semibold text-amber-800">{undecided} row(s) still need a decision.</li>}
              </ul>
              <ActionForm action={commitImportAction.bind(null, id)} className="space-y-3" showSuccess={false}>
                <fieldset className="space-y-2 text-sm">
                  <legend className="mb-1 font-semibold text-navy-900">When updating existing clients</legend>
                  <label className="flex items-start gap-2"><input type="radio" name="mode" value="fill_blanks" defaultChecked className="mt-1 accent-navy-900" /> Only fill in blank fields (safest)</label>
                  <label className="flex items-start gap-2"><input type="radio" name="mode" value="overwrite" className="mt-1 accent-navy-900" /> Replace with values from the file</label>
                </fieldset>
                <p className="text-xs text-slate-600">Tags, services and groups are added, never removed. Opt-outs and permission history are never changed by an import.</p>
                <Button type="submit" disabled={undecided > 0} className="w-full">Import {total - countOf("ERROR")} rows</Button>
              </ActionForm>
            </Card>
            <ActionForm action={discardImportAction.bind(null, id)} confirm="Discard this import? Nothing will be changed." showSuccess={false}>
              <Button variant="danger" className="w-full">Discard import</Button>
            </ActionForm>
          </div>
        )}
      </div>
    </>
  );
}
