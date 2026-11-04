import { redirect } from "next/navigation";
import { Notice } from "@/components/ui";
import { homeTiles, PortalHomeView } from "@/components/portal/home-view";
import { BusinessDashboardView } from "@/components/portal/business-dashboard";
import { requirePortalUser } from "@/lib/portal/session";
import { resolveAccount } from "@/lib/portal/account";
import { loadPortalHome } from "@/lib/portal/views";
import { downloadToken } from "@/lib/services/documents";
import { loadGreetingName } from "@/lib/portal/greeting";
import { homeKind, portalBusinessDashboard } from "@/lib/services/portal-business";

export const metadata = { title: "Client portal" };

export default async function PortalHome({ searchParams }: { searchParams: Promise<{ account?: string; year?: string; month?: string }> }) {
  const user = await requirePortalUser();
  const sp = await searchParams;
  const { accounts, current } = await resolveAccount(user.id, sp.account);
  if (!current) return <Notice title="No accounts yet">Your login isn&apos;t connected to an account right now. Please contact our office.</Notice>;
  // One sign-in, Personal and Business: an owner of an approved Managed Business lands on its dashboard.
  // (Regular tax clients have no such account, so their Home is unchanged.)
  if (!sp.account) {
    const business = accounts.find((a) => homeKind(a) === "BUSINESS");
    if (business) redirect(`/client?account=${business.clientId}`);
  }
  const q = `?account=${current.clientId}`;
  const linkFor = (id: string) => `/api/documents/${downloadToken(id, { portalUserId: user.id })}`;
  const data = await loadPortalHome(current.clientId, current, user.id);

  if (homeKind(current) === "BUSINESS") {
    const d = await portalBusinessDashboard(user, current.clientId, sp.month);
    const { tiles } = homeTiles({ data, q, year: Number(sp.year) || undefined });
    // The owner's own (personal) account, for personal tax uploads and identity documents.
    const personal = accounts.find((a) => a.client.clientType === "INDIVIDUAL");
    return <BusinessDashboardView d={d} tiles={tiles} q={q} base={`/client${q}`} linkFor={linkFor} personalQ={personal ? `?account=${personal.clientId}` : null} />;
  }

  const name = await loadGreetingName(current.clientId, user.id);
  return (
    <PortalHomeView
      data={data}
      q={q}
      clientId={current.clientId}
      name={name ?? undefined}
      accountName={current.client.businessName || current.client.displayName}
      year={Number(sp.year) || undefined}
      linkFor={linkFor}
    />
  );
}
