"use client";

import { useState } from "react";
import { PRESET_OVERRIDE_REASON } from "@/lib/tax/accepted";

/** The owner's "filing without an approved summary" reason, with the one-click TaxAct preset (editable). */
export function PresetReason({ name = "overrideReason", label = "Filing without an approved summary? Say why", className }: { name?: string; label?: string; className?: string }) {
  const [v, setV] = useState("");
  return (
    <div className={className}>
      <label className="block">
        <span className="mb-1 block text-sm font-semibold text-navy-900">{label}</span>
        <input className="input" name={name} value={v} onChange={(e) => setV(e.target.value)} />
      </label>
      <button type="button" className="mt-1 text-xs font-semibold underline" onClick={() => setV(PRESET_OVERRIDE_REASON)}>Use: “{PRESET_OVERRIDE_REASON}”</button>
    </div>
  );
}
