"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import clsx from "clsx";
import {
  BarChart3,
  CalendarCheck,
  FolderLock,
  GitBranch,
  LayoutDashboard,
  Landmark,
  LockKeyhole,
  Megaphone,
  Menu,
  Newspaper,
  MessagesSquare,
  Search,
  Settings,
  Share2,
  Users,
  X,
} from "lucide-react";

const LINKS = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard, also: [] as string[] },
  { href: "/clients", label: "Clients", icon: Users, also: ["/groups", "/imports"] },
  { href: "/conversations", label: "Conversations", icon: MessagesSquare, also: [] },
  { href: "/campaigns", label: "Campaigns", icon: Megaphone, also: ["/media"] },
  { href: "/social", label: "Social media", icon: Share2, also: [] },
  { href: "/workflows", label: "Workflows", icon: GitBranch, also: [] },
  { href: "/documents", label: "Documents", icon: FolderLock, also: [] },
  { href: "/resources", label: "Resource Center", icon: Landmark, also: [] },
  { href: "/news", label: "News & Countdowns", icon: Newspaper, also: [] },
  { href: "/tasks", label: "Tasks & Calendar", icon: CalendarCheck, also: [] },
  { href: "/reports", label: "Reports", icon: BarChart3, also: [] },
  { href: "/settings", label: "Settings", icon: Settings, also: [] },
];

export type OwnerNav = "none" | "claim" | "billing" | "full";

// Rendered only when the server says this signed-in account holds owner access.
function OwnerLink({ owner, onNavigate }: { owner: OwnerNav; onNavigate?: () => void }) {
  const pathname = usePathname();
  if (owner === "none") return null;
  const href = owner === "claim" ? "/owner/claim" : owner === "billing" ? "/owner/invoices" : "/owner";
  const active = pathname.startsWith("/owner");
  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={clsx(
        "mt-3 flex items-center gap-3 rounded-lg border px-3 py-2.5 text-[15px] font-semibold",
        active ? "border-gold-500 bg-gold-500/15 text-white" : "border-gold-500/40 text-gold-500 hover:bg-gold-500/10",
      )}
    >
      <LockKeyhole aria-hidden className="size-[18px]" />
      <span className="flex-1">Owner&apos;s Office</span>
      <span className="text-[10px] font-bold uppercase tracking-wider text-gold-500/90">Private</span>
    </Link>
  );
}

function NavLinks({ onNavigate, unread, owner }: { onNavigate?: () => void; unread: number; owner: OwnerNav }) {
  const pathname = usePathname();
  return (
    <>
    <ul className="space-y-0.5">
      {LINKS.map(({ href, label, icon: Icon, also }) => {
        const active = href === "/" ? pathname === "/" : [href, ...also].some((p) => pathname.startsWith(p));
        return (
          <li key={href}>
            <Link
              href={href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={clsx(
                "flex items-center gap-3 rounded-lg px-3 py-2.5 text-[15px] font-medium",
                active ? "bg-white/10 text-white shadow-[inset_3px_0_0_var(--color-gold-500)]" : "text-navy-100 hover:bg-white/5 hover:text-white",
              )}
            >
              <Icon aria-hidden className={clsx("size-[18px]", active ? "text-gold-500" : "text-navy-100/70")} />
              <span className="flex-1">{label}</span>
              {href === "/conversations" && unread > 0 && (
                <span className="rounded-full bg-gold-500 px-2 text-xs font-bold text-navy-950" aria-label={`${unread} unread`}>{unread}</span>
              )}
            </Link>
          </li>
        );
      })}
    </ul>
    <OwnerLink owner={owner} onNavigate={onNavigate} />
    </>
  );
}

function Brand() {
  return (
    <Link href="/" className="flex items-center gap-3">
      <span className="flex size-11 items-center justify-center rounded-xl bg-ivory-50 p-1 shadow-inner">
        <Image src="/brand/logo-mark.png" alt="" width={200} height={224} className="h-auto w-8" />
      </span>
      <span className="leading-tight">
        <span className="block font-serif text-lg font-bold tracking-[0.08em] text-white">TTURNER</span>
        <span className="block text-[10.5px] font-semibold tracking-[0.2em] text-gold-500">CLIENT CONNECT</span>
      </span>
    </Link>
  );
}

function GlobalSearch({ onDone }: { onDone?: () => void }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  return (
    <form
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        router.push(`/clients?q=${encodeURIComponent(q)}`);
        onDone?.();
      }}
      className="relative"
    >
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-navy-100/70" aria-hidden />
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search clients"
        aria-label="Search clients"
        className="w-full rounded-lg border border-white/10 bg-white/5 py-2 pl-9 pr-3 text-sm text-white placeholder:text-navy-100/60 focus:border-gold-500 focus:outline-none"
      />
    </form>
  );
}

export function AppNav({ user, signOut, unread, owner }: { user: { name: string; role: string }; signOut: () => Promise<void>; unread: number; owner: OwnerNav }) {
  const [open, setOpen] = useState(false);
  const footer = (
    <div className="border-t border-white/10 pt-4 text-sm">
      <p className="font-semibold text-white">{user.name}</p>
      <p className="text-navy-100/80">{user.role === "ADMIN" ? "Admin" : "Staff"} · Staff workspace</p>
      <form action={signOut} className="mt-3">
        <button className="rounded-md border border-white/20 px-3 py-1.5 text-navy-100 hover:bg-white/10 hover:text-white">Sign out</button>
      </form>
    </div>
  );
  return (
    <>
      <aside className="fixed inset-y-0 left-0 hidden w-64 flex-col justify-between overflow-y-auto bg-gradient-to-b from-navy-900 to-navy-950 px-4 py-5 lg:flex">
        <div className="space-y-6">
          <Brand />
          <GlobalSearch />
          <nav aria-label="Main"><NavLinks unread={unread} owner={owner} /></nav>
        </div>
        {footer}
      </aside>

      <header className="sticky top-0 z-30 flex items-center justify-between bg-navy-900 px-4 py-3 lg:hidden">
        <Brand />
        <button onClick={() => setOpen(true)} aria-label="Open menu" aria-expanded={open} className="rounded-md p-2 text-white hover:bg-white/10">
          <Menu className="size-6" />
        </button>
      </header>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <button aria-label="Close menu" className="absolute inset-0 bg-navy-950/60" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 right-0 flex w-72 max-w-[85vw] flex-col justify-between overflow-y-auto bg-navy-900 px-4 py-5">
            <div className="space-y-5">
              <div className="flex justify-end">
                <button onClick={() => setOpen(false)} aria-label="Close menu" className="rounded-md p-2 text-white hover:bg-white/10"><X className="size-6" /></button>
              </div>
              <GlobalSearch onDone={() => setOpen(false)} />
              <nav aria-label="Main"><NavLinks onNavigate={() => setOpen(false)} unread={unread} owner={owner} /></nav>
            </div>
            {footer}
          </div>
        </div>
      )}
    </>
  );
}
