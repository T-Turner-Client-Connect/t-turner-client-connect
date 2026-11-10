import { notFound } from "next/navigation";
import clsx from "clsx";
import { Building2, CheckCircle2, CircleSlash, FileText, Sparkles } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { PageHeader } from "@/components/ui";
import { requireOffice } from "@/lib/auth/owner";
import { isReportApprover } from "@/lib/services/bookkeeping-clients";
import { ownerSwitches } from "@/lib/services/owner-switches";
import { coethaKeyPresent, coethaModel } from "@/lib/coetha-model";
import { COETHA_PRIVACY } from "@/lib/services/coetha";
import { PLAID_MODE_TEXT, plaidMode } from "@/lib/plaid";
import { ownerSwitchAction } from "@/app/actions/coetha";
import { prisma } from "@/lib/prisma";
import { fmtDateTime } from "@/lib/format";

export const metadata = { title: "Coetha & bank feeds" };

const card = "min-w-0 rounded-2xl border border-gold-200/80 bg-gradient-to-b from-white to-ivory-50 p-5 shadow-[0_14px_32px_-24px_rgb(10_26_68/0.45)] sm:p-6";

function Check({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-sm text-navy-900">
      {ok ? <CheckCircle2 className="mt-0.5 size-5 shrink-0 fill-emerald-600 text-white" aria-hidden /> : <CircleSlash className="mt-0.5 size-5 shrink-0 text-gold-600" aria-hidden />}
      <span>{children}<span className="sr-only">{ok ? " (done)" : " (not yet)"}</span></span>
    </li>
  );
}

function Switch({ on, label, testId }: { on: boolean; label: string; testId: string }) {
  return (
    <span className="inline-flex items-center gap-3" data-testid={testId} data-on={on ? "true" : "false"}>
      <span aria-hidden className={clsx("relative inline-flex h-7 w-12 items-center rounded-full ring-1 transition", on ? "bg-emerald-600 ring-emerald-700" : "bg-slate-200 ring-slate-300")}>
        <span className={clsx("absolute size-5 rounded-full bg-white shadow transition", on ? "left-6" : "left-1")} />
      </span>
      <span className="font-semibold text-navy-900">{label}: {on ? "On" : "Off"}</span>
    </span>
  );
}

export default async function OwnerAutomationPage() {
  // The owner's own switches: only Tabitha sees this page.
  const { actor, access } = await requireOffice();
  if (!access.isOwner) notFound();
  const [sw, primary, connCounts] = await Promise.all([
    ownerSwitches(),
    isReportApprover(actor),
    prisma.bankConnection.groupBy({ by: ["environment", "status"], _count: true, where: { status: { not: "DISCONNECTED" } } }),
  ]);
  const ids = [sw.liveBanking.changedById, sw.coetha.changedById, sw.coethaAutoSend.changedById, sw.coethaAutoPost.changedById, sw.taxSummaryAutoSend.changedById, sw.clientBankBalances.changedById].filter((x): x is string => !!x);
  const names = new Map((await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  const env = (process.env.PLAID_ENV ?? "sandbox").trim().toLowerCase();
  const keys = !!process.env.PLAID_CLIENT_ID?.trim() && !!process.env.PLAID_SECRET?.trim();
  const mode = plaidMode(process.env, sw.liveBanking.on);
  const live = connCounts.filter((c) => c.environment === "PRODUCTION").reduce((n, c) => n + c._count, 0);
  const needs = connCounts.filter((c) => c.status === "NEEDS_REAUTH").reduce((n, c) => n + c._count, 0);
  const keyOk = coethaKeyPresent();
  const changed = (s: { changedAt: Date | null; changedById: string | null }) => (s.changedAt ? `Last changed ${fmtDateTime(s.changedAt)} by ${names.get(s.changedById ?? "") ?? "the owner"}.` : "Never changed (off by default).");

  return (
    <>
      <PageHeader title="Coetha & bank feeds" subtitle="Your switches for real bank connections and Coetha AI. Both are off until you turn them on, only you can change them, and every change is recorded." />
      {!primary && <p className="mb-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">Only Tabitha (the primary owner) can change these switches.</p>}
      <div className="grid gap-5 lg:grid-cols-2">
        <section className={card} data-testid="switch-live-banking">
          <h2 className="flex items-center gap-3 font-serif text-xl font-bold text-navy-900"><Building2 className="size-7 text-gold-600" aria-hidden /> Live bank connections</h2>
          <p className="mt-1 text-sm text-navy-800">Lets staff connect a client business&apos;s real bank through Plaid so transactions arrive automatically (at least daily, and whenever Plaid says new ones are ready). CSV statement upload stays available as a backup.</p>
          <ul className="mt-4 space-y-1.5">
            <Check ok={keys}>Plaid keys in Netlify (PLAID_CLIENT_ID, PLAID_SECRET)</Check>
            <Check ok={env === "production"}>PLAID_ENV=production {env !== "production" && <span className="text-slate-600">(now: {env || "sandbox"})</span>}</Check>
            <Check ok={sw.liveBanking.on}>Turned on by you (below)</Check>
          </ul>
          <p className="mt-3 rounded-lg bg-navy-50 p-3 text-sm text-navy-900" data-testid="plaid-mode">{PLAID_MODE_TEXT[mode]}</p>
          <p className="mt-2 text-xs text-slate-600">{live} live connection{live === 1 ? "" : "s"}{needs ? ` · ${needs} need the client to sign in again` : ""}. {changed(sw.liveBanking)}</p>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-ivory-200 pt-4">
            <Switch on={sw.liveBanking.on} label="Live bank connections" testId="live-banking-state" />
            {primary && (
              <ActionForm action={ownerSwitchAction.bind(null, "liveBanking", !sw.liveBanking.on)} confirm={sw.liveBanking.on ? "Turn off live bank connections? Retrieval from real banks stops until you turn it back on; nothing already retrieved is removed." : "Turn on live bank connections? With the Plaid production keys set, staff can connect clients' real banks (read-only) and transactions will be retrieved automatically."}>
                <button type="submit" className={clsx("inline-flex min-h-10 items-center rounded-lg px-4 py-2 text-sm font-semibold shadow", sw.liveBanking.on ? "border-[1.5px] border-navy-900 bg-white text-navy-900" : "bg-navy-900 text-white hover:bg-navy-800")} data-testid="toggle-live-banking">{sw.liveBanking.on ? "Turn off" : "Turn on"}</button>
              </ActionForm>
            )}
          </div>
        </section>

        <section className={card} data-testid="switch-coetha">
          <h2 className="flex items-center gap-3 font-serif text-xl font-bold text-navy-900"><Sparkles className="size-7 text-gold-600" aria-hidden /> Coetha AI</h2>
          <p className="mt-1 text-sm text-navy-800">Coetha prepares draft bookkeeping work from the bank transactions the office imports (daily CSV statement imports) or, if bank connections are ever turned on, syncs, and from the ledger data staff enter: category recommendations, discrepancies, adjusting entries and a month summary. She never posts or finalizes anything; only you approve her work. She doesn&apos;t need live bank connections: CSV imports work the same way.</p>
          <ul className="mt-4 space-y-1.5">
            <Check ok={keyOk}>Anthropic API key in Netlify (ANTHROPIC_API_KEY)</Check>
            <Check ok>Model: {coethaModel()} <span className="text-slate-600">(COETHA_MODEL to change)</span></Check>
            <Check ok={sw.coetha.on}>Turned on by you (below)</Check>
          </ul>
          {!keyOk && <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">Coetha needs an Anthropic API key — add ANTHROPIC_API_KEY in Netlify.</p>}
          <p className="mt-3 text-xs text-slate-600">{COETHA_PRIVACY}</p>
          <p className="mt-2 text-xs text-slate-600">{changed(sw.coetha)}</p>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-ivory-200 pt-4">
            <Switch on={sw.coetha.on} label="Coetha AI" testId="coetha-state" />
            {primary && (
              <ActionForm action={ownerSwitchAction.bind(null, "coetha", !sw.coetha.on)} confirm={sw.coetha.on ? "Turn off Coetha AI? No new drafts are made; existing drafts stay for your review." : "Turn on Coetha AI? Business transaction details will be sent to Anthropic's API under the firm's key to prepare drafts. Nothing is posted without your approval."}>
                <button type="submit" className={clsx("inline-flex min-h-10 items-center rounded-lg px-4 py-2 text-sm font-semibold shadow", sw.coetha.on ? "border-[1.5px] border-navy-900 bg-white text-navy-900" : "bg-navy-900 text-white hover:bg-navy-800")} data-testid="toggle-coetha">{sw.coetha.on ? "Turn off" : "Turn on"}</button>
              </ActionForm>
            )}
          </div>
        </section>

        <section className={card} data-testid="switch-coetha-auto-send">
          <h2 className="flex items-center gap-3 font-serif text-xl font-bold text-navy-900"><Sparkles className="size-7 text-gold-600" aria-hidden /> Coetha&apos;s document requests</h2>
          <p className="mt-1 text-sm text-navy-800">Each month Coetha prepares targeted requests, each naming the exact document, account and period. <strong>Routine</strong> ones — a missing bank or card statement, receipts, payroll records, merchant statements, loan documents for a known loan account, small deposit explanations — go to the client automatically through their own notification preferences (email and text consent and blocks are respected). Nothing already received, available from the bank feed, or not yet due is ever sent. <strong>Unusual, sensitive or unclear</strong> requests (large deposits, owner or related-party items, transfers to unknown accounts, low confidence, personal or tax-sensitive wording, year-end tax forms) always wait for you in the Coetha Accounting Review. On by default; turn it off to have staff send routine requests by hand.</p>
          <p className="mt-2 text-xs text-slate-600">{changed(sw.coethaAutoSend)} The monthly check runs without the AI switch or an API key (rules only, nothing leaves Client Connect).</p>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-ivory-200 pt-4">
            <Switch on={sw.coethaAutoSend.on} label="Send automatically" testId="coetha-auto-send-state" />
            {primary && (
              <ActionForm action={ownerSwitchAction.bind(null, "coethaAutoSend", !sw.coethaAutoSend.on)} confirm={sw.coethaAutoSend.on ? "Turn off automatic sending? Coetha's drafts will wait for staff to send them." : "Let Coetha send her drafted document requests to clients automatically?"}>
                <button type="submit" className={clsx("inline-flex min-h-10 items-center rounded-lg px-4 py-2 text-sm font-semibold shadow", sw.coethaAutoSend.on ? "border-[1.5px] border-navy-900 bg-white text-navy-900" : "bg-navy-900 text-white hover:bg-navy-800")} data-testid="toggle-coetha-auto-send">{sw.coethaAutoSend.on ? "Turn off" : "Turn on"}</button>
              </ActionForm>
            )}
          </div>
        </section>

        <section className={card} data-testid="switch-coetha-auto-post">
          <h2 className="flex items-center gap-3 font-serif text-xl font-bold text-navy-900"><Sparkles className="size-7 text-gold-600" aria-hidden /> Coetha posts routine bookkeeping</h2>
          <p className="mt-1 text-sm text-navy-800">Coetha posts on her own only: <strong>decisions you stated</strong> to her (she quotes your words and Client Connect checks them against your messages), and <strong>routine items</strong> that match one of the business&apos;s rules or the way that vendor was already posted. Only in open months, never twice, never a new bank transaction; every posting is audited and listed under &ldquo;Posted automatically&rdquo; on Ask Coetha, where you can reverse it. Owner/personal, entity, unclear-purpose and on-hold items always wait for you. On by default; turn it off to approve everything by hand.</p>
          <p className="mt-2 text-xs text-slate-600">{changed(sw.coethaAutoPost)}</p>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-ivory-200 pt-4">
            <Switch on={sw.coethaAutoPost.on} label="Post routine items automatically" testId="coetha-auto-post-state" />
            {primary && (
              <ActionForm action={ownerSwitchAction.bind(null, "coethaAutoPost", !sw.coethaAutoPost.on)} confirm={sw.coethaAutoPost.on ? "Turn off automatic posting? Coetha's entries will wait on the Apply These Decisions card for you." : "Let Coetha post routine bookkeeping and your stated decisions herself?"}>
                <button type="submit" className={clsx("inline-flex min-h-10 items-center rounded-lg px-4 py-2 text-sm font-semibold shadow", sw.coethaAutoPost.on ? "border-[1.5px] border-navy-900 bg-white text-navy-900" : "bg-navy-900 text-white hover:bg-navy-800")} data-testid="toggle-coetha-auto-post">{sw.coethaAutoPost.on ? "Turn off" : "Turn on"}</button>
              </ActionForm>
            )}
          </div>
        </section>

        <section className={card} data-testid="switch-tax-summary-auto-send">
          <h2 className="flex items-center gap-3 font-serif text-xl font-bold text-navy-900"><FileText className="size-7 text-gold-600" aria-hidden /> Send tax summaries automatically</h2>
          <p className="mt-1 text-sm text-navy-800">When you upload a prepared return from TaxAct, Client Connect reads the figures from the forms and checks them. <strong>Off</strong>: every summary waits for your one-click “Send for approval”. <strong>On</strong>: a summary goes to the client by itself only when every check passed, <strong>you</strong> uploaded it, and the client has an active portal login. Staff uploads, and anything that couldn&apos;t be read or didn&apos;t add up, always wait for you. No AI is used and no client tax data leaves Client Connect.</p>
          <p className="mt-2 text-xs text-slate-600">{sw.taxSummaryAutoSend.changedAt ? changed(sw.taxSummaryAutoSend) : "Never changed (off by default)."} Each automatic send and each hold is recorded in the audit log.</p>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-ivory-200 pt-4">
            <Switch on={sw.taxSummaryAutoSend.on} label="Send automatically" testId="tax-summary-auto-send-state" />
            {primary && (
              <ActionForm action={ownerSwitchAction.bind(null, "taxSummaryAutoSend", !sw.taxSummaryAutoSend.on)} confirm={sw.taxSummaryAutoSend.on ? "Turn off automatic sending? Every tax summary will wait for your “Send for approval”." : "Send tax summaries automatically? Only summaries you upload, that pass every check, for clients with an active portal login."}>
                <button type="submit" className={clsx("inline-flex min-h-10 items-center rounded-lg px-4 py-2 text-sm font-semibold shadow", sw.taxSummaryAutoSend.on ? "border-[1.5px] border-navy-900 bg-white text-navy-900" : "bg-navy-900 text-white hover:bg-navy-800")} data-testid="toggle-tax-summary-auto-send">{sw.taxSummaryAutoSend.on ? "Turn off" : "Turn on"}</button>
              </ActionForm>
            )}
          </div>
        </section>

        <section className={card} data-testid="switch-client-bank-balances">
          <h2 className="flex items-center gap-3 font-serif text-xl font-bold text-navy-900"><FileText className="size-7 text-gold-600" aria-hidden /> Show office-entered bank balances to clients</h2>
          <p className="mt-1 text-sm text-navy-800">Staff record balances they read at the bank (Morning bank pull) or take from an imported bank file. <strong>Off</strong>: those balances are for staff only; clients&apos; dashboards show nothing from them. <strong>On</strong>: bookkeeping clients&apos; dashboards show them, labeled &ldquo;Updated by our office&rdquo; with each balance&apos;s as-of date, and marked &ldquo;Not current&rdquo; when old — never presented as a live bank balance. This switch is separate from the client rollout lock.</p>
          <p className="mt-2 text-xs text-slate-600">{sw.clientBankBalances.changedAt ? changed(sw.clientBankBalances) : "Never changed (off by default)."} Each change is recorded in the audit log.</p>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-ivory-200 pt-4">
            <Switch on={sw.clientBankBalances.on} label="Show to clients" testId="client-bank-balances-state" />
            {primary && (
              <ActionForm action={ownerSwitchAction.bind(null, "clientBankBalances", !sw.clientBankBalances.on)} confirm={sw.clientBankBalances.on ? "Hide office-entered bank balances from clients? Staff keep seeing and updating them." : "Show office-entered bank balances on bookkeeping clients' dashboards? Each is labeled \u201cUpdated by our office\u201d with its as-of date."}>
                <button type="submit" className={clsx("inline-flex min-h-10 items-center rounded-lg px-4 py-2 text-sm font-semibold shadow", sw.clientBankBalances.on ? "border-[1.5px] border-navy-900 bg-white text-navy-900" : "bg-navy-900 text-white hover:bg-navy-800")} data-testid="toggle-client-bank-balances">{sw.clientBankBalances.on ? "Turn off" : "Turn on"}</button>
              </ActionForm>
            )}
          </div>
        </section>
      </div>
    </>
  );
}
