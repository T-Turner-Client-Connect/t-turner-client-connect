import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { IMPORT_FIELD_KEYS, isImportField, isSensitiveHeader, MAX_IMPORT_ROWS } from "@/lib/import/fields";
import { classifyRow, cleanRow, type CleanRow, type MatchCandidate } from "@/lib/import/rows";
import { IMPORT_FIELDS } from "@/lib/import/fields";
import { mergeList, plannedChanges, REPLACEABLE_FIELDS } from "@/lib/import/plan";
import { caseFromImport } from "@/lib/services/tax-prep";
import { normalizePhone } from "@/lib/normalize";
import { clientDisplayName } from "@/lib/services/clients";

export class ImportError extends Error {}

export type StageInput = {
  fileName: string;
  source: string;
  taxReturnDerived: boolean;
  // header -> CRM field (only the columns staff chose to map)
  mapping: Record<string, string>;
  // Rows keyed by CRM field. Built in the browser from mapped columns only.
  rows: Record<string, unknown>[];
  // Every column header in the file (names only, never cells) so the summary
  // can say what wasn't imported.
  headers?: string[];
  // Service added to every client in this batch, e.g. "Tax Preparation".
  batchService?: string | null;
  // Tax year the return types belong to (required with Tax Preparation or
  // a return-type / filing-status column).
  taxYear?: number | null;
  // Staff member assigned to every client in the batch, and groups added.
  batchAssignedToId?: string | null;
  batchGroupIds?: string[];
};

export const BATCH_SERVICES = ["Tax Preparation", "Bookkeeping", "Payroll", "Business Tax Preparation", "Nonprofit Services", "Consulting"] as const;
const TAX_SERVICES = new Set(["tax preparation", "business tax preparation"]);

export type ImportSummary = {
  mappedColumns: { header: string; field: string }[];
  unmappedColumns: string[];
  blockedColumns: string[];
  rows: number;
  missing: Record<string, number>;
  attention: { joint: number[]; phoneInvalid: number[]; emailInvalid: number[]; returnTypeNeeded: number[]; returnTypeUnrecognized: number[]; noContact: number[] };
  result?: {
    created: number;
    updated: number;
    skipped: number;
    unchanged: number;
    duplicatesPrevented?: number;
    casesCreated: number;
    casesFilled: number;
    returnTypesPrefilled: number;
    // Client ids still needing a return-type selection or confirmation.
    needsReturnType: string[];
    needsConfirmation: string[];
    namesRepaired: string[];
  };
};

/**
 * Validates mapped rows, finds likely duplicates, and stores a review batch.
 * Only allow-listed fields are kept; the original file never reaches the
 * server.
 */
export async function stageImport(actor: Actor, input: StageInput) {
  if (input.rows.length === 0) throw new ImportError("The file has no data rows.");
  if (input.rows.length > MAX_IMPORT_ROWS) {
    throw new ImportError(`Import up to ${MAX_IMPORT_ROWS} rows at a time.`);
  }
  const mapping: Record<string, string> = {};
  for (const [header, field] of Object.entries(input.mapping)) {
    if (!isImportField(field)) continue;
    if (isSensitiveHeader(header)) {
      throw new ImportError(`The column "${header}" looks like tax or financial data and can't be imported.`);
    }
    mapping[header.slice(0, 200)] = field;
  }
  if (Object.keys(mapping).length === 0) throw new ImportError("Map at least one column.");
  const mappedFields = new Set(Object.values(mapping));
  const batchService = input.batchService ? BATCH_SERVICES.find((b) => b === input.batchService) ?? null : null;
  if (input.batchService && !batchService) throw new ImportError("Choose a service from the list.");
  const taxYear = input.taxYear ? Number(input.taxYear) : null;
  const wantsCase = (batchService && TAX_SERVICES.has(batchService.toLowerCase())) || mappedFields.has("returnType") || mappedFields.has("filingStatus");
  if (taxYear !== null && (!Number.isInteger(taxYear) || taxYear < 2000 || taxYear > new Date().getFullYear() + 1)) throw new ImportError("Choose a valid tax year.");
  if (wantsCase && !taxYear && !mappedFields.has("taxYear")) throw new ImportError("Choose the tax year these returns are for.");
  const batchAssignedToId = input.batchAssignedToId || null;
  if (batchAssignedToId && !(await prisma.user.count({ where: { id: batchAssignedToId, active: true } }))) throw new ImportError("Choose an active staff member to assign.");
  const batchGroupIds = Array.from(new Set(input.batchGroupIds ?? [])).slice(0, 20);
  if (batchGroupIds.length && (await prisma.group.count({ where: { id: { in: batchGroupIds } } })) !== batchGroupIds.length) throw new ImportError("One of the chosen groups no longer exists.");

  const cleaned = input.rows.map((raw) => {
    // Drop anything that isn't both allow-listed and actually mapped.
    const allowed: Record<string, unknown> = {};
    for (const key of IMPORT_FIELD_KEYS) if (mappedFields.has(key) && key in raw) allowed[key] = raw[key];
    return cleanRow(allowed);
  });

  const emails = cleaned.map((c) => c.row.emailNormalized).filter((v): v is string => !!v);
  const phones = cleaned.map((c) => c.row.phoneNormalized).filter((v): v is string => !!v);
  const names = Array.from(new Set(cleaned.flatMap((c) => [c.row.displayName, [c.row.firstName, c.row.lastName].filter(Boolean).join(" ")]).filter((v) => v && v !== "Unnamed client")));
  const lastNames = Array.from(new Set(cleaned.flatMap((c) => [c.row.lastName, c.row.spouse?.last]).filter((v): v is string => !!v)));
  const existing = await prisma.client.findMany({
    where: {
      OR: [
        { emailNormalized: { in: emails } },
        { phoneNormalized: { in: phones } },
        { contacts: { some: { OR: [{ emailNormalized: { in: emails } }, { phoneNormalized: { in: phones } }] } } },
        // Name-based fallback (confirmed against the address in classifyRow).
        ...names.map((n) => ({ displayName: { equals: n, mode: "insensitive" as const } })),
        ...(lastNames.length ? [{ lastName: { in: lastNames, mode: "insensitive" as const } }, { spouseLastName: { in: lastNames, mode: "insensitive" as const } }] : []),
        ...lastNames.map((l) => ({ displayName: { contains: l, mode: "insensitive" as const } })),
        ...(emails.length ? [{ spouseEmail: { in: emails, mode: "insensitive" as const } }] : []),
        ...(phones.length ? [{ spousePhoneNormalized: { in: phones } }] : []),
      ],
    },
    select: {
      id: true,
      displayName: true,
      firstName: true,
      spouseFirstName: true,
      spouseLastName: true,
      addressLine1: true,
      postalCode: true,
      lastName: true,
      businessName: true,
      emailNormalized: true,
      phoneNormalized: true,
      contacts: { select: { emailNormalized: true, phoneNormalized: true } },
    },
  });
  const candidates: MatchCandidate[] = existing.map((c) => ({
    ...c,
    contactEmails: c.contacts.map((x) => x.emailNormalized).filter((v): v is string => !!v),
    contactPhones: c.contacts.map((x) => x.phoneNormalized).filter((v): v is string => !!v),
  }));

  const seen = new Map<string, number>();
  const rows = cleaned.map(({ row, errors, warnings }, i) => {
    const rowNumber = i + 2; // spreadsheet row, after the header
    const result = classifyRow(row, errors, candidates, seen, rowNumber);
    const decision =
      result.match === "NEW" ? "create" : result.match === "MATCH" ? `update:${result.candidateIds[0]}` : result.match === "ERROR" ? "skip" : null;
    return {
      rowNumber,
      data: row as unknown as Prisma.InputJsonValue,
      errors,
      warnings: [...warnings, ...result.notes],
      match: result.match,
      candidateIds: result.candidateIds,
      decision,
    };
  });

  // Completion summary: column names and row numbers only — no cell data.
  const headers = (input.headers ?? Object.keys(input.mapping)).map((h) => String(h).slice(0, 200)).slice(0, 300);
  const missingOf = (pick: (r: CleanRow) => unknown) => cleaned.filter((c) => !pick(c.row)).length;
  const at = (pred: (c: (typeof cleaned)[number]) => boolean) => rows.filter((_, i) => pred(cleaned[i])).map((r) => r.rowNumber);
  const summary: ImportSummary = {
    mappedColumns: Object.entries(mapping).map(([header, field]) => ({ header, field: IMPORT_FIELDS[field as keyof typeof IMPORT_FIELDS] ?? field })),
    unmappedColumns: headers.filter((h) => !mapping[h] && !isSensitiveHeader(h)),
    blockedColumns: headers.filter((h) => isSensitiveHeader(h)),
    rows: rows.length,
    missing: {
      Email: missingOf((r) => r.emailNormalized),
      Phone: missingOf((r) => r.phoneNormalized),
      "Mailing address": missingOf((r) => r.addressLine1),
      City: missingOf((r) => r.city),
      State: missingOf((r) => r.state),
      ZIP: missingOf((r) => r.postalCode),
      ...(wantsCase ? { "Return type / filing status": missingOf((r) => r.returnType) } : {}),
    },
    attention: {
      joint: at((c) => !!c.row.spouse),
      phoneInvalid: at((c) => c.warnings.some((w) => w.startsWith("Phone ") || w.startsWith("Spouse phone"))),
      emailInvalid: at((c) => c.warnings.some((w) => w.startsWith("Email ") || w.startsWith("Spouse email"))),
      returnTypeNeeded: wantsCase ? at((c) => !c.row.returnType && !c.row.returnTypeText) : [],
      returnTypeUnrecognized: at((c) => !!c.row.returnTypeText && !c.row.returnType),
      noContact: at((c) => !c.row.emailNormalized && !c.row.phoneNormalized),
    },
  };

  const batch = await prisma.$transaction(async (tx) => {
    const created = await tx.importBatch.create({
      data: {
        batchServices: batchService ? [batchService] : [],
        taxYear,
        batchAssignedToId,
        batchGroupIds,
        summary: summary as unknown as Prisma.InputJsonValue,
        source: input.source.slice(0, 100) || "Spreadsheet",
        fileName: input.fileName.slice(0, 200),
        mapping,
        updateMode: input.taxReturnDerived ? "fill_blanks;tax" : "fill_blanks",
        importedById: actor.id,
        errorCount: rows.filter((r) => r.match === "ERROR").length,
      },
    });
    await tx.importRow.createMany({ data: rows.map((r) => ({ ...r, batchId: created.id })) });
    await audit(tx, {
      actorId: actor.id,
      action: "import.staged",
      entityType: "ImportBatch",
      entityId: created.id,
      details: { fileName: created.fileName, source: created.source, rows: rows.length, mappedFields: [...mappedFields] },
    });
    return created;
  });
  return batch;
}

const DECISION_RE = /^(create|skip|update:[a-z0-9]+)$/;

export async function setRowDecision(actor: Actor, rowId: string, decision: string) {
  if (!DECISION_RE.test(decision)) throw new ImportError("Invalid choice.");
  const row = await prisma.importRow.findUnique({ where: { id: rowId }, include: { batch: true } });
  if (!row || row.batch.status !== "REVIEW") throw new ImportError("This import is no longer open.");
  if (row.match === "ERROR" && decision !== "skip") throw new ImportError("Rows with errors can only be skipped.");
  if (decision.startsWith("update:")) {
    const exists = await prisma.client.count({ where: { id: decision.slice(7) } });
    if (!exists) throw new ImportError("That client no longer exists.");
  }
  await prisma.importRow.update({ where: { id: rowId }, data: { decision } });
}

/** Staff approve replacing specific fields on the matched client (after the comparison). */
export async function setRowApprovals(actor: Actor, rowId: string, fields: string[]) {
  const row = await prisma.importRow.findUnique({ where: { id: rowId }, include: { batch: true } });
  if (!row || row.batch.status !== "REVIEW") throw new ImportError("This import is no longer open.");
  if (!row.decision?.startsWith("update:")) throw new ImportError("Choose which existing client this row updates first.");
  const allowed = new Set<string>(REPLACEABLE_FIELDS);
  const approved = Array.from(new Set(fields.filter((f) => allowed.has(f))));
  await prisma.importRow.update({ where: { id: rowId }, data: { approvedFields: approved } });
  await audit(prisma, { actorId: actor.id, action: "import.fields_approved", entityType: "ImportRow", entityId: rowId, details: { batchId: row.batchId, fields: approved } });
  return approved;
}

type UpdateMode = "fill_blanks" | "overwrite";

/**
 * Applies staff decisions. Never writes consent records or suppressions, and
 * never sends anything. Staged row data is cleared afterwards.
 */
export async function commitImport(actor: Actor, batchId: string, mode: UpdateMode) {
  const batch = await prisma.importBatch.findUnique({ where: { id: batchId }, include: { rows: { orderBy: { rowNumber: "asc" } } } });
  if (!batch || batch.status !== "REVIEW") throw new ImportError("This import is no longer open.");
  const undecided = batch.rows.filter((r) => !r.decision);
  if (undecided.length) {
    throw new ImportError(`Choose what to do with ${undecided.length} row(s) marked "Needs review" first.`);
  }
  const taxReturnDerived = batch.updateMode.endsWith(";tax");
  const source = `Import: ${batch.source} (${batch.fileName})`;
  const extraServices = batch.batchServices;
  const mapped = new Set(Object.values(batch.mapping as Record<string, string>));
  const wantsCase = extraServices.some((s) => TAX_SERVICES.has(s.toLowerCase())) || mapped.has("returnType") || mapped.has("filingStatus");
  const summary = (batch.summary as unknown as ImportSummary | null) ?? null;

  return prisma.$transaction(
    async (tx) => {
      let created = 0;
      let updated = 0;
      let skipped = 0;
      let unchanged = 0;
      let duplicatesPrevented = 0;
      let casesCreated = 0;
      let casesFilled = 0;
      let returnTypesPrefilled = 0;
      const touched: string[] = [];
      const namesRepaired: string[] = [];
      const groupCache = new Map<string, string>();
      const groupIds = async (names: string[]) => {
        const ids: string[] = [];
        for (const name of names) {
          const key = name.toLowerCase();
          if (!groupCache.has(key)) {
            const g =
              (await tx.group.findFirst({ where: { name: { equals: name, mode: "insensitive" } } })) ??
              (await tx.group.create({ data: { name } }));
            groupCache.set(key, g.id);
          }
          ids.push(groupCache.get(key)!);
        }
        return ids;
      };

      for (const r of batch.rows) {
        const row = r.data as unknown as CleanRow | null;
        if (!row || r.decision === "skip") {
          skipped++;
          continue;
        }
        let clientId: string;
        if (r.decision === "create") {
          // Last check before creating: never create a second record for an
          // email/phone already on file (e.g. added since this import was checked).
          const clash = await tx.client.findFirst({
            where: {
              archivedAt: null,
              OR: [
                ...(row.emailNormalized ? [{ emailNormalized: row.emailNormalized }, { spouseEmail: { equals: row.emailNormalized, mode: "insensitive" as const } }] : []),
                ...(row.phoneNormalized ? [{ phoneNormalized: row.phoneNormalized }, { spousePhoneNormalized: row.phoneNormalized }] : []),
              ],
            },
            select: { id: true },
          });
          // Staff saw (and overrode) the records listed for this row; anything
          // else is a record added since — never create a second file for it.
          if ((row.emailNormalized || row.phoneNormalized) && clash && !r.candidateIds.includes(clash.id)) {
            duplicatesPrevented++;
            skipped++;
            continue;
          }
          const client = await tx.client.create({
            data: {
              firstName: row.firstName,
              middleName: row.middleName ?? null,
              lastName: row.lastName,
              spouseFirstName: row.spouseFirstName ?? null,
              spouseMiddleName: row.spouseMiddleName ?? null,
              spouseLastName: row.spouseLastName ?? null,
              spouseEmail: row.spouseEmail ?? null,
              spousePhone: row.spousePhone ?? null,
              spousePhoneNormalized: normalizePhone(row.spousePhone ?? null),
              businessName: row.businessName,
              displayName: row.displayName,
              email: row.email,
              emailNormalized: row.emailNormalized,
              phone: row.phone,
              phoneNormalized: row.phoneNormalized,
              addressLine1: row.addressLine1,
              addressLine2: row.addressLine2,
              city: row.city,
              state: row.state,
              postalCode: row.postalCode,
              clientType: row.clientType ?? "INDIVIDUAL",
              services: mergeList(row.services, extraServices),
              assignedToId: batch.batchAssignedToId,
              tags: row.tags,
              notes: row.notes,
              taxReturnDerived,
              source,
            },
          });
          clientId = client.id;
          created++;
          await audit(tx, { actorId: actor.id, action: "client.created_by_import", entityType: "Client", entityId: clientId, clientId, details: { batchId } });
        } else {
          clientId = r.decision!.slice(7);
          const current = await tx.client.findUnique({ where: { id: clientId } });
          if (!current) {
            skipped++;
            continue;
          }
          const plan = plannedChanges(current, row, mode, extraServices, { approved: r.approvedFields, assignedToId: batch.batchAssignedToId });
          const data: Prisma.ClientUpdateInput = {};
          const changed: string[] = plan.map((c) => c.field);
          for (const c of plan) {
            if (c.field === "services") data.services = mergeList(current.services, [...row.services, ...extraServices]);
            else if (c.field === "tags") data.tags = mergeList(current.tags, row.tags);
            else if (c.field === "notes") data.notes = current.notes ? `${current.notes}\n\n${row.notes}` : row.notes;
            else if (c.field === "assignedToId") data.assignedTo = { connect: { id: batch.batchAssignedToId! } };
            else (data as Record<string, unknown>)[c.field] = row[c.field as keyof CleanRow];
          }
          if (changed.includes("email")) data.emailNormalized = row.emailNormalized;
          if (changed.includes("phone")) data.phoneNormalized = row.phoneNormalized;
          if (changed.includes("spousePhone")) data.spousePhoneNormalized = normalizePhone(row.spousePhone ?? null);
          if (plan.some((c) => c.kind === "repair")) namesRepaired.push(clientId);
          if (changed.some((f) => ["firstName", "middleName", "lastName", "businessName", "spouseFirstName", "spouseMiddleName", "spouseLastName"].includes(f))) {
            const next = { ...current, ...(data as object) } as typeof current;
            data.displayName = clientDisplayName({ ...next, clientType: next.clientType });
          }
          if (taxReturnDerived && !current.taxReturnDerived) {
            data.taxReturnDerived = true;
            changed.push("taxReturnDerived");
          }
          // Consent records and suppressions are intentionally untouched.
          if (changed.length) {
            await tx.client.update({ where: { id: clientId }, data });
            await audit(tx, { actorId: actor.id, action: "client.updated_by_import", entityType: "Client", entityId: clientId, clientId, details: { batchId, fields: changed } });
            updated++;
          } else unchanged++;
        }
        touched.push(clientId);
        // Tax preparation: one case per client for the tax year — joint
        // spouses stay on this one case, never a second client or return.
        const year = row.taxYear ?? batch.taxYear;
        if (wantsCase && year) {
          const res = await caseFromImport(tx, actor.id, clientId, { taxYear: year, returnType: row.returnType ?? null, otherReturnForm: row.otherReturnForm ?? null, primary: row.primary ?? null, spouse: row.spouse ?? null, spouseEmail: row.spouseEmail ?? null, spousePhone: row.spousePhone ?? null }, batchId);
          if (res.created) casesCreated++;
          else if (res.filled.length) casesFilled++;
          if (res.filled.includes("returnType")) returnTypesPrefilled++;
        }
        if (row.groups.length || batch.batchGroupIds.length) {
          const ids = Array.from(new Set([...(row.groups.length ? await groupIds(row.groups) : []), ...batch.batchGroupIds]));
          await tx.clientGroup.createMany({ data: ids.map((groupId) => ({ clientId, groupId })), skipDuplicates: true });
        }
        await tx.importRow.update({ where: { id: r.id }, data: { resultClientId: clientId } });
      }

      const cases = wantsCase ? await tx.taxPrepCase.findMany({ where: { clientId: { in: touched }, taxYear: batch.taxYear ?? undefined }, select: { clientId: true, returnType: true, returnTypeConfirmedAt: true } }) : [];
      const result: ImportSummary["result"] = {
        created,
        updated,
        skipped,
        unchanged,
        duplicatesPrevented,
        casesCreated,
        casesFilled,
        returnTypesPrefilled,
        needsReturnType: cases.filter((c) => !c.returnType).map((c) => c.clientId),
        needsConfirmation: cases.filter((c) => c.returnType && !c.returnTypeConfirmedAt).map((c) => c.clientId),
        namesRepaired,
      };

      // Keep the decision summary, drop the staged contact data.
      await tx.importRow.updateMany({ where: { batchId }, data: { data: Prisma.DbNull } });
      const done = await tx.importBatch.update({
        where: { id: batchId },
        data: {
          status: "COMMITTED",
          committedAt: new Date(),
          createdCount: created,
          updatedCount: updated,
          skippedCount: skipped,
          updateMode: mode + (taxReturnDerived ? ";tax" : ""),
          ...(summary ? { summary: { ...summary, result } as unknown as Prisma.InputJsonValue } : {}),
        },
      });
      await audit(tx, {
        actorId: actor.id,
        action: "import.committed",
        entityType: "ImportBatch",
        entityId: batchId,
        details: { created, updated, skipped, unchanged, mode, casesCreated, casesFilled, returnTypesPrefilled, services: extraServices, taxYear: batch.taxYear },
      });
      return done;
    },
    { timeout: 120_000 },
  );
}

export async function discardImport(actor: Actor, batchId: string) {
  const batch = await prisma.importBatch.findUnique({ where: { id: batchId } });
  if (!batch || batch.status !== "REVIEW") throw new ImportError("This import is no longer open.");
  await prisma.$transaction([
    prisma.importRow.updateMany({ where: { batchId }, data: { data: Prisma.DbNull } }),
    prisma.importBatch.update({ where: { id: batchId }, data: { status: "DISCARDED" } }),
    prisma.auditLog.create({ data: { actorId: actor.id, action: "import.discarded", entityType: "ImportBatch", entityId: batchId } }),
  ]);
}
