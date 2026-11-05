import { IdCard } from "lucide-react";
import { Notice } from "@/components/ui";
import { PageBanner } from "@/components/portal/luxury";
import { IdentityPageView } from "@/components/portal/identity-page";
import { requirePortalUser } from "@/lib/portal/session";
import { requirePersonalTaxAccount, resolveAccount } from "@/lib/portal/account";
import { serviceProfile } from "@/lib/services/service-profile";
import { downloadToken } from "@/lib/services/documents";
import { identityAlerts, ownerIdentityOverview, portalIdentityOverview } from "@/lib/services/identity";

export const metadata = { title: "Identity Documents" };

export default async function IdentityPage({ searchParams }: { searchParams: Promise<{ account?: string }> }) {
  const user = await requirePortalUser();
  const { current } = await resolveAccount(user.id, (await searchParams).account);
  if (!current) return null;
  // A business-only account: only the signed-in owner's own record, and only while our office has
  // asked that owner for an identity document. Otherwise the page isn't available (as before).
  if ((await serviceProfile(current.clientId)).businessOnly) {
    const mine = await ownerIdentityOverview(user, current.clientId);
    if (!mine) await requirePersonalTaxAccount(current.clientId);
    return (
      <>
        <PageBanner icon={IdCard} title="Identity Documents" subtitle="Our office asked you for an identity document. Only you and our office can see it — never the business's other owners or contacts." />
        <IdentityPageView overview={mine!} clientId={current.clientId} linkFor={(id) => `/api/documents/${downloadToken(id, { portalUserId: user.id })}`} ownerOnly />
      </>
    );
  }
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
