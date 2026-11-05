import Link from "next/link";
import clsx from "clsx";
import { connection } from "next/server";
import { ActionForm } from "@/components/action-form";
import { PageHeader } from "@/components/ui";
import { card, navyBtn } from "@/components/bk/parts";
import { enterTodaysBalancesAction } from "@/app/actions/manual-bank";
import { requireUser } from "@/lib/auth/session";
import { firmManualBalanceSheet, MANUAL_KINDS, MANUAL_STALE_DAYS } from "@/lib/services/manual-bank";
import { usd } from "@/lib/services/ledger";
import { fmtDateTime } from "@/lib/format";
import { utcToChicagoLocal } from "@/lib/tz";

export const metadata = { title: "Enter today's balances" };

/**
 * Firm-wide "Enter today's balances": every active manual account of every business this staff
 * member may enter balances for (Admins, the assigned staff member, or Banking → Edit), in one
 * form. Blank amounts are skipped; the server re-checks permission for each business.
 */
export default async function TodaysBalancesPage() {
  await connection();
  const user = await requireUser();
  const sheet = await firmManualBalanceSheet(user);
  const now = new Date();
  const staleMs = MANUAL_STALE_DAYS * 86_400_000;
  const count = sheet.reduce((n, c) => n + c.accounts.length, 0);
  return (
    <>
      <PageHeader
        title="Enter today's balances"
        subtitle="Balances our office looks up at each bank, for businesses without a connected bank feed. Each business's dashboard shows its checking and savings total as “Updated by our office”."
        actions={<Link href="/bookkeeping" className="text-sm underline">← Bookkeeping Clients</Link>}
      />
      {!sheet.length ? (
        <div className={clsx(card, "p-5 text-sm text-navy-800")} data-testid="todays-none">
          No accounts to update. Add a business&apos;s accounts on its Banking page under &ldquo;Balances entered by our office&rdquo;.
        </div>
      ) : (
        <ActionForm action={enterTodaysBalancesAction} className="space-y-4" resetOnSuccess>
          <div className={clsx(card, "flex flex-wrap items-end gap-3 p-4")}>
            <label className="text-sm">As of (Central) for every balance below<input className="input mt-1" type="datetime-local" name="asOf" defaultValue={utcToChicagoLocal(now)} /></label>
            <p className="text-xs text-slate-600">{count} account{count === 1 ? "" : "s"} · leave a balance blank to skip it. Never enter usernames, passwords or full account numbers.</p>
          </div>
          {sheet.map((c) => (
            <section key={c.id} className={clsx(card, "p-4")} data-testid="todays-client">
              <h2 className="flex flex-wrap items-baseline justify-between gap-2 font-serif text-lg font-bold text-navy-900">
                {c.name}
                <Link className="font-sans text-xs font-semibold text-navy-800 underline" href={`/bookkeeping/${c.id}/banking#manual-balances`}>History &amp; notes</Link>
              </h2>
              <ul className="mt-2 divide-y divide-ivory-200">
                {c.accounts.map((a) => {
                  const stale = a.latest && now.getTime() - a.latest.asOf.getTime() > staleMs;
                  return (
                    <li key={a.id} className="grid gap-2 py-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1.5fr)_minmax(0,1fr)] sm:items-center">
                      <span className="min-w-0 text-sm">
                        <span className="font-semibold text-navy-900">{a.name}{a.last4 ? ` ••${a.last4}` : ""}</span>
                        <span className="block text-xs text-slate-600">{[a.institution, MANUAL_KINDS[a.kind] ?? a.kind].filter(Boolean).join(" · ")}</span>
                      </span>
                      <span className={clsx("text-xs", stale ? "font-semibold text-amber-800" : "text-slate-600")}>
                        {a.latest ? <>Last {usd(a.latest.balanceCents)} · {stale ? "Not current · " : ""}{fmtDateTime(a.latest.asOf)}</> : "No balance yet"}
                      </span>
                      <input className="input" name={`amount:${c.id}:${a.id}`} inputMode="decimal" placeholder="New balance" aria-label={`New balance for ${c.name} ${a.name}`} />
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
          <button type="submit" className={navyBtn}>Save balances</button>
        </ActionForm>
      )}
    </>
  );
}
