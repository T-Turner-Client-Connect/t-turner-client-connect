import { ActionForm } from "@/components/action-form";
import { AgreementText } from "@/components/agreements/bits";
import type { ActionState } from "@/lib/action";
import type { Rendered } from "@/lib/agreements/catalog";

type Action = (prev: ActionState, fd: FormData) => Promise<ActionState>;

const input = "mt-1 block min-h-12 w-full rounded-xl border border-slate-400 bg-white px-3 text-base text-slate-900 focus:border-navy-900 focus:outline-none focus:ring-2 focus:ring-navy-900/30";
const label = "block text-base font-semibold text-navy-900";

/**
 * The client's signing page (portal and secure link): read, tick each numbered
 * acknowledgment, answer the questions, confirm their details, type their signature.
 * Mobile-first: one column, 44px+ touch targets, body text at full contrast.
 */
export function SignAgreementPanel({ r, textHash, prefill, signAction, declineAction, consentText, today }: { r: Pick<Rendered, "title" | "intro" | "clauses" | "questions">; textHash: string; prefill: { name: string; address: string; phone: string; email: string }; signAction: Action; declineAction: Action; consentText: string; today: string }) {
  return (
    <div className="space-y-6" data-testid="sign-panel">
      <ActionForm action={signAction} className="space-y-6 rounded-2xl border border-navy-100 bg-ivory-50 p-4 sm:p-6">
        <input type="hidden" name="shownHash" value={textHash} />
        <AgreementText r={r} checkboxes />

        {r.questions.map((q) => (
          <fieldset key={q.key} className="space-y-2">
            <legend className={label}>{q.text}</legend>
            {q.choices.map((c) => (
              <label key={c} className="flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border border-navy-100 bg-white px-3 text-base text-slate-900">
                <input type="radio" name={`q_${q.key}`} value={c} required className="size-5 accent-navy-900" /> {c}
              </label>
            ))}
          </fieldset>
        ))}

        <fieldset className="space-y-3">
          <legend className="font-serif text-lg font-bold text-navy-900">Your information</legend>
          <label className={label}>Full Legal Name<input className={input} name="fullName" defaultValue={prefill.name} autoComplete="name" required /></label>
          <label className={label}>Address<input className={input} name="address" defaultValue={prefill.address} autoComplete="street-address" required /></label>
          <label className={label}>Phone<input className={input} name="phone" type="tel" defaultValue={prefill.phone} autoComplete="tel" required /></label>
          <label className={label}>Email<input className={input} name="email" type="email" defaultValue={prefill.email} autoComplete="email" required /></label>
        </fieldset>

        <fieldset className="space-y-3">
          <legend className="font-serif text-lg font-bold text-navy-900">Sign</legend>
          <label className="flex min-h-12 cursor-pointer items-start gap-3 rounded-xl border border-navy-100 bg-white p-3 text-base text-slate-900">
            <input type="checkbox" name="consent" required className="mt-1 size-6 shrink-0 accent-navy-900" data-testid="consent" /> {consentText}
          </label>
          <label className={label}>Client Signature <span className="font-normal text-slate-700">(type your full legal name)</span><input className={`${input} font-serif text-xl italic`} name="signature" autoComplete="off" required data-testid="signature" /></label>
          <p className="text-base text-slate-900"><span className="font-semibold text-navy-900">Date Signed:</span> {today}</p>
        </fieldset>

        <button type="submit" className="min-h-12 w-full rounded-xl bg-navy-900 px-4 py-3 text-lg font-semibold text-white hover:bg-navy-800" data-testid="sign-submit">Sign agreement</button>
      </ActionForm>

      <details className="rounded-2xl border border-navy-100 bg-white p-4">
        <summary className="flex min-h-11 cursor-pointer items-center text-base font-semibold text-navy-900">I don&apos;t want to sign — decline</summary>
        <ActionForm action={declineAction} className="mt-3 space-y-3">
          <label className={label}>Why are you declining?<textarea className={`${input} py-2`} name="reason" rows={3} required /></label>
          <button type="submit" className="min-h-12 w-full rounded-xl border-2 border-red-800 px-4 py-3 text-base font-semibold text-red-800">Decline agreement</button>
        </ActionForm>
      </details>
    </div>
  );
}
