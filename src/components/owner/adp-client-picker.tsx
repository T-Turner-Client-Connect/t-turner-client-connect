"use client";

import { useMemo, useState } from "react";
import { Search, X } from "lucide-react";

export type PickerClient = { id: string; name: string; person: string | null; email: string | null; phone: string | null };

/**
 * Client search (the same search-as-you-type as Create Invoice): name, email, phone or client
 * ID. Only existing clients can be chosen — nothing here creates a client. Submits `name`.
 */
export function AdpClientPicker({ clients, name = "clientId", defaultId = "", label = "Client", emptyHint, testId = "adp-client" }: { clients: PickerClient[]; name?: string; defaultId?: string; label?: string; emptyHint?: string; testId?: string }) {
  const [id, setId] = useState(defaultId);
  const [query, setQuery] = useState("");
  const chosen = clients.find((c) => c.id === id) ?? null;
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return clients.filter((c) => [c.name, c.person, c.email, c.phone, c.id].some((v) => v?.toLowerCase().includes(q))).slice(0, 8);
  }, [clients, query]);
  const inputId = `${testId}-search`;
  return (
    <div data-testid={testId}>
      <input type="hidden" name={name} value={id} />
      <span className="mb-1 block text-sm font-semibold text-navy-900">{label}</span>
      {chosen ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-gold-300 bg-white px-3 py-2" data-testid={`${testId}-selected`}>
          <span className="min-w-0">
            <span className="block font-semibold text-navy-900">{chosen.name}</span>
            {(chosen.person || chosen.email) && <span className="block text-xs text-slate-600">{[chosen.person, chosen.email].filter(Boolean).join(" · ")}</span>}
          </span>
          <button type="button" className="inline-flex items-center gap-1 text-sm font-semibold text-navy-900 underline decoration-gold-500 underline-offset-4" onClick={() => setId("")}>
            <X className="size-4" aria-hidden /> Change
          </button>
        </div>
      ) : (
        <>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-500" aria-hidden />
            <input id={inputId} aria-label={`${label}: search`} className="input pl-9" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name, email, phone or client ID" autoComplete="off" />
          </div>
          {query.trim() && (
            <ul className="mt-2 max-h-72 divide-y divide-ivory-200 overflow-auto rounded-xl border border-ivory-200 bg-white" role="listbox" aria-label="Matching clients">
              {matches.length === 0 ? (
                <li className="px-4 py-3 text-sm text-slate-600">{emptyHint ?? "No client matches. Clients are never created here."}</li>
              ) : (
                matches.map((c) => (
                  <li key={c.id}>
                    <button type="button" role="option" aria-selected={false} className="block w-full px-4 py-2.5 text-left hover:bg-gold-50" onClick={() => { setId(c.id); setQuery(""); }}>
                      <span className="block font-semibold text-navy-900">{c.name}</span>
                      <span className="block text-xs text-slate-600">{[c.person, c.email, c.phone].filter(Boolean).join(" · ")}</span>
                    </button>
                  </li>
                ))
              )}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
