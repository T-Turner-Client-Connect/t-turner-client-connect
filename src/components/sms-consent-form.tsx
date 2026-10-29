"use client";

import Link from "next/link";
import { startTransition, useActionState } from "react";
import { saveSmsConsentAction, type ConsentState } from "@/app/actions/sms-consent";
import { Button, Field } from "@/components/ui";

export function SmsConsentForm({ serviceText, marketingText }: { serviceText: string; marketingText: string }) {
  const [state, action, pending] = useActionState<ConsentState, FormData>(saveSmsConsentAction, null);

  if (state?.ok) {
    return (
      <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-5 text-emerald-950">
        <p className="font-semibold">Your communication preferences have been saved. You will receive only the message categories you selected. You can unsubscribe from text messages at any time by replying STOP.</p>
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        startTransition(() => action(fd));
      }}
      className="space-y-5"
      aria-busy={pending}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name"><input className="input" name="name" autoComplete="name" required maxLength={120} /></Field>
        <Field label="Mobile phone number"><input className="input" name="phone" type="tel" autoComplete="tel" inputMode="tel" required placeholder="(205) 555-0123" /></Field>
      </div>
      {/* Hidden from people; bots that fill every field are rejected. */}
      <div aria-hidden="true" className="absolute -left-[9999px]">
        <label>Company website<input name="company_website" tabIndex={-1} autoComplete="off" /></label>
      </div>
      <fieldset className="space-y-3">
        <legend className="mb-1 text-sm font-semibold text-navy-900">Choose the messages you would like to receive (optional)</legend>
        <label className="flex items-start gap-3 rounded-xl border border-ivory-200 bg-ivory-50 p-4">
          <input type="checkbox" name="service" className="mt-1 size-5 shrink-0 accent-navy-900" />
          <span>
            <span className="block font-semibold text-navy-900">Service messages</span>
            <span className="text-sm text-slate-700">{serviceText}</span>
          </span>
        </label>
        <label className="flex items-start gap-3 rounded-xl border border-ivory-200 bg-ivory-50 p-4">
          <input type="checkbox" name="marketing" className="mt-1 size-5 shrink-0 accent-navy-900" />
          <span>
            <span className="block font-semibold text-navy-900">Marketing messages</span>
            <span className="text-sm text-slate-700">{marketingText}</span>
          </span>
        </label>
        <p className="text-sm text-slate-700">
          Read our <Link className="font-semibold underline" href="/privacy-policy" target="_blank">Privacy Policy</Link> and{" "}
          <Link className="font-semibold underline" href="/terms" target="_blank">Terms &amp; Conditions</Link>. Text messaging is optional — you can receive our services without agreeing to texts.
        </p>
      </fieldset>
      {state?.error && <p role="alert" className="rounded-lg bg-red-50 px-4 py-3 text-sm font-medium text-red-800">{state.error}</p>}
      <Button type="submit" disabled={pending} className="w-full sm:w-auto">{pending ? "Saving…" : "Save My Preferences"}</Button>
    </form>
  );
}
