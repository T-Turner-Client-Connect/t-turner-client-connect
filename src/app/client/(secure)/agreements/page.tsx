import { ActionForm } from "@/components/action-form";
import { Badge, Button, Card, EmptyState, Notice, PageHeader } from "@/components/ui";
import { SignAgreementForm } from "@/components/portal/sign-agreement-form";
import { changeMethodAction, signAgreementAction } from "@/app/actions/service-agreements";
import { requirePortalUser } from "@/lib/portal/session";
import { resolveAccount } from "@/lib/portal/account";
import { downloadToken } from "@/lib/services/documents";
import { methodLabel, portalAgreements, signingHash, viewAgreement } from "@/lib/services/service-agreements";
import { CONSENT_TEXT, type AgreementSelection, type AgreementTerms } from "@/lib/billing/agreement-terms";
import { usd } from "@/lib/billing/payment-fees";
import { fmtDateTime } from "@/lib/format";

export const metadata = { title: "Pricing agreements" };

/** The client's pricing agreements: open ones to review and sign, signed ones to view. */
export default async function PortalAgreements({ searchParams }: { searchParams: Promise<{ account?: string }> }) {
  const user = await requirePortalUser();
  const { current } = await resolveAccount(user.id, (await searchParams).account);
  if (!current) return null;
  if (!current.canViewBilling) {
    return (
      <>
        <PageHeader title="Pricing agreements" />
        <Notice>Billing isn&apos;t included in your access to this account.</Notice>
      </>
    );
  }
  let list = await portalAgreements(user, current.clientId);
  // Opening the page marks newly sent agreements as viewed.
  for (const a of list.filter((x) => x.status === "SENT")) await viewAgreement(user, a.id);
  if (list.some((x) => x.status === "SENT")) list = await portalAgreements(user, current.clientId);
  const open = list.filter((a) => a.status === "SENT" || a.status === "VIEWED");
  const rest = list.filter((a) => a.status !== "SENT" && a.status !== "VIEWED");

  return (
    <>
      <PageHeader title="Pricing agreements" subtitle="Before we begin any service, you review its price and choose how you'll pay. Your signed copies are saved in your documents." />
      {list.length === 0 && <EmptyState title="Nothing to sign">When we prepare a pricing agreement for a service, it will appear here.</EmptyState>}
      <div className="space-y-4">
        {open.map((a) => {
          const t = a.terms as unknown as AgreementTerms;
          const options = t.options.filter((o) => o.available);
          const hashes = Object.fromEntries(options.map((o) => [o.method, signingHash(t, o.method)]));
          return (
            <Card key={a.id} title={<span data-testid="open-agreement">{t.agreementTitle}</span>} actions={<Badge tone="amber">Waiting for your signature</Badge>}>
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
          );
        })}
        {rest.length > 0 && (
          <Card title="Signed and earlier agreements">
            <ul className="divide-y divide-ivory-200 text-sm" data-testid="past-agreements">
              {rest.map((a) => {
                const t = a.terms as unknown as AgreementTerms;
                const sel = a.selection as unknown as AgreementSelection | null;
                return (
                  <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                    <span>
                      <strong>{t.serviceTitle}</strong> · version {t.version} ·{" "}
                      <Badge tone={a.status === "SIGNED" ? "green" : "gray"}>{a.status === "SIGNED" ? "Signed" : a.status === "SUPERSEDED" ? "Replaced by a newer version" : "Void"}</Badge>
                      {a.signedAt && <span className="block text-xs text-slate-600">Signed {fmtDateTime(a.signedAt)} by {a.signerName}{sel ? ` · ${methodLabel(sel.method)} · total ${usd(sel.totalCents)}` : ""}</span>}
                    </span>
                    <span className="flex flex-wrap gap-2">
                      {a.pdfDocumentId && <a className="rounded-lg border border-navy-700 px-3 py-1.5 font-semibold text-navy-900" href={`/api/documents/${downloadToken(a.pdfDocumentId, { portalUserId: user.id })}`} target="_blank" rel="noopener">View signed copy</a>}
                      {a.status === "SIGNED" && (
                        <ActionForm action={changeMethodAction.bind(null, a.id)} confirm="Request a revised agreement with a different payment method? Your current agreement stays in effect until you sign the new one.">
                          <Button type="submit" variant="ghost">Change payment method</Button>
                        </ActionForm>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          </Card>
        )}
      </div>
    </>
  );
}
