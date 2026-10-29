"use client";

import { useTransition, type ReactNode } from "react";
import { buttonClass } from "@/components/ui";

/** Runs a Server Action after a confirmation prompt. */
export function ConfirmButton({
  action,
  confirm,
  children,
  variant = "secondary",
  className,
}: {
  action: () => Promise<void>;
  confirm?: string;
  children: ReactNode;
  variant?: "primary" | "secondary" | "danger" | "ghost" | "gold";
  className?: string;
}) {
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      className={buttonClass(variant, className)}
      onClick={() => {
        if (confirm && !window.confirm(confirm)) return;
        start(() => action());
      }}
    >
      {pending ? "Working…" : children}
    </button>
  );
}
