import { Notice } from "@/components/ui";
import { PortalHomeView } from "@/components/portal/home-view";
import { requirePortalUser } from "@/lib/portal/session";
import { resolveAccount } from "@/lib/portal/account";
import { loadPortalHome } from "@/lib/portal/views";
import { downloadToken } from "@/lib/services/documents";

export const metadata = { title: "Client portal" };

export default async function PortalHome({ searchParams }: { searchParams: Promise<{ account?: string }> }) {
  const user = await requirePortalUser();
  const { current } = await resolveAccount(user.id, (await searchParams).account);
  if (!current) return <Notice title="No accounts yet">Your login isn&apos;t connected to an account right now. Please contact our office.</Notice>;
  const data = await loadPortalHome(current.clientId, current, user.id);
  return (
    <>
      <PortalHomeView
        data={data}
        q={`?account=${current.clientId}`}
        clientId={current.clientId}
        name={user.name.split(" ")[0]}
        accountName={current.client.businessName || current.client.displayName}
        linkFor={(id) => `/api/documents/${downloadToken(id, { portalUserId: user.id })}`}
      />
    </>
  );
}
