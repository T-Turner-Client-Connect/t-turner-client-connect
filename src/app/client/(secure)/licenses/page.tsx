import { portalViewer } from "@/lib/portal/viewer";
import { OWNER_PREVIEW_PERMS } from "@/lib/portal/views";
import { licensesPageFor, portalLicensesPage } from "@/lib/services/portal-business-pages";
import { LicensesPageView, NotBusinessNotice } from "@/components/portal/business-pages";

export const metadata = { title: "Business Licenses" };

/** The licenses and permits the office tracks for this business, with renewal dates and released copies. */
export default async function PortalLicenses({ searchParams }: { searchParams: Promise<{ account?: string }> }) {
  const v = await portalViewer("licenses", (await searchParams).account);
  const { user, current } = v;
  if (!current) return null;
  if (!current.canViewBookkeeping) return <NotBusinessNotice />;
  const d = user ? await portalLicensesPage(user, current.clientId) : await licensesPageFor(current.clientId, { ...OWNER_PREVIEW_PERMS, ...current }, null);
  return <LicensesPageView d={d} back={`/client?account=${current.clientId}`} linkFor={v.linkFor} />;
}
