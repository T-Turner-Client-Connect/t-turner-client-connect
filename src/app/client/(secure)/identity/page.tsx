import { Notice, PageHeader } from "@/components/ui";
import { IdentitySection } from "@/components/identity-section";
import { requirePortalUser } from "@/lib/portal/session";
import { resolveAccount } from "@/lib/portal/account";
import { downloadToken } from "@/lib/services/documents";
import { identityAlerts, portalIdentityOverview } from "@/lib/services/identity";

export const metadata = { title: "Identity Documents" };

export default async function IdentityPage({ searchParams }: { searchParams: Promise<{ account?: string }> }) {
  const user = await requirePortalUser();
  const { current } = await resolveAccount(user.id, (await searchParams).account);
  if (!current) return null;
  const header = <PageHeader title="Identity Documents" subtitle="Upload or replace driver's licenses, birth certificates and Social Security cards for you, your spouse and dependents. For your protection, Social Security cards and birth certificates can't be viewed or downloaded in the portal after upload — you'll see their verification status." />;
  if (!current.canViewIdentity) return <>{header}<Notice>Identity documents aren&apos;t included in your access to this account. The account owner can ask our office to add it.</Notice></>;
  const overview = await portalIdentityOverview(user, current.clientId);
  const alerts = identityAlerts(overview);
  return (
    <>
      {header}
      {alerts.length > 0 && (
        <div className="mb-4 space-y-2" data-testid="identity-alerts">
          {alerts.map((a, i) => <Notice key={i} tone={a.tone === "error" ? "error" : "warn"}>{a.text}</Notice>)}
        </div>
      )}
      <IdentitySection overview={overview} mode="portal" clientId={current.clientId} linkFor={(id) => `/api/documents/${downloadToken(id, { portalUserId: user.id })}`} />
    </>
  );
}
