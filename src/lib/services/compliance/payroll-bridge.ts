import "server-only";
import { prisma } from "@/lib/prisma";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import { payrollTaxAccess } from "@/lib/payroll-taxes/access";
import { daysBetween, officeToday } from "@/lib/tax/deadlines";
import { complianceAccess } from "./access";
import { COMPLETE_FILING, effectiveDue } from "./obligations";
import { clientStatus } from "./views";

/** The obligation categories the ADP Payroll & Taxes workspace's Taxes tab shows. */
export const PAYROLL_TAX_CATEGORIES = ["WITHHOLDING_PAYROLL", "SALES_USE", "INFORMATION_RETURNS"];

/**
 * Read-only feed for ADP Payroll & Taxes → Taxes. It reuses that workspace's permission area:
 * anyone who may open Payroll & Taxes (payroll_taxes View/Manage) sees the payroll, withholding,
 * sales/use and information-return periods — scoped to their assigned clients unless they hold
 * "All clients" — without needing Tax & Compliance access. Staff with compliance access see every
 * client's. All changes still happen in the Tax & Compliance Center (compliance.manage).
 */
export async function payrollTaxesTaxFeed(actor: Actor, opts: { includeDone?: boolean } = {}) {
  const [pt, cc] = await Promise.all([payrollTaxAccess(actor), complianceAccess(actor)]);
  if (pt.level === "NONE" && cc.level === "NONE") throw new ForbiddenError("Not found.");
  const allClients = cc.level !== "NONE" || pt.allClients;
  const me = actor.id;
  const today = officeToday();
  const periods = await prisma.complianceFilingPeriod.findMany({
    where: {
      obligation: { status: "ACTIVE", category: { in: PAYROLL_TAX_CATEGORIES } },
      ...(opts.includeDone ? {} : { filingStatus: { notIn: COMPLETE_FILING } }),
      ...(allClients ? {} : { OR: [{ obligation: { assignedStaffId: me } }, { entity: { client: { assignedToId: me } } }] }),
    },
    include: { obligation: { include: { filingAccount: { select: { portalUrl: true } } } }, entity: { select: { id: true, legalName: true, dba: true, client: { select: { id: true, displayName: true } } } } },
    orderBy: { adjustedDue: "asc" },
    take: 300,
  });
  return {
    canOpenBoard: cc.level !== "NONE",
    canManage: cc.level === "MANAGE",
    rows: periods.map((p) => {
      const due = effectiveDue(p)?.toISOString().slice(0, 10) ?? null;
      return {
        id: p.id, clientName: p.entity.client.displayName, entityName: p.entity.legalName || p.entity.dba || "(legal name missing)", form: p.obligation.formName, category: p.obligation.category, jurisdiction: p.obligation.jurisdictionName,
        periodKey: p.periodKey, due, days: due ? daysBetween(today, due) : null, dueCertain: p.dueCertainty === "CONFIRMED", status: clientStatus(p, today), paymentStatus: p.paymentStatus, portalUrl: p.obligation.filingAccount?.portalUrl ?? null,
      };
    }),
  };
}
