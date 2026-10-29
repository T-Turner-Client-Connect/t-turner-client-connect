"use client";

import { useActionState } from "react";
import Link from "next/link";
import { Button, Field, Notice } from "@/components/ui";

type State = { error?: string; ok?: string; codes?: string[] } | null;

export function MfaSetupForm({ action, continueHref }: { action: (p: State, fd: FormData) => Promise<State>; continueHref: string }) {
  const [state, formAction, pending] = useActionState(action, null);
  if (state?.codes?.length) {
    return (
      <div className="space-y-4">
        <Notice tone="success" title="Two-step verification is on">
          Save these recovery codes somewhere safe (not on your phone). Each works once if you lose access to your authenticator app. They won&apos;t be shown again.
        </Notice>
        <ul className="grid grid-cols-2 gap-2 rounded-lg bg-navy-50 p-3 font-mono text-sm" data-testid="recovery-codes">
          {state.codes.map((c) => <li key={c}>{c}</li>)}
        </ul>
        <Link href={continueHref} className="block rounded-lg bg-navy-900 px-4 py-2 text-center font-semibold text-white">I&apos;ve saved them — continue</Link>
      </div>
    );
  }
  return (
    <form action={formAction} className="space-y-4">
      <Field label="Enter the 6-digit code shown in the app">
        <input className="input text-center text-xl tracking-[0.3em]" name="code" inputMode="numeric" autoComplete="one-time-code" required maxLength={6} />
      </Field>
      {state?.error && <Notice tone="error">{state.error}</Notice>}
      <Button type="submit" className="w-full" disabled={pending}>{pending ? "Checking…" : "Turn on two-step verification"}</Button>
    </form>
  );
}
