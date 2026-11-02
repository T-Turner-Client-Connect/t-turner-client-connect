"use client";

import { useState } from "react";
import clsx from "clsx";
import { PrintButton } from "@/components/print-button";

export type PortfolioFile = { id: string; kind: "PDF" | "Word" | "Image"; name: string; href: string };
export type PortfolioCard = { id: string; label: string; statusLabel: string; done: boolean; deliverable: boolean; origin: string | null; files: PortfolioFile[] };
export type PortfolioSection = { key: string; label: string; cards: PortfolioCard[]; note?: { title: string; text: string } };

/**
 * The client's nonprofit portfolio: one card per document, grouped by section.
 * Each released format has View / Download / Print where the format supports
 * it (Word files download). Download All (ZIP) and Print All (one PDF) work on
 * everything or just the selected files.
 */
export function PortfolioSections({ orgId, sections }: { orgId: string; sections: PortfolioSection[] }) {
  const [picked, setPicked] = useState<string[]>([]);
  const bundle = (format: "zip" | "pdf", ids: string[] | null) => `/api/client/nonprofit/${orgId}/bundle?format=${format}${ids ? `&ids=${ids.join(",")}` : ""}`;
  const anyFiles = sections.some((s) => s.cards.some((c) => c.files.length));
  const outline = "rounded-lg border border-navy-700 px-3 py-1.5 text-sm font-semibold text-navy-900 hover:bg-navy-50";
  return (
    <div className="space-y-6">
      {anyFiles && (
        <div className="flex flex-wrap gap-2" data-testid="bundle-actions">
          <a className="rounded-lg bg-navy-900 px-3 py-1.5 text-sm font-semibold text-white" href={bundle("zip", null)}>Download All (ZIP)</a>
          <PrintButton href={bundle("pdf", null)} label="Print All" />
          {picked.length > 0 && (
            <>
              <a className={outline} href={bundle("zip", picked)}>Download selected ({picked.length})</a>
              <PrintButton href={bundle("pdf", picked)} label={`Print selected (${picked.length})`} />
            </>
          )}
        </div>
      )}
      {sections.map((s) => (
        <section key={s.key} data-testid="portfolio-section" data-section={s.key}>
          <h2 className="mb-3 font-serif text-xl text-navy-900">{s.label}</h2>
          {s.note && (
            <div className="mb-3 rounded-xl border border-gold-300 bg-ivory-50 p-3 text-xs text-slate-700" data-testid="grant-disclaimer">
              <p className="mb-1 font-semibold text-navy-900">{s.note.title}</p>
              <p className="whitespace-pre-wrap">{s.note.text}</p>
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2" data-testid="portfolio-docs">
            {s.cards.map((c) => (
              <div key={c.id} className={clsx("rounded-2xl border bg-white p-4 shadow-sm", c.files.length ? "border-gold-300" : "border-ivory-200")} data-testid="doc-card" data-doc={c.label}>
                <div className="mb-2 flex items-start justify-between gap-2">
                  <p className="font-semibold text-navy-900">{c.label}</p>
                  <span className={clsx("whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold", c.done ? "bg-emerald-50 text-emerald-700" : "bg-ivory-100 text-slate-600")}>{c.statusLabel}</span>
                </div>
                <p className="mb-3 text-xs text-slate-600">{[c.deliverable ? "Included in your package" : null, c.origin].filter(Boolean).join(" · ") || " "}</p>
                {c.files.length === 0 ? (
                  <p className="text-sm text-slate-500">Available here once it&apos;s completed and released to you.</p>
                ) : (
                  <ul className="space-y-2">
                    {c.files.map((f) => (
                      <li key={f.id} className="flex flex-wrap items-center gap-2 text-sm">
                        <input type="checkbox" checked={picked.includes(f.id)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, f.id] : p.filter((x) => x !== f.id)))} aria-label={`Select ${c.label} (${f.kind})`} />
                        <span className="rounded bg-navy-50 px-1.5 py-0.5 text-xs font-bold text-navy-900">{f.kind}</span>
                        {f.kind !== "Word" && <a className="rounded-lg bg-navy-900 px-3 py-1 font-semibold text-white" href={f.href} target="_blank" rel="noopener">View</a>}
                        <a className={outline} href={`${f.href}?download=1`}>Download</a>
                        {f.kind !== "Word" && <PrintButton href={f.href} />}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
