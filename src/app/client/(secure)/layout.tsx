import { PublicFooter } from "@/components/legal-links";
import { Suspense } from "react";
import { PortalNav } from "@/components/portal/portal-nav";
import { requirePortalUser } from "@/lib/portal/session";
import { accessibleClients } from "@/lib/portal/access";
import { portalLogoutAction } from "@/app/actions/portal";
import { redirect } from "next/navigation";

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const user = await requirePortalUser();
  const accounts = (await accessibleClients(user.id)).map((a) => ({ id: a.clientId, name: a.client.businessName || a.client.displayName }));
  // A login not yet connected to any client account sees only its setup page.
  if (accounts.length === 0) redirect("/client/start");
  return (
    <div className="lux-page min-h-dvh">
      <Suspense>
        <PortalNav accounts={accounts} name={user.name} signOut={portalLogoutAction} />
      </Suspense>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
      <PublicFooter />
    </div>
  );
}
