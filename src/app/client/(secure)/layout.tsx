import { PreviewBanner } from "@/components/preview-banner";
import { PublicFooter } from "@/components/legal-links";
import { Suspense } from "react";
import { PortalNav } from "@/components/portal/portal-nav";
import { portalViewerBase, previewLogins } from "@/lib/portal/viewer";
import { ViewAsClientBanner } from "@/components/portal/view-as-client-banner";
import { portalLogoutAction } from "@/app/actions/portal";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { ownerAndBusiness } from "@/lib/services/related-businesses";
import { isPayrollApprover } from "@/lib/services/payroll-approval";
import { serviceProfile } from "@/lib/services/service-profile";
import { openIdentityRequest } from "@/lib/services/owner-personal-docs";
import { conversationScope } from "@/lib/portal/access";

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  // The signed-in client, or View as Client (the login staff chose, this client only).
  const { user, accounts: grants, preview } = await portalViewerBase();
  const accounts = (
    await Promise.all(
      grants.map(async (a) => {
        const names = a.client.clientType === "INDIVIDUAL" ? null : await ownerAndBusiness(a.clientId);
        const { businessOnly } = await serviceProfile(a.clientId);
        // A business-only account (no personal tax preparation) drops the personal tax pages (except
        // the owner's own personal documents upload, and identity on request), and
        // each area this login wasn't granted. Regular accounts keep the full menu.
        // Personal tax documents: a business owner may still send their own (Upload Documents), and
        // identity documents only while our office has asked that owner for one.
        const idRequest = businessOnly && user ? await openIdentityRequest(user.id, a.clientId) : null;
        const hide = businessOnly
          ? [
              "/client/tax-center",
              ...(idRequest ? [] : ["/client/identity"]),
              "/client/taxes/summary",
              "/client/nonprofit",
              ...(a.canMessage ? [] : ["/client/messages"]),
              ...(a.canViewBilling ? [] : ["/client/billing"]),
              ...(a.canViewContracts ? [] : ["/client/agreements", "/client/contracts"]),
              ...(a.canViewTax ? [] : ["/client/taxes/filings"]),
            ]
          : [];
        return {
          id: a.clientId,
          name: a.client.businessName || a.client.displayName,
          personal: a.client.clientType === "INDIVIDUAL",
          // Business side only for an owner-approved Managed Business this login was given.
          business: a.canViewBookkeeping,
          // "Owner: …" under a business heading — the name already on the owner's record.
          owner: names?.owner ?? null,
          order: names?.order ?? 0,
          payrollApprover: user ? await isPayrollApprover(user.id, a.clientId) : false,
          businessOnly,
          hide,
        };
      }),
    )
  ).sort((x, y) => x.order - y.order); // the owner's main business first, then the others in the order they were added
  // A login not yet connected to any client account sees only its setup page.
  if (accounts.length === 0) redirect(preview ? "/view-as-client/exit" : "/client/start");
  const unread = await prisma.message.count({
    where: { conversation: { clientId: { in: accounts.map((a) => a.id) }, ...conversationScope(user?.id ?? null) }, channel: "PORTAL", direction: "OUTBOUND", readByClientAt: null },

  });
  return (
    <div className={preview ? "lux-page min-h-dvh vac-preview" : "lux-page min-h-dvh"} data-view-as-client={preview ? "true" : undefined}>
      <PreviewBanner />
      {preview && <ViewAsClientBanner clientId={preview.clientId} clientName={accounts[0].name} loginId={preview.loginId} logins={await previewLogins(preview.clientId)} />}
      <Suspense>
        <PortalNav accounts={accounts} name={user?.name ?? accounts[0].name} unread={unread} signOut={preview ? undefined : portalLogoutAction} exitHref={preview ? "/view-as-client/exit" : undefined} />
      </Suspense>
      <div className="lg:pl-64">
        <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">{children}</main>
        <PublicFooter />
      </div>
    </div>
  );
}
