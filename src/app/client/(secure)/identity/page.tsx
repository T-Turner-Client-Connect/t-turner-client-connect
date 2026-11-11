import { IdCard } from "lucide-react";
import { Notice } from "@/components/ui";
import { PageBanner } from "@/components/portal/luxury";
import { IdentityPageView } from "@/components/portal/identity-page";
import { portalViewer } from "@/lib/portal/viewer";
import { requirePersonalTaxAccount } from "@/lib/portal/account";
import { serviceProfile } from "@/lib/services/service-profile";
import { portalAddPersonAction, portalRemovePersonAction } from "@/app/actions/identity";
import type { IdentityActions } from "@/components/portal/identity-page";
import { identityAlerts, identityCompletion, identityOverviewForViewer, ipPinStatus, ownerIdentityOverview, portalIdentityOverview } from "@/lib/services/identity";
import { CheckCircle2 } from "lucide-react";
import { IpPinCard } from "@/components/portal/ip-pin-card";
import { portalIpPinFlagAction, portalIpPinSaveAction } from "@/app/actions/identity";
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
  const pins = await ipPinStatus(current.clientId);
  const done = identityCompletion(overview, pins);
  return (
    <>
      {header}
      {done.complete ? (
        <div className="mb-6 flex items-start gap-3 rounded-2xl border border-emerald-300 bg-emerald-50 p-4 text-emerald-900" data-testid="identity-completed">
          <CheckCircle2 className="mt-0.5 size-6 shrink-0" aria-hidden />
          <p><strong>Completed.</strong> We have everything we need. For your safety, identity documents are kept by our office only and can&apos;t be viewed in the portal once uploaded.</p>
        </div>
      ) : (
        <div className="mb-6 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-amber-900" data-testid="identity-still-needed">
          <p className="font-semibold">Still needed:</p>
          <ul className="mt-1 list-disc pl-5 text-sm">{done.missing.map((m) => <li key={m}>{m}</li>)}</ul>
          <p className="mt-2 text-xs">For your safety, identity documents are kept by our office only and can&apos;t be viewed in the portal once uploaded.</p>
        </div>
      )}
      {alerts.length > 0 && (
        <div className="mb-6 space-y-2" data-testid="identity-alerts">
          {alerts.map((a, i) => <Notice key={i} tone={a.tone === "error" ? "error" : "warn"}>{a.text}</Notice>)}
        </div>
      )}
      <IdentityPageView overview={overview} clientId={current.clientId} linkFor={v.linkFor} actions={ACTIONS} readOnly={v.readOnly} />
      <div className="mt-6">
        <IpPinCard
          people={overview.map((o) => ({ id: o.person.id, name: o.person.name, hasIpPin: o.person.hasIpPin }))}
          year={pins.year}
          onFile={new Set(pins.onFile.keys())}
          flagAction={(pid) => v.act(portalIpPinFlagAction, current.clientId, pid) as never}
          saveAction={(pid) => v.act(portalIpPinSaveAction, current.clientId, pid) as never}
          readOnly={v.readOnly}
        />
      </div>
    </>
  );
}
