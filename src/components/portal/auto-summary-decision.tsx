"use client";

import { useState } from "react";
import { ActionForm } from "@/components/action-form";

type Signer = { role: "TAXPAYER" | "SPOUSE"; name: string; consent: string; signed: string | null };
type Act = (prev: { error?: string; ok?: string } | null, fd: FormData) => Promise<{ error?: string; ok?: string } | null>;

const big = "flex min-h-[52px] w-full items-center justify-center rounded-xl px-4 text-base font-semibold focus-visible:outline-3 focus-visible:outline-offset-2";

/**
 * "Approve my summary" / "I have a question". Approving opens the existing
 * electronic signature (typed name + consent); on a joint return each spouse
 * signs in their own name. A question goes to the office as a secure message
 * and puts the summary on hold until an updated one is sent.
 */
export function AutoSummaryDecision({ signers, approveActions, questionAction, readOnly }: { signers: Signer[]; approveActions: Record<string, Act>; questionAction: Act; readOnly?: boolean }) {
  const [open, setOpen] = useState<"approve" | "question" | null>(null);
  const pending = signers.filter((s) => !s.signed);
  return (
    <div className="flex flex-col gap-2.5" data-testid="auto-summary-decision">
      {signers.filter((s) => s.signed).map((s) => (
        <p key={s.role} className="rounded-xl bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-900" role="status">{s.signed}</p>
      ))}
      {pending.length > 0 && (
        <button type="button" className={`${big} bg-navy-900 text-white hover:bg-navy-800`} aria-expanded={open === "approve"} onClick={() => setOpen(open === "approve" ? null : "approve")} disabled={readOnly} data-testid="approve-open">
          Approve my summary
        </button>
      )}
      {open === "approve" &&
        pending.map((s) => (
          <ActionForm key={s.role} action={approveActions[s.role]} className="rounded-xl border-2 border-navy-100 bg-white p-4">
            <p className="font-semibold text-navy-900">{signers.length > 1 ? `${s.role === "SPOUSE" ? "Spouse" : "Taxpayer"}: ${s.name}` : "Sign to approve"}</p>
            <label className="mt-2 flex min-h-11 items-start gap-3 text-sm text-slate-700">
              <input type="checkbox" name="agree" required className="mt-0.5 size-5 shrink-0 accent-navy-900" />
              <span>{s.consent}</span>
            </label>
            <label className="mt-3 block text-sm font-semibold text-navy-900">
              Type your full name to sign: <span className="font-normal text-slate-600">{s.name}</span>
              <input className="input mt-1 min-h-11" name="signerName" required autoComplete="off" aria-label={`${s.role === "SPOUSE" ? "Spouse" : "Taxpayer"} signature`} />
            </label>
            <button type="submit" className={`${big} mt-3 bg-navy-900 text-white hover:bg-navy-800`}>Sign and approve</button>
          </ActionForm>
        ))}
      {pending.length > 0 && (
        <button type="button" className={`${big} min-h-12 border-[1.5px] border-navy-900 bg-white text-[15px] text-navy-900 hover:bg-navy-50`} aria-expanded={open === "question"} onClick={() => setOpen(open === "question" ? null : "question")} disabled={readOnly} data-testid="question-open">
          I have a question
        </button>
      )}
      {open === "question" && (
        <ActionForm action={questionAction} className="rounded-xl border-2 border-navy-100 bg-white p-4">
          <label className="block text-sm font-semibold text-navy-900">
            What would you like to ask?
            <textarea className="input mt-1 min-h-24" name="note" required maxLength={2000} />
          </label>
          <p className="mt-1 text-xs text-slate-600">Your question goes to our office as a secure message. Your summary waits until we answer and send you an updated one.</p>
          <button type="submit" className={`${big} mt-3 bg-navy-900 text-white hover:bg-navy-800`}>Send my question</button>
        </ActionForm>
      )}
    </div>
  );
}
