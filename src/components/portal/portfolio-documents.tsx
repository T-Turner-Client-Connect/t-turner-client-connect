"use client";

import { useState } from "react";
import { PrintButton } from "@/components/print-button";

type Doc = { id: string; label: string; title: string; origin: string; released: string; href: string };

/**
 * Released documents with View / Download / Print each, and Download All (ZIP)
 * or Print All (one PDF) — for everything or just the selected documents.
 */
export function PortfolioDocuments({ orgId, docs }: { orgId: string; docs: Doc[] }) {
  const [picked, setPicked] = useState<string[]>([]);
  const bundle = (format: "zip" | "pdf", ids: string[] | null) => `/api/client/nonprofit/${orgId}/bundle?format=${format}${ids ? `&ids=${ids.join(",")}` : ""}`;
  const btn = "rounded-lg border border-navy-700 px-3 py-1.5 text-sm font-semibold text-navy-900";
  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-2" data-testid="bundle-actions">
        <a className="rounded-lg bg-navy-900 px-3 py-1.5 text-sm font-semibold text-white" href={bundle("zip", null)}>Download All (ZIP)</a>
        <PrintButton href={bundle("pdf", null)} label="Print All" />
        {picked.length > 0 && (
          <>
            <a className={btn} href={bundle("zip", picked)}>Download selected ({picked.length})</a>
            <PrintButton href={bundle("pdf", picked)} label={`Print selected (${picked.length})`} />
          </>
        )}
      </div>
      <ul className="divide-y divide-ivory-200" data-testid="portfolio-docs">
        {docs.map((d) => (
          <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-1" checked={picked.includes(d.id)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, d.id] : p.filter((x) => x !== d.id)))} aria-label={`Select ${d.label}`} />
              <span><strong>{d.label}</strong><span className="block text-xs text-slate-600">{d.origin} · added {d.released}</span></span>
            </label>
            <span className="flex flex-wrap gap-2">
              <a className="rounded-lg bg-navy-900 px-3 py-1.5 font-semibold text-white" href={d.href} target="_blank" rel="noopener">View</a>
              <a className={btn} href={`${d.href}?download=1`}>Download</a>
              <PrintButton href={d.href} />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
