"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FileSpreadsheet } from "lucide-react";
import { Button } from "@/components/ui";
import { importLinesAction, previewImportAction, type ImportPreview } from "@/app/actions/adp-revenue-share";
import { LINE_TYPES, LINE_TYPE_LABELS, fmtCents, type LineType } from "@/lib/adp-revenue-share";

type Col = string; // "" = not used, else the column index
type Mapping = { headerRow: boolean; amount: Col; type: Col; fixedType: "" | LineType; name: Col; note: Col };
const EMPTY: Mapping = { headerRow: true, amount: "", type: "", fixedType: "", name: "", note: "" };

const toServer = (m: Mapping) => ({ headerRow: m.headerRow, amount: m.amount === "" ? null : Number(m.amount), type: m.type === "" ? null : Number(m.type), fixedType: m.type === "" ? m.fixedType || null : null, name: m.name === "" ? null : Number(m.name), note: m.note === "" ? null : Number(m.note) });

/**
 * Import statement lines from a CSV. ADP publishes no fixed layout, so nothing is guessed: the
 * owner picks each column, previews every row, unticks any she doesn't want (e.g. a totals row),
 * links names to referrals herself, then confirms. The server re-reads the CSV with that mapping.
 */
export function AdpCsvImport({ statementId, referrals, final }: { statementId: string; referrals: { id: string; label: string }[]; final: boolean }) {
  const router = useRouter();
  const [csvText, setCsvText] = useState("");
  const [fileName, setFileName] = useState("");
  const [m, setM] = useState<Mapping>(EMPTY);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [excluded, setExcluded] = useState<number[]>([]);
  const [links, setLinks] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const load = (text: string, mapping: Mapping | null, ex: number[]) =>
    start(async () => {
      setError(null);
      const r = await previewImportAction({ csvText: text, mapping: mapping && mapping.amount !== "" ? toServer(mapping) : null, excluded: ex });
      if (r.ok) setPreview(r.preview);
      else setError(r.error);
    });

  const set = (k: keyof Mapping, v: string | boolean) => {
    const next = { ...m, [k]: v } as Mapping;
    setM(next);
    if (csvText) load(csvText, next, excluded);
  };
  const toggle = (row: number, include: boolean) => {
    const ex = include ? excluded.filter((x) => x !== row) : [...excluded, row];
    setExcluded(ex);
    load(csvText, m, ex);
  };

  const rows = preview?.rows ?? null;
  const included = rows?.filter((r) => r.include) ?? [];
  const names = [...new Set(included.map((r) => r.name).filter(Boolean))];
  const total = included.reduce((t, r) => t + (r.amountCents ?? 0), 0);
  const columnSelect = (k: "amount" | "type" | "name" | "note", label: string, optional: boolean) => (
    <label className="block text-sm">
      <span className="mb-1 block font-semibold text-navy-900">{label}</span>
      <select className="input" value={m[k]} onChange={(e) => set(k, e.target.value)} data-testid={`map-${k}`}>
        <option value="">{optional ? "— Not in the file —" : "— Choose a column —"}</option>
        {preview?.headers.map((h, i) => <option key={i} value={String(i)}>{h}</option>)}
      </select>
    </label>
  );

  return (
    <div className="space-y-4" data-testid="csv-import">
      <label className="block text-sm">
        <span className="mb-1 flex items-center gap-2 font-semibold text-navy-900"><FileSpreadsheet className="size-4 text-gold-600" aria-hidden /> CSV exported from ADP&apos;s partner portal</span>
        <input
          type="file"
          accept=".csv,text/csv"
          className="input"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            setDone(null);
            setPreview(null);
            setExcluded([]);
            setLinks({});
            setM(EMPTY);
            if (!f) return setCsvText("");
            if (f.size > 1_000_000) return setError("That CSV is larger than 1 MB. Export one statement at a time.");
            const text = await f.text();
            setCsvText(text);
            setFileName(f.name);
            load(text, null, []);
          }}
        />
      </label>

      {preview && (
        <>
          <div className="rounded-xl border border-ivory-200 p-3">
            <p className="mb-2 text-sm font-semibold text-navy-900">1. Match the columns (nothing is chosen for you)</p>
            <label className="mb-3 inline-flex items-center gap-2 text-sm"><input type="checkbox" className="size-4 accent-navy-900" checked={m.headerRow} onChange={(e) => set("headerRow", e.target.checked)} /> The first row is column headings</label>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {columnSelect("amount", "Amount (required)", false)}
              {columnSelect("type", "Line type", true)}
              {m.type === "" && (
                <label className="block text-sm">
                  <span className="mb-1 block font-semibold text-navy-900">Type for every line</span>
                  <select className="input" value={m.fixedType} onChange={(e) => set("fixedType", e.target.value)} data-testid="map-fixedType">
                    <option value="">— Choose —</option>
                    {LINE_TYPES.map((t) => <option key={t} value={t}>{LINE_TYPE_LABELS[t]}</option>)}
                  </select>
                </label>
              )}
              {columnSelect("name", "Client / business name", true)}
              {columnSelect("note", "Note", true)}
            </div>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-left text-xs">
                <caption className="mb-1 text-left text-slate-600">First rows of the file, as they are</caption>
                <thead><tr>{preview.headers.map((h, i) => <th key={i} className="border-b border-ivory-200 px-2 py-1 font-semibold">{h}</th>)}</tr></thead>
                <tbody>{preview.sample.map((r, i) => <tr key={i}>{preview.headers.map((_, j) => <td key={j} className="border-b border-ivory-100 px-2 py-1">{r[j] ?? ""}</td>)}</tr>)}</tbody>
              </table>
            </div>
          </div>

          {rows && (
            <div className="rounded-xl border border-ivory-200 p-3" data-testid="csv-preview">
              <p className="mb-2 text-sm font-semibold text-navy-900">2. Check every line ({included.length} ticked, {fmtCents(total)})</p>
              <div className="max-h-96 overflow-auto">
                <table className="w-full text-left text-sm">
                  <thead className="text-xs uppercase tracking-wide text-slate-600"><tr><th className="py-1 pr-2">Import</th><th className="py-1 pr-2">Row</th><th className="py-1 pr-2">Name</th><th className="py-1 pr-2">Type</th><th className="py-1 pr-2 text-right">Amount</th><th className="py-1">Note / problem</th></tr></thead>
                  <tbody className="divide-y divide-ivory-100">
                    {rows.map((r) => (
                      <tr key={r.rowNumber} className={r.error ? "bg-red-50/60" : r.include ? "" : "text-slate-500"}>
                        <td className="py-1 pr-2"><input type="checkbox" aria-label={`Import row ${r.rowNumber}`} className="size-4 accent-navy-900" disabled={!!r.error} checked={r.include} onChange={(e) => toggle(r.rowNumber, e.target.checked)} /></td>
                        <td className="py-1 pr-2">{r.rowNumber}</td>
                        <td className="py-1 pr-2">{r.name}</td>
                        <td className="py-1 pr-2">{r.type ? LINE_TYPE_LABELS[r.type] : ""}</td>
                        <td className="py-1 pr-2 text-right tabular-nums">{r.amountCents === null ? "" : fmtCents(r.amountCents)}</td>
                        <td className="py-1">{r.error ? <span className="font-semibold text-red-800">{r.error}</span> : r.note}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {rows && names.length > 0 && (
            <div className="rounded-xl border border-ivory-200 p-3">
              <p className="mb-1 text-sm font-semibold text-navy-900">3. Link names to referrals (optional)</p>
              <p className="mb-2 text-xs text-slate-600">Nothing is matched automatically. Leave a name unlinked and link its lines later.</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {names.map((n) => (
                  <label key={n} className="block text-sm">
                    <span className="mb-1 block text-navy-900">{n}</span>
                    <select className="input" value={links[n.toLowerCase()] ?? ""} onChange={(e) => setLinks({ ...links, [n.toLowerCase()]: e.target.value })}>
                      <option value="">— Not linked —</option>
                      {referrals.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                    </select>
                  </label>
                ))}
              </div>
            </div>
          )}

          {rows && (
            <div className="flex flex-wrap items-end gap-3">
              {final && (
                <label className="block min-w-64 flex-1 text-sm">
                  <span className="mb-1 block font-semibold text-navy-900">Revision note (required: this statement is Final)</span>
                  <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />
                </label>
              )}
              <Button
                type="button"
                disabled={pending || included.length === 0}
                data-testid="confirm-import"
                onClick={() =>
                  start(async () => {
                    setError(null);
                    const r = await importLinesAction(statementId, { csvText, mapping: toServer(m), excluded, links, reason, fileName });
                    if (r?.error) return setError(r.error);
                    setDone(r?.ok ?? "Imported.");
                    setPreview(null);
                    setCsvText("");
                    router.refresh();
                  })
                }
              >
                Confirm and import {included.length} line{included.length === 1 ? "" : "s"}
              </Button>
            </div>
          )}
        </>
      )}
      {error && <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm font-medium text-red-800">{error}</p>}
      {done && <p role="status" className="text-sm font-medium text-emerald-700">{done}</p>}
    </div>
  );
}
