import { notFound } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { QuoteForm } from "@/components/owner/quote-form";
import { saveQuoteAction } from "@/app/actions/owner";
import { requireOffice } from "@/lib/auth/owner";
import { billingSettings, ymd } from "@/lib/services/owner-billing";
import { FirmInvoiceForm } from "@/components/owner/firm-invoice-form";
import { saveFirmInvoiceAction } from "@/app/actions/firm-invoices";
import { approvedFirmMethods, invoiceClientChoices, squareLinksLive } from "@/lib/services/firm-invoices";
import { prisma } from "@/lib/prisma";

const plain = (type: string, v: number) => (type === "FLAT" || type === "PERCENT" ? (v / 100).toString() : "");

export default async function EditQuotePage({ params }: { params: Promise<{ id: string }> }) {
  const { actor, access } = await requireOffice("billing", "edit");
  const { id } = await params;
  const inv = await prisma.invoice.findUnique({ where: { id }, include: { lines: { orderBy: { sortOrder: "asc" } } } });
  if (!inv || inv.state !== "DRAFT") notFound();
  if (inv.formType === "INVOICE") {
    const [clients, approved, live, settings] = await Promise.all([invoiceClientChoices(actor), approvedFirmMethods(), squareLinksLive(), billingSettings()]);
    const line = inv.lines[0];
    return (
      <>
        <PageHeader title={`Edit ${inv.number}`} subtitle="Drafts only. The client's billing contact refreshes from their master record when you save." />
        <FirmInvoiceForm
          action={saveFirmInvoiceAction.bind(null, inv.id)}
          clients={clients}
          number={{ value: inv.number, assigned: true }}
          approved={approved}
          squareLive={live}
          refundFeeNote={settings.refundTransferFeeNote}
          canApprove={access.can("billing", "send")}
          defaults={{
            clientId: inv.clientId,
            service: line?.service ?? inv.title,
            amount: line ? (line.unitCents / 100).toFixed(2) : "",
            description: line?.description ?? "",
            issueDate: ymd(inv.issueDate),
            dueDate: ymd(inv.dueDate),
            privateNote: inv.privateNote ?? "",
            methods: inv.offeredMethods,
            squarePaymentUrl: inv.squarePaymentUrl ?? "",
          }}
        />
      </>
    );
  }
  const [s, clients] = await Promise.all([billingSettings(), prisma.client.findMany({ where: { archivedAt: null }, select: { id: true, displayName: true }, orderBy: { displayName: "asc" } })]);
  return (
    <>
      <PageHeader title={`Edit ${inv.number}`} />
      <QuoteForm
        action={saveQuoteAction.bind(null, inv.id)}
        clients={clients}
        fee={{ type: s.planFeeType, value: s.planFeeValue, maxInstallments: s.maxInstallments, confirmed: !!s.planFeeRulesConfirmedAt }}
        canOverrideFee={access.can("billing", "approve")}
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
