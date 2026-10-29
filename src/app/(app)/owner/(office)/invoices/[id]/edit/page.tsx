import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { QuoteForm } from "@/components/owner/quote-form";
import { saveQuoteAction } from "@/app/actions/owner";
import { requireOwner } from "@/lib/auth/owner";
import { billingSettings, ymd } from "@/lib/services/owner-billing";
import { prisma } from "@/lib/prisma";

const plain = (type: string, v: number) => (type === "FLAT" || type === "PERCENT" ? (v / 100).toString() : "");

export default async function EditQuotePage({ params }: { params: Promise<{ id: string }> }) {
  const { access } = await requireOwner("billing");
  const { id } = await params;
  const inv = await prisma.invoice.findUnique({ where: { id }, include: { lines: { orderBy: { sortOrder: "asc" } } } });
  if (!inv || inv.state !== "DRAFT") notFound();
  const [s, clients] = await Promise.all([billingSettings(), prisma.client.findMany({ where: { archivedAt: null }, select: { id: true, displayName: true }, orderBy: { displayName: "asc" } })]);
  return (
    <>
      <PageHeader title={`Edit ${inv.number}`} />
      <QuoteForm
        action={saveQuoteAction.bind(null, inv.id)}
        clients={clients}
        fee={{ type: s.planFeeType, value: s.planFeeValue, maxInstallments: s.maxInstallments, confirmed: !!s.planFeeRulesConfirmedAt }}
        canOverrideFee={access.scope === "FULL"}
        submitLabel="Save draft"
        defaults={{
          clientId: inv.clientId,
          title: inv.title,
          issueDate: ymd(inv.issueDate),
          dueDate: ymd(inv.dueDate),
          memo: inv.memo ?? "",
          paymentTerms: inv.paymentTerms ?? "",
          privateNote: inv.privateNote ?? "",
          lines: inv.lines.map((l) => ({ service: l.service, description: l.description ?? "", quantity: String(l.quantity), price: (l.unitCents / 100).toFixed(2) })),
          allowFull: inv.allowFull,
          allowPlan: inv.allowPlan,
          depositType: inv.depositType,
          depositValue: plain(inv.depositType, inv.depositValue),
          discountType: inv.discountType,
          discountValue: plain(inv.discountType, inv.discountValue),
          discountCoversPlanFee: inv.discountCoversPlanFee,
          taxRate: (inv.taxRateBps / 100).toString(),
          planInstallments: String(inv.planInstallments),
          planFirstDueDate: inv.planFirstDueDate ? ymd(inv.planFirstDueDate) : "",
          planIntervalMonths: String(inv.planIntervalMonths),
        }}
      />
    </>
  );
}
