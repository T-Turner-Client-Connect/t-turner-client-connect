import { IdCard } from "lucide-react";
import { Notice } from "@/components/ui";
import { PageBanner } from "@/components/portal/luxury";
import { IdentityPageView } from "@/components/portal/identity-page";
import { requirePortalUser } from "@/lib/portal/session";
import { requirePersonalTaxAccount, resolveAccount } from "@/lib/portal/account";
import { downloadToken } from "@/lib/services/documents";
import { identityAlerts, portalIdentityOverview } from "@/lib/services/identity";

export const metadata = { title: "Identity Documents" };

export default async function IdentityPage({ searchParams }: { searchParams: Promise<{ account?: string }> }) {
  const user = await requirePortalUser();
  const { current } = await resolveAccount(user.id, (await searchParams).account);
  if (!current) return null;
  await requirePersonalTaxAccount(current.clientId);
  const header = <PageBanner icon={IdCard} title="Identity Documents" subtitle="Driver's licenses, birth certificates and Social Security cards for you, your spouse and dependents." />;
  if (!current.canViewIdentity) return <>{header}<Notice>Identity documents aren&apos;t included in your access to this account. The account owner can ask our office to add it.</Notice></>;
  const overview = await portalIdentityOverview(user, current.clientId);
  const alerts = identityAlerts(overview);
  return (
    <>
      {header}
      {alerts.length > 0 && (
        <div className="mb-6 space-y-2" data-testid="identity-alerts">
          {alerts.map((a, i) => <Notice key={i} tone={a.tone === "error" ? "error" : "warn"}>{a.text}</Notice>)}
        </div>
      )}
      <IdentityPageView overview={overview} clientId={current.clientId} linkFor={(id) => `/api/documents/${downloadToken(id, { portalUserId: user.id })}`} />
    </>
  );
}
