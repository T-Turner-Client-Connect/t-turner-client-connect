import { requirePortalUser } from "@/lib/portal/session";
import { resolveAccount } from "@/lib/portal/account";
import { downloadToken } from "@/lib/services/documents";
import { portalPayrollPage } from "@/lib/services/portal-business-pages";
import { NotBusinessNotice, PayrollPageView } from "@/components/portal/business-pages";

export const metadata = { title: "Payroll" };

/** Payroll for a business with a business view: profile, pay dates, pay history and released payroll documents. */
export default async function PortalPayroll({ searchParams }: { searchParams: Promise<{ account?: string }> }) {
  const user = await requirePortalUser();
  const { current } = await resolveAccount(user.id, (await searchParams).account);
  if (!current) return null;
  if (!current.canViewBookkeeping) return <NotBusinessNotice />;
  const d = await portalPayrollPage(user, current.clientId);
  return <PayrollPageView d={d} back={`/client?account=${current.clientId}`} linkFor={(id) => `/api/documents/${downloadToken(id, { portalUserId: user.id })}`} />;
}
