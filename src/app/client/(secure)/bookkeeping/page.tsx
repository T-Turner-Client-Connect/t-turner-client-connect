import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, EmptyState, Notice, PageHeader } from "@/components/ui";
import { portalUploadAction } from "@/app/actions/portal";
import { portalExplainAction } from "@/app/actions/ask-client";
import { BK_PORTAL_COETHA_V1 } from "@/lib/client-letters/templates";
import { BkUploadFields, UploadMeta } from "@/components/bk-upload";
import { UploadReceipt } from "@/components/portal/upload-receipt";
import { scanConfigured } from "@/lib/scan";
import { portalViewer } from "@/lib/portal/viewer";
import { PreviewDisabled } from "@/components/portal/preview-off";
import { prisma } from "@/lib/prisma";
import { MONTHS } from "@/lib/services/bookkeeping";
import { REPORT_LABELS, portalPeriodDocumentsWhere } from "@/lib/services/documents";
import { fmtDate } from "@/lib/format";
import { PERIOD_TYPES, reportPeriod, type PeriodType } from "@/lib/bookkeeping-periods";
import { reportCaption } from "@/lib/services/bookkeeping-clients";
import { CLIENT_STATUS_LABEL, clientInterimStatements, clientStatementStatus, ledgerStatementsReleased } from "@/lib/services/client-statements";
import { rangeText } from "@/lib/services/client-requests";
import { registryLabel } from "@/lib/services/bank-accounts";
import { clientFacingRequestWhere } from "@/lib/services/client-request-scope";
import { clientVisibleConversationWhere } from "@/lib/portal/access";

export const metadata = { title: "Bookkeeping & requests" };


export default async function PortalBookkeeping({ searchParams }: { searchParams: Promise<{ account?: string }> }) {
  const v = await portalViewer("bookkeeping", (await searchParams).account);
  const { current } = v;
  if (!current) return null;
  const q = `?account=${current.clientId}`;
  const [periods, looseRequests] = await Promise.all([
    current.canViewBookkeeping
      ? prisma.bookkeepingPeriod.findMany({
          where: { clientId: current.clientId },
          include: {
            // Published, scanned-clean files — plus the client's own uploads at any scan stage (listed, not opened, until clean).
            // Only what this login may see (its categories, payroll only with payroll access), approved
            // reports only, and the latest version — the same rules as every other document list.
            documents: { where: portalPeriodDocumentsWhere(current, v.user?.id ?? null), orderBy: { createdAt: "desc" }, include: { uploadedByPortal: { select: { name: true } }, file: { select: { originalName: true } } } },
            // Drafts were never sent, and year-end requests have their own place: neither shows in a month.
            requests: { where: { status: { notIn: ["CANCELLED", "DRAFT"] }, kind: { not: "YEAR_END" }, AND: [clientFacingRequestWhere(true)] }, orderBy: { createdAt: "asc" }, include: { bookkeepingAccount: { select: { institution: true, nickname: true, last4: true, accountType: true } } } },
            // Questions our office asked about this month (answered in Messages).
            conversations: { where: { questionStatus: { not: null }, ...clientVisibleConversationWhere(v.user?.id ?? null) }, orderBy: { createdAt: "asc" }, select: { id: true, subject: true, questionStatus: true, responseDueAt: true } },
          },
          orderBy: [{ year: "desc" }, { month: "desc" }],
        })
      : [],
    prisma.documentRequest.findMany({ where: { clientId: current.clientId, periodId: null, status: { in: ["OPEN", "SUBMITTED"] }, kind: { not: "OWNER_PERSONAL" }, AND: [clientFacingRequestWhere(current.canViewBookkeeping)] }, orderBy: { createdAt: "desc" }, include: { bookkeepingAccount: { select: { institution: true, nickname: true, last4: true, accountType: true } } } }),
  ]);
  // Only operational status reaches the client: "in preparation" or "available for download".
  const interims = current.canViewBookkeeping ? await clientInterimStatements(current.clientId) : [];
  const statuses = new Map(await Promise.all(periods.map(async (p) => [p.id, { status: await clientStatementStatus(p.id), ledger: !!(await ledgerStatementsReleased(p.id)) }] as const)));
  const link = v.linkFor;
  const fye = (await prisma.client.findUnique({ where: { id: current.clientId }, select: { fiscalYearEnd: true } }))?.fiscalYearEnd ?? null;
  const ORDER = ["FINANCIAL_PACKET", "PROFIT_AND_LOSS", "GROSS_RECEIPTS", "BALANCE_SHEET", "BANK_RECONCILIATION", "SUPPORTING_SCHEDULE", "OTHER_REPORT"];
  const business = current.client.businessName || current.client.displayName;
  const upload = (requestId: string | null, periodId: string | null, label: string, year?: number, month?: number | null) =>
    current.canUpload ? (
      <PreviewDisabled readOnly={v.readOnly}>
      <ActionForm action={v.act(portalUploadAction, current.clientId)} className="mt-1 space-y-2" resetOnSuccess>
        <input type="hidden" name="bk" value="1" />
        {requestId && <input type="hidden" name="requestId" value={requestId} />}
        {periodId && <input type="hidden" name="periodId" value={periodId} />}
        <BkUploadFields business={business} year={year ?? new Date().getFullYear()} month={month ?? null} labelPrefix={label.includes(" for ") ? `${label.split(" for ").pop()}: ` : ""} />
        <div className="flex flex-wrap items-center gap-2">
          <input className="input max-w-xs" type="file" name="file" accept="application/pdf,image/png,image/jpeg" required aria-label={label} />
          <Button type="submit" variant="secondary">Upload</Button>
        </div>
      </ActionForm>
      </PreviewDisabled>
    ) : null;

  // A targeted request already names the document, account and period: the client just attaches the file.
  const linkedUpload = (requestId: string, label: string) =>
    current.canUpload ? (
      <PreviewDisabled readOnly={v.readOnly}>
      <ActionForm action={v.act(portalUploadAction, current.clientId)} className="mt-1 flex flex-wrap items-center gap-2" resetOnSuccess>
        <input type="hidden" name="requestId" value={requestId} />
        <input className="input max-w-xs" type="file" name="file" accept="application/pdf,image/png,image/jpeg" required aria-label={label} />
        <Button type="submit" variant="secondary">Upload</Button>
      </ActionForm>
      </PreviewDisabled>
    ) : null;
  type Req = { id: string; title: string; instructions: string | null; reason: string | null; dueAt: Date | null; status: string; askClient: boolean; clientExplanation: string | null; docType: string | null; periodStart: Date | null; periodEnd: Date | null; bookkeepingAccount: { institution: string; nickname: string | null; last4: string | null; accountType: string } | null };
  // Ask Client: a supporting request is answered with the file, or with a written explanation.
  const explain = (r: Req) =>
    current.canUpload ? (
      <PreviewDisabled readOnly={v.readOnly}>
      <details className="mt-2" open={!!r.clientExplanation}>
        <summary className="cursor-pointer text-xs font-semibold text-navy-700">{r.clientExplanation ? "Your explanation (you can update it)" : "No document? Explain instead"}</summary>
        <ActionForm action={v.act(portalExplainAction, current.clientId, r.id)} className="mt-2 space-y-2">
          <textarea name="explanation" className="input w-full" rows={3} maxLength={4000} required defaultValue={r.clientExplanation ?? ""} aria-label={`Explanation for ${r.title}`} />
          <Button type="submit" variant="secondary">Send explanation</Button>
        </ActionForm>
      </details>
      </PreviewDisabled>
    ) : null;
  const requestItem = (r: Req, periodId: string | null, period?: { year: number; month: number }) => (
    <li key={r.id} className="py-2 text-sm" data-testid="client-request">
      <p className="flex flex-wrap items-center gap-2">
        <strong>{r.title}</strong>
        {r.status === "OPEN" ? <Badge tone="amber">Needed{r.dueAt ? ` by ${fmtDate(r.dueAt)}` : ""}</Badge> : r.status === "SUBMITTED" ? <Badge tone="gold">Received — thank you</Badge> : <Badge tone="green">Accepted</Badge>}
      </p>
      {(r.bookkeepingAccount || r.periodStart) && <p className="text-xs text-slate-600">{r.bookkeepingAccount ? `Account: ${registryLabel(r.bookkeepingAccount)}` : ""}{r.bookkeepingAccount && r.periodStart ? " · " : ""}{r.periodStart ? `Period: ${rangeText(r)}` : ""}</p>}
      {r.reason && <p className="text-slate-600">{r.reason}</p>}
      {r.instructions && <p className="text-slate-600">{r.instructions}</p>}
      {r.askClient && (r.status === "OPEN" || r.status === "SUBMITTED")
        ? <>{linkedUpload(r.id, `Upload for ${r.title}`)}{explain(r)}</>
        : r.status === "OPEN" && (r.docType ? linkedUpload(r.id, `Upload for ${r.title}`) : upload(r.id, periodId, `Upload for ${r.title}`, period?.year, period?.month))}
    </li>
  );

  return (
    <>
      <PageHeader title="Bookkeeping & requests" subtitle={<span data-testid="bk-business">Checklist, reports and questions for <strong>{current.client.businessName || current.client.displayName}</strong> only.</span>} />
      {looseRequests.length > 0 && (
        <Card title="Documents we need" className="mb-4">
          {looseRequests.some((r) => r.askClient && r.status === "OPEN") && (
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3 border-b-2 border-gold-500 pb-3" data-testid="ask-letterhead">
              <div>
                <p className="font-serif text-base font-bold text-navy-900">{BK_PORTAL_COETHA_V1.letterhead.name}</p>
                <p className="text-xs text-slate-600">{BK_PORTAL_COETHA_V1.letterhead.lines.join(" · ")}</p>
              </div>
              <a href={`/api/client/ask-letter${q}`} className="rounded-full border border-navy-900 px-3 py-1 text-xs font-semibold text-navy-900" target="_blank" rel="noreferrer">View our request letter (PDF)</a>
            </div>
          )}
          <p className="mb-2 text-sm text-slate-600">For each item, upload the document or write a short explanation. Everything goes securely to our office.</p>
          <ul className="divide-y divide-navy-100">{looseRequests.map((r) => requestItem(r, null))}</ul>
        </Card>
      )}
      {interims.length > 0 && (
        <Card title="Interim financial statements" className="mb-4">
          <ul className="divide-y divide-navy-100" data-testid="client-interim">
            {interims.map((r) => (
              <li key={r.id} className="py-2 text-sm">
                <p className="font-semibold">{r.purpose ?? "Interim financial statements"}</p>
                <p className="text-xs font-semibold text-amber-800">{r.label}</p>
                <p className="mt-1 flex flex-wrap gap-2 text-xs">
                  <a className="rounded-full border border-navy-900 px-3 py-1 font-semibold text-navy-900" href={`/api/client/statements?interim=${r.id}&kind=pl&download=1`}>Profit and Loss (PDF)</a>
                  <a className="rounded-full border border-navy-900 px-3 py-1 font-semibold text-navy-900" href={`/api/client/statements?interim=${r.id}&kind=bs&download=1`}>Balance Sheet (PDF)</a>
                </p>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {!current.canViewBookkeeping ? (
        <Notice>Business bookkeeping isn&apos;t part of the services on this account. If you&apos;d like our firm to manage your business books, send us a message.</Notice>
      ) : periods.length === 0 ? (
        <EmptyState title="No bookkeeping months yet">When we start your monthly bookkeeping, each month will appear here with its reports and checklist.</EmptyState>
      ) : (
        <div className="space-y-4">
          {periods.map((p) => (
            <Card key={p.id} title={`${MONTHS[p.month - 1]} ${p.year}`} actions={<span data-testid="client-statement-status"><Badge tone={statuses.get(p.id)?.status === "AVAILABLE" ? "green" : "navy"}>{CLIENT_STATUS_LABEL[statuses.get(p.id)?.status ?? "IN_PREPARATION"]}</Badge></span>}>
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <h3 className="mb-1 text-sm font-semibold">Financial statements</h3>
                  {(() => {
                    // Delivered reports only (the query above returns published, scanned-clean files). A revised report replaces
                    // the delivered one only once the revision itself is delivered, so exactly one version of each is published.
                    const reports = p.documents.filter((d) => d.category === "BOOKKEEPING" && d.reportType && d.reviewStatus === "APPROVED" && d.scanStatus === "CLEAN" && d.visibility === "PUBLISHED");
                    if (!reports.length) return <p className="text-sm text-slate-600">{CLIENT_STATUS_LABEL.IN_PREPARATION}.</p>;
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
                          {t === "MONTH" && statuses.get(p.id)?.ledger && (
                            <p className="mb-2 flex flex-wrap gap-2 text-xs" data-testid="ledger-statements">
                              {([["pl", "Profit and Loss"], ["bs", "Balance Sheet"], ["gl", "General Ledger"]] as const).map(([k, l]) => (
                                <a key={k} className="rounded-full border border-navy-900 px-3 py-1 font-semibold text-navy-900" href={`/api/client/statements?period=${p.id}&kind=${k}&download=1`}>{l} (PDF)</a>
                              ))}
                            </p>
                          )}
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
                  <ul className="space-y-2 text-sm">{p.documents.filter((d) => d.uploadedByPortalId).map((d) => <li key={d.id}><UploadReceipt d={d} scannerConfigured={scanConfigured()} /><UploadMeta d={d} /></li>)}</ul>
                  {upload(null, p.id, `Upload a document for ${MONTHS[p.month - 1]}`, p.year, p.month)}
                </div>
                <div>
                  <h3 className="text-sm font-semibold">Checklist</h3>
                  {p.requests.length ? <ul className="divide-y divide-navy-100">{p.requests.map((r) => requestItem(r, p.id, p))}</ul> : <p className="text-sm text-slate-600">Nothing needed right now.</p>}
                  {p.conversations.length > 0 && (
                    <div className="mt-3" data-testid="client-questions">
                      <h3 className="mb-1 text-sm font-semibold">Questions from our office</h3>
                      <ul className="space-y-1 text-sm">
                        {p.conversations.map((c) => (
                          <li key={c.id} className="flex flex-wrap items-center justify-between gap-2">
                            <span>{c.subject}{c.responseDueAt && c.questionStatus === "OPEN" && <span className="block text-xs text-slate-600">Please answer by {fmtDate(c.responseDueAt)}</span>}</span>
                            <span className="flex items-center gap-2">
                              <Badge tone={c.questionStatus === "OPEN" ? "amber" : c.questionStatus === "ANSWERED" ? "navy" : "green"}>{c.questionStatus === "OPEN" ? "Needs your answer" : c.questionStatus === "ANSWERED" ? "Answered — we're reviewing" : "Resolved"}</Badge>
                              {current.canMessage && <Link className="underline" href={`/client/messages${q}&c=${c.id}`}>{c.questionStatus === "OPEN" ? "Answer" : "View"}</Link>}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
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
