import "server-only";
import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";

/**
 * Every stored file the app keeps, in one list: client documents (all categories), files not yet
 * filed to a client (tax-return intake), sign-up uploads held before an account exists, flyers and
 * consent evidence, and the owner's receipts. The encryption job, the nightly backup and the
 * storage report all read this list, so nothing is left out of any of them.
 *
 * Records that exist ONLY in Client Connect come first (Tabitha's rule): bank statements,
 * nonprofit documents, bookkeeping records, payroll registers and correspondence attachments.
 * Tax returns, identity documents and similar records usually have another copy (TaxAct, the
 * client), so they follow.
 */
export const FILE_GROUPS = [
  "BANK_STATEMENTS",
  "NONPROFIT",
  "BOOKKEEPING",
  "PAYROLL",
  "CORRESPONDENCE",
  "TAX",
  "IDENTITY",
  "CONTRACTS",
  "CLIENT_UPLOADS",
  "OTHER_DOCUMENTS",
  "UNFILED",
  "SIGNUP_UPLOADS",
  "OFFICE_FILES",
  "OWNER_RECEIPTS",
] as const;
export type FileGroup = (typeof FILE_GROUPS)[number];

/** The five groups whose only copy is in Client Connect. */
export const ONLY_IN_CLIENT_CONNECT: FileGroup[] = ["BANK_STATEMENTS", "NONPROFIT", "BOOKKEEPING", "PAYROLL", "CORRESPONDENCE"];

export const GROUP_LABEL: Record<FileGroup, string> = {
  BANK_STATEMENTS: "Bank & card statements",
  NONPROFIT: "Nonprofit documents",
  BOOKKEEPING: "Bookkeeping records",
  PAYROLL: "Payroll registers & files",
  CORRESPONDENCE: "Correspondence attachments",
  TAX: "Tax documents & returns",
  IDENTITY: "Identity documents",
  CONTRACTS: "Contracts & signed agreements",
  CLIENT_UPLOADS: "Client uploads",
  OTHER_DOCUMENTS: "Other client documents",
  UNFILED: "Waiting to be filed (return intake)",
  SIGNUP_UPLOADS: "Sign-up uploads (before an account)",
  OFFICE_FILES: "Flyers & consent evidence",
  OWNER_RECEIPTS: "Owner's receipts",
};

export type SourceType = "StoredFile" | "OnboardingFile" | "Expense";

export type InventoryItem = {
  sourceType: SourceType;
  sourceId: string;
  storageKey: string;
  group: FileGroup;
  encrypted: boolean;
  keyVersion: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  documentId: string | null;
  // A deleted document still waiting in "Recently deleted" (its bytes are kept and backed up).
  deleted: boolean;
};

type DocShape = { category: string; docType: string | null; filingDocType: string | null; _count: { messages: number } };

export function groupForDocument(d: DocShape): FileGroup {
  if (d.docType === "BANK_STATEMENT" || d.docType === "CARD_STATEMENT") return "BANK_STATEMENTS";
  if (d.docType === "NONPROFIT_ITEM") return "NONPROFIT";
  if (d.category === "PAYROLL" || d.docType === "PAYROLL_REPORT") return "PAYROLL";
  if (d.category === "BOOKKEEPING") return "BOOKKEEPING";
  if (d._count.messages > 0 || d.filingDocType === "CORRESPONDENCE" || d.filingDocType === "AGENCY_NOTICE") return "CORRESPONDENCE";
  if (d.category === "TAXES" || d.category === "OWNER_K1") return "TAX";
  if (d.category === "IDENTITY") return "IDENTITY";
  if (d.category === "CONTRACTS") return "CONTRACTS";
  if (d.category === "CLIENT_UPLOADS") return "CLIENT_UPLOADS";
  return "OTHER_DOCUMENTS";
}

/** Normalizes an owner-chosen order: any group left out keeps its default place after the chosen ones. */
export function normalizeGroupOrder(order?: string[] | null): FileGroup[] {
  const chosen = (order ?? []).filter((g): g is FileGroup => (FILE_GROUPS as readonly string[]).includes(g));
  const seen = new Set(chosen);
  return [...chosen.filter((g, i) => chosen.indexOf(g) === i), ...FILE_GROUPS.filter((g) => !seen.has(g))];
}

export function sortByGroup<T extends { group: FileGroup; storageKey: string }>(items: T[], order: FileGroup[] = [...FILE_GROUPS]): T[] {
  const rank = new Map(order.map((g, i) => [g, i]));
  return [...items].sort((a, b) => (rank.get(a.group)! - rank.get(b.group)!) || (a.storageKey < b.storageKey ? -1 : a.storageKey > b.storageKey ? 1 : 0));
}

/** Every live stored file. Purged documents (bytes already removed) are left out. */
export async function fileInventory(db: PrismaClient = defaultPrisma): Promise<InventoryItem[]> {
  const out: InventoryItem[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await db.storedFile.findMany({
      take: 2000,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: "asc" },
      select: {
        id: true, kind: true, storageKey: true, encrypted: true, keyVersion: true, sizeBytes: true, sha256: true,
        document: { select: { id: true, category: true, docType: true, filingDocType: true, deletedAt: true, purgedAt: true, _count: { select: { messages: true } } } },
      },
    });
    if (!page.length) break;
    cursor = page[page.length - 1].id;
    for (const f of page) {
      if (f.document?.purgedAt) continue;
      const group: FileGroup = f.document ? groupForDocument(f.document) : f.kind === "CLIENT_DOCUMENT" ? "UNFILED" : "OFFICE_FILES";
      out.push({ sourceType: "StoredFile", sourceId: f.id, storageKey: f.storageKey, group, encrypted: f.encrypted, keyVersion: f.keyVersion, sizeBytes: f.sizeBytes, sha256: f.sha256, documentId: f.document?.id ?? null, deleted: !!f.document?.deletedAt });
    }
  }
  // Sign-up uploads not yet moved into a client's documents (once moved, the StoredFile row owns the key).
  const held = await db.onboardingFile.findMany({ where: { movedDocumentId: null }, select: { id: true, storageKey: true, sizeBytes: true, encrypted: true } });
  const owned = new Set(out.map((o) => o.storageKey));
  for (const f of held) {
    if (owned.has(f.storageKey)) continue;
    out.push({ sourceType: "OnboardingFile", sourceId: f.id, storageKey: f.storageKey, group: "SIGNUP_UPLOADS", encrypted: !!f.encrypted, keyVersion: null, sizeBytes: f.sizeBytes, sha256: null, documentId: null, deleted: false });
  }
  const receipts = await db.expense.findMany({ where: { receiptKey: { not: null } }, select: { id: true, receiptKey: true, receiptEncrypted: true } });
  for (const e of receipts) {
    out.push({ sourceType: "Expense", sourceId: e.id, storageKey: e.receiptKey!, group: "OWNER_RECEIPTS", encrypted: !!e.receiptEncrypted, keyVersion: null, sizeBytes: null, sha256: null, documentId: null, deleted: false });
  }
  return out;
}

export type GroupTotals = { group: FileGroup; label: string; files: number; bytes: number; unknownSize: number };

export function totalsByGroup(items: InventoryItem[]): GroupTotals[] {
  return FILE_GROUPS.map((g) => {
    const these = items.filter((i) => i.group === g);
    return { group: g, label: GROUP_LABEL[g], files: these.length, bytes: these.reduce((n, i) => n + (i.sizeBytes ?? 0), 0), unknownSize: these.filter((i) => i.sizeBytes == null).length };
  }).filter((t) => t.files > 0);
}
