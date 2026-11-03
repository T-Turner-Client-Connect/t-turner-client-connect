import "server-only";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { ValidationError, clientDisplayName } from "@/lib/services/clients";
import { looksCombined, parseTaxpayerName } from "@/lib/tax/return-types";

/** What the repair would save, parsed from a name that holds two people. */
export function proposedJointRepair(c: { firstName: string | null; middleName: string | null; lastName: string | null; displayName: string }) {
  const parsed = parseTaxpayerName([c.firstName, c.middleName, c.lastName].filter(Boolean).join(" ")) ?? parseTaxpayerName(c.displayName);
  if (!parsed?.spouse) return null;
  return {
    firstName: parsed.primary.first,
    middleName: parsed.primary.middle,
    lastName: parsed.primary.last,
    spouseFirstName: parsed.spouse.first,
    spouseMiddleName: parsed.spouse.middle,
    spouseLastName: parsed.spouse.last,
  };
}

const clean = (v: string | null | undefined) => v?.trim().replace(/\s+/g, " ").slice(0, 100) || null;

/**
 * Staff-confirmed repair of a record that holds two people in one name
 * ("Allison R Stockton & Jonathan" / "Scoggins"). Splits it into the
 * taxpayer and the spouse on the SAME client record. Spouse fields that
 * already hold a value are never overwritten. Audited.
 */
export async function repairJointName(actor: Actor, clientId: string, input: Record<"firstName" | "middleName" | "lastName" | "spouseFirstName" | "spouseMiddleName" | "spouseLastName", string>) {
  const c = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
  const v = Object.fromEntries(Object.entries(input).map(([k, x]) => [k, clean(x)])) as Record<keyof typeof input, string | null>;
  if (!v.firstName || !v.lastName) throw new ValidationError("Enter the taxpayer's first and last name.");
  if (!v.spouseFirstName || !v.spouseLastName) throw new ValidationError("Enter the spouse's first and last name.");
  if ([v.firstName, v.lastName, v.spouseFirstName, v.spouseLastName].some((x) => x && /&|\s(and|\+)\s/i.test(x))) throw new ValidationError("Each name field should hold one person.");
  if (!looksCombined(c) && (c.spouseFirstName || c.spouseLastName)) throw new ValidationError("This record already has separate spouse details — edit them on Edit Client.");
  const data = {
    firstName: v.firstName,
    middleName: v.middleName ?? c.middleName,
    lastName: v.lastName,
    spouseFirstName: c.spouseFirstName ?? v.spouseFirstName,
    spouseMiddleName: c.spouseMiddleName ?? v.spouseMiddleName,
    spouseLastName: c.spouseLastName ?? v.spouseLastName,
  };
  await prisma.$transaction(async (tx) => {
    await tx.client.update({ where: { id: clientId }, data: { ...data, displayName: clientDisplayName({ ...c, ...data }) } });
    await audit(tx, { actorId: actor.id, action: "client.joint_name_repaired", entityType: "Client", entityId: clientId, clientId, details: { from: { firstName: c.firstName, lastName: c.lastName }, fields: Object.keys(data) } });
  });
}

/** Imported / tax clients with fields still missing — the staff completion report. */
export async function incompleteClients() {
  const clients = await prisma.client.findMany({
    where: { archivedAt: null, OR: [{ taxReturnDerived: true }, { source: { startsWith: "Import:" } }] },
    include: { assignedTo: { select: { name: true } }, taxPrepCases: { orderBy: { taxYear: "desc" }, take: 1 } },
    orderBy: { displayName: "asc" },
    take: 2000,
  });
  return clients
    .map((c) => {
      const kase = c.taxPrepCases[0];
      const joint = kase?.returnType === "1040_MFJ" || !!(c.spouseFirstName || c.spouseLastName);
      const missing = [
        !c.addressLine1 && "Mailing address",
        !c.city && "City",
        !c.state && "State",
        !c.postalCode && "ZIP",
        !c.email && "Email",
        !c.phone && "Phone",
        !c.assignedToId && "Assigned staff",
        looksCombined(c) && "Name holds two people",
        joint && !(c.spouseFirstName && c.spouseLastName) && "Spouse name",
        joint && !c.spouseEmail && !c.spousePhone && "Spouse contact",
        !kase && "Tax-preparation case",
        kase && !kase.returnType && "Return type",
      ].filter((x): x is string => !!x);
      return { id: c.id, displayName: c.displayName, assigned: c.assignedTo?.name ?? null, missing };
    })
    .filter((c) => c.missing.length);
}
