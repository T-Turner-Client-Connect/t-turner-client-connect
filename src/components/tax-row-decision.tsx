"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { decideTaxRowAction } from "@/app/actions/tax";

export function TaxRowDecision({ rowId, value, options }: { rowId: string; value: string | null; options: { value: string; label: string }[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      <select
        className="input"
        aria-label="Decision"
        value={value ?? ""}
        disabled={pending}
        onChange={(e) =>
          start(async () => {
            const r = await decideTaxRowAction(rowId, e.target.value);
            setError(r?.error ?? null);
            router.refresh();
          })
        }
      >
        {!value && <option value="">Choose…</option>}
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {error && <p className="mt-1 text-xs text-red-700">{error}</p>}
    </div>
  );
}
