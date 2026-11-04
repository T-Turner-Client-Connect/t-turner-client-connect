import "server-only";
import { prisma } from "@/lib/prisma";
import {
  ALL_KEYS,
  AREAS,
  GRANTABLE_KEYS,
  isKnownKey,
  keyOf,
  OWNER_GRANTS_ONLY,
  OWNER_ONLY_KEYS,
  PRESETS,
  normalizeKeys,
  type Area,
  type PermAction,
  type PermKey,
} from "@/lib/permissions";
import { ValidationError as PermissionValidationError } from "@/lib/services/clients";
import { ForbiddenError, type Actor } from "./actor";

/**
 * Staff Access & Permissions — server checks. Every call reads the database: nothing is cached
 * in the session cookie, so a grant or revoke applies to signed-in staff on their next request.
 *
 * - The primary owner (OwnerAccess.isPrimary, active account) holds every action, always.
 * - Everyone else holds exactly their StaffPermission rows (owner-only actions never count).
 */

export async function isPrimaryOwner(userId: string): Promise<boolean> {
  const n = await prisma.ownerAccess.count({ where: { userId, isPrimary: true, revokedAt: null, user: { active: true } } });
  return n > 0;
}

export type OfficeAccess = {
  isOwner: boolean;
  keys: ReadonlySet<PermKey>;
  can: (area: Area, action: PermAction) => boolean;
  /** Can see at least one part of the Owner's Office. */
  any: boolean;
};

export async function officeAccessFor(userId: string): Promise<OfficeAccess> {
  const owner = await isPrimaryOwner(userId);
  let keys: Set<PermKey>;
  if (owner) keys = new Set(ALL_KEYS);
  else {
    const rows = await prisma.staffPermission.findMany({ where: { userId, user: { active: true } }, select: { area: true, action: true } });
    const grantable = new Set<string>(GRANTABLE_KEYS);
    keys = new Set(rows.map((r) => `${r.area}.${r.action}`).filter((k): k is PermKey => grantable.has(k)));
  }
  return { isOwner: owner, keys, can: (area, action) => keys.has(keyOf(area, action)), any: keys.size > 0 };
}

export async function can(actor: Pick<Actor, "id">, area: Area, action: PermAction): Promise<boolean> {
  const key = keyOf(area, action);
  if (await isPrimaryOwner(actor.id)) return true;
  if (OWNER_ONLY_KEYS.includes(key)) return false;
  const n = await prisma.staffPermission.count({ where: { userId: actor.id, area, action, user: { active: true } } });
  return n > 0;
}

/** Server gate for services and actions. The message never reveals more than "Not found." by default. */
export async function assertCan(actor: Pick<Actor, "id">, area: Area, action: PermAction, message = "Not found."): Promise<void> {
  if (!(await can(actor, area, action))) throw new ForbiddenError(message);
}

/**
 * Coetha's work (entries, categorizations, reconciliations, proposed statements) is approved by
 * the primary owner alone. No grant — not even every grant plus Staff management → Manage —
 * lets anyone else approve it, and there's no staff approval chain. Use this wherever Coetha
 * output is approved, posted or finalized.
 */
export async function canApproveCoethaWork(actor: Pick<Actor, "id">): Promise<boolean> {
  return isPrimaryOwner(actor.id);
}

export async function assertCanApproveCoethaWork(actor: Pick<Actor, "id">): Promise<true> {
  if (!(await canApproveCoethaWork(actor))) throw new ForbiddenError("Only Tabitha approves Coetha's work. Coetha can prepare and recommend; staff can review, but approval is the owner's.");
  return true;
}

// ---------------------------------------------------------------------------------------------
// Changing grants
// ---------------------------------------------------------------------------------------------

type Who = { isOwner: boolean; keys: ReadonlySet<PermKey> };

async function managerOf(actor: Actor): Promise<Who> {
  const me = await officeAccessFor(actor.id);
  if (!me.isOwner && !me.keys.has("staff.manage")) throw new ForbiddenError("Only the owner, or staff she allows to manage staff, can change permissions.");
  return me;
}

/**
 * Sets a staff member's grants to exactly `desired` — nothing is implied or added.
 * - The owner's own row is permanent: nobody edits it, the owner included.
 * - Nobody edits their own row.
 * - Owner-only actions (Coetha approval and Tabitha's sign-offs) are never granted.
 * - A delegated staff manager changes only actions they hold themselves, never Staff management.
 * Every change is recorded (who, whom, area, action, old → new, when).
 */
export async function setStaffPermissions(actor: Actor, userId: string, desired: string[], source = "matrix") {
  const me = await managerOf(actor);
  if (userId === actor.id) throw new ForbiddenError(me.isOwner ? "You're the owner: your access is full and permanent." : "You can't change your own permissions.");
  if (await isPrimaryOwner(userId)) throw new ForbiddenError("The owner's access is full and permanent. Nobody can change it.");
  const target = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, active: true, name: true } });
  if (!target || !target.active) throw new PermissionValidationError("Choose an active staff member.");

  for (const k of desired) if (!isKnownKey(k)) throw new PermissionValidationError("Unknown permission.");
  if (desired.some((k) => OWNER_ONLY_KEYS.includes(k as PermKey))) throw new ForbiddenError("That permission stays with the owner. It can't be granted.");
  const want = new Set(normalizeKeys(desired));

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`staff-perm:${userId}`}))`;
    const rows = await tx.staffPermission.findMany({ where: { userId } });
    const have = new Set(rows.map((r) => `${r.area}.${r.action}`));
    const add = [...want].filter((k) => !have.has(k));
    const remove = [...have].filter((k) => !want.has(k as PermKey));
    if (!me.isOwner) {
      for (const k of [...add, ...remove]) {
        if (OWNER_GRANTS_ONLY.includes(k as PermKey)) throw new ForbiddenError("Only the owner can give or remove Staff management.");
        if (!me.keys.has(k as PermKey)) throw new ForbiddenError("You can only give or remove permissions you hold yourself.");
      }
    }
    for (const k of add) {
      const [area, action] = k.split(".");
      await tx.staffPermission.create({ data: { userId, area, action, grantedById: actor.id } });
    }
    if (remove.length) {
      await tx.staffPermission.deleteMany({ where: { userId, OR: remove.map((k) => ({ area: k.split(".")[0], action: k.split(".")[1] })) } });
    }
    const changes = [...add.map((k) => [k, true] as const), ...remove.map((k) => [k, false] as const)];
    if (changes.length) {
      await tx.staffPermissionEvent.createMany({
        data: changes.map(([k, on]) => ({ actorId: actor.id, userId, area: k.split(".")[0], action: k.split(".")[1], fromAllowed: !on, toAllowed: on, source: source.slice(0, 80) })),
      });
      await tx.ownerAuditLog.create({ data: { actorId: actor.id, action: "staff.permissions_changed", entityType: "User", entityId: userId, details: { added: add, removed: remove, source } } });
    }
    return { added: add as PermKey[], removed: remove as PermKey[] };
  });
}

/** One click: replaces the staff member's grants with the preset's set. Never applied automatically. */
export async function applyPermissionPreset(actor: Actor, userId: string, presetKey: string) {
  const preset = PRESETS.find((p) => p.key === presetKey);
  if (!preset) throw new PermissionValidationError("Choose a preset.");
  return setStaffPermissions(actor, userId, preset.keys, `preset:${preset.key}`);
}

/** Turns single permissions on or off, leaving the rest as they are (used by legacy toggles). */
export async function changePermissions(actor: Actor, userId: string, change: { add?: PermKey[]; remove?: PermKey[] }, source: string) {
  const current = await officeAccessFor(userId);
  const next = new Set<string>(current.keys);
  for (const k of change.add ?? []) next.add(k);
  for (const k of change.remove ?? []) next.delete(k);
  return setStaffPermissions(actor, userId, [...next], source);
}

async function assertMayView(actor: Actor) {
  const me = await officeAccessFor(actor.id);
  if (!me.isOwner && !me.keys.has("staff.view") && !me.keys.has("staff.manage")) throw new ForbiddenError("Not found.");
  return me;
}

/** The Staff Access & Permissions screen: every active staff member and what they hold. */
export async function staffAccessBoard(actor: Actor) {
  const me = await assertMayView(actor);
  const [users, primary, grants] = await Promise.all([
    prisma.user.findMany({ where: { active: true }, select: { id: true, name: true, email: true, role: true, mfaEnabledAt: true }, orderBy: { name: "asc" } }),
    prisma.ownerAccess.findFirst({ where: { isPrimary: true, revokedAt: null }, select: { userId: true } }),
    prisma.staffPermission.findMany({ select: { userId: true, area: true, action: true } }),
  ]);
  const grantable = new Set<string>(GRANTABLE_KEYS);
  return {
    me,
    staff: users.map((u) => {
      const isOwner = u.id === primary?.userId;
      const keys = isOwner ? [...ALL_KEYS] : grants.filter((g) => g.userId === u.id).map((g) => `${g.area}.${g.action}`).filter((k) => grantable.has(k));
      return { ...u, isOwner, keys: keys as PermKey[], twoStep: !!u.mfaEnabledAt };
    }),
  };
}

export async function permissionHistory(actor: Actor, opts: { userId?: string; take?: number } = {}) {
  await assertMayView(actor);
  const rows = await prisma.staffPermissionEvent.findMany({ where: opts.userId ? { userId: opts.userId } : {}, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: opts.take ?? 50 });
  const ids = [...new Set(rows.flatMap((r) => [r.actorId, r.userId]))];
  const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  const name = (id: string) => (id === "system" ? "Data migration" : (users.find((u) => u.id === id)?.name ?? "Former staff member"));
  return rows.map((r) => ({ ...r, actorName: name(r.actorId), userName: name(r.userId) }));
}

/** Areas in display order, for screens. */
export const PERMISSION_AREAS = AREAS;
