import { requirePortalUser } from "@/lib/portal/session";
import { resolveAccount } from "@/lib/portal/account";
import { portalYearEndPage } from "@/lib/services/portal-business-pages";
import { NotBusinessNotice, YearEndPageView } from "@/components/portal/business-pages";

export const metadata = { title: "1099 / W-2" };

/** Year-end W-2 / 1099 progress and the forms requested from this business, with uploads against each request. */
export default async function PortalYearEnd({ searchParams }: { searchParams: Promise<{ account?: string }> }) {
  const user = await requirePortalUser();
  const { current } = await resolveAccount(user.id, (await searchParams).account);
  if (!current) return null;
  if (!current.canViewBookkeeping) return <NotBusinessNotice />;
  const d = await portalYearEndPage(user, current.clientId);
  return <YearEndPageView d={d} canUpload={d.canUpload} back={`/client?account=${current.clientId}`} />;
}
