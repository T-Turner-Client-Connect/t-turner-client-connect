"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Field } from "@/components/ui";

type Values = { spouseFirstName: string; spouseMiddleName: string; spouseLastName: string; spouseEmail: string; spousePhone: string };

/**
 * "Filing jointly / spouse needed for {year}". Collapsed unless that box is
 * ticked for the CURRENT tax year: a spouse saved for an earlier year doesn't
 * open it or assume a joint return. Unticked, the fields are disabled so nothing
 * is sent (the server also ignores them). Hidden entirely for business and
 * nonprofit clients, which are never asked for personal tax information.
 */
export function SpouseSection({ year, initialOpen, initialType, values, savedEarlier }: { year: number; initialOpen: boolean; initialType: string; values: Values; savedEarlier: boolean }) {
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

  const individual = type === "INDIVIDUAL";
  return (
    <div ref={ref} hidden={!individual} className="my-2" data-testid="spouse-section" data-open={open && individual ? "true" : "false"}>
      {individual && <input type="hidden" name="spouseSection" value="1" />}
      <input type="hidden" name="spouseYear" value={year} disabled={!individual} />
      <div className="rounded-xl border border-gold-300 bg-gold-100/30">
        <label className="flex cursor-pointer items-center gap-3 px-4 py-3 text-sm font-semibold text-navy-900">
          <input type="checkbox" name="spouseNeeded" checked={open} onChange={(e) => setOpen(e.target.checked)} disabled={!individual} className="size-4 accent-navy-900" data-testid="spouse-toggle" />
          <span className="flex-1">Filing jointly / spouse needed for {year}</span>
          <ChevronDown className={`size-4 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
        </label>
        {!open && savedEarlier && <p className="px-4 pb-3 text-xs text-slate-600">A spouse is on file from an earlier year. It&apos;s kept as is and isn&apos;t used for {year} unless you tick the box.</p>}
        <fieldset disabled={!open || !individual} hidden={!open} className="grid gap-4 border-t border-gold-300 p-4 sm:grid-cols-3">
          <legend className="sr-only">Spouse (joint return)</legend>
          <p className="text-xs text-slate-600 sm:col-span-3">For a married couple filing jointly: one client record for both of you. The spouse&apos;s contact details are kept separate from the client&apos;s.</p>
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


