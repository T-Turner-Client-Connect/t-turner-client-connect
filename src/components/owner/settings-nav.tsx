import Link from "next/link";
import clsx from "clsx";
import { billingSettingsVisible, staffAccessVisible } from "@/lib/auth/owner";
import type { OfficeAccess } from "@/lib/auth/permissions";

/** Owner's Office → Settings sub-tabs; each shows only to staff who may open it. */
export function SettingsNav({ access, current }: { access: OfficeAccess; current: "billing" | "staff" }) {
  const tabs = [
    { key: "billing", href: "/owner/settings", label: "Billing settings", show: billingSettingsVisible(access) },
    { key: "staff", href: "/owner/settings/staff-access", label: "Staff Access & Permissions", show: staffAccessVisible(access) },
  ].filter((t) => t.show);
  return (
    <nav aria-label="Settings sections" className="-mt-2 mb-5 flex flex-wrap gap-1 rounded-xl bg-white p-1 shadow-sm ring-1 ring-ivory-200">
      {tabs.map((t) => (
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
