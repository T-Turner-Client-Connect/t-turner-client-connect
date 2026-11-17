import { notFound } from "next/navigation";
import clsx from "clsx";
import { Landmark } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { PageHeader } from "@/components/ui";
import { requireOffice } from "@/lib/auth/owner";
import { accountVerificationReport, OWNERSHIP_LABEL } from "@/lib/services/account-ownership";
import { checkAllAccountsAction, decideAccountAction } from "@/app/actions/account-ownership";
import { fmtDateTime } from "@/lib/format";

export const metadata = { title: "Account verification" };

const TONE: Record<string, string> = { VERIFIED: "bg-emerald-50 text-emerald-800", IN_QUESTION: "bg-red-50 text-red-800", NOT_CHECKED: "bg-slate-100 text-slate-700" };

/**
 * Every bookkeeping client's registered bank and card accounts, and whether a statement on file
 * proves each one is the business's own (its bank, last 4 and business name). Owner only.
 */
export default async function AccountVerificationPage() {
  const { access } = await requireOffice();
  if (!access.isOwner) notFound();
  const clients = await accountVerificationReport();
  const all = clients.flatMap((c) => c.accounts);
  const count = (s: string) => all.filter((a) => a.ownershipStatus === s).length;
  return (
    <>
      <PageHeader title="Account verification" subtitle="Each client's actual bank and card accounts. An account is verified only when a statement on file prints its bank, its last 4 digits and the business's own name; chart numbers such as 1000 or 2100 never decide the bank. Accounts in question can't be posted, imported or reconciled until resolved." />
      <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
        <span className="rounded-full bg-emerald-50 px-3 py-1 font-semibold text-emerald-800">{count("VERIFIED")} verified</span>
        <span className="rounded-full bg-red-50 px-3 py-1 font-semibold text-red-800">{count("IN_QUESTION")} in question</span>
        <span className="rounded-full bg-slate-100 px-3 py-1 font-semibold text-slate-700">{count("NOT_CHECKED")} not verified yet</span>
        <ActionForm action={checkAllAccountsAction}><button type="submit" className="rounded-lg bg-navy-900 px-4 py-2 text-sm font-semibold text-white hover:bg-navy-800">Check all accounts now</button></ActionForm>
      </div>
      <ul className="space-y-4" data-testid="account-verification">
        {clients.map((c) => (
          <li key={c.id} className="rounded-2xl border border-ivory-200 bg-white p-4 shadow-sm">
            <h2 className="flex items-center gap-2 font-serif text-lg font-bold text-navy-900"><Landmark className="size-5 text-gold-600" aria-hidden /> {c.name}</h2>
            <ul className="mt-2 divide-y divide-ivory-200">
              {c.accounts.map((a) => (
                <li key={a.id} className="py-2 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-semibold text-navy-900">{a.nickname || a.institution}{a.last4 ? ` ••${a.last4}` : " (no last 4)"} <span className="font-normal text-slate-600">· {a.accountType.toLowerCase().replace("_", " ")} · bank: {a.institution}{a.ledgerAccount ? ` · chart ${a.ledgerAccount.code} ${a.ledgerAccount.name}` : ""} · {a._count.documents} document{a._count.documents === 1 ? "" : "s"}</span></p>
                    <span className={clsx("rounded-full px-2.5 py-0.5 text-xs font-semibold", TONE[a.ownershipStatus] ?? TONE.NOT_CHECKED)}>{OWNERSHIP_LABEL[a.ownershipStatus] ?? a.ownershipStatus}</span>
                  </div>
                  {a.ownershipNote && <p className="mt-0.5 text-slate-700">{a.ownershipNote}</p>}
                  {a.ownershipCheckedAt && <p className="text-xs text-slate-500">Checked {fmtDateTime(a.ownershipCheckedAt)}</p>}
                  <div className="mt-1.5 flex flex-wrap gap-2">
                    {a.ownershipStatus !== "VERIFIED" && <ActionForm action={decideAccountAction.bind(null, a.id, "VERIFIED")} confirm="Confirm this is the business's own account? Its activity can then be posted and reconciled."><button type="submit" className="rounded-lg border border-emerald-300 bg-white px-3 py-1.5 text-xs font-semibold text-emerald-800 hover:bg-emerald-50">It&apos;s the business&apos;s account</button></ActionForm>}
                    {a.ownershipStatus !== "IN_QUESTION" && <ActionForm action={decideAccountAction.bind(null, a.id, "IN_QUESTION")} confirm="Put this account in question? Its activity won't be posted or reconciled until it is resolved."><button type="submit" className="rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-semibold text-red-800 hover:bg-red-50">Put in question</button></ActionForm>}
                    <ActionForm action={decideAccountAction.bind(null, a.id, "RECHECK")}><button type="submit" className="rounded-lg border border-navy-200 bg-white px-3 py-1.5 text-xs font-semibold text-navy-900 hover:bg-ivory-50">Re-check from statements</button></ActionForm>
                  </div>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </>
  );
}
