import Link from "next/link";
import { ChevronRight, ClipboardList, CloudUpload, CreditCard, FileText, Folder, Mail, Megaphone, MessageCircle, MessageSquareText, BookOpen } from "lucide-react";
import type { loadPortalHome } from "@/lib/portal/views";
import { STATES } from "@/lib/resources/catalog";
import { countdownText, fmtIso } from "@/lib/tax/deadlines";
import { money } from "@/lib/billing/pricing";
import { fmtChicago } from "@/lib/tz";
import { TOPICS } from "@/lib/services/news";
import { AnnouncementCarousel, ResourcePicker, TaxYearSelect, type Slide } from "./home-widgets";
import { Mountains } from "./mountains";

type Home = Awaited<ReturnType<typeof loadPortalHome>>;

/** The next date that applies to this client (or the next general one). */
export function nextDeadline(data: Home) {
  const lines = data.countdowns.cards.filter((c) => c.key !== "season").flatMap((c) => c.lines).filter((l) => l.days !== null && l.dueDate);
  const pick = (ls: typeof lines) => [...ls].sort((a, b) => a.days! - b.days!)[0];
  return pick(lines.filter((l) => l.appliesToYou)) ?? pick(lines) ?? null;
}

const card = "rounded-2xl border border-ivory-200 bg-white/95 p-5 shadow-[0_1px_2px_rgb(0_20_82/0.05),0_12px_30px_-18px_rgb(0_20_82/0.25)]";
const goldBtn = "inline-flex items-center justify-center gap-1 rounded-lg bg-gradient-to-b from-gold-500 to-gold-600 px-5 py-2.5 text-sm font-semibold text-white shadow hover:from-gold-600 hover:to-gold-700";
const outlineBtn = "inline-flex items-center justify-center gap-1 rounded-lg border border-gold-600 bg-white px-5 py-2.5 text-sm font-semibold text-navy-900 hover:bg-gold-100";
const viewAll = "mt-4 inline-flex items-center gap-1 text-sm font-medium text-navy-900 hover:text-gold-700";

function CardHead({ icon: Icon, title, sub, badge }: { icon: React.ComponentType<{ className?: string }>; title: string; sub: string; badge?: number }) {
  return (
    <div className="mb-4 flex items-start gap-3">
      <Icon className="mt-0.5 size-8 shrink-0 text-gold-600" aria-hidden />
      <div>
        <h2 className="font-serif text-lg font-bold text-navy-900">
          {title}
          {!!badge && <span className="ml-2 inline-flex size-6 items-center justify-center rounded-full bg-gold-500 align-middle text-xs font-bold text-white">{badge}</span>}
        </h2>
        <p className="text-sm text-slate-600">{sub}</p>
      </div>
    </div>
  );
}

export function PortalHomeView({ data, q, readOnly, name, year }: { data: Home; q: string; readOnly?: boolean; name?: string; accountName?: string; clientId?: string; linkFor?: (id: string) => string; year?: number }) {
  const href = (path: string, extra = "") => (readOnly ? "#" : `${path}${q}${extra ? `${q ? "&" : "?"}${extra}` : ""}`);
  const years = data.questionnaires.map((x) => x.year).sort((a, b) => a - b);
  const thisYear = new Date().getFullYear();
  const selected = year && years.includes(year) ? year : years.includes(thisYear - 1) ? thisYear - 1 : years.at(-1) ?? thisYear;
  const status = data.statuses.find((s) => s.year === selected);
  const doneCount = status?.steps.filter((s) => s.done).length ?? 0;
  const pill = status ? (status.steps.find((s) => !s.done)?.value ?? "Complete") : "Not started";
  const q12 = data.questionnaires.find((x) => x.year === selected);
  const next = nextDeadline(data);
  const req = data.requests[0];

  // A year without a questionnaire link is "Coming soon" — never another year's form.
  const qAvailable = !!q12?.url && !q12.completed;
  const actions = [
    {
      title: "Complete Tax Questionnaire",
      sub: q12?.completed ? `Completed for ${selected}` : qAvailable ? `${selected} questionnaire · secure Jotform` : `${selected} questionnaire coming soon`,
      icon: ClipboardList,
      href: q12?.completed ? href("/client/tax-center", `year=${selected}`) : qAvailable ? q12!.url! : null,
      external: qAvailable,
      tone: "gold",
      testId: "action-questionnaire",
    },
    { title: "Upload Documents", sub: `Send ${selected} tax documents securely`, icon: CloudUpload, href: href("/client/tax-center/upload", `year=${selected}`), external: false, tone: "navy", testId: "upload-button" },
    { title: "Retrieve Tax Filings", sub: `Available filings · 2020 – ${thisYear}`, icon: FileText, href: href("/client/taxes/filings", `year=${selected}`), external: false, tone: "gold", testId: "retrieve-button" },
    { title: "Upload Audit or Tax Notice", sub: "IRS, state or local letters", icon: Mail, href: href("/client/tax-center/notice", `year=${selected}`), external: false, tone: "navy", testId: "notice-button" },
  ];

  const slides: Slide[] = [
    ...(next ? [{ kicker: "Next deadline", title: `${next.label} — ${countdownText(next.days!)}`, body: `${fmtIso(next.dueDate!)}. An extension to file generally does not extend the time to pay.`, href: href("/client/news") }] : []),
    ...data.updates.slice(0, 5).map((a) => ({ kicker: `${a.pinned ? "Pinned · " : ""}${a.clientId ? "For your account" : TOPICS[(a.topic ?? "GENERAL") as keyof typeof TOPICS] ?? "News"}`, title: a.title, body: a.body, href: href("/client/news") })),
  ];

  return (
    <div className="space-y-6">
      {/* Welcome */}
      <section className="relative overflow-hidden rounded-3xl border border-ivory-200 bg-ivory-50 shadow-sm" data-testid="hero">
        <Mountains variant="light" className="absolute bottom-0 right-0 h-1/2 w-full opacity-80 sm:inset-y-0 sm:h-full sm:w-[70%] sm:opacity-100" />
        <div className="relative px-6 pb-24 pt-8 sm:px-10 sm:py-12">
          <h1 className="max-w-[16ch] font-serif text-3xl font-bold leading-tight text-navy-900 sm:max-w-none sm:text-[2.6rem]">{name ? `Welcome back, ${name}` : "Welcome back"}</h1>
          <p className="mt-2 max-w-[24ch] text-base text-navy-800 sm:max-w-none sm:text-lg">Your documents, tax filings, and updates—all in one place.</p>
          {next && (
            <Link href={href("/client/news")} className="mt-4 inline-flex items-center gap-2 rounded-full border border-gold-500/60 bg-white/80 px-3 py-1 text-xs font-semibold text-navy-900 backdrop-blur hover:bg-white" data-testid="hero-deadline">
              <span className="size-1.5 rounded-full bg-gold-500" aria-hidden />Next deadline: {countdownText(next.days!)}
            </Link>
          )}
        </div>
        <p className="absolute right-8 top-1/2 hidden -translate-y-1/2 text-right text-[11px] font-semibold leading-6 tracking-[0.35em] text-navy-800/80 xl:block" aria-hidden>
          EXPERTISE<br />TODAY.<br />BRIGHTER<br />TOMORROWS<br />TOGETHER.
          <span className="ml-auto mt-2 block h-px w-8 bg-gold-500" />
        </p>
      </section>

      {data.identityAlerts.length > 0 && (
        <Link href={href("/client/identity")} className="flex items-center gap-3 rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 hover:bg-amber-100" data-testid="identity-reminder">
          <span className="size-2 shrink-0 rounded-full bg-amber-500" aria-hidden />
          <span className="flex-1">{data.identityAlerts[0].text}{data.identityAlerts.length > 1 && ` (+${data.identityAlerts.length - 1} more)`}</span>
          <ChevronRight className="size-4" aria-hidden />
        </Link>
      )}

      {/* My Tax Center */}
      {data.perms.canViewTax && (
        <section className={card} data-testid="tax-center">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="font-serif text-2xl font-bold text-navy-900">My Tax Center</h2>
              <p className="text-sm text-slate-600">Manage your tax documents, filings, and year-specific tasks.</p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              {!readOnly && <TaxYearSelect years={[...years].reverse()} year={selected} base={`/client${q}${q ? "&" : "?"}`} />}
              <nav aria-label="Tax year" className="flex flex-wrap gap-1.5" data-testid="year-chips">
                {years.map((y) => (
                  <Link key={y} href={href("/client", `year=${y}`)} scroll={false} aria-current={y === selected ? "true" : undefined} className={`rounded-full border px-2.5 py-1 text-xs sm:px-3.5 sm:py-1.5 sm:text-sm ${y === selected ? "border-gold-600 bg-gold-600 font-semibold text-white" : "border-ivory-200 bg-white text-navy-900 hover:border-gold-500"}`}>
                    {y}
                  </Link>
                ))}
              </nav>
            </div>
          </div>

          {readOnly && (
            <p className="mb-3 rounded-lg border border-gold-500 bg-gold-100 px-3 py-2 text-sm text-navy-950" data-testid="preview-note">
              Staff preview is read-only: these buttons are shown as the client sees them but don&apos;t open here. To upload for the client, use their record&apos;s Documents tab.
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {actions.map((a) =>
              readOnly || !a.href ? (
                <div
                  key={a.title}
                  aria-disabled="true"
                  title={readOnly ? "Read-only staff preview" : undefined}
                  className={`flex cursor-not-allowed items-center gap-4 rounded-xl px-5 py-4 text-white opacity-60 shadow-md ${a.tone === "navy" ? "bg-gradient-to-br from-navy-900 to-navy-950" : "bg-gradient-to-br from-gold-500 to-gold-600"}`}
                  data-testid={a.testId}
                  data-disabled="true"
                >
                  <a.icon className="size-9 shrink-0 opacity-95" aria-hidden />
                  <span className="flex-1">
                    <span className="block font-serif text-[17px] font-bold leading-snug">{a.title}</span>
                    <span className="block text-xs text-white/90">{readOnly ? "Disabled in staff preview" : a.sub}</span>
                  </span>
                </div>
              ) : (
              <Link
                key={a.title}
                href={a.href}
                {...(a.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                className={`group flex items-center gap-4 rounded-xl px-5 py-4 text-white shadow-md transition hover:shadow-lg ${a.tone === "navy" ? "bg-gradient-to-br from-navy-900 to-navy-950" : "bg-gradient-to-br from-gold-500 to-gold-600"}`}
                data-testid={a.testId}
              >
                <a.icon className="size-9 shrink-0 opacity-95" aria-hidden />
                <span className="flex-1">
                  <span className="block font-serif text-[17px] font-bold leading-snug">{a.title}</span>
                  <span className="block text-xs text-white/85">{a.sub}</span>
                </span>
                <ChevronRight className="size-5 transition group-hover:translate-x-0.5" aria-hidden />
              </Link>
              ),
            )}
          </div>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div className="flex flex-wrap items-center gap-4 rounded-xl border border-ivory-200 p-4" data-testid="service-progress">
              <FileText className="size-8 shrink-0 text-gold-600" aria-hidden />
              <div className="min-w-48 flex-1">
                <p className="font-serif text-lg font-bold text-navy-900">{selected} Tax Preparation</p>
                <span className="mt-1 inline-block rounded-full bg-ivory-100 px-3 py-0.5 text-xs font-medium text-navy-800">{pill}</span>
                <div className="mt-3 h-2 w-full max-w-64 overflow-hidden rounded-full bg-ivory-200" role="progressbar" aria-valuemin={0} aria-valuemax={5} aria-valuenow={doneCount} aria-label="Steps complete">
                  <div className="h-full rounded-full bg-gradient-to-r from-gold-500 to-gold-600" style={{ width: `${(doneCount / 5) * 100}%` }} />
                </div>
                <p className="mt-1 text-xs text-slate-600">{doneCount} of 5 complete{status?.estimatedCompletion && ` · Estimated ${fmtChicago(status.estimatedCompletion, { month: "short", day: "numeric", year: "numeric" })}`}</p>
              </div>
              <Link href={href("/client/tax-center", `year=${selected}`)} className={outlineBtn}>View checklist <ChevronRight className="size-4" aria-hidden /></Link>
            </div>
            <div className="flex flex-wrap items-center gap-4 rounded-xl border border-ivory-200 p-4" data-testid="doc-requests">
              <Mail className="size-8 shrink-0 text-gold-600" aria-hidden />
              <div className="min-w-48 flex-1">
                <p className="font-serif text-lg font-bold text-navy-900">Documents requested</p>
                <p className="text-sm text-slate-600">{req ? `${req.title}${data.requests.length > 1 ? ` and ${data.requests.length - 1} more` : ""}` : "Nothing requested right now."}</p>
              </div>
              {req && <Link href={href("/client/bookkeeping")} className={goldBtn}>View request <ChevronRight className="size-4" aria-hidden /></Link>}
            </div>
          </div>
        </section>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <section className={card} data-testid="vault">
          <CardHead icon={Folder} title="My Document Vault" sub="Secure storage for all your tax documents." />
          {data.vault.length === 0 ? (
            <p className="text-sm text-slate-600">Your documents will be organized here by year.</p>
          ) : (
            <div className="grid grid-cols-3 gap-3">
              {data.vault.filter((v) => v.year).slice(0, 3).map((v) => (
                <Link key={v.year} href={href("/client/documents", `year=${v.year}`)} className="flex flex-col items-center rounded-xl border border-ivory-200 bg-ivory-50 px-2 py-4 hover:border-gold-500">
                  <Folder className="size-8 fill-gold-500 text-gold-600" aria-hidden />
                  <span className="mt-1 text-sm font-semibold text-navy-900">{v.year}</span>
                </Link>
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Link href={href("/client/documents")} className={viewAll}>View all years <ChevronRight className="size-4" aria-hidden /></Link>
            {data.perms.canViewIdentity && (
              <Link href={href("/client/identity")} className={`${viewAll} text-gold-700`} data-testid="identity-link">
                Identity documents{data.identityAlerts.length > 0 && <span className="ml-1 rounded-full bg-red-600 px-1.5 text-[11px] font-bold text-white">{data.identityAlerts.length}</span>} <ChevronRight className="size-4" aria-hidden />
              </Link>
            )}
          </div>
        </section>

        {data.perms.canMessage && (
          <section className={card} data-testid="messages-panel">
            <CardHead icon={MessageCircle} title="Messages" sub="Communicate securely with our team." badge={data.unread} />
            {data.threads.length === 0 ? (
              <p className="text-sm text-slate-600">No messages yet.</p>
            ) : (
              <ul className="space-y-2">
                {data.threads.map((t) => (
                  <li key={t.id}>
                    <Link href={href("/client/messages")} className="flex items-start gap-3 rounded-xl border border-ivory-200 p-3 hover:border-gold-500">
                      <MessageSquareText className="mt-0.5 size-5 shrink-0 text-navy-700" aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="flex justify-between gap-2 text-sm font-semibold text-navy-900"><span className="truncate">{t.subject ?? "TTurner & Associates"}</span><span className="shrink-0 text-xs font-normal text-slate-500">{fmtChicago(t.at, { month: "short", day: "numeric" })}</span></span>
                        <span className="block truncate text-xs text-slate-600">{t.snippet}</span>
                      </span>
                      <span className={`mt-1.5 size-2 shrink-0 rounded-full ${t.unread ? "bg-gold-500" : "bg-navy-100"}`} aria-label={t.unread ? "Unread" : undefined} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            <Link href={href("/client/messages")} className={viewAll}>View all messages <ChevronRight className="size-4" aria-hidden /></Link>
          </section>
        )}

        {data.perms.canViewBilling && (
          <section className={card} data-testid="billing-panel">
            <CardHead icon={CreditCard} title="Invoices & Payments" sub="View and pay your invoices securely." />
            <div className="flex flex-col items-center py-2 text-center">
              <FileText className="mb-2 size-9 text-navy-700" aria-hidden />
              {data.billing.outstanding.length > 0 ? (
                <p className="text-sm text-navy-900"><strong>{data.billing.outstanding.length}</strong> open invoice{data.billing.outstanding.length === 1 ? "" : "s"} · balance {money(data.billing.outstanding.reduce((s, b) => s + (b.balanceCents ?? 0), 0))}</p>
              ) : data.billing.quotes > 0 ? (
                <p className="text-sm text-navy-900">{data.billing.quotes} quote{data.billing.quotes === 1 ? "" : "s"} ready for your review</p>
              ) : (
                <p className="text-sm text-navy-900">No outstanding invoices<br /><span className="text-slate-600">You&apos;re all set!</span></p>
              )}
              <Link href={href("/client/billing")} className={`${goldBtn} mt-4`}>View invoices <ChevronRight className="size-4" aria-hidden /></Link>
            </div>
          </section>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <section className={`${card} lg:col-span-2`} data-testid="resources-panel">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <CardHead icon={BookOpen} title="Client Resource Center" sub="Helpful resources and tools for your business and personal tax needs." />
            <ResourcePicker states={STATES} initial={data.state} q={q} readOnly={readOnly} />
          </div>
        </section>
        <section className={card} data-testid="announcements">
          <CardHead icon={Megaphone} title="Announcements" sub="Office updates & helpful reminders." />
          {slides.length ? <AnnouncementCarousel slides={slides} /> : <p className="text-sm text-slate-600">No announcements right now.</p>}
          <Link href={href("/client/news")} className={viewAll}>News & tax countdowns <ChevronRight className="size-4" aria-hidden /></Link>
        </section>
      </div>
    </div>
  );
}
