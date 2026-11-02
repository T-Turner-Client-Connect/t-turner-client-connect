"use client";

import { useState } from "react";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui";

type Option = { method: string; label: string; feeCents: number; totalCents: number; note: string };
type State = { error?: string; ok?: string; at?: number; link?: string; next?: { href: string; label: string } } | null;

const usd = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * The client picks a payment method and sees the fee and total for it before
 * signing. Nothing is preselected: no method, no checkbox. The fingerprint of
 * exactly what's shown is sent with the signature.
 */
export function SignAgreementForm({ action, baseCents, options, hashes, consentText }: { action: (prev: State, fd: FormData) => Promise<State>; baseCents: number; options: Option[]; hashes: Record<string, string>; consentText: string }) {
  const [method, setMethod] = useState("");
  const sel = options.find((o) => o.method === method);
  return (
    <ActionForm action={action} className="space-y-4">
      <fieldset>
        <legend className="mb-2 text-sm font-semibold text-navy-900">Choose how you&apos;ll pay</legend>
        <div className="grid gap-2 sm:grid-cols-2" data-testid="method-options">
          {options.map((o) => (
            <label key={o.method} className={`flex cursor-pointer items-start gap-2 rounded-xl border p-3 text-sm ${method === o.method ? "border-navy-700 bg-navy-50" : "border-ivory-200"}`}>
              <input type="radio" name="method" value={o.method} checked={method === o.method} onChange={() => setMethod(o.method)} className="mt-1" required />
              <span>
                <strong>{o.label}</strong>
                <span className="block text-xs text-slate-600">{o.feeCents ? `Fee ${usd(o.feeCents)} · total ${usd(o.totalCents)}` : `No fee · total ${usd(o.totalCents)}`}</span>
                <span className="block text-xs text-slate-500">{o.note}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="rounded-xl bg-ivory-50 p-3 text-sm" data-testid="selected-total" aria-live="polite">
        {sel ? (
          <dl className="grid grid-cols-2 gap-1">
            <dt>Agreed price</dt><dd className="text-right">{usd(baseCents)}</dd>
            <dt>Processing or transfer fee ({sel.label})</dt><dd className="text-right">{usd(sel.feeCents)}</dd>
            <dt className="font-semibold">Total</dt><dd className="text-right font-semibold" data-testid="total">{usd(sel.totalCents)}</dd>
          </dl>
        ) : (
          <p>Choose a payment method to see your total.</p>
        )}
      </div>
      <input type="hidden" name="shownHash" value={method ? hashes[method] : ""} />
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="agree" className="mt-1" required />
        <span>{consentText}</span>
      </label>
      <label className="block text-sm">
        <span className="mb-1 block font-semibold text-navy-900">Type your full name to sign</span>
        <input className="input" name="signerName" autoComplete="name" required />
      </label>
      <Button type="submit" disabled={!sel}>Sign agreement</Button>
    </ActionForm>
  );
}
