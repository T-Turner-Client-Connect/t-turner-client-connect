import Image from "next/image";
import Link from "next/link";
import { BookOpen, ClipboardList, FileSearch, FolderLock, Gift, Inbox, Landmark, MessagesSquare, Newspaper, PenLine, Receipt } from "lucide-react";
import type { loadPortalHome } from "@/lib/portal/views";
import { countdownText, fmtIso } from "@/lib/tax/deadlines";

type Home = Awaited<ReturnType<typeof loadPortalHome>>;

/** The next date that applies to this client (or the next general one). */
export function nextDeadline(data: Home) {
  const lines = data.countdowns.cards.filter((c) => c.key !== "season").flatMap((c) => c.lines).filter((l) => l.days !== null && l.dueDate);
  const pick = (ls: typeof lines) => ls.sort((a, b) => a.days! - b.days!)[0];
  return pick(lines.filter((l) => l.appliesToYou)) ?? pick(lines) ?? null;
}

type Tile = { href: string; title: string; detail: string; icon: React.ComponentType<{ className?: string }>; badge?: string | null; show?: boolean; featured?: boolean };

export function PortalHomeView({ data, q, readOnly, name, accountName }: { data: Home; q: string; readOnly?: boolean; name?: string; accountName?: string; clientId?: string; linkFor?: (id: string) => string }) {
  const href = (path: string) => (readOnly ? "#" : `${path}${q}`);
  const next = nextDeadline(data);
  const toSign = data.contracts.length + data.signatures.length;

  const tiles: Tile[] = [
    { href: "/client/tax-center", title: "My Tax Center", detail: "Questionnaire, uploads and your return's progress", icon: ClipboardList, show: data.perms.canViewTax, featured: true },
    { href: "/client/taxes/filings", title: "Retrieve Tax Filings", detail: "Preview, download or print past returns", icon: FileSearch, show: data.perms.canViewTax },
    { href: "/client/documents", title: "Document Vault", detail: "Your documents, organized by year", icon: FolderLock, badge: data.newDocs.length ? `${data.newDocs.length} new` : null },
    { href: "/client/messages", title: "Messages", detail: "Secure conversations with our team", icon: MessagesSquare, badge: data.unread ? `${data.unread} unread` : null, show: data.perms.canMessage },
    { href: "/client/bookkeeping", title: "Document Requests", detail: "Items we've asked you to send", icon: Inbox, badge: data.requests.length ? `${data.requests.length} open` : null },
    { href: "/client/billing", title: "Invoices & Payments", detail: "Quotes, invoices and payment plans", icon: Receipt, badge: data.billing.quotes ? `${data.billing.quotes} to review` : null, show: data.perms.canViewBilling },
    { href: "/client/news", title: "News & Tax Countdowns", detail: next ? `Next: ${next.label.split(" — ")[0]} · ${countdownText(next.days!)}` : "Deadlines and office updates", icon: Newspaper },
    { href: "/client/resources", title: "Resource Center", detail: "Official state, IRS, SBA and SAM.gov links", icon: Landmark },
    { href: "/client/contracts", title: "Contracts & Signatures", detail: "Agreements and forms to complete", icon: PenLine, badge: toSign ? `${toSign} waiting` : null, show: data.perms.canViewContracts || data.perms.canViewTax },
    { href: "/client/bookkeeping", title: "Bookkeeping", detail: "Monthly reports for your review", icon: BookOpen, badge: data.readyPeriods.length ? `${data.readyPeriods.length} ready` : null, show: data.perms.canViewBookkeeping && data.readyPeriods.length > 0 },
    { href: "/client/referrals", title: "Refer a Friend", detail: "Introduce someone to our team", icon: Gift, show: data.perms.canMessage },
  ].filter((t) => t.show !== false);

  return (
    <div className="space-y-8">
      <section className="lux-hero overflow-hidden rounded-3xl px-6 py-8 text-white sm:px-10 sm:py-12">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-5">
            <span className="flex size-16 shrink-0 items-center justify-center rounded-2xl bg-white/95 p-2 shadow-lg ring-1 ring-gold-300 sm:size-20">
              <Image src="/brand/logo-mark.png" alt="TTurner & Associates Group" width={200} height={224} className="h-auto w-11 sm:w-14" />
            </span>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.3em] text-gold-300">TTurner &amp; Associates Group</p>
              <h1 className="mt-1 font-serif text-3xl font-bold text-white sm:text-4xl">{name ? `Welcome, ${name}` : "Client dashboard"}</h1>
              {accountName && <p className="mt-1 text-sm text-navy-100">{accountName}</p>}
            </div>
          </div>
          {next && (
            <Link href={href("/client/news")} className="rounded-2xl border border-gold-500/50 bg-white/5 px-5 py-3 backdrop-blur hover:bg-white/10" data-testid="hero-deadline">
              <span className="block text-[11px] font-semibold uppercase tracking-[0.2em] text-gold-300">Next deadline</span>
              <span className="block font-serif text-2xl font-bold text-white">{countdownText(next.days!)}</span>
              <span className="block text-xs text-navy-100">{next.label} · {fmtIso(next.dueDate!, { month: "short", day: "numeric", year: "numeric" })}</span>
            </Link>
          )}
        </div>
        <div className="mt-8 h-px bg-gradient-to-r from-transparent via-gold-500/70 to-transparent" aria-hidden />
        <p className="mt-4 text-center text-sm tracking-wide text-navy-100">Everything for your account, in one secure place.</p>
      </section>

      <nav aria-label="Your account" className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3" data-testid="home-tiles">
        {tiles.map((t) => (
          <Link
            key={t.title}
            href={href(t.href)}
            className={`lux-tile group relative flex flex-col rounded-2xl border p-4 sm:p-5 ${t.featured ? "border-gold-500 bg-navy-900 text-white" : "border-ivory-200 bg-white/90"}`}
            data-tile={t.title}
          >
            <span className={`mb-3 flex size-11 items-center justify-center rounded-full ${t.featured ? "bg-gold-500 text-navy-950" : "bg-navy-900 text-gold-300"}`}>
              <t.icon className="size-5" />
            </span>
            <span className={`font-serif text-base font-bold leading-snug sm:text-lg ${t.featured ? "text-white" : "text-navy-900"}`}>{t.title}</span>
            <span className={`mt-1 hidden text-sm sm:block ${t.featured ? "text-navy-100" : "text-slate-600"}`}>{t.detail}</span>
            {t.badge && <span className="absolute right-3 top-3 rounded-full bg-gold-500 px-2 py-0.5 text-[11px] font-bold text-navy-950">{t.badge}</span>}
            <span className={`mt-auto pt-3 text-sm font-semibold ${t.featured ? "text-gold-300" : "text-gold-700"}`} aria-hidden>Open →</span>
          </Link>
        ))}
      </nav>
    </div>
  );
}
