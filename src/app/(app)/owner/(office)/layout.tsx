import Link from "next/link";
import { LockKeyhole } from "lucide-react";
import { officeTabs, requireOffice } from "@/lib/auth/owner";

export const metadata = { title: "Owner's Office" };

// Every page below re-checks its own permission too; this gate returns a plain 404 to anyone
// who holds no Owner's Office permission. Tabs show only the areas this person may view.
export default async function OwnerLayout({ children }: { children: React.ReactNode }) {
  const { access } = await requireOffice();
  const tabs = officeTabs(access);
  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center gap-3 rounded-xl bg-navy-900 px-4 py-3 text-white print:hidden">
        <LockKeyhole className="size-5 text-gold-500" aria-hidden />
        <p className="flex-1 text-sm">
          <strong className="font-serif text-base">Owner&apos;s Office</strong>
          <span className="ml-2 text-navy-100">{access.isOwner ? "Private — visible only to you." : "Access granted by the owner."}</span>
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
