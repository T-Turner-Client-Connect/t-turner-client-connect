"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import clsx from "clsx";

export function PortalNav({ accounts, name, signOut }: { accounts: { id: string; name: string }[]; name: string; signOut: () => Promise<void> }) {
  const pathname = usePathname();
  const router = useRouter();
  const sp = useSearchParams();
  const account = sp.get("account") ?? accounts[0]?.id ?? "";
  const q = account ? `?account=${account}` : "";
  const links = [
    ["/client", "Home"],
    ["/client/messages", "Messages"],
    ["/client/documents", "Documents"],
    ["/client/bookkeeping", "Bookkeeping"],
    ["/client/taxes", "Taxes"],
    ["/client/contracts", "Contracts & Signatures"],
    ["/client/billing", "Billing"],
    ["/client/resources", "Resources"],
    ["/client/account", "Account"],
  ] as const;
  return (
    <header className="bg-navy-900 text-white">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
        <Link href={`/client${q}`} className="flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-lg bg-white p-1"><Image src="/brand/logo-mark.png" alt="" width={200} height={224} className="h-auto w-7" /></span>
          <span className="leading-tight">
            <span className="block font-serif text-base font-bold tracking-wide">TTURNER</span>
            <span className="block text-[10px] font-semibold tracking-[0.18em] text-gold-500">CLIENT PORTAL</span>
          </span>
        </Link>
        <div className="flex items-center gap-3 text-sm">
          {accounts.length > 1 && (
            <label className="flex items-center gap-2">
              <span className="sr-only">Account</span>
              <select
                className="rounded-md bg-navy-800 px-2 py-1.5 text-white"
                value={account}
                onChange={(e) => router.push(`${pathname}?account=${e.target.value}`)}
                aria-label="Choose account"
              >
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </label>
          )}
          <span className="hidden sm:inline">{name}</span>
          <form action={signOut}><button className="rounded-md border border-white/30 px-3 py-1.5 hover:bg-white/10">Sign out</button></form>
        </div>
      </div>
      <nav aria-label="Portal" className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-2 pb-2">
        {links.map(([href, label]) => {
          const active = href === "/client" ? pathname === "/client" : pathname.startsWith(href);
          return (
            <Link key={href} href={`${href}${q}`} aria-current={active ? "page" : undefined} className={clsx("whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium", active ? "bg-white text-navy-900" : "text-navy-100 hover:bg-white/10")}>
              {label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
