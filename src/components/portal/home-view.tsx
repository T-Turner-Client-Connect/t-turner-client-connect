import Link from "next/link";
import { CalendarDays, ChevronRight, Clock, ClipboardList, CloudUpload, CreditCard, FileText, Folder, Mail, Megaphone, MessageCircle, MessageSquareText, FolderOpen } from "lucide-react";
import type { loadPortalHome } from "@/lib/portal/views";
import { countdownText, fmtIso } from "@/lib/tax/deadlines";
import { money } from "@/lib/billing/pricing";
import { fmtChicago } from "@/lib/tz";
import { TaxYearSelect } from "./home-widgets";
import { TaxDocsOnline } from "./tax-docs-online";
import { ActionTiles, CountdownCards, ImportantToKnow, luxCard, NewsList, PanelHead, type Tile } from "./luxury";
import { Mountains } from "./mountains";

type Home = Awaited<ReturnType<typeof loadPortalHome>>;

/** The next date that applies to this client (or the next general one). */
export function nextDeadline(data: Home) {
  const lines = data.countdowns.cards.filter((c) => c.key !== "season").flatMap((c) => c.lines).filter((l) => l.days !== null && l.dueDate);
  const pick = (ls: typeof lines) => [...ls].sort((a, b) => a.days! - b.days!)[0];
  return pick(lines.filter((l) => l.appliesToYou)) ?? pick(lines) ?? null;
}

const card = "min-w-0 rounded-2xl border border-ivory-200 bg-white/95 p-5 shadow-[0_1px_2px_rgb(0_20_82/0.05),0_12px_30px_-18px_rgb(0_20_82/0.25)]";
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

type TileOpts = { data: Pick<Home, "questionnaires">; q: string; readOnly?: boolean; year?: number; previewHref?: (path: string, extra: string) => string };

/**
 * The five headline actions on the regular tax Home (Tax Questionnaire, Upload Documents,
 * Retrieve Tax Filings, Appointments, News & Updates). The business dashboard shows the same ones.
 */
export function homeTiles({ data, q, readOnly, year, previewHref }: TileOpts) {
  const href = (path: string, extra = "") => (previewHref ? previewHref(path, extra) : readOnly ? "#" : `${path}${q}${extra ? `${q ? "&" : "?"}${extra}` : ""}`);
  const browsable = !!previewHref;
  const years = data.questionnaires.map((x) => x.year).sort((a, b) => a - b);
  const thisYear = new Date().getFullYear();
  const selected = year && years.includes(year) ? year : years.includes(thisYear - 1) ? thisYear - 1 : years.at(-1) ?? thisYear;
  const q12 = data.questionnaires.find((x) => x.year === selected);
  // A year without a questionnaire link is "Coming soon" — never another year's form.
  const qAvailable = !!q12?.url && !q12.completed;
  const disabled = readOnly && !browsable ? "Disabled in staff preview" : undefined;
  const link = (h: string | null) => (readOnly && !browsable ? null : h);
  const tiles: Tile[] = [
    {
      title: "Tax Questionnaire",
      sub: q12?.completed ? `Completed for ${selected}` : qAvailable ? `Complete your ${selected} information` : `${selected} questionnaire coming soon`,
      icon: ClipboardList,
      href: link(q12?.completed ? href("/client/tax-center", `year=${selected}`) : qAvailable ? (browsable ? href("/client/tax-center") : q12!.url!) : null),
      external: qAvailable && !browsable,
      testId: "action-questionnaire",
      disabledNote: disabled,
    },
    { title: "Upload Documents", sub: "Send tax documents securely", icon: CloudUpload, href: link(href("/client/tax-center/upload", `year=${selected}`)), testId: "upload-button", disabledNote: disabled },
    { title: "Retrieve Tax Filings", sub: "Access current and prior year returns", icon: FolderOpen, href: link(href("/client/taxes/filings", `year=${selected}`)), testId: "retrieve-button", disabledNote: disabled },
    { title: "Appointments", sub: "Schedule or manage your appointment", icon: CalendarDays, href: link(href("/client/appointments")), testId: "appointments-button", disabledNote: disabled },
    { title: "News & Updates", sub: "Tax updates & office news", icon: Mail, href: link(href("/client/news")), testId: "news-button", disabledNote: disabled },
  ];
  return { tiles, selected, years };
}

export function PortalHomeView({ data, q, readOnly, name, year, previewHref }: { data: Home; q: string; readOnly?: boolean; name?: string; accountName?: string; clientId?: string; linkFor?: (id: string) => string; year?: number; previewHref?: (path: string, extra: string) => string }) {
  // In the owner's View as Client, links open the matching read-only preview page.
  const href = (path: string, extra = "") => (previewHref ? previewHref(path, extra) : readOnly ? "#" : `${path}${q}${extra ? `${q ? "&" : "?"}${extra}` : ""}`);
  const browsable = !!previewHref;
  const { tiles, selected, years } = homeTiles({ data, q, readOnly, year, previewHref });
  const status = data.statuses.find((s) => s.year === selected);
  const doneCount = status?.steps.filter((s) => s.done).length ?? 0;
  const pill = status ? (status.steps.find((s) => !s.done)?.value ?? "Complete") : "Not started";
  const next = nextDeadline(data);
  const req = data.requests[0];
  const countdownLines = data.countdowns.cards.flatMap((c) => c.lines);
  const news = data.updates.map((a) => ({ id: a.id, title: a.title, body: a.body, topic: a.topic, clientId: a.clientId, pinned: a.pinned, at: a.publishedAt ?? a.createdAt }));

  return (
    <div className="space-y-6">
      {/* Welcome */}
      <section className="relative overflow-hidden rounded-[2rem] border border-gold-300/70 bg-gradient-to-br from-white via-ivory-50 to-gold-50 shadow-[0_20px_45px_-28px_rgb(10_26_68/0.45)]" data-testid="hero">
        {/* Gold swoosh accents (top-left and bottom-right), as in the brand design. */}
        <svg className="pointer-events-none absolute inset-0 z-[1] h-full w-full" viewBox="0 0 1000 300" preserveAspectRatio="none" aria-hidden>
          <path d="M0 70 C 60 10, 160 0, 260 4" fill="none" stroke="url(#swoosh)" strokeWidth="6" strokeLinecap="round" />
          <path d="M560 300 C 760 280, 930 250, 1000 170" fill="none" stroke="url(#swoosh)" strokeWidth="6" strokeLinecap="round" />
          <defs><linearGradient id="swoosh" x1="0" x2="1"><stop offset="0" stopColor="#E6C76A" /><stop offset="1" stopColor="#C89D29" /></linearGradient></defs>
        </svg>
        {/* Artwork sits beside the text on larger screens (never under it), with a soft fade, not a hard edge. */}
        <Mountains variant="light" className="absolute bottom-0 right-0 h-1/2 w-full opacity-80 [mask-image:linear-gradient(to_bottom,transparent,black_35%)] sm:inset-y-0 sm:h-full sm:w-[50%] sm:opacity-100 sm:[mask-image:linear-gradient(to_right,transparent,black_30%)] lg:w-[54%]" />
        {/* The text keeps its own column (left of the artwork) and long names wrap onto their own line. */}
        <div className="relative z-10 px-6 pb-28 pt-8 sm:max-w-[54%] sm:px-10 sm:py-12 lg:max-w-[50%]">
          <h1 className="font-serif text-2xl font-bold leading-[1.15] text-navy-900 [overflow-wrap:anywhere] sm:text-[1.75rem] lg:text-3xl" data-testid="hero-heading">
            Welcome Back{name ? "," : ""}
            {name && <span className="block text-balance">{name}</span>}
          </h1>
          <p className="mt-3 max-w-[34ch] text-[15px] text-navy-800 sm:text-base lg:text-lg">Your documents, tax filings, and updates—all in one secure place.</p>
          {next && (
            <Link href={href("/client/news")} className="mt-5 inline-flex items-center gap-2 rounded-full border border-gold-500 bg-gradient-to-b from-gold-100 to-gold-200/70 px-4 py-1.5 text-sm font-semibold text-navy-900 shadow-sm hover:from-gold-200" data-testid="hero-deadline">
              <CalendarDays className="size-4 text-gold-700" aria-hidden />Next deadline: {countdownText(next.days!)}
            </Link>
          )}
        </div>
      </section>

      {data.summariesWaiting.length > 0 && (
        <Link href={href("/client/taxes/summary")} className="flex items-center gap-3 rounded-2xl border-2 border-gold-500 bg-gold-50 px-4 py-3 text-sm font-semibold text-navy-950 hover:bg-gold-100" data-testid="summary-reminder">
          <span className="size-2 shrink-0 rounded-full bg-gold-600" aria-hidden />
          <span className="min-w-0 flex-1">Your {data.summariesWaiting.map((s) => s.taxYear).join(" and ")} tax return summary is ready. Please review and approve it so we can file.</span>
          <ChevronRight className="size-4" aria-hidden />
        </Link>
      )}

      {data.identityAlerts.length > 0 && (
        <Link href={href("/client/identity")} className="flex items-center gap-3 rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 hover:bg-amber-100" data-testid="identity-reminder">
          <span className="size-2 shrink-0 rounded-full bg-amber-500" aria-hidden />
          <span className="flex-1">{data.identityAlerts[0].text}{data.identityAlerts.length > 1 && ` (+${data.identityAlerts.length - 1} more)`}</span>
          <ChevronRight className="size-4" aria-hidden />
        </Link>
      )}

      {readOnly && (
        <p className="rounded-lg border border-gold-500 bg-gold-100 px-3 py-2 text-sm text-navy-950" data-testid="preview-note">
          {browsable ? "View as Client: every button opens the page the client would see, read-only. Nothing can be uploaded, signed or sent from here." : "Staff preview is read-only: these buttons are shown as the client sees them but don't open here."} To upload for the client, use their record&apos;s Documents tab.
        </p>
      )}
      <ActionTiles tiles={tiles} />
      <TaxDocsOnline />

      <div className="grid gap-6 lg:grid-cols-2">
        <section className={luxCard} data-testid="announcements">
          <PanelHead icon={Megaphone} title="News & Announcements" action={<Link href={href("/client/news")} className="inline-flex items-center gap-1 border-b border-gold-500 pb-0.5 text-sm font-semibold text-navy-900 hover:text-gold-700">View All <ChevronRight className="size-4" aria-hidden /></Link>} />
          <NewsList items={news} href={href("/client/news")} limit={2} />
        </section>
        <section className={luxCard} data-testid="countdowns-panel">
          <PanelHead icon={Clock} title="Tax Countdowns" action={<span className="rounded-full border border-gold-500 px-3 py-1 text-sm font-semibold text-navy-900">Next filing season</span>} />
          <div className="pt-3"><CountdownCards lines={countdownLines} max={7} /></div>
        </section>
      </div>

      {/* My Tax Center */}
      {data.perms.canViewTax && (
        <section className={card} data-testid="tax-center">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="font-serif text-xl sm:text-[1.375rem] font-bold text-navy-900">My {selected} Tax Progress</h2>
              <p className="text-sm text-slate-600">Manage your tax documents, filings, and year-specific tasks.</p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              {!readOnly && !browsable && <TaxYearSelect years={[...years].reverse()} year={selected} base={`/client${q}${q ? "&" : "?"}`} />}
              <nav aria-label="Tax year" className="flex flex-wrap gap-1.5" data-testid="year-chips">
                {years.map((y) => (
                  <Link key={y} href={href("/client", `year=${y}`)} scroll={false} aria-current={y === selected ? "true" : undefined} className={`rounded-full border px-2.5 py-1 text-xs sm:px-3.5 sm:py-1.5 sm:text-sm ${y === selected ? "border-gold-600 bg-gold-600 font-semibold text-white" : "border-ivory-200 bg-white text-navy-900 hover:border-gold-500"}`}>
                    {y}
                  </Link>
                ))}
              </nav>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
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

    </div>
  );
}
