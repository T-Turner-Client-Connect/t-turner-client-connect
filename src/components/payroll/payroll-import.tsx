"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Field, Notice } from "@/components/ui";
import { actionFailureMessage } from "@/components/action-form";
import { importPayrollAction, previewPayrollAction, type PreviewResult } from "@/app/actions/payroll";
import { PAYROLL_FIELDS, PAYROLL_PRESETS, type PayrollField } from "@/lib/payroll/fields";

type Preview = NonNullable<PreviewResult["data"]>;
const money = (c: number) => `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/**
 * Payroll register import: choose the file and the provider preset, check the column mapping
 * (change any column by hand), preview totals per pay date, then create DRAFT pay runs.
 * Nothing is saved until "Create draft pay runs".
 */
export function PayrollImport({ clientId, defaultPreset, bankAccounts }: { clientId: string; defaultPreset: string; bankAccounts: { id: string; label: string }[] }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preset, setPreset] = useState(defaultPreset);
  const [defaultCheckDate, setDefaultCheckDate] = useState("");
  const [cash, setCash] = useState(bankAccounts[0]?.id ?? "");
  const [processed, setProcessed] = useState(true);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mapping, setMapping] = useState<Record<number, PayrollField | "">>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const form = (m?: Record<number, PayrollField | "">) => {
    const fd = new FormData();
    if (file) fd.set("file", file);
    fd.set("preset", preset);
    if (defaultCheckDate) fd.set("defaultCheckDate", defaultCheckDate);
    if (m) fd.set("mapping", JSON.stringify(m));
    if (preview) fd.set("headerRow", String(preview.headerRow));
    return fd;
  };

  async function runPreview(m?: Record<number, PayrollField | "">) {
    if (!file) return setError("Choose the payroll register file first.");
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const r = await previewPayrollAction(clientId, form(m));
      if (r.error) {
        setError(r.error);
        setPreview(null);
      } else if (r.data) {
        setPreview(r.data);
        setMapping(r.data.mapping);
        if (r.data.error) setError(r.data.error);
      }
    } catch (e) {
      setError(actionFailureMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function runImport() {
    setBusy(true);
    setError(null);
    try {
      const fd = form(mapping);
      if (cash) fd.set("cashAccountId", cash);
      if (processed) fd.set("alreadyProcessed", "on");
      const r = await importPayrollAction(clientId, null, fd);
      if (r?.error) setError(r.error);
      else {
        setDone(r?.ok ?? "Imported.");
        setPreview(null);
        setFile(null);
        if (fileRef.current) fileRef.current.value = "";
        router.refresh();
      }
    } catch (e) {
      setError(actionFailureMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const ready = preview && !preview.error && preview.payDates.some((p) => p.differenceCents === 0 && !p.duplicate);
  return (
    <div className="space-y-4" data-testid="payroll-import">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Payroll register (CSV or .xlsx)">
          <input ref={fileRef} type="file" accept=".csv,.xlsx,text/csv" className="input" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPreview(null); }} />
        </Field>
        <Field label="Layout">
          <select className="input" value={preset} onChange={(e) => setPreset(e.target.value)}>
            {Object.entries(PAYROLL_PRESETS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        <Field label="Check date (only if the file has no date column)">
          <input type="date" className="input" value={defaultCheckDate} onChange={(e) => setDefaultCheckDate(e.target.value)} />
        </Field>
        <div className="flex items-end"><Button type="button" variant="secondary" disabled={busy || !file} onClick={() => runPreview()}>{busy ? "Reading…" : "Preview"}</Button></div>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {done && <Notice tone="success">{done}</Notice>}
      {preview && (
        <>
          <details className="rounded-lg border border-navy-100 bg-white p-3" open={!!preview.error}>
            <summary className="cursor-pointer text-sm font-semibold text-navy-900">Column mapping ({Object.values(mapping).filter(Boolean).length} of {preview.headers.length} columns used) — change any column, then preview again</summary>
            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {preview.headers.map((h, i) => (
                <label key={i} className="flex items-center justify-between gap-2 text-sm">
                  <span className="truncate font-medium text-navy-900" title={h}>{h}</span>
                  <select className="input max-w-[14rem] py-1 text-xs" value={mapping[i] ?? ""} onChange={(e) => setMapping({ ...mapping, [i]: e.target.value as PayrollField | "" })}>
                    <option value="">Ignore</option>
                    {Object.entries(PAYROLL_FIELDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </label>
              ))}
            </div>
            <Button type="button" variant="secondary" className="mt-3" disabled={busy} onClick={() => runPreview(mapping)}>Preview with this mapping</Button>
          </details>
          {!!preview.payDates.length && (
            <div className="overflow-x-auto rounded-lg border border-navy-100 bg-white" data-testid="import-preview">
              <table className="w-full min-w-[56rem] text-sm">
                <thead className="bg-navy-50 text-left text-xs uppercase tracking-wide text-navy-800">
                  <tr><th className="px-3 py-2">Check date</th><th className="px-3 py-2 text-right">Employees</th><th className="px-3 py-2 text-right">Gross wages</th><th className="px-3 py-2 text-right">Employee taxes</th><th className="px-3 py-2 text-right">Deductions</th><th className="px-3 py-2 text-right">Net pay</th><th className="px-3 py-2 text-right">Employer taxes</th><th className="px-3 py-2 text-right">Total cost</th><th className="px-3 py-2">Check</th></tr>
                </thead>
                <tbody>
                  {preview.payDates.map((p) => {
                    const ee = p.federalWhCents + p.ssEeCents + p.medicareEeCents + p.stateWhCents + p.otherEeTaxCents;
                    return (
                      <tr key={p.checkDate} className="border-t border-navy-100">
                        <td className="px-3 py-2 font-semibold text-navy-900">{day(p.checkDate)}</td>
                        <td className="px-3 py-2 text-right">{p.employees}</td>
                        <td className="px-3 py-2 text-right">{money(p.grossCents)}</td>
                        <td className="px-3 py-2 text-right" title={`Federal ${money(p.federalWhCents)} · SS ${money(p.ssEeCents)} · Medicare ${money(p.medicareEeCents)} · State ${money(p.stateWhCents)} · Other ${money(p.otherEeTaxCents)}`}>{money(ee)}</td>
                        <td className="px-3 py-2 text-right">{money(p.deductionsCents)}</td>
                        <td className="px-3 py-2 text-right">{money(p.netPayCents)}</td>
                        <td className="px-3 py-2 text-right">{money(p.employerTaxCents)}</td>
                        <td className="px-3 py-2 text-right font-semibold">{money(p.grossCents + p.employerTaxCents)}</td>
                        <td className="px-3 py-2">
                          {p.duplicate ? <span className="text-xs font-semibold text-slate-600">Already imported — skipped</span>
                            : p.differenceCents ? <span className="text-xs font-semibold text-red-700">Off by {money(p.differenceCents)} — not imported</span>
                            : <span className="text-xs font-semibold text-emerald-700">Ties out · draft entry balances{p.otherRunSameDate ? " · another run exists for this date" : ""}</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {!!preview.skipped.length && <p className="border-t border-navy-100 px-3 py-2 text-xs text-slate-600">Not counted: {preview.skipped.slice(0, 4).join("; ")}{preview.skipped.length > 4 ? ` and ${preview.skipped.length - 4} more` : ""}.</p>}
            </div>
          )}
          {ready && (
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Paid from (bank account for net pay)">
                <select className="input" value={cash} onChange={(e) => setCash(e.target.value)}>
                  {!bankAccounts.length && <option value="">Set up the books first</option>}
                  {bankAccounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                </select>
              </Field>
              <label className="flex items-center gap-2 pb-2 text-sm text-navy-900">
                <input type="checkbox" checked={processed} onChange={(e) => setProcessed(e.target.checked)} />
                Already processed and paid by the provider (a register of past payroll)
              </label>
              <Button type="button" disabled={busy} onClick={runImport}>Create draft pay runs</Button>
            </div>
          )}
          {ready && <p className="text-xs text-slate-600">{processed ? "Past payroll: runs are recorded as processed and their journal entries wait as drafts for you to post." : "Upcoming payroll: runs start as drafts for the office to review and send to the owners for approval."} Nothing is posted to the books automatically.</p>}
        </>
      )}
    </div>
  );
}
