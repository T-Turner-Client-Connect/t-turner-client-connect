import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { TaxRowDecision } from "@/components/tax-row-decision";
import { Badge, Button, Card, Notice, PageHeader } from "@/components/ui";
import { commitTaxImportAction } from "@/app/actions/tax";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { FILING_LABELS, jurisdictionLabel } from "@/lib/tax/normalize";
import { fmtDate, fmtDateTime } from "@/lib/format";

export const metadata = { title: "Review e-file import" };

const MATCH: Record<string, { label: string; tone: "green" | "navy" | "gold" | "red" | "gray" | "amber" }> = {
  MATCH: { label: "Updates existing filing", tone: "navy" },
  NEW_FILING: { label: "Creates filing", tone: "green" },
  AMBIGUOUS: { label: "Needs review", tone: "gold" },
  NO_CLIENT: { label: "No matching client", tone: "amber" },
  STALE: { label: "Older than recorded — skipped", tone: "gray" },
  FILTERED: { label: "Status not selected", tone: "gray" },
  ERROR: { label: "Error", tone: "red" },
};

type Row = { clientRef: string | null; displayName: string | null; taxYear: number | null; returnType: string | null; jurisdiction: string | null; filingType: string; status: keyof typeof FILING_LABELS | null; eventAt: string | null; submissionId: string | null };

export default async function TaxImportReview({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const { id } = await params;
  const batch = await prisma.taxImportBatch.findUnique({ where: { id }, include: { rows: { orderBy: { rowNumber: "asc" } } } });
  if (!batch) notFound();
  const clientIds = Array.from(new Set(batch.rows.map((r) => r.clientId).filter((v): v is string => !!v)));
  const clients = new Map((await prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, displayName: true } })).map((c) => [c.id, c.displayName]));
  const allClients = batch.rows.some((r) => r.match === "NO_CLIENT" || r.match === "AMBIGUOUS")
    ? await prisma.client.findMany({ where: { archivedAt: null }, select: { id: true, displayName: true }, orderBy: { displayName: "asc" }, take: 3000 })
    : [];
  const open = batch.status === "REVIEW";
  const undecided = batch.rows.filter((r) => !r.decision).length;
  return (
    <>
      <PageHeader title={open ? "Review e-file import" : "E-file import results"} subtitle={`${batch.fileName} · ${batch.source} · ${fmtDateTime(batch.createdAt)} · importing: ${batch.statusFilter.map((s) => FILING_LABELS[s as keyof typeof FILING_LABELS]).join(", ")}`} />
      {!open && <div className="mb-4"><Notice tone="success">Applied {batch.appliedCount}, skipped {batch.skippedCount} on {fmtDateTime(batch.committedAt)}. Source rows are kept for the record. Nothing was published to clients.</Notice></div>}
      <div className="grid gap-4 lg:grid-cols-3">
        <ul className="space-y-2 lg:col-span-2">
          {batch.rows.map((r) => {
            const d = r.data as Row | null;
            const opts = [
              ...(r.clientId && !r.errors.length && !["STALE", "FILTERED"].includes(r.match) ? [{ value: "apply", label: `Apply to ${clients.get(r.clientId) ?? "client"}` }] : []),
              ...(!r.errors.length && (r.match === "NO_CLIENT" || r.match === "AMBIGUOUS") ? allClients.map((c) => ({ value: `apply:${c.id}`, label: `Apply to ${c.displayName}` })) : []),
              { value: "skip", label: "Skip" },
            ];
            return (
              <li key={r.id} className="rounded-2xl border border-ivory-200 bg-white p-4 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-xs text-slate-500">Row {r.rowNumber} · client ID {d?.clientRef ?? "—"}</p>
                    <p className="font-semibold text-navy-900">
                      {r.clientId ? <Link className="underline" href={`/clients/${r.clientId}?tab=taxes`}>{clients.get(r.clientId)}</Link> : d?.displayName ?? "Unknown"}
                    </p>
                    <p className="text-slate-700">
                      {d?.taxYear} · {d?.returnType} · {d?.jurisdiction ? jurisdictionLabel(d.jurisdiction) : "?"} · {d?.filingType?.toLowerCase()} · <strong>{d?.status ? FILING_LABELS[d.status] : "?"}</strong>
                      {d?.eventAt && ` on ${fmtDate(new Date(d.eventAt))}`}{d?.submissionId && ` · ${d.submissionId}`}
                    </p>
                  </div>
                  <Badge tone={MATCH[r.match].tone}>{r.applied ? "Applied" : MATCH[r.match].label}</Badge>
                </div>
                {[...r.errors.map((e) => ["✕", e, "text-red-800"]), ...r.warnings.map((w) => ["!", w, "text-amber-800"])].map(([i, t, c]) => <p key={t} className={c}>{i} {t}</p>)}
                {open && <div className="mt-2 max-w-sm"><TaxRowDecision rowId={r.id} value={r.decision} options={opts} /></div>}
              </li>
            );
          })}
        </ul>
        {open && (
          <Card title="Confirm">
            {undecided > 0 && <p className="mb-2 text-sm font-semibold text-amber-800">{undecided} row(s) need a decision.</p>}
            <ActionForm action={commitTaxImportAction.bind(null, id)} className="space-y-3">
              <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="linkIds" defaultChecked className="mt-1 accent-navy-900" /> Save the TaxAct client ID on clients I matched by hand</label>
              <Button type="submit" disabled={undecided > 0} className="w-full">Apply statuses</Button>
              <p className="text-xs text-slate-600">Older rows never overwrite newer verified statuses. Federal and state filings update separately. Tax updates never add clients to campaigns.</p>
            </ActionForm>
          </Card>
        )}
      </div>
    </>
  );
}
