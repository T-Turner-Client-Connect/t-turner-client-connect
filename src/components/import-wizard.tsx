"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Papa from "papaparse";
import { ShieldAlert } from "lucide-react";
import { Badge, Button, Field, Notice } from "@/components/ui";
import { guessField, IMPORT_FIELDS, isSensitiveHeader, MAX_IMPORT_ROWS, type ImportField } from "@/lib/import/fields";
import { stageImportAction } from "@/app/actions/imports";

// Mirrors BATCH_SERVICES on the server (which re-checks the choice).
const BATCH_SERVICE_OPTIONS = ["Tax Preparation", "Bookkeeping", "Payroll", "Business Tax Preparation", "Nonprofit Services", "Consulting"];

type Sheet = { fileName: string; headers: string[]; rows: string[][] };

function cellToString(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).trim();
}

async function readFile(file: File): Promise<Sheet> {
  let grid: string[][];
  if (/\.xlsx$/i.test(file.name)) {
    const { readSheet } = await import("read-excel-file/browser");
    const data = await readSheet(file);
    grid = data.map((row) => row.map(cellToString));
  } else if (/\.csv$/i.test(file.name) || file.type === "text/csv") {
    const text = await file.text();
    const parsed = Papa.parse<string[]>(text, { skipEmptyLines: "greedy" });
    grid = parsed.data.map((row) => row.map(cellToString));
  } else {
    throw new Error("Choose a .csv or .xlsx file. (Older .xls files: open in Excel and save as .xlsx.)");
  }
  const [headerRow, ...rows] = grid.filter((r) => r.some((c) => c !== ""));
  if (!headerRow) throw new Error("The file is empty.");
  const headers = headerRow.map((h, i) => h || `Column ${i + 1}`);
  return { fileName: file.name, headers, rows };
}

export function ImportWizard({ staff = [], groups = [] }: { staff?: { id: string; name: string }[]; groups?: { id: string; name: string }[] }) {
  const router = useRouter();
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [mapping, setMapping] = useState<Record<number, ImportField | "">>({});
  const [source, setSource] = useState("TaxAct");
  const [taxDerived, setTaxDerived] = useState(true);
  const [batchService, setBatchService] = useState("");
  const [assignTo, setAssignTo] = useState("");
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [taxYear, setTaxYear] = useState(String(new Date().getFullYear() - 1));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onFile(file: File | undefined) {
    setError(null);
    setSheet(null);
    if (!file) return;
    try {
      const s = await readFile(file);
      if (s.rows.length > MAX_IMPORT_ROWS) throw new Error(`This file has ${s.rows.length} rows. Split it into files of ${MAX_IMPORT_ROWS} rows or fewer.`);
      const guessed: Record<number, ImportField | ""> = {};
      const used = new Set<string>();
      s.headers.forEach((h, i) => {
        const g = guessField(h);
        guessed[i] = g && !used.has(g) ? g : "";
        if (g) used.add(g);
      });
      setMapping(guessed);
      setSheet(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That file couldn't be read.");
    }
  }

  const duplicateFields = useMemo(() => {
    const counts = new Map<string, number>();
    Object.values(mapping).forEach((f) => f && counts.set(f, (counts.get(f) ?? 0) + 1));
    return [...counts].filter(([, n]) => n > 1).map(([f]) => IMPORT_FIELDS[f as ImportField]);
  }, [mapping]);

  const mappedCols = sheet ? sheet.headers.map((h, i) => ({ h, i, field: mapping[i] })).filter((c) => c.field && !isSensitiveHeader(c.h)) : [];

  const mappedSet = new Set(mappedCols.map((c) => c.field));
  const needsYear = /tax/i.test(batchService) || mappedSet.has("returnType") || mappedSet.has("filingStatus");
  const unmapped = sheet ? sheet.headers.filter((h, i) => !mapping[i] && !isSensitiveHeader(h)) : [];

  function buildRows() {
    return sheet!.rows.map((r) => Object.fromEntries(mappedCols.map((c) => [c.field, r[c.i] ?? ""])));
  }

  async function submit() {
    if (!sheet) return;
    setBusy(true);
    setError(null);
    const result = await stageImportAction({
      fileName: sheet.fileName,
      source,
      taxReturnDerived: taxDerived,
      mapping: Object.fromEntries(mappedCols.map((c) => [c.h, c.field as string])),
      rows: buildRows(),
      headers: sheet.headers,
      batchService: batchService || null,
      batchAssignedToId: assignTo || null,
      batchGroupIds: groupIds,
      taxYear: needsYear ? Number(taxYear) : null,
    });
    if (result?.batchId) {
      setSheet(null); // drop the parsed file from memory
      router.push(`/imports/${result.batchId}`);
    } else {
      setError(result?.error ?? "The import couldn't be prepared.");
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <section className="space-y-3 rounded-xl border border-navy-100 bg-white p-4 sm:p-5">
        <h2 className="text-lg font-semibold">1. Choose the export file</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Spreadsheet (.csv or .xlsx)" hint="It's read in your browser. Only the columns you map below are sent to the CRM; the file itself is never uploaded or stored.">
            <input className="input" type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(e) => onFile(e.target.files?.[0])} />
          </Field>
          <Field label="Source" hint="Recorded with the import, e.g. TaxAct 2025 client list.">
            <input className="input" value={source} onChange={(e) => setSource(e.target.value)} maxLength={100} />
          </Field>
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1 size-4 accent-navy-900" checked={taxDerived} onChange={(e) => setTaxDerived(e.target.checked)} />
          <span>These contacts came from tax-preparation software or tax-return work. <span className="text-slate-600">(Marks them as tax-derived, so promotions require a reviewed Section 7216 consent.)</span></span>
        </label>
        {error && <Notice tone="error">{error}</Notice>}
      </section>

      {sheet && (
        <>
          <section className="space-y-3 rounded-xl border border-navy-100 bg-white p-4 sm:p-5">
            <h2 className="text-lg font-semibold">2. Match columns to CRM fields</h2>
            <p className="text-sm text-slate-600">
              {sheet.rows.length} data row{sheet.rows.length === 1 ? "" : "s"} in <strong>{sheet.fileName}</strong>. Columns set to &quot;Don&apos;t import&quot; are discarded.
            </p>
            <Notice tone="warn" title="Never imported">SSNs, taxpayer IDs, birth dates, income, bank details, dependents and return figures are blocked automatically. Only the return type / filing status and tax year are read, to open the right tax-preparation case.</Notice>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead><tr className="text-left text-slate-600"><th className="py-2 pr-3">Column in file</th><th className="py-2 pr-3">Sample</th><th className="py-2">CRM field</th></tr></thead>
                <tbody className="divide-y divide-navy-100">
                  {sheet.headers.map((h, i) => {
                    const blocked = isSensitiveHeader(h);
                    const sample = blocked ? "hidden" : sheet.rows.map((r) => r[i]).filter(Boolean).slice(0, 2).join(" · ");
                    return (
                      <tr key={i} className={blocked ? "bg-red-50/60" : ""}>
                        <td className="py-2 pr-3 font-medium">{h}</td>
                        <td className="max-w-[16rem] truncate py-2 pr-3 text-slate-600">{sample}</td>
                        <td className="py-2">
                          {blocked ? (
                            <span className="inline-flex items-center gap-1 text-red-800"><ShieldAlert className="size-4" aria-hidden /> Blocked — sensitive</span>
                          ) : (
                            <select
                              className="input"
                              aria-label={`CRM field for ${h}`}
                              value={mapping[i] ?? ""}
                              onChange={(e) => setMapping({ ...mapping, [i]: e.target.value as ImportField | "" })}
                            >
                              <option value="">Don&apos;t import</option>
                              {Object.entries(IMPORT_FIELDS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                            </select>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {duplicateFields.length > 0 && <Notice tone="error">Each CRM field can only come from one column: {duplicateFields.join(", ")}.</Notice>}
          </section>

          <section className="space-y-3 rounded-xl border border-navy-100 bg-white p-4 sm:p-5">
            <h2 className="text-lg font-semibold">3. Options for every client in this file</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Service for all selected clients" hint="Added to each created or updated client. Choosing Tax Preparation does not add Bookkeeping.">
                <select className="input" value={batchService} onChange={(e) => setBatchService(e.target.value)} aria-label="Service for all selected clients">
                  <option value="">No service — keep what each row says</option>
                  {BATCH_SERVICE_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </Field>
              <Field label="Assign every client to" hint="Fills the assigned staff member where it's blank. If someone else is already assigned, you'll see it in the comparison and can approve the change.">
                <select className="input" value={assignTo} onChange={(e) => setAssignTo(e.target.value)} aria-label="Assign every client to">
                  <option value="">Don&apos;t change assignments</option>
                  {staff.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </Field>
              {groups.length > 0 && (
                <fieldset className="sm:col-span-2">
                  <legend className="mb-1 text-sm font-semibold text-navy-900">Add every client to these groups</legend>
                  <div className="grid gap-1 sm:grid-cols-2">
                    {groups.map((g) => (
                      <label key={g.id} className="flex items-center gap-2 text-sm">
                        <input type="checkbox" className="accent-navy-900" checked={groupIds.includes(g.id)} onChange={(e) => setGroupIds(e.target.checked ? [...groupIds, g.id] : groupIds.filter((x) => x !== g.id))} /> {g.name}
                      </label>
                    ))}
                  </div>
                  <p className="mt-1 text-xs text-slate-600">Groups are only added, never removed. Choosing Tax Preparation never adds Bookkeeping.</p>
                </fieldset>
              )}
              {needsYear && (
                <Field label="Tax year (required)" hint="Each client gets one tax-preparation case for this year. Return type / filing status from the file is prefilled; otherwise staff select it.">
                  <input className="input" inputMode="numeric" value={taxYear} onChange={(e) => setTaxYear(e.target.value)} aria-label="Tax year" required />
                </Field>
              )}
            </div>
            {unmapped.length > 0 && (
              <p className="text-sm text-slate-600">Not imported (no CRM field chosen): {unmapped.join(", ")}</p>
            )}
          </section>

          <section className="space-y-3 rounded-xl border border-navy-100 bg-white p-4 sm:p-5">
            <h2 className="text-lg font-semibold">4. Preview</h2>
            {mappedCols.length === 0 ? (
              <p className="text-sm text-slate-600">Map at least one column to see a preview.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-slate-600">{mappedCols.map((c) => <th key={c.i} className="py-2 pr-3">{IMPORT_FIELDS[c.field as ImportField]}</th>)}</tr></thead>
                  <tbody className="divide-y divide-navy-100">
                    {sheet.rows.slice(0, 8).map((r, ri) => (
                      <tr key={ri}>{mappedCols.map((c) => <td key={c.i} className="py-1.5 pr-3">{r[c.i]}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
                {sheet.rows.length > 8 && <p className="mt-2 text-xs text-slate-600">…and {sheet.rows.length - 8} more rows.</p>}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={submit} disabled={busy || mappedCols.length === 0 || duplicateFields.length > 0}>
                {busy ? "Checking rows…" : "Check for errors & duplicates"}
              </Button>
              <Badge tone="gray">Nothing is saved to client records until you confirm on the next screen.</Badge>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
