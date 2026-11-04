import clsx from "clsx";
import { RUN_STATUS } from "@/lib/payroll/fields";

export const money = (c: number) => `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const hours = (h: number) => (h / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const dayOf = (d: Date | string) => new Date(typeof d === "string" ? `${d}T12:00:00Z` : d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
export const whenOf = (d: Date) => d.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" });

const TONE: Record<string, string> = {
  DRAFT: "bg-navy-50 text-navy-800",
  AWAITING_APPROVAL: "bg-gold-100 text-gold-800",
  DENIED: "bg-red-600 text-white",
  FULLY_APPROVED: "bg-emerald-50 text-emerald-700",
  SUBMITTED: "bg-navy-900 text-white",
  PROCESSED: "bg-navy-900 text-white",
  DISCARDED: "bg-slate-100 text-slate-500",
};

/** "Awaiting Approval", or "Approved by Avery" while some (not all) required owners approved. */
export function RunStatus({ status, approvedBy = [], className }: { status: string; approvedBy?: string[]; className?: string }) {
  const label = status === "AWAITING_APPROVAL" && approvedBy.length ? `Approved by ${approvedBy.join(", ")} · awaiting others` : RUN_STATUS[status as keyof typeof RUN_STATUS] ?? status;
  return <span className={clsx("inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold", TONE[status] ?? TONE.DRAFT, className)} data-testid="run-status">{label}</span>;
}

/** The status timeline: Awaiting Approval → Approved by each required owner → Fully Approved → Submitted. */
export function StatusSteps({ status, required, approvedIds }: { status: string; required: { id: string; name: string }[]; approvedIds: string[] }) {
  const reached = (s: string) => {
    const order = ["DRAFT", "AWAITING_APPROVAL", "FULLY_APPROVED", "SUBMITTED"];
    const at = status === "PROCESSED" ? 3 : status === "DENIED" ? 1 : order.indexOf(status);
    return order.indexOf(s) <= at;
  };
  const steps = [
    { key: "a", label: "Awaiting Approval", done: reached("AWAITING_APPROVAL") && status !== "DRAFT" },
    ...required.map((r) => ({ key: r.id, label: `Approved by ${r.name}`, done: approvedIds.includes(r.id) || reached("FULLY_APPROVED") })),
    { key: "f", label: "Fully Approved", done: reached("FULLY_APPROVED") },
    { key: "s", label: status === "PROCESSED" ? "Processed by provider" : "Submitted for Processing", done: reached("SUBMITTED") },
  ];
  return (
    <ol className="flex flex-wrap items-center gap-2" data-testid="status-steps">
      {steps.map((s, i) => (
        <li key={s.key} className="flex items-center gap-2">
          <span className={clsx("flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold", s.done ? "border-emerald-600 bg-emerald-50 text-emerald-800" : status === "DENIED" && i === 1 ? "border-red-600 bg-red-50 text-red-700" : "border-navy-100 bg-white text-slate-500")}>
            <span aria-hidden>{s.done ? "✓" : i + 1}</span> {s.label}
          </span>
          {i < steps.length - 1 && <span className="text-slate-300" aria-hidden>→</span>}
        </li>
      ))}
      {status === "DENIED" && <li><span className="rounded-full bg-red-600 px-3 py-1 text-xs font-semibold text-white">Denied — Needs Review</span></li>}
    </ol>
  );
}
