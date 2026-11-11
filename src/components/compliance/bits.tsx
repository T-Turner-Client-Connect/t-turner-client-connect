import Link from "next/link";
import clsx from "clsx";
import { ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui";

export const money = (cents: number | null | undefined) => (cents === null || cents === undefined ? "—" : (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" }));
export const fmtD = (d: Date | string | null | undefined) => {
  if (!d) return "—";
  const s = typeof d === "string" ? d : d.toISOString().slice(0, 10);
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(`${s.slice(0, 10)}T00:00:00Z`));
};

/** Shown wherever a date or rule isn't verified: never presented as certain. */
export function NeedsVerification({ title }: { title?: string }) {
  return <Badge tone="amber" className="whitespace-nowrap" ><span title={title ?? "Not confirmed — verify against the official source"} data-testid="needs-verification">Needs verification</span></Badge>;
}

const STATUS_TONE: Record<string, "gray" | "navy" | "gold" | "green" | "red" | "amber"> = {
  "Not Started": "gray", Preparing: "navy", "Awaiting Approval": "gold", Approved: "green", Submitted: "navy", Accepted: "green", Rejected: "red", Overdue: "red", "Not required / no filing": "gray",
};
export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONE[status] ?? "gray"}>{status}</Badge>;
}

export function SwitchesBanner({ clientNotificationsAuthorized, staffEmailReminders, isOwner }: { clientNotificationsAuthorized: boolean; staffEmailReminders: boolean; isOwner: boolean }) {
  if (clientNotificationsAuthorized && staffEmailReminders) return null;
  return (
    <div role="status" data-testid="switches-off-banner" className="mb-4 flex flex-wrap items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950">
      <ShieldAlert className="mt-0.5 size-5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-semibold">Safety switches</p>
        <ul className="mt-1 list-disc pl-5">
          {!clientNotificationsAuthorized && <li><strong>Compliance client notifications: OFF.</strong> No client email, text or portal notice is sent; each is recorded as HELD.</li>}
          {!staffEmailReminders && <li><strong>Compliance staff email reminders: OFF.</strong> Reminders and prep tasks appear in Client Connect only.</li>}
        </ul>
        <p className="mt-1">Nothing here files a return, logs into an agency portal or makes a payment.</p>
      </div>
      {isOwner && <Link href="/compliance/settings" className="font-semibold underline">Switches</Link>}
    </div>
  );
}

export function ComplianceNav({ current, isOwner }: { current: string; isOwner: boolean }) {
  const items = [
    { href: "/compliance", label: "Tax Due Board" },
    { href: "/compliance?view=calendar", label: "Calendar" },
    { href: "/compliance/missing-info", label: "Missing information" },
    { href: "/compliance/rules", label: "Rules library" },
    ...(isOwner ? [{ href: "/compliance/settings", label: "Switches & reminders" }] : []),
  ];
  return (
    <nav aria-label="Tax & Compliance" className="mb-5 flex gap-1 overflow-x-auto rounded-xl border border-navy-100 bg-white p-1">
      {items.map((i) => (
        <Link key={i.href} href={i.href} aria-current={current === i.href ? "page" : undefined} className={clsx("whitespace-nowrap rounded-lg px-4 py-2 text-sm font-semibold", current === i.href ? "bg-navy-900 text-white" : "text-navy-900 hover:bg-navy-50")}>{i.label}</Link>
      ))}
    </nav>
  );
}

export const LABEL: Record<string, string> = { MONTHLY: "Monthly", QUARTERLY: "Quarterly", SEMIANNUAL: "Semiannual", ANNUAL: "Annual", ONE_TIME: "One-time" };
