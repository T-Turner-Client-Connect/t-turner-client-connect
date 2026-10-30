import { Notice } from "@/components/ui";
import { PortalHomeView } from "@/components/portal/home-view";
import { requirePortalUser } from "@/lib/portal/session";
import { resolveAccount } from "@/lib/portal/account";
import { loadPortalHome } from "@/lib/portal/views";
import { downloadToken } from "@/lib/services/documents";
import { loadGreetingName } from "@/lib/portal/greeting";

export const metadata = { title: "Client portal" };

export default async function PortalHome({ searchParams }: { searchParams: Promise<{ account?: string; year?: string }> }) {
  const user = await requirePortalUser();
  const sp = await searchParams;
  const { current } = await resolveAccount(user.id, sp.account);
  if (!current) return <Notice title="No accounts yet">Your login isn&apos;t connected to an account right now. Please contact our office.</Notice>;
  const [data, name] = await Promise.all([loadPortalHome(current.clientId, current, user.id), loadGreetingName(current.clientId, user.id)]);
  return (
    <>
      <PortalHomeView
        data={data}
        q={`?account=${current.clientId}`}
        clientId={current.clientId}
        name={name ?? undefined}
        accountName={current.client.businessName || current.client.displayName}
        year={Number(sp.year) || undefined}
        linkFor={(id) => `/api/documents/${downloadToken(id, { portalUserId: user.id })}`}
      />
    </>
  );
}
