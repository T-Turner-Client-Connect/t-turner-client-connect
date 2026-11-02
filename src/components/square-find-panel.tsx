"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, CalendarDays, Check, CircleCheck, CreditCard, Receipt, Repeat } from "lucide-react";
import { Badge, Button } from "@/components/ui";

const CADENCE: Record<string, string> = { MONTHLY: "Monthly", QUARTERLY: "Quarterly", YEARLY: "Yearly", WEEKLY: "Weekly" };
const ordinal = (d: number) => `${d}${d % 10 === 1 && d !== 11 ? "st" : d % 10 === 2 && d !== 12 ? "nd" : d % 10 === 3 && d !== 13 ? "rd" : "th"}`;
const Tick = ({ ok, children }: { ok: boolean; children: React.ReactNode }) => (
  <li className="flex items-center gap-2.5">{ok ? <CircleCheck aria-hidden className="size-5 fill-emerald-600 text-white" /> : <span aria-hidden className="grid size-5 place-items-center rounded-full bg-slate-300 text-xs font-bold text-white">–</span>}<span className={ok ? "text-navy-900" : "text-slate-500"}>{children}</span></li>
);

type Tone = "navy" | "gold" | "green" | "red" | "gray" | "amber";
import { linkSquareBillingAction, reviewSquareSeriesAction, squareSearchAction, squareSuggestAction, type SquareSearchResult } from "@/app/actions/square-billing";

type Client = { id: string; name: string; email: string | null; phone: string | null };
type Option = { id: string; name: string };
type Result = SquareSearchResult & { score?: number; reasons?: string[] };
type Pick = { customer: Result; series: SquareSearchResult["series"][number] };

const usd = (c: number | null) => (c == null ? "—" : `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`);
const digits = (s: string | null) => (s ?? "").replace(/\D/g, "").slice(-10);
const same = (a: string | null, b: string | null, norm: (s: string | null) => string) => !!norm(a) && norm(a) === norm(b);
const lower = (s: string | null) => (s ?? "").trim().toLowerCase();
const fmtDay = (iso: string | null) => (iso ? new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : null);

/**
 * Find and link in Square, inside the billing card. Search is read only; linking
 * saves only the verified Square customer ID and series in Client Connect. Nothing
 * is created, changed or charged in Square.
 */
export function SquareFindPanel({ client, coverOptions, autoSuggest = false, initialQuery, owner = false }: { client: Client; coverOptions: Option[]; autoSuggest?: boolean; initialQuery?: string; owner?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(autoSuggest);
  const [query, setQuery] = useState(initialQuery || client.email || client.name);
  const [results, setResults] = useState<Result[] | null>(null);
  // Set when the results came from the automatic search with the client's saved details.
  const [suggested, setSuggested] = useState<{ confident: string | null } | null>(null);
  const ran = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState<Pick | null>(null);
  const [covers, setCovers] = useState<string[]>([client.id]);
  const [confirmed, setConfirmed] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [searching, startSearch] = useTransition();
  const [linking, startLink] = useTransition();

  // Searches automatically with the client's saved name, business name, email and phone (read only).
  useEffect(() => {
    if (!autoSuggest || ran.current) return;
    ran.current = true;
    startSearch(async () => {
      try {
        const r = await squareSuggestAction(client.id);
        if (r.error) setError(r.error);
        else {
          setResults(r.results ?? []);
          setSuggested({ confident: r.confident ?? null });
        }
      } catch {
        setError("Square couldn't be searched right now. Nothing was changed — please try again.");
      }
    });
  }, [autoSuggest, client.id]);

  const search = (text = query) => {
    setError(null);
    setPick(null);
    setDone(null);
    setSuggested(null);
    startSearch(async () => {
      try {
        const r = await squareSearchAction(text);
        if (r.error) {
          setResults(null);
          setError(r.error);
        } else setResults(r.results ?? []);
      } catch {
        setError("Square couldn't be searched right now. Nothing was changed — please try again.");
      }
    });
  };

  const choose = (p: Pick) => {
    setPick(p);
    setCovers([client.id]);
    setConfirmed(false);
    setError(null);
  };

  const link = () => {
    if (!pick || !confirmed) return;
    const fd = new FormData();
    fd.set("confirmMatch", "on");
    covers.forEach((id) => fd.append("clientIds", id));
    setError(null);
    startLink(async () => {
      try {
        const r = await linkSquareBillingAction(pick.customer.id, pick.series.seriesKey, null, fd);
        if (r?.error) setError(r.error);
        else {
          setDone(r?.ok ?? "Linked.");
          setPick(null);
          setResults(null);
          router.refresh();
        }
      } catch {
        setError("Square couldn't be reached, so nothing was linked. Please try again.");
      }
    });
  };

  if (!open) {
    return (
      <>
        <Button type="button" variant="secondary" onClick={() => setOpen(true)} data-testid="connect-square">Find and link in Square</Button>
        {done && <p className="w-full text-sm text-emerald-800" role="status" data-testid="square-link-done">✓ {done}</p>}
      </>
    );
  }

  return (
    <div className="w-full space-y-3 rounded-xl border border-gold-300 bg-ivory-50 p-3 text-sm" data-testid="square-find">
      <div className="flex items-center justify-between gap-2">
        <strong>Find {client.name} in Square</strong>
        <button type="button" className="text-xs underline" onClick={() => setOpen(false)}>Close</button>
      </div>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          search();
        }}
      >
        <label className="flex-1">
          <span className="block text-xs font-semibold text-slate-600">Name, email, phone, Square customer ID, or recurring series number (e.g. 54458)</span>
          <input className="input w-full" value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" data-testid="square-query" />
        </label>
        <Button type="submit" disabled={searching}>{searching ? "Searching…" : "Search Square (read only)"}</Button>
      </form>
      <p className="text-xs text-slate-600">Searching only reads from Square. Nothing is created, charged or changed there.</p>
      {error && <p className="text-red-700" role="alert" data-testid="square-find-error">{error}</p>}
      {results && results.length === 0 && <p data-testid="square-none">No Square customer matched “{query}”. Try their email, phone, another spelling, or the customer ID from the Square Dashboard.</p>}

      {suggested && results && !pick && (
        <p className={`rounded p-2 ${suggested.confident ? "bg-emerald-50 text-emerald-900" : "bg-amber-50 text-amber-900"}`} data-testid="square-suggest-summary">
          {results.length === 0
            ? "Searched Square automatically with this client's saved name, business name, email and phone — no match. Try another spelling or the series number from the Square Dashboard."
            : suggested.confident
              ? "Likely match found automatically (email or phone matches). Review it and confirm — nothing is linked until you do."
              : `Searched automatically: ${results.length} possible match${results.length === 1 ? "" : "es"}, none certain. Choose the right customer for owner review.`}
        </p>
      )}
      {results && results.length > 0 && !pick && (
        <ul className="space-y-2" data-testid="square-find-results">
          {results.map((c) => (
            <li key={c.id} className={`rounded-lg border bg-white p-3 ${suggested?.confident === c.id ? "border-emerald-400" : "border-ivory-200"}`} data-likely={suggested?.confident === c.id ? "yes" : undefined}>
              <p>
                <strong>{c.company || c.name || "Square customer"}</strong>
                {c.company && c.name ? ` · ${c.name}` : ""}
                {c.email ? ` · ${c.email}` : ""}
                {c.phone ? ` · ${c.phone}` : ""}
                <span className="ml-1 text-xs text-slate-500">(Square customer ID {c.id})</span>
              </p>
              {c.reasons && c.reasons.length > 0 && (
                <p className="mt-1 flex flex-wrap gap-1">{c.reasons.map((r) => <Badge key={r} tone={r.startsWith("different") ? "amber" : "green"}>{r}</Badge>)}</p>
              )}
              {c.review.length > 0 && (
                <div className="mt-2 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-950" data-testid="square-review-series">
                  <p className="font-semibold">Status needs review — not offered for linking ({c.review.length})</p>
                  <ul className="mt-1 space-y-2">
                    {c.review.map((e) => (
                      <li key={e.seriesKey} data-review-series={e.seriesKey}>
                        <Badge tone="amber">Needs review</Badge> <strong>Series {e.seriesKey}</strong>{e.matched ? " (the series you searched)" : ""} · {e.title || "Recurring invoice"} · {usd(e.amountCents)} · {e.schedule}{e.lastDueDate ? ` · last invoice due ${fmtDay(e.lastDueDate)}` : ""}
                        <span className="block">{e.reason} Square&apos;s API has no series status, so this needs your decision.</span>
                        {owner ? <ReviewSeries customerId={c.id} seriesKey={e.seriesKey} onDone={() => search()} /> : <span className="block italic">Tabitha reviews this series.</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {c.ended.length > 0 && (
                <details className="mt-2 text-xs text-slate-600" data-testid="square-ended-series" open={c.ended.some((e) => e.matched)}>
                  <summary className="cursor-pointer">{c.ended.length} ended series — history only, can&apos;t be linked</summary>
                  <ul className="mt-1 space-y-1">
                    {c.ended.map((e) => (
                      <li key={e.seriesKey} data-ended-series={e.seriesKey}>
                        <Badge tone="gray">Ended</Badge> <strong>Series {e.seriesKey}</strong>{e.matched ? " (the series you searched)" : ""} · {e.title || "Recurring invoice"} · {usd(e.amountCents)} · {e.schedule}{e.lastDueDate ? ` · last invoice due ${fmtDay(e.lastDueDate)}` : ""}
                        <span className="block">{e.decision ? `Marked ended by Tabitha on ${fmtDay(e.decision.decidedAt)}: ${e.decision.reason}` : e.reason}</span>
                        {owner && <ReviewSeries customerId={c.id} seriesKey={e.seriesKey} onDone={() => search()} correction />}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {c.series.length === 0 ? (
                <p className="mt-1 text-slate-600">{c.ended.length ? "No active recurring series in Square for this customer." : "No recurring invoices found in Square for this customer."}</p>
              ) : (
                <div className="mt-3 grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
                  <div className="space-y-4">
                    {c.series.map((s) => (
                      <div key={s.seriesKey} data-testid="square-find-series" data-series={s.seriesKey}>
                        <span className="relative z-10 ml-4 inline-block rounded-t-lg bg-gradient-to-b from-gold-300 to-gold-500 px-4 py-1 text-sm font-bold text-navy-950 shadow-sm">Active Recurring Billing</span>
                        <div className="overflow-hidden rounded-2xl border-2 border-gold-500 bg-gradient-to-br from-navy-950 to-navy-900 text-white shadow-lg">
                          <div className="flex flex-wrap items-start justify-between gap-3 p-5">
                            <div className="flex gap-4">
                              <span aria-hidden className="hidden size-16 shrink-0 place-items-center rounded-full border-2 border-gold-500/70 text-gold-300 sm:grid"><CalendarDays className="size-8" /></span>
                              <div>
                                <p className="text-xl font-bold">Series {s.seriesKey}</p>
                                <p className="text-sm text-slate-200">{s.title || "Recurring invoice"}</p>
                                <p className="mt-1 font-serif text-4xl font-bold text-gold-300">{usd(s.amountCents)}</p>
                                <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-100">
                                  <span className="inline-flex items-center gap-1.5"><Repeat aria-hidden className="size-4" />{CADENCE[s.cadence] ?? "Recurring"}</span>
                                  {s.dueDay && <><span aria-hidden className="text-white/30">|</span><span className="inline-flex items-center gap-1.5"><CalendarDays aria-hidden className="size-4" />Due on the {ordinal(s.dueDay)}</span></>}
                                  <span aria-hidden className="text-white/30">|</span>
                                  <span className="inline-flex items-center gap-1.5"><CreditCard aria-hidden className="size-4" />{s.autopay ? "Card on File" : "Client pays each invoice"}</span>
                                </p>
                              </div>
                            </div>
                            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-400 bg-emerald-500/15 px-3 py-1 text-sm font-semibold text-emerald-300"><Check aria-hidden className="size-4" /> Active</span>
                          </div>
                          <div className="grid divide-y divide-white/15 border-t border-white/15 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
                            <div className="flex gap-3 p-4"><CalendarClock aria-hidden className="mt-0.5 size-6 shrink-0 text-gold-300" /><div><p className="text-sm text-slate-300">Next Invoice</p><p className="text-lg font-bold">{s.nextDueDate ? fmtDay(s.nextDueDate) : "None scheduled"}</p>{s.nextDueDate && <p className="text-sm text-slate-200">{usd(s.amountCents)}{s.autopay ? " · auto-pay" : ""}</p>}</div></div>
                            <div className="flex gap-3 p-4"><CircleCheck aria-hidden className="mt-0.5 size-6 shrink-0 text-gold-300" /><div><p className="text-sm text-slate-300">Status</p><p className={`text-lg font-bold ${s.statusTone === "green" ? "text-emerald-300" : s.statusTone === "red" ? "text-red-300" : "text-gold-300"}`}>{s.status}</p></div></div>
                            <div className="flex gap-3 p-4"><Receipt aria-hidden className="mt-0.5 size-6 shrink-0 text-gold-300" /><div><p className="text-sm text-slate-300">Last Payment</p><p className="text-lg font-bold">{s.lastPaidDate ? fmtDay(s.lastPaidDate) : "—"}</p>{s.lastPaidDate && <p className="text-sm text-slate-200">{usd(s.lastPaidCents)}</p>}</div></div>
                          </div>
                          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/15 bg-navy-950/60 px-5 py-3">
                            {s.linkedTo.length > 0 ? (
                              <span className="text-sm text-gold-300">Already linked to {s.linkedTo.join(", ")}</span>
                            ) : (
                              <>
                                <span className="text-xs text-slate-300">From Square, read only. Nothing is linked until you confirm.</span>
                                <Button type="button" variant="gold" className="rounded-xl" onClick={() => choose({ customer: c, series: s })}>Review this match</Button>
                              </>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="h-fit rounded-2xl border border-ivory-200 bg-white p-5 shadow-sm" data-testid="square-find-customer">
                    <div className="flex items-center justify-between gap-2">
                      <p className="flex items-center gap-2 text-lg font-bold text-navy-900"><span aria-hidden className="grid size-7 place-items-center rounded-md bg-navy-950"><span className="size-3.5 rounded-[2px] border-2 border-white" /></span> Square Customer</p>
                      {suggested?.confident === c.id && <Badge tone="green">Likely match</Badge>}
                    </div>
                    <p className="mt-3 text-lg font-bold text-navy-900">{c.company || c.name || "Square customer"}</p>
                    {c.company && c.name && <p className="text-sm text-slate-700">{c.name}</p>}
                    <p className="text-sm">Customer ID: {c.id}</p>
                    {c.email && <p className="text-sm text-slate-600">{c.email}</p>}
                    {c.phone && <p className="text-sm text-slate-600">{c.phone}</p>}
                    <ul className="mt-3 space-y-1.5 text-sm">
                      <Tick ok={c.series.length > 0}>Recurring Billing Active</Tick>
                      <Tick ok={c.series.some((x) => x.autopay)}>Card on File</Tick>
                      <Tick ok={c.series.some((x) => x.autopay)}>Auto-Pay Enabled</Tick>
                    </ul>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {pick && (
        <div className="space-y-3 rounded-lg border border-navy-200 bg-white p-3" data-testid="square-review">
          <p className="font-semibold">Review the match before linking</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-500">In Square</p>
              <p><strong>{pick.customer.company || pick.customer.name || "Square customer"}</strong>{pick.customer.company && pick.customer.name ? ` · ${pick.customer.name}` : ""}</p>
              <p>Email: {pick.customer.email ?? "—"} {same(pick.customer.email, client.email, lower) && <Badge tone="green">Matches</Badge>}</p>
              <p>Phone: {pick.customer.phone ?? "—"} {same(pick.customer.phone, client.phone, digits) && <Badge tone="green">Matches</Badge>}</p>
              <p className="text-xs text-slate-500">Square customer ID: {pick.customer.id}</p>
              <p className="text-xs text-slate-500">Recurring invoice series: {pick.series.seriesKey} (invoice numbers {pick.series.seriesKey}-R-…)</p>
              <p className="mt-2">
                {pick.series.title || "Recurring invoice"} (series {pick.series.seriesKey}-R): {usd(pick.series.amountCents)} · {pick.series.schedule}
                {" · "}{pick.series.nextDueDate ? `next invoice ${fmtDay(pick.series.nextDueDate)}` : "no upcoming invoice"}
                {" · "}{pick.series.autopay ? "charged automatically to the card on file in Square" : "client pays each invoice"}
                {" · "}<Badge tone={pick.series.statusTone as Tone}>{pick.series.status}</Badge>
              </p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-500">In Client Connect</p>
              <p><strong>{client.name}</strong></p>
              <p>Email: {client.email ?? "—"}</p>
              <p>Phone: {client.phone ?? "—"}</p>
            </div>
          </div>
          {!same(pick.customer.email, client.email, lower) && !same(pick.customer.phone, client.phone, digits) && (
            <p className="rounded bg-amber-50 p-2 text-amber-900">Neither the email nor the phone matches this client&apos;s record. Make sure this is the right Square customer before linking.</p>
          )}
          {coverOptions.length > 1 && (
            <fieldset>
              <legend className="mb-1 font-semibold">This one Square bill covers</legend>
              {coverOptions.map((o) => (
                <label key={o.id} className="mr-4 inline-flex items-center gap-2">
                  <input type="checkbox" checked={covers.includes(o.id)} onChange={(e) => setCovers((c) => (e.target.checked ? [...c, o.id] : c.filter((x) => x !== o.id)))} /> {o.name}
                </label>
              ))}
              <p className="text-xs text-slate-600">Only this owner&apos;s own records are listed. Each record can be on only one Square bill, so nothing is billed twice.</p>
            </fieldset>
          )}
          <label className="flex items-start gap-2">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} data-testid="square-confirm" />
            <span>I confirm this Square customer is {client.name}. Link the existing billing; nothing will be charged, invoiced or changed in Square.</span>
          </label>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={link} disabled={!confirmed || covers.length === 0 || linking} data-testid="square-link">{linking ? "Linking…" : "Link this Square customer"}</Button>
            <Button type="button" variant="ghost" onClick={() => setPick(null)}>Back to results</Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Owner only: settle a series' status (Active / Ended) with a reason. Nothing is changed in Square. */
function ReviewSeries({ customerId, seriesKey, onDone, correction = false }: { customerId: string; seriesKey: string; onDone: () => void; correction?: boolean }) {
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<{ ok?: string; error?: string } | null>(null);
  const [pending, start] = useTransition();
  const decide = (decision: "ACTIVE" | "ENDED") => {
    const fd = new FormData();
    fd.set("reason", reason);
    start(async () => {
      const r = await reviewSquareSeriesAction(customerId, seriesKey, decision, null, fd);
      setMsg(r?.error ? { error: r.error } : { ok: r?.ok ?? "Saved." });
      if (!r?.error) onDone();
    });
  };
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2" data-testid={`review-${seriesKey}`}>
      <input className="input w-72 text-xs" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={correction ? "Why correct it? (required)" : "Why? e.g. Replaced by the monthly series"} aria-label={`Reason for series ${seriesKey}`} />
      {!correction && <Button type="button" variant="secondary" disabled={pending} onClick={() => decide("ENDED")}>Mark ended (historical)</Button>}
      <Button type="button" variant="ghost" disabled={pending} onClick={() => decide("ACTIVE")}>{correction ? "Correct: mark active" : "Mark active"}</Button>
      {msg?.error && <span className="text-red-700" role="alert">{msg.error}</span>}
      {msg?.ok && <span className="text-emerald-800" role="status">{msg.ok}</span>}
    </div>
  );
}
