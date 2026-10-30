"use client";

import { startTransition, useActionState, useEffect, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import Link from "next/link";
import { CopyLink } from "./copy-link";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL } from "@/lib/files";

type State = { error?: string; ok?: string; at?: number; link?: string; next?: { href: string; label: string } } | null;

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
    } catch {
      return { error: "The form couldn't reach the server, so nothing was saved. Check your connection and try again.", at: Date.now() };
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
        const fd = new FormData(e.currentTarget);
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
