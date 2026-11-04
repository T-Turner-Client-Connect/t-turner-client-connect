"use client";

import { useActionState } from "react";
import Link from "next/link";
import type { UnsubscribeState } from "@/app/actions/unsubscribe";

const ESSENTIAL = "You'll still receive essential account messages — appointment confirmations, billing notices, security codes and tax document requests.";

export function UnsubscribeForm({ action, thisLabel, thisHint }: { action: (prev: UnsubscribeState, fd: FormData) => Promise<UnsubscribeState>; thisLabel: string; thisHint: string }) {
  const [state, formAction, pending] = useActionState(action, null);
  if (state?.ok) {
    return (
      <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-5" data-testid="unsubscribe-done">
        <p className="text-lg font-semibold text-emerald-900">You&apos;re unsubscribed.</p>
        <p className="mt-1 text-emerald-900">
          {state.scope === "ALL" ? "We won't send you promotional emails or general business updates." : `We won't send you ${thisLabel.toLowerCase()} anymore.`} The change takes effect right away.
        </p>
        <p className="mt-3 text-sm text-slate-700">{ESSENTIAL}</p>
        <p className="mt-3 text-sm">
          Changed your mind? <Link className="font-semibold text-navy-900 underline decoration-gold-500 underline-offset-4" href="/client/account#communication-preferences">Sign in to manage your Communication Preferences</Link>.
        </p>
      </div>
    );
  }
  return (
    <form action={formAction} className="space-y-4" aria-busy={pending}>
      <fieldset className="space-y-3" disabled={pending}>
        <legend className="mb-1 font-semibold text-navy-900">What would you like to stop?</legend>
        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-ivory-200 bg-ivory-50 p-4 has-[:checked]:border-gold-500 has-[:checked]:bg-gold-100/40">
          <input type="radio" name="scope" value="THIS" defaultChecked className="mt-1 size-4 accent-navy-900" />
          <span>
            <span className="block font-semibold">{thisLabel}</span>
            <span className="block text-sm text-slate-600">{thisHint}</span>
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-ivory-200 bg-ivory-50 p-4 has-[:checked]:border-gold-500 has-[:checked]:bg-gold-100/40">
          <input type="radio" name="scope" value="ALL" className="mt-1 size-4 accent-navy-900" />
          <span>
            <span className="block font-semibold">All non-essential email</span>
            <span className="block text-sm text-slate-600">Promotional emails and general business updates (office news, closures, announcements).</span>
          </span>
        </label>
      </fieldset>
      <p className="text-sm text-slate-600">{ESSENTIAL}</p>
      {state?.error && <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm font-medium text-red-800">{state.error}</p>}
      <button type="submit" disabled={pending} className="inline-flex min-h-11 items-center justify-center rounded-lg bg-navy-900 px-5 py-2 font-semibold text-white hover:bg-navy-800 disabled:opacity-50">
        {pending ? "Saving…" : "Confirm unsubscribe"}
      </button>
    </form>
  );
}
