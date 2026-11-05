import type { PortalRole } from "@prisma/client";

/**
 * The portal permissions an ordinary invitation can choose up front, and their defaults. Shared by
 * invitePortalUser (and acceptance) and the Prepared invitations screens, so a batch never offers
 * anything the single invite wouldn't. The business view (canViewBookkeeping) is never one of
 * them: Tabitha turns it on per login afterwards, and only for a Managed Business.
 * Safe to import from client components (no server code here).
 */

export const INVITE_PERMISSION_FLAGS = ["canMessage", "canUpload", "canViewTax", "canViewContracts", "canViewIdentity"] as const;
export type InvitePermissionFlag = (typeof INVITE_PERMISSION_FLAGS)[number];
export type InvitePermissions = Record<InvitePermissionFlag, boolean>;

export const INVITE_PERMISSION_LABEL: Record<InvitePermissionFlag, string> = {
  canMessage: "Messages",
  canUpload: "Upload files",
  canViewTax: "Tax documents",
  canViewContracts: "Contracts",
  canViewIdentity: "Own ID documents",
};

/** What a new login gets by default for this role. */
export function defaultInvitePermissions(role: PortalRole): InvitePermissions {
  return { canMessage: true, canUpload: true, canViewTax: role === "OWNER", canViewContracts: true, canViewIdentity: role === "OWNER" };
}

/** Keeps only the choosable flags (booleans), with the business view always off. */
export function invitePermissions(input: unknown): Partial<InvitePermissions> & { canViewBookkeeping: false } {
  const src = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const out: Partial<InvitePermissions> & { canViewBookkeeping: false } = { canViewBookkeeping: false };
  for (const f of INVITE_PERMISSION_FLAGS) if (typeof src[f] === "boolean") out[f] = src[f] as boolean;
  return out;
}

/** A stored set, completed with the role's defaults. */
export function fullInvitePermissions(role: PortalRole, stored: unknown): InvitePermissions {
  return { ...defaultInvitePermissions(role), ...invitePermissions(stored) } as InvitePermissions;
}

/** Plain words for the approval screen, e.g. "Can use messages, upload files and tax documents. No contracts. No business (bookkeeping) view." */
export function permissionsInWords(p: InvitePermissions): string {
  const word = (f: InvitePermissionFlag) => INVITE_PERMISSION_LABEL[f].replace(/^./, (ch) => ch.toLowerCase());
  const can = INVITE_PERMISSION_FLAGS.filter((f) => p[f]).map(word);
  const cannot = INVITE_PERMISSION_FLAGS.filter((f) => !p[f]).map(word);
  const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
  return [can.length ? `Can use ${list(can)}.` : "Can't use anything yet.", cannot.length ? `No ${list(cannot)}.` : "", "No business (bookkeeping) view."].filter(Boolean).join(" ");
}
