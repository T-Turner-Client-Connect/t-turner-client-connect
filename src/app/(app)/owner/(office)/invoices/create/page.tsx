import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/ui";
import { FirmInvoiceForm } from "@/components/owner/firm-invoice-form";
import { saveFirmInvoiceAction } from "@/app/actions/firm-invoices";
import { requireOwner } from "@/lib/auth/owner";
import { billingSettings, previewNextNumber, todayYmd } from "@/lib/services/owner-billing";
import { approvedFirmMethods, invoiceClientChoices, squareLinksLive } from "@/lib/services/firm-invoices";
import { squareSendingState } from "@/lib/services/square-invoicing";
import { DEFAULT_SERVICE } from "@/lib/billing/invoice-status";

export const metadata = { title: "Create Invoice" };

export default async function CreateInvoicePage({ searchParams }: { searchParams: Promise<{ client?: string }> }) {
  const { actor, access } = await requireOwner("billing");
  const sp = await searchParams;
  const today = todayYmd(); // Central time
  const [clients, approved, live, settings, next, sending] = await Promise.all([invoiceClientChoices(actor), approvedFirmMethods(), squareLinksLive(), billingSettings(), previewNextNumber(Number(today.slice(0, 4))), squareSendingState()]);
  return (
    <>
      <Link href="/owner/invoices" className="mb-3 inline-flex items-center gap-2 text-sm font-semibold text-navy-900 underline decoration-gold-500 underline-offset-4"><ArrowLeft className="size-4" aria-hidden /> Quotes &amp; invoices</Link>
      <PageHeader title="Create Invoice" subtitle="Invoice an existing client of T. Turner & Associates. Saved as a draft — nothing is sent until the owner approves it." />
      <FirmInvoiceForm
        action={saveFirmInvoiceAction.bind(null, null)}
        clients={clients}
        number={{ value: next, assigned: false }}
        approved={approved}
        squareLive={live}
        squareSending={sending.live}
        refundFeeNote={settings.refundTransferFeeNote}
        canApprove={access.scope === "FULL"}
        defaults={{
          clientId: clients.some((c) => c.id === sp.client) ? sp.client! : "",
          service: DEFAULT_SERVICE,
          amount: "",
          description: "",
          issueDate: today,
          dueDate: "",
          privateNote: "",
          // Approved everyday methods start checked; Square and Refund Transfer are chosen deliberately.
          methods: approved.map((m) => m.method as string).filter((m) => m !== "SQUARE_INVOICE" && m !== "REFUND_TRANSFER"),
          squarePaymentUrl: "",
        }}
      />
    </>
  );
}
