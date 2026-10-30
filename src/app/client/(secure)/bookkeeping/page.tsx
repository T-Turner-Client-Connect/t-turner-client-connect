import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, EmptyState, Notice, PageHeader } from "@/components/ui";
import { portalUploadAction } from "@/app/actions/portal";
import { BK_DOC_TYPES } from "@/lib/services/bookkeeping-clients";
import { requirePortalUser } from "@/lib/portal/session";
import { resolveAccount } from "@/lib/portal/account";
import { prisma } from "@/lib/prisma";
import { MONTHS, PERIOD_LABELS } from "@/lib/services/bookkeeping";
import { downloadToken, REPORT_LABELS } from "@/lib/services/documents";
import { fmtDate } from "@/lib/format";
import { PERIOD_TYPES, reportPeriod, type PeriodType } from "@/lib/bookkeeping-periods";
import { reportCaption } from "@/lib/services/bookkeeping-clients";

export const metadata = { title: "Bookkeeping & requests" };

const TONE = { AWAITING_DOCUMENTS: "amber", IN_PROGRESS: "navy", READY_FOR_REVIEW: "gold", COMPLETE: "green" } as const;

export default async function PortalBookkeeping({ searchParams }: { searchParams: Promise<{ account?: string }> }) {
  const user = await requirePortalUser();
  const { current } = await resolveAccount(user.id, (await searchParams).account);
  if (!current) return null;
  const q = `?account=${current.clientId}`;
  const [periods, looseRequests] = await Promise.all([
    current.canViewBookkeeping
      ? prisma.bookkeepingPeriod.findMany({
          where: { clientId: current.clientId },
          include: {
            documents: { where: { deletedAt: null, visibility: "PUBLISHED", scanStatus: "CLEAN" }, orderBy: { createdAt: "desc" } },
            requests: { where: { status: { not: "CANCELLED" } }, orderBy: { createdAt: "asc" } },
          },
          orderBy: [{ year: "desc" }, { month: "desc" }],
        })
      : [],
    prisma.documentRequest.findMany({ where: { clientId: current.clientId, periodId: null, status: { in: ["OPEN", "SUBMITTED"] } }, orderBy: { createdAt: "desc" } }),
  ]);
  const link = (id: string) => `/api/documents/${downloadToken(id, { portalUserId: user.id })}`;
  const payroll = !!(await prisma.bookkeepingProfile.findUnique({ where: { clientId: current.clientId }, select: { payroll: true } }))?.payroll;
  const fye = (await prisma.client.findUnique({ where: { id: current.clientId }, select: { fiscalYearEnd: true } }))?.fiscalYearEnd ?? null;
  const ORDER = ["FINANCIAL_PACKET", "PROFIT_AND_LOSS", "GROSS_RECEIPTS", "BALANCE_SHEET", "BANK_RECONCILIATION", "SUPPORTING_SCHEDULE", "OTHER_REPORT"];
  const upload = (requestId: string | null, periodId: string | null, label: string) =>
    current.canUpload ? (
      <ActionForm action={portalUploadAction.bind(null, current.clientId)} className="mt-1 flex flex-wrap items-center gap-2" resetOnSuccess>
        {requestId && <input type="hidden" name="requestId" value={requestId} />}
        {periodId && <input type="hidden" name="periodId" value={periodId} />}
        {periodId && !requestId && (
          <select className="input w-auto" name="docType" defaultValue="" aria-label="What is it?">
            <option value="">What is it? (optional)</option>
            {Object.entries(BK_DOC_TYPES).filter(([k]) => k !== "PAYROLL_REPORT" || payroll).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        )}
        <span className="w-full text-xs text-slate-600">Saving to <strong>{current.client.businessName || current.client.displayName}</strong>{label.includes(" for ") ? ` — ${label.split(" for ").pop()}` : ""}</span>
        <input className="input max-w-xs" type="file" name="file" accept="application/pdf,image/png,image/jpeg" required aria-label={label} />
        <Button type="submit" variant="secondary">Upload</Button>
      </ActionForm>
    ) : null;

  const requestItem = (r: { id: string; title: string; instructions: string | null; dueAt: Date | null; status: string }, periodId: string | null) => (
    <li key={r.id} className="py-2 text-sm">
      <p className="flex flex-wrap items-center gap-2">
        <strong>{r.title}</strong>
        {r.status === "OPEN" ? <Badge tone="amber">Needed{r.dueAt ? ` by ${fmtDate(r.dueAt)}` : ""}</Badge> : r.status === "SUBMITTED" ? <Badge tone="gold">Received — under review</Badge> : <Badge tone="green">Accepted</Badge>}
      </p>
      {r.instructions && <p className="text-slate-600">{r.instructions}</p>}
      {r.status === "OPEN" && upload(r.id, periodId, `Upload for ${r.title}`)}
    </li>
  );

  return (
    <>
      <PageHeader title="Bookkeeping & requests" subtitle={<span data-testid="bk-business">Checklist, reports and questions for <strong>{current.client.businessName || current.client.displayName}</strong> only.</span>} />
      {looseRequests.length > 0 && (
        <Card title="Documents we need" className="mb-4"><ul className="divide-y divide-navy-100">{looseRequests.map((r) => requestItem(r, null))}</ul></Card>
      )}
      {!current.canViewBookkeeping ? (
        <Notice>Bookkeeping isn&apos;t included in your access to this account.</Notice>
      ) : periods.length === 0 ? (
        <EmptyState title="No bookkeeping months yet">When we start your monthly bookkeeping, each month will appear here with its reports and checklist.</EmptyState>
      ) : (
        <div className="space-y-4">
          {periods.map((p) => (
            <Card key={p.id} title={`${MONTHS[p.month - 1]} ${p.year}`} actions={<Badge tone={TONE[p.status]}>{PERIOD_LABELS[p.status]}</Badge>}>
              {p.staffNote && <p className="mb-2 text-sm text-slate-700">Note from us: {p.staffNote}</p>}
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <h3 className="mb-1 text-sm font-semibold">Financial statements</h3>
                  {(() => {
                    // Delivered reports only (the query above returns published, scanned-clean files). A revised report replaces
                    // the delivered one only once the revision itself is delivered, so exactly one version of each is published.
                    const reports = p.documents.filter((d) => d.category === "BOOKKEEPING" && d.reportType);
                    if (!reports.length) return <p className="text-sm text-slate-600">Your statements will be posted here once they&apos;re reviewed and ready.</p>;
                    const types = [...new Set(reports.map((d) => (d.reportPeriodType ?? "MONTH") as PeriodType))];
                    return types.map((t) => {
                      const r = reportPeriod(p.year, p.month, t, fye);
                      const inPacket = reports.filter((d) => (d.reportPeriodType ?? "MONTH") === t).sort((a, b) => ORDER.indexOf(a.reportType!) - ORDER.indexOf(b.reportType!));
                      const href = `/api/bookkeeping/packet?period=${p.id}&type=${t}`;
                      return (
                        <div key={t} className="mb-3 rounded-xl border border-ivory-200 p-3" data-testid="client-packet">
                          <p className="text-sm font-semibold">{PERIOD_TYPES[t] === "Month" ? "Monthly" : PERIOD_TYPES[t] === "Quarter" ? "Quarterly" : "Year-to-date"} financial statements</p>
                          <p className="text-xs text-slate-600">{r.cover}</p>
                          <div className="my-2 flex flex-wrap gap-2">
                            <a className="rounded-full bg-navy-900 px-3 py-1.5 text-xs font-semibold text-white" href={href} target="_blank" rel="noopener">View &amp; print</a>
                            <a className="rounded-full border border-navy-900 px-3 py-1.5 text-xs font-semibold text-navy-900" href={`${href}&download=1`}>Download PDF</a>
                          </div>
                          <ul className="space-y-1 text-sm">
                            {inPacket.map((d) => (
                              <li key={d.id}>
                                <a className="underline" href={link(d.id)} target="_blank" rel="noopener">{REPORT_LABELS[d.reportType!]}</a>
                                <span className="block text-xs text-slate-500">{reportCaption(d, p.year, p.month, fye)}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      );
                    });
                  })()}
                  <h3 className="mb-1 mt-3 text-sm font-semibold">Your uploads</h3>
                  <ul className="text-sm">{p.documents.filter((d) => d.uploadedByPortalId).map((d) => <li key={d.id}>{d.title} <span className="text-slate-500">· {fmtDate(d.createdAt)}</span></li>)}</ul>
                  {upload(null, p.id, `Upload a document for ${MONTHS[p.month - 1]}`)}
                </div>
                <div>
                  <h3 className="text-sm font-semibold">Checklist</h3>
                  {p.requests.length ? <ul className="divide-y divide-navy-100">{p.requests.map((r) => requestItem(r, p.id))}</ul> : <p className="text-sm text-slate-600">Nothing needed right now.</p>}
                  {current.canMessage && <Link href={`/client/messages${q}`} className="mt-2 inline-block text-sm underline">Ask a question about this month</Link>}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
