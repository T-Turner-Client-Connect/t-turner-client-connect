import Link from "next/link";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, EmptyState, Field, Notice, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { recordHeading } from "@/lib/services/related-businesses";
import { isReportApprover } from "@/lib/services/bookkeeping-clients";
import { ACCOUNT_TYPES, SUBTYPES, balanceSheet, canUseLedger, isFeedSubtype, ledgerFlags, officeMayWorkBooks, ledgerOverview, profitAndLoss, todayCentral, ymdOf, type Basis, type ReportRow } from "@/lib/services/ledger";
import { closeChecklist, suggestCategories } from "@/lib/services/ledger-review";
import { receivablesAging, stripeMode } from "@/lib/services/client-invoicing";
import { BANK_CONSENT_TEXT, bankConnectionsView } from "@/lib/services/banking";
import { PLAID_MODE_TEXT } from "@/lib/plaid";
import { BankConnect } from "@/components/bank-connect";
import { fmtDateTime } from "@/lib/format";
import {
  clearBankFlagAction, disconnectBankAction, mapBankAccountAction, retrieveNowAction,
  addAccountAction, addCustomerAction, addRecurringAction, addRuleAction, categorizeAction, closeBooksAction, createInvoiceAction, excludeAction, generateDraftsAction, importBankAction, includeAction,
  issueInvoiceAction, journalEntryAction, openingBalancesAction, reconcileAction, recordInvoicePaymentAction, reopenBooksAction, reverseEntryAction, setupLedgerAction, toggleAccountAction, voidInvoiceAction,
} from "@/app/actions/ledger";

export const metadata = { title: "Books & Ledger" };

const TABS = [
  ["overview", "Overview"],
  ["bank", "Bank & reconcile"],
  ["journal", "Journal"],
  ["accounts", "Chart of accounts"],
  ["reports", "Statements"],
  ["invoicing", "Invoicing (test)"],
] as const;
type Tab = (typeof TABS)[number][0];
const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const money = (c: number) => (c < 0 ? `$(${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })})` : `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`);

export default async function BooksPage({ params, searchParams }: { params: Promise<{ clientId: string }>; searchParams: Promise<{ tab?: string; year?: string; basis?: string; month?: string }> }) {
  await connection();
  const user = await requireUser();
  const { clientId } = await params;
  const sp = await searchParams;
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { id: true, displayName: true, businessName: true } });
  if (!client) notFound();
  const heading = (await recordHeading(clientId))?.title ?? client.businessName ?? client.displayName;
  const back = <p className="mb-2 text-sm"><Link className="underline" href={`/bookkeeping/${clientId}`}>← {heading}&apos;s bookkeeping workspace</Link></p>;
  if (!(await canUseLedger(user, clientId))) {
    return (<>{back}<PageHeader title="Books & Ledger" /><Notice tone="warn" title="Not available">Only Admins and the staff member assigned to this client can open its books.</Notice></>);
  }
  const owner = await isReportApprover(user);
  const ov = await ledgerOverview(user, clientId);
  // Business books are only built for an owner-approved Managed Business; existing history stays readable.
  // The office works on any Bookkeeping Client (or Managed Business); client portal access is a separate matter.
  const managed = await officeMayWorkBooks(clientId);
  const notManaged = (
    <Notice tone="warn" title="Regular Tax Client — books are read-only">
      This business isn&apos;t on the Bookkeeping Client list, so its books can&apos;t be set up or changed. Add it in{" "}
      <Link className="underline" href={`/bookkeeping/new?client=${clientId}`}>Add Bookkeeping Client</Link>. (Managed Business access in{" "}
      <Link className="underline" href="/owner/business-access">Owner&apos;s Office → Business access</Link> controls only what the client sees in their portal.)
    </Notice>
  );
  const tab: Tab = (TABS.map((t) => t[0]) as string[]).includes(sp.tab ?? "") ? (sp.tab as Tab) : "overview";
  const tabHref = (t: string) => `/bookkeeping/${clientId}/books?tab=${t}`;

  if (!ov.book) {
    return (
      <>
        {back}
        <PageHeader title={`${heading} — Books & Ledger`} subtitle="Double-entry books kept for this client only." />
        {!managed ? notManaged : <Card title="Set up this client's books">
          <p className="mb-3 text-sm text-slate-700">Creates this client&apos;s own ledger with a standard chart of accounts (owner draws in equity, never in expenses). You can add, rename or deactivate accounts afterwards.</p>
          <ActionForm action={setupLedgerAction.bind(null, clientId)} className="flex flex-wrap items-end gap-3">
            <Field label="Reporting basis"><select className="input" name="basis" defaultValue="CASH"><option value="CASH">Cash basis</option><option value="ACCRUAL">Accrual basis</option></select></Field>
            <Field label="Fiscal year starts"><select className="input" name="fy" defaultValue="1">{MONTH_ABBR.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</select></Field>
            <Button type="submit">Set up books</Button>
          </ActionForm>
        </Card>}
      </>
    );
  }
  const { book, accounts, entries, bank, imports, recons } = ov;
  const active = accounts.filter((a) => a.active);
  const banks = active.filter((a) => isFeedSubtype(a.subtype));
  const acctLabel = (a: { code: string; name: string }) => `${a.code} · ${a.name}`;
  const options = (list = active) => list.map((a) => <option key={a.id} value={a.id}>{acctLabel(a)}</option>);
  const today = todayCentral();

  return (
    <>
      {back}
      <PageHeader
        title={`${heading} — Books & Ledger`}
        subtitle={<>{book.basis === "CASH" ? "Cash basis" : "Accrual basis"} · Fiscal year starts {MONTH_ABBR[book.fiscalYearStartMonth - 1]} · {book.openingDate ? `Opening balances ${ymdOf(book.openingDate)}` : "Opening balances not entered"} · {book.lockedThrough ? `Closed through ${ymdOf(book.lockedThrough)}` : "No period closed"}</>}
      />
      {!managed && <div className="mb-4">{notManaged}</div>}
      <nav className="mb-4 flex flex-wrap gap-2" aria-label="Books sections" data-testid="books-tabs">
        {TABS.map(([k, label]) => (
          <Link key={k} href={tabHref(k)} aria-current={tab === k ? "page" : undefined} className={`rounded-full px-3 py-1.5 text-sm font-semibold ${tab === k ? "bg-navy-900 text-gold-300 ring-2 ring-gold-500" : "bg-ivory-50 text-navy-900 ring-1 ring-ivory-200 hover:bg-gold-100"}`}>{label}</Link>
        ))}
      </nav>

      {tab === "overview" && <Overview />}
      {tab === "bank" && <BankTab />}
      {tab === "journal" && <JournalTab />}
      {tab === "accounts" && <AccountsTab />}
      {tab === "reports" && <ReportsTab />}
      {tab === "invoicing" && <InvoicingTab />}
    </>
  );

  async function Overview() {
    const flags = await ledgerFlags(user, clientId);
    const month = sp.month && /^\d{4}-\d{2}$/.test(sp.month) ? sp.month : (() => { const d = new Date(`${today.slice(0, 7)}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); })();
    const close = await closeChecklist(user, clientId, month, today);
    const opening = accounts.filter((a) => a.active && ["ASSET", "LIABILITY", "EQUITY"].includes(a.type) && a.subtype !== "OPENING_BALANCE" && a.subtype !== "RETAINED_EARNINGS");
    return (
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Needs review" className="lg:col-span-2">
          {flags.length === 0 ? <p className="text-sm text-emerald-800">Nothing flagged.</p> : (
            <ul className="space-y-1 text-sm" data-testid="ledger-flags">
              {flags.map((f, i) => <li key={i} className="flex gap-2"><Badge tone={f.severity === "HIGH" ? "red" : "amber"}>{f.severity === "HIGH" ? "Fix" : "Review"}</Badge><span>{f.message}</span></li>)}
            </ul>
          )}
          <p className="mt-2 text-xs text-slate-500">Flags only point to what needs a person&apos;s attention. Nothing is filled in or changed automatically.</p>
        </Card>
        <Card title={`Monthly close checklist — ${month}`}>
          <form className="mb-2 flex items-end gap-2" action={`/bookkeeping/${clientId}/books`}><input type="hidden" name="tab" value="overview" /><Field label="Month"><input className="input" type="month" name="month" defaultValue={month} /></Field><Button variant="ghost" type="submit">Check</Button></form>
          <ul className="space-y-1 text-sm" data-testid="close-checklist">
            {close.items.map((i) => <li key={i.key} className="flex gap-2"><span aria-hidden>{i.ok ? "✅" : "⬜"}</span><span><strong>{i.label}</strong> <span className="text-slate-600">— {i.detail}</span></span></li>)}
          </ul>
          <p className="mt-2 text-sm">{close.readyForReview ? <Badge tone="green">Ready for Tabitha&apos;s review</Badge> : <Badge tone="amber">Not ready yet</Badge>}</p>
        </Card>
        <Card title="Opening balances">
          {book.openingDate ? <p className="text-sm">Posted as of {ymdOf(book.openingDate)}. Corrections are made with an adjusting entry.</p> : (
            <ActionForm action={openingBalancesAction.bind(null, clientId)} className="space-y-2">
              <p className="text-xs text-slate-600">Enter each balance exactly as the client&apos;s statements show on the opening date (positive on the account&apos;s normal side). The difference goes to Opening Balance Equity.</p>
              <Field label="Opening date"><input className="input" type="date" name="date" required /></Field>
              <div className="max-h-72 space-y-1 overflow-y-auto">
                {opening.map((a) => <label key={a.id} className="flex items-center gap-2 text-sm"><input type="hidden" name="accountId" value={a.id} /><span className="w-64 truncate">{acctLabel(a)}</span><input className="input w-36" name="amount" inputMode="decimal" placeholder="0.00" /></label>)}
              </div>
              <Button type="submit">Post opening balances</Button>
            </ActionForm>
          )}
        </Card>
        <Card title="Closing approved periods" className="lg:col-span-2">
          <p className="mb-2 text-sm text-slate-700">After Tabitha approves a period&apos;s statements, the books are closed through its last day. Nothing on or before that date can be posted or reversed; corrections go in an open period as adjusting entries.</p>
          {owner ? (
            <div className="flex flex-wrap gap-4">
              <ActionForm action={closeBooksAction.bind(null, clientId)} className="flex items-end gap-2" confirm="Close the books through this date? Entries on or before it can no longer change.">
                <Field label="Close through"><input className="input" type="date" name="through" required /></Field><Button type="submit" variant="secondary">Close books</Button>
              </ActionForm>
              {book.lockedThrough && (
                <ActionForm action={reopenBooksAction.bind(null, clientId)} className="flex flex-wrap items-end gap-2">
                  <Field label="Reopen back to (blank = fully open)"><input className="input" type="date" name="through" /></Field>
                  <Field label="Reason"><input className="input w-72" name="reason" required /></Field><Button type="submit" variant="ghost">Reopen</Button>
                </ActionForm>
              )}
            </div>
          ) : <p className="text-xs text-slate-600">Only Tabitha closes or reopens periods.</p>}
        </Card>
      </div>
    );
  }

  async function BankTab() {
    const [suggestions, bv] = await Promise.all([suggestCategories(user, clientId), bankConnectionsView(user, clientId)]);
    const FLAG_LABEL: Record<string, string> = { POSSIBLE_DUPLICATE: "Possible duplicate", CHANGED_AFTER_POSTING: "Changed by the bank after posting", REMOVED_AFTER_POSTING: "Removed by the bank after posting" };
    const toReview = bank.filter((t) => t.status === "UNREVIEWED");
    const done = bank.filter((t) => t.status !== "UNREVIEWED");
    const name = new Map(accounts.map((a) => [a.id, acctLabel(a)]));
    return (
      <div className="space-y-4">
        <Card title="Automatic bank retrieval (read-only)">
          <div data-testid="bank-connections" className="space-y-3 text-sm">
            <p className="text-slate-700">Once the client authorizes a read-only connection for this business, new transactions are retrieved automatically (at least daily, and when the bank reports new ones) into the review list below. Rows already imported from a statement are recognized, not added twice. <Link className="font-semibold underline" href={`/bookkeeping/${clientId}/coetha`}>Coetha</Link> drafts categories for Tabitha to approve; she never posts on her own. CSV import below stays available as a backup.</p>
            <p data-testid="bank-mode" className={bv.mode === "LIVE" ? "font-semibold text-emerald-800" : bv.mode === "SANDBOX" ? "font-semibold text-navy-900" : "font-semibold text-red-700"}>{PLAID_MODE_TEXT[bv.mode]}</p>
            {bv.connections.length === 0 && <p className="text-slate-600">No bank connected yet.</p>}
            {bv.connections.map((c) => (
              <div key={c.id} className="rounded-lg border border-ivory-200 p-3">
                <p className="flex flex-wrap items-center gap-2"><strong>{c.institutionName ?? "Bank"}</strong>
                  <Badge tone={c.status === "ACTIVE" ? "green" : c.status === "DISCONNECTED" ? "gray" : "red"}>{c.status === "NEEDS_REAUTH" ? "Client must sign in again" : c.status.toLowerCase()}</Badge>
                  <Badge tone="navy">{c.environment.toLowerCase()}</Badge>
                  <span data-testid="bank-last-sync">Last successful retrieval: {c.lastSuccessAt ? fmtDateTime(c.lastSuccessAt) : "not yet"}</span>
                </p>
                <p className="text-xs text-slate-600">Authorized by {c.authorizedByName} ({c.authorizationMethod.replaceAll("_", " ").toLowerCase()}) · consent {c.consentVersion}{c.lastError ? ` · Last problem: ${c.lastError}` : ""}</p>
                <ul className="mt-2 space-y-1">
                  {c.accounts.map((a) => (
                    <li key={a.id} className="flex flex-wrap items-center gap-2">
                      <span className="w-56">{a.name}{a.mask ? ` ····${a.mask}` : ""} <span className="text-xs text-slate-500">({a.subtype ?? a.type})</span></span>
                      <ActionForm action={mapBankAccountAction.bind(null, clientId, a.id)} className="flex items-center gap-1" showSuccess={false}>
                        <select className="input py-1 text-xs" name="ledgerAccountId" defaultValue={a.ledgerAccountId ?? ""}><option value="">Not retrieved</option>{options(banks)}</select>
                        <Button type="submit" variant="ghost" className="px-2 py-1 text-xs">Save</Button>
                      </ActionForm>
                    </li>
                  ))}
                </ul>
                {c.runs.length > 0 && <p className="mt-1 text-xs text-slate-500">Recent: {c.runs.map((r) => `${fmtDateTime(r.startedAt)} ${r.trigger.toLowerCase()} ${r.status === "OK" ? `+${r.added}, ${r.matched} linked` : `failed (${r.errorCode})`}`).join(" · ")}</p>}
                {c.status === "NEEDS_REAUTH" && (
                  <div className="mt-2 rounded-lg border border-red-200 bg-red-50 p-2 text-xs text-red-900" data-testid="bank-reauth">
                    <p><strong>The client needs to sign in to the bank again</strong>{c.reauthRequiredAt ? ` (since ${fmtDateTime(c.reauthRequiredAt)})` : ""}{c.errorCode ? ` · ${c.errorCode}` : ""}. Retrieval is paused for this connection until they do.</p>
                    {(bv.mode === "LIVE" ? "PRODUCTION" : bv.mode === "SANDBOX" ? "SANDBOX" : null) === c.environment && <div className="mt-1"><BankConnect clientId={clientId} consentText={BANK_CONSENT_TEXT} reauthConnectionId={c.id} /></div>}
                  </div>
                )}
                {c.status !== "DISCONNECTED" && user.role === "ADMIN" && (
                  <details className="mt-1 text-xs"><summary className="cursor-pointer underline">Disconnect</summary>
                    <ActionForm action={disconnectBankAction.bind(null, clientId, c.id)} className="mt-1 flex gap-1"><input className="input py-1 text-xs" name="reason" placeholder="Why?" required /><Button type="submit" variant="ghost" className="px-2 py-1 text-xs">Disconnect</Button></ActionForm>
                  </details>
                )}
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-3">
              {(bv.mode === "SANDBOX" || bv.mode === "LIVE") && <BankConnect clientId={clientId} consentText={BANK_CONSENT_TEXT} live={bv.mode === "LIVE"} />}
              {bv.connections.some((c) => c.status === "ACTIVE" || c.status === "ERROR") && (
                <ActionForm action={retrieveNowAction.bind(null, clientId)}><Button type="submit" variant="gold" data-testid="bank-retrieve">Retrieve now</Button></ActionForm>
              )}
            </div>
          </div>
        </Card>
        <div className="grid gap-4 lg:grid-cols-3">
          <Card title="Import a statement (CSV)">
            {banks.length === 0 ? <p className="text-sm">Add a bank or credit card account first.</p> : (
              <ActionForm action={importBankAction.bind(null, clientId)} className="space-y-2" resetOnSuccess>
                <Field label="Account"><select className="input" name="accountId" required>{options(banks)}</select></Field>
                <Field label="Statement file (.csv)" hint="Needs Date, Description and Amount (or Debit and Credit) columns. Rows already imported are skipped."><input className="input" type="file" name="file" accept=".csv,text/csv" required /></Field>
                <Button type="submit">Import</Button>
              </ActionForm>
            )}
            {imports.length > 0 && <ul className="mt-3 space-y-0.5 text-xs text-slate-600">{imports.slice(0, 6).map((i) => <li key={i.id}>{i.fileName}: {i.added} added, {i.duplicates} skipped{i.firstDate ? ` · ${ymdOf(i.firstDate)} – ${ymdOf(i.lastDate!)}` : ""}</li>)}</ul>}
          </Card>
          <Card title="Reconcile to the statement">
            {banks.length === 0 ? <p className="text-sm">No bank accounts yet.</p> : (
              <ActionForm action={reconcileAction.bind(null, clientId)} className="space-y-2">
                <Field label="Account"><select className="input" name="accountId" required>{options(banks)}</select></Field>
                <Field label="Statement ending date"><input className="input" type="date" name="statementDate" required /></Field>
                <Field label="Statement ending balance"><input className="input" name="statementBalance" inputMode="decimal" required /></Field>
                <Button type="submit" variant="secondary">Reconcile</Button>
              </ActionForm>
            )}
            {recons.length > 0 && <ul className="mt-3 space-y-0.5 text-xs text-slate-600">{recons.slice(0, 6).map((r) => <li key={r.id}>✓ {r.account.name} through {ymdOf(r.statementDate)}: {money(r.statementBalanceCents)}</li>)}</ul>}
          </Card>
          <Card title="Category rules (suggestions)">
            <ActionForm action={addRuleAction.bind(null, clientId)} className="space-y-2" resetOnSuccess>
              <Field label="When the description contains"><input className="input" name="matchText" placeholder="e.g. CLOVER" required /></Field>
              <Field label="Direction"><select className="input" name="direction"><option value="ANY">Money in or out</option><option value="OUT">Money out</option><option value="IN">Money in</option></select></Field>
              <Field label="Suggest"><select className="input" name="accountId" required>{options(active.filter((a) => a.subtype !== "OPENING_BALANCE" && a.subtype !== "SUSPENSE"))}</select></Field>
              <Button type="submit" variant="ghost">Save rule</Button>
            </ActionForm>
            <p className="mt-2 text-xs text-slate-500">Rules and past postings only suggest; a person posts every transaction.</p>
          </Card>
        </div>
        <Card title={`To review (${toReview.length})`}>
          {toReview.length === 0 ? <EmptyState title="Nothing waiting" /> : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="bank-review">
                <thead className="text-left text-slate-600"><tr><th className="py-1">Date</th><th>Account</th><th>Description</th><th className="text-right">Amount</th><th>Post to</th><th></th></tr></thead>
                <tbody className="divide-y divide-ivory-200">
                  {toReview.map((t) => {
                    const s = suggestions.get(t.id);
                    return (
                      <tr key={t.id}>
                        <td className="whitespace-nowrap py-2">{ymdOf(t.date)}</td>
                        <td className="whitespace-nowrap">{t.account.name}</td>
                        <td>{t.description}</td>
                        <td className={`whitespace-nowrap text-right ${t.amountCents < 0 ? "" : "text-emerald-800"}`}>{money(t.amountCents)}</td>
                        <td>
                          <ActionForm action={categorizeAction.bind(null, clientId, t.id)} className="flex items-center gap-1" showSuccess={false}>
                            <select className="input max-w-56 py-1 text-xs" name="accountId" defaultValue={s?.accountId ?? ""} required><option value="" disabled>Choose…</option>{options(active.filter((a) => a.id !== t.accountId && a.subtype !== "OPENING_BALANCE"))}</select>
                            <Button type="submit" variant="secondary" className="px-2 py-1 text-xs">Post</Button>
                          </ActionForm>
                          {s && <span className="block text-[11px] text-slate-500">Suggested: {s.why}</span>}
                          {t.flag && <span className="block text-[11px] font-semibold text-red-700">{FLAG_LABEL[t.flag] ?? t.flag}: {t.flagNote}</span>}
                        </td>
                        <td>
                          <details className="text-xs"><summary className="cursor-pointer underline">Exclude</summary>
                            <ActionForm action={excludeAction.bind(null, clientId, t.id)} className="mt-1 flex gap-1"><input className="input py-1 text-xs" name="reason" placeholder="Why?" required /><Button type="submit" variant="ghost" className="px-2 py-1 text-xs">OK</Button></ActionForm>
                          </details>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card title="Reviewed">
          {done.length === 0 ? <p className="text-sm text-slate-600">None yet.</p> : (
            <ul className="divide-y divide-ivory-200 text-sm">
              {done.slice(0, 100).map((t) => {
                const cat = t.journalEntry?.lines.find((l) => l.accountId !== t.accountId)?.accountId;
                return (
                  <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                    <span>{ymdOf(t.date)} · {t.description} · {money(t.amountCents)} {t.source === "PLAID" && <Badge tone="navy">daily</Badge>}{t.flag && <span className="ml-1 text-xs font-semibold text-red-700">{FLAG_LABEL[t.flag] ?? t.flag}: {t.flagNote}</span>}</span>
                    {t.flag && t.status === "POSTED" && (
                      <details className="text-xs"><summary className="cursor-pointer underline">Checked — clear flag</summary>
                        <ActionForm action={clearBankFlagAction.bind(null, clientId, t.id)} className="mt-1 flex gap-1"><input className="input py-1 text-xs" name="note" placeholder="What you checked" required /><Button type="submit" variant="ghost" className="px-2 py-1 text-xs">Clear</Button></ActionForm>
                      </details>
                    )}
                    <span className="text-xs">{t.status === "POSTED" ? <>→ {cat ? name.get(cat) : "posted"}</> : <><Badge tone="gray">Excluded</Badge> {t.excludedReason} <ActionForm action={includeAction.bind(null, clientId, t.id)} className="inline"><Button type="submit" variant="ghost" className="px-1 py-0 text-xs">Include again</Button></ActionForm></>}</span>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="mt-2 text-xs text-slate-500">To change a posted transaction, reverse its entry in the Journal; the transaction comes back here for review.</p>
        </Card>
      </div>
    );
  }

  function JournalTab() {
    return (
      <div className="space-y-4">
        <Card title="New journal entry">
          <ActionForm action={journalEntryAction.bind(null, clientId)} className="space-y-2" resetOnSuccess idempotent>
            <div className="flex flex-wrap gap-3">
              <Field label="Date"><input className="input" type="date" name="date" required /></Field>
              <Field label="Description" className="min-w-72 flex-1"><input className="input" name="memo" required /></Field>
              <Field label="Statements"><select className="input" name="basis" defaultValue="BOTH"><option value="BOTH">Cash and accrual</option><option value="ACCRUAL_ONLY">Accrual only</option><option value="CASH_ONLY">Cash only</option></select></Field>
              <label className="flex items-end gap-2 pb-2 text-sm"><input type="checkbox" name="adjusting" /> Adjusting entry</label>
            </div>
            <table className="w-full text-sm"><thead className="text-left text-slate-600"><tr><th>Account</th><th>Debit</th><th>Credit</th><th>Line note</th></tr></thead>
              <tbody>{[0, 1, 2, 3].map((i) => (
                <tr key={i}><td className="py-1 pr-2"><select className="input" name="lineAccount" defaultValue=""><option value="">—</option>{options()}</select></td><td className="pr-2"><input className="input w-32" name="lineDebit" inputMode="decimal" /></td><td className="pr-2"><input className="input w-32" name="lineCredit" inputMode="decimal" /></td><td><input className="input" name="lineDesc" /></td></tr>
              ))}</tbody>
            </table>
            <p className="text-xs text-slate-600">Debits must equal credits. Entries are never edited — to correct one, reverse it and post the right entry.</p>
            <Button type="submit">Post entry</Button>
          </ActionForm>
        </Card>
        <Card title="Journal (latest 100)">
          {entries.length === 0 ? <EmptyState title="No entries yet" /> : (
            <ul className="divide-y divide-ivory-200 text-sm" data-testid="journal">
              {entries.map((e) => (
                <li key={e.id} className="py-2">
                  <p className="flex flex-wrap items-center gap-2"><strong>{ymdOf(e.date)}</strong> {e.memo} <Badge tone="gray">{e.source.toLowerCase()}</Badge>{e.basis !== "BOTH" && <Badge tone="navy">{e.basis === "CASH_ONLY" ? "cash only" : "accrual only"}</Badge>}{e.reversedBy && <Badge tone="amber">Reversed {ymdOf(e.reversedBy.date)}</Badge>}{e.reason && <span className="text-xs text-slate-600">Reason: {e.reason}</span>}</p>
                  <table className="mt-1 text-xs"><tbody>{e.lines.map((l) => <tr key={l.id}><td className="pr-4">{l.account.code} · {l.account.name}</td><td className="w-28 text-right">{l.debitCents ? money(l.debitCents) : ""}</td><td className="w-28 text-right">{l.creditCents ? money(l.creditCents) : ""}</td><td className="pl-3 text-slate-500">{l.description}</td></tr>)}</tbody></table>
                  {!e.reversedBy && !e.reversalOfId && e.source !== "OPENING" && (
                    <details className="mt-1 text-xs"><summary className="cursor-pointer underline">Reverse</summary>
                      <ActionForm action={reverseEntryAction.bind(null, clientId, e.id)} className="mt-1 flex flex-wrap items-end gap-2">
                        <Field label="Reversal date"><input className="input" type="date" name="date" defaultValue={today} required /></Field>
                        <Field label="Why"><input className="input w-72" name="reason" required /></Field><Button type="submit" variant="ghost">Reverse entry</Button>
                      </ActionForm>
                    </details>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    );
  }

  function AccountsTab() {
    return (
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Chart of accounts" className="lg:col-span-2">
          <table className="w-full text-sm" data-testid="chart">
            <thead className="text-left text-slate-600"><tr><th className="py-1">No.</th><th>Name</th><th>Type</th><th>Kind</th><th></th></tr></thead>
            <tbody className="divide-y divide-ivory-200">
              {accounts.map((a) => (
                <tr key={a.id} className={a.active ? "" : "text-slate-400"}>
                  <td className="py-1.5">{a.code}</td><td>{a.name}{a.last4 ? ` ····${a.last4}` : ""}</td><td>{ACCOUNT_TYPES[a.type as keyof typeof ACCOUNT_TYPES]}</td><td className="text-xs">{a.subtype ? SUBTYPES[a.subtype]?.label : ""}</td>
                  <td><ActionForm action={toggleAccountAction.bind(null, clientId, a.id, !a.active)} showSuccess={false}><Button type="submit" variant="ghost" className="px-2 py-0.5 text-xs">{a.active ? "Deactivate" : "Reactivate"}</Button></ActionForm></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Card title="Add an account">
          <ActionForm action={addAccountAction.bind(null, clientId)} className="space-y-2" resetOnSuccess>
            <Field label="Number"><input className="input" name="code" required /></Field>
            <Field label="Name"><input className="input" name="name" required /></Field>
            <Field label="Type"><select className="input" name="type">{Object.entries(ACCOUNT_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
            <Field label="Kind (optional)"><select className="input" name="subtype" defaultValue=""><option value="">—</option>{Object.entries(SUBTYPES).map(([k, v]) => <option key={k} value={k}>{v.label} ({ACCOUNT_TYPES[v.type]})</option>)}</select></Field>
            <Field label="Bank (bank/card accounts)"><input className="input" name="institution" /></Field>
            <Field label="Last 4 digits only"><input className="input" name="last4" inputMode="numeric" maxLength={4} /></Field>
            <Button type="submit" variant="secondary">Add account</Button>
          </ActionForm>
        </Card>
      </div>
    );
  }

  async function ReportsTab() {
    const year = Number(sp.year) || Number(today.slice(0, 4));
    const basis: Basis = sp.basis === "ACCRUAL" || sp.basis === "CASH" ? sp.basis : (book.basis as Basis);
    const fyStart = `${book.fiscalYearStartMonth === 1 ? year : year - 1}-${String(book.fiscalYearStartMonth).padStart(2, "0")}-01`;
    const endMonth = today.slice(0, 7) < `${year}-12` && today.slice(0, 4) === String(year) ? today.slice(0, 7) : null;
    const to = endMonth ? today : new Date(Date.UTC(Number(fyStart.slice(0, 4)) + 1, book.fiscalYearStartMonth - 1, 0)).toISOString().slice(0, 10);
    const [pl, bs] = await Promise.all([profitAndLoss(user, clientId, { from: fyStart, to, basis }), balanceSheet(user, clientId, { asOf: to, basis })]);
    const label = (m: string) => MONTH_ABBR[Number(m.slice(5, 7)) - 1];
    const rows = (title: string, list: ReportRow[], total: { months: number[]; total: number }, totalLabel: string) => list.length === 0 ? null : (
      <>
        <tr><td colSpan={pl.months.length + 2} className="pt-3 font-bold text-[#2b5aa0]">{title}</td></tr>
        {list.map((r) => <tr key={r.accountId}><td className="py-1">{r.name}</td>{r.months.map((v, i) => <td key={i} className="text-right">{money(v)}</td>)}<td className="text-right">{money(r.total)}</td></tr>)}
        <tr className="border-t border-slate-400 font-semibold"><td className="py-1">{totalLabel}</td>{total.months.map((v, i) => <td key={i} className="text-right">{money(v)}</td>)}<td className="text-right">{money(total.total)}</td></tr>
      </>
    );
    return (
      <div className="space-y-4">
        <form className="flex flex-wrap items-end gap-2" action={`/bookkeeping/${clientId}/books`}>
          <input type="hidden" name="tab" value="reports" />
          <Field label="Year"><input className="input w-28" type="number" name="year" defaultValue={year} /></Field>
          <Field label="Basis"><select className="input" name="basis" defaultValue={basis}><option value="CASH">Cash</option><option value="ACCRUAL">Accrual</option></select></Field>
          <Button type="submit" variant="ghost">Show</Button>
        </form>
        <Notice>Working view from this client&apos;s ledger, in the Vessel Insurance statement layout. The branded PDF package (cover page, notes, confidential footers), Tabitha&apos;s approval and release to the portal come in Phase 2. Nothing here is visible to the client.</Notice>
        <Card title={<span className="text-[#2b5aa0]">Profit &amp; Loss Statement</span>}>
          <p className="-mt-2 mb-2 text-center text-sm italic text-slate-600">{heading} • {basis === "CASH" ? "Cash Basis" : "Accrual Basis"} • {fyStart} – {to} (Categorized, Monthly &amp; YTD)</p>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]" data-testid="pl-report">
              <thead><tr className="border-b-2 border-slate-700 text-[#1f2d5a]"><th className="py-1 text-left">Account</th>{pl.months.map((m) => <th key={m} className="text-right">{label(m)}</th>)}<th className="text-right">YTD</th></tr></thead>
              <tbody>
                {rows("INCOME", pl.income, pl.totalIncome, "Total Income")}
                {rows("COST OF GOODS SOLD", pl.cogs, pl.totalCogs, "Total Cost of Goods Sold")}
                {rows("OPERATING EXPENSES", pl.expenses, pl.totalExpenses, "Total Operating Expenses")}
                {rows("OTHER INCOME", pl.otherIncome, pl.totalOtherIncome, "Total Other Income")}
                {rows("OTHER EXPENSES", pl.otherExpense, pl.totalOtherExpense, "Total Other Expenses")}
                <tr className="border-y-2 border-slate-700 bg-slate-100 font-bold"><td className="py-1.5">NET INCOME / (LOSS)</td>{pl.netIncome.months.map((v, i) => <td key={i} className="text-right">{money(v)}</td>)}<td className="text-right">{money(pl.netIncome.total)}</td></tr>
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-slate-500">Owner draws are recorded in equity and never appear as expenses.</p>
        </Card>
        <Card title={<span className="text-[#2b5aa0]">Balance Sheet</span>}>
          <p className="-mt-2 mb-2 text-center text-sm italic text-slate-600">{heading} • {basis === "CASH" ? "Cash Basis" : "Accrual Basis"} • As of {to}</p>
          <table className="mx-auto w-full max-w-xl text-[13px]" data-testid="bs-report">
            <thead><tr className="border-b-2 border-slate-700 text-[#1f2d5a]"><th className="py-1 text-left">Account</th><th className="text-right">Amount</th></tr></thead>
            <tbody>
              <tr><td colSpan={2} className="pt-3 font-bold text-[#2b5aa0]">ASSETS</td></tr>
              {bs.assets.map((r) => <tr key={r.accountId}><td className="py-1">{r.name}</td><td className="text-right">{money(r.amount)}</td></tr>)}
              <tr className="border-t border-slate-400 font-semibold"><td className="py-1">Total Assets</td><td className="text-right">{money(bs.totalAssets)}</td></tr>
              <tr><td colSpan={2} className="pt-3 font-bold text-[#2b5aa0]">LIABILITIES</td></tr>
              {bs.liabilities.map((r) => <tr key={r.accountId}><td className="py-1">{r.name}</td><td className="text-right">{money(r.amount)}</td></tr>)}
              <tr className="border-t border-slate-400 font-semibold"><td className="py-1">Total Liabilities</td><td className="text-right">{money(bs.totalLiabilities)}</td></tr>
              <tr><td colSpan={2} className="pt-3 font-bold text-[#2b5aa0]">EQUITY</td></tr>
              {bs.equity.map((r) => <tr key={r.accountId}><td className="py-1">{r.subtype === "OWNER_DRAW" ? `Less: ${r.name}` : r.name}</td><td className="text-right">{money(r.amount)}</td></tr>)}
              {bs.retainedEarningsFromPriorYears !== 0 && <tr><td className="py-1">Retained earnings (prior years)</td><td className="text-right">{money(bs.retainedEarningsFromPriorYears)}</td></tr>}
              <tr><td className="py-1">Net income (this fiscal year)</td><td className="text-right">{money(bs.netIncomeThisYear)}</td></tr>
              <tr className="border-t border-slate-400 font-semibold"><td className="py-1">Total Equity</td><td className="text-right">{money(bs.totalEquity)}</td></tr>
              <tr className="border-y-2 border-slate-700 bg-slate-100 font-bold"><td className="py-1.5">TOTAL LIABILITIES &amp; EQUITY</td><td className="text-right">{money(bs.totalLiabilitiesAndEquity)}</td></tr>
            </tbody>
          </table>
          <p className={`mt-2 text-center text-xs ${bs.balanced ? "text-emerald-800" : "font-bold text-red-700"}`}>{bs.balanced ? "Balanced: assets equal liabilities plus equity." : "NOT BALANCED — stop and review."}</p>
        </Card>
      </div>
    );
  }

  async function InvoicingTab() {
    const [customers, invoices, recurring, aging] = await Promise.all([
      prisma.invoiceCustomer.findMany({ where: { clientId, active: true }, orderBy: { name: "asc" } }),
      prisma.clientInvoice.findMany({ where: { clientId }, orderBy: { createdAt: "desc" }, take: 50, include: { customer: { select: { name: true } }, payments: { orderBy: { receivedOn: "asc" } } } }),
      prisma.recurringInvoice.findMany({ where: { clientId }, include: { customer: { select: { name: true } } } }),
      receivablesAging(user, clientId),
    ]);
    const income = active.filter((a) => a.type === "INCOME");
    const mode = stripeMode();
    return (
      <div className="space-y-4">
        <Notice tone="warn" title="Foundation — test mode only">Staff-side invoicing for this client&apos;s own customers, separate from the office&apos;s Square billing. Stripe: <strong>{mode === "TEST" ? "test mode" : mode === "LIVE_BLOCKED" ? "a live key is set — blocked until Tabitha approves live payments" : "not set up"}</strong>. No live payments, no emails to customers, and nothing is visible in the client portal yet.</Notice>
        <div className="grid gap-4 lg:grid-cols-3">
          <Card title="Customers">
            <ul className="mb-2 text-sm">{customers.map((c) => <li key={c.id}>{c.name}{c.email ? ` · ${c.email}` : ""}</li>)}</ul>
            <ActionForm action={addCustomerAction.bind(null, clientId)} className="space-y-2" resetOnSuccess>
              <Field label="Name"><input className="input" name="name" required /></Field>
              <Field label="Email"><input className="input" name="email" type="email" /></Field>
              <Field label="Phone"><input className="input" name="phone" /></Field>
              <Button type="submit" variant="ghost">Add customer</Button>
            </ActionForm>
          </Card>
          <Card title="New invoice (draft)" className="lg:col-span-2">
            {customers.length === 0 || income.length === 0 ? <p className="text-sm">Add a customer (and an income account) first.</p> : (
              <ActionForm action={createInvoiceAction.bind(null, clientId)} className="space-y-2" resetOnSuccess idempotent>
                <div className="flex flex-wrap gap-2">
                  <Field label="Customer"><select className="input" name="customerId">{customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
                  <Field label="Invoice date"><input className="input" type="date" name="issueDate" defaultValue={today} required /></Field>
                  <Field label="Due date"><input className="input" type="date" name="dueDate" required /></Field>
                </div>
                {[0, 1, 2].map((i) => (
                  <div key={i} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_4.5rem_7rem_minmax(0,13rem)]">
                    <input className="input" name="lineDesc" placeholder="Description" aria-label={`Line ${i + 1} description`} />
                    <input className="input" name="lineQty" type="number" min={1} defaultValue={1} aria-label={`Line ${i + 1} quantity`} />
                    <input className="input" name="linePrice" inputMode="decimal" placeholder="Price" aria-label={`Line ${i + 1} price`} />
                    <select className="input" name="lineIncome" aria-label={`Line ${i + 1} income account`}>{income.map((a) => <option key={a.id} value={a.id}>{acctLabel(a)}</option>)}</select>
                  </div>
                ))}
                <Field label="Note to customer"><input className="input" name="memo" /></Field>
                <Button type="submit">Create draft</Button>
              </ActionForm>
            )}
          </Card>
        </div>
        <Card title={`Receivables — ${money(aging.totalCents)} open`}>
          <p className="mb-2 text-sm">Current {money(aging.buckets.current)} · 1–30 days {money(aging.buckets.d1_30)} · 31–60 {money(aging.buckets.d31_60)} · 61–90 {money(aging.buckets.d61_90)} · 90+ {money(aging.buckets.d90plus)}</p>
          {invoices.length === 0 ? <EmptyState title="No invoices yet" /> : (
            <ul className="divide-y divide-ivory-200 text-sm" data-testid="invoices">
              {invoices.map((i) => (
                <li key={i.id} className="py-2">
                  <p className="flex flex-wrap items-center gap-2"><strong>{i.number}</strong> {i.customer.name} · {money(i.totalCents)} · due {ymdOf(i.dueDate)} <Badge tone={i.status === "PAID" ? "green" : i.status === "VOID" ? "gray" : i.status === "DRAFT" ? "navy" : "amber"}>{i.status.replace("_", " ").toLowerCase()}</Badge>{i.paidCents > 0 && i.status !== "PAID" && <span className="text-xs">{money(i.totalCents - i.paidCents)} still owed</span>}{i.voidReason && <span className="text-xs text-slate-600">Void: {i.voidReason}</span>}</p>
                  {i.payments.length > 0 && <p className="text-xs text-slate-600">Payments: {i.payments.map((p) => `${p.receiptNumber} ${money(p.amountCents)} on ${ymdOf(p.receivedOn)} (${p.method.replace("_", " ").toLowerCase()}${p.feeCents ? `, fee ${money(p.feeCents)}` : ""})`).join("; ")}</p>}
                  <div className="mt-1 flex flex-wrap gap-3">
                    {i.status === "DRAFT" && <ActionForm action={issueInvoiceAction.bind(null, clientId, i.id)} confirm={`Issue ${i.number}? It will be recorded as owed.`}><Button type="submit" variant="secondary" className="px-2 py-1 text-xs">Issue</Button></ActionForm>}
                    {(i.status === "OPEN" || i.status === "PARTIALLY_PAID") && (
                      <details className="text-xs"><summary className="cursor-pointer underline">Record payment</summary>
                        <ActionForm action={recordInvoicePaymentAction.bind(null, clientId, i.id)} className="mt-1 flex flex-wrap items-end gap-2" idempotent>
                          <Field label="Amount"><input className="input w-28" name="amount" defaultValue={((i.totalCents - i.paidCents) / 100).toFixed(2)} required /></Field>
                          <Field label="Received"><input className="input" type="date" name="receivedOn" defaultValue={today} required /></Field>
                          <Field label="Method"><select className="input" name="method"><option value="CHECK">Check</option><option value="ACH">ACH</option><option value="ZELLE">Zelle</option><option value="CASH">Cash</option><option value="STRIPE_TEST">Stripe (test)</option><option value="OTHER">Other</option></select></Field>
                          <Field label="Processor fee"><input className="input w-24" name="fee" inputMode="decimal" /></Field>
                          <Field label="Reference"><input className="input w-28" name="reference" /></Field>
                          <Button type="submit" variant="secondary">Record</Button>
                        </ActionForm>
                      </details>
                    )}
                    {i.status !== "VOID" && i.paidCents === 0 && (
                      <details className="text-xs"><summary className="cursor-pointer underline">Void</summary>
                        <ActionForm action={voidInvoiceAction.bind(null, clientId, i.id)} className="mt-1 flex flex-wrap items-end gap-2">
                          <Field label="Date"><input className="input" type="date" name="date" defaultValue={today} required /></Field>
                          <Field label="Why"><input className="input w-64" name="reason" required /></Field><Button type="submit" variant="ghost">Void</Button>
                        </ActionForm>
                      </details>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Recurring invoices (create drafts only)">
          <ul className="mb-2 text-sm">{recurring.map((r) => <li key={r.id}>{r.customer.name} · {r.cadence.toLowerCase()} · next {ymdOf(r.nextDate)}{r.active ? "" : " · paused"}</li>)}</ul>
          <ActionForm action={generateDraftsAction.bind(null, clientId)} className="mb-3"><Button type="submit" variant="ghost">Create drafts that are due</Button></ActionForm>
          {customers.length > 0 && income.length > 0 && (
            <ActionForm action={addRecurringAction.bind(null, clientId)} className="flex flex-wrap items-end gap-2" resetOnSuccess>
              <Field label="Customer"><select className="input" name="customerId">{customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
              <Field label="Every"><select className="input" name="cadence"><option value="MONTHLY">Month</option><option value="QUARTERLY">Quarter</option><option value="YEARLY">Year</option></select></Field>
              <Field label="First invoice"><input className="input" type="date" name="startDate" required /></Field>
              <Field label="Due after (days)"><input className="input w-20" type="number" name="dueDays" defaultValue={15} /></Field>
              <Field label="Description"><input className="input" name="description" required /></Field>
              <Field label="Price"><input className="input w-28" name="price" inputMode="decimal" required /></Field>
              <Field label="Income account"><select className="input" name="incomeAccountId">{income.map((a) => <option key={a.id} value={a.id}>{acctLabel(a)}</option>)}</select></Field>
              <Button type="submit" variant="secondary">Save</Button>
            </ActionForm>
          )}
        </Card>
      </div>
    );
  }
}
