import Link from "next/link";
import clsx from "clsx";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { Archive, FileClock } from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { ActionForm } from "@/components/action-form";
import { card, h2, navyBtn } from "@/components/bk/parts";
import { RequestList } from "@/components/bk/requests";
import { HISTORICAL_TYPES, requestsFor } from "@/lib/services/client-requests";
import { registryLabel } from "@/lib/services/bank-accounts";
import { canSendClientRequests, canViewBanking } from "@/lib/services/bk-permissions";
import { historicalRequestAction } from "@/app/actions/bk-workflow";

export const metadata = { title: "Historical Records & Statements" };

export default async function RecordsPage({ params }: { params: Promise<{ clientId: string }> }) {
  await connection();
  const user = await requireUser();
  const { clientId } = await params;
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { displayName: true, businessName: true } });
  if (!client) notFound();
  const biz = client.businessName || client.displayName;
  const base = `/bookkeeping/${clientId}`;
  if (!(await canViewBanking(user, clientId))) return <div className={clsx(card, "p-6 text-navy-900")}>Only Admins, the staff member assigned to {biz} and staff Tabitha allows can see its records requests.</div>;
  const [reqs, send, accounts] = await Promise.all([requestsFor(clientId), canSendClientRequests(user, clientId), prisma.bookkeepingAccount.findMany({ where: { clientId, active: true }, orderBy: [{ accountType: "asc" }, { institution: "asc" }] })]);
  const thisYear = new Date().getFullYear();

  return (
    <div className="space-y-5" data-testid="records-page">
      <p className="text-sm"><Link className="underline" href={`${base}/close`}>← Bookkeeping management</Link></p>
      <section className="rounded-2xl bg-gradient-to-br from-navy-900 via-navy-950 to-navy-900 px-5 py-5 text-white ring-1 ring-gold-500/40 sm:px-7">
        <p className="text-xs uppercase tracking-[0.2em] text-gold-300">{biz}</p>
        <h1 className="mt-1 font-serif text-2xl font-bold text-white">Historical Records &amp; Statements</h1>
        <p className="mt-1 text-sm text-navy-100">For onboarding: earlier bank and card statements, payroll reports, receipts and prior financial statements. Each request names the exact account and date range; the client uploads straight to it and the file is filed to that account and period automatically.</p>
      </section>

      {send && (
        <section className={clsx(card, "p-4 sm:p-5")} data-testid="historical-form">
          <h2 className={h2}><FileClock className="size-5 text-gold-600" aria-hidden /> Request records</h2>
          <ActionForm action={historicalRequestAction.bind(null, clientId)} className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3" resetOnSuccess>
            <label className="text-sm">What you need<select className="input mt-1" name="docType" defaultValue="BANK_STATEMENT">{Object.entries(HISTORICAL_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            <label className="text-sm">Account (required for statements)<select className="input mt-1" name="accountId" defaultValue=""><option value="">—</option>{accounts.map((a) => <option key={a.id} value={a.id}>{registryLabel(a)}</option>)}</select></label>
            <label className="text-sm">Due (optional)<input className="input mt-1" type="date" name="dueAt" /></label>
            <label className="text-sm">From<input className="input mt-1" type="date" name="start" required defaultValue={`${thisYear}-01-01`} /></label>
            <label className="text-sm">Through<input className="input mt-1" type="date" name="end" required /></label>
            <label className="text-sm">Note to the client (optional)<input className="input mt-1" name="note" placeholder="Why it's needed" /></label>
            <div className="sm:col-span-2 lg:col-span-3"><button type="submit" className={navyBtn}>Send request</button></div>
          </ActionForm>
          <p className="mt-2 text-xs text-slate-600">Records already on file for that account and range aren&apos;t requested again. Coetha also drafts these when a bank feed starts after the books&apos; opening date.</p>
        </section>
      )}

      <section className={clsx(card, "p-4 sm:p-5")} data-testid="historical-requests">
        <h2 className={h2}><Archive className="size-5 text-gold-600" aria-hidden /> Historical requests <span className="rounded-full bg-navy-900 px-2.5 py-0.5 font-sans text-xs font-semibold text-gold-300">{reqs.historical.length}</span></h2>
        <RequestList items={reqs.historical} clientId={clientId} canSend={send} empty="No historical records requested yet." />
      </section>

      <section className={clsx(card, "p-4 sm:p-5")} data-testid="all-requests">
        <h2 className={h2}><FileClock className="size-5 text-gold-600" aria-hidden /> Monthly and supporting requests</h2>
        <RequestList items={reqs.all.filter((r) => r.kind !== "HISTORICAL" && r.kind !== "YEAR_END")} clientId={clientId} canSend={send} empty="None." />
      </section>
    </div>
  );
}
