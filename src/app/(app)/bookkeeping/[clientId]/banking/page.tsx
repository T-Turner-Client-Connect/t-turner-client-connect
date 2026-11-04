import Link from "next/link";
import clsx from "clsx";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { Building2, CreditCard, Landmark, Link2, ListChecks, Plus, ShieldCheck } from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { ActionForm } from "@/components/action-form";
import { BankConnect } from "@/components/bank-connect";
import { card, Dot, h2, navyBtn, outlineBtn } from "@/components/bk/parts";
import { bankingRegistry, CONN_LABEL, lightOf, REC_LABEL, REGISTRY_TYPES, registryLabel } from "@/lib/services/bank-accounts";
import { canManageBanking, canViewBanking } from "@/lib/services/bk-permissions";
import { BANK_CONSENT_TEXT } from "@/lib/services/banking";
import { currentPlaidMode, PLAID_MODE_TEXT } from "@/lib/plaid";
import { usd } from "@/lib/services/ledger";
import { workMonth } from "@/lib/services/bookkeeping-clients";
import { fmtDateTime } from "@/lib/format";
import { monitorAccountAction, registerAccountAction, sharedCardAction } from "@/app/actions/bk-workflow";

export const metadata = { title: "Banking & Credit Card Connections" };

const GROUPS = [
  { title: "Bank accounts", types: ["CHECKING", "SAVINGS"], icon: Landmark },
  { title: "Credit cards", types: ["CREDIT_CARD"], icon: CreditCard },
  { title: "Lines of credit & loans", types: ["LINE_OF_CREDIT", "LOAN"], icon: Building2 },
  { title: "Other accounts", types: ["MERCHANT", "OTHER"], icon: Building2 },
];
const CONN_TONE: Record<string, string> = { CONNECTED: "bg-emerald-50 text-emerald-800", NEEDS_REAUTH: "bg-red-50 text-red-800", ERROR: "bg-red-50 text-red-800", NOT_CONNECTED: "bg-slate-100 text-slate-700", MANUAL: "bg-navy-50 text-navy-800" };

export default async function BankingPage({ params }: { params: Promise<{ clientId: string }> }) {
  await connection();
  const user = await requireUser();
  const { clientId } = await params;
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { displayName: true, businessName: true } });
  if (!client) notFound();
  const biz = client.businessName || client.displayName;
  const base = `/bookkeeping/${clientId}`;
  if (!(await canViewBanking(user, clientId))) {
    return <div className={clsx(card, "p-6 text-navy-900")}>Only Admins, the staff member assigned to {biz} and staff Tabitha allows can see its banking.</div>;
  }
  const [reg, manage, mode, book] = await Promise.all([bankingRegistry(user, clientId), canManageBanking(user, clientId), currentPlaidMode(), prisma.ledgerBook.findUnique({ where: { clientId }, select: { clientId: true } })]);
  const wm = workMonth("MONTHLY");
  const recs = await prisma.accountReconciliation.findMany({ where: { clientId, year: wm.year, month: wm.month } });
  const recOf = (id: string) => recs.find((r) => r.bookkeepingAccountId === id) ?? null;
  const parents = reg.rows.filter((r) => r.accountType === "CREDIT_CARD");
  const total = reg.rows.length + reg.rows.reduce((n, r) => n + r.subCards.length, 0);
  const monthName = new Date(Date.UTC(wm.year, wm.month - 1, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

  return (
    <div className="space-y-5" data-testid="banking-page">
      <p className="text-sm"><Link className="underline" href={base}>← Client Overview</Link></p>
      <section className="rounded-2xl bg-gradient-to-br from-navy-900 via-navy-950 to-navy-900 px-5 py-5 text-white ring-1 ring-gold-500/40 sm:px-7">
        <p className="text-xs uppercase tracking-[0.2em] text-gold-300">Owner&apos;s Office · Banking &amp; Reconciliation</p>
        <h1 className="mt-1 font-serif text-2xl font-bold text-white">Banking &amp; Credit Card Connections</h1>
        <p className="mt-1 text-sm text-navy-100">{biz} · read-only bank feeds and every account Coetha monitors. Only the institution, a nickname and the last 4 digits are stored.</p>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="banking-kpis">
          {[["Accounts", String(total)], ["Connected", `${reg.connected} of ${reg.rows.length}`], ["Institutions linked", String(reg.institutions)], ["Last synced", reg.lastSync ? fmtDateTime(reg.lastSync) : "Not yet"]].map(([k, v]) => (
            <div key={k} className="rounded-xl bg-white/10 px-3 py-2"><p className="text-xs text-navy-100">{k}</p><p className="font-semibold text-white">{v}</p></div>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link href={`${base}/banking/reconciliation`} className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-gradient-to-b from-gold-300 to-gold-500 px-4 py-2 text-sm font-semibold text-navy-950"><ListChecks className="size-4" aria-hidden /> Monthly reconciliation</Link>
          <Link href={`${base}/books?tab=bank`} className="inline-flex min-h-10 items-center rounded-lg border border-white/70 px-4 py-2 text-sm font-semibold text-white hover:bg-white/10">Review transactions</Link>
        </div>
      </section>

      {/* Connect a financial institution */}
      <section className={clsx(card, "scroll-mt-6 p-4 sm:p-5")} id="connect" data-testid="connect-institution">
        <h2 className={h2}><Link2 className="size-5 text-gold-600" aria-hidden /> Connect Financial Institution</h2>
        <p className="mt-1 text-sm text-navy-800">The client signs in to their bank in Plaid&apos;s secure window (Client Connect never sees bank passwords), then you choose which accounts Coetha monitors. Connect as many institutions as the business uses; each card or account is its own account below.</p>
        <p className={clsx("mt-2 text-sm font-semibold", mode === "LIVE" ? "text-emerald-800" : mode === "SANDBOX" ? "text-navy-900" : "text-red-700")} data-testid="bank-mode">{PLAID_MODE_TEXT[mode]}</p>
        {manage && book && (mode === "SANDBOX" || mode === "LIVE") && <div className="mt-2"><BankConnect clientId={clientId} consentText={BANK_CONSENT_TEXT} live={mode === "LIVE"} /></div>}
        {!book && <p className="mt-2 text-sm text-navy-800">Set up the books first in <Link className="font-semibold underline" href={`${base}/books`}>General Ledger</Link> so each account gets its GL account.</p>}
        {(reg.unmonitored.length > 0 || reg.sharedSuggestions.length > 0) && (
          <div className="mt-3 space-y-3">
            {reg.unmonitored.length > 0 && (
              <div className="rounded-xl border border-gold-300 bg-ivory-50 p-3" data-testid="choose-monitored">
                <p className="text-sm font-semibold text-navy-900">Choose which accounts Coetha monitors</p>
                <ul className="mt-2 space-y-2">
                  {reg.unmonitored.map((ca) => (
                    <li key={ca.id} className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="min-w-48">{ca.connection.institutionName ?? "Bank"} · {ca.name}{ca.mask ? ` ••${ca.mask}` : ""} <span className="text-xs text-slate-500">({ca.subtype ?? ca.type})</span></span>
                      {manage && (
                        <ActionForm action={monitorAccountAction.bind(null, clientId, ca.id)} className="flex flex-wrap items-center gap-1" showSuccess={false}>
                          <select className="input py-1 text-sm" name="registryId" defaultValue="NEW" aria-label="Registered account">
                            <option value="NEW">Add as a new account</option>
                            {reg.rows.map((r) => <option key={r.id} value={r.id}>{registryLabel(r)}</option>)}
                          </select>
                          <button type="submit" className={outlineBtn}>Monitor</button>
                        </ActionForm>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {reg.sharedSuggestions.length > 0 && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-3" data-testid="shared-cards">
                <p className="text-sm font-semibold text-amber-900">Employee cards on one shared credit account?</p>
                <ul className="mt-2 space-y-2 text-sm text-amber-900">
                  {reg.sharedSuggestions.map((ca) => (
                    <li key={ca.id}>
                      <p>••{ca.mask} → shared with ••{ca.primary?.mask ?? "?"}. {ca.sharedReason}</p>
                      {manage && (
                        <div className="mt-1 flex flex-wrap gap-2">
                          <ActionForm action={sharedCardAction.bind(null, clientId, ca.id, "CONFIRM")} showSuccess={false}><button type="submit" className={navyBtn}>Confirm — one account</button></ActionForm>
                          <ActionForm action={sharedCardAction.bind(null, clientId, ca.id, "SEPARATE")} showSuccess={false}><button type="submit" className={outlineBtn}>Separate account</button></ActionForm>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Accounts, grouped */}
      {GROUPS.map((g) => {
        const rows = reg.rows.filter((r) => g.types.includes(r.accountType));
        if (!rows.length && g.title === "Other accounts") return null;
        return (
          <section key={g.title} className={clsx(card, "scroll-mt-6 p-4 sm:p-5")} id={`group-${g.types[0]}`} data-testid={`group-${g.types[0]}`}>
            <h2 className={h2}><g.icon className="size-5 text-gold-600" aria-hidden /> {g.title} <span className="rounded-full bg-navy-900 px-2.5 py-0.5 font-sans text-xs font-semibold text-gold-300">{rows.length}</span></h2>
            {!rows.length ? <p className="mt-2 text-sm text-slate-600">None registered.</p> : (
              <ul className="mt-3 divide-y divide-ivory-200">
                {rows.map((r) => {
                  const rec = recOf(r.id);
                  const light = lightOf(rec);
                  return (
                    <li key={r.id} className="py-3" data-testid="registry-row">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-semibold text-navy-900">{r.nickname || r.institution}{r.last4 && <span className="ml-1 font-normal text-navy-800">••{r.last4}</span>}</p>
                          <p className="text-xs text-slate-600">{r.institution} · {REGISTRY_TYPES[r.accountType as keyof typeof REGISTRY_TYPES]?.label ?? r.accountType} · GL {r.ledgerAccount ? `${r.ledgerAccount.code} ${r.ledgerAccount.name} (${r.ledgerAccount.type === "LIABILITY" ? "liability" : "asset"})` : "not assigned"}</p>
                          {(() => {
                            const l = r.feeds.find((f) => f.liabilitiesAt);
                            return l ? <p className="text-xs text-navy-800" data-testid="liabilities">Last statement {l.lastStatementBalanceCents != null ? usd(l.lastStatementBalanceCents) : "—"}{l.lastStatementDate ? ` (${l.lastStatementDate.toISOString().slice(0, 10)})` : ""} · APR {l.aprPercent != null ? `${l.aprPercent}%` : "—"} · Minimum {l.minimumPaymentCents != null ? usd(l.minimumPaymentCents) : "—"}{l.nextPaymentDueDate ? ` due ${l.nextPaymentDueDate.toISOString().slice(0, 10)}` : ""}{l.liabilityOverdue ? <strong className="text-red-700"> · overdue</strong> : null}</p> : null;
                          })()}
                          <p className="text-xs text-slate-600">{r.openingBalanceCents != null ? `Opening ${usd(r.openingBalanceCents)} on ${r.openingBalanceDate?.toISOString().slice(0, 10)}` : "No opening balance"}{r.statementDay ? ` · statement closes day ${r.statementDay}` : ""}</p>
                        </div>
                        <div className="flex flex-col items-end gap-1 text-xs">
                          <span className={clsx("rounded-full px-2.5 py-0.5 font-semibold", CONN_TONE[r.status])}>{CONN_LABEL[r.status]}</span>
                          <span className="text-slate-600">Last sync: {r.lastSync ? fmtDateTime(r.lastSync) : "—"}</span>
                          <span className="flex items-center gap-1.5 text-navy-800"><Dot light={light} />{monthName}: {rec ? REC_LABEL[rec.status] : "Not prepared"}</span>
                        </div>
                      </div>
                      {r.subCards.length > 0 && (
                        <ul className="mt-2 space-y-1 rounded-lg bg-ivory-50 px-3 py-2 text-xs text-navy-800" data-testid="sub-cards">
                          <li className="font-semibold">Employee cards on this account (one liability, not counted twice)</li>
                          {r.subCards.map((s) => <li key={s.id}>••{s.last4} {s.cardholderLabel ? `· ${s.cardholderLabel}` : ""}</li>)}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}

      {/* Manage accounts */}
      {manage && (
        <section className={clsx(card, "p-4 sm:p-5")} id="manage" data-testid="manage-accounts">
          <h2 className={h2}><Plus className="size-5 text-gold-600" aria-hidden /> Manage Accounts — add an account</h2>
          <p className="mt-1 text-sm text-navy-800">Register every checking, savings, card, line of credit and loan — as many as the business has. Cards, lines of credit and loans are liabilities. Never enter usernames, passwords, full numbers or security codes.</p>
          <ActionForm action={registerAccountAction.bind(null, clientId)} className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4" resetOnSuccess>
            <label className="text-sm">Institution<input className="input mt-1" name="institution" required placeholder="e.g. Pretend National Bank" /></label>
            <label className="text-sm">Nickname<input className="input mt-1" name="nickname" placeholder="e.g. Operating" /></label>
            <label className="text-sm">Type<select className="input mt-1" name="accountType" defaultValue="CHECKING">{Object.entries(REGISTRY_TYPES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></label>
            <label className="text-sm">Last 4 digits<input className="input mt-1" name="last4" inputMode="numeric" maxLength={4} pattern="\d{4}" placeholder="1234" /></label>
            <label className="text-sm">Opening balance<input className="input mt-1" name="openingBalance" inputMode="decimal" placeholder="0.00" /></label>
            <label className="text-sm">Effective date<input className="input mt-1" type="date" name="openingBalanceDate" /></label>
            <label className="text-sm">Statement closing day<input className="input mt-1" name="statementDay" inputMode="numeric" placeholder="Month end" /></label>
            <label className="text-sm">GL account
              <select className="input mt-1" name="gl" defaultValue="NEW">
                <option value="NEW">Create the GL account</option>
                <option value="NONE">Assign later</option>
                {reg.ledger.filter((l) => !l.registryAccount && l.subtype && ["BANK", "CREDIT_CARD", "LINE_OF_CREDIT", "LOAN"].includes(l.subtype)).map((l) => <option key={l.id} value={l.id}>{l.code} {l.name}</option>)}
              </select>
            </label>
            <label className="text-sm sm:col-span-2">Employee card on a shared account (optional)
              <select className="input mt-1" name="parentAccountId" defaultValue=""><option value="">No — its own account</option>{parents.map((p) => <option key={p.id} value={p.id}>{registryLabel(p)}</option>)}</select>
            </label>
            <label className="text-sm sm:col-span-2">Cardholder (employee cards)<input className="input mt-1" name="cardholderLabel" placeholder="e.g. Delivery driver" /></label>
            <div className="sm:col-span-2 lg:col-span-4"><button type="submit" className={navyBtn}>Add account</button></div>
          </ActionForm>
        </section>
      )}
      <p className="flex items-center gap-2 text-xs text-slate-500"><ShieldCheck className="size-3.5" aria-hidden /> Connections belong to {biz} only. A bank connection never grants the client portal access, and every change is in the audit log.</p>
    </div>
  );
}
