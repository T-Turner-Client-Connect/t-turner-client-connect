import Link from "next/link";
import clsx from "clsx";

export type AdpTab = "overview" | "referrals" | "statements" | "payments" | "reports";

const TABS: { key: AdpTab; href: string; label: string }[] = [
  { key: "overview", href: "/owner/adp-revenue-share", label: "Overview" },
  { key: "referrals", href: "/owner/adp-revenue-share/referrals", label: "Referrals" },
  { key: "statements", href: "/owner/adp-revenue-share/statements", label: "Statements" },
  { key: "payments", href: "/owner/adp-revenue-share/payments", label: "Payments" },
  { key: "reports", href: "/owner/adp-revenue-share/reports", label: "Reports" },
];

/** Owner's Office → ADP Revenue Share tabs (owner only, like the pages themselves). */
export function AdpNav({ current }: { current: AdpTab }) {
  return (
    <nav aria-label="ADP Revenue Share sections" className="-mt-2 mb-5 flex flex-wrap gap-1 rounded-xl bg-white p-1 shadow-sm ring-1 ring-ivory-200 print:hidden" data-testid="adp-tabs">
      {TABS.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={t.key === current ? "page" : undefined}
          className={clsx("rounded-lg px-3 py-2 text-sm font-semibold", t.key === current ? "bg-navy-900 text-white" : "text-navy-900 hover:bg-navy-50")}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

/** Small "Final" / "Draft" pill used on statement lists and pages. */
export function StatementStatus({ status }: { status: string }) {
  return status === "FINAL" ? (
    <span className="inline-flex items-center rounded-full bg-navy-900 px-2.5 py-0.5 text-xs font-semibold text-white">Final</span>
  ) : (
    <span className="inline-flex items-center rounded-full bg-gold-100 px-2.5 py-0.5 text-xs font-semibold text-gold-700">Draft</span>
  );
}
