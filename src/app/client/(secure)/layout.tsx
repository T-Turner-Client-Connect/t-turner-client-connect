import { PublicFooter } from "@/components/legal-links";
import { Suspense } from "react";
import { PortalNav } from "@/components/portal/portal-nav";
import { requirePortalUser } from "@/lib/portal/session";
import { accessibleClients } from "@/lib/portal/access";
import { portalLogoutAction } from "@/app/actions/portal";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { ownerAndBusiness } from "@/lib/services/related-businesses";

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const user = await requirePortalUser();
  const accounts = (
    await Promise.all(
      (await accessibleClients(user.id)).map(async (a) => {
        const names = a.client.clientType === "INDIVIDUAL" ? null : await ownerAndBusiness(a.clientId);
        return {
          id: a.clientId,
          name: a.client.businessName || a.client.displayName,
          personal: a.client.clientType === "INDIVIDUAL",
          // "Owner: …" under a business heading — the name already on the owner's record.
          owner: names?.owner ?? null,
          order: names?.order ?? 0,
        };
      }),
    )
  ).sort((x, y) => x.order - y.order); // the owner's main business first, then the others in the order they were added
  // A login not yet connected to any client account sees only its setup page.
  if (accounts.length === 0) redirect("/client/start");
  const unread = await prisma.message.count({
    where: { conversation: { clientId: { in: accounts.map((a) => a.id) } }, channel: "PORTAL", direction: "OUTBOUND", readByClientAt: null },
  });
  return (
    <div className="lux-page min-h-dvh">
      <Suspense>
        <PortalNav accounts={accounts} name={user.name} unread={unread} signOut={portalLogoutAction} />
      </Suspense>
      <div className="lg:ml-64">
        <main className="mx-auto max-w-6xl px-4 py-6 sm:px-8">{children}</main>
        <PublicFooter />
      </div>
    </div>
  );
}
