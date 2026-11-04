"use client";

import { startTransition, useActionState, useEffect, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import Link from "next/link";
import { CopyLink } from "./copy-link";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL } from "@/lib/files";

type State = { error?: string; ok?: string; at?: number; link?: string; next?: { href: string; label: string } } | null;

/**
 * Says what actually went wrong when a form gets no usable answer, instead of
 * always blaming the connection:
 * - Client Connect was updated while the page was open (the button belongs to
 *   the previous version) → reload;
 * - the device is offline → reconnect;
 * - anything else is a server problem → try again / tell the office.
 */
export function actionFailureMessage(err: unknown, online = typeof navigator === "undefined" ? true : navigator.onLine): string {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  if (/server action|older or newer deployment|failed-to-find-server-action/i.test(msg)) {
    return "Client Connect was updated while this page was open, so this button is out of date. Nothing was saved. Reload the page (Ctrl+R or pull down to refresh) and try again.";
  }
  if (!online) return "You appear to be offline, so nothing was saved. Reconnect to the internet and try again.";
  return "Something went wrong on our side and nothing was saved. Please try again in a moment; if it keeps happening, tell the office what you were doing and the time.";
}

export function ActionForm({
  action,
  children,
  className,
  resetOnSuccess,
  showSuccess = true,
  confirm,
  idempotent,
}: {
  action: (prev: State, fd: FormData) => Promise<State>;
  children: ReactNode;
  className?: string;
  resetOnSuccess?: boolean;
  showSuccess?: boolean;
  confirm?: string;
  // Sends an idempotencyKey with the form: the same key on a retry, a new
  // one after each success, so a double-submit can't create a duplicate.
  idempotent?: boolean;
}) {
  // A request that never gets an answer (connection lost, server down) shows an error instead of failing silently.
  const [state, formAction, pending] = useActionState(async (prev: State, fd: FormData): Promise<State> => {
    try {
      return await action(prev, fd);
    } catch (err) {
      return { error: actionFailureMessage(err), at: Date.now() };
    }
  }, null);
  const ref = useRef<HTMLFormElement>(null);
  const keyRef = useRef<string | null>(null);
  // Problems caught before sending (too-large file, connection lost) are shown like server errors.
  const [localError, setLocalError] = useState<string | null>(null);
  useEffect(() => {
    if (state?.ok) keyRef.current = null;
    if (state?.ok && resetOnSuccess) ref.current?.reset();
  }, [state, resetOnSuccess]);
  return (
    <form
      ref={ref}
      className={clsx(className, pending && "opacity-70")}
      aria-busy={pending}
      // Submitting through onSubmit (rather than the action prop) stops React
      // from clearing the form, so a validation error doesn't wipe what was typed.
      onSubmit={(e) => {
        e.preventDefault();
        if (confirm && !window.confirm(confirm)) return;
        // Includes the clicked button's name/value, so a form can have more than one submit button.
        const fd = new FormData(e.currentTarget, (e.nativeEvent as SubmitEvent).submitter);
        const big = [...fd.values()].find((v): v is File => v instanceof File && v.size > MAX_UPLOAD_BYTES);
        if (big) {
          setLocalError(`"${big.name}" is larger than ${MAX_UPLOAD_LABEL}. Nothing was uploaded.`);
          return;
        }
        setLocalError(null);
        if (idempotent) {
          keyRef.current ??= crypto.randomUUID();
          fd.set("idempotencyKey", keyRef.current);
        }
        startTransition(() => formAction(fd));
      }}
    >
      <fieldset disabled={pending} className="contents">
        {children}
      </fieldset>
      {localError && (
        <p role="alert" className="mt-2 rounded-md bg-red-50 px-3 py-2 text-sm font-medium text-red-800">
          {localError}
        </p>
      )}
      {!localError && state?.error && (
        <p role="alert" className="mt-2 rounded-md bg-red-50 px-3 py-2 text-sm font-medium text-red-800">
          {state.error}
          {state.error.startsWith("Client Connect was updated") && (
            <button type="button" onClick={() => window.location.reload()} className="ml-2 underline">Reload page</button>
          )}
        </p>
      )}
      {!localError && state?.ok && showSuccess && !state.error && (
        <p role="status" className="mt-2 text-sm font-medium text-emerald-700">
          {state.ok}
        </p>
      )}
      {state?.ok && state.link && <CopyLink link={state.link} />}
      {state?.next && (
        <Link href={state.next.href} className="mt-2 inline-block text-sm font-semibold text-navy-900 underline decoration-gold-500 underline-offset-4">
          {state.next.label} →
        </Link>
      )}
    </form>
  );
}
