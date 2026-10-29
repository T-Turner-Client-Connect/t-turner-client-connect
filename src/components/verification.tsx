"use client";

import { useActionState, useEffect, useState } from "react";
import clsx from "clsx";
import { Button, Field, Notice } from "@/components/ui";

type State = { error?: string; ok?: string; at?: number } | null;
type Action = (prev: State, fd: FormData) => Promise<State>;
type Method = "authenticator" | "recovery" | "email";

export type Diagnostics = {
  enrolledAt: string | null;
  authenticatorReadable: boolean;
  recoveryCodesRemaining: number;
  emailAvailable: boolean;
  emailReason: string | null;
  maskedEmail: string | null;
  officeTime: string;
};

function CodeForm({ method, action, label, hint, maxLength, remember }: { method: Method; action: Action; label: string; hint: string; maxLength: number; remember?: boolean }) {
  const [state, formAction, pending] = useActionState(action, null);
  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="method" value={method} />
      <Field label={label} hint={hint}>
        <input
          className="input text-center text-xl tracking-[0.3em]"
          name="code"
          inputMode={method === "recovery" ? "text" : "numeric"}
          autoComplete="one-time-code"
          required
          autoFocus
          maxLength={maxLength}
          aria-label={label}
        />
      </Field>
      {remember && (
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="remember" className="mt-1" />
          <span>Remember this device for 30 days (don&apos;t use on shared computers). You can remove it anytime in Account.</span>
        </label>
      )}
      {state?.error && <Notice tone="error">{state.error}</Notice>}
      <Button type="submit" className="w-full" disabled={pending}>{pending ? "Checking…" : "Verify"}</Button>
    </form>
  );
}

function EmailCode({ sendAction, verifyAction, masked }: { sendAction: Action; verifyAction: Action; masked: string }) {
  const [sent, send, sending] = useActionState(sendAction, null);
  // Countdown derived from when the provider accepted the last code (server time stamp).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const wait = sent?.ok && sent.at ? Math.max(0, Math.ceil(60 - (now - sent.at) / 1000)) : 0;
  return (
    <div className="space-y-3">
      {!sent?.ok && <p className="text-sm text-slate-700">We&apos;ll email a 6-digit code to <strong>{masked}</strong>.</p>}
      {sent?.ok && <Notice tone="success">{sent.ok}</Notice>}
      {sent?.error && <Notice tone="error">{sent.error}</Notice>}
      {sent?.ok && <CodeForm method="email" action={verifyAction} label="Code from your email" hint="Single use. Expires in 10 minutes." maxLength={6} remember />}
      <form action={send}>
        {sent?.ok ? (
          <p className="text-center text-sm">
            Didn&apos;t receive a code?{" "}
            <button className="font-semibold underline disabled:no-underline disabled:opacity-60" disabled={sending || wait > 0}>
              {wait > 0 ? `Resend in ${wait}s` : "Resend"}
            </button>
          </p>
        ) : (
          <Button type="submit" variant="secondary" className="w-full" disabled={sending}>{sending ? "Sending…" : "Email me a code"}</Button>
        )}
      </form>
    </div>
  );
}

export function SignInVerification({
  verifyAction,
  sendCodeAction,
  diagnostics: d,
  recovery,
  emailFirst = false,
  authenticatorAvailable = true,
}: {
  verifyAction: Action;
  sendCodeAction: Action;
  diagnostics: Diagnostics;
  recovery: React.ReactNode;
  emailFirst?: boolean;
  authenticatorAvailable?: boolean;
}) {
  // Clients on emailed codes see Email first; an existing authenticator stays as a backup.
  const tabs: { key: Method; label: string }[] = [
    ...(d.emailAvailable && emailFirst ? [{ key: "email" as const, label: "Email code" }] : []),
    ...(authenticatorAvailable ? [{ key: "authenticator" as const, label: "Authenticator app" }] : []),
    ...(d.recoveryCodesRemaining > 0 || !emailFirst ? [{ key: "recovery" as const, label: "Recovery code" }] : []),
    ...(d.emailAvailable && !emailFirst ? [{ key: "email" as const, label: "Email code" }] : []),
  ];
  const [method, setMethod] = useState<Method>(emailFirst && d.emailAvailable ? "email" : d.authenticatorReadable || !d.enrolledAt ? tabs[0].key : "recovery");
  return (
    <div className="space-y-4">
      {!d.authenticatorReadable && d.enrolledAt && !emailFirst && (
        <Notice tone="warn" title="Authenticator codes can't work right now">
          This site can&apos;t read your authenticator setup — usually because the site&apos;s encryption key changed after you set up your app. Your account and data are safe.
          Use a recovery code, or the recovery options under &ldquo;Having trouble signing in?&rdquo;.
        </Notice>
      )}
      <div role="tablist" aria-label="Verification method" className="grid grid-flow-col gap-1 rounded-lg bg-navy-50 p-1">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={method === t.key}
            onClick={() => setMethod(t.key)}
            className={clsx("rounded-md px-2 py-2 text-sm font-semibold", method === t.key ? "bg-white text-navy-900 shadow" : "text-slate-600")}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        {method === "authenticator" && (
          <CodeForm method="authenticator" action={verifyAction} label="6-digit code" hint="Open your authenticator app and enter the current 6-digit code." maxLength={6} />
        )}
        {method === "recovery" && (
          <CodeForm method="recovery" action={verifyAction} label="Recovery code" hint="One of the recovery codes you saved when you set up two-step verification (like ABCDE-12345). Each works once." maxLength={11} />
        )}
        {method === "email" && d.maskedEmail && <EmailCode sendAction={sendCodeAction} verifyAction={verifyAction} masked={d.maskedEmail} />}
      </div>
      <details className="rounded-lg border border-navy-100 p-3 text-sm">
        <summary className="cursor-pointer font-semibold text-navy-900">Having trouble signing in?</summary>
        <ul className="mt-2 space-y-1 text-slate-700" data-testid="mfa-diagnostics">
          <li>Authenticator app: {d.enrolledAt ? `set up ${d.enrolledAt}` : "not set up"}{d.enrolledAt && (d.authenticatorReadable ? " — working" : " — can't be read by this site")}</li>
          <li>Unused recovery codes: {d.recoveryCodesRemaining}</li>
          <li>Email codes: {d.emailAvailable ? `available (to ${d.maskedEmail})` : d.emailReason}</li>
          <li>Text-message codes: not used for sign-in.</li>
          <li>Office time now: {d.officeTime}. If authenticator codes keep failing, make sure your phone&apos;s date and time are set automatically.</li>
        </ul>
        <div className="mt-3 border-t border-navy-100 pt-3">{recovery}</div>
      </details>
    </div>
  );
}

/** Settings card: verify the account's email so email codes can be offered. */
export function VerifyEmailCard({ verified, masked, emailReady, sendAction, confirmAction }: { verified: boolean; masked: string; emailReady: boolean; sendAction: Action; confirmAction: Action }) {
  const [sent, send, sending] = useActionState(sendAction, null);
  const [done, confirm, confirming] = useActionState(confirmAction, null);
  if (verified || done?.ok) return <Notice tone="success">Test code received at {masked} — email delivery confirmed.</Notice>;
  if (!emailReady) return <p className="text-sm text-slate-700">Add the Resend settings in Netlify first (see docs/INTEGRATIONS.md).</p>;
  return (
    <div className="space-y-2">
      <p className="text-sm text-slate-700">We&apos;ll email a test code to {masked}. Entering it proves emails really arrive.</p>
      {sent?.ok && <Notice tone="success">{sent.ok}</Notice>}
      {sent?.error && <Notice tone="error">{sent.error}</Notice>}
      <form action={send}><Button type="submit" variant="secondary" disabled={sending}>{sent?.ok ? "Resend code" : "Email me a code"}</Button></form>
      {sent?.ok && (
        <form action={confirm} className="flex flex-wrap gap-2">
          <input className="input w-40 text-center tracking-[0.3em]" name="code" inputMode="numeric" maxLength={6} required aria-label="Email verification code" />
          <Button type="submit" disabled={confirming}>Verify email</Button>
        </form>
      )}
      {done?.error && <Notice tone="error">{done.error}</Notice>}
    </div>
  );
}
