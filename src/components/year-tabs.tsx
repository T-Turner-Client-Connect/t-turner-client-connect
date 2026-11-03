"use client";

import { useState, type ReactNode } from "react";

/** Payment history by year: click a year to see that year's payments. */
export function YearTabs({ years, panels, testId }: { years: string[]; panels: Record<string, ReactNode>; testId?: string }) {
  const [year, setYear] = useState(years[0]);
  if (!years.length) return null;
  return (
    <div data-testid={testId}>
      <div role="tablist" aria-label="Year" className="mb-3 flex flex-wrap gap-2">
        {years.map((y) => (
          <button
            key={y}
            type="button"
            role="tab"
            aria-selected={y === year}
            onClick={() => setYear(y)}
            data-year={y}
            className={`rounded-full px-4 py-1.5 text-sm font-semibold transition ${y === year ? "bg-navy-950 text-gold-300 ring-2 ring-gold-500" : "bg-ivory-50 text-navy-900 ring-1 ring-ivory-200 hover:bg-gold-100"}`}
          >
            {y}
          </button>
        ))}
      </div>
      <div role="tabpanel">{panels[year]}</div>
    </div>
  );
}
