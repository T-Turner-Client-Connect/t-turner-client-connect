import { Notice, PageHeader } from "@/components/ui";
import { PortalTaxesView } from "@/components/portal/taxes-view";
import { portalViewer } from "@/lib/portal/viewer";
import { loadPortalTaxes } from "@/lib/portal/tax-view";

export const metadata = { title: "Taxes" };

export default async function PortalTaxes({ searchParams }: { searchParams: Promise<{ account?: string }> }) {
  const v = await portalViewer("taxes", (await searchParams).account);
  const { user, current } = v;
  if (!current) return null;
  if (!current.canViewTax) return <Notice>Tax information isn&apos;t included in your access to this account.</Notice>;
  const data = await loadPortalTaxes(current.clientId, user?.id ?? null);
  return (
    <>
      <PageHeader title="Taxes" subtitle="Each filing is listed separately — federal and state, extensions and amendments." />
      <PortalTaxesView data={data} linkFor={v.linkFor} />
    </>
  );
}
