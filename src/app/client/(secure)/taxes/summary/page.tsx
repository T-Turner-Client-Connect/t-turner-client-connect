import { Notice, PageHeader } from "@/components/ui";
import { PortalSummaryView } from "@/components/portal/tax-summary-portal";
import { portalViewer } from "@/lib/portal/viewer";
import { requirePersonalTaxAccount } from "@/lib/portal/account";
import { portalSummaries, previewSummaries } from "@/lib/services/tax-summary";

export const metadata = { title: "Tax return summary" };

export default async function PortalTaxSummary({ searchParams }: { searchParams: Promise<{ account?: string }> }) {
  const v = await portalViewer("summary", (await searchParams).account);
  const { user, current } = v;
  if (!current) return null;
  await requirePersonalTaxAccount(current.clientId);
  if (!current.canViewTax) return <Notice>Tax information isn&apos;t included in your access to this account.</Notice>;
  const summaries = user ? await portalSummaries(user, current.clientId) : await previewSummaries(current.clientId);
  return (
    <>
      <PageHeader title="Tax Return Summary & Approval" subtitle="Review the key figures from your prepared return and approve it for filing — or tell us what to change." />
      <PortalSummaryView summaries={summaries} clientId={current.clientId} readOnly={v.readOnly} />
    </>
  );
}
