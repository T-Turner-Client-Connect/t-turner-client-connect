import "server-only";
import type { Client, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { assertAdmin, type Actor } from "@/lib/auth/actor";
import { ValidationError, clientDisplayName } from "@/lib/services/clients";
import { candidateKeys } from "@/lib/import/rows";

type Tx = Prisma.TransactionClient;

/**
 * Every table that points at a client (from the schema). On merge these move
 * from the duplicate to the record being kept. Audit logs stay where they
 * were written — the archived duplicate keeps its own history, and it is
 * linked to the kept record with mergedIntoId.
 */
const MOVABLE: { model: string; label: string; fk?: string }[] = [
  { model: "contact", label: "Contacts" },
  { model: "clientNote", label: "Notes" },
  { model: "consentRecord", label: "Consent records" },
  { model: "task", label: "Tasks" },
  { model: "campaignInclusion", label: "Campaign inclusions" },
  { model: "campaignExclusion", label: "Campaign exclusions" },
  { model: "portalAccess", label: "Portal access" },
  { model: "portalInvite", label: "Portal invitations" },
  { model: "conversation", label: "Conversations" },
  { model: "document", label: "Documents" },
  { model: "bookkeepingPeriod", label: "Bookkeeping months" },
  { model: "documentRequest", label: "Document requests" },
  { model: "announcement", label: "Announcements" },
  { model: "questionnaireSubmission", label: "Questionnaires" },
  { model: "questionnaireRequest", label: "Questionnaire requests" },
  { model: "taxYearProgress", label: "Tax-year progress" },
  { model: "clientDeadline", label: "Deadlines" },
  { model: "signatureRequest", label: "Signature requests" },
  { model: "contractAssignment", label: "Contracts" },
  { model: "appointment", label: "Appointments" },
  { model: "pipelineCard", label: "Pipeline cards" },
  { model: "filingRecord", label: "Filings" },
  { model: "invoice", label: "Invoices" },
  { model: "payment", label: "Payments" },
  { model: "identityPerson", label: "Identity people" },
  { model: "identityDocument", label: "Identity documents" },
  { model: "bookkeepingProfile", label: "Bookkeeping profile" },
  { model: "bookkeepingAccount", label: "Bookkeeping accounts" },
  { model: "bookkeepingBilling", label: "Bookkeeping billing" },
  { model: "recurringChargeAuthorization", label: "Payment authorizations" },
  { model: "businessOnboarding", label: "Business onboarding" },
  { model: "businessInfoChange", label: "Business info changes" },
  { model: "noticeCase", label: "Audits & notices" },
  { model: "clientRelationship", label: "Business relationships (as person)", fk: "personClientId" },
  { model: "clientRelationship", label: "Business relationships (as business)", fk: "businessClientId" },
  { model: "squareBillingMember", label: "Square billing series" },
  { model: "nonprofitProfile", label: "Nonprofit profile" },
  { model: "clientService", label: "Services & agreements" },
  { model: "nonprofitPortfolio", label: "Nonprofit portfolio" },
  { model: "installmentPlan", label: "Installment plans" },
  { model: "manualBillingPayment", label: "Manual billing payments" },
  { model: "taxPrepCase", label: "Tax-preparation cases" },
];

// One-per-client records: if both have one, staff must resolve it first.
const ONE_PER_CLIENT = new Set(["bookkeepingProfile", "bookkeepingBilling", "nonprofitProfile", "nonprofitPortfolio", "businessOnboarding"]);
// Unique keys that include the client: [model, other key fields, label]
const PER_CLIENT_KEYS: [string, string[], string][] = [
  ["portalAccess", ["portalUserId"], "the same portal login"],
  ["bookkeepingPeriod", ["year", "month"], "the same bookkeeping month"],
  ["questionnaireRequest", ["taxYear"], "a questionnaire request for the same tax year"],
  ["taxYearProgress", ["taxYear"], "tax-year progress for the same year"],
  ["pipelineCard", ["stageId"], "a card in the same pipeline stage"],
  ["filingRecord", ["taxYear", "returnType", "jurisdiction", "filingType"], "the same filing"],
  ["squareBillingMember", ["arrangementId"], "the same Square billing series"],
  ["taxPrepCase", ["taxYear"], "a tax-preparation case for the same tax year"],
];

const FIELDS: [keyof Client, string][] = [
  ["firstName", "First name"],
  ["middleName", "Middle name"],
  ["lastName", "Last name"],
  ["preferredName", "Preferred name"],
  ["businessName", "Business name"],
  ["email", "Email"],
  ["phone", "Phone"],
  ["spouseFirstName", "Spouse first name"],
  ["spouseMiddleName", "Spouse middle name"],
  ["spouseLastName", "Spouse last name"],
  ["spouseEmail", "Spouse email"],
  ["spousePhone", "Spouse phone"],
  ["addressLine1", "Address"],
  ["addressLine2", "Address line 2"],
  ["city", "City"],
  ["state", "State"],
  ["postalCode", "ZIP"],
  ["assignedToId", "Assigned staff"],
  ["taxSoftwareId", "TaxAct client ID"],
  ["entityType", "Entity type"],
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const delegate = (db: Tx | typeof prisma, model: string) => (db as any)[model];

export async function mergePreview(keepId: string, dupId: string) {
  if (keepId === dupId) throw new ValidationError("Choose two different client records.");
  const [keep, dup] = await Promise.all([prisma.client.findUnique({ where: { id: keepId } }), prisma.client.findUnique({ where: { id: dupId } })]);
  if (!keep || !dup) throw new ValidationError("Client not found.");
  if (keep.archivedAt || dup.archivedAt) throw new ValidationError("Restore archived records before merging.");
  const moves: { label: string; count: number }[] = [];
  for (const m of MOVABLE) {
    const count = await delegate(prisma, m.model).count({ where: { [m.fk ?? "clientId"]: dupId } });
    if (count) moves.push({ label: m.label, count });
  }
  const conflicts: string[] = [];
  for (const model of ONE_PER_CLIENT) {
    const [a, b] = await Promise.all([delegate(prisma, model).count({ where: { clientId: keepId } }), delegate(prisma, model).count({ where: { clientId: dupId } })]);
    if (a && b) conflicts.push(`Both records have a ${MOVABLE.find((x) => x.model === model)!.label.toLowerCase()} — keep one and remove the other first.`);
  }
  for (const [model, keys, label] of PER_CLIENT_KEYS) {
    const dupRows = await delegate(prisma, model).findMany({ where: { clientId: dupId }, select: Object.fromEntries(keys.map((k) => [k, true])) });
    for (const r of dupRows) {
      if (await delegate(prisma, model).count({ where: { clientId: keepId, ...r } })) conflicts.push(`Both records have ${label} (${keys.map((k) => r[k]).join(" · ")}).`);
    }
  }
  const rel = await prisma.clientRelationship.findMany({ where: { OR: [{ personClientId: dupId }, { businessClientId: dupId }] } });
  for (const r of rel) {
    const other = r.personClientId === dupId ? r.businessClientId : r.personClientId;
    if (other === keepId) conflicts.push("The two records are linked to each other as owner and business — unlink them first.");
  }
  if (keep.taxSoftwareId && dup.taxSoftwareId && keep.taxSoftwareId !== dup.taxSoftwareId) conflicts.push("The records have different TaxAct client IDs — confirm which one is right first.");
  const fields = FIELDS.map(([f, label]) => ({ field: f as string, label, keep: (keep[f] as string | null) ?? null, duplicate: (dup[f] as string | null) ?? null }))
    .filter((x) => x.duplicate && x.duplicate !== x.keep)
    .map((x) => ({ ...x, outcome: x.keep ? ("choose" as const) : ("fill" as const) }));
  return { keep, dup, moves, conflicts, fields };
}

/**
 * Admin-only, after the preview: moves everything from the duplicate to the
 * kept record, fills the kept record's blank fields (and the fields staff
 * chose), then ARCHIVES the duplicate with a merged-into link. Nothing is
 * deleted. Refuses while any conflict remains.
 */
export async function mergeClients(actor: Actor, keepId: string, dupId: string, useDuplicateFor: string[], confirmName: string) {
  assertAdmin(actor);
  const p = await mergePreview(keepId, dupId);
  if (p.conflicts.length) throw new ValidationError(`Resolve these first: ${p.conflicts.join(" ")}`);
  if (confirmName.trim().toLowerCase() !== p.dup.displayName.trim().toLowerCase()) throw new ValidationError(`Type the duplicate's name exactly ("${p.dup.displayName}") to confirm.`);
  const chosen = new Set(useDuplicateFor);
  const data: Record<string, unknown> = {};
  for (const f of p.fields) if (f.outcome === "fill" || chosen.has(f.field)) data[f.field] = f.duplicate;
  if ("email" in data) data.emailNormalized = p.dup.emailNormalized;
  if ("phone" in data) data.phoneNormalized = p.dup.phoneNormalized;
  if ("spousePhone" in data) data.spousePhoneNormalized = p.dup.spousePhoneNormalized;
  const union = (a: string[], b: string[]) => [...a, ...b.filter((x) => !a.some((y) => y.toLowerCase() === x.toLowerCase()))];
  data.services = union(p.keep.services, p.dup.services);
  data.tags = union(p.keep.tags, p.dup.tags);
  if (p.dup.notes && !p.keep.notes?.includes(p.dup.notes)) data.notes = [p.keep.notes, p.dup.notes].filter(Boolean).join("\n\n");
  if (p.dup.taxReturnDerived) data.taxReturnDerived = true;

  return prisma.$transaction(
    async (tx) => {
      // The unique TaxAct ID moves with the record.
      if ("taxSoftwareId" in data) await tx.client.update({ where: { id: dupId }, data: { taxSoftwareId: null } });
      for (const m of MOVABLE) await delegate(tx, m.model).updateMany({ where: { [m.fk ?? "clientId"]: dupId }, data: { [m.fk ?? "clientId"]: keepId } });
      const groups = await tx.clientGroup.findMany({ where: { clientId: dupId } });
      await tx.clientGroup.createMany({ data: groups.map((g) => ({ clientId: keepId, groupId: g.groupId })), skipDuplicates: true });
      await tx.clientGroup.deleteMany({ where: { clientId: dupId } });
      await tx.onboardingApplication.updateMany({ where: { clientId: dupId }, data: { clientId: keepId } });
      await tx.jotformInbox.updateMany({ where: { filedClientId: dupId }, data: { filedClientId: keepId } });
      await tx.jotformInbox.updateMany({ where: { suggestedClientId: dupId }, data: { suggestedClientId: keepId } });
      const kept = await tx.client.update({ where: { id: keepId }, data: data as Prisma.ClientUpdateInput });
      await tx.client.update({ where: { id: keepId }, data: { displayName: clientDisplayName(kept) } });
      await tx.client.update({
        where: { id: dupId },
        data: { archivedAt: new Date(), status: "INACTIVE", mergedIntoId: keepId, notes: [p.dup.notes, `Merged into ${p.keep.displayName} on ${new Date().toISOString().slice(0, 10)} by ${actor.name}.`].filter(Boolean).join("\n\n") },
      });
      const details = { keepId, dupId, moved: p.moves, fieldsFromDuplicate: Object.keys(data).filter((k) => FIELDS.some(([f]) => f === k)) };
      await audit(tx, { actorId: actor.id, action: "client.merged_in", entityType: "Client", entityId: keepId, clientId: keepId, details });
      await audit(tx, { actorId: actor.id, action: "client.merged_away", entityType: "Client", entityId: dupId, clientId: dupId, details });
      return kept;
    },
    { timeout: 60_000 },
  );
}

/**
 * Possible duplicate pairs for staff review: same email or phone (including a
 * spouse's), or the same person by name. Nothing is merged automatically.
 */
export async function possibleDuplicates() {
  const clients = await prisma.client.findMany({
    where: { archivedAt: null },
    select: { id: true, displayName: true, firstName: true, lastName: true, spouseFirstName: true, spouseLastName: true, emailNormalized: true, phoneNormalized: true, spouseEmail: true, spousePhoneNormalized: true, postalCode: true, createdAt: true, source: true },
  });
  const buckets = new Map<string, string[]>();
  const add = (key: string | null | undefined, id: string) => {
    if (!key) return;
    buckets.set(key, [...(buckets.get(key) ?? []), id]);
  };
  for (const c of clients) {
    add(c.emailNormalized && `email:${c.emailNormalized}`, c.id);
    add(c.spouseEmail && `email:${c.spouseEmail.toLowerCase()}`, c.id);
    add(c.phoneNormalized && `phone:${c.phoneNormalized}`, c.id);
    add(c.spousePhoneNormalized && `phone:${c.spousePhoneNormalized}`, c.id);
    for (const k of candidateKeys({ ...c, businessName: null, lastName: c.lastName, emailNormalized: null, phoneNormalized: null, contactEmails: [], contactPhones: [] })) add(`name:${k}`, c.id);
  }
  const pairs = new Map<string, { a: string; b: string; why: Set<string> }>();
  for (const [key, ids] of buckets) {
    const uniq = [...new Set(ids)];
    if (uniq.length < 2 || uniq.length > 6) continue;
    for (let i = 0; i < uniq.length; i++)
      for (let j = i + 1; j < uniq.length; j++) {
        const [a, b] = [uniq[i], uniq[j]].sort();
        const e = pairs.get(`${a}|${b}`) ?? { a, b, why: new Set<string>() };
        e.why.add(key.startsWith("email:") ? "Same email" : key.startsWith("phone:") ? "Same phone" : "Same name");
        pairs.set(`${a}|${b}`, e);
      }
  }
  const byId = new Map(clients.map((c) => [c.id, c]));
  return [...pairs.values()]
    .map((p) => ({ a: byId.get(p.a)!, b: byId.get(p.b)!, why: [...p.why] }))
    .sort((x, y) => y.why.length - x.why.length || +y.b.createdAt - +x.b.createdAt);
}
