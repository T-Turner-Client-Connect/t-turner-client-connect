import { PreviewBanner } from "@/components/preview-banner";
import { PublicFooter } from "@/components/legal-links";
import { Suspense } from "react";
import { PortalNav } from "@/components/portal/portal-nav";
import { requirePortalUser } from "@/lib/portal/session";
import { accessibleClients } from "@/lib/portal/access";
import { portalLogoutAction } from "@/app/actions/portal";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { ownerAndBusiness } from "@/lib/services/related-businesses";
import { isPayrollApprover } from "@/lib/services/payroll-approval";
import { serviceProfile } from "@/lib/services/service-profile";
import { openIdentityRequest } from "@/lib/services/owner-personal-docs";
import { conversationScope } from "@/lib/portal/access";

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const user = await requirePortalUser();
  const accounts = (
    await Promise.all(
      (await accessibleClients(user.id)).map(async (a) => {
        const names = a.client.clientType === "INDIVIDUAL" ? null : await ownerAndBusiness(a.clientId);
        const { businessOnly } = await serviceProfile(a.clientId);
        // A business-only account (no personal tax preparation) drops the personal tax pages (except
        // the owner's own personal documents upload, and identity on request), and
        // each area this login wasn't granted. Regular accounts keep the full menu.
        // Personal tax documents: a business owner may still send their own (Upload Documents), and
        // identity documents only while our office has asked that owner for one.
        const idRequest = businessOnly ? await openIdentityRequest(user.id, a.clientId) : null;
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
          payrollApprover: await isPayrollApprover(user.id, a.clientId),
          businessOnly,
          hide,
        };
      }),
    )
  ).sort((x, y) => x.order - y.order); // the owner's main business first, then the others in the order they were added
  // A login not yet connected to any client account sees only its setup page.
  if (accounts.length === 0) redirect("/client/start");
  const unread = await prisma.message.count({
    where: { conversation: { clientId: { in: accounts.map((a) => a.id) }, ...conversationScope(user.id) }, channel: "PORTAL", direction: "OUTBOUND", readByClientAt: null },

  });
  return (
    <div className="lux-page min-h-dvh">
      <PreviewBanner />
      <Suspense>
        <PortalNav accounts={accounts} name={user.name} unread={unread} signOut={portalLogoutAction} />
      </Suspense>
      <div className="lg:pl-64">
        <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">{children}</main>
        <PublicFooter />
      </div>
    </div>
  );
}
