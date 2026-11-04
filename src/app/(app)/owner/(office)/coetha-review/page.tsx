import Link from "next/link";
import clsx from "clsx";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { AlertTriangle, ClipboardList, Inbox, Landmark, Scale, Sparkles } from "lucide-react";
import { requireOffice } from "@/lib/auth/owner";
import { prisma } from "@/lib/prisma";
import { card, h2, RecommendationCard } from "@/components/bk/parts";
import { RequestList } from "@/components/bk/requests";
import { coethaAutoSendOn } from "@/lib/services/owner-switches";
import { officeBookClientIds } from "@/lib/services/ledger";
import { canApproveCoethaWork } from "@/lib/auth/permissions";
import { TAX_CLASSIFICATIONS, isTaxClassification } from "@/lib/services/tax-classification";

export const metadata = { title: "Coetha Accounting Review" };

/**
 * Tabitha's private, internal workspace for Coetha's senior-accountant work across every
 * bookkeeping client: findings and recommendations, classification suggestions, missing
 * information and requests, draft entries, reconciliation discrepancies and what waits for her.
 * Nothing here is ever shown to a client.
 */
export default async function CoethaReview({ searchParams }: { searchParams: Promise<{ client?: string }> }) {
  await connection();
  const { actor, access } = await requireOffice();
  if (!access.isOwner && !access.can("coetha", "view")) notFound();
  const sp = await searchParams;
  const ids = await officeBookClientIds();
  const [clients, proposals, drafts, open, ready, exceptions, approver] = await Promise.all([
    prisma.client.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true, businessName: true, bookkeepingProfile: { select: { taxClassification: true } } }, orderBy: { displayName: "asc" } }),
    prisma.coethaProposal.findMany({ where: { clientId: { in: ids }, status: "PROPOSED" }, orderBy: { createdAt: "desc" }, take: 400 }),
    prisma.documentRequest.groupBy({ by: ["clientId"], where: { clientId: { in: ids }, status: "DRAFT" }, _count: true }),
    prisma.documentRequest.groupBy({ by: ["clientId"], where: { clientId: { in: ids }, status: "OPEN" }, _count: true }),
    prisma.accountReconciliation.groupBy({ by: ["clientId"], where: { clientId: { in: ids }, status: "READY" }, _count: true }),
    prisma.accountReconciliation.groupBy({ by: ["clientId"], where: { clientId: { in: ids }, status: "EXCEPTION" }, _count: true }),
    canApproveCoethaWork(actor),
  ]);
  const [held, autoSend] = await Promise.all([
    prisma.documentRequest.findMany({ where: { clientId: { in: ids }, status: "DRAFT", routing: "REVIEW" }, orderBy: { createdAt: "desc" }, take: 50, include: { bookkeepingAccount: true } }),
    coethaAutoSendOn(),
  ]);
  const n = (rows: { clientId: string; _count: number }[], id: string) => rows.find((r) => r.clientId === id)?._count ?? 0;
  const kinds = (id: string, k: string[]) => proposals.filter((p) => p.clientId === id && k.includes(p.kind)).length;
  const rows = clients.map((c) => ({
    c, name: c.businessName || c.displayName,
    findings: kinds(c.id, ["RECOMMENDATION", "DISCREPANCY"]), classification: kinds(c.id, ["CLASSIFICATION"]), drafts: kinds(c.id, ["CATEGORY", "ADJUSTING_ENTRY", "MONTH_SUMMARY"]),
    requestDrafts: n(drafts, c.id), requestsOpen: n(open, c.id), reconReady: n(ready, c.id), reconIssues: n(exceptions, c.id),
  })).map((r) => ({ ...r, waiting: r.findings + r.classification + r.drafts + r.reconReady })).sort((a, b) => b.waiting - a.waiting || a.name.localeCompare(b.name));
  const focus = sp.client && ids.includes(sp.client) ? sp.client : null;
  const shown = proposals.filter((p) => (p.kind === "RECOMMENDATION" || p.kind === "CLASSIFICATION") && (!focus || p.clientId === focus)).slice(0, 25);
  const nameOf = new Map(rows.map((r) => [r.c.id, r.name]));
  const totals = rows.reduce((t, r) => ({ findings: t.findings + r.findings + r.classification, drafts: t.drafts + r.drafts, requests: t.requests + r.requestDrafts, recon: t.recon + r.reconReady, issues: t.issues + r.reconIssues }), { findings: 0, drafts: 0, requests: 0, recon: 0, issues: 0 });

  return (
    <div className="space-y-5" data-testid="coetha-review">
      <section className="rounded-2xl bg-gradient-to-br from-navy-900 via-navy-950 to-navy-900 px-5 py-5 text-white ring-1 ring-gold-500/40 sm:px-7">
        <h1 className="flex items-center gap-3 font-serif text-2xl font-bold text-white"><Sparkles className="size-7 text-gold-400" aria-hidden /> Coetha Accounting Review</h1>
        <p className="mt-1 text-sm text-navy-100">Internal only. Coetha prepares and recommends; only Tabitha approves. Nothing on this page ever reaches a client, a statement or a download.</p>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
          {[["Findings for you", totals.findings], ["Draft entries & categories", totals.drafts], ["Draft requests", totals.requests], ["Reconciliations to approve", totals.recon], ["Reconciliation issues", totals.issues]].map(([k, v]) => (
            <div key={k} className="rounded-xl bg-white/10 px-3 py-2"><p className="text-xs text-navy-100">{k}</p><p className="font-serif text-xl font-bold text-white">{v}</p></div>
          ))}
        </div>
      </section>

      <section className={clsx(card, "p-4 sm:p-5")} data-testid="review-queue">
        <h2 className={h2}><ClipboardList className="size-5 text-gold-600" aria-hidden /> Across clients</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[40rem] text-sm">
            <thead className="text-left text-xs text-slate-600"><tr><th className="py-1.5 pr-2 font-medium">Business</th><th className="pr-2 font-medium">Classification</th><th className="pr-2 text-center font-medium"><AlertTriangle className="inline size-4" aria-label="Findings" /></th><th className="pr-2 text-center font-medium">Drafts</th><th className="pr-2 text-center font-medium"><Inbox className="inline size-4" aria-label="Requests" /></th><th className="pr-2 text-center font-medium"><Landmark className="inline size-4" aria-label="Reconciliations" /></th><th></th></tr></thead>
            <tbody className="divide-y divide-ivory-200">
              {rows.map((r) => (
                <tr key={r.c.id} className={clsx(focus === r.c.id && "bg-gold-50")}>
                  <td className="py-2 pr-2 font-semibold text-navy-900"><Link className="underline decoration-gold-500" href={`/owner/coetha-review?client=${r.c.id}`}>{r.name}</Link></td>
                  <td className="pr-2 text-xs text-navy-800">{isTaxClassification(r.c.bookkeepingProfile?.taxClassification) ? TAX_CLASSIFICATIONS[r.c.bookkeepingProfile!.taxClassification as keyof typeof TAX_CLASSIFICATIONS].label.split(" — ")[0] : <span className="text-red-700">Not set</span>}{r.classification ? " · change suggested" : ""}</td>
                  <td className="pr-2 text-center">{r.findings || "—"}</td>
                  <td className="pr-2 text-center">{r.drafts || "—"}</td>
                  <td className="pr-2 text-center">{r.requestDrafts ? `${r.requestDrafts} draft` : ""}{r.requestDrafts && r.requestsOpen ? " · " : ""}{r.requestsOpen ? `${r.requestsOpen} sent` : !r.requestDrafts ? "—" : ""}</td>
                  <td className="pr-2 text-center">{r.reconReady ? `${r.reconReady} ready` : ""}{r.reconReady && r.reconIssues ? " · " : ""}{r.reconIssues ? <span className="text-red-700">{r.reconIssues} issue{r.reconIssues === 1 ? "" : "s"}</span> : !r.reconReady ? "—" : ""}</td>
                  <td className="whitespace-nowrap text-right text-xs"><Link className="font-semibold underline" href={`/bookkeeping/${r.c.id}/coetha`}>Open</Link> · <Link className="underline" href={`/bookkeeping/${r.c.id}/close`}>Month</Link></td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={7} className="py-3 text-slate-600">No bookkeeping clients yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className={clsx(card, "p-4 sm:p-5")} data-testid="review-requests">
        <h2 className={h2}><Inbox className="size-5 text-gold-600" aria-hidden /> Requests held for your review <span className="rounded-full bg-navy-900 px-2.5 py-0.5 font-sans text-xs font-semibold text-gold-300">{held.length}</span></h2>
        <p className="mt-1 text-xs text-slate-600">Routine requests (statements, receipts, payroll records, loan documents for known loans) go out automatically{autoSend ? "" : " — currently turned off, so they wait as drafts"}. Unusual, sensitive or unclear ones wait here.</p>
        {!held.length ? <p className="mt-2 text-sm text-slate-600">Nothing held.</p> : (
          <ul className="mt-2 space-y-3">
            {held.map((r) => (
              <li key={r.id}>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{nameOf.get(r.clientId)}</p>
                <RequestList items={[r]} clientId={r.clientId} canSend canApprove={approver} empty="" />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={clsx(card, "p-4 sm:p-5")} data-testid="review-findings">
        <h2 className={h2}><Scale className="size-5 text-gold-600" aria-hidden /> Findings awaiting you {focus && <span className="font-sans text-sm font-normal text-navy-800">— {nameOf.get(focus)} · <Link className="underline" href="/owner/coetha-review">all clients</Link></span>}</h2>
        {!shown.length ? <p className="mt-2 text-sm text-slate-600">Nothing waiting.</p> : (
          <ul className="mt-3 space-y-3">
            {shown.map((p) => (
              <li key={p.id}>
                {!focus && <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{nameOf.get(p.clientId)}</p>}
                <ul><RecommendationCard p={p} clientId={p.clientId} canApprove={approver} booksHref={`/bookkeeping/${p.clientId}/books?tab=bank`} /></ul>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
