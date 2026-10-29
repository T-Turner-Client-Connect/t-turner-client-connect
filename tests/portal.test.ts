import { beforeEach, describe, expect, it } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { createClient } from "@/lib/services/clients";
import { acceptPortalInvite, invitePortalUser, updatePortalAccess } from "@/lib/services/portal-accounts";
import { authorizeDownload, deleteDocument, downloadToken, portalDocuments, portalUploadDocument, staffUploadDocument } from "@/lib/services/documents";
import { portalConversations, portalSendMessage, staffSendMessage } from "@/lib/services/messaging";
import { ForbiddenError } from "@/lib/auth/actor";
import { assignmentRef, assignContract, handleJotformWebhook, parseAssignmentRef } from "@/lib/services/contracts";
import { createSignatureRequest, recordOfflineSigned, sendSignatureRequest } from "@/lib/services/signatures";
import { beginEnrollment, confirmEnrollment, verifySecondFactor } from "@/lib/services/mfa";
import { currentTotp } from "@/lib/auth/totp";
import { requireClientAccess } from "@/lib/portal/access";
import { createDocumentRequest } from "@/lib/services/bookkeeping";

beforeEach(resetDb);

const PDF = new TextEncoder().encode("%PDF-1.4\n% fictional test document\n");

async function setup() {
  const staff = await makeUser("ADMIN");
  const bakery = await createClient(staff, { businessName: "Bluebird Bakery LLC", clientType: "BUSINESS", status: "ACTIVE" });
  const cafe = await createClient(staff, { businessName: "Bluebird Cafe LLC", clientType: "BUSINESS", status: "ACTIVE" });
  const other = await createClient(staff, { firstName: "Other", lastName: "Client", clientType: "INDIVIDUAL", status: "ACTIVE" });
  const join = async (clientId: string, email: string, role: "OWNER" | "AUTHORIZED_CONTACT") => {
    const { token } = await invitePortalUser(staff, clientId, { email, name: email.split("@")[0], role });
    const u = await acceptPortalInvite(token!, "Portal-Pass-123");
    return { id: u.id, name: u.name, email: u.email };
  };
  const owner = await join(bakery.id, "priya@example.com", "OWNER");
  // Same owner, second business: access granted to the existing login.
  const second = await invitePortalUser(staff, cafe.id, { email: "priya@example.com", name: "Priya", role: "OWNER" });
  const assistant = await join(bakery.id, "sam@example.com", "AUTHORIZED_CONTACT");
  const stranger = await join(other.id, "other@example.com", "OWNER");
  return { staff, bakery, cafe, other, owner, assistant, stranger, second };
}

describe("portal access control", () => {
  it("multi-business owners see both businesses; others see only their own", async () => {
    const { owner, stranger, bakery, cafe, other, second } = await setup();
    expect(second.grantedExisting).toBe(true);
    await requireClientAccess(owner.id, bakery.id);
    await requireClientAccess(owner.id, cafe.id);
    await expect(requireClientAccess(owner.id, other.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(requireClientAccess(stranger.id, bakery.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("documents: staff-only, other clients, and tax permission are enforced", async () => {
    const { staff, bakery, owner, assistant, stranger } = await setup();
    const published = await staffUploadDocument(staff, { clientId: bakery.id, category: "BOOKKEEPING", visibility: "PUBLISHED", bytes: PDF, originalName: "pl.pdf", year: 2026, month: 9, reportType: "PROFIT_AND_LOSS" });
    const internal = await staffUploadDocument(staff, { clientId: bakery.id, category: "BOOKKEEPING", visibility: "STAFF_ONLY", bytes: PDF, originalName: "workpaper.pdf" });
    const tax = await staffUploadDocument(staff, { clientId: bakery.id, category: "TAXES", visibility: "PUBLISHED", bytes: PDF, originalName: "return.pdf" });

    const ownerDocs = (await portalDocuments(owner, bakery.id)).map((d) => d.id);
    expect(ownerDocs).toContain(published.id);
    expect(ownerDocs).toContain(tax.id);
    expect(ownerDocs).not.toContain(internal.id);

    // Authorized contacts don't get tax documents by default.
    const assistantDocs = (await portalDocuments(assistant, bakery.id)).map((d) => d.id);
    expect(assistantDocs).toContain(published.id);
    expect(assistantDocs).not.toContain(tax.id);

    await expect(portalDocuments(stranger, bakery.id)).rejects.toBeInstanceOf(ForbiddenError);

    // Download links are bound to one viewer and re-check access.
    const t = downloadToken(published.id, { portalUserId: owner.id });
    expect(await authorizeDownload(t, { portalUserId: owner.id })).not.toBeNull();
    expect(await authorizeDownload(t, { portalUserId: stranger.id })).toBeNull();
    expect(await authorizeDownload(downloadToken(internal.id, { portalUserId: owner.id }), { portalUserId: owner.id })).toBeNull();
    expect(await authorizeDownload(downloadToken(tax.id, { portalUserId: assistant.id }), { portalUserId: assistant.id })).toBeNull();
    expect(await authorizeDownload(t.replace(/.$/, (c) => (c === "A" ? "B" : "A")), { portalUserId: owner.id })).toBeNull();
    const expired = downloadToken(published.id, { portalUserId: owner.id }, Date.now() - 20 * 60 * 1000);
    expect(await authorizeDownload(expired, { portalUserId: owner.id })).toBeNull();

    // Revoking access takes effect immediately, even for an issued link.
    const grant = await prisma.portalAccess.findFirstOrThrow({ where: { portalUserId: owner.id, clientId: bakery.id } });
    await updatePortalAccess(staff, grant.id, { revoke: true });
    expect(await authorizeDownload(t, { portalUserId: owner.id })).toBeNull();
  });

  it("uploads go only to accounts the user can access and answer requests", async () => {
    const { staff, bakery, owner, stranger } = await setup();
    const req = await createDocumentRequest(staff, { clientId: bakery.id, title: "September bank statement" });
    const doc = await portalUploadDocument(owner, { clientId: bakery.id, requestId: req.id, bytes: PDF, originalName: "sept.pdf" });
    expect(doc.category).toBe("CLIENT_UPLOADS");
    expect((await prisma.documentRequest.findUniqueOrThrow({ where: { id: req.id } })).status).toBe("SUBMITTED");
    await expect(portalUploadDocument(stranger, { clientId: bakery.id, bytes: PDF, originalName: "x.pdf" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(portalUploadDocument(owner, { clientId: bakery.id, bytes: new TextEncoder().encode("MZ fake exe"), originalName: "virus.pdf" })).rejects.toThrow(/PDF, JPG, or PNG/);
  });

  it("audited deletion destroys the file but keeps the record", async () => {
    const { staff, bakery } = await setup();
    const doc = await staffUploadDocument(staff, { clientId: bakery.id, category: "OTHER", visibility: "STAFF_ONLY", bytes: PDF, originalName: "old.pdf" });
    const daria = await makeUser("STAFF");
    await expect(deleteDocument(daria, doc.id, "duplicate")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(deleteDocument(staff, doc.id, " ")).rejects.toThrow(/why/);
    await deleteDocument(staff, doc.id, "Duplicate upload");
    const after = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
    expect(after.deletedAt).not.toBeNull();
    expect(await prisma.documentAccessLog.count({ where: { documentId: doc.id, action: "DELETE" } })).toBe(1);
  });
});

describe("portal messaging", () => {
  it("delivers portal messages both ways, prevents duplicates, and keeps accounts separate", async () => {
    const { staff, bakery, owner, stranger } = await setup();
    const key = "compose-123";
    const m1 = await staffSendMessage(staff, { clientId: bakery.id, subject: "September close", body: "Your P&L is ready.", channel: "PORTAL", idempotencyKey: key });
    const m2 = await staffSendMessage(staff, { clientId: bakery.id, subject: "September close", body: "Your P&L is ready.", channel: "PORTAL", idempotencyKey: key });
    expect(m2.id).toBe(m1.id);
    expect(await prisma.message.count()).toBe(1);

    const convos = await portalConversations(owner, bakery.id);
    expect(convos).toHaveLength(1);
    await portalSendMessage(owner, { clientId: bakery.id, conversationId: m1.conversationId, body: "Thanks! Quick question about payroll." });
    const convo = await prisma.conversation.findUniqueOrThrow({ where: { id: m1.conversationId } });
    expect(convo.awaitingStaff).toBe(true);
    expect(convo.unreadByStaff).toBe(true);

    await expect(portalConversations(stranger, bakery.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(portalSendMessage(stranger, { clientId: bakery.id, conversationId: m1.conversationId, body: "hi" })).rejects.toBeInstanceOf(ForbiddenError);

    // One notification per channel per message, even if queued twice.
    const notes = await prisma.notification.findMany({ where: { portalUserId: owner.id, kind: "NEW_MESSAGE" } });
    expect(notes).toHaveLength(1);
    expect(notes[0].status).toBe("PENDING");
  });

  it("email and text are unavailable until configured", async () => {
    const { staff, bakery } = await setup();
    await expect(staffSendMessage(staff, { clientId: bakery.id, body: "hi", channel: "EMAIL" })).rejects.toThrow(/Setup required|turned off/);
    await expect(staffSendMessage(staff, { clientId: bakery.id, body: "hi", channel: "SMS" })).rejects.toThrow(/Setup required|next stage/);
  });
});

describe("contracts and signatures", () => {
  it("contract references can't be forged and links never mark completion", async () => {
    const { staff, bakery } = await setup();
    const a = await assignContract(staff, { clientId: bakery.id, title: "Bookkeeping engagement letter", jotformFormId: "241234567890" });
    expect(parseAssignmentRef(assignmentRef(a.id))).toBe(a.id);
    expect(parseAssignmentRef(`${a.id}.AAAAAAAAAAAAAAAAAAAAAA`)).toBeNull();
    expect((await handleJotformWebhook("anything", "123")).status).toBe(503);
    expect((await prisma.contractAssignment.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("ASSIGNED");
  });

  it("tax signatures are setup-required; offline copies are labeled as such", async () => {
    const { staff, bakery } = await setup();
    const pkg = await staffUploadDocument(staff, { clientId: bakery.id, category: "TAXES", visibility: "STAFF_ONLY", bytes: PDF, originalName: "8879.pdf" });
    const req = await createSignatureRequest(staff, { clientId: bakery.id, title: "2025 Form 8879", taxYear: 2025, packageDocumentId: pkg.id, signers: [{ name: "Priya", role: "TAXPAYER" }] });
    await expect(sendSignatureRequest(staff, req.id)).rejects.toThrow(/not set up/);
    await recordOfflineSigned(staff, req.id, { bytes: PDF, originalName: "signed.pdf" }, false);
    const done = await prisma.signatureRequest.findUniqueOrThrow({ where: { id: req.id }, include: { signedDocument: true } });
    expect(done.status).toBe("SIGNED_OFFLINE_UPLOADED");
    expect(done.signedDocument?.title).toMatch(/signed outside the app/);
  });
});

describe("two-step verification", () => {
  it("enrolls with a TOTP code, stores the secret encrypted, and recovery codes work once", async () => {
    const { owner } = await setup();
    const subject = { kind: "portal" as const, id: owner.id };
    const { secret } = await beginEnrollment(subject);
    const row = await prisma.portalUser.findUniqueOrThrow({ where: { id: owner.id } });
    expect(row.mfaSecretEnc).not.toContain(secret);
    await expect(confirmEnrollment(subject, "000000")).rejects.toThrow(/didn't match/);
    const codes = await confirmEnrollment(subject, currentTotp(secret));
    expect(codes).toHaveLength(10);
    // The code that finished setup can't be replayed to sign in.
    expect(await verifySecondFactor(subject, currentTotp(secret))).toBe(false);
    expect(await verifySecondFactor(subject, "123456")).toBe(false);
    expect(await verifySecondFactor(subject, codes[0])).toBe(true);
    expect(await verifySecondFactor(subject, codes[0])).toBe(false);
  });
});
