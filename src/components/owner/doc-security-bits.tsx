import clsx from "clsx";
import { CheckCircle2, CircleSlash } from "lucide-react";
import type { ReactNode } from "react";

export const securityCard = "min-w-0 rounded-2xl border border-gold-200/80 bg-gradient-to-b from-white to-ivory-50 p-5 shadow-[0_14px_32px_-24px_rgb(10_26_68/0.45)] sm:p-6";

export function fmtBytes(n: number | bigint | null | undefined) {
  const v = Number(n ?? 0);
  if (v < 1024) return `${v} B`;
  if (v < 1048576) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1073741824) return `${(v / 1048576).toFixed(1)} MB`;
  return `${(v / 1073741824).toFixed(2)} GB`;
}

export function Check({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-sm text-navy-900">
      {ok ? <CheckCircle2 className="mt-0.5 size-5 shrink-0 fill-emerald-600 text-white" aria-hidden /> : <CircleSlash className="mt-0.5 size-5 shrink-0 text-gold-600" aria-hidden />}
      <span className="min-w-0 break-words">
        {children}
        <span className="sr-only">{ok ? " (done)" : " (not yet)"}</span>
      </span>
    </li>
  );
}

export function Switch({ on, label, testId }: { on: boolean; label: string; testId: string }) {
  return (
    <span className="inline-flex items-center gap-3" data-testid={testId} data-on={on ? "true" : "false"}>
      <span aria-hidden className={clsx("relative inline-flex h-7 w-12 items-center rounded-full ring-1 transition", on ? "bg-emerald-600 ring-emerald-700" : "bg-slate-200 ring-slate-300")}>
        <span className={clsx("absolute size-5 rounded-full bg-white shadow transition", on ? "left-6" : "left-1")} />
      </span>
      <span className="font-semibold text-navy-900">
        {label}: {on ? "On" : "Off"}
      </span>
    </span>
  );
}

export function StatusPill({ status }: { status: string }) {
  const tone = status === "SUCCEEDED" || status === "PASSED" || status === "COMPLETED" || status === "MIGRATED" ? "bg-emerald-50 text-emerald-800" : status === "FAILED" ? "bg-red-50 text-red-800" : status === "RUNNING" ? "bg-gold-100 text-gold-700" : "bg-slate-100 text-slate-700";
  const label: Record<string, string> = { SUCCEEDED: "Succeeded", PASSED: "Passed", FAILED: "Failed", RUNNING: "Running", COMPLETED: "Completed", PAUSED: "Paused", MIGRATED: "Moved" };
  return <span className={clsx("inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold", tone)}>{label[status] ?? status}</span>;
}
