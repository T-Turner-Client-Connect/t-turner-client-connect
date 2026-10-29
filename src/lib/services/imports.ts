import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { IMPORT_FIELD_KEYS, isImportField, isSensitiveHeader, MAX_IMPORT_ROWS } from "@/lib/import/fields";
import { classifyRow, cleanRow, type CleanRow, type MatchCandidate } from "@/lib/import/rows";

export class ImportError extends Error {}

export type StageInput = {
  fileName: string;
  source: string;
  taxReturnDerived: boolean;
  // header -> CRM field (only the columns staff chose to map)
  mapping: Record<string, string>;
  // Rows keyed by CRM field. Built in the browser from mapped columns only.
  rows: Record<string, unknown>[];
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

  const cleaned = input.rows.map((raw) => {
    // Drop anything that isn't both allow-listed and actually mapped.
    const allowed: Record<string, unknown> = {};
    for (const key of IMPORT_FIELD_KEYS) if (mappedFields.has(key) && key in raw) allowed[key] = raw[key];
    return cleanRow(allowed);
  });

  const emails = cleaned.map((c) => c.row.emailNormalized).filter((v): v is string => !!v);
  const phones = cleaned.map((c) => c.row.phoneNormalized).filter((v): v is string => !!v);
  const existing = await prisma.client.findMany({
    where: {
      OR: [
        { emailNormalized: { in: emails } },
        { phoneNormalized: { in: phones } },
        { contacts: { some: { OR: [{ emailNormalized: { in: emails } }, { phoneNormalized: { in: phones } }] } } },
      ],
    },
    select: {
      id: true,
      displayName: true,
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

  const batch = await prisma.$transaction(async (tx) => {
    const created = await tx.importBatch.create({
      data: {
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

type UpdateMode = "fill_blanks" | "overwrite";

const SCALAR_FIELDS = [
  "firstName",
  "lastName",
  "businessName",
  "email",
  "phone",
  "addressLine1",
  "addressLine2",
  "city",
  "state",
  "postalCode",
  "clientType",
] as const;

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

  return prisma.$transaction(
    async (tx) => {
      let created = 0;
      let updated = 0;
      let skipped = 0;
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
          const client = await tx.client.create({
            data: {
              firstName: row.firstName,
              lastName: row.lastName,
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
              services: row.services,
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
          const data: Prisma.ClientUpdateInput = {};
          const changed: string[] = [];
          for (const field of SCALAR_FIELDS) {
            const incoming = row[field];
            if (incoming === null || incoming === undefined) continue;
            const existing = current[field];
            if (mode === "fill_blanks" && existing !== null && existing !== "") continue;
            if (existing === incoming) continue;
            (data as Record<string, unknown>)[field] = incoming;
            changed.push(field);
          }
          if (changed.includes("email")) data.emailNormalized = row.emailNormalized;
          if (changed.includes("phone")) data.phoneNormalized = row.phoneNormalized;
          if (changed.some((f) => ["firstName", "lastName", "businessName"].includes(f))) {
            const next = { ...current, ...(data as object) } as typeof current;
            data.displayName = next.firstName || next.lastName ? [next.firstName, next.lastName].filter(Boolean).join(" ") : next.businessName ?? current.displayName;
          }
          const services = Array.from(new Set([...current.services, ...row.services]));
          const tags = Array.from(new Set([...current.tags, ...row.tags]));
          if (services.length !== current.services.length) {
            data.services = services;
            changed.push("services");
          }
          if (tags.length !== current.tags.length) {
            data.tags = tags;
            changed.push("tags");
          }
          if (row.notes && !current.notes?.includes(row.notes)) {
            data.notes = current.notes ? `${current.notes}\n\n${row.notes}` : row.notes;
            changed.push("notes");
          }
          if (taxReturnDerived && !current.taxReturnDerived) {
            data.taxReturnDerived = true;
            changed.push("taxReturnDerived");
          }
          // Consent records and suppressions are intentionally untouched.
          if (changed.length) {
            await tx.client.update({ where: { id: clientId }, data });
            await audit(tx, { actorId: actor.id, action: "client.updated_by_import", entityType: "Client", entityId: clientId, clientId, details: { batchId, fields: changed } });
          }
          updated++;
        }
        if (row.groups.length) {
          const ids = await groupIds(row.groups);
          await tx.clientGroup.createMany({ data: ids.map((groupId) => ({ clientId, groupId })), skipDuplicates: true });
        }
        await tx.importRow.update({ where: { id: r.id }, data: { resultClientId: clientId } });
      }

      // Keep the decision summary, drop the staged contact data.
      await tx.importRow.updateMany({ where: { batchId }, data: { data: Prisma.DbNull } });
      const done = await tx.importBatch.update({
        where: { id: batchId },
        data: { status: "COMMITTED", committedAt: new Date(), createdCount: created, updatedCount: updated, skippedCount: skipped, updateMode: mode + (taxReturnDerived ? ";tax" : "") },
      });
      await audit(tx, {
        actorId: actor.id,
        action: "import.committed",
        entityType: "ImportBatch",
        entityId: batchId,
        details: { created, updated, skipped, mode },
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
