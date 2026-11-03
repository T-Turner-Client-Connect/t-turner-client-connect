import type { TaxReturnSummary, TaxSummaryCheck, TaxSummaryItem } from "@prisma/client";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Field, Notice } from "@/components/ui";
import { addItemAction, attachReturnAction, extractAgainAction, itemStepAction, resolveCheckAction, updateItemAction } from "@/app/actions/tax-summary";
import { FORM_LABELS, ITEM_STATUS } from "@/lib/services/tax-summary-items";
import type { Amount } from "@/lib/tax/extract";
import { fmtDateTime } from "@/lib/format";

const money = (c: number) => (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
const amounts = (j: unknown) => (Array.isArray(j) ? (j as Amount[]) : []);
const FORM_OPTIONS = ["W-2", "1099-R", "1099-NEC", "1099-MISC", "1099-INT", "1099-DIV", "1099-K", "1099-G", "SSA-1099", "SCH-C", "1098", "1098-T", "1098-E", "CREDIT", "DEDUCTION", "ADJUSTMENT", "OTHER"];
const SECTION_OPTIONS = [["INCOME", "Income"], ["ADJUSTMENT", "Adjustment"], ["DEDUCTION", "Deduction"], ["CREDIT", "Credit"], ["PAYMENT", "Payment / withholding"], ["OTHER", "Other"]];
const DEFAULT_BOXES: Record<string, [string, string][]> = {
  "W-2": [["wages", "Wages (box 1)"], ["fedWithheld", "Federal income tax withheld (box 2)"], ["stateWithheld", "State income tax (box 17)"]],
  "1099-R": [["gross", "Gross distribution (box 1)"], ["taxable", "Taxable amount (box 2a)"], ["fedWithheld", "Federal income tax withheld (box 4)"]],
};

function AmountList({ list }: { list: Amount[] }) {
  if (!list.length) return <span className="text-slate-500">—</span>;
  return (
    <ul className="space-y-0.5">
      {list.map((a) => <li key={a.key} className="flex justify-between gap-2"><span className="text-slate-600">{a.label}</span><span className="font-medium tabular-nums">{money(a.cents)}</span></li>)}
    </ul>
  );
}

function ItemFields({ it }: { it?: TaxSummaryItem }) {
  const ret = it ? amounts(it.returnAmounts) : [];
  const base = ret.length ? ret.map((a) => [a.key, a.label, a.cents] as const) : (DEFAULT_BOXES[it?.formType ?? ""] ?? amounts(it?.documentAmounts).map((a) => [a.key, a.label] as const)).map(([k, l]) => [k, l, undefined] as const);
  const rows = [...base, ...Array(Math.max(0, 4 - base.length)).fill(["", "", undefined] as const)].slice(0, 6);
  return (
    <div className="grid gap-2 sm:grid-cols-4">
      <Field label="Section"><select className="input" name="section" defaultValue={it?.section ?? "INCOME"}>{SECTION_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
      <Field label="Document type"><select className="input" name="formType" defaultValue={it && it.formType !== "UNREADABLE" ? it.formType : "W-2"}>{FORM_OPTIONS.map((f) => <option key={f} value={f}>{FORM_LABELS[f] ?? f}</option>)}</select></Field>
      <Field label="Payer / employer / description"><input className="input" name="payerName" defaultValue={it && it.formType !== "UNREADABLE" ? it.payerName : ""} required /></Field>
      <Field label="Whose"><select className="input" name="recipient" defaultValue={it?.recipient ?? "TAXPAYER"}><option value="TAXPAYER">Taxpayer</option><option value="SPOUSE">Spouse</option><option value="JOINT">Joint</option></select></Field>
      <fieldset className="sm:col-span-4">
        <legend className="mb-1 text-xs font-semibold text-navy-900">Amounts as reported on the prepared return</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {rows.map(([k, l, c], i) => (
            <div key={i} className="flex gap-2">
              <input type="hidden" name={`amtKey_${i}`} defaultValue={k} />
              <input className="input" name={`amtLabel_${i}`} defaultValue={l} placeholder="Box / line" aria-label={`Amount ${i + 1} label`} />
              <input className="input w-36" name={`amt_${i}`} defaultValue={c !== undefined ? (c / 100).toFixed(2) : ""} inputMode="decimal" placeholder="0.00" aria-label={`Amount ${i + 1}`} />
            </div>
          ))}
        </div>
      </fieldset>
    </div>
  );
}

/**
 * Staff reconciliation: each document/return entry with the amount on the
 * source document and the amount reported on the return kept apart.
 */
export function SummaryItemsPanel({ s, items, checks, staff, blockers }: { s: TaxReturnSummary; items: TaxSummaryItem[]; checks: TaxSummaryCheck[]; staff: Map<string, string>; blockers: string[] }) {
  const editable = s.status === "DRAFT";
  return (
    <div className="mt-3 space-y-3" data-testid="summary-items">
      {editable && (
        <div className="flex flex-wrap items-end gap-3 rounded-xl bg-ivory-50 p-3">
          <ActionForm action={attachReturnAction.bind(null, s.id)} className="flex flex-wrap items-end gap-2" resetOnSuccess>
            <Field label={s.returnDocumentId ? "Replace prepared return PDF (TaxAct)" : "Prepared return PDF from TaxAct"} hint="Staff only — never sent to the client from here."><input className="input" type="file" name="file" accept="application/pdf" required /></Field>
            <Button type="submit" variant="secondary">Upload &amp; read return</Button>
          </ActionForm>
          {s.returnDocumentId && <ActionForm action={extractAgainAction.bind(null, s.id)}><Button type="submit" variant="ghost">Re-read return &amp; client documents</Button></ActionForm>}
          {s.extractedAt && <span className="text-xs text-slate-600">Last read {fmtDateTime(s.extractedAt)}</span>}
        </div>
      )}
      {/* Phones: one card per item (no sideways scrolling). */}
      <ul className="space-y-2 md:hidden">
        {items.map((it) => {
          const st = ITEM_STATUS[it.status as keyof typeof ITEM_STATUS] ?? ITEM_STATUS.NEEDS_REVIEW;
          return (
            <li key={it.id} className="rounded-xl border border-ivory-200 p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-semibold">{FORM_LABELS[it.formType] ?? it.formType} — {it.payerName}</span><Badge tone={st.tone as never}>{st.label}</Badge></div>
              <p className="mt-2 text-xs font-semibold text-slate-500">On the source document</p><AmountList list={amounts(it.documentAmounts)} />
              <p className="mt-2 text-xs font-semibold text-slate-500">Reported on the return</p><AmountList list={amounts(it.returnAmounts)} />
              <p className="mt-2 text-xs text-slate-600">Reviewer: {it.verifiedById ? `${staff.get(it.verifiedById) ?? "staff"} · ${fmtDateTime(it.verifiedAt)}` : "—"} · Print: not tracked yet</p>
              {it.note && <p className="mt-1 text-xs text-amber-900">{it.note}</p>}
            </li>
          );
        })}
      </ul>
      <div className="hidden md:block">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-slate-500">
            <tr><th className="p-2">Document &amp; payer</th><th className="p-2">On the source document</th><th className="p-2">Reported on the return</th><th className="p-2">Status</th><th className="p-2">Reviewer</th><th className="p-2">Print</th></tr>
          </thead>
          <tbody className="divide-y divide-ivory-200 align-top">
            {items.map((it) => {
              const st = ITEM_STATUS[it.status as keyof typeof ITEM_STATUS] ?? ITEM_STATUS.NEEDS_REVIEW;
              return (
                <tr key={it.id} data-testid="summary-item" data-form={it.formType} data-status={it.status}>
                  <td className="p-2">
                    <p className="font-semibold">{FORM_LABELS[it.formType] ?? it.formType}</p>
                    <p>{it.payerName}{it.recipient !== "TAXPAYER" ? ` · ${it.recipient.toLowerCase()}` : ""}</p>
                    <p className="text-xs text-slate-500">{it.source === "BOTH" ? "Document + return" : it.source === "RETURN" ? `Read from the return${it.sourcePage ? `, page ${it.sourcePage}` : ""}` : it.source === "DOCUMENT" ? "Client document only" : "Entered by staff"}</p>
                    {it.note && <p className="mt-1 text-xs text-amber-900">{it.note}</p>}
                  </td>
                  <td className="p-2"><AmountList list={amounts(it.documentAmounts)} /></td>
                  <td className="p-2"><AmountList list={amounts(it.returnAmounts)} /></td>
                  <td className="p-2"><Badge tone={st.tone as never}>{st.label}</Badge></td>
                  <td className="p-2 text-xs">{it.verifiedById ? <>{staff.get(it.verifiedById) ?? "staff"}<br />{fmtDateTime(it.verifiedAt)}</> : "—"}</td>
                  <td className="p-2 text-xs text-slate-500">Not tracked yet (Print Center)</td>
                </tr>
              );
            })}
            {items.length === 0 && <tr><td colSpan={6} className="p-2 text-slate-600">No items yet. Upload the prepared return to read it, or add each item from TaxAct.</td></tr>}
          </tbody>
        </table>
      </div>
      {editable && items.filter((i) => i.status !== "VERIFIED" && i.status !== "EXCLUDED").length > 0 && (
        <div className="space-y-2">
          <p className="text-sm font-semibold">Review each item against the prepared return</p>
          {items.filter((i) => i.status !== "VERIFIED" && i.status !== "EXCLUDED").map((it) => (
            <details key={it.id} className="rounded-xl border border-ivory-200 p-3" data-testid="item-review">
              <summary className="cursor-pointer text-sm font-semibold">{FORM_LABELS[it.formType] ?? it.formType} — {it.payerName} <Badge tone={(ITEM_STATUS[it.status as keyof typeof ITEM_STATUS]?.tone ?? "gold") as never}>{ITEM_STATUS[it.status as keyof typeof ITEM_STATUS]?.label}</Badge></summary>
              <div className="mt-2 grid gap-3 lg:grid-cols-3">
                <ActionForm action={itemStepAction.bind(null, it.id, "verify")} className="space-y-2 rounded-lg bg-emerald-50/60 p-3">
                  <p className="text-xs">Confirm the amounts under “Reported on the return” match TaxAct.</p>
                  <Field label="Note (required when the document differs)"><input className="input" name="note" /></Field>
                  <Button type="submit" variant="secondary">Verify as entered on the return</Button>
                </ActionForm>
                <ActionForm action={updateItemAction.bind(null, it.id)} className="space-y-2 rounded-lg bg-ivory-50 p-3 lg:col-span-2">
                  <ItemFields it={it} />
                  <Field label="Why the correction"><input className="input" name="reason" required minLength={3} /></Field>
                  <Button type="submit" variant="ghost">Save correction (audited)</Button>
                </ActionForm>
                <ActionForm action={itemStepAction.bind(null, it.id, "exclude")} className="flex flex-wrap items-end gap-2 lg:col-span-3">
                  <Field label="Not on this return? Say why"><input className="input" name="reason" required minLength={3} /></Field>
                  <Button type="submit" variant="ghost">Exclude</Button>
                </ActionForm>
              </div>
            </details>
          ))}
        </div>
      )}
      {checks.length > 0 && (
        <ul className="space-y-1 text-sm" data-testid="summary-checks">
          {checks.map((c) => (
            <li key={c.id} className={`rounded-lg p-2 ${c.resolvedAt ? "bg-ivory-50 text-slate-600" : c.severity === "BLOCKING" ? "bg-red-50 text-red-900" : "bg-amber-50 text-amber-900"}`}>
              {c.message}
              {c.resolvedAt ? <span className="block text-xs">Resolved by {staff.get(c.resolvedById ?? "") ?? "staff"}: “{c.resolutionNote}”</span> : editable && (
                <ActionForm action={resolveCheckAction.bind(null, c.id)} className="mt-1 flex flex-wrap gap-2">
                  <input className="input w-72" name="note" placeholder="How was this confirmed?" aria-label="Resolution" required minLength={3} />
                  <Button type="submit" variant="ghost">Mark resolved</Button>
                </ActionForm>
              )}
            </li>
          ))}
        </ul>
      )}
      {editable && blockers.length > 0 && <Notice tone="warn" title="Before this can be sent">{blockers.map((b) => <span key={b} className="block">• {b}</span>)}</Notice>}
      {editable && (
        <details>
          <summary className="cursor-pointer text-sm font-semibold underline">Add an item from TaxAct</summary>
          <ActionForm action={addItemAction.bind(null, s.id)} className="mt-2 space-y-2" resetOnSuccess>
            <ItemFields />
            <Button type="submit" variant="secondary">Add item</Button>
          </ActionForm>
        </details>
      )}
    </div>
  );
}
