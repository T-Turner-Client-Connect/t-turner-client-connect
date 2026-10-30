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
      <PageHeader title="Bookkeeping & requests" />
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
                  <h3 className="mb-1 text-sm font-semibold">Reports</h3>
                  {p.documents.filter((d) => d.category === "BOOKKEEPING").length ? (
                    <ul className="space-y-1 text-sm">
                      {p.documents.filter((d) => d.category === "BOOKKEEPING").map((d) => (
                        <li key={d.id}><a className="underline" href={link(d.id)} target="_blank" rel="noopener">{d.title}</a> {d.reportType && <Badge tone="navy">{REPORT_LABELS[d.reportType]}</Badge>}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-slate-600">Reports will be posted here when ready.</p>
                  )}
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
