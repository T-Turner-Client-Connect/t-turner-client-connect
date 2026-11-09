/**
 * Restore drill: fills a LOCAL, empty database with fictional clients and documents in every
 * category — some stored the old way (plaintext, as production holds them before the encryption
 * job), some new (encrypted on upload). Refuses anything but a local database.
 *
 *   DATABASE_URL=postgresql://…@localhost:5432/crm_drill npm run drill:seed
 *
 * Then follow docs/backup-restore.md → "Restore drill".
 */
import { createHash, randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { storage } from "@/lib/storage";
import { isProductionDatabaseUrl } from "@/lib/backup/restore";
import { createClient } from "@/lib/services/clients";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { deleteDocument, portalUploadDocument, staffUploadDocument } from "@/lib/services/documents";
import { ensureClientPerson, uploadIdentityDocument } from "@/lib/services/identity";

const pdf = (tag: string) => new TextEncoder().encode(`%PDF-1.4\n% fictional drill document: ${tag} ${randomUUID()}\n`);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

async function legacy(clientId: string, actorId: string, category: "TAXES" | "BOOKKEEPING" | "PAYROLL" | "OTHER", docType: string | null, title: string) {
  const bytes = pdf(title);
  const storageKey = `client_document/${randomUUID()}`;
  await storage.put(storageKey, bytes); // the pre-encryption way, on purpose (a drill of the migration)
  const file = await prisma.storedFile.create({ data: { kind: "CLIENT_DOCUMENT", storageKey, originalName: `${title}.pdf`, title, mimeType: "application/pdf", sizeBytes: bytes.length, sha256: sha(bytes), uploadedById: actorId } });
  const doc = await prisma.document.create({ data: { clientId, category, docType, year: 2026, title, visibility: "STAFF_ONLY", fileId: file.id, scanStatus: "CLEAN", uploadedByStaffId: actorId } });
  await prisma.documentAccessLog.create({ data: { documentId: doc.id, action: "UPLOAD", staffUserId: actorId } });
  await prisma.auditLog.create({ data: { actorId, action: "document.uploaded", entityType: "Document", entityId: doc.id, clientId } });
}

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  if (!url || process.env.NETLIFY || isProductionDatabaseUrl(url)) throw new Error("drill-seed runs only against a local database.");
  if (await prisma.user.count()) throw new Error("This database already has users: use an empty, freshly migrated drill database.");
  const u = await prisma.user.create({ data: { email: "tabitha@drill.example", name: "Tabitha (drill)", role: "ADMIN", passwordHash: "x" } });
  await prisma.ownerAccess.create({ data: { userId: u.id, isPrimary: true } });
  const tab = { id: u.id, role: u.role, name: u.name, email: u.email };
  const biz = await createClient(tab, { businessName: "Pretend Lantern Works LLC (drill)", clientType: "BUSINESS", status: "ACTIVE" });
  const np = await createClient(tab, { businessName: "Pretend Food Pantry (drill nonprofit)", clientType: "BUSINESS", status: "ACTIVE" });
  for (const [cat, type, title] of [["BOOKKEEPING", "BANK_STATEMENT", "October bank statement"], ["BOOKKEEPING", null, "October reconciliation workpapers"], ["PAYROLL", null, "October payroll register"], ["TAXES", "FEDERAL_RETURN", "2025 federal return"]] as const) await legacy(biz.id, u.id, cat, type, title);
  await legacy(np.id, u.id, "OTHER", "NONPROFIT_ITEM", "Board minutes");
  const { token } = await invitePortalUser(tab, biz.id, { email: "owner@lantern.drill.example", name: "Pat Pretend", role: "OWNER" });
  const pu = await acceptPortalInvite(token!, "Drill-Pass-12345");
  const portal = { id: pu.id, name: pu.name, email: pu.email };
  const me = await ensureClientPerson(biz.id);
  await uploadIdentityDocument({ portal }, { clientId: biz.id, personId: me.id, type: "SOCIAL_SECURITY_CARD", bytes: pdf("ss card"), originalName: "ss.pdf" });
  await portalUploadDocument(portal, { clientId: biz.id, year: 2025, bytes: pdf("1099"), originalName: "1099.pdf" });
  const letter = await staffUploadDocument(tab, { clientId: biz.id, category: "TAXES", visibility: "PUBLISHED", year: 2025, bytes: pdf("IRS letter"), originalName: "irs-letter.pdf" });
  const convo = await prisma.conversation.create({ data: { clientId: biz.id, subject: "IRS letter" } });
  await prisma.message.create({ data: { conversationId: convo.id, channel: "PORTAL", direction: "OUTBOUND", body: "Attached.", status: "DELIVERED", staffAuthorId: u.id, attachments: { connect: { id: letter.id } } } });
  const dup = await staffUploadDocument(tab, { clientId: biz.id, category: "OTHER", visibility: "STAFF_ONLY", bytes: pdf("duplicate"), originalName: "dup.pdf" });
  await deleteDocument(tab, dup.id, "Duplicate (drill)");
  const docs = await prisma.document.count();
  const plain = await prisma.storedFile.count({ where: { encrypted: false } });
  process.stdout.write(`Seeded ${docs} fictional documents (${plain} stored the old, plaintext way) for 2 clients.\n`);
}

main().then(
  () => process.exit(0),
  (err) => {
    process.stderr.write(`✖ ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
