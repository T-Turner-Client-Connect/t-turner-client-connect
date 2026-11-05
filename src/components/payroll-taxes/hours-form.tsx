"use client";

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui";
import { CHANGE_FLAGS, type ChangeFlag, type HoursSubmission } from "@/lib/payroll/queue";

type State = { error?: string; ok?: string; at?: number } | null;
type Row = { name: string; regularHours: string; overtimeHours: string; notes: string };

const blank = (): Row => ({ name: "", regularHours: "", overtimeHours: "", notes: "" });
const input = "w-full rounded-lg border border-ivory-200 px-2.5 py-1.5 text-sm focus:border-navy-700 focus:outline-none";

/**
 * Hours for one pay period: each employee's regular and overtime hours with notes, change flags,
 * or "No changes — same as last period". Used by the client in the portal and by staff recording
 * hours the client gave by phone or email. The server re-validates everything.
 */
export function HoursForm({ action, initial, submitLabel = "Send hours" }: { action: (prev: State, fd: FormData) => Promise<State>; initial?: HoursSubmission | null; submitLabel?: string }) {
  const [noChanges, setNoChanges] = useState(initial?.noChanges ?? false);
  const [rows, setRows] = useState<Row[]>(initial?.employees.length ? initial.employees.map((e) => ({ name: e.name, regularHours: String(e.regularHours), overtimeHours: String(e.overtimeHours || ""), notes: e.notes })) : [blank()]);
  const [flags, setFlags] = useState<ChangeFlag[]>(initial?.flags ?? []);
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const payload = JSON.stringify({ noChanges, employees: noChanges ? [] : rows, flags, notes });
  const set = (i: number, k: keyof Row, v: string) => setRows((r) => r.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  return (
    <ActionForm action={action} className="space-y-3">
      <input type="hidden" name="hours" value={payload} />
      <label className="flex items-center gap-2 rounded-lg border border-ivory-200 bg-ivory-50 px-3 py-2 text-sm font-semibold text-navy-900">
        <input type="checkbox" checked={noChanges} onChange={(e) => setNoChanges(e.target.checked)} className="size-4 accent-[#0a1a44]" data-testid="no-changes" />
        No changes — same as last period
      </label>
      {!noChanges && (
        <div className="space-y-2" data-testid="hours-rows">
          <div className="hidden grid-cols-[minmax(0,2fr)_90px_90px_minmax(0,2fr)_36px] gap-2 text-xs font-semibold text-slate-600 sm:grid">
            <span>Employee</span><span>Regular hrs</span><span>Overtime hrs</span><span>Notes</span><span />
          </div>
          {rows.map((r, i) => (
            <div key={i} className="grid grid-cols-2 gap-2 sm:grid-cols-[minmax(0,2fr)_90px_90px_minmax(0,2fr)_36px]">
              <input aria-label="Employee name" placeholder="Employee name" value={r.name} onChange={(e) => set(i, "name", e.target.value)} className={`${input} col-span-2 sm:col-span-1`} />
              <input aria-label="Regular hours" inputMode="decimal" placeholder="40" value={r.regularHours} onChange={(e) => set(i, "regularHours", e.target.value)} className={input} />
              <input aria-label="Overtime hours" inputMode="decimal" placeholder="0" value={r.overtimeHours} onChange={(e) => set(i, "overtimeHours", e.target.value)} className={input} />
              <input aria-label="Notes" placeholder="Notes (optional)" value={r.notes} onChange={(e) => set(i, "notes", e.target.value)} className={`${input} col-span-2 sm:col-span-1`} />
              <button type="button" aria-label="Remove row" onClick={() => setRows((x) => (x.length > 1 ? x.filter((_, j) => j !== i) : [blank()]))} className="flex items-center justify-center rounded-lg text-slate-500 hover:bg-red-50 hover:text-red-700">
                <Trash2 className="size-4" aria-hidden />
              </button>
            </div>
          ))}
          <button type="button" onClick={() => setRows((x) => [...x, blank()])} className="inline-flex items-center gap-1 text-sm font-semibold text-navy-900 underline decoration-gold-500 underline-offset-4">
            <Plus className="size-4" aria-hidden /> Add employee
          </button>
        </div>
      )}
      <fieldset className="flex flex-wrap gap-2">
        <legend className="mb-1 text-sm font-semibold text-navy-900">Anything different this period?</legend>
        {(Object.entries(CHANGE_FLAGS) as [ChangeFlag, string][]).map(([k, label]) => (
          <label key={k} className="inline-flex items-center gap-1.5 rounded-full border border-ivory-200 px-3 py-1 text-xs font-semibold text-navy-900">
            <input type="checkbox" checked={flags.includes(k)} onChange={(e) => setFlags((f) => (e.target.checked ? [...f, k] : f.filter((x) => x !== k)))} className="size-3.5 accent-[#0a1a44]" />
            {label}
          </label>
        ))}
      </fieldset>
      <label className="block">
        <span className="mb-1 block text-sm font-semibold text-navy-900">Notes for the office</span>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={input} placeholder="New hire start date, rate change, bonus amount…" />
      </label>
      <Button type="submit" variant="gold">{submitLabel}</Button>
    </ActionForm>
  );
}
