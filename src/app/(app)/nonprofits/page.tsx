import Link from "next/link";
import { connection } from "next/server";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, EmptyState, Field, PageHeader } from "@/components/ui";
import { correctFilingAction, markFiledAction, outcomeAction, saveNonprofitAction } from "@/app/actions/nonprofits";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { BUCKETS, FILING_SERVICE, IRS_SOURCES, NONPROFIT_FORMS, nonprofitDashboard } from "@/lib/services/nonprofits";
import { FILING_LABELS } from "@/lib/tax/normalize";
import { fmtIso } from "@/lib/tax/deadlines";
import { MONTHS } from "@/lib/services/bookkeeping";
import { fmtDateTime } from "@/lib/format";

export const metadata = { title: "Nonprofit filings" };

const VIEWS = {
  all: "All",
  ours: "Our nonprofit filing clients",
  needs: "Needs information",
  due: "Upcoming/overdue filings",
} as const;

export default async function NonprofitsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await connection();
  await requireUser();
  const sp = await searchParams;
  const view = (sp.view && sp.view in VIEWS ? sp.view : "all") as keyof typeof VIEWS;
  const all = await nonprofitDashboard();
  const rows = all.filter((r) =>
    view === "ours" ? r.service === "YES"
    : view === "needs" ? r.bucket === "NOT_SET_UP" || r.review.length > 0
    : view === "due" ? r.service === "YES" && ["OVERDUE", "DUE", "UPCOMING"].includes(r.bucket)
    : true);
  // Owners who said they have a nonprofit whose organization record isn't linked yet.
  const unlinked = view === "needs" || view === "all"
    ? await prisma.client.findMany({ where: { hasNonprofit: "YES", archivedAt: null, ownsBusinesses: { none: { business: { clientType: "NONPROFIT" } } } }, select: { id: true, displayName: true }, orderBy: { displayName: "asc" }, take: 100 })
    : [];
  const docs = await prisma.document.findMany({
    where: { clientId: { in: rows.map((r) => r.client.id) }, deletedAt: null, category: { in: ["TAXES", "OTHER"] } },
    select: { id: true, clientId: true, title: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    take: 500,
  });
  const counts = Object.fromEntries(Object.keys(BUCKETS).map((b) => [b, all.filter((r) => r.bucket === b).length]));

  return (
    <>
      <PageHeader title="Nonprofit filings" subtitle="Annual federal returns for the nonprofit organizations whose filings TTurner handles: the form each one files, its deadline, and filed vs. accepted kept separate. Nonprofit Interest (formation inquiries) isn't listed here." />
      <nav className="mb-3 flex flex-wrap gap-2" data-testid="np-views">
        {Object.entries(VIEWS).map(([k, v]) => (
          <Link key={k} href={k === "all" ? "/nonprofits" : `/nonprofits?view=${k}`} aria-current={view === k ? "page" : undefined} className={`rounded-lg px-3 py-1.5 text-sm font-semibold ${view === k ? "bg-navy-900 text-white" : "border border-navy-200 text-navy-900"}`}>{v}</Link>
        ))}
      </nav>
      {unlinked.length > 0 && (
        <p className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="np-unlinked">
          Has a nonprofit, organization not linked yet:{" "}
          {unlinked.map((c, i) => <span key={c.id}>{i > 0 && ", "}<Link className="underline" href={`/clients/${c.id}`}>{c.displayName}</Link></span>)}
        </p>
      )}
      <div className="mb-4 flex flex-wrap gap-2" data-testid="np-counts">
        {(["OVERDUE", "DUE", "NOT_SET_UP", "SUBMITTED", "UPCOMING", "COMPLETED"] as const).map((b) => <Badge key={b} tone={BUCKETS[b].tone}>{BUCKETS[b].label}: {counts[b]}</Badge>)}
      </div>
      <p className="mb-4 text-xs text-slate-600">
        Rules from the IRS (checked Oct 31, 2026): who files which form, due the 15th day of the 5th month after the tax year ends (next business day if a weekend or holiday), and Form 8868&apos;s automatic 6-month extension for 990, 990-EZ and 990-PF — <strong>not</strong> 990-N. Sources:{" "}
        {IRS_SOURCES.map((u, i) => <span key={u}>{i > 0 && " · "}<a className="underline" href={u} target="_blank" rel="noopener noreferrer">IRS {i + 1}</a></span>)}. Three consecutive years without filing automatically revokes exempt status.
      </p>
      {rows.length === 0 && <EmptyState title="Nothing here">Add a nonprofit from any client record (Overview → Nonprofit), then set “Does TTurner handle its annual filings?” to Yes.</EmptyState>}
      <div className="space-y-4">
        {rows.map((r) => {
          const name = r.client.businessName || r.client.displayName;
          const clientDocs = docs.filter((d) => d.clientId === r.client.id);
          const form = r.profile?.formType ? NONPROFIT_FORMS[r.profile.formType as keyof typeof NONPROFIT_FORMS] : null;
          return (
            <div key={r.client.id} id={`np-${r.client.id}`} className="scroll-mt-6" data-testid="np-card" data-client={name}>
            <Card title={<span data-testid="np-row">{name} <span className="text-sm font-normal text-slate-600">· {r.taxYear ? `tax year ${r.taxYear}` : "tax year unknown"}</span></span>} actions={<span data-testid="np-bucket"><Badge tone={BUCKETS[r.bucket].tone}>{BUCKETS[r.bucket].label}</Badge></span>}>
              <dl className="mb-3 grid gap-2 text-sm sm:grid-cols-5">
                <div><dt className="text-xs uppercase text-slate-500">TTurner files it?</dt><dd data-testid="np-service">{r.service ? FILING_SERVICE[r.service] : <span className="text-amber-800">Not recorded</span>} · <Link className="underline" href={`/clients/${r.client.id}`}>change</Link></dd></div>
                <div><dt className="text-xs uppercase text-slate-500">Fiscal year ends</dt><dd>{r.client.fiscalYearEnd ? MONTHS[r.client.fiscalYearEnd - 1] : <span className="text-amber-800">Not recorded</span>}</dd></div>
                <div><dt className="text-xs uppercase text-slate-500">Return</dt><dd>{form ? (r.profile?.formType === "OTHER" ? r.profile.otherForm : form.label) : "Not chosen"}</dd></div>
                <div><dt className="text-xs uppercase text-slate-500">Assigned</dt><dd>{r.client.assignedTo?.name ?? "Unassigned"}</dd></div>
                <div><dt className="text-xs uppercase text-slate-500">Due</dt><dd data-testid="np-due">{r.due && r.days !== null ? <>{fmtIso(r.due, { month: "short", day: "numeric", year: "numeric" })}{r.extended ? " (extended — Form 8868 accepted)" : ""} · {r.days < 0 ? `${-r.days} days late` : `${r.days} days`}</> : "Unknown until the fiscal year-end is recorded"}</dd></div>
              </dl>
              {r.missing.length > 0 && <p className="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="np-missing">Needs review: {r.missing.join(" · ")}{!r.client.fiscalYearEnd && <> — set it on the client&apos;s <Link className="underline" href={`/clients/${r.client.id}?tab=taxes`}>Taxes tab</Link></>}</p>}
              {r.review.length > 0 && <p className="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="np-review">Review: {r.review.join(" · ")}</p>}
              {r.filing && (
                <p className="mb-2 text-sm" data-testid="np-status">
                  Filing status: <strong>{FILING_LABELS[r.filing.filingStatus]}</strong>
                  {r.filing.submittedAt && ` · filed ${fmtDateTime(r.filing.submittedAt)}`}
                  {r.filing.filingReference && ` · confirmation ${r.filing.filingReference}`}
                  {r.filing.acknowledgedAt && r.filing.filingStatus === "ACCEPTED" && ` · accepted ${fmtDateTime(r.filing.acknowledgedAt)}`}
                </p>
              )}
              <div className="grid gap-3 lg:grid-cols-3">
                <details className="rounded-xl bg-ivory-50 p-3 text-sm" open={!r.profile?.formType}>
                  <summary className="cursor-pointer font-semibold">Required return &amp; reminders</summary>
                  <ActionForm action={saveNonprofitAction.bind(null, r.client.id)} className="mt-2 space-y-2">
                    <Field label="Federal return">
                      <select className="input" name="formType" defaultValue={r.profile?.formType ?? ""} required>
                        <option value="" disabled>Choose — don&apos;t assume 990-N</option>
                        {Object.entries(NONPROFIT_FORMS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                      </select>
                    </Field>
                    <ul className="list-disc pl-5 text-xs text-slate-600">{Object.entries(NONPROFIT_FORMS).map(([k, v]) => <li key={k}><strong>{k}:</strong> {v.guide}</li>)}</ul>
                    <Field label="Other filing (if Other)"><input className="input" name="otherForm" defaultValue={r.profile?.otherForm ?? ""} /></Field>
                    <Field label="How you determined it"><input className="input" name="formBasis" required defaultValue={r.profile?.formBasis ?? ""} placeholder="e.g. receipts avg $38k (2023–2025); not a supporting org" /></Field>
                    <Field label="Remind (days before)"><input className="input" name="reminderDays" defaultValue={(r.profile?.reminderDays ?? [60, 30, 7]).join(", ")} /></Field>
                    <label className="flex items-center gap-2"><input type="checkbox" name="notifyClient" defaultChecked={r.profile?.notifyClient ?? false} /> Also remind the client&apos;s owner logins (portal notice)</label>
                    <Button type="submit" variant="secondary">Save</Button>
                  </ActionForm>
                </details>
                {r.taxYear !== null && (<>
                <details className="rounded-xl bg-ivory-50 p-3 text-sm">
                  <summary className="cursor-pointer font-semibold">Mark filed (submitted)</summary>
                  <ActionForm action={markFiledAction.bind(null, r.client.id, r.taxYear!)} className="mt-2 space-y-2" resetOnSuccess>
                    <Field label="Filed on (Central time)"><input className="input" type="datetime-local" name="filedAt" required /></Field>
                    <Field label="Confirmation / submission number"><input className="input" name="confirmation" /></Field>
                    <Field label="…or the acknowledgment uploaded to their file"><select className="input" name="ackDocumentId" defaultValue=""><option value="">—</option>{clientDocs.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}</select></Field>
                    <p className="text-xs text-slate-600">This records <em>Submitted</em> only. It never claims IRS acceptance.</p>
                    <Button type="submit" variant="secondary">Mark filed</Button>
                  </ActionForm>
                </details>
                <details className="rounded-xl bg-ivory-50 p-3 text-sm">
                  <summary className="cursor-pointer font-semibold">Record IRS outcome</summary>
                  <ActionForm action={outcomeAction.bind(null, r.client.id, r.taxYear!)} className="mt-2 space-y-2" resetOnSuccess>
                    <Field label="Outcome"><select className="input" name="outcome" defaultValue="ACCEPTED"><option value="ACCEPTED">Accepted</option><option value="REJECTED">Rejected</option></select></Field>
                    <Field label="Date and time (Central)"><input className="input" type="datetime-local" name="at" required /></Field>
                    <Field label="IRS acknowledgment in their file"><select className="input" name="evidenceDocumentId" defaultValue=""><option value="">—</option>{clientDocs.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}</select></Field>
                    <Field label="…or how you verified it"><input className="input" name="note" placeholder="e.g. Checked IRS acknowledgment in TaxAct E-file Center" /></Field>
                    <Field label="Rejection codes (if rejected)"><input className="input" name="rejectionCodes" /></Field>
                    <Button type="submit" variant="secondary">Record</Button>
                  </ActionForm>
                </details>
                </>)}
              </div>
              {r.filing && (
                <details className="mt-3 text-sm" data-testid="np-history">
                  <summary className="cursor-pointer underline">History &amp; corrections</summary>
                  <ul className="mt-2 space-y-1 text-xs">
                    {r.filing.events.map((e) => <li key={e.id}>{fmtDateTime(e.createdAt)} — {e.fromValue ?? "—"} → {e.toValue}{e.verificationNote ? ` · ${e.verificationNote}` : ""}{e.evidenceDocumentId ? " · acknowledgment attached" : ""}</li>)}
                  </ul>
                  {r.filing.notes && <pre className="mt-2 whitespace-pre-wrap text-xs text-slate-600">{r.filing.notes}</pre>}
                  <ActionForm action={correctFilingAction.bind(null, r.client.id, r.filing.id)} className="mt-2 flex flex-wrap items-end gap-2" resetOnSuccess>
                    <Field label="Corrected confirmation number"><input className="input" name="confirmation" /></Field>
                    <Field label="Reason"><input className="input w-64" name="reason" required /></Field>
                    <Button type="submit" variant="ghost">Log correction</Button>
                  </ActionForm>
                </details>
              )}
              <p className="mt-2 text-xs"><Link className="underline" href={`/clients/${r.client.id}?tab=taxes`}>Open client&apos;s Taxes tab</Link></p>
            </Card>
            </div>
          );
        })}
      </div>
    </>
  );
}
