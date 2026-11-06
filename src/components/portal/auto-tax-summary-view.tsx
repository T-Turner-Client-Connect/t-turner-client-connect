import clsx from "clsx";
import { CheckCircle2 } from "lucide-react";
import { AutoSummaryDecision } from "./auto-summary-decision";
import { approveSummaryAction, requestSummaryChangesAction } from "@/app/actions/tax-summary";
import { consentText, requiredRoles, type SummaryWithSigs } from "@/lib/services/tax-summary";
import { clientSummaryOf, form8879Status, type F8879Status } from "@/lib/services/auto-tax-summary";
import { money, type Row } from "@/lib/tax/return-parser/summary";
import { fmtDateTime } from "@/lib/format";

const card = "flex flex-col rounded-2xl bg-white p-5 shadow-[0_1px_2px_rgba(10,26,68,0.06)]";
const h2 = "m-0 font-serif text-[19px] font-bold text-navy-900";

function Amount({ cents, sign }: { cents: number; sign?: Row["sign"] }) {
  return <>{sign === "minus" ? "−" : sign === "plus" ? "+" : ""}{money(cents)}</>;
}

function Steps({ rows }: { rows: Row[] }) {
  return (
    <ol className="m-0 list-none p-0">
      {rows.map((r, i) => (
        <li key={i} className={clsx("flex justify-between gap-4 border-t border-[#EEF0F4] py-3", r.emphasis && "-mx-5 bg-ivory-100 px-5")}>
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className={clsx("text-[15px] text-navy-900", r.emphasis ? "font-bold" : "font-semibold")}>{i + 1}. {r.title}</span>
            {r.detail && <span className="text-[13px] leading-snug text-slate-600">{r.detail}</span>}
            {r.source && <span className="text-xs text-slate-600">{r.source}</span>}
          </div>
          <span className={clsx("whitespace-nowrap text-base text-navy-900", r.emphasis ? "font-bold" : "font-semibold", (r.sign === "minus" || r.sign === "plus") && "text-emerald-800")}>
            <Amount cents={r.cents} sign={r.sign} />
          </span>
        </li>
      ))}
    </ol>
  );
}

const F8879_CLIENT: Record<F8879Status, { label: string; tone: string } | null> = {
  NONE: null,
  WAITING: { label: "Waiting to be sent", tone: "bg-slate-100 text-slate-800" },
  SENT: { label: "Sent — check your email", tone: "bg-amber-50 text-amber-900" },
  SIGNED: { label: "Signed ✓", tone: "bg-emerald-50 text-emerald-900" },
  NEEDS_RESIGN: { label: "Needs re-signing", tone: "bg-red-50 text-red-900" },
  MISMATCH: { label: "Signed — our office is reviewing it", tone: "bg-amber-50 text-amber-900" },
};

/**
 * Step 2 after approval: the client signs Form 8879 through our tax software's
 * own e-signature request. Only the status shows here — never the PDF.
 */
export function Form8879Step({ s }: { s: SummaryWithSigs }) {
  const f = form8879Status(s);
  const show = F8879_CLIENT[f.status];
  if (!show) return null;
  return (
    <section className={clsx(card, "gap-2")} data-testid="form-8879-step" data-status={f.status} aria-labelledby={`f8879-${s.id}`}>
      <h2 id={`f8879-${s.id}`} className={h2}>Step 2: Sign your Form 8879 (IRS e-file authorization)</h2>
      <p className="text-sm leading-relaxed text-slate-700">Your 8879 shows the same numbers you just approved. We&apos;ll send it for your e-signature from our tax software. Watch for that email.</p>
      <p className="flex items-center gap-2 text-sm">
        <span className="font-semibold text-navy-900">Status:</span>
        <span className={clsx("rounded-full px-3 py-1 text-sm font-semibold", show.tone)} data-testid="form-8879-status">{show.label}</span>
      </p>
      {f.status === "NEEDS_RESIGN" && <p className="text-sm text-slate-700">Your summary was updated after you signed, so the 8879 needs to be signed again with the new numbers. We&apos;ll send a new one.</p>}
      {f.status === "SIGNED" && (
        <p className="flex items-center gap-2 rounded-xl bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-900">
          <CheckCircle2 className="size-5 shrink-0" aria-hidden /> All set: we&apos;ll file your return.
        </p>
      )}
    </section>
  );
}

/** The automatic summary as the client sees it (layout approved by Tabitha). */
export function AutoTaxSummaryView({ s, clientId, readOnly }: { s: SummaryWithSigs; clientId: string; readOnly?: boolean }) {
  const m = clientSummaryOf(s);
  const signed = new Map(s.signatures.filter((g) => !g.invalidatedAt).map((g) => [g.role, g]));
  const roles = requiredRoles(s);
  const a = m.answer;
  return (
    <article className="mx-auto flex max-w-[640px] flex-col gap-5 text-navy-900" data-testid="auto-summary" aria-label={`Your ${m.taxYear} tax summary`}>
      <header className="flex flex-col gap-0.5">
        <span className="text-[13px] text-slate-600">T. Turner &amp; Associates, LLC</span>
        <h2 className="m-0 font-serif text-[26px] font-bold leading-tight">Your {m.taxYear} Tax Summary</h2>
        <span className="text-sm text-slate-600">{s.taxpayerName}{s.spouseName ? ` & ${s.spouseName}` : ""} · {m.statusLabel}</span>
      </header>

      {/* 1. The answer */}
      <section className="flex flex-col gap-4 rounded-[18px] bg-navy-900 p-6 text-white" data-testid="summary-answer">
        <p className="m-0 text-sm text-navy-100">{a.headline}</p>
        <div className="grid grid-cols-2 gap-3">
          {[a.federal, ...(a.state ? [a.state] : [])].map((x) => (
            <div key={x.label} className="flex flex-col gap-1 rounded-xl bg-white/10 p-3.5">
              <span className="text-[13px] text-navy-100">{x.label}</span>
              <span className="text-[28px] font-bold leading-none">{money(x.cents)}</span>
            </div>
          ))}
        </div>
        {a.total && (
          <div className="flex flex-wrap items-baseline justify-between gap-3 border-t border-white/20 pt-3.5">
            <span className="text-[15px]">{a.total.label}</span>
            <span className="text-[32px] font-bold leading-none text-gold-300">{money(a.total.cents)}</span>
          </div>
        )}
        {a.deposit && <p className="m-0 text-[13px] text-navy-100">{a.deposit}</p>}
      </section>

      {/* 2. Who's on the return */}
      <section className={clsx(card, "gap-3")}>
        <h2 className={h2}>Who&apos;s on your return</h2>
        <div className="flex flex-col gap-1">
          <span className="text-[15px] font-semibold">{m.who.status}</span>
          <span className="text-sm leading-relaxed text-slate-700">{m.who.meaning}</span>
        </div>
        {m.who.dependentsTitle && (
          <div className="flex flex-col gap-1">
            <span className="text-[15px] font-semibold">{m.who.dependentsTitle}</span>
            <span className="text-sm text-slate-700">{m.who.dependentsText}</span>
          </div>
        )}
      </section>

      {/* 3. Federal */}
      <section className={clsx(card, "gap-1")} data-testid="summary-federal">
        <h2 className={clsx(h2, "mb-1")}>{m.federal.title}</h2>
        <span className="mb-2 text-sm text-slate-600">{m.federal.intro}</span>
        <Steps rows={m.federal.rows} />
        <div className="flex items-baseline justify-between gap-4 border-t-2 border-navy-900 pb-0.5 pt-3.5">
          <span className="text-base font-bold">{m.federal.result.label}</span>
          <span className="whitespace-nowrap text-[22px] font-bold">{money(m.federal.result.cents)}</span>
        </div>
      </section>

      {/* 4. Deductions */}
      <section className={clsx(card, "gap-1")} data-testid="summary-deductions">
        <h2 className={clsx(h2, "mb-1")}>Your deductions: we picked what saves you the most</h2>
        <span className="mb-2 text-sm leading-relaxed text-slate-600">{m.deductions.intro}</span>
        {m.deductions.items.length > 0 && (
          <ul className="m-0 list-none p-0">
            {m.deductions.items.map((r) => (
              <li key={r.title} className="flex justify-between gap-4 border-t border-[#EEF0F4] py-3">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-[15px] font-semibold">{r.title}</span>
                  {r.detail && <span className="text-[13px] leading-snug text-slate-600">{r.detail}</span>}
                  {r.source && <span className="text-xs text-slate-600">{r.source}</span>}
                </div>
                <span className="whitespace-nowrap text-base font-semibold">{money(r.cents)}</span>
              </li>
            ))}
          </ul>
        )}
        {m.deductions.total && (
          <div className="flex items-baseline justify-between gap-4 border-t-2 border-navy-900 py-3">
            <span className="text-[15px] font-bold">{m.deductions.total.label}</span>
            <span className="whitespace-nowrap text-lg font-bold">{money(m.deductions.total.cents)}</span>
          </div>
        )}
        {m.deductions.alabamaTotal && <p className="text-[13px] text-slate-700">{m.deductions.alabamaTotal}</p>}
        {m.deductions.medical && (
          <div className="mt-1.5 flex flex-col gap-1.5 rounded-xl bg-gold-100 p-3.5" data-testid="summary-medical">
            <span className="text-sm font-bold text-gold-800">{m.deductions.medical.title}</span>
            {m.deductions.medical.lines.map((l) => (
              <span key={l} className="text-[13px] leading-relaxed text-gold-800">{l}</span>
            ))}
          </div>
        )}
        <div className="mt-2.5 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          {[{ who: "IRS (federal)", c: m.deductions.federalChoice }, ...(m.deductions.alabamaChoice ? [{ who: "Alabama", c: m.deductions.alabamaChoice }] : [])].map(({ who, c }) => (
            <div key={who} className="flex flex-col gap-1 rounded-xl border border-[#DDE1EA] p-3">
              <span className="text-[13px] text-slate-600">{who}</span>
              <span className="text-[15px] font-bold">{c.heading}</span>
              <span className="text-[13px] leading-snug text-slate-700">{c.text}</span>
            </div>
          ))}
        </div>
        <span className="mt-1.5 text-xs text-slate-600">{m.deductions.source}</span>
      </section>

      {/* 5. Alabama */}
      {m.alabama && (
        <section className={clsx(card, "gap-1")} data-testid="summary-alabama">
          <h2 className={clsx(h2, "mb-1")}>{m.alabama.title}</h2>
          <span className="mb-2 text-sm text-slate-600">{m.alabama.intro}</span>
          <Steps rows={m.alabama.rows} />
          <div className="flex items-baseline justify-between gap-4 border-t-2 border-navy-900 pb-0.5 pt-3.5">
            <span className="text-base font-bold">{m.alabama.result.label}</span>
            <span className="whitespace-nowrap text-[22px] font-bold">{money(m.alabama.result.cents)}</span>
          </div>
        </section>
      )}

      {/* 6. What happens next */}
      <section className={clsx(card, "gap-2.5")}>
        <h2 className={h2}>What happens next</h2>
        <ol className="m-0 flex list-none flex-col gap-2 p-0">
          {m.next.map((n, i) => (
            <li key={i} className="text-sm leading-relaxed text-slate-700"><b>{i + 1}.</b> {n}</li>
          ))}
        </ol>
      </section>

      {/* 7. Decision */}
      {s.status === "SENT" && (
        <AutoSummaryDecision
          readOnly={readOnly}
          signers={roles.map((role) => {
            const name = role === "SPOUSE" ? s.spouseName! : s.taxpayerName;
            const g = signed.get(role);
            return { role, name, consent: consentText(role, name, s.taxYear), signed: g ? `${g.signerName} approved ${fmtDateTime(g.signedAt)}.${roles.length > 1 && signed.size < roles.length ? " The other spouse's approval is still needed." : ""}` : null };
          })}
          approveActions={Object.fromEntries(roles.map((r) => [r, approveSummaryAction.bind(null, clientId, s.id, r)]))}
          questionAction={requestSummaryChangesAction.bind(null, clientId, s.id)}
        />
      )}
      {s.status === "CHANGES_REQUESTED" && (
        <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900" role="status">We got your question on {fmtDateTime(s.changesRequestedAt)}. Your summary is on hold until we answer and send you an updated one.</p>
      )}
      {s.status === "CLIENT_APPROVED" && (
        <p className="flex items-center gap-2 rounded-xl bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-900" role="status">
          <CheckCircle2 className="size-5 shrink-0" aria-hidden /> Approved: {roles.map((r) => signed.get(r)).filter(Boolean).map((g) => `${g!.signerName}, ${fmtDateTime(g!.signedAt)}`).join(" · ")}
        </p>
      )}
      <p className="text-center text-xs leading-relaxed text-slate-600">{m.approveNote}</p>
      <Form8879Step s={s} />
    </article>
  );
}
