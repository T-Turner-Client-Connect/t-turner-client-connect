import Image from "next/image";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Badge, Button, Field } from "@/components/ui";
import type { loadPortalHome } from "@/lib/portal/views";
import { MONTHS } from "@/lib/services/bookkeeping";
import { STATES } from "@/lib/resources/catalog";
import { fmtDate } from "@/lib/format";
import { fmtChicago } from "@/lib/tz";
import { referralAction } from "@/app/actions/tax-center";
import { NewsAndCountdowns } from "./news-countdowns";
import { QuestionnairePicker } from "./questionnaire-picker";

type Home = Awaited<ReturnType<typeof loadPortalHome>>;

function Panel({ title, href, cta, children, testId, className = "" }: { title: string; href?: string; cta?: string; children: React.ReactNode; testId?: string; className?: string }) {
  return (
    <section className={`flex flex-col rounded-2xl border border-ivory-200 border-t-4 border-t-gold-500 bg-white p-5 shadow-sm ${className}`} data-testid={testId}>
      <h2 className="mb-3 font-serif text-xl font-bold text-navy-900">{title}</h2>
      <div className="flex-1 text-sm">{children}</div>
      {href && cta && <Link href={href} className="mt-3 inline-block text-sm font-semibold text-navy-900 underline decoration-gold-500 decoration-2 underline-offset-4">{cta} →</Link>}
    </section>
  );
}

export function PortalHomeView({ data, linkFor, q, readOnly, name, accountName, clientId }: { data: Home; linkFor: (id: string) => string; q: string; readOnly?: boolean; name?: string; accountName?: string; clientId?: string }) {
  const href = (path: string) => (readOnly ? "#" : `${path}${q}`);
  const actions = [
    data.requests.length && { href: href("/client/bookkeeping"), label: "Upload requested documents", detail: `${data.requests.length} requested${data.requests[0]?.dueAt ? ` · first due ${fmtDate(data.requests[0].dueAt)}` : ""}` },
    data.readyPeriods.length && { href: href("/client/bookkeeping"), label: "Review report", detail: `${MONTHS[data.readyPeriods[0].month - 1]} ${data.readyPeriods[0].year} is ready` },
    data.contracts.length && { href: readOnly ? "#" : `/client/contracts/${data.contracts[0].id}${q}`, label: "Complete contract", detail: data.contracts[0].title },
    data.signatures.length && { href: href("/client/contracts"), label: "Sign documents", detail: data.signatures[0].title },
    data.unread && { href: href("/client/messages"), label: "Read messages", detail: `${data.unread} new` },
  ].filter(Boolean) as { href: string; label: string; detail: string }[];

  return (
    <div className="space-y-6">
      {/* Welcome */}
      <section className="relative overflow-hidden rounded-3xl bg-gradient-to-r from-navy-950 to-navy-800 p-5 text-white shadow-lg sm:p-6">
        <div className="flex items-center gap-4">
          <span className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-white p-1.5 shadow ring-2 ring-gold-500"><Image src="/brand/logo-mark.png" alt="TTurner & Associates Group" width={200} height={224} className="h-auto w-10" /></span>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-gold-300">TTurner Client Connect</p>
            <h1 className="font-serif text-2xl font-bold text-white sm:text-3xl">{name ? `Welcome, ${name}` : "Client dashboard"}</h1>
            {accountName && <p className="text-sm text-navy-100">Viewing <strong className="text-white">{accountName}</strong></p>}
          </div>
        </div>
        {actions.length > 0 && (
          <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Your next steps">
            {actions.map((a) => (
              <Link key={a.label} href={a.href} className="rounded-xl border border-white/10 bg-white/10 p-3 hover:bg-white/15">
                <span className="block font-semibold text-white">{a.label} →</span>
                <span className="text-sm text-navy-100">{a.detail}</span>
              </Link>
            ))}
          </div>
        )}
      </section>

      <NewsAndCountdowns cards={data.countdowns.cards} news={data.updates} personalized={data.personalized} />

      {/* My Tax Center */}
      {data.perms.canViewTax && (
        <section aria-labelledby="tax-center-heading" className="rounded-3xl border-2 border-gold-500 bg-ivory-50 p-5 shadow-md" data-testid="tax-center">
          <div className="mb-4">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-gold-700">Your taxes, in one place</p>
            <h2 id="tax-center-heading" className="font-serif text-2xl font-bold text-navy-900">My Tax Center</h2>
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-ivory-200" data-testid="tile-questionnaire">
              <p className="text-3xl" aria-hidden>📝</p>
              <h3 className="font-serif text-lg font-bold text-navy-900">Complete Tax Questionnaire</h3>
              <p className="mb-3 text-sm text-slate-700">Answer a few questions about your year so we can prepare your return.</p>
              <QuestionnairePicker options={data.questionnaires} disabled={readOnly} />
            </div>
            <div className="flex flex-col rounded-2xl bg-white p-4 shadow-sm ring-1 ring-ivory-200" data-testid="tile-upload">
              <p className="text-3xl" aria-hidden>📤</p>
              <h3 className="font-serif text-lg font-bold text-navy-900">Upload Documents</h3>
              <p className="flex-1 text-sm text-slate-700">W-2s, 1099s, receipts and letters go straight into your secure yearly Document Vault. Choose the tax year and the kind of document.</p>
              <Link href={href("/client/documents")} className="mt-3 inline-flex items-center justify-center rounded-xl bg-navy-900 px-4 py-2.5 font-semibold text-white hover:bg-navy-800" data-testid="upload-button">Upload documents →</Link>
            </div>
            <div className="flex flex-col rounded-2xl bg-white p-4 shadow-sm ring-1 ring-ivory-200" data-testid="tile-retrieve">
              <p className="text-3xl" aria-hidden>🗂️</p>
              <h3 className="font-serif text-lg font-bold text-navy-900">Retrieve Tax Filings</h3>
              <p className="flex-1 text-sm text-slate-700">Preview, download or print the returns and records our office has saved to your account — 2020 onward.</p>
              <Link href={href("/client/taxes/filings")} className="mt-3 inline-flex items-center justify-center rounded-xl border-2 border-gold-500 bg-navy-950 px-4 py-2.5 font-semibold text-gold-300 hover:bg-navy-900" data-testid="retrieve-button">Retrieve Tax Filings →</Link>
              {!data.verified && <p className="mt-2 text-xs text-amber-800">Verify your account first — we&apos;ll walk you through it.</p>}
            </div>
          </div>
        </section>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        {data.perms.canViewTax && (
          <Panel title="Service progress" href={href("/client/taxes")} cta="See your filings" className="lg:col-span-2" testId="service-progress">
            {data.progress.map((y) => (
              <div key={y.year} className="mb-4 last:mb-0">
                <p className="mb-2 font-semibold text-navy-900">
                  {y.year} tax year
                  {y.estimatedCompletion && <span className="ml-2 font-normal text-slate-700">· Estimated completion {fmtChicago(y.estimatedCompletion, { month: "long", day: "numeric", year: "numeric" })}</span>}
                </p>
                <ol className="grid gap-2 sm:grid-cols-5">
                  {y.steps.map((s) => (
                    <li key={s.key} className={`rounded-xl p-2.5 ${s.done ? "bg-emerald-50 ring-1 ring-emerald-200" : "bg-ivory-100"}`} data-step={s.key}>
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-600">{s.label}</p>
                      <p className={`text-sm font-semibold ${s.done ? "text-emerald-800" : "text-navy-900"}`}>{s.done ? "✓ " : ""}{s.value}</p>
                    </li>
                  ))}
                </ol>
                {y.estimateNote && <p className="mt-1 text-xs text-slate-600">{y.estimateNote}</p>}
              </div>
            ))}
            <p className="mt-2 text-xs text-slate-500">Each step is updated separately by our office. An estimate is not a guarantee.</p>
          </Panel>
        )}

        <Panel title="Document requests" href={href("/client/bookkeeping")} cta="Upload now" testId="doc-requests">
          {data.requests.length === 0 ? <p className="text-slate-600">Nothing requested right now.</p> : (
            <ul className="divide-y divide-navy-100">
              {data.requests.map((r) => (
                <li key={r.id} className="py-2">
                  <strong>{r.title}</strong>
                  {r.dueAt && <Badge tone={r.dueAt < new Date() ? "red" : "amber"} className="ml-2">Due {fmtDate(r.dueAt)}</Badge>}
                  {r.instructions && <span className="block text-slate-600">{r.instructions}</span>}
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Document Vault" href={href("/client/documents")} cta="Open your vault" testId="vault">
          {data.vault.length === 0 ? <p className="text-slate-600">Documents you and our office share will be organized here by year.</p> : (
            <ul className="grid grid-cols-2 gap-2">
              {data.vault.map((v) => (
                <li key={v.year ?? "none"}>
                  <Link href={readOnly ? "#" : `/client/documents${q}${q ? "&" : "?"}year=${v.year ?? "none"}`} className="flex items-center justify-between rounded-xl bg-ivory-100 px-3 py-2 hover:bg-gold-100">
                    <span className="font-semibold text-navy-900">📁 {v.year ?? "Year to confirm"}</span>
                    <span className="text-xs text-slate-600">{v.count}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {data.newDocs.length > 0 && (
            <div className="mt-3">
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-gold-700">New from our office</p>
              <ul className="space-y-1">{data.newDocs.slice(0, 3).map((d) => <li key={d.id}><a className="underline" href={linkFor(d.id)} target="_blank" rel="noopener">{d.title}</a></li>)}</ul>
            </div>
          )}
        </Panel>

        {data.perms.canMessage && (
          <Panel title="Messages" href={href("/client/messages")} cta="Open messages" testId="messages-panel">
            <p className="font-serif text-3xl font-bold text-navy-900">{data.unread}</p>
            <p className="text-slate-600">unread {data.unread === 1 ? "message" : "messages"}</p>
            {data.latestThread && <p className="mt-2 text-slate-700">Latest: <strong>{data.latestThread.subject ?? "Conversation"}</strong> · {fmtDate(data.latestThread.lastMessageAt)}</p>}
          </Panel>
        )}

        {data.perms.canViewBilling && (
          <Panel title="Invoices & Payments" href={href("/client/billing")} cta="View billing" testId="billing-panel">
            {data.billing.quotes + data.billing.invoices === 0 ? <p className="text-slate-600">No open quotes or invoices.</p> : (
              <ul className="space-y-1">
                {data.billing.quotes > 0 && <li><Badge tone="gold">{data.billing.quotes}</Badge> quote{data.billing.quotes === 1 ? "" : "s"} ready for your review</li>}
                {data.billing.invoices > 0 && <li><Badge tone="navy">{data.billing.invoices}</Badge> invoice{data.billing.invoices === 1 ? "" : "s"} on your account</li>}
              </ul>
            )}
          </Panel>
        )}

        <Panel title="Client Resource Center" testId="resources-panel">
          <p className="mb-3 text-slate-700">Official tax, license and filing links for your state, plus IRS, SBA and SAM.gov.</p>
          <form action={readOnly ? undefined : "/client/resources"} method="get" className="flex flex-wrap gap-2">
            {clientId && <input type="hidden" name="account" value={clientId} />}
            <label className="sr-only" htmlFor="home-state">State</label>
            <select id="home-state" name="state" className="input flex-1" defaultValue={data.state}>
              {STATES.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
            </select>
            <Button type="submit" variant="gold" disabled={readOnly}>Open</Button>
          </form>
          <Link href={href("/client/resources")} className="mt-3 inline-block text-sm font-semibold underline decoration-gold-500 decoration-2 underline-offset-4" data-testid="resources-button">Resources →</Link>
        </Panel>

        {data.perms.canMessage && clientId && (
          <Panel title="Referrals" testId="referrals-panel">
            <p className="mb-2 text-slate-700">Know someone who could use our help? Share their details and we&apos;ll reach out.</p>
            {readOnly ? <p className="text-xs text-slate-500">Clients see a short referral form here.</p> : (
              <ActionForm action={referralAction.bind(null, clientId)} className="space-y-2" resetOnSuccess>
                <Field label="Their name"><input className="input" name="name" required /></Field>
                <Field label="Phone or email"><input className="input" name="contact" required /></Field>
                <Field label="Note (optional)"><input className="input" name="note" /></Field>
                <Button type="submit" variant="secondary">Send referral</Button>
              </ActionForm>
            )}
          </Panel>
        )}

        {(data.contracts.length > 0 || data.signatures.length > 0 || data.readyPeriods.length > 0 || data.deadlines.length > 0) && (
          <Panel title="Also waiting for you" testId="also-waiting">
            <ul className="space-y-1">
              {data.contracts.map((c) => <li key={c.id}><Link className="underline" href={readOnly ? "#" : `/client/contracts/${c.id}${q}`}>{c.title}</Link>{c.dueAt && ` · due ${fmtDate(c.dueAt)}`}</li>)}
              {data.signatures.map((s) => <li key={s.id}>✍️ {s.title}</li>)}
              {data.readyPeriods.map((p) => <li key={p.id}><Badge tone="gold">Bookkeeping</Badge> {MONTHS[p.month - 1]} {p.year} is ready for review</li>)}
              {data.deadlines.map((d) => <li key={d.id}>📅 <strong>{fmtDate(d.dueAt)}</strong> — {d.title}</li>)}
            </ul>
          </Panel>
        )}
      </div>
    </div>
  );
}
