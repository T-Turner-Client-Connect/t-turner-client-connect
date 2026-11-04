"use client";

import { useState } from "react";
import clsx from "clsx";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui";
import { saveRowEditsAction } from "@/app/actions/imports";

export type EditorField = {
  key: string;
  label: string;
  // From the file, what staff entered (saved on the batch), and what the matched client has now.
  imported: string | null;
  entered: string | null;
  existing: string | null;
  useImported: boolean;
  optional?: boolean;
  span?: 1 | 2 | 3 | 6;
  inputMode?: "tel" | "email" | "numeric";
  maxLength?: number;
};

// Phone width: state and ZIP share a line; everything else is full width.
const SPAN = { 1: "col-span-2 sm:col-span-1", 2: "col-span-4 sm:col-span-2", 3: "col-span-6 sm:col-span-3", 6: "col-span-6" } as const;

function FieldEditor({ f, matched }: { f: EditorField; matched: boolean }) {
  const incoming = f.entered ?? f.imported;
  const [value, setValue] = useState(incoming ?? "");
  const [use, setUse] = useState(f.useImported);
  const conflict = matched && !!f.existing && value.trim() !== "" && value.trim().toLowerCase() !== f.existing.trim().toLowerCase();
  const missing = !f.optional && !f.existing && !value.trim();
  return (
    <div className={clsx("min-w-0", SPAN[f.span ?? 6])}>
      <label className="block">
        <span className="mb-1 block text-xs font-semibold text-navy-900">
          {f.label}
          {f.optional && <span className="font-normal text-slate-500"> (optional)</span>}
        </span>
        <input
          className={clsx("input", missing && "border-amber-400")}
          name={f.key}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          inputMode={f.inputMode === "numeric" ? "numeric" : undefined}
          type={f.inputMode === "tel" ? "tel" : f.inputMode === "email" ? "email" : "text"}
          maxLength={f.maxLength ?? 200}
          autoComplete="off"
          placeholder={f.existing && !incoming ? "Nothing imported — existing value kept" : undefined}
        />
      </label>
      {matched && f.existing && (
        <div className="mt-1 text-xs text-slate-600" data-testid={`existing-${f.key}`}>
          <p>
            Existing: <strong className="text-navy-900">{f.existing}</strong>
            {value.trim() ? <> / Imported: <strong className="text-navy-900">{value.trim()}</strong></> : <> — kept (nothing imported)</>}
          </p>
          {conflict && (
            <label className="mt-0.5 flex items-center gap-1.5">
              <input type="checkbox" name="useImported" value={f.key} checked={use} onChange={(e) => setUse(e.target.checked)} className="accent-navy-900" />
              <span>Use imported value</span>
            </label>
          )}
          {conflict && !use && <p className="text-amber-800">Existing value kept unless you tick “Use imported value”.</p>}
        </div>
      )}
    </div>
  );
}

export function ImportRowEditor({
  rowId,
  matched,
  address,
  mailing,
  contact,
  mailingSame,
  existingMailing,
  returnType,
  disabled,
}: {
  rowId: string;
  matched: boolean;
  address: EditorField[];
  mailing: EditorField[];
  contact: EditorField[];
  mailingSame: boolean;
  // How the matched client's mailing address reads now, e.g. "Same as street address".
  existingMailing?: string | null;
  returnType?: { imported: string | null; entered: string | null; existing: string | null; options: [string, string][] } | null;
  disabled?: boolean;
}) {
  const [same, setSame] = useState(mailingSame);
  return (
    <ActionForm action={saveRowEditsAction.bind(null, rowId)} className="space-y-3 text-sm">
      <fieldset disabled={disabled} className="space-y-3">
        <div>
          <p className="mb-1 font-semibold text-navy-900">Physical address</p>
          <div className="grid grid-cols-6 gap-2">{address.map((f) => <FieldEditor key={f.key} f={f} matched={matched} />)}</div>
        </div>
        <div>
          <label className="flex items-start gap-2">
            <input type="checkbox" name="mailingSameAsAddress" value="1" checked={same} onChange={(e) => setSame(e.target.checked)} className="mt-0.5 accent-navy-900" />
            <span>Mailing address is the same as physical address</span>
          </label>
          {matched && existingMailing && <p className="ml-6 text-xs text-slate-600">Existing mailing address: <strong className="text-navy-900">{existingMailing}</strong></p>}
          {!same && <div className="mt-2 grid grid-cols-6 gap-2" data-testid="mailing-fields">{mailing.map((f) => <FieldEditor key={f.key} f={f} matched={matched} />)}</div>}
        </div>
        <div>
          <p className="mb-1 font-semibold text-navy-900">Contact</p>
          <div className="grid grid-cols-6 gap-2">{contact.map((f) => <FieldEditor key={f.key} f={f} matched={matched} />)}</div>
        </div>
        {returnType && (
          <div className="sm:max-w-sm">
            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-navy-900">Return type / filing status</span>
              <select className="input" name="returnType" defaultValue={returnType.entered ?? ""}>
                <option value="">{returnType.imported ? `From the file: ${returnType.options.find(([k]) => k === returnType.imported)?.[1] ?? returnType.imported}` : "Not set — choose one"}</option>
                {returnType.options.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </label>
            {returnType.existing && <p className="mt-1 text-xs text-slate-600">Already on this year&apos;s tax case: <strong className="text-navy-900">{returnType.existing}</strong> (kept)</p>}
            {!returnType.imported && !returnType.existing && <p className="mt-1 text-xs text-amber-800">Not in the file. Client Connect never assumes a filing status.</p>}
          </div>
        )}
        <Button type="submit" variant="secondary">Save row</Button>
      </fieldset>
    </ActionForm>
  );
}
