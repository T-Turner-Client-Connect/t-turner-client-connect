"use client";

import { useState } from "react";
import { ActionForm } from "@/components/action-form";
import { Button, Field } from "@/components/ui";
import { markMonthsPaidAction } from "@/app/actions/manual-billing";

type Methods = Record<string, string>;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Method select plus a Check # box that appears (and is required) when the method is Check. */
export function MethodFields({ methods, defaultMethod }: { methods: Methods; defaultMethod: string }) {
  const [method, setMethod] = useState(defaultMethod);
  return (
    <>
      <Field label="Method"><select className="input" name="method" value={method} onChange={(e) => setMethod(e.target.value)}>{Object.entries(methods).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
      <Field label={method === "CHECK" ? "Check #" : method === "SQUARE" ? "Square invoice # (optional)" : "Reference (optional)"}>
        <input className="input" name="reference" autoComplete="off" required={method === "CHECK"} placeholder={method === "CHECK" ? "e.g. 1042" : method === "SQUARE" ? "e.g. 54508" : ""} />
      </Field>
    </>
  );
}

/** Mark several months paid at once: choose a year, tick months (or the whole year), enter the amount once. */
export function MarkMonthsPaid({ clientId, feeCents, paidMonths, methods, defaultMethod, thisYear }: { clientId: string; feeCents: number; paidMonths: string[]; methods: Methods; defaultMethod: string; thisYear: number }) {
  const years = [thisYear, thisYear - 1, thisYear - 2, thisYear - 3].map(String);
  const [year, setYear] = useState(years[0]);
  const [picked, setPicked] = useState<string[]>([]);
  const [dateMode, setDateMode] = useState<"DUE_DATE" | "ONE_DATE">("DUE_DATE");
  const paid = new Set(paidMonths);
  const months = MONTHS.map((label, i) => ({ label, value: `${year}-${String(i + 1).padStart(2, "0")}` }));
  const unpaid = months.filter((m) => !paid.has(m.value)).map((m) => m.value);
  const toggle = (v: string) => setPicked((p) => (p.includes(v) ? p.filter((x) => x !== v) : [...p, v]));
  return (
    <ActionForm action={markMonthsPaidAction.bind(null, clientId)} className="mt-3 space-y-3" showSuccess resetOnSuccess>
      <div className="flex flex-wrap items-center gap-2">
        {years.map((y) => (
          <button key={y} type="button" onClick={() => setYear(y)} className={`rounded-full px-3 py-1 text-sm font-semibold ${y === year ? "bg-navy-950 text-gold-300" : "bg-ivory-50 text-navy-900 ring-1 ring-ivory-200"}`}>{y}</button>
        ))}
        <button type="button" className="ml-auto text-sm font-semibold text-navy-900 underline" onClick={() => setPicked((p) => [...new Set([...p.filter((x) => !x.startsWith(year)), ...unpaid])])} data-testid="select-whole-year">Whole year</button>
      </div>
      <div className="grid grid-cols-4 gap-2 sm:grid-cols-6" data-testid="month-grid">
        {months.map((m) => {
          const isPaid = paid.has(m.value);
          return (
            <label key={m.value} className={`flex cursor-pointer flex-col items-center rounded-lg border px-1 py-2 text-sm ${isPaid ? "cursor-not-allowed border-emerald-200 bg-emerald-50 text-emerald-800" : picked.includes(m.value) ? "border-gold-500 bg-gold-100" : "border-ivory-200 bg-white"}`}>
              <input type="checkbox" className="sr-only" name="months" value={m.value} disabled={isPaid} checked={picked.includes(m.value)} onChange={() => toggle(m.value)} />
              <span className="font-semibold">{m.label}</span>
              <span className="text-[11px]">{isPaid ? "Paid" : picked.includes(m.value) ? "✓ Selected" : "—"}</span>
            </label>
          );
        })}
      </div>
      {/* Selected months from other years stay selected */}
      {picked.filter((p) => !p.startsWith(year)).map((p) => <input key={p} type="hidden" name="months" value={p} />)}
      <p className="text-xs text-slate-600">{picked.length} month{picked.length === 1 ? "" : "s"} selected. Months already paid can&apos;t be entered twice.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Amount each month ($)"><input className="input" name="amountEach" inputMode="decimal" defaultValue={(feeCents / 100).toFixed(2)} /></Field>
        <MethodFields methods={methods} defaultMethod={defaultMethod} />
      </div>
      <fieldset className="space-y-1 text-sm">
        <legend className="font-semibold text-navy-900">Date received</legend>
        <label className="flex items-center gap-2"><input type="radio" name="dateMode" value="DUE_DATE" checked={dateMode === "DUE_DATE"} onChange={() => setDateMode("DUE_DATE")} /> Use each month&apos;s due date</label>
        <label className="flex items-center gap-2"><input type="radio" name="dateMode" value="ONE_DATE" checked={dateMode === "ONE_DATE"} onChange={() => setDateMode("ONE_DATE")} /> One date for all:</label>
        {dateMode === "ONE_DATE" && <input className="input" type="date" name="paidOn" required />}
      </fieldset>
      <Button type="submit" variant="gold" className="w-full rounded-xl py-2.5 text-base" disabled={!picked.length}>Mark {picked.length || ""} month{picked.length === 1 ? "" : "s"} paid</Button>
    </ActionForm>
  );
}
