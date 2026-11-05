import { requirePortalUser } from "@/lib/portal/session";
import { resolveAccount } from "@/lib/portal/account";
import { downloadToken } from "@/lib/services/documents";
import { portalPayrollPage } from "@/lib/services/portal-business-pages";
import { portalPayrollRequests } from "@/lib/services/payroll-taxes";
import { NotBusinessNotice, PayrollPageView } from "@/components/portal/business-pages";
import { PortalPayrollRequests } from "@/components/payroll-taxes/portal-requests";

export const metadata = { title: "Payroll" };

/**
 * Payroll for a business: open payroll requests for this login (hours to send, approvals waiting on
 * them, deadlines, released payroll documents), then the business view's pay schedule, pay history
 * and payroll reports. Every part re-checks this login's access to this one business.
 */
export default async function PortalPayroll({ searchParams }: { searchParams: Promise<{ account?: string }> }) {
  const user = await requirePortalUser();
  const { current } = await resolveAccount(user.id, (await searchParams).account);
  if (!current) return null;
  const requests = await portalPayrollRequests(user.id, current.clientId).catch(() => null);
  const linkFor = (id: string) => `/api/documents/${downloadToken(id, { portalUserId: user.id })}`;
  const section = requests ? <PortalPayrollRequests clientId={current.clientId} r={requests} linkFor={linkFor} /> : null;
  if (!current.canViewBookkeeping) return <>{section}{!section && <NotBusinessNotice />}</>;
  const d = await portalPayrollPage(user, current.clientId);
  return <>{section}<PayrollPageView d={d} back={`/client?account=${current.clientId}`} linkFor={linkFor} /></>;
}
