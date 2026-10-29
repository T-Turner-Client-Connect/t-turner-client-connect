"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setRowDecisionAction } from "@/app/actions/imports";

export function DecisionSelect({
  rowId,
  value,
  options,
  disabled,
}: {
  rowId: string;
  value: string | null;
  options: { value: string; label: string }[];
  disabled?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      <select
        className="input"
        aria-label="What to do with this row"
        value={value ?? ""}
        disabled={disabled || pending}
        onChange={(e) =>
          start(async () => {
            const res = await setRowDecisionAction(rowId, e.target.value);
            setError(res?.error ?? null);
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
