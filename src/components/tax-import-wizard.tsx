"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Papa from "papaparse";
import { ShieldAlert } from "lucide-react";
import { Button, Field, Notice } from "@/components/ui";
import { isSensitiveHeader } from "@/lib/import/fields";
import { TAX_IMPORT_FIELDS, type TaxImportField } from "@/lib/tax/normalize";
import { stageTaxImportAction } from "@/app/actions/tax";

type Sheet = { fileName: string; headers: string[]; rows: string[][] };
const STATUSES = [
  ["ACCEPTED", "Accepted"],
  ["REJECTED", "Rejected"],
  ["PENDING_ACKNOWLEDGMENT", "Pending acknowledgment"],
  ["SUBMITTED", "Submitted"],
] as const;

const GUESS: [TaxImportField, RegExp][] = [
  ["clientRef", /client\s*(id|#|number)|account\s*id/i],
  ["displayName", /^(client|taxpayer)?\s*name$/i],
  ["taxYear", /tax\s*year|^year$/i],
  ["returnType", /return\s*type|form|^type$/i],
  ["jurisdiction", /jurisdiction|state|federal|agency/i],
  ["filingType", /filing\s*type|original|amend/i],
  ["status", /status/i],
  ["submittedAt", /submit|sent|transmit/i],
  ["statusDate", /ack|status\s*date|accepted\s*date|date/i],
  ["submissionId", /submission|dcn|reference/i],
  ["rejectionCodes", /reject.*code|error\s*code/i],
];

function blocked(h: string) {
  return isSensitiveHeader(h) && !/return\s*type|form/i.test(h);
}

async function read(file: File): Promise<Sheet> {
  let grid: string[][];
  if (/\.xlsx$/i.test(file.name)) {
    const { readSheet } = await import("read-excel-file/browser");
    grid = (await readSheet(file)).map((r) => r.map((c) => (c instanceof Date ? c.toISOString() : c == null ? "" : String(c).trim())));
  } else if (/\.(csv|txt)$/i.test(file.name)) {
    grid = Papa.parse<string[]>(await file.text(), { skipEmptyLines: "greedy" }).data.map((r) => r.map((c) => String(c ?? "").trim()));
  } else throw new Error("Choose the CSV (or .xlsx) you exported from TaxAct.");
  const [head, ...rows] = grid.filter((r) => r.some(Boolean));
  if (!head) throw new Error("The file is empty.");
  return { fileName: file.name, headers: head.map((h, i) => h || `Column ${i + 1}`), rows };
}

export function TaxImportWizard() {
  const router = useRouter();
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [mapping, setMapping] = useState<Record<number, TaxImportField | "">>({});
  const [filter, setFilter] = useState<string[]>(["ACCEPTED"]);
  const [source, setSource] = useState("TaxAct Professional — E-file Details report");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onFile(f?: File) {
    setError(null);
    setSheet(null);
    if (!f) return;
    try {
      const s = await read(f);
      const used = new Set<string>();
      const m: Record<number, TaxImportField | ""> = {};
      s.headers.forEach((h, i) => {
        const g = blocked(h) ? undefined : GUESS.find(([k, re]) => !used.has(k) && re.test(h))?.[0];
        m[i] = g ?? "";
        if (g) used.add(g);
      });
      setMapping(m);
      setSheet(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That file couldn't be read.");
    }
  }

  const cols = sheet ? sheet.headers.map((h, i) => ({ h, i, f: mapping[i] })).filter((c) => c.f && !blocked(c.h)) : [];
  const hasRef = cols.some((c) => c.f === "clientRef");
  const dupes = useMemo(() => {
    const seen = new Map<string, number>();
    Object.values(mapping).forEach((f) => f && seen.set(f, (seen.get(f) ?? 0) + 1));
    return [...seen].filter(([, n]) => n > 1).map(([f]) => f);
  }, [mapping]);

  async function submit() {
    if (!sheet) return;
    setBusy(true);
    const res = await stageTaxImportAction({
      fileName: sheet.fileName,
      source,
      statusFilter: filter as never,
      mapping: Object.fromEntries(cols.map((c) => [c.h, c.f as string])),
      rows: sheet.rows.map((r) => Object.fromEntries(cols.map((c) => [c.f, r[c.i] ?? ""]))),
    });
    if (res?.batchId) router.push(`/imports/tax/${res.batchId}`);
    else {
      setError(res?.error ?? "Couldn't prepare the import.");
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <section className="space-y-3 rounded-2xl border border-ivory-200 bg-white p-5">
        <h2 className="text-lg font-semibold">1. Choose the export</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="CSV or XLSX" hint="Read in your browser; only mapped columns are sent. SSN/EIN/DOB columns are blocked.">
            <input className="input" type="file" accept=".csv,.txt,.xlsx" onChange={(e) => onFile(e.target.files?.[0])} />
          </Field>
          <Field label="Source"><input className="input" value={source} onChange={(e) => setSource(e.target.value)} /></Field>
        </div>
        <fieldset>
          <legend className="mb-1 text-sm font-semibold text-navy-900">Which e-file statuses to bring in</legend>
          <div className="flex flex-wrap gap-3 text-sm">
            {STATUSES.map(([k, l]) => (
              <label key={k} className="flex items-center gap-2">
                <input type="checkbox" className="accent-navy-900" checked={filter.includes(k)} onChange={(e) => setFilter(e.target.checked ? [...filter, k] : filter.filter((x) => x !== k))} /> {l}
              </label>
            ))}
          </div>
          <p className="mt-1 text-xs text-slate-600">Other rows are shown in the preview as “not selected” and won&apos;t change anything.</p>
        </fieldset>
        {error && <Notice tone="error">{error}</Notice>}
      </section>
      {sheet && (
        <section className="space-y-3 rounded-2xl border border-ivory-200 bg-white p-5">
          <h2 className="text-lg font-semibold">2. Map columns</h2>
          <p className="text-sm text-slate-600">{sheet.rows.length} rows in {sheet.fileName}.</p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead><tr className="text-left text-slate-600"><th className="py-2 pr-3">Column</th><th className="py-2 pr-3">Sample</th><th className="py-2">Field</th></tr></thead>
              <tbody className="divide-y divide-ivory-200">
                {sheet.headers.map((h, i) => (
                  <tr key={i} className={blocked(h) ? "bg-red-50/60" : ""}>
                    <td className="py-2 pr-3 font-medium">{h}</td>
                    <td className="max-w-[14rem] truncate py-2 pr-3 text-slate-600">{blocked(h) ? "hidden" : sheet.rows.map((r) => r[i]).filter(Boolean).slice(0, 2).join(" · ")}</td>
                    <td className="py-2">
                      {blocked(h) ? (
                        <span className="inline-flex items-center gap-1 text-red-800"><ShieldAlert className="size-4" aria-hidden /> Blocked — sensitive</span>
                      ) : (
                        <select className="input" aria-label={`Field for ${h}`} value={mapping[i] ?? ""} onChange={(e) => setMapping({ ...mapping, [i]: e.target.value as TaxImportField | "" })}>
                          <option value="">Don&apos;t import</option>
                          {Object.entries(TAX_IMPORT_FIELDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                        </select>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!hasRef && <Notice tone="warn">Map the client ID column. Filings are never matched by name alone.</Notice>}
          {dupes.length > 0 && <Notice tone="error">Each field can come from one column only.</Notice>}
          <Button onClick={submit} disabled={busy || !hasRef || dupes.length > 0 || !filter.length}>{busy ? "Checking…" : "Preview matches"}</Button>
        </section>
      )}
    </div>
  );
}
