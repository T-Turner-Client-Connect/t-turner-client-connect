import "server-only";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import type { Actor } from "@/lib/auth/actor";
import { ValidationError } from "./clients";
import { staffUploadDocument } from "./documents";

/**
 * Tax e-signatures require a provider verified for the exact forms (e.g.
 * Form 8879 / 8878), the IRS identity-verification requirements, joint-return
 * signers, and record retention. Until SIGNING_PROVIDER is set AND an Admin
 * confirms that review with SIGNING_PROVIDER_VERIFIED_FOR_TAX=true, the
 * feature is "Setup required" and only offline-signed uploads are possible.
 */
export function signingProviderStatus() {
  const provider = process.env.SIGNING_PROVIDER || null;
  const verified = process.env.SIGNING_PROVIDER_VERIFIED_FOR_TAX === "true";
  return { provider, ready: false as boolean, label: provider && verified ? `Provider "${provider}" configured — adapter pending` : "Setup required" };
}

export async function createSignatureRequest(
  actor: Actor,
  input: { clientId: string; title: string; taxYear?: number | null; packageDocumentId: string; signers: { name: string; email?: string; role: string }[] },
) {
  if (!input.title.trim()) throw new ValidationError("Name this signature request.");
  const pkg = await prisma.document.findFirst({ where: { id: input.packageDocumentId, clientId: input.clientId, deletedAt: null } });
  if (!pkg) throw new ValidationError("Choose the tax package from this client's documents.");
  const signers = input.signers.filter((s) => s.name.trim());
  if (!signers.length) throw new ValidationError("Add at least one signer.");
  const req = await prisma.signatureRequest.create({
    data: {
      clientId: input.clientId,
      title: input.title.trim().slice(0, 200),
      taxYear: input.taxYear ?? null,
      packageDocumentId: pkg.id,
      createdById: actor.id,
      signers: { create: signers.map((s, i) => ({ name: s.name.trim(), email: s.email?.trim() || null, role: s.role, order: i + 1 })) },
    },
  });
  await audit(prisma, { actorId: actor.id, action: "signature.created", entityType: "SignatureRequest", entityId: req.id, clientId: input.clientId, details: { signers: signers.length } });
  return req;
}

export async function sendSignatureRequest(_actor: Actor, _requestId: string): Promise<never> {
  throw new ValidationError(
    "E-signature sending is not set up. A signing provider must be connected and verified for tax forms (identity verification, joint signers, record keeping) first. Until then, use “Record signed copy” for documents signed outside the app.",
  );
}

/** Staff uploads a copy signed outside the app (wet ink or another system). */
export async function recordOfflineSigned(actor: Actor, requestId: string, file: { bytes: Uint8Array; originalName: string }, publish: boolean) {
  const req = await prisma.signatureRequest.findUnique({ where: { id: requestId } });
  if (!req) throw new ValidationError("Signature request not found.");
  if (req.status === "COMPLETED" || req.status === "SIGNED_OFFLINE_UPLOADED") throw new ValidationError("A signed copy is already on file.");
  const doc = await staffUploadDocument(actor, {
    clientId: req.clientId,
    category: "TAXES",
    title: `${req.title} — signed copy (signed outside the app)`,
    year: req.taxYear,
    visibility: publish ? "PUBLISHED" : "STAFF_ONLY",
    bytes: file.bytes,
    originalName: file.originalName,
  });
  await prisma.signatureRequest.update({ where: { id: requestId }, data: { status: "SIGNED_OFFLINE_UPLOADED", signedDocumentId: doc.id, completedAt: new Date() } });
  await audit(prisma, { actorId: actor.id, action: "signature.offline_copy_recorded", entityType: "SignatureRequest", entityId: requestId, clientId: req.clientId });
}

export const SIGNATURE_LABELS: Record<string, string> = {
  DRAFT: "Draft",
  SENT: "Sent",
  VIEWED: "Viewed",
  PARTIALLY_SIGNED: "Partially signed",
  COMPLETED: "Completed (e-signed)",
  DECLINED: "Declined",
  EXPIRED: "Expired",
  SIGNED_OFFLINE_UPLOADED: "Signed outside the app — copy uploaded",
};
