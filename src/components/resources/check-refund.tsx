"use client";

import { useState } from "react";
import { hostOf, STATES } from "@/lib/resources/catalog";

export type RefundLink = { state: string; url: string | null; agency: string; status: string; note: string | null };

/** Links only: nothing is typed into or sent through Client Connect. */
export function CheckYourRefund({ irs, states }: { irs: { home: string | null; wmr: string | null }; states: RefundLink[] }) {
  const [code, setCode] = useState("");
  const pick = states.find((s) => s.state === code);
  const linkCls = "flex items-center justify-between gap-2 rounded-lg bg-white px-4 py-3 font-semibold text-navy-900 shadow-sm hover:bg-ivory-50";
  return (
    <section aria-labelledby="refund-heading" className="rounded-2xl border border-gold-500/60 bg-navy-900 p-5 text-white" data-testid="check-refund">
      <h2 id="refund-heading" className="font-serif text-xl font-bold">Check Your Refund</h2>
      <p className="mt-1 text-sm text-navy-100">Check directly with the IRS or your state tax agency. You may need information from your filed return.</p>
      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        {irs.home && <a className={linkCls} href={irs.home} target="_blank" rel="noopener noreferrer">IRS Website <span className="text-xs font-normal text-slate-600">{hostOf(irs.home)} ↗</span></a>}
        {irs.wmr && <a className={linkCls} href={irs.wmr} target="_blank" rel="noopener noreferrer">Where&apos;s My Federal Refund? <span className="text-xs font-normal text-slate-600">{hostOf(irs.wmr)} ↗</span></a>}
      </div>
      <label className="mt-4 block text-sm font-semibold text-gold-500" htmlFor="refund-state">Where&apos;s My State Refund?</label>
      <select id="refund-state" className="mt-1 w-full rounded-lg border-0 bg-white px-3 py-2.5 text-navy-900 sm:w-72" value={code} onChange={(e) => setCode(e.target.value)}>
        <option value="">Select your state…</option>
        {STATES.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
      </select>
      {code && (
        <div className="mt-3" role="status">
          {pick?.status === "NOT_APPLICABLE" ? (
            <p className="rounded-lg bg-white/10 px-3 py-2 text-sm">{pick.note}</p>
          ) : pick?.url ? (
            <a className={linkCls} href={pick.url} target="_blank" rel="noopener noreferrer">
              {pick.agency}{pick.status !== "VERIFIED" ? " (confirm on the agency site)" : ""} <span className="text-xs font-normal text-slate-600">{hostOf(pick.url)} ↗</span>
            </a>
          ) : (
            <p className="rounded-lg bg-white/10 px-3 py-2 text-sm">We haven&apos;t verified this state&apos;s refund tool yet. Search for the state&apos;s official Department of Revenue website, or ask our office.</p>
          )}
        </div>
      )}
      <p className="mt-3 text-xs text-navy-100">Opens the official government site in a new tab. We don&apos;t collect or see your Social Security number, refund amount or filing details.</p>
    </section>
  );
}
