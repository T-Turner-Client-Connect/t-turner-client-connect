"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import clsx from "clsx";
import { Bell, BookOpen, CalendarDays, ChevronDown, ClipboardCheck, ClipboardList, CreditCard, FileSearch, FileSignature, FileText, Folder, HeartHandshake, Home, Landmark, Megaphone, Menu, MessageCircle, Newspaper, PenLine, Settings, ShieldCheck, Users, X } from "lucide-react";
import { Mountains } from "./mountains";

const MAIN = [
  ["/client", "Overview", Home],
  ["/client/tax-center", "My Tax Center", ClipboardList],
  ["/client/documents", "Document Vault", Folder],
  ["/client/identity", "Identity Documents", ShieldCheck],
  ["/client/messages", "Messages", MessageCircle],
  ["/client/billing", "Invoices", CreditCard],
  ["/client/agreements", "Pricing Agreements", FileSignature],
  ["/client/nonprofit", "Nonprofit Portfolio", HeartHandshake],
  ["/client/resources", "Resource Center", BookOpen],
  ["/client/referrals", "Referrals", Users],
] as const;
// The five headline destinations shown across the top bar on larger screens.
// Appointments goes to a prefilled request to the office until online scheduling ships.
const TOP = [
  ["/client", "Home", Home],
  ["/client/tax-center", "My Tax Center", FileText],
  ["/client/documents", "Documents", Folder],
  ["/client/messages?new=appointment", "Appointments", CalendarDays],
  ["/client/news", "News & Updates", Megaphone],
] as const;
const MORE = [
  ["/client/taxes/summary", "Tax Summary & Approval", ClipboardCheck],
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
          <span className="block text-[9px] font-semibold tracking-[0.2em] text-navy-100">T. TURNER &amp; ASSOCIATES, LLC</span>
        </>
      )}
    </span>
  );
}

function NavLinks({ q, pathname, unread, onNavigate, business }: { q: string; pathname: string; unread: number; onNavigate?: () => void; business: boolean }) {
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
      {MORE.filter(([href]) => business || href !== "/client/bookkeeping").map(([href, label, Icon]) => (
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
type Account = { id: string; name: string; personal?: boolean; owner?: string | null; business?: boolean };

/** Business tabs: Personal first, then each business this login may open. The selected one is always named. */
function AccountTabs({ accounts, current, pathname }: { accounts: Account[]; current: string; pathname: string }) {
  if (accounts.length < 2) return null;
  const sorted = [...accounts.filter((a) => a.personal), ...accounts.filter((a) => !a.personal)];
  const selected = accounts.find((a) => a.id === current);
  return (
    <div className="border-b border-ivory-200 bg-white/90 px-4 py-2 sm:px-8" data-testid="account-tabs">
      <nav aria-label="Your accounts" className="flex gap-2 overflow-x-auto pb-1">
        {sorted.map((a) => (
          <Link key={a.id} href={`${pathname}?account=${a.id}`} aria-current={a.id === current ? "page" : undefined} className={clsx("shrink-0 rounded-full px-3 py-1.5 text-sm font-semibold", a.id === current ? "bg-navy-900 text-gold-300 ring-2 ring-gold-500" : "bg-ivory-50 text-navy-900 ring-1 ring-ivory-200 hover:bg-gold-100")}>
            {a.personal ? `Personal — ${a.name}` : a.name}
          </Link>
        ))}
      </nav>
      {selected && (
        <div className="pt-1" data-testid="viewing-account">
          <p className="font-serif text-lg font-bold leading-tight text-navy-900 sm:text-xl">{selected.personal ? `Personal — ${selected.name}` : selected.name}</p>
          {selected.owner && <p className="text-sm text-slate-600" data-testid="viewing-owner">Owner: {selected.owner}</p>}
        </div>
      )}
    </div>
  );
}

export function PortalNav({ accounts, name, unread, signOut }: { accounts: Account[]; name: string; unread: number; signOut: () => Promise<void> }) {
  const pathname = usePathname();
  const router = useRouter();
  const sp = useSearchParams();
  const account = sp.get("account") ?? accounts[0]?.id ?? "";
  const q = account ? `?account=${account}` : "";
  // Bookkeeping link only for a Managed Business this login may see (the page and data are gated on the server too).
  const business = !!accounts.find((a) => a.id === account)?.business;
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const [more, setMore] = useState(false);
  // Close the drawer and menu after navigating.
  const [seenPath, setSeenPath] = useState(pathname);
  if (seenPath !== pathname) {
    setSeenPath(pathname);
    setOpen(false);
    setMenu(false);
    setMore(false);
  }
  const initials = name.split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase();

  const sidebar = (onNavigate?: () => void) => (
    <div className="relative flex h-full flex-col overflow-hidden bg-gradient-to-b from-navy-950 via-navy-900 to-navy-900 text-white">
      <div className="px-6 pb-6 pt-8">
        <Link href={`/client${q}`} onClick={onNavigate} className="block">
          <span className="mx-auto mb-3 flex size-12 items-center justify-center rounded-xl bg-white p-1.5 shadow ring-1 ring-gold-300"><Image src="/brand/logo-shield.png" alt="" width={353} height={400} className="h-auto w-8" /></span>
          <Wordmark />
        </Link>
      </div>
      <NavLinks q={q} pathname={pathname} unread={unread} onNavigate={onNavigate} business={business} />
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

  const isActive = (href: string) => {
    const path = href.split("?")[0];
    if (href.includes("new=appointment")) return pathname === "/client/messages" && sp.get("new") === "appointment";
    return path === "/client" ? pathname === "/client" : pathname === path || (pathname.startsWith(`${path}/`) && path !== "/client/taxes");
  };
  const withQ = (href: string) => (href.includes("?") ? `${href}${account ? `&account=${account}` : ""}` : `${href}${q}`);
  const allMore = [...MAIN.filter(([h]) => !TOP.some(([t]) => t.split("?")[0] === h)), ...MORE].filter(([href]) => business || href !== "/client/bookkeeping");

  return (
    <>
      {/* Navy top bar with the firm's shield logo and a thin gold rule. */}
      <header className="sticky top-0 z-30 border-b-2 border-gold-500 bg-gradient-to-b from-navy-950 to-navy-900 text-white shadow-[0_6px_20px_-12px_rgb(10_26_68/0.6)]" data-testid="portal-topbar">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-2.5 sm:px-6">
          <button type="button" onClick={() => setOpen(true)} className="rounded-lg p-2 text-white hover:bg-white/10 lg:hidden" aria-label="Open menu"><Menu className="size-6" /></button>
          <Link href={`/client${q}`} className="flex min-w-0 items-center gap-3" aria-label="TTurner Client Connect — home">
            <Image src="/brand/logo-shield.png" alt="" width={353} height={400} priority className="h-11 w-auto shrink-0 drop-shadow-[0_0_1px_rgb(200_157_41)] rounded-sm bg-white/95 p-1 sm:h-12" />
            <span className="min-w-0 leading-none">
              <span className="block whitespace-nowrap font-serif text-lg tracking-[0.08em] text-white sm:text-2xl">TTURNER</span>
              <span className="mt-0.5 block whitespace-nowrap font-serif text-[11px] tracking-[0.12em] text-white/90 sm:text-sm">CLIENT CONNECT</span>
            </span>
          </Link>
          <span className="mx-2 hidden h-10 w-px shrink-0 bg-gold-500/70 xl:block" aria-hidden />
          <span className="hidden shrink-0 whitespace-nowrap leading-none xl:block">
            <span className="block font-serif text-[15px] tracking-[0.06em] text-white">T. TURNER &amp; ASSOCIATES, LLC</span>
            <span className="mt-1.5 block text-[10px] font-semibold tracking-[0.42em] text-gold-300">SECURE CLIENT PORTAL</span>
          </span>
          <nav aria-label="Portal" className="ml-auto hidden items-stretch gap-0.5 lg:flex">
            {TOP.map(([href, label, Icon]) => (
              <Link
                key={href}
                href={withQ(href)}
                aria-current={isActive(href) ? "page" : undefined}
                className={clsx(
                  "flex flex-col items-center justify-center gap-1 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-[13px] transition-colors xl:px-3.5",
                  isActive(href) ? "bg-gold-500/20 font-semibold text-white ring-1 ring-gold-500" : "text-navy-100 hover:bg-white/10 hover:text-white",
                )}
              >
                <Icon className="size-5" aria-hidden />
                {label}
              </Link>
            ))}
            <div className="relative">
              <button type="button" onClick={() => { setMore((m) => !m); setMenu(false); }} className="flex h-full flex-col items-center justify-center gap-1 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-[13px] text-navy-100 hover:bg-white/10 hover:text-white" aria-expanded={more} aria-haspopup="menu">
                <ChevronDown className="size-5" aria-hidden />More
              </button>
              {more && (
                <div role="menu" className="absolute right-0 z-40 mt-2 w-64 rounded-xl border border-ivory-200 bg-white p-2 text-sm text-navy-900 shadow-xl">
                  {allMore.map(([href, label, Icon]) => (
                    <Link key={href} href={withQ(href)} role="menuitem" className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-gold-100">
                      <Icon className="size-4 text-gold-700" aria-hidden />
                      <span className="flex-1">{label}</span>
                      {href === "/client/messages" && unread > 0 && <span className="rounded-full bg-gold-500 px-2 py-0.5 text-[11px] font-bold text-navy-950">{unread}</span>}
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </nav>
          <div className="ml-auto flex items-center gap-1 lg:ml-2">
            <Link href={`/client/messages${q}`} className="relative rounded-full p-2 text-white hover:bg-white/10" aria-label={unread ? `${unread} unread messages` : "Messages"}>
              <Bell className="size-5" />
              {unread > 0 && <span className="absolute right-1 top-1 size-2.5 rounded-full bg-gold-500 ring-2 ring-navy-950" />}
            </Link>
            <div className="relative">
              <button type="button" onClick={() => { setMenu((m) => !m); setMore(false); }} className="rounded-full p-0.5" aria-expanded={menu} aria-haspopup="menu" aria-label="Your account">
                <span className="flex size-10 items-center justify-center rounded-full border-2 border-gold-500 font-serif text-base text-gold-300">{initials}</span>
              </button>
              {menu && (
                <div role="menu" className="absolute right-0 z-40 mt-2 w-64 rounded-xl border border-ivory-200 bg-white p-2 text-sm text-navy-900 shadow-xl">
                  <p className="px-3 pb-2 pt-1 text-xs text-slate-500">Signed in as <strong className="text-navy-900">{name}</strong></p>
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
        </div>
      </header>
      <AccountTabs accounts={accounts} current={account} pathname={pathname} />
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
