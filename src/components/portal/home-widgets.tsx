"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { BarChart3, Building2, Calculator, ChevronLeft, ChevronRight, ClipboardList, Leaf } from "lucide-react";

/** Tax-year dropdown that reloads the dashboard for that year. */
export function TaxYearSelect({ years, year, base }: { years: number[]; year: number; base: string }) {
  const router = useRouter();
  return (
    <label className="flex items-center gap-2 text-sm text-navy-900">
      <span className="font-medium">Tax Year</span>
      <select className="rounded-lg border border-ivory-200 bg-white px-3 py-2 font-serif text-base text-navy-900 shadow-sm" value={year} onChange={(e) => router.push(`${base}year=${e.target.value}`, { scroll: false })} aria-label="Tax year">
        {years.map((y) => <option key={y} value={y}>{y}</option>)}
      </select>
    </label>
  );
}

const CATEGORIES = [
  { title: "Taxes & Payments", detail: "Helpful links and resources", anchor: "taxes", icon: Calculator },
  { title: "SBA & SAM.gov", detail: "Business resources", anchor: "federal", icon: BarChart3 },
  { title: "Licenses & Alcohol Taxes", detail: "State resources", anchor: "alcohol", icon: ClipboardList },
  { title: "Business & Nonprofit Setup", detail: "Guides and information", anchor: "nonprofit", icon: Building2 },
];

/** Resource Center card: choose a state, then jump to a category. */
export function ResourcePicker({ states, initial, q, readOnly }: { states: { code: string; name: string }[]; initial: string; q: string; readOnly?: boolean }) {
  const [state, setState] = useState(initial);
  const link = (anchor: string) => (readOnly ? "#" : `/client/resources${q}${q ? "&" : "?"}state=${state}#${anchor}`);
  return (
    <>
      <label className="flex items-center gap-2 text-sm text-navy-900">
        <span>Select State</span>
        <select className="rounded-lg border border-ivory-200 bg-white px-3 py-2 text-sm shadow-sm" value={state} onChange={(e) => setState(e.target.value)} aria-label="State">
          {states.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
        </select>
      </label>
      <div className="mt-2 grid w-full basis-full grid-cols-2 gap-3 lg:grid-cols-4">
        {CATEGORIES.map((c) => (
          <Link key={c.title} href={link(c.anchor)} className="group flex flex-col rounded-xl border border-ivory-200 bg-white p-4 shadow-sm transition hover:border-gold-500 hover:shadow" data-resource-tile={c.anchor}>
            <c.icon className="mb-3 size-7 text-gold-600" aria-hidden />
            <span className="font-serif text-[15px] font-bold leading-snug text-navy-900">{c.title}</span>
            <span className="text-xs text-slate-600">{c.detail}</span>
            <ChevronRight className="mt-2 size-4 self-end text-navy-700 transition group-hover:translate-x-0.5" aria-hidden />
          </Link>
        ))}
      </div>
    </>
  );
}

export type Slide = { kicker?: string; title: string; body: string; href?: string };

/** Announcements, one at a time, with arrows and dots. */
export function AnnouncementCarousel({ slides }: { slides: Slide[] }) {
  const [i, setI] = useState(0);
  if (!slides.length) return null;
  const s = slides[i];
  const go = (d: number) => setI((i + d + slides.length) % slides.length);
  return (
    <div className="rounded-xl bg-ivory-100 p-4" data-testid="announcement-carousel">
      <div className="flex items-start gap-3">
        <span className="mt-1 flex size-12 shrink-0 items-center justify-center rounded-full bg-white text-gold-600 shadow-sm"><Leaf className="size-6" aria-hidden /></span>
        <div className="min-h-24 flex-1">
          {s.kicker && <p className="text-[11px] font-semibold uppercase tracking-wide text-gold-700">{s.kicker}</p>}
          <p className="font-serif text-base font-bold text-navy-900">{s.title}</p>
          <p className="line-clamp-3 whitespace-pre-wrap text-sm text-slate-700">{s.body}</p>
          {s.href && <Link href={s.href} className="mt-1 inline-block text-xs font-semibold text-gold-700 underline">Learn more</Link>}
        </div>
      </div>
      {slides.length > 1 && (
        <div className="mt-3 flex items-center justify-between">
          <button type="button" onClick={() => go(-1)} className="rounded-full p-1 text-navy-700 hover:bg-white" aria-label="Previous announcement"><ChevronLeft className="size-5" /></button>
          <span className="flex gap-1.5" aria-hidden>
            {slides.map((_, k) => <span key={k} className={`size-2 rounded-full ${k === i ? "bg-gold-500" : "bg-navy-100"}`} />)}
          </span>
          <button type="button" onClick={() => go(1)} className="rounded-full p-1 text-navy-700 hover:bg-white" aria-label="Next announcement"><ChevronRight className="size-5" /></button>
        </div>
      )}
    </div>
  );
}
