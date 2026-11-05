"use client";

import { useEffect, useRef, useState } from "react";
import { BUSINESS_RETURN, CLOSE_DRAFT_LABEL, DEFAULT_VERIFICATION, PRESET_OVERRIDE_REASON } from "@/lib/tax/accepted";

const STATES = "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(" ");
const STATE_NAMES: Record<string, string> = { AL: "Alabama", GA: "Georgia", FL: "Florida", MS: "Mississippi", TN: "Tennessee", IL: "Illinois", TX: "Texas", CA: "California", NY: "New York" };
/** Common individual state forms (a suggestion only; always editable). */
const STATE_FORM: Record<string, string> = { AL: "40", GA: "500", MS: "80-105", IL: "IL-1040", CA: "540", NY: "IT-201" };

type Row = { code: string; on: boolean; returnType: string; acceptedOn: string | null; submissionId: string | null };

export type DeliveryContext = {
  owner: boolean;
  clientType: string;
  /** `${year}:${ORIGINAL|AMENDED}` with a client-approved summary on file. */
  approvedKeys: string[];
  /** `${year}:${ORIGINAL|AMENDED}` with a never-sent draft summary. */
  draftKeys: string[];
};

const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });

/**
 * The fields of "Deliver accepted return": federal plus any states in one
 * submission, each with its own accepted date and submission ID (copied from
 * federal until edited), one combined PDF or one per return, and — for
 * Tabitha — the owner confirmation inline.
 */
export function AcceptedReturnFields({
  ctx,
  showYear = true,
  showFiles = true,
  defaultYear,
  startWithState = false,
  amended = false,
  ownerSendsNow = true,
}: {
  ctx: DeliveryContext;
  showYear?: boolean;
  showFiles?: boolean;
  defaultYear?: number;
  startWithState?: boolean;
  amended?: boolean;
  ownerSendsNow?: boolean;
}) {
  const individual = ctx.clientType === "INDIVIDUAL";
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState<number>(defaultYear ?? thisYear - 1);
  const [filingType, setFilingType] = useState<"ORIGINAL" | "AMENDED">(amended ? "AMENDED" : "ORIGINAL");
  const [fed, setFed] = useState({ on: !startWithState, returnType: individual ? (amended ? "1040-X" : "1040") : "", acceptedOn: "", submissionId: "" });
  const [rows, setRows] = useState<Row[]>([{ code: "AL", on: startWithState, returnType: individual ? "40" : "", acceptedOn: null, submissionId: null }]);
  const [reason, setReason] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  // On the Documents tab the year comes from that form's own "Tax year" field.
  useEffect(() => {
    if (showYear) return;
    const input = ref.current?.closest("form")?.querySelector<HTMLInputElement>('input[name="year"]');
    if (!input) return;
    const read = () => Number(input.value) && setYear(Number(input.value));
    read();
    input.addEventListener("input", read);
    return () => input.removeEventListener("input", read);
  }, [showYear]);

  const key = `${year}:${filingType}`;
  const anyGated = (fed.on && !BUSINESS_RETURN.test(fed.returnType)) || (individual && rows.some((r) => r.on));
  const needsReason = ctx.owner && anyGated && !ctx.approvedKeys.includes(key);
  const hasDraft = ctx.draftKeys.includes(key);
  const set = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <div ref={ref} className="space-y-3 sm:col-span-6" data-testid="accepted-return-fields">
      {showYear && (
        <div className="grid gap-2 sm:grid-cols-3">
          <label className="block">
            <span className="mb-1 block text-sm font-semibold text-navy-900">Tax year</span>
            <select className="input" name="taxYear" value={year} onChange={(e) => setYear(Number(e.target.value))} required>
              {Array.from({ length: 8 }, (_, i) => thisYear - i).map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-semibold text-navy-900">Original or amended</span>
            <select className="input" name="filingType" value={filingType} onChange={(e) => setFilingType(e.target.value === "AMENDED" ? "AMENDED" : "ORIGINAL")}>
              <option value="ORIGINAL">Original</option>
              <option value="AMENDED">Amended</option>
            </select>
          </label>
        </div>
      )}
      {!showYear && <input type="hidden" name="filingType" value={filingType} />}

      <div className="overflow-x-auto rounded-lg border border-ivory-200">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="bg-ivory-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr><th className="p-2">Deliver</th><th className="p-2">Return</th><th className="p-2">Form</th><th className="p-2">Accepted on</th><th className="p-2">Submission ID (optional)</th>{showFiles && <th className="p-2">Own PDF (optional)</th>}<th className="p-2">Acknowledgment (optional)</th></tr>
          </thead>
          <tbody>
            <tr className="border-t border-ivory-200" data-testid="row-federal">
              <td className="p-2"><input type="checkbox" name="fed.on" checked={fed.on} onChange={(e) => setFed({ ...fed, on: e.target.checked })} className="accent-navy-900" aria-label="Deliver the federal return" /></td>
              <td className="p-2 font-semibold">Federal (IRS)</td>
              <td className="p-2"><input className="input w-28" name="fed.returnType" value={fed.returnType} onChange={(e) => setFed({ ...fed, returnType: e.target.value })} placeholder="1040, 1120-S…" required={fed.on} aria-label="Federal form" /></td>
              <td className="p-2"><input className="input" type="date" name="fed.acceptedOn" value={fed.acceptedOn} max={today()} onChange={(e) => setFed({ ...fed, acceptedOn: e.target.value })} required={fed.on} aria-label="Federal accepted on" /></td>
              <td className="p-2"><input className="input w-44" name="fed.submissionId" value={fed.submissionId} onChange={(e) => setFed({ ...fed, submissionId: e.target.value })} aria-label="Federal submission ID" /></td>
              {showFiles && <td className="p-2"><input className="input w-48" type="file" name="fed.file" accept="application/pdf" aria-label="Separate federal return PDF" /></td>}
              <td className="p-2"><input className="input w-48" type="file" name="fed.ack" accept="application/pdf,image/png,image/jpeg" aria-label="Federal acknowledgment" /></td>
            </tr>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-ivory-200" data-testid={`row-state-${i}`}>
                <td className="p-2"><input type="checkbox" name={`st.${i}.on`} checked={r.on} onChange={(e) => set(i, { on: e.target.checked })} className="accent-navy-900" aria-label={`Deliver the ${r.code} return`} /></td>
                <td className="p-2">
                  <select className="input w-36" name={`st.${i}.code`} value={r.code} onChange={(e) => set(i, { code: e.target.value, returnType: individual && STATE_FORM[e.target.value] ? STATE_FORM[e.target.value] : r.returnType })} aria-label="State">
                    {STATES.map((s) => <option key={s} value={s}>{STATE_NAMES[s] ? `${STATE_NAMES[s]} (${s})` : s}</option>)}
                  </select>
                </td>
                <td className="p-2"><input className="input w-28" name={`st.${i}.returnType`} value={r.returnType} onChange={(e) => set(i, { returnType: e.target.value })} placeholder="State form" required={r.on} aria-label={`${r.code} form`} /></td>
                <td className="p-2"><input className="input" type="date" name={`st.${i}.acceptedOn`} value={r.acceptedOn ?? fed.acceptedOn} max={today()} onChange={(e) => set(i, { acceptedOn: e.target.value })} required={r.on} aria-label={`${r.code} accepted on`} /></td>
                <td className="p-2"><input className="input w-44" name={`st.${i}.submissionId`} value={r.submissionId ?? fed.submissionId} onChange={(e) => set(i, { submissionId: e.target.value })} aria-label={`${r.code} submission ID`} /></td>
                {showFiles && <td className="p-2"><input className="input w-48" type="file" name={`st.${i}.file`} accept="application/pdf" aria-label={`Separate ${r.code} return PDF`} /></td>}
                <td className="p-2"><input className="input w-48" type="file" name={`st.${i}.ack`} accept="application/pdf,image/png,image/jpeg" aria-label={`${r.code} acknowledgment`} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-600">
        State dates and submission IDs copy the federal ones until you change them.{" "}
        <button type="button" className="underline" onClick={() => setRows((rs) => [...rs, { code: "GA", on: true, returnType: individual ? STATE_FORM.GA : "", acceptedOn: null, submissionId: null }])}>Add another state</button>
      </p>

      {showFiles && (
        <label className="block">
          <span className="mb-1 block text-sm font-semibold text-navy-900">Return PDF (one combined federal + state file is fine)</span>
          <input className="input" type="file" name="file" accept="application/pdf" />
          <span className="mt-1 block text-xs text-slate-600">Used for every ticked return that has no PDF of its own. The client sees it under each return.</span>
        </label>
      )}
      <label className="block">
        <span className="mb-1 block text-sm font-semibold text-navy-900">How you verified the acceptance</span>
        <input className="input" name="verificationNote" defaultValue={DEFAULT_VERIFICATION} />
      </label>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="relabelAck" className="mt-1 accent-navy-900" /> If this PDF was saved earlier as the acknowledgment on this filing, re-label it as the return</label>
      {hasDraft && (
        <label className="flex items-start gap-2 text-sm" data-testid="close-draft-summary"><input type="checkbox" name="closeDraftSummary" defaultChecked className="mt-1 accent-navy-900" /> {CLOSE_DRAFT_LABEL}</label>
      )}

      {ctx.owner ? (
        <div className="rounded-lg border border-gold-500/50 bg-gold-50 p-3 text-sm" data-testid="owner-confirmation">
          <p className="font-semibold">Owner filing — your confirmation</p>
          <label className="mt-1 flex items-start gap-2"><input type="checkbox" name="form8879" className="mt-1 accent-navy-900" /> Signed IRS Form 8879 (and any state e-file authorization) is on file.</label>
          {needsReason && (
            <div className="mt-2">
              <label className="block">
                <span className="mb-1 block text-sm font-semibold text-navy-900">No client-approved {year} summary — reason</span>
                <input className="input" name="overrideReason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why you're filing without an approved summary" />
              </label>
              <button type="button" className="mt-1 text-xs font-semibold underline" onClick={() => setReason(PRESET_OVERRIDE_REASON)}>Use: “{PRESET_OVERRIDE_REASON}”</button>
            </div>
          )}
          {ownerSendsNow && (
            <>
              <label className="mt-2 flex items-start gap-2"><input type="checkbox" name="sendToClient" defaultChecked className="mt-1 accent-navy-900" /> Send to the client&apos;s vault now (shown once the malware scan passes)</label>
              <label className="ml-6 flex items-start gap-2"><input type="checkbox" name="notifyClient" className="mt-1 accent-navy-900" /> Notify the client by email (optional — a sign-in link only, never the return)</label>
            </>
          )}
        </div>
      ) : (
        <p className="rounded-lg border border-ivory-200 bg-ivory-50 p-3 text-sm" data-testid="staff-path-note">
          Only Tabitha records a return as submitted or accepted. This saves the return (staff only) and the filing as <strong>Ready for Tabitha to confirm acceptance</strong> — nothing is marked submitted and the client sees nothing yet.
        </p>
      )}
    </div>
  );
}

/**
 * On the Documents tab, for Tabitha: picking Federal, State or Amended return
 * (category Taxes) shows the delivery fields inline, so one upload records the
 * acceptance and delivers the return.
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
          <label className="flex items-start gap-2 text-sm font-semibold"><input type="checkbox" name="deliverAccepted" checked={deliver} onChange={(e) => setDeliver(e.target.checked)} className="mt-1 accent-navy-900" /> Deliver as an accepted return (records the acceptance and sends it to the client in one step)</label>
          {deliver && <AcceptedReturnFields key={type} ctx={ctx} showYear={false} showFiles={false} startWithState={type === "STATE_RETURN"} amended={type === "AMENDED_RETURN"} ownerSendsNow={false} />}
          {deliver && <p className="text-xs text-slate-600">Sent to the client&apos;s vault once the malware scan passes. “Who can see it” below is ignored for a delivered return. <label className="inline-flex items-center gap-1"><input type="checkbox" name="notifyClient" className="accent-navy-900" /> Notify the client by email</label></p>}
        </div>
      )}
    </div>
  );
}
