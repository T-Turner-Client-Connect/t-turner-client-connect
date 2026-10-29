import { Notice, PageHeader } from "@/components/ui";
import { PortalTaxesView } from "@/components/portal/taxes-view";
import { requirePortalUser } from "@/lib/portal/session";
import { resolveAccount } from "@/lib/portal/account";
import { loadPortalTaxes } from "@/lib/portal/tax-view";
import { downloadToken } from "@/lib/services/documents";

export const metadata = { title: "Taxes" };

export default async function PortalTaxes({ searchParams }: { searchParams: Promise<{ account?: string }> }) {
  const user = await requirePortalUser();
  const { current } = await resolveAccount(user.id, (await searchParams).account);
  if (!current) return null;
  if (!current.canViewTax) return <Notice>Tax information isn&apos;t included in your access to this account.</Notice>;
  const data = await loadPortalTaxes(current.clientId);
  return (
    <>
      <PageHeader title="Taxes" subtitle="Each filing is listed separately — federal and state, extensions and amendments." />
      <PortalTaxesView data={data} linkFor={(id) => `/api/documents/${downloadToken(id, { portalUserId: user.id })}`} />
    </>
  );
}
