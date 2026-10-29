"use client";

import { startTransition, useActionState, useEffect, useRef, type ReactNode } from "react";
import clsx from "clsx";

type State = { error?: string; ok?: string; at?: number } | null;

export function ActionForm({
  action,
  children,
  className,
  resetOnSuccess,
  showSuccess = true,
  confirm,
}: {
  action: (prev: State, fd: FormData) => Promise<State>;
  children: ReactNode;
  className?: string;
  resetOnSuccess?: boolean;
  showSuccess?: boolean;
  confirm?: string;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
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
        startTransition(() => formAction(fd));
      }}
    >
      <fieldset disabled={pending} className="contents">
        {children}
      </fieldset>
      {state?.error && (
        <p role="alert" className="mt-2 rounded-md bg-red-50 px-3 py-2 text-sm font-medium text-red-800">
          {state.error}
        </p>
      )}
      {state?.ok && showSuccess && !state.error && (
        <p role="status" className="mt-2 text-sm font-medium text-emerald-700">
          {state.ok}
        </p>
      )}
    </form>
  );
}
