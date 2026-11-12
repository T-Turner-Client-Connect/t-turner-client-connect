import Link from "next/link";
import { ChevronDown, Layers, LockKeyhole } from "lucide-react";
import { officeTabs, requireOffice } from "@/lib/auth/owner";

export const metadata = { title: "Owner's Office" };

// Every page below re-checks its own permission too; this gate returns a plain 404 to anyone
// who holds no Owner's Office permission. The menu lists only the areas this person may view.
export default async function OwnerLayout({ children }: { children: React.ReactNode }) {
  const { access } = await requireOffice();
  const tabs = officeTabs(access);
  return (
    <div>
      <div className="mb-5 space-y-3 print:hidden">
        <div className="relative flex items-center gap-4 overflow-hidden rounded-2xl bg-gradient-to-br from-navy-900 to-navy-800 px-5 py-5 text-white shadow-md" data-testid="office-banner">
          <LockKeyhole className="size-8 shrink-0 text-gold-500" aria-hidden />
          <span className="h-12 w-px bg-white/25" aria-hidden />
          <div>
            <p className="font-serif text-2xl font-bold leading-tight">Owner&apos;s Office</p>
            <p className="text-sm text-navy-100">{access.isOwner ? "Private — visible only to you." : "Access granted by the owner."}</p>
          </div>
        </div>
        <details className="group rounded-2xl border border-ivory-200 bg-white shadow-sm" data-testid="office-quick-nav">
          <summary className="flex cursor-pointer list-none items-center gap-4 px-5 py-4 [&::-webkit-details-marker]:hidden">
            <Layers className="size-7 shrink-0 text-navy-900" aria-hidden />
            <span className="flex-1">
              <span className="block font-serif text-lg font-bold text-navy-900">Quick navigation</span>
              <span className="block text-sm text-slate-600">Access all Owner&apos;s Office sections</span>
            </span>
            <ChevronDown className="size-5 text-navy-900 transition-transform group-open:rotate-180" aria-hidden />
          </summary>
          <nav aria-label="Owner's Office" className="grid gap-1 border-t border-ivory-200 p-3 sm:grid-cols-2 lg:grid-cols-3">
            {tabs.map((t) => (
              <Link key={t.href} href={t.href} className="rounded-lg px-3 py-2 text-sm font-semibold text-navy-900 hover:bg-ivory-100">{t.label}</Link>
            ))}
          </nav>
        </details>
      </div>
      {children}
    </div>
  );
}
