import "server-only";
import type { PortalRole, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit, changedFields } from "@/lib/audit";
import { ownerAudit } from "@/lib/auth/owner";
import { assertAdmin, ForbiddenError, type Actor } from "@/lib/auth/actor";
import { normalizeEmail } from "@/lib/normalize";
import { fmtDate } from "@/lib/format";
import { ADDRESS_NEEDED_TAG, FILING_STATUS_NEEDED_TAG } from "@/lib/import/edits";
import { defaultInvitePermissions, fullInvitePermissions, INVITE_PERMISSION_FLAGS, invitePermissions, type InvitePermissions } from "@/lib/portal/invite-permissions";
import { isReportApprover } from "./bookkeeping-clients";
import { ValidationError } from "./clients";
import { emailPortalInvitation } from "./client-signup";
import { portalInvitesAuthorized } from "./owner-switches";

/**
 * Prepared invitations. Staff gather clients into a draft batch and check each row (name, email,
 * role, permissions); Tabitha reviews and approves rows; and only once she has turned on "Portal
 * invitations authorized" does Send go out, one row at a time, through the ordinary single-invite
 * path (invitePortalUser + the activation email, whose Resend statuses are recorded on the
 * invitation). Nothing here emails anyone before approval, and nothing grants the business view.
 */

export const ON_HOLD_MESSAGE = "Portal invitations are on hold until you authorize them.";

export type FlagCode =
  | "NO_EMAIL"
  | "SHARED_EMAIL"
  | "SHARED_EMAIL_CONFIRMED"
  | "STAFF_EMAIL"
  | "HAS_ACCESS"
  | "INVITE_OPEN"
  | "SUPPRESSED"
  | "ARCHIVED"
  | "NOT_ON_RECORD"
  | "CLIENT_HAS_LOGINS"
  | "BOOKKEEPING_YES"
  | "BOOKKEEPING_NO"
  | "MISSING_INFO";

export type RowFlag = { code: FlagCode; label: string; blocking: boolean; tone: "red" | "amber" | "gray" | "green" | "navy" };

export type RowResult = "SENT" | "EMAIL_FAILED" | "SKIPPED" | "NO_EMAIL" | "ACCESS_ADDED";

const SUPPRESSION_WORDS: Record<string, string> = {
  STOP: "Replied STOP",
  BOUNCE: "Email address bounced",
  COMPLAINT: "Marked a message as spam",
  MANUAL: "On the do-not-contact list",
};

async function isOwner(actor: Actor) {
  return isReportApprover(actor);
}

async function assertOwnerApprover(actor: Actor, what: string) {
  if (!(await isOwner(actor))) throw new ForbiddenError(`Only Tabitha can ${what}.`);
}

// --- Flags -------------------------------------------------------------------------

type FlagRow = { id: string; batchId: string; clientId: string; email: string | null; sharedEmailConfirmedAt: Date | null };

/**
 * Everything the review screen and approval need to know about each row, worked out live from the
 * database (so a row that changed since it was prepared is re-checked at approval and at send).
 */
export async function flagsFor(rows: FlagRow[]): Promise<Map<string, RowFlag[]>> {
  const out = new Map<string, RowFlag[]>();
  if (rows.length === 0) return out;
  const clientIds = [...new Set(rows.map((r) => r.clientId))];
  const emails = [...new Set(rows.map((r) => r.email).filter((e): e is string => !!e))];
  const batchIds = [...new Set(rows.map((r) => r.batchId))];
  const [clients, otherClients, otherContacts, logins, staff, suppressions, openInvites, batchRows] = await Promise.all([
    prisma.client.findMany({
      where: { id: { in: clientIds } },
      select: {
        id: true,
        archivedAt: true,
        emailNormalized: true,
        tags: true,
        contacts: { select: { emailNormalized: true } },
        bookkeepingProfile: { select: { active: true } },
        portalAccess: { where: { revokedAt: null }, select: { portalUser: { select: { email: true } } } },
      },
    }),
    emails.length ? prisma.client.findMany({ where: { emailNormalized: { in: emails }, archivedAt: null }, select: { id: true, displayName: true, emailNormalized: true } }) : [],
    emails.length ? prisma.contact.findMany({ where: { emailNormalized: { in: emails }, client: { archivedAt: null } }, select: { clientId: true, emailNormalized: true, client: { select: { displayName: true } } } }) : [],
    emails.length ? prisma.portalUser.findMany({ where: { email: { in: emails } }, select: { email: true, access: { where: { revokedAt: null }, select: { clientId: true } } } }) : [],
    emails.length ? prisma.user.findMany({ where: { email: { in: emails } }, select: { email: true } }) : [],
    emails.length ? prisma.suppression.findMany({ where: { channel: "EMAIL", addressNormalized: { in: emails }, liftedAt: null }, select: { addressNormalized: true, reason: true } }) : [],
    emails.length
      ? prisma.portalInvite.findMany({ where: { email: { in: emails }, clientId: { in: clientIds }, sentByEmail: true, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() }, emailStatus: { in: ["SENT", "DELIVERED"] } }, select: { email: true, clientId: true, emailSentAt: true, expiresAt: true } })
      : [],
    prisma.portalInviteBatchRow.findMany({ where: { batchId: { in: batchIds }, email: { not: null } }, select: { id: true, batchId: true, clientId: true, email: true } }),
  ]);
  const clientById = new Map(clients.map((c) => [c.id, c]));
  const staffSet = new Set(staff.map((s) => s.email));

  for (const r of rows) {
    const flags: RowFlag[] = [];
    const c = clientById.get(r.clientId);
    if (!c || c.archivedAt) flags.push({ code: "ARCHIVED", label: "Client is archived", blocking: true, tone: "red" });
    if (!r.email) {
      flags.push({ code: "NO_EMAIL", label: "No email on file", blocking: true, tone: "red" });
    } else {
      const e = r.email;
      // Possible duplicate / shared email: another client record, another login, or another row in this batch.
      const others = new Set<string>();
      for (const x of otherClients) if (x.emailNormalized === e && x.id !== r.clientId) others.add(x.displayName);
      for (const x of otherContacts) if (x.emailNormalized === e && x.clientId !== r.clientId) others.add(x.client.displayName);
      const login = logins.find((l) => l.email === e);
      const loginElsewhere = !!login && login.access.some((a) => a.clientId !== r.clientId);
      const inBatch = batchRows.some((b) => b.batchId === r.batchId && b.email === e && b.id !== r.id);
      if (others.size || loginElsewhere || inBatch) {
        const where = [others.size ? `another client (${[...others].slice(0, 3).join(", ")}${others.size > 3 ? "…" : ""})` : "", loginElsewhere ? "an existing portal login" : "", inBatch ? "another row in this batch" : ""].filter(Boolean).join(", ");
        flags.push(
          r.sharedEmailConfirmedAt
            ? { code: "SHARED_EMAIL_CONFIRMED", label: `Shared email confirmed (also on ${where})`, blocking: false, tone: "gray" }
            : { code: "SHARED_EMAIL", label: `Email used by ${where} — possible duplicate or shared email`, blocking: true, tone: "red" },
        );
      }
      if (staffSet.has(e)) flags.push({ code: "STAFF_EMAIL", label: "Also a staff login — invite from the client's Portal tab instead", blocking: true, tone: "red" });
      if (login && login.access.some((a) => a.clientId === r.clientId)) flags.push({ code: "HAS_ACCESS", label: "Already has portal access", blocking: true, tone: "red" });
      const open = openInvites.find((i) => i.email === e && i.clientId === r.clientId);
      if (open) flags.push({ code: "INVITE_OPEN", label: `An invitation was already emailed ${fmtDate(open.emailSentAt)} and is open until ${fmtDate(open.expiresAt)}`, blocking: true, tone: "red" });
      // Service email: a promotional unsubscribe doesn't block it; every other suppression does.
      const sup = suppressions.find((s) => s.addressNormalized === e && s.reason !== "UNSUBSCRIBE");
      if (sup) flags.push({ code: "SUPPRESSED", label: `Do not contact: ${SUPPRESSION_WORDS[sup.reason] ?? sup.reason}`, blocking: true, tone: "red" });
      if (c && c.emailNormalized !== e && !c.contacts.some((k) => k.emailNormalized === e)) flags.push({ code: "NOT_ON_RECORD", label: "Email isn't on this client's record", blocking: false, tone: "amber" });
    }
    if (c) {
      const otherLogins = c.portalAccess.filter((a) => a.portalUser.email !== r.email).length;
      if (otherLogins) flags.push({ code: "CLIENT_HAS_LOGINS", label: `Client already has ${otherLogins} other portal login${otherLogins === 1 ? "" : "s"}`, blocking: false, tone: "gray" });
      for (const t of c.tags) if (t === ADDRESS_NEEDED_TAG || t === FILING_STATUS_NEEDED_TAG) flags.push({ code: "MISSING_INFO", label: t, blocking: false, tone: "amber" });
      flags.push(c.bookkeepingProfile?.active ? { code: "BOOKKEEPING_YES", label: "On Bookkeeping Clients list: yes", blocking: false, tone: "navy" } : { code: "BOOKKEEPING_NO", label: "On Bookkeeping Clients list: no", blocking: false, tone: "gray" });
    }
    out.set(r.id, flags);
  }
  return out;
}

export const blockingFlags = (flags: RowFlag[] | undefined) => (flags ?? []).filter((f) => f.blocking);

// --- Prepare -------------------------------------------------------------------------

/** Clients with no active portal login yet (the default filter for preparing). */
export const noPortalLoginWhere: Prisma.ClientWhereInput = { archivedAt: null, portalAccess: { none: { revokedAt: null } } };

async function rowDataFor(clientIds: string[]) {
  const clients = await prisma.client.findMany({ where: { id: { in: clientIds }, archivedAt: null }, select: { id: true, displayName: true, emailNormalized: true } });
  return clients.map((c) => ({ clientId: c.id, inviteeName: c.displayName, email: c.emailNormalized, role: "OWNER" as PortalRole, permissions: defaultInvitePermissions("OWNER") as Prisma.InputJsonValue }));
}

/** Starts a draft batch with these clients. Any staff member can prepare one. */
export async function createInviteBatch(actor: Actor, input: { title?: string; clientIds: string[]; importBatchId?: string | null }) {
  const ids = [...new Set(input.clientIds)].slice(0, 500);
  if (!ids.length) throw new ValidationError("Choose at least one client.");
  if (input.importBatchId && !(await prisma.importBatch.count({ where: { id: input.importBatchId } }))) throw new ValidationError("Import not found.");
  const rows = await rowDataFor(ids);
  if (!rows.length) throw new ValidationError("None of those clients can be invited (archived or missing).");
  const title = input.title?.trim().slice(0, 120) || `Portal invitations ${fmtDate(new Date())}`;
  return prisma.$transaction(async (tx) => {
    const batch = await tx.portalInviteBatch.create({ data: { title, importBatchId: input.importBatchId ?? null, createdById: actor.id } });
    await tx.portalInviteBatchRow.createMany({ data: rows.map((r) => ({ ...r, batchId: batch.id })) });
    await audit(tx, { actorId: actor.id, action: "portal_invites.batch_created", entityType: "PortalInviteBatch", entityId: batch.id, details: { title, rows: rows.length, importBatchId: input.importBatchId ?? null } });
    await audit(tx, { actorId: actor.id, action: "portal_invites.rows_added", entityType: "PortalInviteBatch", entityId: batch.id, details: { clientIds: rows.map((r) => r.clientId) } });
    return batch;
  });
}

/** Adds clients to an existing batch (clients already in it are left as they are). */
export async function addClientsToBatch(actor: Actor, batchId: string, clientIds: string[]) {
  await prisma.portalInviteBatch.findUniqueOrThrow({ where: { id: batchId } });
  const existing = new Set((await prisma.portalInviteBatchRow.findMany({ where: { batchId }, select: { clientId: true } })).map((r) => r.clientId));
  const rows = (await rowDataFor([...new Set(clientIds)].filter((id) => !existing.has(id)).slice(0, 500)));
  if (rows.length) {
    await prisma.$transaction(async (tx) => {
      await tx.portalInviteBatchRow.createMany({ data: rows.map((r) => ({ ...r, batchId })), skipDuplicates: true });
      await audit(tx, { actorId: actor.id, action: "portal_invites.rows_added", entityType: "PortalInviteBatch", entityId: batchId, details: { clientIds: rows.map((r) => r.clientId) } });
    });
  }
  return { added: rows.length, alreadyIn: clientIds.length - rows.length };
}

async function editableRow(rowId: string) {
  const row = await prisma.portalInviteBatchRow.findUnique({ where: { id: rowId } });
  if (!row) throw new ValidationError("That row is no longer in the batch.");
  if (row.sendStartedAt) throw new ValidationError("This invitation has already been sent; it can't be changed here. Use the client's Portal tab.");
  return row;
}

/** Edits a row. Any change clears Tabitha's approval of it. Changing who sees ID documents needs an Admin (as on the Portal tab). */
export async function editInviteRow(actor: Actor, rowId: string, input: { inviteeName: string; email: string; role: PortalRole; permissions: Partial<InvitePermissions> & { canViewBookkeeping?: boolean } }) {
  const row = await editableRow(rowId);
  const name = input.inviteeName.trim().slice(0, 120);
  if (!name) throw new ValidationError("Enter the invitee's name.");
  const email = input.email.trim() ? normalizeEmail(input.email) : null;
  if (input.email.trim() && !email) throw new ValidationError("Enter a valid email address, or leave it blank.");
  if (input.role !== "OWNER" && input.role !== "AUTHORIZED_CONTACT") throw new ValidationError("Choose Owner or Authorized contact.");
  // The business view is never part of an invitation (see invitePortalUser).
  if (input.permissions.canViewBookkeeping) throw new ValidationError("Business access is turned on separately by Tabitha after the invitation.");
  const before = fullInvitePermissions(row.role, row.permissions);
  // Flags not given keep their current value, or follow the new role's defaults when the role changes.
  const base = row.role === input.role ? before : defaultInvitePermissions(input.role);
  const { canViewBookkeeping: _never, ...given } = invitePermissions(input.permissions);
  void _never;
  const next = { ...base, ...given } as InvitePermissions;
  if (next.canViewIdentity !== base.canViewIdentity) assertAdmin(actor);
  const after = { inviteeName: name, email, role: input.role, permissions: next };
  const changed = changedFields({ inviteeName: row.inviteeName, email: row.email, role: row.role, permissions: before } as Record<string, unknown>, after);
  if (!changed.length) return { changed };
  const emailChanged = changed.includes("email");
  await prisma.$transaction(async (tx) => {
    await tx.portalInviteBatchRow.update({
      where: { id: rowId },
      data: { inviteeName: name, email, role: input.role, permissions: next as Prisma.InputJsonValue, approvedAt: null, approvedById: null, ...(emailChanged ? { sharedEmailConfirmedAt: null, sharedEmailConfirmedById: null } : {}) },
    });
    await audit(tx, { actorId: actor.id, action: "portal_invites.row_edited", entityType: "PortalInviteBatchRow", entityId: rowId, clientId: row.clientId, details: { batchId: row.batchId, changed, approvalCleared: !!row.approvedAt } });
  });
  return { changed };
}

/** Removes a row that hasn't been sent. */
export async function removeInviteRow(actor: Actor, rowId: string) {
  const row = await editableRow(rowId);
  await prisma.$transaction(async (tx) => {
    await tx.portalInviteBatchRow.delete({ where: { id: rowId } });
    await audit(tx, { actorId: actor.id, action: "portal_invites.row_removed", entityType: "PortalInviteBatchRow", entityId: rowId, clientId: row.clientId, details: { batchId: row.batchId, wasApproved: !!row.approvedAt } });
  });
}

/** Records that a shared address really is the same person (e.g. an owner with two businesses). */
export async function confirmSharedEmail(actor: Actor, rowId: string) {
  const row = await editableRow(rowId);
  if (!row.email) throw new ValidationError("This row has no email.");
  await prisma.$transaction(async (tx) => {
    await tx.portalInviteBatchRow.update({ where: { id: rowId }, data: { sharedEmailConfirmedAt: new Date(), sharedEmailConfirmedById: actor.id, approvedAt: null, approvedById: null } });
    await audit(tx, { actorId: actor.id, action: "portal_invites.shared_email_confirmed", entityType: "PortalInviteBatchRow", entityId: rowId, clientId: row.clientId, details: { batchId: row.batchId } });
  });
}

// --- Approve -------------------------------------------------------------------------

/**
 * Tabitha approves rows: the chosen ones, or the whole batch. A row with a blocking problem is
 * never approved; approving the whole batch is refused until every unsent row is ready.
 */
export async function approveInviteRows(actor: Actor, batchId: string, which: { rowIds: string[] } | "ALL") {
  await assertOwnerApprover(actor, "approve portal invitations");
  const rows = await prisma.portalInviteBatchRow.findMany({ where: { batchId, sendStartedAt: null, ...(which === "ALL" ? {} : { id: { in: which.rowIds } }) } });
  if (!rows.length) throw new ValidationError(which === "ALL" ? "There's nothing left to approve in this batch." : "Choose at least one row to approve.");
  const flags = await flagsFor(rows);
  const blocked = rows.filter((r) => blockingFlags(flags.get(r.id)).length);
  if (which === "ALL" && blocked.length) throw new ValidationError(`${blocked.length} row${blocked.length === 1 ? " has a problem" : "s have problems"} to fix or remove before the whole batch can be approved.`);
  const ok = rows.filter((r) => !blocked.includes(r) && !r.approvedAt);
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    if (ok.length) await tx.portalInviteBatchRow.updateMany({ where: { id: { in: ok.map((r) => r.id) }, sendStartedAt: null }, data: { approvedAt: now, approvedById: actor.id } });
    await audit(tx, { actorId: actor.id, action: "portal_invites.approved", entityType: "PortalInviteBatch", entityId: batchId, details: { scope: which === "ALL" ? "batch" : "selected", approvedRowIds: ok.map((r) => r.id), blockedRowIds: blocked.map((r) => r.id) } });
  });
  await ownerAudit(actor.id, "portal_invites.approved", "PortalInviteBatch", batchId, { approved: ok.length, blocked: blocked.length });
  return { approved: ok.length, blocked: blocked.map((r) => ({ rowId: r.id, reasons: blockingFlags(flags.get(r.id)).map((f) => f.label) })) };
}

/** Takes back an approval (before sending). */
export async function unapproveInviteRow(actor: Actor, rowId: string) {
  await assertOwnerApprover(actor, "change approvals");
  const row = await editableRow(rowId);
  await prisma.$transaction(async (tx) => {
    await tx.portalInviteBatchRow.update({ where: { id: rowId }, data: { approvedAt: null, approvedById: null } });
    await audit(tx, { actorId: actor.id, action: "portal_invites.approval_removed", entityType: "PortalInviteBatchRow", entityId: rowId, clientId: row.clientId, details: { batchId: row.batchId } });
  });
}

// --- Send ----------------------------------------------------------------------------

/**
 * Sends the batch's approved rows. Only Tabitha, only with "Portal invitations authorized" on.
 * Each row is claimed once (so it can never be invited twice, even if Send is pressed twice),
 * re-checked, and then goes through the single-invite path. "SENT" means the email provider
 * accepted the email — delivery shows only when Resend reports it.
 */
export async function sendInviteBatch(actor: Actor, batchId: string) {
  await assertOwnerApprover(actor, "send portal invitations");
  if (!(await portalInvitesAuthorized())) throw new ForbiddenError(ON_HOLD_MESSAGE);
  const batch = await prisma.portalInviteBatch.findUniqueOrThrow({ where: { id: batchId } });
  const rows = await prisma.portalInviteBatchRow.findMany({ where: { batchId, approvedAt: { not: null }, sendStartedAt: null }, orderBy: { createdAt: "asc" } });
  if (!rows.length) throw new ValidationError("There are no approved invitations waiting to be sent in this batch.");
  await audit(prisma, { actorId: actor.id, action: "portal_invites.send_started", entityType: "PortalInviteBatch", entityId: batch.id, details: { rows: rows.length } });
  const tally: Record<RowResult, number> = { SENT: 0, EMAIL_FAILED: 0, SKIPPED: 0, NO_EMAIL: 0, ACCESS_ADDED: 0 };
  for (const r of rows) {
    const claimed = await prisma.portalInviteBatchRow.updateMany({ where: { id: r.id, sendStartedAt: null, approvedAt: { not: null } }, data: { sendStartedAt: new Date() } });
    if (claimed.count !== 1) continue; // another Send already took this row
    const outcome = await sendOne(actor, r);
    tally[outcome.result]++;
    await prisma.portalInviteBatchRow.update({ where: { id: r.id }, data: { result: outcome.result, resultDetail: outcome.detail?.slice(0, 300) ?? null, resultAt: new Date(), portalInviteId: outcome.inviteId ?? null } });
    await audit(prisma, { actorId: actor.id, action: "portal_invites.row_result", entityType: "PortalInviteBatchRow", entityId: r.id, clientId: r.clientId, details: { batchId, result: outcome.result, detail: outcome.detail ?? null, portalInviteId: outcome.inviteId ?? null } });
  }
  await prisma.portalInviteBatch.update({ where: { id: batchId }, data: { lastSentAt: new Date() } });
  await audit(prisma, { actorId: actor.id, action: "portal_invites.sent", entityType: "PortalInviteBatch", entityId: batchId, details: tally });
  await ownerAudit(actor.id, "portal_invites.sent", "PortalInviteBatch", batchId, tally);
  return tally;
}

async function sendOne(actor: Actor, r: { id: string; batchId: string; clientId: string; contactId: string | null; inviteeName: string; email: string | null; role: PortalRole; permissions: Prisma.JsonValue; sharedEmailConfirmedAt: Date | null }): Promise<{ result: RowResult; detail?: string; inviteId?: string }> {
  if (!r.email) return { result: "NO_EMAIL", detail: "No email on file." };
  // Things may have changed since approval (a login appeared, an address bounced): re-check.
  const flags = (await flagsFor([r])).get(r.id) ?? [];
  const has = (c: FlagCode) => flags.find((f) => f.code === c);
  if (has("HAS_ACCESS")) return { result: "SKIPPED", detail: "Already has portal access." };
  const block = blockingFlags(flags)[0];
  if (block) return { result: "SKIPPED", detail: block.label };
  const permissions = invitePermissions(fullInvitePermissions(r.role, r.permissions));
  try {
    const sent = await emailPortalInvitation(actor, r.clientId, { email: r.email, name: r.inviteeName, role: r.role, contactId: r.contactId, permissions });
    if (!sent.ok) return { result: "EMAIL_FAILED", detail: sent.detail, inviteId: sent.inviteId };
    if (sent.grantedExisting) return { result: "ACCESS_ADDED", detail: "They already had a portal login; this account was added to it. No email was needed." };
    return { result: "SENT", detail: "Accepted by the email provider.", inviteId: sent.inviteId };
  } catch (err) {
    if (err instanceof ValidationError || err instanceof ForbiddenError) return { result: "SKIPPED", detail: err.message };
    throw err;
  }
}

// --- Read ----------------------------------------------------------------------------

export const RESULT_LABEL: Record<RowResult, string> = {
  SENT: "Sent — accepted by the email provider",
  EMAIL_FAILED: "Email failed",
  SKIPPED: "Skipped",
  NO_EMAIL: "Not sent — no email",
  ACCESS_ADDED: "Access added to their existing login",
};

/** The status shown for a sent row: the invitation's own email status wins once Resend reports it. */
export function rowStatusLabel(row: { result: string | null; approvedAt: Date | null; sendStartedAt: Date | null }, invite?: { emailStatus: string | null; acceptedAt: Date | null; emailError: string | null } | null): { label: string; tone: "green" | "gold" | "red" | "gray" | "navy" } {
  if (invite?.acceptedAt) return { label: "Activated", tone: "green" };
  if (row.result === "SENT" && invite?.emailStatus === "DELIVERED") return { label: "Delivered (reported by Resend)", tone: "green" };
  if (row.result === "SENT" && invite?.emailStatus === "FAILED") return { label: `Not delivered${invite.emailError ? `: ${invite.emailError}` : ""}`, tone: "red" };
  if (row.result) return { label: RESULT_LABEL[row.result as RowResult] ?? row.result, tone: row.result === "SENT" || row.result === "ACCESS_ADDED" ? "gold" : row.result === "SKIPPED" ? "gray" : "red" };
  if (row.sendStartedAt) return { label: "Sending…", tone: "gray" };
  if (row.approvedAt) return { label: "Approved — waiting to send", tone: "navy" };
  return { label: "Draft — needs Tabitha's approval", tone: "gray" };
}

export async function inviteBatchDetail(batchId: string) {
  const batch = await prisma.portalInviteBatch.findUnique({
    where: { id: batchId },
    include: {
      createdBy: { select: { name: true } },
      rows: { orderBy: { createdAt: "asc" }, include: { client: { select: { displayName: true, clientType: true } } } },
    },
  });
  if (!batch) return null;
  const inviteIds = batch.rows.map((r) => r.portalInviteId).filter((x): x is string => !!x);
  const [flags, invites] = await Promise.all([
    flagsFor(batch.rows.filter((r) => !r.sendStartedAt)),
    inviteIds.length ? prisma.portalInvite.findMany({ where: { id: { in: inviteIds } }, select: { id: true, emailStatus: true, acceptedAt: true, emailError: true, emailDeliveredAt: true } }) : [],
  ]);
  const inviteById = new Map(invites.map((i) => [i.id, i]));
  const userIds = [...new Set(batch.rows.map((r) => r.approvedById).filter((x): x is string => !!x))];
  const approvers = new Map((await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  return {
    batch,
    rows: batch.rows.map((r) => ({
      ...r,
      perms: fullInvitePermissions(r.role, r.permissions),
      flags: flags.get(r.id) ?? [],
      invite: r.portalInviteId ? inviteById.get(r.portalInviteId) ?? null : null,
      approvedByName: r.approvedById ? approvers.get(r.approvedById) ?? null : null,
    })),
  };
}

export function batchCounts(rows: { approvedAt: Date | null; sendStartedAt: Date | null; result: string | null; flags: RowFlag[] }[]) {
  const unsent = rows.filter((r) => !r.sendStartedAt);
  return {
    total: rows.length,
    blocked: unsent.filter((r) => blockingFlags(r.flags).length).length,
    ready: unsent.filter((r) => !blockingFlags(r.flags).length && !r.approvedAt).length,
    approved: unsent.filter((r) => r.approvedAt).length,
    sent: rows.filter((r) => r.result === "SENT").length,
    done: rows.filter((r) => r.sendStartedAt).length,
  };
}

export { INVITE_PERMISSION_FLAGS };
