"use client";

import { useEffect, useRef, useState } from "react";
import { BUSINESS_RETURN, CLOSE_DRAFT_LABEL, DEFAULT_VERIFICATION, federalFormFor, PRESET_OVERRIDE_REASON, stateFormFor } from "@/lib/tax/accepted";

const STATES = "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(" ");

export type DeliveryContext = {
  owner: boolean;
  clientType: string;
  entityType: string | null;
  /** The client's state (two letters), when on file. */
  clientState: string | null;
  /** `${year}:${ORIGINAL|AMENDED}` with a client-approved summary on file. */
  approvedKeys: string[];
  /** `${year}:${ORIGINAL|AMENDED}` with a never-sent draft summary. */
  draftKeys: string[];
  /** `${year}:${jurisdiction}:${ORIGINAL|AMENDED}` → the form numbers of existing filings. */
  existing: Record<string, string[]>;
  /** year → the forms from that year's confirmed Tax Preparation case (null where the mapping isn't known for sure). */
  prepForms?: Record<string, { federal: string | null; state: string | null }>;
};

type Row = { code: string; on: boolean; form: string | null; acceptedOn: string | null; ref: string | null };

const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
const label = "mb-1 block text-sm font-semibold text-navy-900";

/**
 * The fields of "Finish & Send a Return": which returns (Federal, the
 * client's state, more states), each with its own submission ID (the IRS and
 * each state issue their own), the accepted date (shared, or per return), one combined PDF or one per return, the optional acceptance
 * confirmation (not the return), the notice, and Tabitha's confirmation.
 */
export function AcceptedReturnFields({
  ctx,
  showYear = true,
  showFiles = true,
  defaultYear,
  startWithState = false,
  amended = false,
}: {
  ctx: DeliveryContext;
  showYear?: boolean;
  showFiles?: boolean;
  defaultYear?: number;
  startWithState?: boolean;
  amended?: boolean;
}) {
  const individual = ctx.clientType === "INDIVIDUAL";
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState<number>(defaultYear ?? thisYear - 1);
  const [filingType, setFilingType] = useState<"ORIGINAL" | "AMENDED">(amended ? "AMENDED" : "ORIGINAL");
  const [date, setDate] = useState(today());
  const [fed, setFed] = useState<{ on: boolean; form: string | null; acceptedOn: string | null; ref: string | null }>({ on: !startWithState, form: null, acceptedOn: null, ref: null });
  const home = ctx.clientState && STATES.includes(ctx.clientState) ? ctx.clientState : "AL";
  const [rows, setRows] = useState<Row[]>([{ code: home, on: startWithState || !!ctx.clientState, form: null, acceptedOn: null, ref: null }]);
  const [oneFile, setOneFile] = useState(true);
  const [reason, setReason] = useState("");
  const ref0 = useRef<HTMLDivElement>(null);

  // On the Documents tab the year comes from that form's own "Tax year" field.
  useEffect(() => {
    if (showYear) return;
    const input = ref0.current?.closest("form")?.querySelector<HTMLInputElement>('input[name="year"]');
    if (!input) return;
    const read = () => Number(input.value) && setYear(Number(input.value));
    read();
    input.addEventListener("input", read);
    return () => input.removeEventListener("input", read);
  }, [showYear]);

  // Form number: what's already on file (one filing), else a mapping we know for sure, else blank.
  const onFile = (j: string) => {
    const list = ctx.existing[`${year}:${j}:${filingType}`] ?? [];
    return list.length === 1 ? list[0] : null;
  };
  // Then the confirmed Tax Preparation case for the year (original returns; its state form is for the client's own state).
  const prep = filingType === "ORIGINAL" ? ctx.prepForms?.[String(year)] : undefined;
  const fedForm = fed.form ?? onFile("FEDERAL") ?? (filingType === "AMENDED" && individual ? "1040-X" : prep?.federal ?? federalFormFor(ctx.clientType, ctx.entityType)) ?? "";
  const stForm = (r: Row) => r.form ?? onFile(r.code) ?? (r.code === ctx.clientState ? prep?.state : null) ?? stateFormFor(r.code, ctx.clientType, ctx.entityType) ?? "";
  const ticked = [...(fed.on ? ["FEDERAL"] : []), ...rows.filter((r) => r.on).map((r) => r.code)];

  const key = `${year}:${filingType}`;
  const anyGated = (fed.on && !BUSINESS_RETURN.test(fedForm)) || (individual && rows.some((r) => r.on));
  const needsReason = ctx.owner && anyGated && !ctx.approvedKeys.includes(key);
  const hasDraft = ctx.draftKeys.includes(key);
  const set = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <div ref={ref0} className="space-y-4 sm:col-span-6" data-testid="accepted-return-fields">
      <div className="grid gap-3 sm:grid-cols-3">
        {showYear && (
          <label className="block">
            <span className={label}>Tax year</span>
            <select className="input" name="taxYear" value={year} onChange={(e) => setYear(Number(e.target.value))} required>
              {Array.from({ length: 8 }, (_, i) => thisYear - i).map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </label>
        )}
        <label className="block">
          <span className={label}>Original or amended</span>
          <select className="input" name="filingType" value={filingType} onChange={(e) => setFilingType(e.target.value === "AMENDED" ? "AMENDED" : "ORIGINAL")}>
            <option value="ORIGINAL">Original</option>
            <option value="AMENDED">Amended</option>
          </select>
        </label>
        <label className="block">
          <span className={label}>Accepted on</span>
          <input className="input" type="date" value={date} max={today()} onChange={(e) => setDate(e.target.value)} required data-testid="accepted-date" />
        </label>
      </div>

      <fieldset className="rounded-lg border border-ivory-200 p-3">
        <legend className="px-1 text-sm font-semibold text-navy-900">Which returns</legend>
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2" data-testid="row-federal">
            <label className="flex w-40 items-center gap-2 font-semibold"><input type="checkbox" name="fed.on" checked={fed.on} onChange={(e) => setFed({ ...fed, on: e.target.checked })} className="accent-navy-900" /> Federal</label>
            <span className="text-sm text-slate-600">Form</span>
            <input className="input w-28" name="fed.returnType" value={fedForm} onChange={(e) => setFed({ ...fed, form: e.target.value })} placeholder="e.g. 1120-S" required={fed.on} aria-label="Federal form" />
            <span className="text-sm text-slate-600">Submission ID</span>
            <input className="input w-60" name="fed.submissionId" value={fed.ref ?? ""} onChange={(e) => setFed({ ...fed, ref: e.target.value })} placeholder="IRS submission ID (optional)" aria-label="Federal submission ID" data-testid="fed-submission-id" />
          </div>
          {rows.map((r, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2" data-testid={`row-state-${i}`}>
              <label className="flex w-40 items-center gap-2 font-semibold">
                <input type="checkbox" name={`st.${i}.on`} checked={r.on} onChange={(e) => set(i, { on: e.target.checked })} className="accent-navy-900" aria-label="State return" />
                State
                <select className="input w-20 py-1" name={`st.${i}.code`} value={r.code} onChange={(e) => set(i, { code: e.target.value, form: null })} aria-label="State">
                  {STATES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
              <span className="text-sm text-slate-600">Form</span>
              <input className="input w-28" name={`st.${i}.returnType`} value={stForm(r)} onChange={(e) => set(i, { form: e.target.value })} placeholder="Type it" required={r.on && !onFile(r.code)} aria-label={`${r.code} form`} />
              <span className="text-sm text-slate-600">Submission ID</span>
              <input className="input w-60" name={`st.${i}.submissionId`} value={r.ref ?? ""} onChange={(e) => set(i, { ref: e.target.value })} placeholder={`${r.code} submission ID (optional)`} aria-label={`${r.code} submission ID`} data-testid={`state-${i}-submission-id`} />
            </div>
          ))}
          <button type="button" className="text-xs underline" onClick={() => setRows((rs) => [...rs, { code: "GA", on: true, form: null, acceptedOn: null, ref: null }])}>+ Another state</button>
        </div>
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer text-slate-600 underline">Different accepted date for one return?</summary>
          <div className="mt-2 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="w-24">Federal</span>
              <input className="input w-44" type="date" name="fed.acceptedOn" value={fed.acceptedOn ?? date} max={today()} onChange={(e) => setFed({ ...fed, acceptedOn: e.target.value })} aria-label="Federal accepted on" />
            </div>
            {rows.map((r, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <span className="w-24">{r.code}</span>
                <input className="input w-44" type="date" name={`st.${i}.acceptedOn`} value={r.acceptedOn ?? date} max={today()} onChange={(e) => set(i, { acceptedOn: e.target.value })} aria-label={`${r.code} accepted on`} />
              </div>
            ))}
          </div>
        </details>
      </fieldset>

      {showFiles && (
        <fieldset className="rounded-lg border border-ivory-200 p-3" data-testid="return-pdf">
          <legend className="px-1 text-sm font-semibold text-navy-900">Return PDF</legend>
          <div className="mb-2 flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2"><input type="radio" checked={oneFile} onChange={() => setOneFile(true)} className="accent-navy-900" /> One file for {ticked.length > 1 ? "both" : "it"}</label>
            <label className="flex items-center gap-2"><input type="radio" checked={!oneFile} onChange={() => setOneFile(false)} className="accent-navy-900" /> One file per return</label>
          </div>
          {oneFile ? (
            <input className="input" type="file" name="file" accept="application/pdf" required aria-label="Return PDF" />
          ) : (
            <div className="space-y-1">
              {fed.on && <label className="flex flex-wrap items-center gap-2 text-sm"><span className="w-24">Federal</span><input className="input flex-1" type="file" name="fed.file" accept="application/pdf" required /></label>}
              {rows.map((r, i) => r.on && <label key={i} className="flex flex-wrap items-center gap-2 text-sm"><span className="w-24">{r.code}</span><input className="input flex-1" type="file" name={`st.${i}.file`} accept="application/pdf" required /></label>)}
            </div>
          )}
        </fieldset>
      )}

      <details className="rounded-lg border border-dashed border-ivory-200 p-2 text-sm">
        <summary className="cursor-pointer text-slate-600">IRS/state acceptance confirmation — <strong>not the return</strong> (optional)</summary>
        <div className="mt-2 space-y-1">
          {fed.on && <label className="flex flex-wrap items-center gap-2"><span className="w-24">Federal</span><input className="input flex-1" type="file" name="fed.ack" accept="application/pdf,image/png,image/jpeg" /></label>}
          {rows.map((r, i) => r.on && <label key={i} className="flex flex-wrap items-center gap-2"><span className="w-24">{r.code}</span><input className="input flex-1" type="file" name={`st.${i}.ack`} accept="application/pdf,image/png,image/jpeg" /></label>)}
        </div>
      </details>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className={label}>How verified</span>
          <input className="input" name="verificationNote" defaultValue={DEFAULT_VERIFICATION} />
        </label>
        <div className="text-sm">
          <span className={label}>Notify the client</span>
          <label className="mr-4 inline-flex items-center gap-2"><input type="checkbox" name="notifyClient" defaultChecked className="accent-navy-900" /> Email</label>
          <label className="inline-flex items-center gap-2"><input type="checkbox" name="notifyText" className="accent-navy-900" /> Text</label>
          <span className="block text-xs text-slate-600">A sign-in link only — never the return.{ctx.owner ? "" : " Sent when Tabitha releases it."}</span>
        </div>
      </div>
      {hasDraft && (
        <label className="flex items-start gap-2 text-sm" data-testid="close-draft-summary"><input type="checkbox" name="closeDraftSummary" defaultChecked className="mt-1 accent-navy-900" /> {CLOSE_DRAFT_LABEL}</label>
      )}

      {ctx.owner ? (
        <div className="rounded-lg border border-gold-500/50 bg-gold-50 p-3 text-sm" data-testid="owner-confirmation">
          <label className="flex items-start gap-2"><input type="checkbox" name="form8879" className="mt-1 accent-navy-900" /> Signed Form 8879 (and any state e-file authorization) is on file.</label>
          {needsReason && (
            <div className="mt-2">
              <label className="block">
                <span className={label}>No client-approved {year} summary — why?</span>
                <input className="input" name="overrideReason" value={reason} onChange={(e) => setReason(e.target.value)} />
              </label>
              <button type="button" className="mt-1 text-xs font-semibold underline" onClick={() => setReason(PRESET_OVERRIDE_REASON)}>Use: “{PRESET_OVERRIDE_REASON}”</button>
            </div>
          )}
        </div>
      ) : (
        <p className="rounded-lg border border-ivory-200 bg-ivory-50 p-3 text-sm" data-testid="staff-path-note">
          Tabitha marks returns Accepted and releases them. This saves everything for her — the client sees nothing until she does.
        </p>
      )}
    </div>
  );
}

/**
 * On the Documents tab, for Tabitha: picking Federal, State or Amended return
 * (category Taxes) shows the same fields inline, so one upload marks it
 * Accepted and sends it.
 */
export function OwnerReturnInline({ ctx }: { ctx: DeliveryContext }) {
  const ref = useRef<HTMLDivElement>(null);
  const [type, setType] = useState("");
  const [deliver, setDeliver] = useState(true);
  useEffect(() => {
    const form = ref.current?.closest("form");
    if (!form) return;
    const read = () => {
      const cat = form.querySelector<HTMLSelectElement>('select[name="category"]')?.value;
      const dt = form.querySelector<HTMLSelectElement>('select[name="docType"]')?.value ?? "";
      setType(cat === "TAXES" && ["FEDERAL_RETURN", "STATE_RETURN", "AMENDED_RETURN"].includes(dt) ? dt : "");
    };
    read();
    form.addEventListener("change", read);
    return () => form.removeEventListener("change", read);
  }, []);
  return (
    <div ref={ref} className="sm:col-span-2">
      {type && (
        <div className="space-y-2 rounded-xl border border-navy-100 bg-navy-50 p-3" data-testid="owner-return-inline">
          <label className="flex items-start gap-2 text-sm font-semibold"><input type="checkbox" name="deliverAccepted" checked={deliver} onChange={(e) => setDeliver(e.target.checked)} className="mt-1 accent-navy-900" /> Mark Accepted &amp; send to the client (one step)</label>
          {deliver && <AcceptedReturnFields key={type} ctx={ctx} showYear={false} showFiles={false} startWithState={type === "STATE_RETURN"} amended={type === "AMENDED_RETURN"} />}
          {deliver && <p className="text-xs text-slate-600">“Who can see it” below is ignored for a return sent this way; the client sees it once the malware scan passes.</p>}
        </div>
      )}
    </div>
  );
}
