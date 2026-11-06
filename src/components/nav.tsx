"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import clsx from "clsx";
import {
  BarChart3,
  Calculator,
  CalendarCheck,
  CalendarDays,
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
  MailWarning,
  FileCheck2,
  HeartHandshake,
  ArrowLeft,
  LayoutGrid,
  Sparkles,
  Building2,
  BookOpen,
  UsersRound,
  ClipboardList,
  FileBadge,
  FileSpreadsheet,
  ReceiptText,
  FileBarChart,
  FolderOpen,
  MessageSquareText,
  History,
  ChevronRight,
  Banknote,
  FileSignature,
} from "lucide-react";

const LINKS = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard, also: [] as string[] },
  { href: "/clients", label: "Clients", icon: Users, also: ["/groups", "/imports"] },
  { href: "/bookkeeping", label: "Bookkeeping Clients", icon: Calculator, also: [] },
  { href: "/conversations", label: "Conversations", icon: MessagesSquare, also: [] },
  { href: "/campaigns", label: "Campaigns", icon: Megaphone, also: ["/media"] },
  { href: "/social", label: "Social media", icon: Share2, also: [] },
  { href: "/workflows", label: "Workflows", icon: GitBranch, also: [] },
  { href: "/documents", label: "Documents", icon: FolderLock, also: [] },
  { href: "/agreements", label: "Agreements", icon: FileSignature, also: [] },
  { href: "/notices", label: "Audits & Notices", icon: MailWarning, also: [] },
  { href: "/taxes/returns", label: "Tax returns", icon: FileCheck2, also: ["/taxes/questionnaires"] },
  { href: "/taxes/8879", label: "8879 Signatures", icon: FileSignature, also: [] },
  { href: "/nonprofits", label: "Nonprofit filings", icon: HeartHandshake, also: [] },
  { href: "/resources", label: "Resource Center", icon: Landmark, also: [] },
  { href: "/news", label: "News & Countdowns", icon: Newspaper, also: [] },
  { href: "/appointments", label: "Appointments", icon: CalendarDays, also: [] },
  { href: "/tasks", label: "Tasks & Calendar", icon: CalendarCheck, also: [] },
  { href: "/reports", label: "Reports", icon: BarChart3, also: [] },
  { href: "/settings", label: "Settings", icon: Settings, also: [] },
];

/** Shown only to staff the owner granted ADP Payroll & Taxes (the server decides; pages re-check). */
const PAYROLL_TAXES_LINK = { href: "/payroll-taxes", label: "ADP Payroll & Taxes", icon: Banknote, also: [] as string[] };

/** "none", "claim", or the first Owner's Office page this account may open. */
export type OwnerNav = "none" | "claim" | `/owner${string}`;

// Rendered only when the server says this signed-in account holds owner access.
function OwnerLink({ owner, onNavigate }: { owner: OwnerNav; onNavigate?: () => void }) {
  const pathname = usePathname();
  if (owner === "none") return null;
  const href = owner === "claim" ? "/owner/claim" : owner;
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

/** The bookkeeping client's own menu, shown in place of the main menu inside /bookkeeping/<client>. */
export function workspaceClientId(pathname: string) {
  const m = /^\/bookkeeping\/([^/]+)/.exec(pathname);
  return m && !["new", "square-billing", "plaid-oauth"].includes(m[1]) ? m[1] : null;
}

function WorkspaceLinks({ id, onNavigate }: { id: string; onNavigate?: () => void }) {
  const pathname = usePathname();
  const tab = useSearchParams().get("tab");
  const base = `/bookkeeping/${id}`;
  const items: { href: string; label: string; icon: typeof Users; active: boolean }[] = [
    { href: base, label: "Client Overview", icon: LayoutGrid, active: pathname === base },
    { href: `/clients/${id}?tab=overview`, label: "Client Profile", icon: Users, active: false },
    { href: `${base}/coetha`, label: "Coetha AI", icon: Sparkles, active: pathname === `${base}/coetha` },
    { href: base, label: "Bookkeeping Management", icon: ClipboardList, active: false },
    { href: `${base}/banking`, label: "Banking & Reconciliation", icon: Building2, active: pathname.startsWith(`${base}/banking`) || (pathname === `${base}/books` && tab === "bank") },
    { href: `${base}/records`, label: "Historical Records", icon: History, active: pathname === `${base}/records` },
    { href: `${base}/books?tab=journal`, label: "General Ledger", icon: BookOpen, active: pathname === `${base}/books` && (tab === "journal" || tab === "accounts" || !tab || tab === "overview") },
    { href: `${base}/payroll`, label: "Payroll & ADP", icon: UsersRound, active: pathname === `${base}/payroll` },
    { href: `/clients/${id}?tab=taxes`, label: "Taxes & Compliance", icon: ClipboardList, active: false },
    { href: `${base}/licenses`, label: "Business Licenses", icon: FileBadge, active: pathname === `${base}/licenses` },
    { href: `${base}/year-end`, label: "W-2 / 1099 Center", icon: FileSpreadsheet, active: pathname === `${base}/year-end` },
    { href: `${base}/books?tab=invoicing`, label: "Invoicing & Payments", icon: ReceiptText, active: pathname === `${base}/books` && tab === "invoicing" },
    { href: `${base}/books?tab=reports`, label: "Financial Statements", icon: FileBarChart, active: pathname === `${base}/books` && tab === "reports" },
    { href: `/clients/${id}?tab=documents`, label: "Documents", icon: FolderOpen, active: false },
    { href: `/clients/${id}?tab=messages`, label: "Communication", icon: MessageSquareText, active: false },
    { href: `${base}/profile`, label: "Business Profile", icon: History, active: pathname === `${base}/profile` },
  ];
  return (
    <div className="space-y-4" data-testid="workspace-nav">
      <Link href="/bookkeeping" onClick={onNavigate} className="flex items-center gap-3 rounded-lg px-3 py-2 text-[15px] font-medium text-navy-100 hover:bg-white/5 hover:text-white">
        <ArrowLeft aria-hidden className="size-[18px]" /> Back to Clients
      </Link>
      <ul className="space-y-0.5">
        {items.map(({ href, label, icon: Icon, active }) => (
          <li key={label}>
            <Link
              href={href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={clsx(
                "flex items-center gap-3 rounded-lg px-3 py-2.5 text-[15px] font-medium",
                active ? "bg-gradient-to-b from-gold-300 to-gold-500 font-semibold text-navy-950 shadow" : "border-b border-white/5 text-navy-100 hover:bg-white/5 hover:text-white",
              )}
            >
              <Icon aria-hidden className={clsx("size-[18px]", active ? "text-navy-950" : "text-navy-100/80")} />
              <span className="flex-1">{label}</span>
            </Link>
          </li>
        ))}
      </ul>
      <Link href={`${base}/coetha`} onClick={onNavigate} className="flex items-center gap-3 rounded-xl border border-gold-500 bg-navy-950/60 px-3 py-3 text-white shadow-[0_0_18px_-6px_var(--color-gold-500)] hover:bg-navy-900" data-testid="coetha-nav-card">
        <Sparkles aria-hidden className="size-8 shrink-0 text-gold-400" />
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block font-serif text-lg font-bold">Coetha</span>
          <span className="block text-xs text-navy-100">Senior Accountant</span>
          <span className="mt-1 block text-[11px] text-navy-100/80">Drafts for Tabitha to approve</span>
        </span>
        <ChevronRight aria-hidden className="size-4 text-gold-400" />
      </Link>
    </div>
  );
}

function NavLinks({ onNavigate, unread, owner, payrollTaxes }: { onNavigate?: () => void; unread: number; owner: OwnerNav; payrollTaxes: boolean }) {
  const pathname = usePathname();
  const ws = workspaceClientId(pathname);
  if (ws) return <WorkspaceLinks id={ws} onNavigate={onNavigate} />;
  const links = payrollTaxes ? [...LINKS.slice(0, 3), PAYROLL_TAXES_LINK, ...LINKS.slice(3)] : LINKS;
  return (
    <>
    <ul className="space-y-0.5">
      {links.map(({ href, label, icon: Icon, also }) => {
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

export function AppNav({ user, signOut, unread, owner, payrollTaxes = false }: { user: { name: string; role: string }; signOut: () => Promise<void>; unread: number; owner: OwnerNav; payrollTaxes?: boolean }) {
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
      <aside className="fixed inset-y-0 left-0 hidden w-64 flex-col justify-between overflow-y-auto bg-gradient-to-b from-navy-900 to-navy-950 px-4 py-5 lg:flex print:hidden!">
        <div className="space-y-6">
          <Brand />
          <GlobalSearch />
          <nav aria-label="Main"><NavLinks unread={unread} owner={owner} payrollTaxes={payrollTaxes} /></nav>
        </div>
        {footer}
      </aside>

      <header className="sticky top-0 z-30 flex items-center justify-between bg-navy-900 px-4 py-3 lg:hidden print:hidden!">
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
              <nav aria-label="Main"><NavLinks onNavigate={() => setOpen(false)} unread={unread} owner={owner} payrollTaxes={payrollTaxes} /></nav>
            </div>
            {footer}
          </div>
        </div>
      )}
    </>
  );
}
