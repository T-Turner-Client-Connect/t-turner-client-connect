"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { ActionForm } from "@/components/action-form";
import { Button, Field } from "@/components/ui";
import { resourceHelpAction, setStateAction } from "@/app/actions/resources";
import { CATEGORIES, hostOf, REQUEST_TOPICS, SECTIONS, STATES, stateName, type RequestTopic, type SectionKey } from "@/lib/resources/catalog";

export type ResourceItem = {
  id: string;
  jurisdiction: string;
  county: string | null;
  city: string | null;
  category: string;
  title: string;
  purpose: string;
  agency: string;
  url: string | null;
  phone: string | null;
  status: string;
  notes: string | null;
  lastVerified: string | null;
};

type Faq = { id: string; question: string; answer: string; tags: string[] };

const SECTION_REQUESTS: Partial<Record<SectionKey, RequestTopic[]>> = {
  BUSINESS: ["BUSINESS_SETUP", "LICENSING"],
  ALCOHOL: ["LICENSING", "ALCOHOL_TAX"],
  NONPROFIT: ["NONPROFIT_SETUP"],
  FEDERAL: ["SAM_ASSISTANCE"],
};

function matches(r: ResourceItem, q: string) {
  if (!q) return true;
  const hay = `${r.title} ${r.purpose} ${r.agency} ${CATEGORIES[r.category]?.label ?? ""} ${r.notes ?? ""} ${r.county ?? ""} ${r.city ?? ""}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

function HelpForm({ clientId, state, topic, area, onDone }: { clientId: string; state: string; topic: RequestTopic; area?: string; onDone?: () => void }) {
  const year = new Date().getFullYear();
  return (
    <ActionForm action={resourceHelpAction.bind(null, clientId)} className="mt-3 space-y-3 rounded-xl bg-white p-4 text-left shadow-inner" resetOnSuccess idempotent>
      <input type="hidden" name="topic" value={topic} />
      <input type="hidden" name="state" value={state} />
      {area && <input type="hidden" name="area" value={area} />}
      <p className="text-sm font-semibold text-navy-900">{REQUEST_TOPICS[topic]} · {state === "US" ? "Federal" : stateName(state)}</p>
      <Field label="How can we help?"><textarea className="input" name="message" rows={3} required placeholder="A few details help us respond faster. Please don't include Social Security numbers." /></Field>
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Supporting document (optional)"><input className="input" type="file" name="file" accept="application/pdf,image/png,image/jpeg" /></Field>
        <Field label="Tax year of the document">
          <select className="input" name="year" defaultValue="">
            <option value="">No document</option>
            {Array.from({ length: 6 }, (_, i) => year - i).map((y) => <option key={y} value={y}>{y}</option>)}
            <option value="unsure">Not sure</option>
          </select>
        </Field>
      </div>
      <div className="flex gap-2">
        <Button type="submit">Send securely</Button>
        {onDone && <Button type="button" variant="ghost" onClick={onDone}>Close</Button>}
      </div>
    </ActionForm>
  );
}

function Request({ clientId, state, topic, area, primary }: { clientId: string; state: string; topic: RequestTopic; area?: string; primary?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={clsx("rounded-lg px-4 py-2 text-sm font-semibold", primary ? "bg-gold-500 text-navy-950 hover:bg-gold-300" : "border border-navy-200 bg-white text-navy-900 hover:bg-navy-50")}
        aria-expanded={open}
      >
        {REQUEST_TOPICS[topic]}
      </button>
      {open && <HelpForm clientId={clientId} state={state} topic={topic} area={area} onDone={() => setOpen(false)} />}
    </div>
  );
}

function StatusPill({ r, state }: { r: ResourceItem; state: string }) {
  if (r.status === "VERIFIED") return <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-800">Verified{r.lastVerified ? ` ${r.lastVerified}` : ""}</span>;
  if (r.status === "NOT_APPLICABLE") return <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-700">Doesn&apos;t apply in {stateName(r.jurisdiction === "US" ? state : r.jurisdiction)}</span>;
  if (r.status === "UNAVAILABLE") return <span className="rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-semibold text-red-800">Currently unavailable</span>;
  return <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-800">Being verified — confirm on the agency site</span>;
}

function Card({ r, state }: { r: ResourceItem; state: string }) {
  const host = hostOf(r.url);
  return (
    <li className="flex flex-col justify-between rounded-xl border border-ivory-200 bg-white p-4 shadow-sm" data-resource={r.category}>
      <div>
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-bold uppercase tracking-wider text-gold-700">{CATEGORIES[r.category]?.label ?? r.category}</span>
          <StatusPill r={r} state={state} />
        </div>
        <h4 className="font-serif text-base font-bold text-navy-900">{r.title}</h4>
        <p className="text-xs text-slate-600">{r.agency}{r.city ? ` · ${r.city}` : r.county ? ` · ${r.county}` : ""}</p>
        <p className="mt-2 text-sm text-slate-800">{r.purpose}</p>
        {r.notes && r.status === "NOT_APPLICABLE" && <p className="mt-1 text-sm text-slate-700">{r.notes}</p>}
        {r.phone && <p className="mt-1 text-sm">Phone: <a className="underline" href={`tel:${r.phone.replace(/[^\d+]/g, "")}`}>{r.phone}</a></p>}
      </div>
      {r.url && r.status !== "NOT_APPLICABLE" && (
        <a
          href={r.url}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 inline-flex items-center justify-between gap-2 rounded-lg bg-navy-900 px-3 py-2 text-sm font-semibold text-white hover:bg-navy-800"
          aria-label={`${r.title} — opens ${host} in a new tab`}
        >
          <span className="truncate">Open {host}</span>
          <span aria-hidden className="text-gold-500">↗</span>
        </a>
      )}
    </li>
  );
}

export function ResourceCenter({
  clientId,
  initialState,
  resources,
  faqs,
  coverage,
}: {
  clientId: string;
  initialState: string;
  resources: ResourceItem[];
  faqs: Faq[];
  coverage: { missing: string[]; unconfirmed: string[] };
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [q, setQ] = useState("");
  const [local, setLocal] = useState("");
  const state = initialState;
  const changeState = (s: string) => start(async () => {
    await setStateAction(s);
    router.push(`/client/resources?state=${s}`);
  });
  const filtered = useMemo(() => resources.filter((r) => matches(r, q)), [resources, q]);
  const localOptions = [...new Set(resources.filter((r) => r.county || r.city).map((r) => r.city ? `${r.city}, ${r.county ?? ""}` : r.county!))];
  const faqHits = faqs.filter((f) => !q || `${f.question} ${f.answer} ${f.tags.join(" ")}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-2xl bg-gradient-to-br from-navy-900 to-navy-950 p-5 text-white shadow-lg sm:p-8">
        <p className="text-xs font-bold uppercase tracking-[0.2em] text-gold-500">TTurner Resource Center</p>
        <h1 className="mt-1 font-serif text-2xl font-bold text-white sm:text-3xl">Official links for taxes, licenses and filings</h1>
        <p className="mt-1 max-w-2xl text-sm text-navy-100">Every link goes straight to the official government website. Sign in and pay there — we never ask for your agency passwords.</p>
        <div className="mt-5 grid gap-3 sm:grid-cols-[minmax(0,240px)_1fr]">
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-gold-500">Select Your State</span>
            <select className="w-full rounded-lg border-0 bg-white px-3 py-2.5 text-navy-900" value={state} onChange={(e) => changeState(e.target.value)} disabled={pending} aria-label="Select your state">
              {STATES.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-gold-500">Search</span>
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Try “sales tax”, “liquor license”, “nonprofit”, “refund”"
              className="w-full rounded-lg border-0 bg-white px-3 py-2.5 text-navy-900"
              aria-label="Search resources"
            />
          </label>
        </div>
        {pending && <p className="mt-2 text-sm text-gold-300">Loading {stateName(state)}…</p>}
      </section>

      {(coverage.missing.length > 0 || coverage.unconfirmed.length > 0) && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900" role="status" data-testid="coverage-note">
          <strong>{stateName(state)} coverage is still being completed.</strong>{" "}
          {coverage.missing.length > 0 && <>Not yet listed: {coverage.missing.map((c) => CATEGORIES[c]?.label ?? c).join(", ")}. </>}
          {coverage.unconfirmed.length > 0 && <>Being verified: {coverage.unconfirmed.map((c) => CATEGORIES[c]?.label ?? c).join(", ")}. </>}
          Use &ldquo;Ask TTurner for Help&rdquo; and we&apos;ll point you to the right office.
        </div>
      )}

      {SECTIONS.map((section) => {
        const items = filtered.filter((r) => CATEGORIES[r.category]?.section === section.key && (section.key !== "LOCAL" || !local || (r.city ? `${r.city}, ${r.county ?? ""}` : r.county) === local));
        if (section.key === "LOCAL" && !localOptions.length) return null;
        if (q && !items.length && section.key !== "NONPROFIT") return null;
        return (
          <section key={section.key} aria-labelledby={`s-${section.key}`} className="rounded-2xl border border-ivory-200 bg-ivory-50 p-4 sm:p-6" data-section={section.key}>
            <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 id={`s-${section.key}`} className="font-serif text-xl font-bold text-navy-900">{section.key === "FEDERAL" ? section.title : `${section.title} — ${stateName(state)}`}</h2>
                <p className="text-sm text-slate-600">{section.blurb}</p>
              </div>
              {section.key === "LOCAL" && (
                <select className="rounded-lg border border-navy-100 px-3 py-2 text-sm" value={local} onChange={(e) => setLocal(e.target.value)} aria-label="County or city">
                  <option value="">All verified counties & cities</option>
                  {localOptions.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              )}
            </div>
            {section.key === "NONPROFIT" && (
              <div className="mb-4 rounded-xl border-2 border-gold-500 bg-gradient-to-r from-navy-900 to-navy-800 p-5 text-white">
                <p className="font-serif text-xl font-bold">We help establish nonprofits.</p>
                <p className="mt-1 text-sm text-navy-100">Tell us about your plans and our team will follow up about getting your nonprofit established.</p>
                <div className="mt-3"><Request clientId={clientId} state={state} topic="NONPROFIT_SETUP" primary /></div>
              </div>
            )}
            {section.key === "FEDERAL" && (
              <p className="mb-3 rounded-lg bg-white px-3 py-2 text-sm text-slate-700">
                <strong>SAM.gov registration is free.</strong> If TTurner &amp; Associates helps you register or renew, our service fee is separate from the government site.
              </p>
            )}
            {items.length ? (
              <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{items.map((r) => <Card key={r.id} r={r} state={state} />)}</ul>
            ) : (
              <p className="rounded-lg bg-white px-3 py-4 text-sm text-slate-700">No verified links listed here yet for {stateName(state)}. Ask us and we&apos;ll find the right office.</p>
            )}
            <div className="mt-4 flex flex-wrap gap-2">
              {(SECTION_REQUESTS[section.key] ?? []).filter((t) => section.key !== "NONPROFIT" || t !== "NONPROFIT_SETUP").map((t) => <Request key={t} clientId={clientId} state={section.key === "FEDERAL" ? "US" : state} topic={t} />)}
              <Request clientId={clientId} state={section.key === "FEDERAL" ? "US" : state} topic="HELP" area={section.title} />
            </div>
          </section>
        );
      })}

      <section aria-labelledby="faq" className="rounded-2xl border border-ivory-200 bg-white p-4 sm:p-6">
        <h2 id="faq" className="font-serif text-xl font-bold text-navy-900">Common Questions</h2>
        {faqHits.length === 0 ? (
          <p className="mt-2 text-sm text-slate-600">No questions match your search.</p>
        ) : (
          <ul className="mt-3 divide-y divide-ivory-200">
            {faqHits.map((f) => (
              <li key={f.id}>
                <details className="py-3">
                  <summary className="cursor-pointer font-semibold text-navy-900">{f.question}</summary>
                  <p className="mt-2 whitespace-pre-line text-sm text-slate-700">{f.answer}</p>
                </details>
              </li>
            ))}
          </ul>
        )}
      </section>
      <p className="text-xs text-slate-500">
        Clicking a link doesn&apos;t record a payment or filing with us. Pay and file directly on the official site, then let us know through Messages if you&apos;d like us to keep a copy.
      </p>
    </div>
  );
}
