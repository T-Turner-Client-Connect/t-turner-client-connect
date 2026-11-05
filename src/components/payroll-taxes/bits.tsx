import Link from "next/link";
import clsx from "clsx";
import { AlertTriangle, BellOff } from "lucide-react";
import { Badge } from "@/components/ui";
import { QUEUE_STATUS, type QueueStatus } from "@/lib/payroll/queue";
import { countdown } from "@/lib/payroll/schedule";

export const fmtDay = (s: string | Date) => new Date(typeof s === "string" ? `${s}T12:00:00Z` : s).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
export const fmtWhen = (d: Date) => d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" });

export function QueueBadge({ status }: { status: QueueStatus }) {
  const s = QUEUE_STATUS[status];
  return <Badge tone={s.tone} className="whitespace-nowrap">{s.label}</Badge>;
}

export function VersionTag({ n }: { n: number | null | undefined }) {
  if (!n) return null;
  return <span className="inline-flex items-center rounded-md border border-navy-900 bg-white px-1.5 text-xs font-bold text-navy-900" data-testid="version-tag">v{n}</span>;
}

export function Countdown({ days, overdue }: { days: number | null; overdue?: boolean }) {
  if (days === null) return null;
  return <span className={clsx("text-xs font-semibold", overdue || days < 0 ? "text-red-700" : days <= 1 ? "text-amber-700" : "text-slate-600")}>{countdown(days)}</span>;
}

export function OverdueFlag() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-red-600 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-white" data-testid="overdue-flag">
      <AlertTriangle className="size-3" aria-hidden /> Overdue
    </span>
  );
}

/** Shown on every workspace page while automated client reminders are off. */
export function RemindersOffBanner({ isOwner }: { isOwner: boolean }) {
  return (
    <div role="status" className="mb-4 flex flex-wrap items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950" data-testid="reminders-off-banner">
      <BellOff className="mt-0.5 size-5 shrink-0 text-amber-700" aria-hidden />
      <p className="min-w-0 flex-1">
        <strong>Automated client reminders are off.</strong> Hours requests and approval reminders are recorded as <em>held</em> and never sent until
        {isOwner ? " you turn on " : " the owner turns on "}“Payroll &amp; tax client reminders authorized” (and the client&apos;s own reminders switch). Staff alerts and the manual “Send for client approval” still work as before.
      </p>
      <Link href="/payroll-taxes/settings" className="font-semibold underline decoration-amber-600 underline-offset-4">Reminder settings</Link>
    </div>
  );
}
