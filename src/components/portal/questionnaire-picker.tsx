"use client";

import { useState } from "react";

/**
 * Choose a tax year, then Start Questionnaire (opens that year's Jotform form
 * in a new tab). A year without a form shows "coming soon" with Start
 * disabled — never another year's form. Opening the form doesn't mark it
 * complete; only a verified submission does.
 */
export function QuestionnairePicker({ options, disabled, uploadHref }: { options: { year: number; url: string | null; completed: boolean }[]; disabled?: boolean; uploadHref?: string }) {
  const [year, setYear] = useState(String(options.find((o) => o.year === new Date().getFullYear() - 1)?.year ?? options[0]?.year ?? ""));
  const pick = options.find((o) => String(o.year) === year);
  const available = !!pick?.url && !pick.completed && !disabled;
  return (
    <div className="space-y-2" data-testid="questionnaire-picker">
      <label className="block text-sm font-semibold text-navy-900" htmlFor="q-year">Tax year</label>
      <select id="q-year" className="input" value={year} onChange={(e) => setYear(e.target.value)}>
        {options.map((o) => (
          <option key={o.year} value={o.year}>
            {o.year}{o.completed ? " — completed" : !o.url ? " — coming soon" : ""}
          </option>
        ))}
      </select>
      {pick?.completed && <p className="text-sm text-emerald-800" data-testid="q-status">✓ Our office has your {pick.year} questionnaire. You don&apos;t need to complete it again.</p>}
      {pick && !pick.completed && !pick.url && <p className="text-sm font-semibold text-navy-900" data-testid="q-status">{pick.year} questionnaire coming soon</p>}
      {available ? (
        <a href={pick!.url!} target="_blank" rel="noopener noreferrer" className="inline-flex w-full items-center justify-center rounded-xl bg-gold-500 px-4 py-2.5 font-semibold text-navy-950 shadow hover:bg-gold-300" data-testid="q-open">
          Start Questionnaire ↗
        </a>
      ) : (
        !pick?.completed && (
          <button type="button" disabled aria-disabled="true" className="inline-flex w-full cursor-not-allowed items-center justify-center rounded-xl bg-ivory-200 px-4 py-2.5 font-semibold text-slate-500" data-testid="q-open-disabled">
            Start Questionnaire
          </button>
        )
      )}
      {uploadHref && pick && (
        <p className="text-sm">
          <a className="underline" href={`${uploadHref}${pick.year}`} data-testid="q-upload">Upload {pick.year} documents</a> — available any time, separately from the questionnaire.
        </p>
      )}
      <p className="text-sm">
        <a className="font-semibold underline" href="/client/taxes/filings" data-testid="q-earlier">View Earlier Years / Retrieve Tax Filings</a> <span className="text-xs text-slate-600">(2020 onward, where available)</span>
      </p>
      <p className="text-xs text-slate-600">Opens on Jotform, our secure form service. It&apos;s marked complete only after our office confirms your submission.</p>
    </div>
  );
}
