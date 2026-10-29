"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { useState } from "react";
import clsx from "clsx";
import { CheckSquare, FileImage, LayoutDashboard, Megaphone, Menu, Settings, Upload, Users, UsersRound, X } from "lucide-react";

const LINKS = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/clients", label: "Clients", icon: Users },
  { href: "/groups", label: "Groups", icon: UsersRound },
  { href: "/campaigns", label: "Campaigns", icon: Megaphone },
  { href: "/flyers", label: "Flyer library", icon: FileImage },
  { href: "/imports", label: "Imports", icon: Upload },
  { href: "/tasks", label: "Tasks", icon: CheckSquare },
  { href: "/settings", label: "Settings", icon: Settings },
];

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <ul className="space-y-1">
      {LINKS.map(({ href, label, icon: Icon }) => {
        const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
        return (
          <li key={href}>
            <Link
              href={href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={clsx(
                "flex items-center gap-3 rounded-lg px-3 py-2.5 text-[15px] font-medium transition",
                active ? "bg-white/10 text-white shadow-[inset_3px_0_0_var(--color-gold-500)]" : "text-navy-100 hover:bg-white/5 hover:text-white",
              )}
            >
              <Icon aria-hidden className={clsx("size-5", active ? "text-gold-500" : "text-navy-100/80")} />
              {label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function Brand() {
  return (
    <Link href="/" className="flex items-center gap-3">
      <span className="flex size-11 items-center justify-center rounded-lg bg-white p-1">
        <Image src="/brand/logo-mark.png" alt="" width={200} height={224} className="h-auto w-8" />
      </span>
      <span className="leading-tight">
        <span className="block font-serif text-lg font-bold tracking-wide text-white">TTURNER</span>
        <span className="block text-[11px] font-semibold tracking-[0.18em] text-gold-500">CLIENT CONNECT</span>
      </span>
    </Link>
  );
}

export function AppNav({ user, signOut }: { user: { name: string; role: string }; signOut: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const footer = (
    <div className="border-t border-white/10 pt-4 text-sm">
      <p className="font-semibold text-white">{user.name}</p>
      <p className="text-navy-100/80">{user.role === "ADMIN" ? "Admin" : "Staff"}</p>
      <form action={signOut} className="mt-3">
        <button className="rounded-md border border-white/20 px-3 py-1.5 text-navy-100 hover:bg-white/10 hover:text-white">Sign out</button>
      </form>
    </div>
  );
  return (
    <>
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 hidden w-64 flex-col justify-between bg-navy-900 px-4 py-5 lg:flex">
        <div>
          <Brand />
          <nav aria-label="Main" className="mt-8"><NavLinks /></nav>
        </div>
        {footer}
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-30 flex items-center justify-between bg-navy-900 px-4 py-3 lg:hidden">
        <Brand />
        <button
          onClick={() => setOpen(true)}
          aria-label="Open menu"
          aria-expanded={open}
          className="rounded-md p-2 text-white hover:bg-white/10"
        >
          <Menu className="size-6" />
        </button>
      </header>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <button aria-label="Close menu" className="absolute inset-0 bg-navy-950/60" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 right-0 flex w-72 max-w-[85vw] flex-col justify-between bg-navy-900 px-4 py-5">
            <div>
              <div className="mb-6 flex justify-end">
                <button onClick={() => setOpen(false)} aria-label="Close menu" className="rounded-md p-2 text-white hover:bg-white/10">
                  <X className="size-6" />
                </button>
              </div>
              <nav aria-label="Main"><NavLinks onNavigate={() => setOpen(false)} /></nav>
            </div>
            {footer}
          </div>
        </div>
      )}
    </>
  );
}
