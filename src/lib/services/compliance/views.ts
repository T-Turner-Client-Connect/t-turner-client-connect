import "server-only";
import type { ComplianceFilingPeriod, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import type { PortalActor } from "@/lib/portal/session";
import { requireClientAccess } from "@/lib/portal/access";
import { daysBetween, officeToday } from "@/lib/tax/deadlines";
import { entityFacts, maskEin, PORTAL_KINDS } from "./entities";
import { assertComplianceView, complianceAccess } from "./access";
import { COMPLETE_FILING, effectiveDue, isComplete } from "./obligations";
import { FILING_STATUS, PAYMENT_STATUS } from "./periods";
import { complianceSettings } from "./settings";

const iso = (x: Date | null | undefined) => (x ? x.toISOString().slice(0, 10) : null);

// --- Client portal ---------------------------------------------------------------------------

/**
 * May this portal login see this entity? Server-enforced on every read and decision:
 * - an active grant to the client with tax view (requireClientAccess "tax"), and
 * - the entity is active and marked portal-visible, and
 * - the login isn't a business owner of this client, OR it is a responsible owner of this
 *   entity, OR it was explicitly granted (ComplianceEntityViewer). So one owner can't see
 *   another owner's separate entity unless granted.
 */
export async function portalMaySeeEntity(portalUserId: string, entity: { id: string; clientId: string; portalVisible: boolean; status: string; archivedAt: Date | null }) {
  try {
    await requireClientAccess(portalUserId, entity.clientId, "tax");
  } catch {
    return false;
  }
  if (!entity.portalVisible || entity.status !== "ACTIVE" || entity.archivedAt) return false;
  const asOwner = await prisma.businessOwner.findFirst({ where: { clientId: entity.clientId, portalUserId, archivedAt: null }, select: { id: true } });
  if (!asOwner) return true;
  if (await prisma.complianceEntityOwner.count({ where: { entityId: entity.id, businessOwnerId: asOwner.id } })) return true;
  return (await prisma.complianceEntityViewer.count({ where: { entityId: entity.id, portalUserId, revokedAt: null } })) > 0;
}

/** Contracted service types for the client (active ClientService rows). */
async function contracted(clientId: string) {
  return new Set((await prisma.clientService.findMany({ where: { clientId, status: { not: "CLOSED" } }, select: { type: true } })).map((s) => s.type as string));
}

const obligationVisible = (o: { clientVisible: boolean; status: string; serviceType: string | null }, services: Set<string>) => o.clientVisible && o.status === "ACTIVE" && !!o.serviceType && services.has(o.serviceType);

export async function portalMayActOnPeriod(portalUserId: string, period: Pick<ComplianceFilingPeriod, "entityId" | "obligationId">) {
  const [entity, o] = await Promise.all([prisma.complianceEntity.findUnique({ where: { id: period.entityId } }), prisma.complianceObligation.findUnique({ where: { id: period.obligationId } })]);
  if (!entity || !o || o.entityId !== entity.id) return false;
  if (!(await portalMaySeeEntity(portalUserId, entity))) return false;
  return obligationVisible(o, await contracted(entity.clientId));
}

export function clientStatus(p: { filingStatus: string; extendedDue: Date | null; adjustedDue: Date | null }, today = officeToday()) {
  const due = effectiveDue(p);
  if (!isComplete(p) && p.filingStatus !== "REJECTED" && due && iso(due)! < today) return "Overdue";
  return FILING_STATUS[p.filingStatus as keyof typeof FILING_STATUS] ?? p.filingStatus;
}

/** The client's Tax & Compliance page: their own visible entities and obligations only. */
export async function portalCompliance(user: PortalActor, clientId: string) {
  await requireClientAccess(user.id, clientId, "tax");
  const today = officeToday();
  const services = await contracted(clientId);
  const entities = await prisma.complianceEntity.findMany({ where: { clientId, portalVisible: true, status: "ACTIVE", archivedAt: null }, orderBy: { createdAt: "asc" } });
  const out = [];
  for (const e of entities) {
    if (!(await portalMaySeeEntity(user.id, e))) continue;
    const obligations = (await prisma.complianceObligation.findMany({ where: { entityId: e.id, status: "ACTIVE" }, orderBy: { title: "asc" } })).filter((o) => obligationVisible(o, services));
    const periods = await prisma.complianceFilingPeriod.findMany({
      where: { obligationId: { in: obligations.map((o) => o.id) }, entityId: e.id },
      include: { versions: { where: { status: { in: ["SENT", "APPROVED", "CHANGES_REQUESTED"] } }, orderBy: { version: "desc" }, take: 1 }, documents: { where: { publishedAt: { not: null } }, include: { document: { select: { id: true, title: true, scanStatus: true, deletedAt: true } } } } },
      orderBy: [{ adjustedDue: "asc" }],
    });
    out.push({
      id: e.id,
      name: e.legalName || e.dba || "Your business",
      kind: e.kind,
      periods: periods.map((p) => {
        const o = obligations.find((x) => x.id === p.obligationId)!;
        const v = p.versions[0];
        return {
          id: p.id,
          form: o.formName,
          title: o.title,
          period: p.periodKey,
          periodStart: iso(p.periodStart),
          periodEnd: iso(p.periodEnd),
          dueDate: iso(effectiveDue(p)),
          dueCertain: p.dueCertainty === "CONFIRMED",
          amountDueCents: p.amountDueCents,
          status: clientStatus(p, today),
          paymentStatus: PAYMENT_STATUS[p.paymentStatus as keyof typeof PAYMENT_STATUS] ?? p.paymentStatus,
          actualFilingDate: iso(p.actualFilingDate),
          confirmationNumber: p.confirmationNumber,
          awaitingMe: v?.status === "SENT" && p.filingStatus === "AWAITING_APPROVAL" ? { versionId: v.id, version: v.version, contentHash: v.contentHash, documentIds: v.documentIds } : null,
          published: p.documents.filter((d) => d.document.scanStatus === "CLEAN" && !d.document.deletedAt).map((d) => ({ documentId: d.document.id, title: d.document.title, kind: d.kind })),
        };
      }),
    });
  }
  return { entities: out };
}

/** A compliance document for a portal login: a published one, or one in the version awaiting their review. */
export async function portalComplianceDocument(portalUserId: string, documentId: string) {
  const link = await prisma.complianceDocument.findUnique({ where: { documentId }, include: { document: { include: { file: true } }, period: true } });
  if (!link || !link.period || link.document.deletedAt || link.document.scanStatus !== "CLEAN") return null;
  if (!(await portalMayActOnPeriod(portalUserId, link.period))) return null;
  if (link.publishedAt) return link.document;
  const inReview = await prisma.complianceReturnVersion.count({ where: { periodId: link.period.id, status: { in: ["SENT", "APPROVED", "CHANGES_REQUESTED"] }, documentIds: { has: documentId } } });
  return inReview ? link.document : null;
}

// --- Staff: board, entity, period -------------------------------------------------------------

export type BoardFilter = {
  clientId?: string; entityId?: string; state?: string; county?: string; city?: string; industry?: string; form?: string; staffId?: string;
  from?: string; to?: string; filingStatus?: string; frequency?: string; segment?: "nonprofit" | "bookkeeping" | "payroll" | "tax_only"; includeDone?: boolean;
};

export async function taxDueBoard(actor: Actor, f: BoardFilter = {}) {
  await assertComplianceView(actor);
  const today = officeToday();
  const where: Prisma.ComplianceFilingPeriodWhereInput = {
    obligation: { status: { in: ["ACTIVE"] }, ...(f.frequency ? { frequency: f.frequency } : {}), ...(f.staffId ? { assignedStaffId: f.staffId } : {}), ...(f.form ? { OR: [{ formName: { contains: f.form, mode: "insensitive" } }, { title: { contains: f.form, mode: "insensitive" } }] } : {}) },
    ...(f.clientId ? { clientId: f.clientId } : {}),
    ...(f.entityId ? { entityId: f.entityId } : {}),
    ...(f.filingStatus ? { filingStatus: f.filingStatus } : f.includeDone ? {} : { OR: [{ filingStatus: { notIn: COMPLETE_FILING } }, { filingStatus: "SUBMITTED" }, { paymentStatus: "DUE" }] }),
    ...(f.from || f.to ? { adjustedDue: { ...(f.from ? { gte: new Date(`${f.from}T00:00:00Z`) } : {}), ...(f.to ? { lte: new Date(`${f.to}T00:00:00Z`) } : {}) } } : {}),
  };
  const periods = await prisma.complianceFilingPeriod.findMany({
    where,
    include: { obligation: { include: { filingAccount: true } }, entity: { include: { locations: true, client: { select: { id: true, displayName: true, bookkeepingProfile: { select: { active: true, payroll: true } }, clientServices: { where: { status: { not: "CLOSED" } }, select: { type: true } } } } } }, evidence: { select: { kind: true } } },
    orderBy: [{ adjustedDue: "asc" }],
    take: 1000,
  });
  const staff = await prisma.user.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } });
  const ci = (a: string | null | undefined, b: string) => (a ?? "").toLowerCase() === b.toLowerCase();
  const rows = periods
    .filter((p) => !f.state || p.entity.locations.some((l) => ci(l.state, f.state!)) || p.entity.statesOfOperation.includes(f.state.toUpperCase()))
    .filter((p) => !f.county || p.entity.locations.some((l) => ci(l.county, f.county!.replace(/ county$/i, ""))))
    .filter((p) => !f.city || p.entity.locations.some((l) => ci(l.city, f.city!)))
    .filter((p) => !f.industry || ci(p.entity.industry, f.industry) || p.entity.activityTags.includes(f.industry.toLowerCase()))
    .filter((p) => {
      if (!f.segment) return true;
      const svc = new Set(p.entity.client.clientServices.map((s) => s.type as string));
      if (f.segment === "nonprofit") return p.entity.kind === "NONPROFIT";
      if (f.segment === "bookkeeping") return !!p.entity.client.bookkeepingProfile?.active;
      if (f.segment === "payroll") return p.entity.payrollStatus === "YES" || svc.has("PAYROLL") || !!p.entity.client.bookkeepingProfile?.payroll;
      return !p.entity.client.bookkeepingProfile?.active && !svc.has("PAYROLL") && [...svc].some((s) => s.startsWith("TAX_"));
    })
    .map((p) => {
      const due = iso(effectiveDue(p));
      return {
        id: p.id, periodKey: p.periodKey, kind: p.kind, due, days: due ? daysBetween(today, due) : null, dueCertain: p.dueCertainty === "CONFIRMED", prepDeadline: iso(p.prepDeadline),
        filingStatus: p.filingStatus, paymentStatus: p.paymentStatus, status: clientStatus(p, today),
        title: p.obligation.title, form: p.obligation.formName, frequency: p.obligation.frequency, jurisdiction: p.obligation.jurisdictionName, verification: p.obligation.verification,
        assignedStaffId: p.obligation.assignedStaffId, assigned: staff.find((s) => s.id === p.obligation.assignedStaffId)?.name ?? "Unassigned (owner)",
        portalUrl: p.obligation.filingAccount?.portalUrl ?? null,
        entityId: p.entityId, entityName: p.entity.legalName || p.entity.dba || "(legal name missing)", entityKind: p.entity.kind, clientId: p.clientId, clientName: p.entity.client.displayName,
        hasAcceptance: p.evidence.some((e) => e.kind === "ACCEPTANCE"), hasPaymentEvidence: p.evidence.some((e) => e.kind === "PAYMENT"),
      };
    });
  const open = rows.filter((r) => !COMPLETE_FILING.includes(r.filingStatus));
  const in30 = (r: (typeof rows)[number]) => r.days !== null && r.days >= 0 && r.days <= 30;
  const settings = await complianceSettings();
  const workload = staff.map((s) => ({ name: s.name, id: s.id, open: open.filter((r) => r.assignedStaffId === s.id).length, overdue: open.filter((r) => r.assignedStaffId === s.id && r.days !== null && r.days < 0).length })).filter((w) => w.open > 0);
  const unassigned = open.filter((r) => !r.assignedStaffId).length;
  const [clients, entities] = await Promise.all([
    prisma.client.findMany({ where: { complianceEntities: { some: {} } }, select: { id: true, displayName: true }, orderBy: { displayName: "asc" } }),
    prisma.complianceEntity.findMany({ where: { archivedAt: null, ...(f.clientId ? { clientId: f.clientId } : {}) }, select: { id: true, legalName: true, dba: true, clientId: true }, orderBy: { createdAt: "asc" } }),
  ]);
  return {
    rows,
    widgets: {
      upcoming: open.filter((r) => in30(r) && r.filingStatus !== "AWAITING_APPROVAL"),
      overdue: open.filter((r) => r.days !== null && r.days < 0),
      awaitingApproval: rows.filter((r) => r.filingStatus === "AWAITING_APPROVAL"),
      missingConfirmations: rows.filter((r) => (r.filingStatus === "SUBMITTED" && !r.hasAcceptance) || (r.paymentStatus === "PAID" && !r.hasPaymentEvidence) || r.paymentStatus === "DUE" && COMPLETE_FILING.includes(r.filingStatus)),
      renewals: open.filter((r) => r.days !== null && r.days <= 60 && /licen|permit|renewal/i.test(r.title)),
      workload: [...workload, ...(unassigned ? [{ id: "", name: "Unassigned (owner)", open: unassigned, overdue: open.filter((r) => !r.assignedStaffId && r.days !== null && r.days < 0).length }] : [])],
      needsVerification: open.filter((r) => !r.dueCertain).length,
    },
    options: { staff, clients, entities: entities.map((e) => ({ id: e.id, name: e.legalName || e.dba || "(legal name missing)", clientId: e.clientId })) },
    switches: { clientNotificationsAuthorized: settings.clientNotificationsAuthorized, staffEmailReminders: settings.staffEmailReminders },
    today,
  };
}

/** My in-app reminders (unread first). */
export async function myReminders(actor: Actor, take = 20) {
  await assertComplianceView(actor);
  return prisma.complianceReminder.findMany({ where: { recipient: `staff:${actor.id}`, channel: "IN_APP", period: { filingStatus: { notIn: COMPLETE_FILING }, obligation: { status: "ACTIVE" } } }, orderBy: [{ createdAt: "desc" }], take, include: { period: { select: { id: true, periodKey: true, obligation: { select: { formName: true } } } } } });
}

export async function entityWorkspace(actor: Actor, entityId: string) {
  const access = await assertComplianceView(actor);
  const e = await prisma.complianceEntity.findUnique({
    where: { id: entityId },
    include: {
      client: { select: { id: true, displayName: true, businessName: true } },
      owners: { include: { businessOwner: { include: { contact: { select: { name: true } } } } } },
      viewers: { where: { revokedAt: null } },
      locations: true,
      taxAccounts: { orderBy: { createdAt: "asc" } },
      licenses: { include: { businessLicense: true } },
      filingAccounts: { include: { firmAccount: true, authorizations: true }, orderBy: { createdAt: "asc" } },
      authorizations: { orderBy: { createdAt: "desc" } },
      linkedEntity: { select: { id: true, legalName: true, dba: true } },
      linkedFrom: { select: { id: true, legalName: true, dba: true, kind: true } },
      obligations: { include: { rule: { select: { version: true, verificationStatus: true, sourceUrls: true } }, filingAccount: true }, orderBy: [{ status: "asc" }, { category: "asc" }, { title: "asc" }] },
      periods: { include: { evidence: { orderBy: { recordedAt: "desc" } }, versions: { orderBy: { version: "desc" }, include: { approvals: true } } }, orderBy: { adjustedDue: "asc" } },
      documents: { include: { document: { select: { id: true, title: true, scanStatus: true, createdAt: true, deletedAt: true } } }, orderBy: { createdAt: "desc" } },
    },
  });
  if (!e) return null;
  const [firmAccounts, owners, licenses, history, facts, staff, nonprofitProfile, portalLogins] = await Promise.all([
    prisma.complianceFilingAccount.findMany({ where: { firmLevel: true } }),
    prisma.businessOwner.findMany({ where: { clientId: e.clientId, archivedAt: null }, include: { contact: { select: { name: true } } } }),
    prisma.businessLicense.findMany({ where: { clientId: e.clientId, archivedAt: null } }),
    prisma.auditLog.findMany({ where: { OR: [{ entityType: "ComplianceEntity", entityId }, { entityType: "ComplianceObligation", entityId: { in: e.obligations.map((o) => o.id) } }, { entityType: "ComplianceFilingPeriod", entityId: { in: e.periods.map((p) => p.id) } }] }, orderBy: { createdAt: "desc" }, take: 60, include: { actor: { select: { name: true } } } }),
    entityFacts(entityId),
    prisma.user.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    e.nonprofitClientId ? prisma.nonprofitProfile.findUnique({ where: { clientId: e.nonprofitClientId } }) : null,
    prisma.portalAccess.findMany({ where: { clientId: e.clientId, revokedAt: null }, include: { portalUser: { select: { id: true, name: true, email: true } } } }),
  ]);
  return { e: { ...e, einEncrypted: null, einHash: null, einMasked: maskEin(e.einLast4), taxAccounts: e.taxAccounts.map((a) => ({ ...a, accountNumberEnc: null })) }, access, firmAccounts, owners, licenses, history, facts, staff, nonprofitProfile, portalLogins, portalKinds: PORTAL_KINDS };
}

export async function periodWorkspace(actor: Actor, periodId: string) {
  const access = await assertComplianceView(actor);
  const p = await prisma.complianceFilingPeriod.findUnique({
    where: { id: periodId },
    include: {
      obligation: { include: { filingAccount: { include: { firmAccount: true } }, rule: true, taxAccount: true } },
      entity: { include: { client: { select: { id: true, displayName: true } } } },
      evidence: { orderBy: { recordedAt: "asc" } },
      versions: { orderBy: { version: "desc" }, include: { approvals: { orderBy: { createdAt: "asc" } } } },
      documents: { include: { document: { select: { id: true, title: true, scanStatus: true, createdAt: true, deletedAt: true, file: { select: { sha256: true } } } } }, orderBy: { createdAt: "asc" } },
      reminders: { orderBy: { createdAt: "desc" }, take: 40 },
    },
  });
  if (!p) return null;
  const ids = [...new Set([...p.evidence.map((e) => e.recordedById), p.verifiedById, p.acceptedById, p.paidById, ...p.versions.map((v) => v.preparedById)].filter((x): x is string => !!x))];
  const portalIds = [...new Set(p.versions.flatMap((v) => v.approvals.map((a) => a.portalUserId)))];
  const [users, portalUsers, task] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
    prisma.portalUser.findMany({ where: { id: { in: portalIds } }, select: { id: true, name: true, email: true } }),
    p.prepTaskId ? prisma.task.findUnique({ where: { id: p.prepTaskId } }) : null,
  ]);
  const { currentApproval } = await import("./periods");
  return { p, access, users, portalUsers, task, approval: await currentApproval(periodId) };
}

// --- Missing Compliance Information ---------------------------------------------------------

export type MissingRow = { clientId: string; clientName: string; entityId: string; entityName: string; item: string; blocks: string; source: string };

/** Every gap that blocks a confirmed obligation, per entity (office-wide or one client). */
export async function missingInfoReport(actor: Actor, opts: { clientId?: string } = {}) {
  await assertComplianceView(actor);
  const entities = await prisma.complianceEntity.findMany({
    where: { archivedAt: null, status: { not: "INACTIVE" }, ...(opts.clientId ? { clientId: opts.clientId } : {}) },
    include: { client: { select: { displayName: true } }, locations: true, taxAccounts: true, obligations: { where: { status: { in: ["PROPOSED", "ACTIVE", "SUSPENDED"] } } } },
    orderBy: [{ clientId: "asc" }, { createdAt: "asc" }],
  });
  const rows: MissingRow[] = [];
  for (const e of entities) {
    const name = e.legalName || e.dba || `(${e.kind.toLowerCase()} — legal name missing)`;
    const add = (item: string, blocks: string, source = "Entity profile") => rows.push({ clientId: e.clientId, clientName: e.client.displayName, entityId: e.id, entityName: name, item, blocks, source });
    if (!e.legalName) add("Legal name not recorded", "Every filing for this entity");
    if (!e.einLast4) add("EIN not recorded", "Federal and state returns");
    if (!e.taxClassification && e.kind !== "NONPROFIT") add("Federal tax classification not recorded", "Income tax obligations");
    if (!e.fiscalYearEndMonth) add("Fiscal year-end not recorded", "Annual income tax / 990 due dates");
    if (!e.stateOfFormation) add("State of formation not recorded", "State filings");
    if (!e.locations.length) add("Business location (address, city, county) not recorded", "County and city taxes and licenses");
    for (const l of e.locations) if (!l.county) add(`County not recorded for ${l.city ?? l.label ?? "a location"}`, "County taxes and licenses");
    if (e.kind !== "NONPROFIT" && e.payrollStatus === "UNKNOWN") add("Payroll status not recorded", "Payroll returns (941, 940, W-2, state withholding)");
    if (e.kind === "NONPROFIT" && !e.irsExemptionStatus) add("IRS exemption status not recorded", "990 series and exemption documents");
    for (const a of e.taxAccounts) {
      const label = `${a.jurisdictionName ?? a.agency} ${a.type === "SALES_USE" ? "sales/use tax" : a.type === "WITHHOLDING" ? "withholding" : "tax"} account`;
      if (!a.accountLast4) add(`${label}: account number missing`, "Filing in the agency portal");
      if (!a.filingFrequency) add(`${label}: filing frequency not recorded`, "Due dates for this tax");
    }
    for (const o of e.obligations) for (const item of o.verifyItems) add(item, o.title, `Obligation (${o.status === "PROPOSED" ? "proposed" : o.status.toLowerCase()})`);
  }
  // De-duplicate identical item lines per entity.
  const seen = new Set<string>();
  return rows.filter((r) => {
    const k = `${r.entityId}|${r.item}|${r.blocks}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function missingInfoCsv(rows: MissingRow[]) {
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  // Formula-injection guard for spreadsheet apps.
  const safe = (s: string) => esc(/^[=+\-@]/.test(s) ? `'${s}` : s);
  return ["Client,Entity,Missing information,Blocks,Source", ...rows.map((r) => [r.clientName, r.entityName, r.item, r.blocks, r.source].map(safe).join(","))].join("\n");
}

export async function clientComplianceSummary(actor: Actor, clientId: string) {
  const access = await complianceAccess(actor);
  if (access.level === "NONE") throw new ForbiddenError("Not found.");
  const entities = await prisma.complianceEntity.findMany({ where: { clientId }, orderBy: { createdAt: "asc" }, include: { obligations: { select: { status: true, verification: true } }, periods: { where: { filingStatus: { notIn: COMPLETE_FILING } }, include: { obligation: { select: { formName: true, status: true } } }, orderBy: { adjustedDue: "asc" } } } });
  return { access, entities };
}
