import Link from "next/link";
import clsx from "clsx";
import { ArrowLeft, CalendarClock, CheckCircle2, Circle, Download, FileBadge, FileText, IdCard, MessageSquarePlus, ReceiptText, UsersRound, Wallet } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { Badge } from "@/components/ui";
import { usdc } from "@/components/bank/bank-ticker";
import { MONTH_NAMES } from "@/lib/bk-uploads";
import { LICENSE_STATUS, YEAR_END_STEPS, type licensesPageFor, type payrollPageFor, type yearEndPageFor } from "@/lib/services/portal-business-pages";
import { YEAR_END_STAGES } from "@/lib/services/business-overview";
import { CLIENT_INVOICE_STATUS, type clientInvoicingFor } from "@/lib/services/portal-client-invoicing";
import { requestCustomerInvoiceAction } from "@/app/actions/portal-invoicing";
import { previewFormAction } from "@/app/actions/preview";
import { PreviewDisabled } from "@/components/portal/preview-off";
import { PageBanner } from "./luxury";
import { NeedList } from "./business-dashboard";

/**
 * The portal pages behind the business dashboard's cards: Payroll, Business Licenses, 1099 / W-2
 * and Client Invoicing (Your Customers). Shared by the client's own pages and staff View as
 * Client (`readOnly`: nothing can be uploaded or requested; documents open with a staff link).
 */

type Payroll = Awaited<ReturnType<typeof payrollPageFor>>;
type Licenses = Awaited<ReturnType<typeof licensesPageFor>>;
type YearEnd = Awaited<ReturnType<typeof yearEndPageFor>>;
type Invoicing = Awaited<ReturnType<typeof clientInvoicingFor>> & { requests: { id: string; subject: string; sent: string; status: string }[]; canRequest: boolean };

const card = "min-w-0 rounded-2xl border border-gold-200/70 bg-white p-5 shadow-[0_1px_2px_rgb(10_26_68/0.05),0_14px_32px_-22px_rgb(10_26_68/0.4)] sm:p-6";
const navyCard = "min-w-0 rounded-2xl bg-gradient-to-br from-navy-900 to-navy-950 p-5 text-white shadow-[0_14px_32px_-22px_rgb(10_26_68/0.7)] ring-1 ring-gold-500/40 sm:p-6";
const h2 = "flex flex-wrap items-center gap-2 font-serif text-lg font-bold text-navy-900";
const navyBtn = "inline-flex items-center justify-center gap-1.5 rounded-lg bg-navy-900 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-navy-800";
const docLink = "inline-flex shrink-0 items-center gap-1.5 rounded-lg border-[1.5px] border-navy-900 bg-white px-3 py-1 text-sm font-semibold text-navy-900 hover:bg-ivory-50";

export const dayLabel = (d: string, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" }) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { ...opts, timeZone: "UTC" });

/** Page frame: the light banner, a way back to the dashboard, then the page's sections. */
function Shell({ icon, title, subtitle, back, testId, children }: { icon: React.ComponentType<{ className?: string }>; title: string; subtitle: string; back: string | null; testId: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 space-y-5" data-testid={testId}>
      <PageBanner icon={icon} title={title} subtitle={subtitle} />
      {back && (
        <Link href={back} className="inline-flex items-center gap-1 text-sm font-semibold text-navy-900 underline decoration-gold-500 underline-offset-4" data-testid="back-to-dashboard">
          <ArrowLeft className="size-4" aria-hidden /> Business dashboard
        </Link>
      )}
      {children}
    </div>
  );
}

function Empty({ children, testId }: { children: React.ReactNode; testId?: string }) {
  return <p className="mt-3 rounded-xl border border-dashed border-gold-300 bg-ivory-50 px-4 py-5 text-sm text-navy-800" data-testid={testId ?? "empty-state"}>{children}</p>;
}

/** Released documents, each opening through the viewer's own expiring document link. */
function DocList({ docs, linkFor, testId }: { docs: Payroll["documents"]; linkFor: (id: string) => string; testId: string }) {
  return (
    <ul className="mt-2 divide-y divide-ivory-200" data-testid={testId}>
      {docs.map((d) => (
        <li key={d.id} className="flex flex-wrap items-center gap-3 py-3">
          <FileText className="size-6 shrink-0 text-gold-600" aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block font-semibold text-navy-900 [overflow-wrap:anywhere]">{d.title}</span>
            <span className="text-xs text-slate-600">{[d.type, d.month && d.year ? `${MONTH_NAMES[d.month - 1]} ${d.year}` : d.year, `Released ${dayLabel(d.date)}`].filter(Boolean).join(" · ")}</span>
          </span>
          <a href={linkFor(d.id)} className={docLink} target={d.spreadsheet ? undefined : "_blank"} rel="noopener" data-testid="doc-link">
            <Download className="size-4" aria-hidden /> {d.spreadsheet ? "Download" : "Open"}
          </a>
        </li>
      ))}
    </ul>
  );
}

export function NotBusinessNotice() {
  return (
    <div className={card} data-testid="not-business">
      <p className="font-serif text-lg font-bold text-navy-900">This page is for business accounts</p>
      <p className="mt-1 text-sm text-navy-800">It shows your business&apos;s payroll, licenses, year-end forms and customer invoices once our office manages your business books. If you&apos;d like that, send us a message.</p>
    </div>
  );
}

// --- Payroll ---------------------------------------------------------------------------------------

export function PayrollPageView({ d, linkFor, back }: { d: Payroll; linkFor: (id: string) => string; back: string | null }) {
  const p = d.profile;
  return (
    <Shell icon={UsersRound} title="Payroll" subtitle={`${d.client.name} — your pay schedule, pay history and payroll reports.`} back={back} testId="payroll-page">
      <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className={clsx(navyCard, "lg:col-span-1")} data-testid="payroll-profile">
          <h2 className="flex items-center gap-2 font-serif text-lg font-bold text-white"><Wallet className="size-5 text-gold-400" aria-hidden /> Payroll profile</h2>
          {p ? (
            <dl className="mt-4 space-y-3 text-sm">
              <div className="flex justify-between gap-3 border-b border-white/10 pb-2"><dt className="text-navy-100">Provider</dt><dd className="text-right font-semibold">{p.provider ?? "—"}</dd></div>
              <div className="flex justify-between gap-3 border-b border-white/10 pb-2"><dt className="text-navy-100">Frequency</dt><dd className="text-right font-semibold">{p.frequency ?? "—"}</dd></div>
              <div className="flex justify-between gap-3 border-b border-white/10 pb-2"><dt className="text-navy-100">Next pay date</dt><dd className="text-right font-semibold" data-testid="payroll-next">{p.next ? dayLabel(p.next) : "We'll show it here"}</dd></div>
              <div className="flex items-center justify-between gap-3"><dt className="text-navy-100">Status</dt><dd><span className="rounded-full bg-emerald-500 px-3 py-0.5 text-xs font-semibold text-white">{p.status}</span></dd></div>
              {p.reports && <p className="pt-1 text-xs text-navy-100">Payroll reports: {p.reports}</p>}
            </dl>
          ) : (
            <p className="mt-4 rounded-xl bg-white/10 px-4 py-3 text-sm text-navy-100" data-testid="payroll-not-set-up">Payroll isn&apos;t set up for this account with our office. If your business runs payroll, send us a message and we&apos;ll add it.</p>
          )}
        </div>

        <div className={clsx(card, "lg:col-span-2")} data-testid="payroll-schedule">
          <h2 className={h2}><CalendarClock className="size-5 text-gold-600" aria-hidden /> Upcoming pay dates</h2>
          {d.schedule.length ? (
            <ul className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {d.schedule.map((s, i) => (
                <li key={s} className={clsx("rounded-xl px-3 py-3 text-center", i === 0 ? "bg-gold-100 ring-1 ring-gold-400" : "bg-ivory-50 ring-1 ring-ivory-200")}>
                  <p className="text-xs font-semibold uppercase tracking-wide text-navy-800">{dayLabel(s, { weekday: "short" })}</p>
                  <p className="font-serif text-lg font-bold text-navy-900">{dayLabel(s, { month: "short", day: "numeric" })}</p>
                  <p className="text-xs text-slate-600">{s.slice(0, 4)}</p>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>{p ? "Your pay dates appear here once our office records your first pay date." : "No payroll schedule on file."}</Empty>
          )}
          <p className="mt-3 text-xs text-slate-600">Pay dates follow your payroll frequency from the pay date on file with our office.</p>
        </div>
      </section>

      {d.canSeePayroll ? (
        <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className={card} data-testid="payroll-history">
            <h2 className={h2}><CheckCircle2 className="size-5 text-gold-600" aria-hidden /> Pay history</h2>
            {d.history.length ? (
              <ul className="mt-2 divide-y divide-ivory-200">
                {d.history.map((h) => (
                  <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                    <span className="font-semibold text-navy-900">Pay date {dayLabel(h.payDate)}</span>
                    <Badge tone={h.status.startsWith("Processed") || h.status.startsWith("Submitted") ? "green" : h.status.startsWith("Denied") ? "red" : "gold"}>{h.status}</Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty testId="payroll-history-empty">No payroll runs recorded with our office yet.</Empty>
            )}
          </div>
          <div className={card} data-testid="payroll-documents">
            <h2 className={h2}><FileText className="size-5 text-gold-600" aria-hidden /> Payroll reports &amp; filings</h2>
            {d.documents.length ? <DocList docs={d.documents} linkFor={linkFor} testId="payroll-doc-list" /> : <Empty testId="payroll-docs-empty">No payroll reports or filings have been released to you yet. Quarterly 941s, W-2s and payroll registers appear here once our office releases them. Have a payroll file for us? <Link className="font-semibold underline" href={`/client/documents?account=${d.client.id}&cat=payroll`}>Send it from your Document Vault →</Link></Empty>}
          </div>
        </section>
      ) : (
        <p className={clsx(card, "text-sm text-navy-800")} data-testid="payroll-no-access">Your login doesn&apos;t include payroll reports for this business. The account owner can ask our office to add them.</p>
      )}
    </Shell>
  );
}

// --- Business licenses -----------------------------------------------------------------------------

export function LicensesPageView({ d, linkFor, back }: { d: Licenses; linkFor: (id: string) => string; back: string | null }) {
  return (
    <Shell icon={IdCard} title="Business Licenses" subtitle={`${d.client.name} — the licenses and permits we track for you, with renewal dates.`} back={back} testId="licenses-page">
      <section className={card} data-testid="license-list">
        <h2 className={h2}>
          <IdCard className="size-5 text-gold-600" aria-hidden /> Your licenses
          {d.licenses.length > 0 && (d.expired ? <Badge tone="red">{d.expired} Expired</Badge> : <Badge tone="green">None expired</Badge>)}
        </h2>
        {d.licenses.length ? (
          <ul className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
            {d.licenses.map((l) => {
              const s = LICENSE_STATUS[l.status];
              return (
                <li key={l.id} className="min-w-0 rounded-xl border border-ivory-200 bg-ivory-50/60 p-4" data-testid="license" data-status={l.status}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className="min-w-0 font-serif text-base font-bold text-navy-900 [overflow-wrap:anywhere]">{l.name}</p>
                    <Badge tone={s.tone}>{s.label}</Badge>
                  </div>
                  <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                    <dt className="text-slate-600">Jurisdiction</dt><dd className="min-w-0 text-navy-900 [overflow-wrap:anywhere]">{l.jurisdiction ?? "—"}</dd>
                    {l.number && <><dt className="text-slate-600">License no.</dt><dd className="min-w-0 text-navy-900 [overflow-wrap:anywhere]">{l.number}</dd></>}
                    <dt className="text-slate-600">Renewal</dt><dd className="font-semibold text-navy-900">{l.renewal ? dayLabel(l.renewal) : "Not on file"}</dd>
                  </dl>
                </li>
              );
            })}
          </ul>
        ) : (
          <Empty testId="licenses-empty">No licenses on file with us yet. When our office adds your business licenses and permits, their renewal dates appear here and on your dashboard.</Empty>
        )}
      </section>
      <section className={card} data-testid="license-documents">
        <h2 className={h2}><FileText className="size-5 text-gold-600" aria-hidden /> License documents</h2>
        <p className="text-sm text-slate-600">Copies of your licenses released to you or sent by you.</p>
        {d.documents.length ? <DocList docs={d.documents} linkFor={linkFor} testId="license-doc-list" /> : <Empty testId="license-docs-empty">No license documents in your portal yet. Have a license or permit to share? <Link className="font-semibold underline" href={`/client/documents?account=${d.client.id}`}>Upload it in your Document Vault →</Link></Empty>}
      </section>
    </Shell>
  );
}

// --- 1099 / W-2 ------------------------------------------------------------------------------------

function Steps({ step }: { step: number }) {
  return (
    <ol className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3" aria-label="Year-end progress">
      {YEAR_END_STEPS.map((s, i) => {
        const done = step > i + 1 || (step === YEAR_END_STEPS.length && i === YEAR_END_STEPS.length - 1);
        const current = step === i + 1 && !done;
        return (
          <li key={s} className={clsx("flex items-center gap-2 rounded-xl px-3 py-2 text-sm", done ? "bg-emerald-50 text-emerald-800" : current ? "bg-gold-100 font-semibold text-navy-900 ring-1 ring-gold-400" : "bg-ivory-50 text-slate-600")} data-done={done ? "true" : undefined} data-current={current ? "true" : undefined}>
            {done ? <CheckCircle2 className="size-5 shrink-0 fill-emerald-600 text-white" aria-hidden /> : <Circle className={clsx("size-5 shrink-0", current ? "text-gold-600" : "text-slate-400")} aria-hidden />}
            {YEAR_END_STAGES[s].label}
          </li>
        );
      })}
    </ol>
  );
}

export function YearEndPageView({ d, canUpload, back, readOnly }: { d: YearEnd; canUpload: boolean; back: string | null; readOnly?: boolean }) {
  return (
    <Shell icon={FileBadge} title="1099 / W-2" subtitle={`${d.client.name} — year-end W-2 and 1099 progress, and the forms we need from you.`} back={back} testId="year-end-page">
      {!d.season.active && (
        <p className="rounded-xl border border-gold-300 bg-gold-50/70 px-4 py-3 text-sm text-navy-900" data-testid="year-end-season">Year-end form requests for {d.season.taxYear} start in {d.season.startsIn}. Anything already requested is listed below.</p>
      )}
      {d.years.length === 0 ? (
        <section className={card}>
          <Empty testId="year-end-empty">Year-end W-2 / 1099 work hasn&apos;t started for your business. When our office starts the contractor review or requests forms from you, they appear here.</Empty>
        </section>
      ) : (
        d.years.map((y) => (
          <section key={y.taxYear} className={card} data-testid="year-end-year" data-year={y.taxYear}>
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-ivory-200 pb-3">
              <div className="min-w-0">
                <h2 className={h2}>{y.taxYear} Year-End <Badge tone={y.stage === "FILED" ? "green" : y.stage === "NOT_STARTED" ? "gray" : "gold"}>{y.stageLabel}</Badge></h2>
                {y.deadline && <p className="text-sm text-navy-800">W-2 / 1099 filing deadline: <span className="font-semibold">{dayLabel(y.deadline)}</span></p>}
              </div>
              <div className="grid grid-cols-2 gap-3 text-center" data-testid="year-end-counts">
                <div className="rounded-xl bg-ivory-50 px-4 py-2 ring-1 ring-ivory-200"><p className="font-serif text-xl font-bold text-navy-900">{y.requested}</p><p className="text-xs text-navy-800">Forms requested</p></div>
                <div className="rounded-xl bg-ivory-50 px-4 py-2 ring-1 ring-ivory-200"><p className="font-serif text-xl font-bold text-navy-900">{y.received}</p><p className="text-xs text-navy-800">Received</p></div>
              </div>
            </div>
            <Steps step={y.step} />
            {y.items.length ? <NeedList items={y.items} clientId={d.client.id} canUpload={canUpload} readOnly={readOnly} /> : <Empty testId="year-end-no-forms">No forms requested from you for {y.taxYear}.</Empty>}
          </section>
        ))
      )}
    </Shell>
  );
}

// --- Client invoicing ------------------------------------------------------------------------------

function RequestForm({ clientId, customers, readOnly }: { clientId: string; customers: Invoicing["customers"]; readOnly?: boolean }) {
  return (
    <PreviewDisabled readOnly={readOnly}>
    <ActionForm action={readOnly ? previewFormAction : requestCustomerInvoiceAction.bind(null, clientId)} className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2" resetOnSuccess idempotent>
      <label className="text-sm font-semibold text-navy-900">Customer
        <select className="input mt-1" name="customerId" defaultValue={customers.length ? "" : "NEW"} required>
          {customers.length > 0 && <option value="" disabled>Choose…</option>}
          {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          <option value="NEW">A new customer (type the name)</option>
        </select>
      </label>
      <label className="text-sm font-semibold text-navy-900">New customer&apos;s name <span className="font-normal text-slate-600">(if not listed)</span>
        <input className="input mt-1" name="customerName" maxLength={120} autoComplete="off" />
      </label>
      <label className="text-sm font-semibold text-navy-900">Amount
        <input className="input mt-1" name="amount" inputMode="decimal" placeholder="1,250.00" required />
      </label>
      <label className="text-sm font-semibold text-navy-900">Due date
        <input className="input mt-1" type="date" name="dueDate" required />
      </label>
      <label className="text-sm font-semibold text-navy-900 sm:col-span-2">What it&apos;s for
        <textarea className="input mt-1" name="description" rows={3} maxLength={1000} required placeholder="e.g. October catering, 120 boxed lunches" />
      </label>
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <button type="submit" className={navyBtn} data-testid="send-invoice-request"><MessageSquarePlus className="size-4" aria-hidden /> Send request to our office</button>
        <p className="text-xs text-slate-600">Our office creates and sends the invoice. Nothing is sent to your customer from here.</p>
      </div>
    </ActionForm>
    </PreviewDisabled>
  );
}

export function InvoicingPageView({ d, back, readOnly }: { d: Invoicing; back: string | null; readOnly?: boolean }) {
  const t = d.totals;
  return (
    <Shell icon={ReceiptText} title="Client Invoicing" subtitle={`${d.client.name} — invoices we keep for your customers, and the payments received.`} back={back} testId="invoicing-page">
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-3" data-testid="invoicing-totals">
        <div className={navyCard}><p className="text-sm text-navy-100">Open balance</p><p className="font-serif text-2xl font-bold">{usdc(t.openCents)}</p><p className="text-xs text-navy-100">{t.openCount} open invoice{t.openCount === 1 ? "" : "s"}</p></div>
        <div className={card}><p className="text-sm text-navy-800">Overdue</p><p className="font-serif text-2xl font-bold text-navy-900">{t.overdueCount}</p><p className="text-xs text-slate-600">past their due date</p></div>
        <div className={card}><p className="text-sm text-navy-800">Collected ({t.year})</p><p className="font-serif text-2xl font-bold text-navy-900">{usdc(t.collectedYtdCents)}</p><p className="text-xs text-slate-600">payments recorded this year</p></div>
      </section>

      <section id="invoices" className={clsx(card, "scroll-mt-20")} data-testid="invoice-list">
        <h2 className={h2}><ReceiptText className="size-5 text-gold-600" aria-hidden /> Invoices</h2>
        {d.invoices.length ? (
          <>
            <div className="mt-3 hidden md:block">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-ivory-200 text-xs uppercase tracking-wide text-slate-600">
                  <tr><th className="py-2 pr-3">Invoice</th><th className="py-2 pr-3">Customer</th><th className="py-2 pr-3">Issued</th><th className="py-2 pr-3">Due</th><th className="py-2 pr-3 text-right">Amount</th><th className="py-2 pr-3 text-right">Balance</th><th className="py-2">Status</th></tr>
                </thead>
                <tbody className="divide-y divide-ivory-200">
                  {d.invoices.map((i) => {
                    const s = CLIENT_INVOICE_STATUS[i.display] ?? CLIENT_INVOICE_STATUS.OPEN;
                    return (
                      <tr key={i.id} data-testid="invoice-row">
                        <td className="py-2.5 pr-3 font-semibold text-navy-900">{i.number}</td>
                        <td className="max-w-[16rem] py-2.5 pr-3 text-navy-900 [overflow-wrap:anywhere]">{i.customer}</td>
                        <td className="whitespace-nowrap py-2.5 pr-3 text-slate-700">{dayLabel(i.issued)}</td>
                        <td className="whitespace-nowrap py-2.5 pr-3 text-slate-700">{dayLabel(i.due)}</td>
                        <td className="py-2.5 pr-3 text-right tabular-nums text-navy-900">{usdc(i.totalCents)}</td>
                        <td className="py-2.5 pr-3 text-right tabular-nums font-semibold text-navy-900">{usdc(i.balanceCents)}</td>
                        <td className="py-2.5"><Badge tone={s.tone}>{s.label}</Badge></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <ul className="mt-2 divide-y divide-ivory-200 md:hidden">
              {d.invoices.map((i) => {
                const s = CLIENT_INVOICE_STATUS[i.display] ?? CLIENT_INVOICE_STATUS.OPEN;
                return (
                  <li key={i.id} className="py-3 text-sm">
                    <div className="flex items-start justify-between gap-2">
                      <p className="min-w-0 font-semibold text-navy-900 [overflow-wrap:anywhere]">{i.number} · {i.customer}</p>
                      <Badge tone={s.tone}>{s.label}</Badge>
                    </div>
                    <p className="text-xs text-slate-600">Issued {dayLabel(i.issued)} · Due {dayLabel(i.due)}</p>
                    <p className="mt-0.5 tabular-nums text-navy-900">{usdc(i.totalCents)}{i.balanceCents > 0 && i.balanceCents !== i.totalCents && <span className="text-slate-600"> · balance {usdc(i.balanceCents)}</span>}</p>
                  </li>
                );
              })}
            </ul>
          </>
        ) : (
          <Empty testId="invoices-empty">No invoices to your customers yet. When our office creates invoices for your business, they appear here with their status.</Empty>
        )}
      </section>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div id="payments" className={clsx(card, "scroll-mt-20")} data-testid="payment-history">
          <h2 className={h2}><Wallet className="size-5 text-gold-600" aria-hidden /> Payment history</h2>
          {d.payments.length ? (
            <ul className="mt-2 divide-y divide-ivory-200">
              {d.payments.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm" data-testid="payment-row">
                  <span className="min-w-0">
                    <span className="block font-semibold text-navy-900 [overflow-wrap:anywhere]">{p.customer} · {p.invoice}</span>
                    <span className="text-xs text-slate-600">{dayLabel(p.receivedOn)} · {p.method} · Receipt {p.receipt}</span>
                  </span>
                  <span className="font-serif text-base font-bold tabular-nums text-emerald-700">{usdc(p.amountCents)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty testId="payments-empty">No customer payments recorded yet.</Empty>
          )}
        </div>

        <div id="request" className={clsx(card, "scroll-mt-20")} data-testid="invoice-request">
          <h2 className={h2}><MessageSquarePlus className="size-5 text-gold-600" aria-hidden /> Request an invoice</h2>
          <p className="text-sm text-navy-800">Tell us who to invoice, how much and when it&apos;s due. We&apos;ll create the invoice for you.</p>
          {d.canRequest || readOnly ? (
            <RequestForm clientId={d.client.id} customers={d.customers} readOnly={readOnly} />
          ) : (
            <p className="mt-3 text-sm text-slate-600" data-testid="request-no-access">Your login can&apos;t send requests to our office. The account owner can ask us to add messaging.</p>
          )}
          {d.requests.length > 0 && (
            <div className="mt-4 border-t border-ivory-200 pt-3" data-testid="recent-requests">
              <h3 className="text-sm font-semibold text-navy-900">Your recent requests</h3>
              <ul className="mt-1 space-y-1 text-sm">
                {d.requests.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-baseline justify-between gap-x-2">
                    <span className="min-w-0 text-navy-900 [overflow-wrap:anywhere]">{r.subject.replace(/^Customer invoice request from [^:]*: /, "")}</span>
                    <span className="text-xs text-slate-600">{dayLabel(r.sent)} · {r.status}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </section>
    </Shell>
  );
}
