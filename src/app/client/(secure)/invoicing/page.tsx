import { requirePortalUser } from "@/lib/portal/session";
import { resolveAccount } from "@/lib/portal/account";
import { portalClientInvoicing } from "@/lib/services/portal-client-invoicing";
import { InvoicingPageView, NotBusinessNotice } from "@/components/portal/business-pages";

export const metadata = { title: "Client Invoicing" };

/** Invoices the office keeps for this business's customers, payments received, and "Request an invoice". */
export default async function PortalInvoicing({ searchParams }: { searchParams: Promise<{ account?: string }> }) {
  const user = await requirePortalUser();
  const { current } = await resolveAccount(user.id, (await searchParams).account);
  if (!current) return null;
  if (!current.canViewBookkeeping) return <NotBusinessNotice />;
  const d = await portalClientInvoicing(user, current.clientId);
  return <InvoicingPageView d={d} back={`/client?account=${current.clientId}`} />;
}
