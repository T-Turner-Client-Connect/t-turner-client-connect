import Link from "next/link";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { Badge, Card, EmptyState, Notice, PageHeader } from "@/components/ui";
import { AUDIT_CATEGORY_LABEL, auditFileView, describeFilter, parseAuditFilter } from "@/lib/services/audit-file";
import { downloadToken } from "@/lib/services/documents";
import { canUseLedger } from "@/lib/services/ledger";

export const metadata = { title: "Audit File" };

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const fmt = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const ACTION_LABEL: Record<string, string> = {
  "audit_file.exported": "Audit File exported",
  "ask_client.letter_prepared": "Request letter prepared",
  "request.client_explained": "Client wrote an explanation",
  "ask_client.edited": "Request edited",
  "ask_client.withdrawn": "Request withdrawn",
  "request.sent": "Request sent to the client",
  "coetha.client_response_queued": "Client upload queued for Coetha",
};

export default async function AuditFilePage({ params, searchParams }: { params: Promise<{ clientId: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  await connection();
  const user = await requireUser();
  const { clientId } = await params;
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { displayName: true, businessName: true } });
  if (!client) notFound();
  if (!(await canUseLedger(user, clientId))) return <Notice tone="warn">Only Admins, the staff member assigned to this business and staff Tabitha allows can open its Audit File.</Notice>;
  const sp = await searchParams;
  const filter = parseAuditFilter(sp);
  const v = await auditFileView(user, clientId, filter);
  const business = client.businessName || client.displayName;
  const qs = new URLSearchParams(Object.entries({ year: filter.year, month: filter.month, category: filter.category, account: filter.accountId }).filter(([, x]) => x != null && x !== "").map(([k, x]) => [k, String(x)])).toString();
  const accountLabel = filter.accountId ? v.accounts.find((a) => a.id === filter.accountId)?.label ?? null : null;
  const link = (id: string) => `/api/documents/${downloadToken(id, { staffId: user.id })}`;

  // Group: year → month → category → account.
  const groups = new Map<string, typeof v.rows>();
  for (const d of v.rows) {
    const key = `${d.year} · ${d.month ? MONTHS[d.month - 1] : "Whole year"} · ${AUDIT_CATEGORY_LABEL[d.category] ?? d.category}${d.account ? ` · ${d.account}` : ""}`;
    groups.set(key, [...(groups.get(key) ?? []), d]);
  }

  return (
    <>
      <PageHeader
        title="Audit File"
        subtitle={<>Every document on file for <strong>{business}</strong>, organized by year, month, category and account, with the client&apos;s written explanations.</>}
        actions={<Link href={`/bookkeeping/${clientId}/ask-client`} className="rounded-full border border-navy-900 px-4 py-2 text-sm font-semibold text-navy-900">Ask Client</Link>}
      />
      <Card className="mb-4">
        <form method="get" className="flex flex-wrap items-end gap-3" data-testid="audit-filters">
          <label className="text-sm"><span className="mb-1 block font-semibold text-navy-900">Year</span>
            <select name="year" className="input" defaultValue={filter.year ?? ""}><option value="">All years</option>{v.years.map((y) => <option key={y} value={y}>{y}</option>)}</select></label>
          <label className="text-sm"><span className="mb-1 block font-semibold text-navy-900">Month</span>
            <select name="month" className="input" defaultValue={filter.month ?? ""}><option value="">All months</option>{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</select></label>
          <label className="text-sm"><span className="mb-1 block font-semibold text-navy-900">Category</span>
            <select name="category" className="input" defaultValue={filter.category ?? ""}><option value="">All categories</option>{Object.entries(AUDIT_CATEGORY_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <label className="text-sm"><span className="mb-1 block font-semibold text-navy-900">Account</span>
            <select name="account" className="input" defaultValue={filter.accountId ?? ""}><option value="">All accounts</option>{v.accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</select></label>
          <button type="submit" className="rounded-full border border-navy-900 px-4 py-2 text-sm font-semibold text-navy-900">Show</button>
          <a href={`/api/bookkeeping/${clientId}/audit-file${qs ? `?${qs}` : ""}`} className="rounded-full bg-navy-900 px-4 py-2 text-sm font-semibold text-white" data-testid="audit-export">Export PDF (cover, index and documents)</a>
        </form>
        <p className="mt-3 text-xs text-slate-600">Showing: {describeFilter(filter, accountLabel)} · {v.rows.length} document{v.rows.length === 1 ? "" : "s"}. Identity and owners&apos; personal documents are never part of the Audit File. A file is exported only after its virus scan is clean. Every export is recorded below.</p>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {groups.size ? [...groups.entries()].map(([key, docs]) => (
            <Card key={key} title={key}>
              <ul className="divide-y divide-ivory-200" data-testid="audit-group">
                {docs.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                    <div className="min-w-0">
                      {d.scanStatus === "CLEAN" ? <a className="font-semibold text-navy-700 underline" href={link(d.id)} target="_blank" rel="noreferrer">{d.title}</a> : <span className="font-semibold">{d.title}</span>}
                      <p className="text-xs text-slate-500">Received {fmt(d.createdAt)} from {d.from}{d.request ? ` · answers “${d.request.title}”` : ""}</p>
                    </div>
                    {d.scanStatus !== "CLEAN" && <Badge tone="amber">Not exported: scan {d.scanStatus.toLowerCase().replace("_", " ")}</Badge>}
                  </li>
                ))}
              </ul>
            </Card>
          )) : <EmptyState title="Nothing on file for these filters" />}

          {v.explanations.length > 0 && (
            <Card title={`Client explanations (${v.explanations.length})`}>
              <ul className="divide-y divide-ivory-200" data-testid="audit-explanations">
                {v.explanations.map((e) => (
                  <li key={e.id} className="py-2 text-sm">
                    <p className="font-semibold text-navy-900">{e.title} <span className="text-xs font-normal text-slate-500">{fmt(e.explainedAt!)}</span></p>
                    <p className="whitespace-pre-wrap text-slate-800">{e.clientExplanation}</p>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-amber-800">Explanations are supporting evidence, not authorization for an accounting entry.</p>
            </Card>
          )}
        </div>
        <Card title="Audit trail">
          {v.trail.length ? (
            <ul className="space-y-2 text-sm" data-testid="audit-trail">
              {v.trail.map((t) => (
                <li key={t.id}>
                  <p className="font-semibold text-navy-900">{ACTION_LABEL[t.action] ?? t.action}</p>
                  <p className="text-xs text-slate-500">{t.createdAt.toLocaleString("en-US", { timeZone: "America/Chicago", dateStyle: "medium", timeStyle: "short" })}{t.actor ? ` · ${t.actor.name}` : " · Client Connect"}</p>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-slate-600">No activity yet.</p>}
        </Card>
      </div>
    </>
  );
}
