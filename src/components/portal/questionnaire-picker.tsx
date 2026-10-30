"use client";

import { useState } from "react";

/** Choose a tax year, then open that year's Jotform questionnaire in a new tab. */
export function QuestionnairePicker({ options, disabled }: { options: { year: number; url: string | null; completed: boolean }[]; disabled?: boolean }) {
  const [year, setYear] = useState(String(options.find((o) => o.year === new Date().getFullYear() - 1)?.year ?? options[0]?.year ?? ""));
  const pick = options.find((o) => String(o.year) === year);
  return (
    <div className="space-y-2" data-testid="questionnaire-picker">
      <label className="block text-sm font-semibold text-navy-900" htmlFor="q-year">Tax year</label>
      <select id="q-year" className="input" value={year} onChange={(e) => setYear(e.target.value)}>
        {options.map((o) => (
          <option key={o.year} value={o.year}>
            {o.year}{o.completed ? " — completed" : !o.url ? " — not available yet" : ""}
          </option>
        ))}
      </select>
      {pick?.completed ? (
        <p className="text-sm text-emerald-800" data-testid="q-status">✓ Our office has your {pick.year} questionnaire. You don&apos;t need to complete it again.</p>
      ) : pick?.url && !disabled ? (
        <a href={pick.url} target="_blank" rel="noopener noreferrer" className="inline-flex w-full items-center justify-center rounded-xl bg-gold-500 px-4 py-2.5 font-semibold text-navy-950 shadow hover:bg-gold-300" data-testid="q-open">
          Open {pick.year} questionnaire ↗
        </a>
      ) : (
        <p className="text-sm text-slate-700" data-testid="q-status">The {pick?.year} questionnaire isn&apos;t available online yet. Send us a message and we&apos;ll help.</p>
      )}
      <p className="text-xs text-slate-600">Opens on Jotform, our secure form service. It&apos;s marked complete only after Jotform confirms your submission.</p>
    </div>
  );
}
