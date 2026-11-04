import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, EmptyState, Field, PageHeader } from "@/components/ui";
import {
  cancelRefundTransferAction,
  recordRefundDepositAction,
  refundNotReceivedAction,
  setRefundAmountAction,
  undoRefundDepositAction,
} from "@/app/actions/refund-transfers";
import { requireOwner } from "@/lib/auth/owner";
import { DEBT_CHECK, OFFSET_RISK, RT_STATUS, refundTransferBoard, type RtStatus } from "@/lib/services/refund-transfers";
import { fmtDateTime } from "@/lib/format";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Pay by Refund" };

const TONE: Record<RtStatus, "gray" | "amber" | "green" | "red" | "gold"> = { REQUESTED: "gold", AWAITING_DEPOSIT: "amber", RECEIVED: "green", SHORT: "red", NOT_RECEIVED: "red", CANCELLED: "gray" };
const usd = (c: number | null) => (c == null ? "—" : `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });

/**
 * Owner's Office → Pay by Refund. Enter each client's preparation fee once the return is done,
 * then clear it when the Republic Bank deposit arrives — so it's clear who has paid and who hasn't.
 * Tracking only: Republic Bank's application and agreement are the authorization.
 */
export default async function RefundPaymentsPage({ searchParams }: { searchParams: Promise<{ year?: string }> }) {
  const { actor } = await requireOwner("billing");
  const thisYear = new Date().getFullYear();
  const year = Number((await searchParams).year) || thisYear - 1;
  const [{ rows, totals }, clients] = await Promise.all([
    refundTransferBoard(actor, year),
    prisma.client.findMany({ where: { archivedAt: null }, select: { id: true, displayName: true, businessName: true }, orderBy: { displayName: "asc" } }),
  ]);
  const name = (c: { displayName: string; businessName: string | null }) => c.businessName || c.displayName;
  const years = [thisYear, thisYear - 1, thisYear - 2];
  return (
    <>
      <PageHeader title="Pay by Refund (Republic Bank)" subtitle="Add each client's preparation fee once the return is done, then clear it when the refund deposit arrives. A fee is never marked paid until you record the deposit." />
      <nav aria-label="Tax year" className="mb-4 flex gap-2">
        {years.map((y) => <Link key={y} href={`/owner/refund-payments?year=${y}`} aria-current={y === year ? "page" : undefined} className={`rounded-full px-3 py-1.5 text-sm font-semibold ${y === year ? "bg-navy-900 text-gold-300" : "bg-ivory-50 text-navy-900 ring-1 ring-ivory-200"}`}>{y} returns</Link>)}
      </nav>

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="refund-totals">
        <Card title="Requests to review"><p className="font-serif text-2xl font-bold text-navy-900">{totals.pending}</p></Card>
        <Card title="Awaiting deposit"><p className="font-serif text-2xl font-bold text-navy-900">{usd(totals.awaitingCents)}</p><p className="text-sm text-slate-600">{totals.awaitingCount} client{totals.awaitingCount === 1 ? "" : "s"}</p></Card>
        <Card title="Received"><p className="font-serif text-2xl font-bold text-emerald-800">{usd(totals.receivedCents)}</p></Card>
        <Card title="Follow up (short / not received)"><p className="font-serif text-2xl font-bold text-red-800">{usd(totals.followUpCents)}</p><p className="text-sm text-slate-600">{totals.followUpCount} client{totals.followUpCount === 1 ? "" : "s"}</p></Card>
      </div>

      <Card title="Add a client's fee owed" className="mb-5">
        <ActionForm action={setRefundAmountAction} className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr_auto] sm:items-end" resetOnSuccess>
          <Field label="Client">
            <select className="input" name="clientId" required defaultValue="">
              <option value="" disabled>Choose a client…</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{name(c)}</option>)}
            </select>
          </Field>
          <Field label="Tax year"><select className="input" name="taxYear" defaultValue={year}>{years.map((y) => <option key={y} value={y}>{y}</option>)}</select></Field>
          <Field label="Fee owed ($)"><input className="input" name="amount" inputMode="decimal" required placeholder="300.00" /></Field>
          <Button type="submit">Add — awaiting deposit</Button>
        </ActionForm>
      </Card>

      <Card title={`${year} returns paid by refund`}>
        {rows.length === 0 ? (
          <EmptyState title="Nothing yet">Clients who choose Pay From My Refund, and fees you add above, appear here.</EmptyState>
        ) : (
          <ul className="divide-y divide-navy-100" data-testid="refund-rows">
            {rows.map((r) => {
              const status = r.status as RtStatus;
              const flagged = r.offsetRisk === "YES" || r.offsetRisk === "NOT_SURE" || (r.debtCheck && r.debtCheck !== "CHECKED");
              return (
                <li key={r.id} className="py-3 text-sm" data-status={status}>
                  <div className="flex flex-wrap items-center gap-2">
                    <Link className="font-semibold text-navy-900 underline" href={`/clients/${r.client.id}`}>{name(r.client)}</Link>
                    <Badge tone={TONE[status]}>{RT_STATUS[status].label}</Badge>
                    {flagged && <Badge tone="red">Check for offset</Badge>}
                    <span className="ml-auto font-semibold">Owed {usd(r.amountCents)}{r.receivedCents != null && <> · Received {usd(r.receivedCents)}</>}</span>
                  </div>
                  {r.debtCheck && <p className="mt-1 text-slate-600">Debt check: {DEBT_CHECK[r.debtCheck as keyof typeof DEBT_CHECK]} · Possible offset: {r.offsetRisk ? OFFSET_RISK[r.offsetRisk as keyof typeof OFFSET_RISK] : "—"}</p>}
                  <div className="mt-2 flex flex-wrap gap-3">
                    {status === "REQUESTED" && (
                      <ActionForm action={setRefundAmountAction} className="flex flex-wrap items-end gap-2">
                        <input type="hidden" name="clientId" value={r.client.id} /><input type="hidden" name="taxYear" value={r.taxYear} />
                        <Field label="Fee owed ($)"><input className="input w-32" name="amount" inputMode="decimal" required /></Field>
                        <Button type="submit">Approve — awaiting deposit</Button>
                      </ActionForm>
                    )}
                    {status === "AWAITING_DEPOSIT" && (
                      <ActionForm action={recordRefundDepositAction.bind(null, r.id)} className="flex flex-wrap items-end gap-2">
                        <Field label="Deposit received ($)"><input className="input w-32" name="amount" inputMode="decimal" required defaultValue={r.amountCents != null ? (r.amountCents / 100).toFixed(2) : ""} /></Field>
                        <Field label="Date"><input className="input" type="date" name="receivedOn" required defaultValue={today()} /></Field>
                        <Button type="submit" data-testid="record-deposit">Clear — deposit received</Button>
                      </ActionForm>
                    )}
                    {(status === "REQUESTED" || status === "AWAITING_DEPOSIT") && (
                      <details><summary className="cursor-pointer font-semibold text-red-800">Not received</summary>
                        <ActionForm action={refundNotReceivedAction.bind(null, r.id)} className="mt-2 flex items-end gap-2"><Field label="Reason"><input className="input" name="note" required maxLength={300} /></Field><Button type="submit" variant="danger">Mark not received</Button></ActionForm>
                      </details>
                    )}
                    {(status === "RECEIVED" || status === "SHORT") && (
                      <details><summary className="cursor-pointer text-slate-600">Undo deposit</summary>
                        <ActionForm action={undoRefundDepositAction.bind(null, r.id)} className="mt-2 flex items-end gap-2"><Field label="Reason"><input className="input" name="note" required maxLength={300} /></Field><Button type="submit" variant="secondary">Undo</Button></ActionForm>
                      </details>
                    )}
                    {(status === "REQUESTED" || status === "AWAITING_DEPOSIT" || status === "NOT_RECEIVED") && (
                      <details><summary className="cursor-pointer text-slate-600">Cancel</summary>
                        <ActionForm action={cancelRefundTransferAction.bind(null, r.id)} className="mt-2 flex items-end gap-2"><Field label="Reason"><input className="input" name="note" required maxLength={300} /></Field><Button type="submit" variant="secondary">Cancel</Button></ActionForm>
                      </details>
                    )}
                  </div>
                  {r.events.length > 0 && <p className="mt-2 text-xs text-slate-500">Last: {r.events[0].action.replaceAll("_", " ").toLowerCase()} · {fmtDateTime(r.events[0].createdAt)}{r.events[0].note ? ` · ${r.events[0].note}` : ""}</p>}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </>
  );
}
