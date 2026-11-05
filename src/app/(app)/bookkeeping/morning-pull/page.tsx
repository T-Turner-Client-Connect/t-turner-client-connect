import Link from "next/link";
import clsx from "clsx";
import { connection } from "next/server";
import { CheckCircle2, CircleAlert, CircleDashed, ExternalLink, KeyRound } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { PageHeader } from "@/components/ui";
import { card, outlineBtn } from "@/components/bk/parts";
import { morningImportAction } from "@/app/actions/manual-bank";
import { requireUser } from "@/lib/auth/session";
import { morningPull, type PullStatus } from "@/lib/services/manual-bank";
import { usd } from "@/lib/services/ledger";
import { fmtChicago } from "@/lib/tz";

export const metadata = { title: "Morning bank pull" };

const time = (d: Date) => fmtChicago(d, { hour: "numeric", minute: "2-digit" });
const day = (d: Date) => fmtChicago(d, { month: "short", day: "numeric", year: "numeric" });

function Status({ s }: { s: PullStatus }) {
  if (s.state === "NOT_STARTED") return <span className="inline-flex items-center gap-1.5 text-sm text-slate-600" data-testid="pull-status"><CircleDashed className="size-4" aria-hidden /> Not started</span>;
  const who = <span className="block text-xs text-slate-600">{s.by} · {time(s.at)}</span>;
  const rows = s.added !== undefined ? `Imported ${s.added} new row${s.added === 1 ? "" : "s"}${s.duplicates ? ` (+${s.duplicates} already imported)` : ""}` : null;
  if (s.state === "PROBLEM") {
    return <span className="text-sm text-red-800" data-testid="pull-status"><span className="inline-flex items-center gap-1.5 font-semibold"><CircleAlert className="size-4" aria-hidden /> Problem</span><span className="block">{[rows, s.problem].filter(Boolean).join(" · ")}</span>{who}</span>;
  }
  return (
    <span className="text-sm text-emerald-800" data-testid="pull-status">
      <span className="inline-flex items-center gap-1.5 font-semibold"><CheckCircle2 className="size-4" aria-hidden /> {s.state === "BALANCE" ? `Balance recorded ${usd(s.balanceCents!)} as of ${day(s.balanceAsOf!)}` : rows}</span>
      {s.state === "BALANCE" && rows && <span className="block text-navy-800">{rows}</span>}
      {s.problem && <span className="block text-amber-800">{s.problem}</span>}
      {who}
    </span>
  );
}

/**
 * The morning routine: sign in to each client's bank (in a new tab, with the sign-in kept in the
 * firm's password manager), download yesterday's transactions CSV and import it here. The file's
 * running balance, if it has one, updates the client's dashboard. Status is for today (Central).
 */
export default async function MorningPullPage() {
  await connection();
  const user = await requireUser();
  const now = new Date();
  const pull = await morningPull(user, now);
  return (
    <>
      <PageHeader
        title="Morning bank pull"
        subtitle={`${fmtChicago(now, { weekday: "long", month: "long", day: "numeric" })} · open each bank, download yesterday's transactions CSV and import it.`}
        actions={<Link href="/bookkeeping" className="text-sm underline">← Bookkeeping Clients</Link>}
      />
      <div className={clsx(card, "mb-4 p-4")}>
        <p className="font-serif text-xl font-bold text-navy-900" data-testid="pull-progress">{pull.done} of {pull.total} account{pull.total === 1 ? "" : "s"} done today</p>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-ivory-200" aria-hidden><div className="h-full bg-gradient-to-r from-gold-400 to-gold-600" style={{ width: `${pull.total ? Math.round((pull.done / pull.total) * 100) : 0}%` }} /></div>
        <p className="mt-2 flex items-center gap-1.5 text-sm text-navy-800" data-testid="pull-password-note"><KeyRound className="size-4 text-gold-600" aria-hidden /> Bank sign-ins are kept in the firm&apos;s password manager, never in Client Connect.</p>
      </div>
      {!pull.rows.length ? (
        <div className={clsx(card, "p-5 text-sm text-navy-800")} data-testid="pull-none">No bank accounts yet for the businesses you work on. Add them on each business&apos;s Banking page.</div>
      ) : (
        <ul className={clsx(card, "divide-y divide-ivory-200")} data-testid="pull-rows">
          {pull.rows.map((r) => (
            <li key={r.key} className="grid gap-3 p-4 lg:grid-cols-[minmax(0,1.4fr)_auto_minmax(0,1.6fr)_minmax(0,1.2fr)] lg:items-center" data-testid="pull-row">
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-wide text-gold-700">{r.clientName}</p>
                <p className="font-semibold text-navy-900">{r.name}{r.last4 && <span className="font-normal text-navy-800"> ••{r.last4}</span>}</p>
                <p className="text-xs text-slate-600">{[r.institution, r.glLabel ? `GL ${r.glLabel}` : "No GL account linked"].filter(Boolean).join(" · ")}</p>
              </div>
              <div>
                {r.signInUrl ? (
                  <a href={r.signInUrl} target="_blank" rel="noopener noreferrer" className={outlineBtn} data-testid="pull-open-bank"><ExternalLink className="size-4" aria-hidden /> Open bank site</a>
                ) : (
                  <Link href={`/bookkeeping/${r.clientId}/banking#manual-balances`} className="text-xs underline">Add the bank&apos;s sign-in page</Link>
                )}
              </div>
              <ActionForm action={morningImportAction.bind(null, r.clientId, r.manualAccountId, r.manualAccountId ? null : r.ledgerAccountId)} className="grid min-w-0 gap-2" resetOnSuccess>
                {r.manualAccountId && !r.ledgerAccountId && (
                  r.linkChoices.length ? (
                    <label className="block text-xs">GL account for this account&apos;s files<select className="input mt-1 w-full py-1 text-sm" name="ledgerAccountId" required defaultValue="">{[<option key="" value="" disabled>Choose…</option>, ...r.linkChoices.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)]}</select></label>
                  ) : (
                    <span className="text-xs text-slate-600">Set up its GL account in <Link className="underline" href={`/bookkeeping/${r.clientId}/books`}>General Ledger</Link> to import files.</span>
                  )
                )}
                {(r.ledgerAccountId || r.linkChoices.length > 0) && (
                  <div className="flex min-w-0 items-end gap-2">
                    <label className="min-w-0 flex-1 text-xs">Import yesterday&apos;s CSV<input className="input mt-1 w-full py-1 text-sm" type="file" name="file" accept=".csv,text/csv" required /></label>
                    <button type="submit" className={outlineBtn}>Import</button>
                  </div>
                )}
              </ActionForm>
              <Status s={r.status} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
