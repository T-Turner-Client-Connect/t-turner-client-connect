import Link from "next/link";
import { Download, FileSignature, Receipt } from "lucide-react";
import { Card, Notice } from "@/components/ui";
import { SignAgreementForm } from "@/components/portal/sign-agreement-form";
import { NavyCard, PageBanner } from "@/components/portal/luxury";
import { GoldNote, StatusPill, tableCard, type Tone } from "@/components/portal/billing-pages";
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
  { title: "Basic Individual Tax Return", sub: "W-2 income only · Simple return", price: "$300" },
  { title: "Married Filing Jointly", sub: "Basic W-2 return", price: "$400" },
  { title: "All 1099 & Business Tax Returns", sub: "Self-employed, business income and business filings", price: "$500", from: true },
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
  const banner = <PageBanner icon={FileSignature} title="Pricing & Agreements" subtitle="Our standard tax preparation pricing and your signed agreements." />;
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

      <div className="grid items-start gap-6 lg:grid-cols-[1.25fr_1fr]">
        <NavyCard icon={Receipt} title="Tax Preparation Pricing">
          <ul className="divide-y divide-ivory-200" data-testid="tax-pricing">
            {PRICES.map((p) => (
              <li key={p.title} className="flex items-center justify-between gap-4 py-4 first:pt-1 last:pb-1">
                <span className="min-w-0">
                  <span className="block font-serif text-lg font-bold leading-snug text-navy-900">{p.title}</span>
                  <span className="block text-sm text-slate-600">{p.sub}</span>
                </span>
                <span className="shrink-0 text-right">
                  {p.from && <span className="block text-xs font-semibold uppercase tracking-wide text-gold-700">Starting at</span>}
                  <span className="block font-serif text-3xl font-bold leading-none text-gold-600">{p.price}</span>
                </span>
              </li>
            ))}
          </ul>
        </NavyCard>
        <GoldNote title="Pricing Notice" testId="pricing-notice">
          <p>
            Prices are subject to change without notice. Tax preparation fees are based on the complexity of each individual return. Additional forms, schedules, income sources, and documentation may result in additional charges. Final pricing will be provided after reviewing your tax
            information.
          </p>
        </GoldNote>
      </div>

      <section className={tableCard} data-testid="your-agreements">
        <h2 className="flex items-center gap-3 bg-navy-900 px-5 py-3.5 font-serif text-xl font-bold text-white sm:text-2xl">
          <FileSignature className="size-6 shrink-0" aria-hidden /> Your Agreements
        </h2>
        {list.length === 0 ? (
          <p className="p-5 text-sm text-slate-600">When we prepare a pricing agreement for you, it will appear here.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-sm">
              <thead className="bg-ivory-50 text-left text-xs font-bold uppercase tracking-wide text-slate-600">
                <tr><th className="px-5 py-3">Agreement</th><th className="px-3 py-3">Date</th><th className="px-3 py-3">Status</th><th className="px-5 py-3 text-right">Download</th></tr>
              </thead>
              <tbody className="divide-y divide-ivory-200">
                {list.map((a) => {
                  const t = a.terms as unknown as AgreementTerms;
                  const [label, tone] = STATUS[a.status] ?? ["—", "muted"];
                  const open = a.status === "SENT" || a.status === "VIEWED";
                  return (
                    <tr key={a.id} data-testid={open ? "open-agreement" : "past-agreement"}>
                      <td className="px-5 py-3.5">
                        <span className="block font-semibold text-navy-900">{t.agreementTitle || t.serviceTitle}</span>
                        <span className="block text-xs text-slate-500">{t.taxYear ? `${t.taxYear} tax year` : t.periodLabel} · version {t.version}</span>
                      </td>
                      <td className="whitespace-nowrap px-3 py-3.5">{fmtDate(a.signedAt ?? a.sentAt ?? a.createdAt)}</td>
                      <td className="px-3 py-3.5"><StatusPill tone={tone}>{label}</StatusPill></td>
                      <td className="px-5 py-3.5 text-right">
                        {open ? (
                          <Link href={`/client/agreements?${q}&sign=${a.id}#sign`} className="inline-flex whitespace-nowrap rounded-lg bg-navy-900 px-3 py-1.5 font-semibold text-white hover:bg-navy-950">Review &amp; Sign</Link>
                        ) : a.pdfDocumentId ? (
                          <a className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-gold-500 px-3 py-1.5 font-semibold text-navy-900 hover:bg-gold-50" href={`/api/documents/${downloadToken(a.pdfDocumentId, { portalUserId: user.id })}`} target="_blank" rel="noopener">
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

      {signing && <SignCard a={signing} />}

      <GoldNote title="Important" testId="agreements-important">
        <p>This page displays our standard tax preparation pricing and your personalized pricing agreement. It is not a contract and does not automatically charge your account.</p>
      </GoldNote>
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
