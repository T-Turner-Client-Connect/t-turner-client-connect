import Link from "next/link";
import { LockKeyhole } from "lucide-react";
import { requireOwner } from "@/lib/auth/owner";

export const metadata = { title: "Owner's Office" };

// Every page below re-checks access too; this gate returns a plain 404 to everyone else.
export default async function OwnerLayout({ children }: { children: React.ReactNode }) {
  const { access } = await requireOwner("billing");
  const tabs = [
    ...(access.scope === "FULL" ? [{ href: "/owner", label: "Overview" }] : []),
    { href: "/owner/invoices", label: "Quotes & invoices" },
    ...(access.scope === "FULL" ? [{ href: "/owner/expenses", label: "Expenses" }, { href: "/owner/settings", label: "Billing settings & access" }] : []),
  ];
  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center gap-3 rounded-xl bg-navy-900 px-4 py-3 text-white">
        <LockKeyhole className="size-5 text-gold-500" aria-hidden />
        <p className="flex-1 text-sm">
          <strong className="font-serif text-base">Owner&apos;s Office</strong>
          <span className="ml-2 text-navy-100">{access.scope === "FULL" ? "Private — visible only to you." : "Billing access delegated by the owner."}</span>
        </p>
        <nav aria-label="Owner's Office" className="flex flex-wrap gap-1">
          {tabs.map((t) => (
            <Link key={t.href} href={t.href} className="rounded-md px-3 py-1.5 text-sm font-semibold text-navy-100 hover:bg-white/10 hover:text-white">{t.label}</Link>
          ))}
        </nav>
      </div>
      {children}
    </div>
  );
}
