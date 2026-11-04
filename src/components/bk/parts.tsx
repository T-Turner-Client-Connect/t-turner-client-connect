import clsx from "clsx";
import { CheckCircle2, CircleAlert, CircleDot, CircleMinus } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { approveCoethaAction, rejectCoethaAction } from "@/app/actions/coetha";
import { usd } from "@/lib/services/ledger";
import type { Light } from "@/lib/services/bank-accounts";

/** Shared pieces for the bookkeeping management screens (navy/gold, calm sizes). */

export const card = "min-w-0 rounded-2xl border border-gold-200/80 bg-gradient-to-b from-white to-ivory-50 shadow-[0_14px_32px_-24px_rgb(10_26_68/0.45)]";
export const navyBtn = "inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-navy-900 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-navy-800 disabled:opacity-50";
export const goldBtn = "inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-gradient-to-b from-gold-300 to-gold-500 px-4 py-2 text-sm font-semibold text-navy-950 shadow hover:to-gold-600 disabled:opacity-50";
export const outlineBtn = "inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border-[1.5px] border-navy-900 bg-white px-3 py-2 text-sm font-semibold text-navy-900 hover:bg-ivory-50";
export const h2 = "flex flex-wrap items-center gap-2 font-serif text-lg font-bold text-navy-900 sm:text-xl";

export const LIGHT_DOT: Record<Light, string> = { GREEN: "bg-emerald-600", RED: "bg-red-600", YELLOW: "bg-amber-400", GRAY: "bg-slate-300" };
export const LIGHT_TEXT: Record<Light, string> = { GREEN: "Reconciled", RED: "Missing info or issue", YELLOW: "In progress / awaiting data", GRAY: "Not yet due" };

export function Dot({ light, className }: { light: Light; className?: string }) {
  return <span className={clsx("inline-block size-3 shrink-0 rounded-full", LIGHT_DOT[light], className)} aria-hidden />;
}

export function Legend() {
  return (
    <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-navy-800" data-testid="legend">
      {(["GREEN", "RED", "YELLOW", "GRAY"] as Light[]).map((l) => <span key={l} className="flex items-center gap-1.5"><Dot light={l} />{LIGHT_TEXT[l]}</span>)}
    </p>
  );
}

/** Green check (done), red mark (genuinely missing), amber (in progress), gray (not yet due). */
export function StateIcon({ state }: { state: string }) {
  if (state === "DONE") return <CheckCircle2 className="size-5 shrink-0 fill-emerald-600 text-white" aria-label="Complete" />;
  if (state === "MISSING") return <CircleAlert className="size-5 shrink-0 fill-red-600 text-white" aria-label="Missing" />;
  if (state === "IN_PROGRESS") return <CircleDot className="size-5 shrink-0 text-amber-500" aria-label="In progress" />;
  return <CircleMinus className="size-5 shrink-0 text-slate-400" aria-label="Not yet due" />;
}

export function Donut({ percent, size = "size-32" }: { percent: number; size?: string }) {
  const r = 52;
  const c = 2 * Math.PI * r;
  return (
    <div className={clsx("relative shrink-0", size)} role="img" aria-label={`${percent}% complete`}>
      <svg viewBox="0 0 128 128" className="size-full -rotate-90">
        <circle cx="64" cy="64" r={r} fill="none" stroke="var(--color-navy-900)" strokeWidth="12" />
        <circle cx="64" cy="64" r={r} fill="none" stroke="var(--color-gold-500)" strokeWidth="12" strokeDasharray={`${(percent / 100) * c} ${c}`} strokeLinecap="round" />
      </svg>
      <span className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-serif text-xl font-bold text-navy-900">{percent}%</span>
        <span className="text-xs text-navy-800">Complete</span>
      </span>
    </div>
  );
}

type RecPayload = {
  category?: string; title?: string; found?: string; why?: string; correction?: string; impact?: string;
  accounts?: { id: string; code: string; name: string }[]; transactions?: { id: string; date: string; amountCents: number; description: string }[]; documents?: { id: string; title: string }[];
  entry?: { date: string; memo: string; lines: { accountCode: string; accountName: string; debitCents: number; creditCents: number }[] } | null;
  recommended?: string; current?: string | null;
};

const CLASS_LABEL: Record<string, string> = { FORM_1065: "Form 1065 — Partnership / Multi-Member LLC", FORM_1120S: "Form 1120-S — S Corporation", SCHEDULE_C: "Schedule C — Sole Proprietor / Disregarded SMLLC", OTHER_REVIEW: "Other / Requires Review" };

export const CATEGORY_LABEL: Record<string, string> = {
  CARD_PAYMENT_DOUBLE_COUNTED: "Card payment double-counted", LOAN_PAYMENT_AS_EXPENSE: "Loan payment as expense", OWNER_DRAW: "Owner draw", SHAREHOLDER_DISTRIBUTION: "Shareholder distribution", PARTNER_DRAW: "Partner draw",
  GUARANTEED_PAYMENT: "Guaranteed payment", PAYROLL: "Payroll", SCORP_REASONABLE_COMP: "S corp reasonable compensation", PARTNER_CAPITAL: "Partner capital", CLASSIFICATION_INCONSISTENCY: "Classification inconsistency",
  UNRECONCILED: "Unreconciled account", DUPLICATE: "Possible duplicate", INCORRECT_CLASSIFICATION: "Incorrect classification", MISSING_ENTRY: "Missing journal entry", UNRECORDED_LIABILITY: "Unrecorded liability", OTHER: "Other",
};

/** One Coetha recommendation, with its full rationale (internal only). Approve / reject for Tabitha. */
export function RecommendationCard({ p, clientId, canApprove, booksHref }: { p: { id: string; kind: string; payload: unknown; reason: string; model: string; createdAt: Date }; clientId: string; canApprove: boolean; booksHref: string }) {
  const d = p.payload as RecPayload;
  const isClass = p.kind === "CLASSIFICATION";
  return (
    <li className="rounded-xl border border-ivory-200 bg-white p-3 sm:p-4" data-testid="recommendation" data-kind={p.kind}>
      <p className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-gold-100 px-2.5 py-0.5 text-xs font-semibold text-gold-800">{isClass ? "Tax classification" : CATEGORY_LABEL[d.category ?? "OTHER"] ?? d.category}</span>
        <span className="font-semibold text-navy-900">{isClass ? `Recommend: ${CLASS_LABEL[d.recommended ?? ""] ?? d.recommended}` : d.title}</span>
        <span className="text-xs text-slate-500">{p.model === "rules" ? "Coetha (rules)" : "Coetha (AI)"}</span>
      </p>
      <dl className="mt-2 grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[9rem_1fr]">
        <dt className="font-semibold text-navy-800">What she found</dt><dd className="text-navy-900">{d.found}</dd>
        <dt className="font-semibold text-navy-800">Why it matters</dt><dd className="text-navy-900">{d.why}</dd>
        <dt className="font-semibold text-navy-800">Proposed correction</dt><dd className="text-navy-900">{d.correction}</dd>
        {!!d.accounts?.length && (<><dt className="font-semibold text-navy-800">Accounts affected</dt><dd className="text-navy-900">{d.accounts.map((a) => `${a.code} ${a.name}`).join(" · ")}</dd></>)}
        {!!d.transactions?.length && (
          <><dt className="font-semibold text-navy-800">Supporting</dt><dd className="text-navy-900"><ul className="space-y-0.5">{d.transactions.slice(0, 6).map((t) => <li key={t.id}><a className="underline decoration-gold-500" href={`${booksHref}#txn-${t.id}`}>{t.date} · {usd(t.amountCents)} · {t.description}</a></li>)}</ul></dd></>
        )}
        {!!d.documents?.length && (<><dt className="font-semibold text-navy-800">Documents</dt><dd>{d.documents.map((x) => x.title).join(", ")}</dd></>)}
        <dt className="font-semibold text-navy-800">Statement impact</dt><dd className="text-navy-900">{d.impact}</dd>
      </dl>
      {d.entry && (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[18rem] text-sm" data-testid="draft-entry">
            <caption className="text-left text-xs font-semibold text-navy-800">Draft entry — {d.entry.date}</caption>
            <tbody>{d.entry.lines.map((l, i) => <tr key={i} className="border-t border-ivory-200"><td className="py-1 pr-2">{l.accountCode} {l.accountName}</td><td className="py-1 pr-2 text-right tabular-nums">{l.debitCents ? usd(l.debitCents) : ""}</td><td className="py-1 text-right tabular-nums">{l.creditCents ? usd(l.creditCents) : ""}</td></tr>)}</tbody>
          </table>
        </div>
      )}
      {canApprove ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <ActionForm action={approveCoethaAction.bind(null, clientId, p.id)} confirm={d.entry ? "Approve and post this correction to the books?" : isClass ? "Change this business's tax classification?" : undefined} showSuccess={false}>
            <button type="submit" className={navyBtn} data-testid="approve">{d.entry ? "Approve & post" : isClass ? "Approve change" : "Acknowledge"}</button>
          </ActionForm>
          <ActionForm action={rejectCoethaAction.bind(null, clientId, p.id)} showSuccess={false}><button type="submit" className={outlineBtn} data-testid="reject">Reject</button></ActionForm>
        </div>
      ) : (
        <p className="mt-2 text-xs text-slate-600">Waiting for Tabitha. Only she approves Coetha&apos;s work.</p>
      )}
    </li>
  );
}
