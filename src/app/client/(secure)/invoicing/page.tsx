import { portalViewer } from "@/lib/portal/viewer";
import { portalClientInvoicing, previewClientInvoicing } from "@/lib/services/portal-client-invoicing";
import { InvoicingPageView, NotBusinessNotice } from "@/components/portal/business-pages";

export const metadata = { title: "Client Invoicing" };

/** Invoices the office keeps for this business's customers, payments received, and "Request an invoice". */
export default async function PortalInvoicing({ searchParams }: { searchParams: Promise<{ account?: string }> }) {
  const v = await portalViewer("invoicing", (await searchParams).account);
  const { user, current } = v;
  if (!current) return null;
  if (!current.canViewBookkeeping) return <NotBusinessNotice />;
  const d = user ? await portalClientInvoicing(user, current.clientId) : await previewClientInvoicing(current.clientId);
  return <InvoicingPageView d={d} back={`/client?account=${current.clientId}`} readOnly={v.readOnly} />;
}
