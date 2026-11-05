import { requirePortalUser } from "@/lib/portal/session";
import { resolveAccount } from "@/lib/portal/account";
import { downloadToken } from "@/lib/services/documents";
import { portalLicensesPage } from "@/lib/services/portal-business-pages";
import { LicensesPageView, NotBusinessNotice } from "@/components/portal/business-pages";

export const metadata = { title: "Business Licenses" };

/** The licenses and permits the office tracks for this business, with renewal dates and released copies. */
export default async function PortalLicenses({ searchParams }: { searchParams: Promise<{ account?: string }> }) {
  const user = await requirePortalUser();
  const { current } = await resolveAccount(user.id, (await searchParams).account);
  if (!current) return null;
  if (!current.canViewBookkeeping) return <NotBusinessNotice />;
  const d = await portalLicensesPage(user, current.clientId);
  return <LicensesPageView d={d} back={`/client?account=${current.clientId}`} linkFor={(id) => `/api/documents/${downloadToken(id, { portalUserId: user.id })}`} />;
}
