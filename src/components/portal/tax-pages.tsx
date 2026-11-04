"use client";

import { useState } from "react";

/**
 * Tax Year select + Start Questionnaire for the My Tax Center card. Same rules as the original
 * picker: a year without a form shows "coming soon" with Start disabled (never another year's
 * form), and opening the form never marks it complete — only a verified submission does.
 */
export function QuestionnaireStart({ options }: { options: { year: number; url: string | null; completed: boolean }[] }) {
  const [year, setYear] = useState(String(options.find((o) => o.year === new Date().getFullYear() - 1)?.year ?? options[0]?.year ?? ""));
  const pick = options.find((o) => String(o.year) === year);
  const available = !!pick?.url && !pick.completed;
  return (
    <div className="space-y-3" data-testid="questionnaire-picker">
      <label className="block">
        <span className="mb-1 block text-sm font-semibold text-navy-900">Tax Year</span>
        <select className="input h-10 bg-white" value={year} onChange={(e) => setYear(e.target.value)}>
          {options.map((o) => (
            <option key={o.year} value={o.year}>
              {o.year}{o.completed ? " — completed" : !o.url ? " — coming soon" : ""}
            </option>
          ))}
        </select>
      </label>
      {pick?.completed && <p className="text-sm text-emerald-800" data-testid="q-status">✓ Our office has your {pick.year} questionnaire.</p>}
      {pick && !pick.completed && !pick.url && <p className="text-sm font-semibold text-navy-900" data-testid="q-status">{pick.year} questionnaire coming soon</p>}
      {available ? (
        <a href={pick!.url!} target="_blank" rel="noopener noreferrer" className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-gradient-to-b from-gold-300 to-gold-500 px-4 py-2.5 font-bold text-navy-950 shadow hover:to-gold-400" data-testid="q-open">
          Start Questionnaire <span aria-hidden>→</span>
        </a>
      ) : (
        !pick?.completed && (
          <button type="button" disabled aria-disabled="true" className="inline-flex w-full cursor-not-allowed items-center justify-center rounded-full bg-ivory-200 px-4 py-2.5 font-semibold text-slate-500" data-testid="q-open-disabled">
            Start Questionnaire
          </button>
        )
      )}
    </div>
  );
}
