"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import clsx from "clsx";
import { Bell, BookOpen, CalendarDays, ClipboardCheck, ClipboardList, CreditCard, FileSearch, FileSignature, Folder, HeartHandshake, Home, Landmark, LogOut, Megaphone, Menu, MessageCircle, PenLine, Settings, ShieldCheck, Upload, Users, X } from "lucide-react";

const MAIN = [
  ["/client", "Home", Home],
  ["/client/tax-center", "My Tax Center", ClipboardList],
  ["/client/tax-center/upload", "Upload Documents", Upload],
  ["/client/documents", "Document Vault", Folder],
  ["/client/identity", "Identity Documents", ShieldCheck],
  ["/client/messages", "Message Center", MessageCircle],
  ["/client/appointments", "Appointments", CalendarDays],
  ["/client/billing", "Billing & Payments", CreditCard],
  ["/client/agreements", "Pricing & Agreements", FileSignature],
  ["/client/news", "News & Tax Countdowns", Megaphone],
] as const;
const MORE = [
  ["/client/taxes/summary", "Tax Summary & Approval", ClipboardCheck],
  ["/client/taxes/filings", "Tax Filings", FileSearch],
  ["/client/nonprofit", "Nonprofit Portfolio", HeartHandshake],
  ["/client/resources", "Resource Center", BookOpen],
  ["/client/referrals", "Referrals", Users],
  ["/client/contracts", "Contracts & Signatures", PenLine],
  ["/client/bookkeeping", "Bookkeeping", Landmark],
  ["/client/account", "Account Settings", Settings],
] as const;

function NavLinks({ q, pathname, unread, onNavigate }: { q: string; pathname: string; unread: number; onNavigate?: () => void }) {
  const isActive = (href: string) =>
    href === "/client" || href === "/client/tax-center" ? pathname === href : pathname === href || (pathname.startsWith(`${href}/`) && href !== "/client/taxes");
  return (
    <nav aria-label="Portal" className="space-y-1 px-3">
      {MAIN.map(([href, label, Icon]) => (
        <Link
          key={href}
          href={`${href}${q}`}
          onClick={onNavigate}
          aria-current={isActive(href) ? "page" : undefined}
          className={clsx(
            "flex items-center gap-3 rounded-xl px-3 py-2.5 text-[15px] transition-colors",
            isActive(href) ? "bg-gradient-to-b from-gold-300 to-gold-500 font-bold text-navy-950 shadow-[0_6px_16px_-8px_rgb(200_157_41/0.9)] ring-1 ring-gold-200" : "border-b border-white/5 text-white/90 hover:bg-white/10 hover:text-white",
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
type Account = { id: string; name: string; personal?: boolean; owner?: string | null };

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
  const [open, setOpen] = useState(false);
    // Close the drawer and menu after navigating.
  const [seenPath, setSeenPath] = useState(pathname);
  if (seenPath !== pathname) {
    setSeenPath(pathname);
    setOpen(false);
  }
  const initials = name.split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase();

  // Navy sidebar like before: logo at the top, then the client, then every portal page.
  const sidebar = (onNavigate?: () => void) => (
    <div className="relative flex min-h-full flex-col bg-gradient-to-b from-navy-950 via-navy-900 to-navy-950 pb-8 text-white">
      <Link href={`/client${q}`} onClick={onNavigate} className="flex items-center gap-3 border-b border-gold-500/40 px-5 pb-5 pt-6" aria-label="TTurner Client Connect — home">
        <Image src="/brand/logo-shield.png" alt="" width={353} height={400} priority className="h-12 w-auto shrink-0 rounded-sm bg-white/95 p-1" />
        <span className="min-w-0 leading-none">
          <span className="block font-serif text-[15px] leading-snug tracking-[0.04em]">T. TURNER &amp;<br />ASSOCIATES, LLC</span>
          <span className="mt-1 block whitespace-nowrap font-serif text-[12px] tracking-[0.14em] text-gold-300">CLIENT CONNECT</span>
        </span>
      </Link>
      <div className="flex items-center gap-3 px-5 py-4">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full border-2 border-gold-500 font-serif text-base text-gold-300">{initials}</span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{name}</span>
        <Link href={`/client/messages${q}`} onClick={onNavigate} className="relative rounded-full p-2 hover:bg-white/10" aria-label={unread ? `${unread} unread messages` : "Messages"}>
          <Bell className="size-5" />
          {unread > 0 && <span className="absolute right-1 top-1 size-2.5 rounded-full bg-gold-500 ring-2 ring-navy-950" />}
        </Link>
      </div>
      {accounts.length > 1 && (
        <label className="block px-5 pb-3">
          <span className="sr-only">Choose account</span>
          <select className="w-full rounded-lg border border-white/20 bg-navy-950 px-3 py-2 text-sm text-white" value={account} onChange={(e) => router.push(`${pathname}?account=${e.target.value}`)} aria-label="Choose account">
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
      )}
      <NavLinks q={q} pathname={pathname} unread={unread} onNavigate={onNavigate} />
      <form action={signOut} className="px-3 pt-4">
        <button className="flex w-full items-center gap-3 rounded-lg px-3 py-1.5 text-left text-[13px] text-navy-100/80 hover:bg-white/10 hover:text-white"><LogOut className="size-4" aria-hidden />Sign out</button>
      </form>
    </div>
  );

  return (
    <>
      {/* Phones and tablets: a slim bar with the menu button. Large screens use the sidebar only. */}
      <header className="sticky top-0 z-30 border-b-2 border-gold-500 bg-navy-950 text-white lg:hidden" data-testid="portal-topbar">
        <div className="flex h-14 items-center gap-3 px-4">
          <button type="button" onClick={() => setOpen(true)} className="rounded-lg p-2 hover:bg-white/10" aria-label="Open menu"><Menu className="size-6" /></button>
          <Link href={`/client${q}`} className="flex min-w-0 items-center gap-2" aria-label="TTurner Client Connect — home">
            <Image src="/brand/logo-shield.png" alt="" width={353} height={400} className="h-9 w-auto rounded-sm bg-white/95 p-0.5" />
            <span className="truncate font-serif text-[15px] tracking-[0.06em]">CLIENT CONNECT</span>
          </Link>
          <Link href={`/client/messages${q}`} className="relative ml-auto rounded-full p-2 hover:bg-white/10" aria-label={unread ? `${unread} unread messages` : "Messages"}>
            <Bell className="size-5" />
            {unread > 0 && <span className="absolute right-1 top-1 size-2.5 rounded-full bg-gold-500 ring-2 ring-navy-950" />}
          </Link>
        </div>
      </header>
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-64 overflow-y-auto lg:block" data-testid="portal-sidebar">
        {sidebar()}
      </aside>
      <div className="lg:pl-64"><AccountTabs accounts={accounts} current={account} pathname={pathname} /></div>
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <button type="button" className="absolute inset-0 bg-navy-950/60" onClick={() => setOpen(false)} aria-label="Close menu" />
          <div className="absolute inset-y-0 left-0 w-72 max-w-[85vw] overflow-y-auto shadow-2xl">
            {sidebar(() => setOpen(false))}
            <button type="button" onClick={() => setOpen(false)} className="absolute right-2 top-2 rounded-lg p-2 text-white hover:bg-white/10" aria-label="Close menu"><X className="size-5" /></button>
          </div>
        </div>
      )}
    </>
  );
}
