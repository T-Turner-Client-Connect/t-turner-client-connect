"use client";

import { useState } from "react";
import { ActionForm } from "@/components/action-form";
import { Button, Field } from "@/components/ui";
import { RETURN_TYPES, SPOUSE_RETURN_TYPES, type ReturnTypeCode } from "@/lib/tax/return-types";

type Values = Partial<Record<
  | "returnType"
  | "otherReturnForm"
  | "primaryFirstName"
  | "primaryMiddleName"
  | "primaryLastName"
  | "spouseFirstName"
  | "spouseMiddleName"
  | "spouseLastName"
  | "spouseEmail"
  | "spousePhone",
  string | null
>>;

/**
 * Required Tax Return Type for one tax year. Picking Married Filing Jointly
 * shows the primary taxpayer and spouse side by side on the same case.
 */
export function ReturnTypeForm({
  action,
  taxYear,
  yearEditable,
  values,
  submitLabel,
}: {
  action: (prev: { error?: string; ok?: string } | null, fd: FormData) => Promise<{ error?: string; ok?: string } | null>;
  taxYear: number;
  yearEditable?: boolean;
  values: Values;
  submitLabel: string;
}) {
  const [type, setType] = useState<string>(values.returnType ?? "");
  const hasSpouse = SPOUSE_RETURN_TYPES.includes(type as ReturnTypeCode);
  const joint = type === "1040_MFJ";
  const v = (k: keyof Values) => values[k] ?? "";
  return (
    <ActionForm action={action} className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-3">
        {yearEditable ? (
          <Field label="Tax year"><input className="input" name="taxYear" defaultValue={taxYear} inputMode="numeric" required /></Field>
        ) : (
          <input type="hidden" name="taxYear" value={taxYear} />
        )}
        <Field label="Tax Return Type (required)" className={yearEditable ? "sm:col-span-2" : "sm:col-span-3"} hint="Not the same as the client category — this is the return being prepared for this tax year.">
          <select className="input" name="returnType" value={type} onChange={(e) => setType(e.target.value)} required aria-label={`Tax Return Type for ${taxYear}`}>
            <option value="" disabled>Select the return type…</option>
            {Object.entries(RETURN_TYPES).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
        </Field>
        {type === "OTHER" && (
          <Field label="Return form" hint="e.g. 1040-NR, 706, 709"><input className="input" name="otherReturnForm" defaultValue={v("otherReturnForm")} maxLength={40} required /></Field>
        )}
      </div>

      <div className={hasSpouse ? "grid gap-3 lg:grid-cols-2" : "grid gap-3"}>
        <fieldset className="rounded-xl border border-ivory-200 p-3">
          <legend className="px-1 text-sm font-semibold text-navy-900">{hasSpouse ? "Primary taxpayer" : "Taxpayer (as named on the return)"}</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            <Field label="First name"><input className="input" name="primaryFirstName" defaultValue={v("primaryFirstName")} autoComplete="off" /></Field>
            <Field label="Middle"><input className="input" name="primaryMiddleName" defaultValue={v("primaryMiddleName")} autoComplete="off" /></Field>
            <Field label="Last name"><input className="input" name="primaryLastName" defaultValue={v("primaryLastName")} autoComplete="off" /></Field>
          </div>
          <p className="mt-1 text-xs text-slate-600">Contact details stay on the client record.</p>
        </fieldset>
        {hasSpouse && (
          <fieldset className="rounded-xl border border-gold-300 bg-gold-100/30 p-3" data-testid="spouse-fields">
            <legend className="px-1 text-sm font-semibold text-navy-900">Spouse{joint ? " (same joint return)" : ""}</legend>
            <div className="grid gap-2 sm:grid-cols-3">
              <Field label="First name"><input className="input" name="spouseFirstName" defaultValue={v("spouseFirstName")} required={joint} autoComplete="off" /></Field>
              <Field label="Middle"><input className="input" name="spouseMiddleName" defaultValue={v("spouseMiddleName")} autoComplete="off" /></Field>
              <Field label="Last name"><input className="input" name="spouseLastName" defaultValue={v("spouseLastName")} required={joint} autoComplete="off" /></Field>
              <Field label="Spouse email" className="sm:col-span-2"><input className="input" type="email" name="spouseEmail" defaultValue={v("spouseEmail")} autoComplete="off" /></Field>
              <Field label="Spouse phone"><input className="input" type="tel" name="spousePhone" defaultValue={v("spousePhone")} autoComplete="off" /></Field>
            </div>
            {joint && <p className="mt-1 text-xs text-slate-600">One joint return on this one client record — the spouse is not a separate client or return.</p>}
          </fieldset>
        )}
      </div>
      <Button type="submit">{submitLabel}</Button>
    </ActionForm>
  );
}
