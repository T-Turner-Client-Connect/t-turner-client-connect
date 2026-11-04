"use client";

import { useEffect, useRef, useState } from "react";
import { Field } from "@/components/ui";

type Values = { spouseFirstName: string; spouseMiddleName: string; spouseLastName: string; spouseEmail: string; spousePhone: string };

/**
 * Whether the "Add spouse / Joint tax return" box is offered and whether the
 * spouse fields are showing. Never assumes married: shown only when ticked (it
 * starts ticked for a joint return THIS tax year). Never for a business or
 * nonprofit record, or a business return (1065, 1120-S, ...) this year.
 */
export function spouseSectionView({ clientType, businessReturn, checked }: { clientType: string; businessReturn: boolean; checked: boolean }) {
  const offered = clientType === "INDIVIDUAL" && !businessReturn;
  return { offered, expanded: offered && checked };
}

/**
 * The client form's spouse section (Create and Edit). Unticked, the fields are
 * only hidden and disabled, so nothing is sent and a spouse already on file is
 * kept as is on save (the server keeps it too). Ticking again shows what was typed.
 */
export function SpouseSection({ year, initialOpen, initialType, businessReturn = false, values, savedEarlier }: { year: number; initialOpen: boolean; initialType: string; businessReturn?: boolean; values: Values; savedEarlier: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(initialOpen);
  const [type, setType] = useState(initialType);

  useEffect(() => {
    const form = ref.current?.closest("form");
    if (!form) return;
    const onChange = (e: Event) => {
      const t = e.target as HTMLSelectElement;
      if (t.name === "clientType") setType(t.value);
    };
    form.addEventListener("change", onChange);
    return () => form.removeEventListener("change", onChange);
  }, []);

  const { offered, expanded } = spouseSectionView({ clientType: type, businessReturn, checked: open });
  return (
    <div ref={ref} hidden={!offered} data-testid="spouse-section" data-open={expanded ? "true" : "false"} data-offered={offered ? "true" : "false"}>
      {/* Marks the client form: with no tick (or no box), the server keeps any spouse on file. */}
      <input type="hidden" name="spouseSection" value="1" />
      <input type="hidden" name="spouseYear" value={year} disabled={!offered} />
      <div>
        <label className="inline-flex cursor-pointer items-center gap-2 text-sm font-semibold text-navy-900">
          <input type="checkbox" name="spouseNeeded" checked={open} onChange={(e) => setOpen(e.target.checked)} disabled={!offered} className="size-4 accent-navy-900" data-testid="spouse-toggle" aria-controls="spouse-fields" aria-expanded={expanded} />
          Add spouse / Joint tax return
          <span className="font-normal text-slate-600">({year})</span>
        </label>
        {!expanded && savedEarlier && <p className="mt-1 text-xs text-slate-600">A spouse is on file from an earlier year. It&apos;s kept and isn&apos;t used for {year} unless you tick the box.</p>}
        <fieldset id="spouse-fields" disabled={!expanded} hidden={!expanded} className="mt-3 grid gap-4 rounded-xl border border-gold-300 bg-gold-100/30 p-4 sm:grid-cols-3">
          <legend className="sr-only">Spouse (joint return)</legend>
          <p className="text-xs text-slate-600 sm:col-span-3">Spouse (joint return) for {year}: one client record for the couple. The spouse&apos;s contact details are kept separate from the client&apos;s. Unticking only hides these; nothing is removed.</p>
          <Field label="Spouse first name"><input className="input" name="spouseFirstName" defaultValue={values.spouseFirstName} autoComplete="off" /></Field>
          <Field label="Spouse middle name / initial"><input className="input" name="spouseMiddleName" defaultValue={values.spouseMiddleName} autoComplete="off" /></Field>
          <Field label="Spouse last name"><input className="input" name="spouseLastName" defaultValue={values.spouseLastName} autoComplete="off" /></Field>
          <Field label="Spouse email" className="sm:col-span-2"><input className="input" type="email" name="spouseEmail" defaultValue={values.spouseEmail} autoComplete="off" /></Field>
          <Field label="Spouse mobile phone"><input className="input" type="tel" name="spousePhone" defaultValue={values.spousePhone} autoComplete="off" /></Field>
        </fieldset>
      </div>
    </div>
  );
}
