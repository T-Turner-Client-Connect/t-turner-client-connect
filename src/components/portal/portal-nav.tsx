"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import clsx from "clsx";
import { Bell, BookOpen, ChevronDown, ClipboardList, CreditCard, FileSearch, Folder, Home, Landmark, Menu, MessageCircle, Newspaper, PenLine, Settings, Users, X } from "lucide-react";
import { Mountains } from "./mountains";

const MAIN = [
  ["/client", "Overview", Home],
  ["/client/tax-center", "My Tax Center", ClipboardList],
  ["/client/documents", "Document Vault", Folder],
  ["/client/messages", "Messages", MessageCircle],
  ["/client/billing", "Invoices", CreditCard],
  ["/client/resources", "Resource Center", BookOpen],
  ["/client/referrals", "Referrals", Users],
] as const;
const MORE = [
  ["/client/taxes/filings", "Tax Filings", FileSearch],
  ["/client/news", "News & Countdowns", Newspaper],
  ["/client/contracts", "Contracts & Signatures", PenLine],
  ["/client/bookkeeping", "Bookkeeping", Landmark],
  ["/client/account", "Account Settings", Settings],
] as const;

function Wordmark({ small }: { small?: boolean }) {
  return (
    <span className="block text-center leading-none">
      <span className={clsx("block font-serif tracking-wide text-white", small ? "text-lg" : "text-[2rem]")}>
        <span className="text-gold-300">T</span>Turner
      </span>
      <span className={clsx("mt-1 block font-semibold tracking-[0.32em] text-navy-100", small ? "text-[8px]" : "text-[10px]")}>CLIENT CONNECT</span>
      {!small && (
        <>
          <span className="mx-auto my-2 block h-px w-28 bg-gradient-to-r from-transparent via-gold-500 to-transparent" />
          <span className="block text-[9px] font-semibold tracking-[0.28em] text-navy-100">TTURNER &amp; ASSOCIATES</span>
        </>
      )}
    </span>
  );
}

function NavLinks({ q, pathname, unread, onNavigate }: { q: string; pathname: string; unread: number; onNavigate?: () => void }) {
  const isActive = (href: string) => (href === "/client" ? pathname === "/client" : pathname === href || (pathname.startsWith(`${href}/`) && href !== "/client/taxes"));
  return (
    <nav aria-label="Portal" className="space-y-1 px-3">
      {MAIN.map(([href, label, Icon]) => (
        <Link
          key={href}
          href={`${href}${q}`}
          onClick={onNavigate}
          aria-current={isActive(href) ? "page" : undefined}
          className={clsx(
            "flex items-center gap-3 rounded-lg px-3 py-2.5 text-[15px] transition-colors",
            isActive(href) ? "bg-gradient-to-r from-gold-600/90 to-gold-500/70 font-semibold text-white shadow" : "text-navy-100 hover:bg-white/10 hover:text-white",
          )}
        >
          <Icon className="size-5 shrink-0" aria-hidden />
          <span className="flex-1">{label}</span>
          {href === "/client/messages" && unread > 0 && <span className="rounded-full bg-gold-500 px-2 py-0.5 text-[11px] font-bold text-navy-950">{unread}</span>}
        </Link>
      ))}
      <div className="mx-3 my-4 h-px bg-white/15" aria-hidden />
      {MORE.map(([href, label, Icon]) => (
        <Link
          key={href}
          href={`${href}${q}`}
          onClick={onNavigate}
          aria-current={isActive(href) ? "page" : undefined}
          className={clsx("flex items-center gap-3 rounded-lg px-3 py-1.5 text-[13px]", isActive(href) ? "bg-white/15 font-semibold text-white" : "text-navy-100/80 hover:bg-white/10 hover:text-white")}
        >
          <Icon className="size-4 shrink-0" aria-hidden />
          {label}
        </Link>
      ))}
    </nav>
  );
}

/** Client portal frame: navy sidebar on large screens, top bar with a menu drawer on phones. */
export function PortalNav({ accounts, name, unread, signOut }: { accounts: { id: string; name: string }[]; name: string; unread: number; signOut: () => Promise<void> }) {
  const pathname = usePathname();
  const router = useRouter();
  const sp = useSearchParams();
  const account = sp.get("account") ?? accounts[0]?.id ?? "";
  const q = account ? `?account=${account}` : "";
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  // Close the drawer and menu after navigating.
  const [seenPath, setSeenPath] = useState(pathname);
  if (seenPath !== pathname) {
    setSeenPath(pathname);
    setOpen(false);
    setMenu(false);
  }
  const initials = name.split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase();

  const sidebar = (onNavigate?: () => void) => (
    <div className="relative flex h-full flex-col overflow-hidden bg-gradient-to-b from-navy-950 via-navy-900 to-navy-900 text-white">
      <div className="px-6 pb-6 pt-8">
        <Link href={`/client${q}`} onClick={onNavigate} className="block">
          <span className="mx-auto mb-3 flex size-11 items-center justify-center rounded-xl bg-white p-1.5 shadow ring-1 ring-gold-300"><Image src="/brand/logo-mark.png" alt="" width={200} height={224} className="h-auto w-7" /></span>
          <Wordmark />
        </Link>
      </div>
      <NavLinks q={q} pathname={pathname} unread={unread} onNavigate={onNavigate} />
      <div className="relative mt-auto min-h-56 flex-1">
        <Mountains variant="dark" className="absolute inset-x-0 bottom-0 h-56 w-full" />
        <div className="absolute bottom-6 left-6 text-[11px] font-semibold leading-6 tracking-[0.35em] text-navy-100/90">
          <span className="mb-3 block h-px w-8 bg-gold-500" />
          YOUR<br />SUCCESS<br />BUILDS<br />BRIGHTER<br />TOMORROWS
          <span className="mt-3 block h-px w-8 bg-gold-500" />
        </div>
      </div>
    </div>
  );

  const topRight = (
    <div className="flex items-center gap-3">
      <Link href={`/client/messages${q}`} className="relative rounded-full p-2 text-navy-900 hover:bg-navy-50" aria-label={unread ? `${unread} unread messages` : "Messages"}>
        <Bell className="size-5" />
        {unread > 0 && <span className="absolute right-1 top-1 size-2.5 rounded-full bg-gold-500 ring-2 ring-white" />}
      </Link>
      <div className="relative">
        <button type="button" onClick={() => setMenu((m) => !m)} className="flex items-center gap-2 rounded-full py-1 pl-1 pr-2 hover:bg-navy-50" aria-expanded={menu} aria-haspopup="menu">
          <span className="flex size-9 items-center justify-center rounded-full bg-navy-900 text-sm font-semibold text-gold-300 ring-2 ring-gold-500/60">{initials}</span>
          <span className="hidden text-sm font-medium text-navy-900 sm:inline">{name.split(" ")[0]}</span>
          <ChevronDown className="hidden size-4 text-navy-700 sm:block" />
        </button>
        {menu && (
          <div role="menu" className="absolute right-0 z-40 mt-2 w-64 rounded-xl border border-ivory-200 bg-white p-2 text-sm shadow-xl">
            {accounts.length > 1 && (
              <label className="mb-2 block px-2 pt-1">
                <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">Account</span>
                <select className="input" value={account} onChange={(e) => router.push(`${pathname}?account=${e.target.value}`)} aria-label="Choose account">
                  {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </label>
            )}
            <Link href={`/client/account${q}`} className="block rounded-lg px-3 py-2 hover:bg-navy-50" role="menuitem">Account settings</Link>
            <form action={signOut}><button className="w-full rounded-lg px-3 py-2 text-left hover:bg-navy-50" role="menuitem">Sign out</button></form>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <>
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 lg:block">{sidebar()}</aside>
      <header className="sticky top-0 z-20 border-b border-ivory-200 bg-ivory-50/85 backdrop-blur lg:ml-64">
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 sm:px-8">
          <div className="flex items-center gap-3 lg:hidden">
            <button type="button" onClick={() => setOpen(true)} className="rounded-lg p-2 text-navy-900 hover:bg-navy-50" aria-label="Open menu"><Menu className="size-6" /></button>
            <Link href={`/client${q}`} className="rounded-lg bg-navy-900 px-3 py-1.5"><Wordmark small /></Link>
          </div>
          <span className="hidden lg:block" />
          {topRight}
        </div>
      </header>
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <button type="button" className="absolute inset-0 bg-navy-950/60" onClick={() => setOpen(false)} aria-label="Close menu" />
          <div className="absolute inset-y-0 left-0 w-72 max-w-[85vw] shadow-2xl">
            {sidebar(() => setOpen(false))}
            <button type="button" onClick={() => setOpen(false)} className="absolute right-3 top-3 rounded-lg p-2 text-white hover:bg-white/10" aria-label="Close menu"><X className="size-5" /></button>
          </div>
        </div>
      )}
    </>
  );
}
