import { IdCard } from "lucide-react";
import { Notice } from "@/components/ui";
import { PageBanner } from "@/components/portal/luxury";
import { IdentityPageView } from "@/components/portal/identity-page";
import { portalViewer } from "@/lib/portal/viewer";
import { requirePersonalTaxAccount } from "@/lib/portal/account";
import { serviceProfile } from "@/lib/services/service-profile";
import { portalAddPersonAction, portalRemovePersonAction } from "@/app/actions/identity";
import type { IdentityActions } from "@/components/portal/identity-page";
import { identityAlerts, identityOverviewForViewer, ownerIdentityOverview, portalIdentityOverview } from "@/lib/services/identity";
import { portalIdentityUploadAction } from "@/app/actions/identity";

export const metadata = { title: "Identity Documents" };



export default async function IdentityPage({ searchParams }: { searchParams: Promise<{ account?: string }> }) {
  const v = await portalViewer("identity", (await searchParams).account);
  const { user, current } = v;
  if (!current) return null;
  // The portal's own actions, or (View as Client) the stand-ins: the same forms, disabled.
  const ACTIONS: IdentityActions = { upload: v.act(portalIdentityUploadAction, current.clientId), addPerson: (c) => v.act(portalAddPersonAction, c), removePerson: (c, p) => v.act(portalRemovePersonAction, c, p) };
  // A business account: identity documents are kept per owner. Only the signed-in owner's own
  // record shows (when our office asked them for one, or documents were assigned to them) — never
  // the business's own record (staff-only) and never another owner's.
  const profile = await serviceProfile(current.clientId);
  if (profile.business) {
    const mine = user ? await ownerIdentityOverview(user, current.clientId) : null;
    const banner = <PageBanner icon={IdCard} title="Identity Documents" subtitle="Only you and our office can see your identity documents — never the business's other owners or contacts." />;
    if (!mine) {
      // A business-only account without a request: the page isn't available (as before).
      if (profile.businessOnly) await requirePersonalTaxAccount(current.clientId);
      return <>{banner}<Notice>On a business account, identity documents are kept for each owner separately. Our office will ask you if we need yours.</Notice></>;
    }
    return (
      <>
        {banner}
        <IdentityPageView overview={mine} clientId={current.clientId} linkFor={v.linkFor} ownerOnly actions={ACTIONS} readOnly={v.readOnly} />
      </>
    );
  }
  await requirePersonalTaxAccount(current.clientId);
  const header = <PageBanner icon={IdCard} title="Identity Documents" subtitle="Driver's licenses, birth certificates and Social Security cards for you, your spouse and dependents." />;
  if (!current.canViewIdentity) return <>{header}<Notice>Identity documents aren&apos;t included in your access to this account. The account owner can ask our office to add it.</Notice></>;
  const overview = user ? await portalIdentityOverview(user, current.clientId) : await identityOverviewForViewer(current.clientId, null);
  const alerts = identityAlerts(overview);
  return (
    <>
      {header}
      {alerts.length > 0 && (
        <div className="mb-6 space-y-2" data-testid="identity-alerts">
          {alerts.map((a, i) => <Notice key={i} tone={a.tone === "error" ? "error" : "warn"}>{a.text}</Notice>)}
        </div>
      )}
      <IdentityPageView overview={overview} clientId={current.clientId} linkFor={v.linkFor} actions={ACTIONS} readOnly={v.readOnly} />
    </>
  );
}
