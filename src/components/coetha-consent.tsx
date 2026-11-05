import { Sparkles } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { COETHA_CONSENT_TEXT, COETHA_CONSENT_TITLE, COETHA_CONSENT_VERSION, CONSENT_LABEL, type ConsentState } from "@/lib/services/coetha-consent";
import { portalCoethaDecisionAction, staffCoethaConsentAction } from "@/app/actions/doc-security";
import { fmtDate } from "@/lib/format";

const tone = (s: ConsentState["state"]) => (s === "AUTHORIZED" ? "bg-emerald-50 text-emerald-800" : s === "NONE" || s === "OLD_VERSION" ? "bg-amber-50 text-amber-800" : "bg-slate-100 text-slate-700");

export function ConsentBadge({ state }: { state: ConsentState }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${tone(state.state)}`} data-testid="coetha-consent-status" data-state={state.state}>
      AI assistant: {CONSENT_LABEL[state.state]}
    </span>
  );
}

/** Client portal: the notice with "I authorize" / "I decline", or the current answer with "Withdraw". */
export function PortalCoethaNotice({ clientId, state }: { clientId: string; state: ConsentState }) {
  const answered = state.state === "AUTHORIZED" || state.state === "DECLINED" || state.state === "WITHDRAWN";
  return (
    <section className="mb-4 rounded-2xl border border-gold-200/80 bg-gradient-to-b from-white to-ivory-50 p-5 sm:p-6" data-testid="coetha-notice" data-version={COETHA_CONSENT_VERSION}>
      <h2 className="flex items-center gap-2 font-serif text-lg font-bold text-navy-900"><Sparkles className="size-5 text-gold-600" aria-hidden /> {COETHA_CONSENT_TITLE}</h2>
      <div className="mt-2 space-y-2 text-sm text-navy-900">
        {COETHA_CONSENT_TEXT.map((p) => <p key={p}>{p}</p>)}
      </div>
      {state.state === "OLD_VERSION" && <p className="mt-3 text-sm font-semibold text-amber-800">We updated this notice. Please review it and answer again.</p>}
      {answered ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-ivory-200 pt-3">
          <p className="text-sm text-navy-900">Your answer: <strong>{state.state === "AUTHORIZED" ? "Authorized" : state.state === "DECLINED" ? "Declined" : "Withdrawn"}</strong>{state.consent ? ` on ${fmtDate(state.consent.createdAt)}` : ""}.</p>
          {state.state === "AUTHORIZED" ? (
            <ActionForm action={portalCoethaDecisionAction.bind(null, clientId, "WITHDRAWN")} confirm="Withdraw your authorization? We'll do your books without the AI assistant from now on.">
              <button type="submit" className="inline-flex min-h-10 items-center rounded-lg border-[1.5px] border-navy-900 bg-white px-4 py-2 text-sm font-semibold text-navy-900">Withdraw</button>
            </ActionForm>
          ) : (
            <ActionForm action={portalCoethaDecisionAction.bind(null, clientId, "AUTHORIZED")}>
              <button type="submit" className="inline-flex min-h-10 items-center rounded-lg bg-navy-900 px-4 py-2 text-sm font-semibold text-white">I authorize</button>
            </ActionForm>
          )}
        </div>
      ) : (
        <div className="mt-4 flex flex-wrap gap-2 border-t border-ivory-200 pt-3">
          <ActionForm action={portalCoethaDecisionAction.bind(null, clientId, "AUTHORIZED")}>
            <button type="submit" className="inline-flex min-h-10 items-center rounded-lg bg-navy-900 px-4 py-2 text-sm font-semibold text-white" data-testid="coetha-authorize">I authorize</button>
          </ActionForm>
          <ActionForm action={portalCoethaDecisionAction.bind(null, clientId, "DECLINED")}>
            <button type="submit" className="inline-flex min-h-10 items-center rounded-lg border-[1.5px] border-navy-900 bg-white px-4 py-2 text-sm font-semibold text-navy-900" data-testid="coetha-decline">I decline</button>
          </ActionForm>
        </div>
      )}
      <p className="mt-2 text-xs text-slate-600">Notice version {COETHA_CONSENT_VERSION}.</p>
    </section>
  );
}

/** Staff (bookkeeping dashboard): status, and recording an in-office or written answer. */
export function StaffCoethaConsent({ clientId, state }: { clientId: string; state: ConsentState }) {
  return (
    <details className="rounded-xl border border-ivory-200 bg-white p-3 text-sm" data-testid="coetha-consent-staff">
      <summary className="flex cursor-pointer flex-wrap items-center gap-2">
        <ConsentBadge state={state} />
        {state.consent && <span className="text-xs text-slate-600">{state.consent.method === "PORTAL" ? "In the portal" : state.consent.method === "IN_OFFICE" ? "In the office" : "In writing"}{state.consent.decidedByName ? ` · ${state.consent.decidedByName}` : ""} · {fmtDate(state.consent.createdAt)} · v{state.consent.version}</span>}
      </summary>
      <p className="mt-2 text-navy-900">Coetha works on this business only with the client&apos;s current authorization. Clients answer in their portal (Bookkeeping). Record an answer they gave in the office or in writing here:</p>
      <ActionForm action={staffCoethaConsentAction.bind(null, clientId)} className="mt-2 grid gap-2 sm:grid-cols-2">
        <select name="status" className="input" defaultValue="AUTHORIZED" aria-label="Answer"><option value="AUTHORIZED">Authorized</option><option value="DECLINED">Declined</option><option value="WITHDRAWN">Withdrawn</option></select>
        <select name="method" className="input" defaultValue="" aria-label="How"><option value="" disabled>How did they answer?</option><option value="IN_OFFICE">In the office</option><option value="WRITTEN">In writing</option></select>
        <input name="clientName" className="input" placeholder="Who answered (name)" maxLength={120} />
        <input name="note" className="input" placeholder="Note: when, and where the signed copy is kept" required minLength={5} maxLength={500} />
        <button type="submit" className="inline-flex min-h-10 items-center justify-center rounded-lg bg-navy-900 px-4 py-2 text-sm font-semibold text-white sm:col-span-2 sm:justify-self-start">Record answer</button>
      </ActionForm>
    </details>
  );
}
