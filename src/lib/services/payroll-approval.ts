import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import { can, canApproveCoethaWork } from "@/lib/auth/permissions";
import { ownerHasPermission } from "@/lib/portal/owner-permissions";
import { verifyPassword } from "@/lib/auth/password";
import { sendEmail, brandedEmailHtml } from "@/lib/email";
import { appUrl } from "@/lib/integrations";
import { sendSms } from "@/lib/twilio";
import { chicagoParts } from "@/lib/tz";
import { ValidationError } from "./clients";
import { usd, ymdOf } from "./ledger";
import { canSend } from "./comm-prefs";
import { clientTextingOn } from "./staff-alerts";
import { CLIENT_SMS_QUIET } from "./notifications";
import { sendEmailCode, verifyEmailCode, verifySecondFactor } from "./mfa";
import { assertPayrollWork, assertStaff, event, LOCKED, loadRun } from "./payroll";
import { payrollCost } from "@/lib/payroll/register";
import { NOTIFY_CHANNELS, type NotifyChannel } from "@/lib/payroll/fields";

/**
 * Payroll Review & Approval by business owners.
 *
 * - Approvers are portal logins (business owners) designated per business by Tabitha or staff she
 *   authorized (Owner's Office or bookkeeping-billing permission). Owners never designate anyone.
 * - A decision binds to one version (id + content hash) and one approval round. Editing a run
 *   creates a new version, so earlier decisions stop counting and the run is sent again.
 * - Fully Approved = every required approver approved the SAME version in the current round.
 *   Fully Approved never releases anything: a staff payroll operator submits it to ADP/Paychex.
 * - Owners can only approve or deny (with a comment) and change how they're notified. Every other
 *   payroll mutation takes a staff Actor and re-checks it's a real staff account.
 * - Payroll approval is separate from Coetha accounting approval (which only Tabitha gives).
 */

type Tx = Prisma.TransactionClient;
export const LINK_TTL_MS = 72 * 3600_000;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

// --- Approvers ----------------------------------------------------------------------------

/**
 * Tabitha (she holds every permission) or staff she granted "Payroll → Edit" in Owner's Office →
 * Settings → Staff Access & Permissions. Re-read from the database on every call.
 */
export async function canManagePayrollApprovers(actor: Actor) {
  return can(actor, "payroll", "edit");
}
async function assertApproverManager(actor: Actor) {
  await assertStaff(actor);
  if (!(await canManagePayrollApprovers(actor))) throw new ForbiddenError("Only Tabitha, or staff she authorizes for billing and payroll, can choose payroll approvers.");
}

/**
 * The one check for "may this portal login approve this business's payroll?".
 *
 * Source of truth: the business owner's own portal permission "Payroll approval → Approve/Deny"
 * (PortalAccess.canApprovePayroll, read by ownerHasPermission): an active business owner of this
 * client, with live access, who was granted it. The PayrollApprover row only says HOW they take
 * part (required or optional, per-employee detail, how they're notified); setPayrollApprover and
 * the owner permission matrix keep the two in step, and a row without the permission never counts.
 */
export async function isPayrollApprover(portalUserId: string, clientId: string) {
  return ownerHasPermission(portalUserId, clientId, "payrollApproval", "approve");
}

/** The PayrollApprover filter that matches isPayrollApprover (for lists of approvers). */
export const approverWhere = (clientId: string) => ({
  clientId,
  active: true,
  portalUser: {
    active: true,
    access: { some: { clientId, revokedAt: null, canApprovePayroll: true, client: { archivedAt: null } } },
    businessOwners: { some: { clientId, archivedAt: null } },
  },
});

/** Portal logins with access to the business (who could be designated), and current designations. */
export async function approverCandidates(actor: Actor, clientId: string) {
  await assertApproverManager(actor);
  const [grants, approvers] = await Promise.all([
    prisma.portalAccess.findMany({ where: { clientId, revokedAt: null, portalUser: { active: true } }, include: { portalUser: { select: { id: true, name: true, email: true, phoneNormalized: true } } }, orderBy: { createdAt: "asc" } }),
    prisma.payrollApprover.findMany({ where: { clientId } }),
  ]);
  return grants.map((g) => ({ portalUser: g.portalUser, role: g.role, approver: approvers.find((a) => a.portalUserId === g.portalUserId) ?? null }));
}

export async function setPayrollApprover(actor: Actor, clientId: string, portalUserId: string, input: { approver: boolean; required: boolean; showEmployeeDetail?: boolean }) {
  await assertApproverManager(actor);
  const access = await prisma.portalAccess.findFirst({ where: { portalUserId, clientId, revokedAt: null } });
  if (!access) throw new ValidationError("That login doesn't have access to this business. Give them portal access first.");
  if (input.approver && !(await prisma.businessOwner.count({ where: { clientId, portalUserId, archivedAt: null } }))) {
    throw new ValidationError("Only a business owner approves payroll. Add them on the client's Owners card (with this login) first.");
  }
  const before = await prisma.payrollApprover.findUnique({ where: { clientId_portalUserId: { clientId, portalUserId } } });
  const data = input.approver
    ? { active: true, required: input.required, showEmployeeDetail: input.showEmployeeDetail ?? before?.showEmployeeDetail ?? true, removedAt: null, removedById: null }
    : { active: false, required: false, removedAt: new Date(), removedById: actor.id };
  const after = await prisma.$transaction(async (tx) => {
    const row = await tx.payrollApprover.upsert({ where: { clientId_portalUserId: { clientId, portalUserId } }, create: { clientId, portalUserId, designatedById: actor.id, ...data }, update: data });
    // Same switch as the owner permission matrix's "Payroll approval", so the two never disagree.
    if (access.canApprovePayroll !== input.approver) {
      await tx.portalAccess.update({ where: { id: access.id }, data: { canApprovePayroll: input.approver } });
      await audit(tx, { actorId: actor.id, action: "business_owner.permissions_changed", entityType: "PortalAccess", entityId: access.id, clientId, details: { changes: { canApprovePayroll: { from: access.canApprovePayroll, to: input.approver } }, via: "payroll_approvers" } });
    }
    return row;
  });
  await audit(prisma, { actorId: actor.id, action: "payroll.approver_set", entityType: "PayrollApprover", entityId: after.id, clientId, details: { portalUserId, before: before ? { active: before.active, required: before.required, showEmployeeDetail: before.showEmployeeDetail } : null, after: { active: after.active, required: after.required, showEmployeeDetail: after.showEmployeeDetail }, ownerPermission: { from: access.canApprovePayroll, to: input.approver } } });
  return after;
}


/** Who must approve: the required approvers, or every approver when none is marked required. */
export async function requiredApprovers(clientId: string, db: Tx | typeof prisma = prisma) {
  const all = await db.payrollApprover.findMany({ where: approverWhere(clientId), include: { portalUser: { select: { id: true, name: true, email: true } } } });
  const req = all.filter((a) => a.required);
  return { all, required: req.length ? req : all };
}

// --- Notification channel -----------------------------------------------------------------

/** The approver's own choice (from their Payroll Approval page) or staff at the client's request. */
export async function setNotifyChannel(by: { portalUserId: string } | { staff: Actor }, clientId: string, portalUserId: string, channel: string) {
  if (!(channel in NOTIFY_CHANNELS)) throw new ValidationError("Choose Text, Email or both.");
  if ("staff" in by) await assertStaff(by.staff);
  else if (by.portalUserId !== portalUserId || !(await isPayrollApprover(portalUserId, clientId))) throw new ForbiddenError("You can only change your own payroll notifications.");
  const a = await prisma.payrollApprover.findUnique({ where: { clientId_portalUserId: { clientId, portalUserId } } });
  if (!a?.active) throw new ValidationError("That login isn't a payroll approver for this business.");
  await prisma.payrollApprover.update({ where: { id: a.id }, data: { notifyChannel: channel } });
  await audit(prisma, { actorId: "staff" in by ? by.staff.id : null, action: "payroll.notify_channel_set", entityType: "PayrollApprover", entityId: a.id, clientId, details: { portalUserId, from: a.notifyChannel, to: channel, by: "staff" in by ? "staff at the client's request" : "approver" } });
}

const smsWindowOpen = (now: Date) => {
  const p = chicagoParts(now);
  const t = `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
  return t >= CLIENT_SMS_QUIET.start && t < CLIENT_SMS_QUIET.end;
};

/**
 * Which channels an approval request goes to. Default: email, plus text when allowed. A text that
 * isn't allowed (texting switched off, no service-text consent, STOP) falls back to email, with the
 * reason shown to the approver.
 *
 * Both channels go through Communication Preferences' canSend() as ESSENTIAL account notices: never
 * stopped by marketing choices, only by a STOP block or missing service-text consent (texts) or a
 * bounce, complaint or do-not-contact entry (email). It's checked again right before each send.
 */
export async function channelsFor(approver: { notifyChannel: string | null }, user: { email: string; phoneNormalized: string | null }) {
  const choice = (approver.notifyChannel as NotifyChannel | null) ?? null;
  const wantSms = choice === null || choice === "SMS" || choice === "BOTH";
  let smsBlocked: string | null = null;
  if (wantSms) {
    if (!(await clientTextingOn())) smsBlocked = "Text messages from the office are switched off right now.";
    else if (!user.phoneNormalized) smsBlocked = "There's no mobile number on your login.";
    else {
      const ok = await canSend({ channel: "SMS", address: user.phoneNormalized, category: "ESSENTIAL" });
      if (!ok.ok) smsBlocked = /STOP/.test(ok.reason) ? "Your number has opted out of texts (STOP)." : /do-not-contact/i.test(ok.reason) ? "Your number is on our do-not-contact list." : "We don't have your permission to text this number.";
    }
  }
  const sms = wantSms && !smsBlocked;
  const mail = await canSend({ channel: "EMAIL", address: user.email, category: "ESSENTIAL" });
  const emailBlocked = mail.ok ? null : mail.reason;
  const email = choice === null || choice === "EMAIL" || choice === "BOTH" || (choice === "SMS" && !sms);
  return { email, sms, choice, fallback: choice === "SMS" && !sms ? smsBlocked : null, smsBlocked, emailBlocked };
}

// --- Links --------------------------------------------------------------------------------

async function createLink(tx: Tx, run: { id: string; clientId: string; approvalRound: number; currentVersionId: string | null }, portalUserId: string, channel: "SMS" | "EMAIL") {
  const token = randomBytes(32).toString("base64url");
  const link = await tx.payrollApprovalLink.create({ data: { tokenHash: sha(token), runId: run.id, versionId: run.currentVersionId!, round: run.approvalRound, portalUserId, clientId: run.clientId, channel, expiresAt: new Date(Date.now() + LINK_TTL_MS) } });
  return { token, link, url: `${appUrl()}/payroll-approval/${token}` };
}

/** "Payroll for X (Oct 3–Oct 16, pay date Oct 23, total $1,234.00) needs your approval." No employee details. */
export function requestSummary(business: string, v: { periodStart: Date | null; periodEnd: Date | null; checkDate: Date; grossCents: number; employerTaxCents: number }) {
  const period = v.periodStart && v.periodEnd ? `${fmtShort(v.periodStart)}–${fmtShort(v.periodEnd)}, ` : "";
  return `Payroll for ${business} (${period}pay date ${fmtShort(v.checkDate)}, total ${usd(payrollCost(v))}) needs your approval.`;
}
const fmtShort = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** Sends each approver the request on their channel(s), each with its own single-use link. */
export async function notifyApprovers(runId: string, now = new Date()) {
  const run = await prisma.payrollRun.findUniqueOrThrow({ where: { id: runId }, include: { client: { select: { displayName: true, businessName: true } } } });
  const version = await prisma.payrollRunVersion.findUniqueOrThrow({ where: { id: run.currentVersionId! } });
  const { all } = await requiredApprovers(run.clientId);
  const business = run.client.businessName || run.client.displayName;
  const enabled = process.env.NOTIFICATIONS_ENABLED === "true";
  const results: { portalUserId: string; channel: string; status: string; detail: string | null }[] = [];
  for (const a of all) {
    const user = await prisma.portalUser.findUniqueOrThrow({ where: { id: a.portalUserId } });
    const ch = await channelsFor(a, user);
    const record = async (channel: "SMS" | "EMAIL", status: string, detail: string | null, linkId: string | null) => {
      await prisma.payrollNotice.create({ data: { runId, round: run.approvalRound, portalUserId: a.portalUserId, channel, status, detail, linkId, sentAt: status === "SENT" ? new Date() : null } });
      results.push({ portalUserId: a.portalUserId, channel, status, detail });
    };
    if (ch.smsBlocked && ch.choice !== "EMAIL") await record("SMS", "SKIPPED", ch.smsBlocked, null);
    for (const channel of [...(ch.sms ? (["SMS"] as const) : []), ...(ch.email ? (["EMAIL"] as const) : [])]) {
      if (!enabled) {
        await record(channel, "SKIPPED", "Notifications are turned off (NOTIFICATIONS_ENABLED is not true)", null);
        continue;
      }
      if (channel === "EMAIL" && ch.emailBlocked) {
        await record("EMAIL", "SKIPPED", ch.emailBlocked, null);
        continue;
      }
      const { url, link } = await prisma.$transaction((tx) => createLink(tx, run, a.portalUserId, channel));
      const summary = requestSummary(business, version);
      if (channel === "SMS") {
        if (!smsWindowOpen(now)) {
          await record("SMS", "HELD", "Held for quiet hours — sends after 8 a.m. Central", link.id);
          continue;
        }
        const r = await sendSms(user.phoneNormalized!, `TTurner Client Connect: ${summary} Review and approve or deny: ${url}`);
        await record("SMS", r.ok ? "SENT" : "FAILED", r.detail, link.id);
      } else {
        const r = await sendEmail({
          to: user.email,
          subject: `Payroll approval needed — ${business}`,
          text: `${summary}\n\nReview and approve or deny: ${url}\n\nThe link works once and expires in 72 hours. You'll confirm it's you before your decision is recorded.\n\nT. Turner & Associates`,
          html: brandedEmailHtml({ heading: "Payroll needs your approval", paragraphs: [summary, "The link works once and expires in 72 hours. You'll confirm it's you before your decision is recorded."], button: { label: "Review payroll", url }, footer: "T. Turner & Associates" }),
          idempotencyKey: `payroll-approval/${link.id}`,
          tags: { category: "payroll_approval" },
        });
        await record("EMAIL", r.ok ? "SENT" : "FAILED", r.ok ? "Accepted by email provider" : r.detail, link.id);
      }
    }
  }
  return results;
}

/** Texts held for quiet hours go out once the window opens (run from the notifications cron). */
export async function dispatchHeldPayrollTexts(now = new Date()) {
  if (!smsWindowOpen(now) || process.env.NOTIFICATIONS_ENABLED !== "true") return 0;
  const held = await prisma.payrollNotice.findMany({ where: { status: "HELD", channel: "SMS" }, take: 50 });
  let sent = 0;
  for (const n of held) {
    const claimed = await prisma.payrollNotice.updateMany({ where: { id: n.id, status: "HELD" }, data: { status: "SENDING" } });
    if (!claimed.count) continue;
    const run = await prisma.payrollRun.findUnique({ where: { id: n.runId } });
    if (!run || run.status !== "AWAITING_APPROVAL" || run.approvalRound !== n.round) {
      await prisma.payrollNotice.update({ where: { id: n.id }, data: { status: "SKIPPED", detail: "The pay run changed before the text could go out" } });
      continue;
    }
    // The held link is replaced by a fresh one so its 72 hours start now.
    await notifyOne(n.runId, n.portalUserId, "SMS", n.id);
    sent++;
  }
  return sent;
}

async function notifyOne(runId: string, portalUserId: string, channel: "SMS", noticeId: string) {
  const run = await prisma.payrollRun.findUniqueOrThrow({ where: { id: runId }, include: { client: { select: { displayName: true, businessName: true } } } });
  const version = await prisma.payrollRunVersion.findUniqueOrThrow({ where: { id: run.currentVersionId! } });
  const user = await prisma.portalUser.findUniqueOrThrow({ where: { id: portalUserId } });
  const approver = await prisma.payrollApprover.findUnique({ where: { clientId_portalUserId: { clientId: run.clientId, portalUserId } } });
  const ch = approver ? await channelsFor(approver, user) : null;
  if (!ch?.sms) {
    await prisma.payrollNotice.update({ where: { id: noticeId }, data: { status: "SKIPPED", detail: ch?.smsBlocked ?? "No longer an approver" } });
    return;
  }
  const { url, link } = await prisma.$transaction((tx) => createLink(tx, run, portalUserId, channel));
  const business = run.client.businessName || run.client.displayName;
  const r = await sendSms(user.phoneNormalized!, `TTurner Client Connect: ${requestSummary(business, version)} Review and approve or deny: ${url}`);
  await prisma.payrollNotice.update({ where: { id: noticeId }, data: { status: r.ok ? "SENT" : "FAILED", detail: r.detail, linkId: link.id, sentAt: r.ok ? new Date() : null } });
}

// --- Office workflow ----------------------------------------------------------------------

/** Staff send the current version to the business's approvers (a new round each time). */
export async function requestPayrollApproval(actor: Actor, clientId: string, runId: string, now = new Date()) {
  await assertStaff(actor);
  await assertPayrollWork(actor, clientId);
  const { all } = await requiredApprovers(clientId);
  if (!all.length) throw new ValidationError("No payroll approvers are set for this business. Tabitha chooses them in the Owner's Office → Payroll approvers.");
  const run = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"payroll-run:" + runId}))`;
    const { run, version } = await loadRun(clientId, runId, tx);
    if (run.status !== "DRAFT" && run.status !== "DENIED") throw new ValidationError(LOCKED.has(run.status) ? "This pay run is locked." : "This pay run is already with the approvers.");
    const r = await tx.payrollRun.update({ where: { id: run.id }, data: { status: "AWAITING_APPROVAL", approvalRound: { increment: 1 }, approvalRequestedAt: new Date(), approvalRequestedById: actor.id, fullyApprovedAt: null } });
    await event(tx, run.id, "APPROVAL_REQUESTED", { userId: actor.id, name: actor.name }, { versionNumber: version.number, note: `Sent to ${all.map((a) => a.portalUser.name).join(", ")}` });
    await audit(tx, { actorId: actor.id, action: "payroll.approval_requested", entityType: "PayrollRun", entityId: run.id, clientId, details: { version: version.number, round: r.approvalRound, contentHash: version.contentHash, approvers: all.map((a) => a.portalUserId) } });
    return r;
  });
  const notices = await notifyApprovers(run.id, now);
  return { run, notices };
}

export type DecisionMeta = { channel: "PORTAL" | "SMS_LINK" | "EMAIL_LINK"; verifiedBy: "PORTAL_SESSION" | "EMAIL_CODE" | "PASSWORD_AND_AUTHENTICATOR"; ip?: string | null; userAgent?: string | null; linkId?: string | null };

/**
 * An approver's decision on the CURRENT version. The only payroll write a portal login can make.
 * Recorded immutably: who, decision, when, comment, channel, how they were verified, IP/device.
 */
export async function decidePayroll(portalUserId: string, clientId: string, runId: string, input: { decision: "APPROVED" | "DENIED"; comment?: string | null; versionId: string }, meta: DecisionMeta) {
  if (input.decision !== "APPROVED" && input.decision !== "DENIED") throw new ValidationError("Choose Approve or Deny.");
  if (!(await isPayrollApprover(portalUserId, clientId))) throw new ForbiddenError("You're not a payroll approver for this business.");
  const comment = input.comment?.trim().slice(0, 1000) || null;
  if (input.decision === "DENIED" && !comment) throw new ValidationError("Tell the office what needs to change.");
  const user = await prisma.portalUser.findUniqueOrThrow({ where: { id: portalUserId } });
  const out = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"payroll-run:" + runId}))`;
    const { run, version } = await loadRun(clientId, runId, tx);
    if (LOCKED.has(run.status)) throw new ValidationError("This payroll was already processed, so decisions are closed.");
    if (run.status !== "AWAITING_APPROVAL") throw new ValidationError(run.status === "FULLY_APPROVED" ? "This payroll is already fully approved." : "This payroll isn't waiting for approval right now.");
    if (version.id !== input.versionId) throw new ValidationError("This payroll has changed since you opened it. Review the new version.");
    if (await tx.payrollApproval.count({ where: { runId, round: run.approvalRound, portalUserId } })) throw new ValidationError("You already recorded your decision on this payroll.");
    const a = await tx.payrollApproval.create({ data: { runId, versionId: version.id, contentHash: version.contentHash, round: run.approvalRound, clientId, portalUserId, approverName: user.name, approverEmail: user.email, decision: input.decision, comment, channel: meta.channel, verifiedBy: meta.verifiedBy, ip: meta.ip?.slice(0, 64) ?? null, userAgent: meta.userAgent?.slice(0, 300) ?? null, linkId: meta.linkId ?? null } });
    await event(tx, runId, input.decision, { portalUserId, name: user.name }, { versionNumber: version.number, note: comment });
    await audit(tx, { actorId: null, action: input.decision === "APPROVED" ? "payroll.approved_by_owner" : "payroll.denied_by_owner", entityType: "PayrollRun", entityId: runId, clientId, details: { portalUserId, approvalId: a.id, version: version.number, round: run.approvalRound, contentHash: version.contentHash, channel: meta.channel, verifiedBy: meta.verifiedBy } });
    let status = run.status;
    if (input.decision === "DENIED") {
      status = "DENIED";
      await tx.payrollRun.update({ where: { id: runId }, data: { status } });
    } else {
      const { required } = await requiredApprovers(clientId, tx);
      const approvals = await tx.payrollApproval.findMany({ where: { runId, round: run.approvalRound, versionId: version.id, contentHash: version.contentHash, decision: "APPROVED" } });
      if (required.length && required.every((r) => approvals.some((x) => x.portalUserId === r.portalUserId))) {
        status = "FULLY_APPROVED";
        await tx.payrollRun.update({ where: { id: runId }, data: { status, fullyApprovedAt: new Date() } });
        await event(tx, runId, "FULLY_APPROVED", { name: "All required approvers" }, { versionNumber: version.number, note: "Waiting for the office to submit it to the payroll provider" });
      }
    }
    return { approval: a, status, run };
  });
  if (out.status === "DENIED") await alertOffice(out.run, user.name, comment);
  return out;
}

/** A denial goes back to the office: a task for the client's assigned staff member (or unassigned). */
async function alertOffice(run: { id: string; clientId: string; createdById: string | null }, owner: string, comment: string | null) {
  const client = await prisma.client.findUniqueOrThrow({ where: { id: run.clientId }, select: { assignedToId: true, displayName: true, businessName: true } });
  const creator = run.createdById ?? (await prisma.user.findFirst({ where: { role: "ADMIN", active: true }, select: { id: true } }))?.id;
  if (!creator) return;
  await prisma.task.create({ data: { title: `Payroll denied by ${owner} — ${client.businessName || client.displayName}`, details: `Needs review. ${comment ?? ""}`.trim().slice(0, 1000), priority: "HIGH", clientId: run.clientId, assigneeId: client.assignedToId, createdById: creator } });
}

/**
 * The payroll operator submits a Fully Approved run to ADP/Paychex. Until the API connection is
 * authorized this records the submission done in the provider. Never automatic.
 */
export async function submitPayrollRun(actor: Actor, clientId: string, runId: string, input: { note?: string | null } = {}) {
  await assertStaff(actor);
  await assertPayrollWork(actor, clientId);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"payroll-run:" + runId}))`;
    const { run, version } = await loadRun(clientId, runId, tx);
    if (run.origin === "COETHA" && !(await canApproveCoethaWork(actor))) throw new ForbiddenError("This pay run was prepared by Coetha. Only Tabitha can approve Coetha's work.");
    if (LOCKED.has(run.status)) throw new ValidationError("This pay run was already submitted or processed.");
    const { all, required } = await requiredApprovers(clientId, tx);
    if (all.length) {
      if (run.status !== "FULLY_APPROVED") throw new ValidationError("Every required owner must approve this version before it's submitted.");
      const approvals = await tx.payrollApproval.findMany({ where: { runId, round: run.approvalRound, versionId: version.id, contentHash: version.contentHash, decision: "APPROVED" } });
      if (!required.every((r) => approvals.some((x) => x.portalUserId === r.portalUserId))) throw new ValidationError("The approvals no longer match the current version. Send it for approval again.");
    } else if (run.status !== "DRAFT") throw new ValidationError("This pay run isn't ready to submit.");
    const r = await tx.payrollRun.update({ where: { id: run.id }, data: { status: "SUBMITTED", submittedAt: new Date(), submittedById: actor.id, submissionMethod: "MANUAL_IN_PROVIDER", submissionNote: input.note?.trim().slice(0, 300) || null } });
    await event(tx, run.id, "SUBMITTED", { userId: actor.id, name: actor.name }, { versionNumber: version.number, note: `Submitted to ${run.provider.startsWith("ADP") ? "ADP" : run.provider === "PAYCHEX_FLEX" ? "Paychex" : "the payroll provider"} by the office (recorded; the API submission turns on once the provider connection is authorized).${input.note ? ` ${input.note}` : ""}` });
    await audit(tx, { actorId: actor.id, action: "payroll.run_submitted", entityType: "PayrollRun", entityId: run.id, clientId, details: { version: version.number, method: "MANUAL_IN_PROVIDER", approvalsRequired: all.length > 0 } });
    return r;
  });
}

// --- Owner views ---------------------------------------------------------------------------

/** A run as an approver may see it (employee lines only when the office allows it for them). */
export async function approverRunView(portalUserId: string, clientId: string, runId: string) {
  if (!(await isPayrollApprover(portalUserId, clientId))) throw new ForbiddenError("You're not a payroll approver for this business.");
  const { run, version } = await loadRun(clientId, runId);
  const approver = await prisma.payrollApprover.findUniqueOrThrow({ where: { clientId_portalUserId: { clientId, portalUserId } } });
  const decisions = await prisma.payrollApproval.findMany({ where: { runId, round: run.approvalRound }, orderBy: { createdAt: "asc" }, select: { approverName: true, decision: true, createdAt: true, portalUserId: true, versionId: true } });
  const mine = decisions.find((x) => x.portalUserId === portalUserId && x.versionId === version.id) ?? null;
  return { run, version: { ...version, lines: approver.showEmployeeDetail ? version.lines : [] }, showDetail: approver.showEmployeeDetail, decisions, mine, cost: payrollCost(version) };
}

export async function approverDashboard(portalUserId: string) {
  const approverRows = await prisma.payrollApprover.findMany({ where: { portalUserId, active: true }, include: { client: { select: { id: true, displayName: true, businessName: true } } } });
  const rows = [];
  for (const a of approverRows) if (await isPayrollApprover(portalUserId, a.clientId)) rows.push(a);
  const pending = await prisma.payrollRun.findMany({ where: { clientId: { in: rows.map((r) => r.clientId) }, status: "AWAITING_APPROVAL" }, orderBy: { checkDate: "asc" } });
  const history = await prisma.payrollApproval.findMany({ where: { portalUserId, clientId: { in: rows.map((r) => r.clientId) } }, orderBy: { createdAt: "desc" }, take: 25, include: { version: { select: { number: true, checkDate: true, grossCents: true, employerTaxCents: true } } } });
  const lastFallback = await prisma.payrollNotice.findFirst({ where: { portalUserId, status: "SKIPPED", channel: "SMS" }, orderBy: { createdAt: "desc" } });
  const user = await prisma.portalUser.findUniqueOrThrow({ where: { id: portalUserId }, select: { email: true, phoneNormalized: true } });
  const channels = await Promise.all(rows.map(async (r) => ({ clientId: r.clientId, ...(await channelsFor(r, user)) })));
  return { approvers: rows, pending, history, lastFallback, channels };
}

// --- Single-use links (text / email) ------------------------------------------------------

export type LinkState = "OK" | "USED" | "EXPIRED" | "CHANGED" | "COMPLETE" | "LOCKED" | "NOT_FOUND";
export const LINK_MESSAGES: Record<Exclude<LinkState, "OK">, string> = {
  USED: "This link was already used. Your decision is recorded — sign in to your portal to see it.",
  EXPIRED: "This link has expired. Sign in to your portal to review the payroll.",
  CHANGED: "This payroll has changed since this link was sent. A new link is sent when the new version is ready for you.",
  COMPLETE: "All required owners already approved this payroll. The office submits it for processing.",
  LOCKED: "This payroll was already processed, so decisions are closed.",
  NOT_FOUND: "This link isn't valid.",
};

export async function resolveLink(token: string) {
  const link = token && token.length > 20 ? await prisma.payrollApprovalLink.findUnique({ where: { tokenHash: sha(token) } }) : null;
  if (!link) return { state: "NOT_FOUND" as LinkState, link: null };
  const run = await prisma.payrollRun.findUnique({ where: { id: link.runId } });
  let state: LinkState = "OK";
  if (link.usedAt) state = "USED";
  else if (!run || LOCKED.has(run.status)) state = "LOCKED";
  else if (run.status === "FULLY_APPROVED" && run.currentVersionId === link.versionId && run.approvalRound === link.round) state = "COMPLETE";
  else if (run.currentVersionId !== link.versionId || run.approvalRound !== link.round || run.status !== "AWAITING_APPROVAL") state = "CHANGED";
  else if (link.expiresAt < new Date()) state = "EXPIRED";
  return { state, link };
}

async function okLink(token: string) {
  const r = await resolveLink(token);
  if (r.state !== "OK" || !r.link) throw new ValidationError(LINK_MESSAGES[r.state as Exclude<LinkState, "OK">]);
  return r.link;
}

/** Step 1 without a session: email a one-time code to the approver (existing code mechanism). */
export async function sendLinkCode(token: string) {
  const link = await okLink(token);
  return sendEmailCode({ kind: "portal", id: link.portalUserId }, "PAYROLL_APPROVAL");
}

/** Step 2: the code (or password + authenticator) proves who is deciding. Returns a nonce for this browser. */
export async function verifyLink(token: string, input: { code?: string; password?: string; authenticatorCode?: string }) {
  const link = await okLink(token);
  let verifiedBy: DecisionMeta["verifiedBy"];
  if (input.code) {
    const r = await verifyEmailCode({ kind: "portal", id: link.portalUserId }, "PAYROLL_APPROVAL", input.code.replace(/\s/g, ""));
    if (!r.ok) throw new ValidationError(r.reason === "expired" ? "That code expired. Send a new one." : r.reason === "too_many_attempts" ? "Too many tries. Send a new code." : "That code isn't right.");
    verifiedBy = "EMAIL_CODE";
  } else {
    const u = await prisma.portalUser.findUniqueOrThrow({ where: { id: link.portalUserId } });
    if (!u.passwordHash || !input.password || !(await verifyPassword(input.password, u.passwordHash))) throw new ValidationError("That password isn't right.");
    if (!u.mfaEnabledAt || !input.authenticatorCode || !(await verifySecondFactor({ kind: "portal", id: u.id }, input.authenticatorCode))) throw new ValidationError("Enter the code from your authenticator app (or use an emailed code).");
    verifiedBy = "PASSWORD_AND_AUTHENTICATOR";
  }
  const nonce = randomBytes(24).toString("base64url");
  await prisma.payrollApprovalLink.update({ where: { id: link.id }, data: { verifiedAt: new Date(), verifyNonceHash: `${verifiedBy}:${sha(nonce)}` } });
  return { nonce, verifiedBy };
}

/**
 * The decision from a link. Accepted only for the link's own approver, version and round; with
 * either that approver's signed-in portal session on this device or this browser's verification.
 * The link is consumed (single use).
 */
export async function decideByLink(token: string, input: { decision: "APPROVED" | "DENIED"; comment?: string | null; sessionPortalUserId?: string | null; nonce?: string | null; ip?: string | null; userAgent?: string | null }) {
  const link = await okLink(token);
  let verifiedBy: DecisionMeta["verifiedBy"];
  if (input.sessionPortalUserId && input.sessionPortalUserId === link.portalUserId) verifiedBy = "PORTAL_SESSION";
  else {
    const [how, hash] = (link.verifyNonceHash ?? "").split(":");
    const ok = !!(input.nonce && hash && link.verifiedAt && Date.now() - link.verifiedAt.getTime() < 30 * 60_000 && timingSafeEqual(Buffer.from(hash), Buffer.from(sha(input.nonce))));
    if (!ok) throw new ForbiddenError("Confirm it's you first.");
    verifiedBy = how as DecisionMeta["verifiedBy"];
  }
  const claimed = await prisma.payrollApprovalLink.updateMany({ where: { id: link.id, usedAt: null }, data: { usedAt: new Date() } });
  if (claimed.count !== 1) throw new ValidationError(LINK_MESSAGES.USED);
  try {
    return await decidePayroll(link.portalUserId, link.clientId, link.runId, { decision: input.decision, comment: input.comment, versionId: link.versionId }, { channel: link.channel === "SMS" ? "SMS_LINK" : "EMAIL_LINK", verifiedBy, ip: input.ip, userAgent: input.userAgent, linkId: link.id });
  } catch (e) {
    // A refused decision (e.g. missing comment) leaves the link usable.
    if (e instanceof ValidationError && !/already|changed|processed|isn't waiting/.test(e.message)) await prisma.payrollApprovalLink.update({ where: { id: link.id }, data: { usedAt: null } });
    throw e;
  }
}

/** The run summary behind a link (same content as the signed-in screen). */
export async function linkView(token: string) {
  const r = await resolveLink(token);
  if (!r.link) return { state: r.state, view: null, link: null };
  const view = await approverRunView(r.link.portalUserId, r.link.clientId, r.link.runId).catch(() => null);
  const client = await prisma.client.findUnique({ where: { id: r.link.clientId }, select: { displayName: true, businessName: true } });
  const user = await prisma.portalUser.findUnique({ where: { id: r.link.portalUserId }, select: { name: true, email: true, mfaEnabledAt: true } });
  return { state: r.state, view, link: r.link, business: client?.businessName || client?.displayName || "", approver: user };
}

// --- Text replies ---------------------------------------------------------------------------

export const PAYROLL_REPLY_RE = /^\s*(approve[ds]?|approval|deny|denied|reject(ed)?|yes|no|ok(ay)?)\b/i;

/**
 * "APPROVE"/"DENY" text replies are never accepted as decisions (a text can be spoofed and can't
 * carry identity verification). If the number belongs to an approver with payroll waiting, the
 * reply is a fresh secure link instead.
 */
export async function payrollTextReply(fromNormalized: string, body: string): Promise<string | null> {
  if (!PAYROLL_REPLY_RE.test(body)) return null;
  const users = await prisma.portalUser.findMany({ where: { phoneNormalized: fromNormalized, active: true }, select: { id: true } });
  for (const u of users) {
    const approvers = await prisma.payrollApprover.findMany({ where: { portalUserId: u.id, active: true } });
    for (const a of approvers) {
      if (!(await isPayrollApprover(u.id, a.clientId))) continue;
      const run = await prisma.payrollRun.findFirst({ where: { clientId: a.clientId, status: "AWAITING_APPROVAL" }, orderBy: { checkDate: "asc" } });
      if (!run) continue;
      if (await prisma.payrollApproval.count({ where: { runId: run.id, round: run.approvalRound, portalUserId: u.id } })) continue;
      const { url } = await prisma.$transaction((tx) => createLink(tx, run, u.id, "SMS"));
      return `TTurner Client Connect: For your security, payroll can't be approved by text reply. Review and approve or deny here: ${url}`;
    }
  }
  return null;
}

// --- Timeline ------------------------------------------------------------------------------

export async function runTimeline(actor: Actor, clientId: string, runId: string) {
  await assertStaff(actor);
  await assertPayrollWork(actor, clientId);
  const { run, version } = await loadRun(clientId, runId);
  const [events, versions, approvals, notices, approvers] = await Promise.all([
    prisma.payrollRunEvent.findMany({ where: { runId }, orderBy: { createdAt: "asc" } }),
    prisma.payrollRunVersion.findMany({ where: { runId }, orderBy: { number: "asc" }, select: { id: true, number: true, contentHash: true, createdAt: true, reason: true, grossCents: true, netPayCents: true, employerTaxCents: true } }),
    prisma.payrollApproval.findMany({ where: { runId }, orderBy: { createdAt: "asc" } }),
    prisma.payrollNotice.findMany({ where: { runId }, orderBy: { createdAt: "asc" } }),
    requiredApprovers(clientId),
  ]);
  const current = approvals.filter((a) => a.round === run.approvalRound && a.versionId === version.id);
  return { run, version, events, versions, approvals, current, notices, approvers };
}

export const checkDateText = (d: Date) => ymdOf(d);
