import Link from "next/link";
import { Briefcase, Coins, Download, FileSignature, FileText, Handshake, PenLine, Users } from "lucide-react";
import { Card, Notice } from "@/components/ui";
import { SignAgreementForm } from "@/components/portal/sign-agreement-form";
import { PageBanner } from "@/components/portal/luxury";
import { GoldNote, luxPanel, navyTable, NoteBar, PanelTitle, pillButton, StatusPill, type Tone } from "@/components/portal/billing-pages";
import { signAgreementAction } from "@/app/actions/service-agreements";
import { requirePortalUser } from "@/lib/portal/session";
import { resolveAccount } from "@/lib/portal/account";
import { downloadToken } from "@/lib/services/documents";
import { portalAgreements, signingHash, viewAgreement } from "@/lib/services/service-agreements";
import { CONSENT_TEXT, type AgreementTerms } from "@/lib/billing/agreement-terms";
import { usd } from "@/lib/billing/payment-fees";
import { fmtDate } from "@/lib/format";

export const metadata = { title: "Pricing & Agreements" };

const PRICES = [
  { title: "Basic Individual Tax Return", sub: "W-2 income only · Simple return", price: "$300", icon: Coins },
  { title: "Married Filing Jointly", sub: "Basic W-2 return", price: "$400", icon: Users },
  { title: "All 1099 & Business Tax Returns", sub: "Self-employed, business income and business filings", price: "$500", from: true, icon: Briefcase },
];

const STATUS: Record<string, [string, Tone]> = {
  SENT: ["Waiting for your signature", "pending"],
  VIEWED: ["Waiting for your signature", "pending"],
  SIGNED: ["Signed", "paid"],
  SUPERSEDED: ["Replaced", "muted"],
  VOID: ["Void", "muted"],
};

/** Pricing & Agreements, built to Tabitha's design: standard pricing, pricing notice, the client's agreements. */
export default async function PortalAgreements({ searchParams }: { searchParams: Promise<{ account?: string; sign?: string }> }) {
  const user = await requirePortalUser();
  const sp = await searchParams;
  const { current } = await resolveAccount(user.id, sp.account);
  if (!current) return null;
  const banner = <PageBanner icon={FileSignature} title="Pricing & Agreements" subtitle="Review our tax preparation pricing and access your agreements in one place." />;
  if (!current.canViewBilling) {
    return (
      <>
        {banner}
        <Notice>Billing isn&apos;t included in your access to this account.</Notice>
      </>
    );
  }
  let list = await portalAgreements(user, current.clientId);
  // Opening the page marks newly sent agreements as viewed.
  for (const a of list.filter((x) => x.status === "SENT")) await viewAgreement(user, a.id);
  if (list.some((x) => x.status === "SENT")) list = await portalAgreements(user, current.clientId);
  const q = `account=${current.clientId}`;
  const signing = list.find((a) => a.id === sp.sign && (a.status === "SENT" || a.status === "VIEWED"));

  return (
    <div className="space-y-6" data-testid="pricing-agreements">
      {banner}

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[1fr_1.2fr]">
        <section className={`${luxPanel} overflow-hidden`} data-testid="tax-pricing-card">
          <h2 className="flex items-center gap-3 rounded-2xl bg-gradient-to-b from-navy-900 to-navy-950 px-5 py-4 font-serif text-2xl font-bold text-white sm:text-[1.7rem]">
            <Coins className="size-9 shrink-0 text-gold-400" aria-hidden /> Tax Preparation Pricing
          </h2>
          <ul className="divide-y divide-gold-200/70 px-5 pb-3" data-testid="tax-pricing">
            {PRICES.map((p) => (
              <li key={p.title} className="flex items-center gap-4 py-5">
                <p.icon className="size-9 shrink-0 text-gold-600" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block font-serif text-lg font-bold leading-snug text-navy-900 sm:text-xl">{p.title}</span>
                  <span className="block text-sm text-navy-800">{p.sub}</span>
                </span>
                <span className="flex min-w-[6.5rem] shrink-0 flex-col items-center rounded-2xl border border-gold-300 bg-gradient-to-b from-gold-50 to-gold-100 px-4 py-2 text-center shadow-sm">
                  {p.from && <span className="text-xs font-semibold text-navy-900">Starting at</span>}
                  <span className="font-serif text-3xl font-bold leading-none text-navy-900">{p.price}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>

        <div className="min-w-0 space-y-6">
          <GoldNote title="Pricing Notice" testId="pricing-notice">
            <p>
              Prices are subject to change without notice. Tax preparation fees are based on the complexity of each individual return. Additional forms, schedules, income sources, and documentation may result in additional charges. Final pricing will be provided after reviewing your tax
              information.
            </p>
          </GoldNote>

          <section className={`${luxPanel} p-4 sm:p-5`} data-testid="your-agreements">
            <PanelTitle icon={Handshake} title="Your Agreements" sub="View your personalized pricing agreement and any signed documents." />
            {list.length === 0 ? (
              <p className="mt-4 rounded-xl bg-white px-4 py-5 text-sm text-slate-600 ring-1 ring-ivory-200">When we prepare a pricing agreement for you, it will appear here.</p>
            ) : (
              <div className="relative mt-4 overflow-x-auto">
                <table className={`${navyTable} min-w-[34rem]`}>
                  <thead>
                    <tr><th className="pl-4 pr-3">Agreement</th><th className="px-3">Date</th><th className="px-3">Status</th><th className="px-3 text-center">Action</th></tr>
                  </thead>
                  <tbody>
                    {list.map((a) => {
                      const t = a.terms as unknown as AgreementTerms;
                      const [label, tone] = STATUS[a.status] ?? ["—", "muted"];
                      const open = a.status === "SENT" || a.status === "VIEWED";
                      return (
                        <tr key={a.id} className="bg-white" data-testid={open ? "open-agreement" : "past-agreement"}>
                          <td className="py-3 pl-4 pr-3">
                            <span className="flex items-center gap-2 font-semibold text-navy-900"><FileText className="size-5 shrink-0 text-gold-600" aria-hidden />{t.agreementTitle || t.serviceTitle}</span>
                          </td>
                          <td className="whitespace-nowrap px-3 py-3 text-navy-900">{fmtDate(a.signedAt ?? a.sentAt ?? a.createdAt)}</td>
                          <td className="px-3 py-3"><StatusPill tone={tone}>{label}</StatusPill></td>
                          <td className="px-3 py-3 text-center">
                            {open ? (
                              <Link href={`/client/agreements?${q}&sign=${a.id}#sign`} className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-navy-900 px-4 py-1.5 text-[13px] font-semibold text-white hover:bg-navy-950"><PenLine className="size-4" aria-hidden /> Review &amp; Sign</Link>
                            ) : a.pdfDocumentId ? (
                              <a className={pillButton} href={`/api/documents/${downloadToken(a.pdfDocumentId, { portalUserId: user.id })}`} target="_blank" rel="noopener">
                                <Download className="size-4" aria-hidden /> Download
                              </a>
                            ) : (
                              <span className="text-slate-400">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      </div>

      {signing && <SignCard a={signing} />}

      <NoteBar icon={FileText} title="Important" testId="agreements-important">
        <p>This page displays our standard tax preparation pricing and your personalized pricing agreement. It is not a contract and does not automatically charge your account.</p>
      </NoteBar>
    </div>
  );
}

/** The existing review-and-sign flow for one open agreement (opened from "Review & Sign"). */
function SignCard({ a }: { a: Awaited<ReturnType<typeof portalAgreements>>[number] }) {
  const t = a.terms as unknown as AgreementTerms;
  const options = t.options.filter((o) => o.available);
  const hashes = Object.fromEntries(options.map((o) => [o.method, signingHash(t, o.method)]));
  return (
    <div id="sign" className="scroll-mt-24">
      <Card title={t.agreementTitle}>
        <dl className="mb-4 grid gap-2 text-sm sm:grid-cols-2">
          <div><dt className="text-xs uppercase text-slate-500">Client</dt><dd>{t.clientName}{t.businessName ? ` · ${t.businessName}` : ""}</dd></div>
          <div><dt className="text-xs uppercase text-slate-500">Service</dt><dd>{t.serviceTitle}</dd></div>
          <div><dt className="text-xs uppercase text-slate-500">{t.taxYear ? "Tax year" : "Service period"}</dt><dd>{t.taxYear ?? t.periodLabel}</dd></div>
          <div><dt className="text-xs uppercase text-slate-500">Version</dt><dd>{t.version}</dd></div>
          {t.description && <div className="sm:col-span-2"><dt className="text-xs uppercase text-slate-500">Description</dt><dd>{t.description}</dd></div>}
        </dl>
        <table className="mb-4 w-full text-sm" data-testid="agreement-lines">
          <tbody>
            {t.lines.map((l, i) => <tr key={i}><td className="py-1">{l.label}</td><td className="py-1 text-right">{usd(l.cents)}</td></tr>)}
            <tr className="border-t font-semibold"><td className="py-1">Agreed price</td><td className="py-1 text-right">{usd(t.baseCents)}</td></tr>
          </tbody>
        </table>
        <p className="mb-4 whitespace-pre-wrap text-sm"><strong>Payment terms:</strong> {t.paymentTerms}</p>
        {(t.disclaimers ?? []).map((d) => (
          <div key={d.title} className="mb-4 rounded-xl border border-gold-300 bg-ivory-50 p-3 text-sm" data-testid="agreement-disclaimer">
            <p className="mb-1 font-semibold text-navy-900">{d.title}</p>
            <p className="whitespace-pre-wrap">{d.text}</p>
            <p className="mt-2 text-xs text-slate-600">Signing this agreement acknowledges this disclaimer.</p>
          </div>
        ))}
        <SignAgreementForm action={signAgreementAction.bind(null, a.id)} baseCents={t.baseCents} options={options} hashes={hashes} consentText={CONSENT_TEXT} />
      </Card>
    </div>
  );
}
