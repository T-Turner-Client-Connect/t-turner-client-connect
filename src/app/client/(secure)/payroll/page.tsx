import { portalViewer } from "@/lib/portal/viewer";
import { OWNER_PREVIEW_PERMS } from "@/lib/portal/views";
import { payrollPageFor, portalPayrollPage } from "@/lib/services/portal-business-pages";
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
  const v = await portalViewer("payroll", (await searchParams).account);
  const { user, current } = v;
  if (!current) return null;
  const requests = user ? await portalPayrollRequests(user.id, current.clientId).catch(() => null) : null;
  const linkFor = v.linkFor;
  const section = requests ? <PortalPayrollRequests clientId={current.clientId} r={requests} linkFor={linkFor} readOnly={v.readOnly} /> : null;
  if (!current.canViewBookkeeping) return <>{section}{!section && <NotBusinessNotice />}</>;
  const d = user ? await portalPayrollPage(user, current.clientId) : await payrollPageFor(current.clientId, { ...OWNER_PREVIEW_PERMS, ...current }, null);
  return <>{section}<PayrollPageView d={d} back={`/client?account=${current.clientId}`} linkFor={linkFor} /></>;
}
