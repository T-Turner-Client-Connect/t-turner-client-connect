import { Notice, PageHeader } from "@/components/ui";
import { PortalSummaryView } from "@/components/portal/tax-summary-portal";
import { requirePortalUser } from "@/lib/portal/session";
import { requirePersonalTaxAccount, resolveAccount } from "@/lib/portal/account";
import { portalSummaries } from "@/lib/services/tax-summary";

export const metadata = { title: "Tax return summary" };

export default async function PortalTaxSummary({ searchParams }: { searchParams: Promise<{ account?: string }> }) {
  const user = await requirePortalUser();
  const { current } = await resolveAccount(user.id, (await searchParams).account);
  if (!current) return null;
  await requirePersonalTaxAccount(current.clientId);
  if (!current.canViewTax) return <Notice>Tax information isn&apos;t included in your access to this account.</Notice>;
  const summaries = await portalSummaries(user, current.clientId);
  return (
    <>
      <PageHeader title="Tax Return Summary & Approval" subtitle="Review the key figures from your prepared return and approve it for filing — or tell us what to change." />
      <PortalSummaryView summaries={summaries} clientId={current.clientId} />
    </>
  );
}
