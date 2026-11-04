"use client";

import { useState } from "react";
import { Field } from "@/components/ui";

type Values = Partial<Record<
  | "addressLine1"
  | "addressLine2"
  | "city"
  | "state"
  | "postalCode"
  | "mailingAddressLine1"
  | "mailingAddressLine2"
  | "mailingCity"
  | "mailingState"
  | "mailingPostalCode",
  string | null
>> & { mailingSameAsAddress?: boolean | null };

/**
 * Physical address + mailing address for the Create/Edit client screens.
 * Rendered inside the form's 6-column address grid. With "same as physical"
 * ticked the mailing fields are hidden and saved as cleared.
 */
export function ClientAddressFields({ values }: { values: Values }) {
  const [same, setSame] = useState(values.mailingSameAsAddress !== false);
  const v = (k: Exclude<keyof Values, "mailingSameAsAddress">) => values[k] ?? "";
  return (
    <>
      <input type="hidden" name="mailingSection" value="1" />
      <p className="text-sm font-semibold text-navy-900 sm:col-span-6">Physical address</p>
      <Field label="Street address" className="sm:col-span-6"><input className="input" name="addressLine1" defaultValue={v("addressLine1")} autoComplete="off" /></Field>
      <Field label="Address line 2 (optional)" className="sm:col-span-6"><input className="input" name="addressLine2" defaultValue={v("addressLine2")} autoComplete="off" /></Field>
      <Field label="City" className="sm:col-span-3"><input className="input" name="city" defaultValue={v("city")} autoComplete="off" /></Field>
      <Field label="State" className="sm:col-span-1"><input className="input" name="state" maxLength={2} defaultValue={v("state")} autoComplete="off" /></Field>
      <Field label="ZIP" className="sm:col-span-2"><input className="input" name="postalCode" inputMode="numeric" maxLength={10} defaultValue={v("postalCode")} autoComplete="off" /></Field>
      <label className="flex items-start gap-2 text-sm sm:col-span-6">
        <input type="checkbox" name="mailingSameAsAddress" value="1" checked={same} onChange={(e) => setSame(e.target.checked)} className="mt-0.5 accent-navy-900" />
        <span>Mailing address is the same as physical address</span>
      </label>
      {!same && (
        <>
          <p className="text-sm font-semibold text-navy-900 sm:col-span-6">Mailing address <span className="font-normal text-slate-600">— used for invoices and mail</span></p>
          <Field label="Mailing street address" className="sm:col-span-6"><input className="input" name="mailingAddressLine1" defaultValue={v("mailingAddressLine1")} autoComplete="off" required /></Field>
          <Field label="Address line 2 (optional)" className="sm:col-span-6"><input className="input" name="mailingAddressLine2" defaultValue={v("mailingAddressLine2")} autoComplete="off" /></Field>
          <Field label="City" className="sm:col-span-3"><input className="input" name="mailingCity" defaultValue={v("mailingCity")} autoComplete="off" required /></Field>
          <Field label="State" className="sm:col-span-1"><input className="input" name="mailingState" maxLength={2} defaultValue={v("mailingState")} autoComplete="off" required /></Field>
          <Field label="ZIP" className="sm:col-span-2"><input className="input" name="mailingPostalCode" inputMode="numeric" maxLength={10} defaultValue={v("mailingPostalCode")} autoComplete="off" required /></Field>
        </>
      )}
    </>
  );
}
