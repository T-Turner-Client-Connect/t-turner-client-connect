import { PageHeader } from "@/components/ui";
import { QuoteForm } from "@/components/owner/quote-form";
import { saveQuoteAction } from "@/app/actions/owner";
import { requireOwner } from "@/lib/auth/owner";
import { billingSettings, todayYmd } from "@/lib/services/owner-billing";
import { addMonths } from "@/lib/billing/pricing";
import { prisma } from "@/lib/prisma";

const plain = (type: string, v: number) => (type === "FLAT" || type === "PERCENT" ? (v / 100).toString() : "");

export default async function NewQuotePage({ searchParams }: { searchParams: Promise<{ client?: string }> }) {
  const { access } = await requireOwner("billing");
  const [s, clients, sp] = await Promise.all([billingSettings(), prisma.client.findMany({ where: { archivedAt: null }, select: { id: true, displayName: true }, orderBy: { displayName: "asc" } }), searchParams]);
  const today = todayYmd();
  return (
    <>
      <PageHeader title="New quote / invoice" subtitle="Save as a draft, then send it as a quote for the client to accept, or issue it as an invoice." />
      <QuoteForm
        action={saveQuoteAction.bind(null, null)}
        clients={clients}
        fee={{ type: s.planFeeType, value: s.planFeeValue, maxInstallments: s.maxInstallments, confirmed: !!s.planFeeRulesConfirmedAt }}
        canOverrideFee={access.scope === "FULL"}
        submitLabel="Save draft"
        defaults={{
          clientId: sp.client ?? "",
          title: "",
          issueDate: today,
          dueDate: addMonths(today, 1),
          memo: "",
          paymentTerms: s.defaultPaymentTerms ?? "",
          privateNote: "",
          lines: [{ service: "", description: "", quantity: "1", price: "" }],
          allowFull: true,
          allowPlan: false,
          depositType: s.defaultDepositType,
          depositValue: plain(s.defaultDepositType, s.defaultDepositValue),
          discountType: s.defaultDiscountType,
          discountValue: plain(s.defaultDiscountType, s.defaultDiscountValue),
          discountCoversPlanFee: false,
          taxRate: (s.defaultTaxRateBps / 100).toString(),
          planInstallments: String(s.defaultInstallments),
          planFirstDueDate: addMonths(today, 1),
          planIntervalMonths: "1",
        }}
      />
    </>
  );
}
