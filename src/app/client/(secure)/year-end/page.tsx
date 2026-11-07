import { portalViewer } from "@/lib/portal/viewer";
import { portalYearEndPage, yearEndPageFor } from "@/lib/services/portal-business-pages";
import { NotBusinessNotice, YearEndPageView } from "@/components/portal/business-pages";

export const metadata = { title: "1099 / W-2" };

/** Year-end W-2 / 1099 progress and the forms requested from this business, with uploads against each request. */
export default async function PortalYearEnd({ searchParams }: { searchParams: Promise<{ account?: string }> }) {
  const v = await portalViewer("year-end", (await searchParams).account);
  const { user, current } = v;
  if (!current) return null;
  if (!current.canViewBookkeeping) return <NotBusinessNotice />;
  const d = user ? await portalYearEndPage(user, current.clientId) : { ...(await yearEndPageFor(current.clientId)), canUpload: current.canUpload };
  return <YearEndPageView d={d} canUpload={d.canUpload} back={`/client?account=${current.clientId}`} readOnly={v.readOnly} />;
}
