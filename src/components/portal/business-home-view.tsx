import Link from "next/link";
import { Briefcase, CalendarDays, ChevronRight, CloudUpload, CreditCard, FileBadge, Folder, MessageCircle, MessageSquareText, Receipt } from "lucide-react";
import type { loadPortalHome } from "@/lib/portal/views";
import { money } from "@/lib/billing/pricing";
import { fmtChicago } from "@/lib/tz";
import { ActionForm } from "@/components/action-form";
import { Button, Field } from "@/components/ui";
import { portalRequestPersonalTaxAction } from "@/app/actions/business-owners";
import { ActionTiles, luxCard, PanelHead, type Tile } from "./luxury";
import { Mountains } from "./mountains";

type Home = Awaited<ReturnType<typeof loadPortalHome>>;

const viewAll = "mt-4 inline-flex items-center gap-1 text-sm font-medium text-navy-900 hover:text-gold-700";

/**
 * Home for a business-only account (business tax return, K-1s, payroll — no
 * personal tax preparation). Shows only what this login was granted, plus the
 * owner's own K-1s, and a way to ask for personal tax preparation later.
 */
export function BusinessHomeView({ data, href, name, accountName, clientId, linkFor, readOnly }: { data: Home; href: (path: string, extra?: string) => string; name?: string; accountName?: string; clientId?: string; linkFor?: (id: string) => string; readOnly?: boolean }) {
  const p = data.perms;
  const tiles: Tile[] = [
    ...(p.canViewDocuments ? [{ title: "Business Documents", sub: "Your business's secure document vault", icon: Folder, href: href("/client/documents"), testId: "biz-documents" }] : []),
    ...(p.canUpload ? [{ title: "Upload Documents", sub: "Send files to our office securely", icon: CloudUpload, href: href("/client/documents"), testId: "biz-upload" }] : []),
    { title: "My K-1s", sub: data.k1s.length ? `${data.k1s.length} ready to view` : "Your Schedule K-1s appear here", icon: FileBadge, href: "#k1s", testId: "biz-k1s" },
    ...(p.canViewPayroll ? [{ title: "Payroll", sub: data.payrollDocs ? `${data.payrollDocs} payroll document${data.payrollDocs === 1 ? "" : "s"}` : "Payroll reports and filings", icon: Receipt, href: href("/client/documents"), testId: "biz-payroll" }] : []),
    ...(p.canMessage ? [{ title: "Messages", sub: "Write to our team privately", icon: MessageCircle, href: href("/client/messages"), testId: "biz-messages" }] : []),
    ...(p.canViewBilling ? [{ title: "Billing", sub: "Invoices and payments", icon: CreditCard, href: href("/client/billing"), testId: "biz-billing" }] : []),
    { title: "Appointments", sub: "Schedule time with our office", icon: CalendarDays, href: href("/client/appointments"), testId: "biz-appointments" },
  ];
  return (
    <div className="space-y-6" data-testid="business-home">
      <section className="relative overflow-hidden rounded-[2rem] border border-gold-300/70 bg-gradient-to-br from-white via-ivory-50 to-gold-50 shadow-[0_20px_45px_-28px_rgb(10_26_68/0.45)]" data-testid="hero">
        <Mountains variant="light" className="absolute bottom-0 right-0 h-1/2 w-full opacity-80 [mask-image:linear-gradient(to_bottom,transparent,black_35%)] sm:inset-y-0 sm:h-full sm:w-[50%] sm:opacity-100 sm:[mask-image:linear-gradient(to_right,transparent,black_30%)]" />
        <div className="relative z-10 px-6 pb-28 pt-8 sm:max-w-[54%] sm:px-10 sm:py-12">
          <h1 className="font-serif text-2xl font-bold leading-[1.15] text-navy-900 [overflow-wrap:anywhere] lg:text-3xl" data-testid="hero-heading">
            Welcome Back{name ? "," : ""}
            {name && <span className="block text-balance">{name}</span>}
          </h1>
          <p className="mt-3 max-w-[38ch] text-[15px] text-navy-800 sm:text-base">
            {accountName ? <><strong>{accountName}</strong>: your </> : "Your "}business documents, K-1s and messages, all in one secure place.
          </p>
        </div>
      </section>

      <ActionTiles tiles={tiles} />

      <div className="grid gap-6 lg:grid-cols-3">
        <section id="k1s" className={`${luxCard} scroll-mt-6 lg:col-span-2`} data-testid="k1-panel">
          <PanelHead icon={FileBadge} title="My K-1s" />
          {data.k1s.length === 0 ? (
            <p className="pt-3 text-sm text-slate-600">When our office finishes your Schedule K-1, it will be here. Only you can see your K-1.</p>
          ) : (
            <ul className="divide-y divide-ivory-200 pt-2">
              {data.k1s.map((k) => (
                <li key={k.id} className="flex items-center gap-3 py-3">
                  <FileBadge className="size-6 shrink-0 text-gold-600" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold text-navy-900">{k.title}</span>
                    <span className="text-sm text-slate-600">{k.year ?? "—"}{!k.own && k.ownerName ? ` · ${k.ownerName} (shared with you)` : ""}</span>
                  </span>
                  {linkFor && !readOnly && <a href={linkFor(k.id)} className="text-sm font-semibold text-navy-900 underline decoration-gold-500 underline-offset-4">Open</a>}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className={luxCard} data-testid="personal-tax-panel">
          <PanelHead icon={Briefcase} title="Personal taxes" />
          <p className="pt-3 text-sm text-slate-700">We handle this business&apos;s tax return{data.k1s.length ? ", K-1s" : ""} and payroll. Want us to prepare your personal tax return too?</p>
          {data.personalTaxRequest ? (
            <p className="mt-3 rounded-lg bg-gold-50 px-3 py-2 text-sm text-navy-900" data-testid="personal-tax-pending">Requested {fmtChicago(data.personalTaxRequest.createdAt, { month: "short", day: "numeric", year: "numeric" })}. Our office will be in touch.</p>
          ) : readOnly || !clientId ? (
            <p className="mt-3 text-xs text-slate-500">“Request personal tax preparation” appears here for the client.</p>
          ) : (
            <ActionForm action={portalRequestPersonalTaxAction.bind(null, clientId)} className="mt-3 space-y-2">
              <Field label="Anything we should know? (optional)"><textarea className="input" name="note" rows={2} maxLength={1000} /></Field>
              <Button type="submit" data-testid="request-personal-tax">Request personal tax preparation</Button>
            </ActionForm>
          )}
        </section>
      </div>

      {(p.canMessage || p.canViewBilling) && (
        <div className="grid gap-6 lg:grid-cols-2">
          {p.canMessage && (
            <section className={luxCard} data-testid="messages-panel">
              <PanelHead icon={MessageCircle} title="Messages" />
              {data.threads.length === 0 ? (
                <p className="pt-3 text-sm text-slate-600">No messages yet. Your messages to our office are private to you.</p>
              ) : (
                <ul className="space-y-2 pt-3">
                  {data.threads.map((t) => (
                    <li key={t.id}>
                      <Link href={href("/client/messages")} className="flex items-start gap-3 rounded-xl border border-ivory-200 p-3 hover:border-gold-500">
                        <MessageSquareText className="mt-0.5 size-5 shrink-0 text-navy-700" aria-hidden />
                        <span className="min-w-0 flex-1">
                          <span className="flex justify-between gap-2 text-sm font-semibold text-navy-900"><span className="truncate">{t.subject ?? "TTurner & Associates"}</span><span className="shrink-0 text-xs font-normal text-slate-500">{fmtChicago(t.at, { month: "short", day: "numeric" })}</span></span>
                          <span className="block truncate text-xs text-slate-600">{t.snippet}</span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
              <Link href={href("/client/messages")} className={viewAll}>View all messages <ChevronRight className="size-4" aria-hidden /></Link>
            </section>
          )}
          {p.canViewBilling && (
            <section className={luxCard} data-testid="billing-panel">
              <PanelHead icon={CreditCard} title="Invoices & Payments" />
              <p className="pt-3 text-sm text-navy-900">
                {data.billing.outstanding.length > 0
                  ? `${data.billing.outstanding.length} open invoice${data.billing.outstanding.length === 1 ? "" : "s"} · balance ${money(data.billing.outstanding.reduce((s, b) => s + (b.balanceCents ?? 0), 0))}`
                  : "No outstanding invoices. You're all set!"}
              </p>
              <Link href={href("/client/billing")} className={viewAll}>View invoices <ChevronRight className="size-4" aria-hidden /></Link>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
