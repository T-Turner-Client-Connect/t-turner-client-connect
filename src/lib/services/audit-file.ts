import "server-only";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { DocumentCategory } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { BK_PORTAL_COETHA_V1, type LetterBlock } from "@/lib/client-letters/templates";
import { ValidationError } from "./clients";
import { assertLedger } from "./ledger";
import { registryLabel } from "./bank-accounts";
import { readDocumentBytes } from "./documents";

/**
 * Audit File: every document on file for one business, organized by year, month, category and
 * account, with the client's written explanations to Ask Client requests. Staff who can open the
 * business's books can view it and export it as one PDF (letterhead cover, index, then each
 * document). Each export is written to the audit log and each included document's access log.
 *
 * Personal and identity documents (IDENTITY, OWNER_K1, OWNER_PERSONAL) are never in the Audit
 * File, and a file that hasn't scanned clean is listed in the index but not included.
 */

const EXCLUDED: DocumentCategory[] = ["IDENTITY", "OWNER_K1", "OWNER_PERSONAL"];
export const AUDIT_CATEGORY_LABEL: Partial<Record<DocumentCategory, string>> = {
  BOOKKEEPING: "Bookkeeping",
  CLIENT_UPLOADS: "Client uploads",
  PAYROLL: "Payroll",
  TAXES: "Taxes",
  CONTRACTS: "Contracts",
  OTHER: "Other",
};
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MAX_EXPORT_DOCS = 200;
const MAX_EXPORT_BYTES = 150 * 1024 * 1024;

export type AuditFilter = { year?: number | null; month?: number | null; category?: string | null; accountId?: string | null };

export function parseAuditFilter(p: Record<string, string | undefined>): AuditFilter {
  const n = (v: string | undefined, lo: number, hi: number) => {
    const x = Number(v);
    return v && Number.isInteger(x) && x >= lo && x <= hi ? x : null;
  };
  return {
    year: n(p.year, 2000, 2100),
    month: n(p.month, 1, 12),
    category: p.category && p.category in AUDIT_CATEGORY_LABEL ? p.category : null,
    accountId: p.account || null,
  };
}

/** The document's year and month: what it was filed for, else its period, else when it was received. */
function placeOf(d: { year: number | null; month: number | null; periodEnd: Date | null; createdAt: Date }) {
  const year = d.year ?? d.periodEnd?.getUTCFullYear() ?? d.createdAt.getUTCFullYear();
  const month = d.month ?? (d.periodEnd ? d.periodEnd.getUTCMonth() + 1 : d.year ? null : d.createdAt.getUTCMonth() + 1);
  return { year, month };
}

export async function auditFileView(actor: Actor, clientId: string, filter: AuditFilter) {
  await assertLedger(actor, clientId);
  const docs = await prisma.document.findMany({
    where: { clientId, deletedAt: null, category: { notIn: EXCLUDED }, ...(filter.category ? { category: filter.category as DocumentCategory } : {}), ...(filter.accountId ? { bookkeepingAccountId: filter.accountId } : {}) },
    orderBy: { createdAt: "asc" },
    take: 3000,
    select: {
      id: true, title: true, category: true, docType: true, year: true, month: true, periodStart: true, periodEnd: true, createdAt: true, scanStatus: true,
      uploadedByPortalId: true, uploadedByPortal: { select: { name: true } }, uploadedByStaff: { select: { name: true } },
      bookkeepingAccount: { select: { id: true, institution: true, nickname: true, last4: true, accountType: true } },
      request: { select: { id: true, title: true } },
      file: { select: { mimeType: true, originalName: true, sizeBytes: true } },
    },
  });
  const rows = docs
    .map((d) => ({ ...d, ...placeOf(d), account: d.bookkeepingAccount ? registryLabel(d.bookkeepingAccount) : null, from: d.uploadedByPortalId ? `Client (${d.uploadedByPortal?.name ?? "portal"})` : d.uploadedByStaff ? `Office (${d.uploadedByStaff.name})` : "Office" }))
    .filter((d) => (!filter.year || d.year === filter.year) && (!filter.month || d.month === filter.month))
    .sort((a, b) => a.year - b.year || (a.month ?? 13) - (b.month ?? 13) || a.category.localeCompare(b.category) || (a.account ?? "").localeCompare(b.account ?? "") || a.createdAt.getTime() - b.createdAt.getTime());

  const explanations = (
    await prisma.documentRequest.findMany({
      where: { clientId, clientExplanation: { not: null }, ...(filter.accountId ? { bookkeepingAccountId: filter.accountId } : {}) },
      orderBy: { explainedAt: "asc" },
      select: { id: true, title: true, reason: true, clientExplanation: true, explainedAt: true },
    })
  )
    .map((e) => ({ ...e, year: e.explainedAt!.getUTCFullYear(), month: e.explainedAt!.getUTCMonth() + 1 }))
    .filter((e) => !filter.category && (!filter.year || e.year === filter.year) && (!filter.month || e.month === filter.month));

  const [years, accounts, trail] = await Promise.all([
    prisma.document.findMany({ where: { clientId, deletedAt: null, category: { notIn: EXCLUDED } }, select: { year: true, periodEnd: true, createdAt: true, month: true } }),
    prisma.bookkeepingAccount.findMany({ where: { clientId }, select: { id: true, institution: true, nickname: true, last4: true, accountType: true } }),
    prisma.auditLog.findMany({ where: { clientId, action: { in: ["audit_file.exported", "ask_client.letter_prepared", "request.client_explained", "ask_client.edited", "ask_client.withdrawn", "request.sent", "coetha.client_response_queued"] } }, orderBy: { createdAt: "desc" }, take: 30, select: { id: true, action: true, createdAt: true, actor: { select: { name: true } }, details: true } }),
  ]);
  return {
    rows,
    explanations,
    years: [...new Set(years.map((d) => placeOf(d).year))].sort((a, b) => b - a),
    accounts: accounts.map((a) => ({ id: a.id, label: registryLabel(a) })),
    trail,
  };
}

export const describeFilter = (f: AuditFilter, accountLabel?: string | null) =>
  [f.year ? String(f.year) : "All years", f.month ? MONTHS[f.month - 1] : null, f.category ? AUDIT_CATEGORY_LABEL[f.category as DocumentCategory] : null, accountLabel ?? null].filter(Boolean).join(" · ");

/** One PDF: letterhead cover with the index (and the client's explanations), then each document. */
export async function buildAuditFilePdf(actor: Actor, clientId: string, filter: AuditFilter) {
  const view = await auditFileView(actor, clientId, filter);
  if (!view.rows.length && !view.explanations.length) throw new ValidationError("Nothing on file matches these filters.");
  const client = await prisma.client.findUniqueOrThrow({ where: { id: clientId }, select: { businessName: true, displayName: true } });
  const business = (client.businessName || client.displayName).trim();
  const accountLabel = filter.accountId ? view.accounts.find((a) => a.id === filter.accountId)?.label ?? null : null;

  // Choose what goes in: clean files only, within the size and count limits.
  let total = 0;
  const included: typeof view.rows = [];
  const left: { title: string; why: string }[] = [];
  for (const d of view.rows) {
    if (d.scanStatus !== "CLEAN") left.push({ title: d.title, why: "not included until its virus scan is clean" });
    else if (included.length >= MAX_EXPORT_DOCS || total + (d.file?.sizeBytes ?? 0) > MAX_EXPORT_BYTES) left.push({ title: d.title, why: "not included (export limit reached; narrow the filters)" });
    else {
      included.push(d);
      total += d.file?.sizeBytes ?? 0;
    }
  }

  const when = (d: { year: number; month: number | null }) => `${d.month ? `${MONTHS[d.month - 1]} ` : ""}${d.year}`;
  const blocks: LetterBlock[] = [
    { lead: "Contents.", text: `${included.length} document${included.length === 1 ? "" : "s"}${view.explanations.length ? ` and ${view.explanations.length} written explanation${view.explanations.length === 1 ? "" : "s"} from the client` : ""}. Filters: ${describeFilter(filter, accountLabel)}. Prepared ${new Date().toLocaleString("en-US", { timeZone: "America/Chicago", dateStyle: "long", timeStyle: "short" })} (Central) by ${actor.name}.` },
  ];
  if (included.length) blocks.push({ lead: "Index", bullets: included.map((d, i) => `Item ${i + 1}: ${d.title} · ${when(d)} · ${AUDIT_CATEGORY_LABEL[d.category] ?? d.category}${d.account ? ` · ${d.account}` : ""} · received ${d.createdAt.toISOString().slice(0, 10)} from ${d.from}${d.request ? ` · answers "${d.request.title}"` : ""}`) });
  if (left.length) blocks.push({ lead: "Listed but not included", bullets: left.map((l) => `${l.title}: ${l.why}`) });
  for (const e of view.explanations) {
    blocks.push({ lead: `Client explanation: ${e.title} (${e.explainedAt!.toISOString().slice(0, 10)}).`, text: `${e.reason ? `Asked because: ${e.reason} ` : ""}The client wrote: “${e.clientExplanation}”` });
  }
  if (view.explanations.length) blocks.push({ text: "Client explanations are kept word for word as supporting evidence. They are not, by themselves, authorization for any accounting entry." });

  const { buildLetterPdf } = await import("@/lib/client-letters/pdf");
  const coverBytes = await buildLetterPdf(
    {
      version: "audit-file-2026-11-v1", documentTitle: "Audit File", label: "Audit File", letterhead: BK_PORTAL_COETHA_V1.letterhead,
      reLine: `Audit File: ${business}`, blocks, closing: "Prepared from the records on file in TTurner Client Connect.", signature: "T. Turner & Associates, LLC", email: { subject: "", heading: "" },
    },
    { date: new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/Chicago" }), businessName: business, ownerName: "Audit File", ownerFirstName: "Reviewer" },
  );
  const out = await PDFDocument.load(coverBytes);
  out.setTitle(`Audit File — ${business}`.replace(/[^\x20-\x7E]/g, "-"));
  const font = await out.embedFont(StandardFonts.Helvetica);
  const stamp = (page: ReturnType<typeof out.addPage>, text: string) => {
    const t = text.replace(/[^\x20-\x7E]/g, "?").slice(0, 110);
    page.drawRectangle({ x: 0, y: 0, width: page.getWidth(), height: 16, color: rgb(1, 1, 1), opacity: 0.85 });
    page.drawText(t, { x: 18, y: 5, size: 7, font, color: rgb(0.25, 0.27, 0.32) });
  };
  const placeholder = (title: string, why: string) => {
    const p = out.addPage([612, 792]);
    p.drawText(title.replace(/[^\x20-\x7E]/g, "?").slice(0, 80), { x: 72, y: 700, size: 13, font, color: rgb(0.04, 0.1, 0.27) });
    p.drawText(why, { x: 72, y: 680, size: 10, font, color: rgb(0.3, 0.3, 0.35) });
    return p;
  };

  for (const [i, d] of included.entries()) {
    const label = `Audit File · Item ${i + 1} of ${included.length} · ${d.title}`;
    const full = await prisma.document.findUnique({ where: { id: d.id }, select: { file: { select: { storageKey: true, encrypted: true, mimeType: true } } } });
    const bytes = full?.file ? await readDocumentBytes(full.file) : null;
    try {
      if (!bytes || !full?.file) throw new Error("missing");
      if (full.file.mimeType === "application/pdf") {
        const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
        for (const p of await out.copyPages(src, src.getPageIndices())) stamp(out.addPage(p), label);
      } else if (full.file.mimeType === "image/png" || full.file.mimeType === "image/jpeg") {
        const img = full.file.mimeType === "image/png" ? await out.embedPng(bytes) : await out.embedJpg(bytes);
        const p = out.addPage([612, 792]);
        const s = Math.min((612 - 72) / img.width, (792 - 96) / img.height, 1);
        p.drawImage(img, { x: (612 - img.width * s) / 2, y: (792 - img.height * s) / 2 + 8, width: img.width * s, height: img.height * s });
        stamp(p, label);
      } else {
        stamp(placeholder(d.title, `This file (${d.file?.originalName ?? "file"}) can't be printed here. Open it from the Audit File page.`), label);
      }
    } catch {
      stamp(placeholder(d.title, "This file couldn't be added to the PDF. Open it from the Audit File page."), label);
    }
  }

  const pdf = await out.save();
  await audit(prisma, { actorId: actor.id, action: "audit_file.exported", entityType: "Client", entityId: clientId, clientId, details: { filter, documentIds: included.map((d) => d.id), explanations: view.explanations.map((e) => e.id), notIncluded: left.length } });
  if (included.length) await prisma.documentAccessLog.createMany({ data: included.map((d) => ({ documentId: d.id, action: "DOWNLOAD", staffUserId: actor.id })) });
  const name = `Audit File - ${business} - ${describeFilter(filter, accountLabel)}.pdf`.replace(/[^\w.\- ()&]/g, "_");
  return { bytes: pdf, fileName: name };
}
