import "server-only";
import { createHash } from "node:crypto";
import QRCode from "qrcode";
import { prisma } from "@/lib/prisma";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { newRecoveryCodes, newTotpSecret, otpauthUri, verifyTotp } from "@/lib/auth/totp";
import { assertAdmin, type Actor } from "@/lib/auth/actor";
import { ValidationError } from "./clients";

export type MfaSubject = { kind: "staff" | "portal"; id: string };

const hashCode = (code: string) => createHash("sha256").update(code.replace(/[\s-]/g, "").toUpperCase()).digest("hex");

async function load(subject: MfaSubject) {
  return subject.kind === "staff"
    ? prisma.user.findUnique({ where: { id: subject.id }, select: { email: true, mfaSecretEnc: true, mfaEnabledAt: true } })
    : prisma.portalUser.findUnique({ where: { id: subject.id }, select: { email: true, mfaSecretEnc: true, mfaEnabledAt: true } });
}

async function save(subject: MfaSubject, data: { mfaSecretEnc?: string | null; mfaEnabledAt?: Date | null }) {
  if (subject.kind === "staff") await prisma.user.update({ where: { id: subject.id }, data });
  else await prisma.portalUser.update({ where: { id: subject.id }, data });
}

/** Creates (or re-shows) a pending authenticator secret and its QR code. */
export async function beginEnrollment(subject: MfaSubject) {
  const row = await load(subject);
  if (!row) throw new ValidationError("Account not found.");
  if (row.mfaEnabledAt) throw new ValidationError("Two-step verification is already set up.");
  let secret = row.mfaSecretEnc ? decryptSecret(row.mfaSecretEnc) : null;
  if (!secret) {
    secret = newTotpSecret();
    await save(subject, { mfaSecretEnc: encryptSecret(secret) });
  }
  const uri = otpauthUri(secret, row.email);
  const qrSvg = await QRCode.toString(uri, { type: "svg", margin: 1, color: { dark: "#001452", light: "#ffffff" } });
  return { secret, qrSvg };
}

/** Confirms the first code and returns one-time recovery codes (shown once). */
export async function confirmEnrollment(subject: MfaSubject, code: string): Promise<string[]> {
  const row = await load(subject);
  if (!row?.mfaSecretEnc || row.mfaEnabledAt) throw new ValidationError("Start setup again.");
  if (!verifyTotp(decryptSecret(row.mfaSecretEnc), code)) throw new ValidationError("That code didn't match. Check the time on your phone and try the newest code.");
  const codes = newRecoveryCodes();
  const owner = subject.kind === "staff" ? { userId: subject.id } : { portalUserId: subject.id };
  await prisma.$transaction([
    prisma.mfaRecoveryCode.deleteMany({ where: owner }),
    prisma.mfaRecoveryCode.createMany({ data: codes.map((c) => ({ ...owner, codeHash: hashCode(c) })) }),
  ]);
  await save(subject, { mfaEnabledAt: new Date() });
  await prisma.auditLog.create({
    data: { actorId: subject.kind === "staff" ? subject.id : null, action: "mfa.enrolled", entityType: subject.kind === "staff" ? "User" : "PortalUser", entityId: subject.id },
  });
  return codes;
}

/** Checks an authenticator code or an unused recovery code. */
export async function verifySecondFactor(subject: MfaSubject, code: string): Promise<boolean> {
  const row = await load(subject);
  if (!row?.mfaSecretEnc || !row.mfaEnabledAt) return false;
  if (verifyTotp(decryptSecret(row.mfaSecretEnc), code)) return true;
  const owner = subject.kind === "staff" ? { userId: subject.id } : { portalUserId: subject.id };
  const used = await prisma.mfaRecoveryCode.updateMany({ where: { ...owner, codeHash: hashCode(code), usedAt: null }, data: { usedAt: new Date() } });
  return used.count === 1;
}

/** Lost phone: an Admin clears staff MFA; any staff member can clear a client's. */
export async function resetMfa(actor: Actor, subject: MfaSubject) {
  if (subject.kind === "staff") assertAdmin(actor);
  const owner = subject.kind === "staff" ? { userId: subject.id } : { portalUserId: subject.id };
  await save(subject, { mfaSecretEnc: null, mfaEnabledAt: null });
  await prisma.mfaRecoveryCode.deleteMany({ where: owner });
  if (subject.kind === "staff") await prisma.session.deleteMany({ where: { userId: subject.id } });
  else await prisma.portalSession.deleteMany({ where: { portalUserId: subject.id } });
  await prisma.auditLog.create({ data: { actorId: actor.id, action: "mfa.reset", entityType: subject.kind === "staff" ? "User" : "PortalUser", entityId: subject.id } });
}
