"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button } from "@/components/ui";

type Tone = "navy" | "gold" | "green" | "red" | "gray" | "amber";
import { linkSquareBillingAction, squareSearchAction, type SquareSearchResult } from "@/app/actions/square-billing";

type Client = { id: string; name: string; email: string | null; phone: string | null };
type Option = { id: string; name: string };
type Pick = { customer: SquareSearchResult; series: SquareSearchResult["series"][number] };

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
export function SquareFindPanel({ client, coverOptions }: { client: Client; coverOptions: Option[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(client.email || client.name);
  const [results, setResults] = useState<SquareSearchResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState<Pick | null>(null);
  const [covers, setCovers] = useState<string[]>([client.id]);
  const [confirmed, setConfirmed] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [searching, startSearch] = useTransition();
  const [linking, startLink] = useTransition();

  const search = () => {
    setError(null);
    setPick(null);
    setDone(null);
    startSearch(async () => {
      try {
        const r = await squareSearchAction(query);
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
          <span className="block text-xs font-semibold text-slate-600">Name, email, phone or Square customer ID</span>
          <input className="input w-full" value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" data-testid="square-query" />
        </label>
        <Button type="submit" disabled={searching}>{searching ? "Searching…" : "Search Square (read only)"}</Button>
      </form>
      <p className="text-xs text-slate-600">Searching only reads from Square. Nothing is created, charged or changed there.</p>
      {error && <p className="text-red-700" role="alert" data-testid="square-find-error">{error}</p>}
      {results && results.length === 0 && <p data-testid="square-none">No Square customer matched “{query}”. Try their email, phone, another spelling, or the customer ID from the Square Dashboard.</p>}

      {results && results.length > 0 && !pick && (
        <ul className="space-y-2" data-testid="square-find-results">
          {results.map((c) => (
            <li key={c.id} className="rounded-lg border border-ivory-200 bg-white p-3">
              <p>
                <strong>{c.company || c.name || "Square customer"}</strong>
                {c.company && c.name ? ` · ${c.name}` : ""}
                {c.email ? ` · ${c.email}` : ""}
                {c.phone ? ` · ${c.phone}` : ""}
                <span className="ml-1 text-xs text-slate-500">({c.id})</span>
              </p>
              {c.series.length === 0 ? (
                <p className="mt-1 text-slate-600">No recurring invoices found in Square for this customer.</p>
              ) : (
                <ul className="mt-2 space-y-2">
                  {c.series.map((s) => (
                    <li key={s.seriesKey} className="flex flex-wrap items-center gap-2 rounded bg-ivory-50 p-2" data-testid="square-find-series">
                      <span>
                        {s.title || "Recurring invoice"} · {usd(s.amountCents)} · {s.schedule} · {s.nextDueDate ? `next ${fmtDay(s.nextDueDate)}` : "no upcoming invoice"} · {s.autopay ? "card on file charged by Square" : "client pays each invoice"}
                      </span>
                      <Badge tone={s.statusTone as Tone}>{s.status}</Badge>
                      {s.linkedTo.length > 0 ? (
                        <span className="text-amber-800">Already linked to {s.linkedTo.join(", ")}</span>
                      ) : (
                        <Button type="button" variant="ghost" onClick={() => choose({ customer: c, series: s })}>Review this match</Button>
                      )}
                    </li>
                  ))}
                </ul>
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
