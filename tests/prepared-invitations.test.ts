import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import { addSuppression, createClient } from "@/lib/services/clients";
import { saveProfile } from "@/lib/services/bookkeeping-clients";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { applyActivationEmailEvent } from "@/lib/services/client-signup";
import { setOwnerSwitch } from "@/lib/services/owner-switches";
import {
  addClientsToBatch,
  approveInviteRows,
  confirmSharedEmail,
  createInviteBatch,
  editInviteRow,
  flagsFor,
  inviteBatchDetail,
  ON_HOLD_MESSAGE,
  removeInviteRow,
  rowStatusLabel,
  sendInviteBatch,
} from "@/lib/services/prepared-invitations";

// Local Resend stub — nothing leaves the machine; every "sent" email is captured here.
const sent: { to: string[]; text: string; subject: string }[] = [];
let failNext = false;
beforeEach(async () => {
  await resetDb();
  sent.length = 0;
  failNext = false;
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("EMAIL_FROM_ADDRESS", "TTurner & Associates <hello@mail.fictional.example>");
  vi.stubEnv("APP_URL", "https://portal.fictional.example");
  vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
    if (failNext) {
      failNext = false;
      return new Response(JSON.stringify({ message: "invalid recipient" }), { status: 422 });
    }
    sent.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ id: `re_${sent.length}` }), { status: 200 });
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function world() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const daria = await makeUser("STAFF", "Daria");
  const otherAdmin = await makeUser("ADMIN", "Avery");
  const rosa = await createClient(tabitha, { firstName: "Rosa", lastName: "Fictional", email: "rosa@fictional.example", clientType: "INDIVIDUAL", status: "ACTIVE" });
  const bakery = await createClient(tabitha, { businessName: "Pretend Bakery LLC", email: "owner@pretend-bakery.example", clientType: "BUSINESS", status: "ACTIVE" });
  await saveProfile(tabitha, bakery.id, { active: true, frequency: "MONTHLY", payroll: false });
  const noEmail = await createClient(tabitha, { firstName: "Nolan", lastName: "Nomail", clientType: "INDIVIDUAL", status: "ACTIVE" });
  return { tabitha, daria, otherAdmin, rosa, bakery, noEmail };
}

const authorize = (owner: Actor) => setOwnerSwitch(owner, "portalInvites", true);
const rowFor = (batchId: string, clientId: string) => prisma.portalInviteBatchRow.findFirstOrThrow({ where: { batchId, clientId } });

describe("Prepared invitations", () => {
  it("staff can prepare a batch but not approve or send it; Tabitha approves; nothing is emailed before approval", async () => {
    const { tabitha, daria, otherAdmin, rosa, bakery } = await world();
    const batch = await createInviteBatch(daria, { clientIds: [rosa.id, bakery.id], title: "Fictional rollout" });
    const rows = await prisma.portalInviteBatchRow.findMany({ where: { batchId: batch.id } });
    expect(rows.map((r) => [r.inviteeName, r.email, r.role]).sort()).toEqual([
      ["Pretend Bakery LLC", "owner@pretend-bakery.example", "OWNER"],
      ["Rosa Fictional", "rosa@fictional.example", "OWNER"],
    ]);
    // Defaults are the single-invite defaults for an owner.
    expect(rows[0].permissions).toEqual({ canMessage: true, canUpload: true, canViewTax: true, canViewContracts: true, canViewIdentity: true });

    await expect(approveInviteRows(daria, batch.id, "ALL")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(approveInviteRows(otherAdmin, batch.id, "ALL")).rejects.toBeInstanceOf(ForbiddenError); // an Admin isn't the primary owner
    await authorize(tabitha);
    await expect(sendInviteBatch(daria, batch.id)).rejects.toBeInstanceOf(ForbiddenError);
    // Tabitha presses Send before approving: nothing is approved, so nothing goes out.
    await expect(sendInviteBatch(tabitha, batch.id)).rejects.toThrow(/no approved invitations/);
    expect(sent).toHaveLength(0);
    expect(await prisma.portalInvite.count()).toBe(0);

    const r = await approveInviteRows(tabitha, batch.id, "ALL");
    expect(r.approved).toBe(2);
    expect(sent).toHaveLength(0); // approval alone sends nothing

    const audits = (await prisma.auditLog.findMany({ where: { action: { startsWith: "portal_invites." } }, select: { action: true } })).map((a) => a.action);
    expect(audits).toEqual(expect.arrayContaining(["portal_invites.batch_created", "portal_invites.rows_added", "portal_invites.approved"]));
  });

  it("Send is refused while “Portal invitations authorized” is off, and is audited when turned on", async () => {
    const { tabitha, daria, rosa } = await world();
    const batch = await createInviteBatch(daria, { clientIds: [rosa.id] });
    await approveInviteRows(tabitha, batch.id, "ALL");
    await expect(sendInviteBatch(tabitha, batch.id)).rejects.toThrow(ON_HOLD_MESSAGE);
    expect(sent).toHaveLength(0);
    expect((await rowFor(batch.id, rosa.id)).sendStartedAt).toBeNull();
    await expect(setOwnerSwitch(daria, "portalInvites", true)).rejects.toBeInstanceOf(ForbiddenError);
    await authorize(tabitha);
    expect(await prisma.auditLog.count({ where: { action: "portal_invites.authorized_on" } })).toBe(1);
    expect(await prisma.ownerAuditLog.count({ where: { action: "portal_invites.authorized_on" } })).toBe(1);
    await sendInviteBatch(tabitha, batch.id);
    expect(sent.map((m) => m.to[0])).toEqual(["rosa@fictional.example"]);
  });

  it("send goes through invitePortalUser + the activation email, records SENT honestly, and is idempotent per row", async () => {
    const { tabitha, daria, rosa, bakery } = await world();
    const batch = await createInviteBatch(daria, { clientIds: [rosa.id, bakery.id] });
    const bakeryRow = await rowFor(batch.id, bakery.id);
    // Staff choose permissions before inviting (no contracts for the bakery login).
    await editInviteRow(daria, bakeryRow.id, { inviteeName: "Pat Pretend", email: "owner@pretend-bakery.example", role: "OWNER", permissions: { canViewContracts: false } });
    await approveInviteRows(tabitha, batch.id, "ALL");
    await authorize(tabitha);
    failNext = true; // the first email (Rosa's) is refused by the provider
    const t = await sendInviteBatch(tabitha, batch.id);
    expect(t).toMatchObject({ SENT: 1, EMAIL_FAILED: 1 });

    const rosaRow = await rowFor(batch.id, rosa.id);
    expect(rosaRow.result).toBe("EMAIL_FAILED");
    expect(rosaRow.resultDetail).toMatch(/refused the message/);
    const bRow = await rowFor(batch.id, bakery.id);
    expect(bRow.result).toBe("SENT");
    const invite = await prisma.portalInvite.findUniqueOrThrow({ where: { id: bRow.portalInviteId! } });
    expect([invite.email, invite.name, invite.sentByEmail, invite.emailStatus, invite.emailProviderId]).toEqual(["owner@pretend-bakery.example", "Pat Pretend", true, "SENT", "re_1"]);
    expect(rowStatusLabel(bRow, invite).label).toMatch(/accepted by the email provider/); // never "Delivered" yet
    expect(await prisma.auditLog.count({ where: { action: "portal.invited", clientId: bakery.id } })).toBe(1); // the single-invite path's own audit

    // Resend's signed webhook later reports delivery; the row shows it from the invitation.
    await applyActivationEmailEvent("email.delivered", "re_1");
    const delivered = await prisma.portalInvite.findUniqueOrThrow({ where: { id: invite.id } });
    expect(rowStatusLabel(bRow, delivered).label).toMatch(/^Delivered/);

    // Pressing Send again never re-invites a processed row.
    await expect(sendInviteBatch(tabitha, batch.id)).rejects.toThrow(/no approved invitations/);
    expect(sent).toHaveLength(1);
    expect(await prisma.portalInvite.count({ where: { clientId: bakery.id } })).toBe(1);

    // Two Sends racing: each row is claimed once.
    const b2 = await createInviteBatch(daria, { clientIds: [rosa.id] });
    await approveInviteRows(tabitha, b2.id, "ALL");
    await Promise.allSettled([sendInviteBatch(tabitha, b2.id), sendInviteBatch(tabitha, b2.id)]);
    expect(sent.filter((m) => m.to[0] === "rosa@fictional.example")).toHaveLength(1);

    // The new login starts with the permissions chosen in the batch, and never the business view.
    const token = /\/client\/invite\/([A-Za-z0-9_-]+)/.exec(sent[0].text)![1];
    const user = await acceptPortalInvite(token, "Pretend-Bakery-Pass-2026");
    const access = await prisma.portalAccess.findFirstOrThrow({ where: { portalUserId: user.id, clientId: bakery.id } });
    expect([access.canViewContracts, access.canViewTax, access.canMessage, access.canViewBookkeeping]).toEqual([false, true, true, false]);
    const results = (await prisma.auditLog.findMany({ where: { action: "portal_invites.row_result" } })).map((a) => (a.details as { result: string }).result).sort();
    expect(results).toEqual(["EMAIL_FAILED", "SENT", "SENT"]);
  });

  it("a duplicate or shared email is flagged and blocks approval until resolved", async () => {
    const { tabitha, daria, rosa } = await world();
    const twin = await createClient(tabitha, { businessName: "Rosa's Pretend Studio", email: "rosa@fictional.example", clientType: "BUSINESS", status: "ACTIVE" });
    const batch = await createInviteBatch(daria, { clientIds: [rosa.id, twin.id] });
    const rows = await prisma.portalInviteBatchRow.findMany({ where: { batchId: batch.id } });
    const flags = await flagsFor(rows);
    for (const r of rows) expect(flags.get(r.id)!.find((f) => f.code === "SHARED_EMAIL")).toMatchObject({ blocking: true });
    await expect(approveInviteRows(tabitha, batch.id, "ALL")).rejects.toThrow(/fix or remove/);
    const sel = await approveInviteRows(tabitha, batch.id, { rowIds: rows.map((r) => r.id) });
    expect([sel.approved, sel.blocked.length]).toEqual([0, 2]);
    expect(sel.blocked[0].reasons[0]).toMatch(/possible duplicate or shared email/);

    // Fixed one way: the studio row gets its own address. Rosa's row is still flagged by the other record.
    const studio = rows.find((r) => r.clientId === twin.id)!;
    await editInviteRow(daria, studio.id, { inviteeName: "Rosa Fictional", email: "studio@fictional.example", role: "OWNER", permissions: {} });
    const rosaRow = rows.find((r) => r.clientId === rosa.id)!;
    await expect(approveInviteRows(tabitha, batch.id, "ALL")).rejects.toThrow(/fix or remove/);
    // ...or the other way: someone confirms it's the same person.
    await confirmSharedEmail(daria, rosaRow.id);
    expect((await approveInviteRows(tabitha, batch.id, "ALL")).approved).toBe(2);
    expect(await prisma.auditLog.count({ where: { action: "portal_invites.shared_email_confirmed" } })).toBe(1);
    // Editing a row clears its approval.
    await editInviteRow(daria, studio.id, { inviteeName: "Rosa F.", email: "studio@fictional.example", role: "OWNER", permissions: {} });
    expect((await prisma.portalInviteBatchRow.findUniqueOrThrow({ where: { id: studio.id } })).approvedAt).toBeNull();
  });

  it("a row with no email is blocked; once an email is added it can be approved", async () => {
    const { tabitha, daria, noEmail } = await world();
    const batch = await createInviteBatch(daria, { clientIds: [noEmail.id] });
    const row = await rowFor(batch.id, noEmail.id);
    expect((await flagsFor([row])).get(row.id)!.find((f) => f.code === "NO_EMAIL")).toMatchObject({ blocking: true, label: "No email on file" });
    await expect(approveInviteRows(tabitha, batch.id, "ALL")).rejects.toThrow(/fix or remove/);
    await expect(editInviteRow(daria, row.id, { inviteeName: "Nolan Nomail", email: "not-an-email", role: "OWNER", permissions: {} })).rejects.toThrow(/valid email/);
    await editInviteRow(daria, row.id, { inviteeName: "Nolan Nomail", email: "Nolan@Fictional.Example ", role: "OWNER", permissions: {} });
    expect((await rowFor(batch.id, noEmail.id)).email).toBe("nolan@fictional.example");
    const flags = (await flagsFor([await rowFor(batch.id, noEmail.id)])).get(row.id)!;
    expect(flags.find((f) => f.code === "NOT_ON_RECORD")).toMatchObject({ blocking: false });
    expect((await approveInviteRows(tabitha, batch.id, "ALL")).approved).toBe(1);
  });

  it("do-not-contact and bounced addresses block approval; a promotional unsubscribe doesn't", async () => {
    const { tabitha, daria, rosa, bakery } = await world();
    await addSuppression(tabitha, "EMAIL", "rosa@fictional.example", "MANUAL", "Asked for no email");
    await addSuppression(tabitha, "EMAIL", "owner@pretend-bakery.example", "UNSUBSCRIBE");
    const batch = await createInviteBatch(daria, { clientIds: [rosa.id, bakery.id] });
    const rows = await prisma.portalInviteBatchRow.findMany({ where: { batchId: batch.id } });
    const flags = await flagsFor(rows);
    expect(flags.get(rows.find((r) => r.clientId === rosa.id)!.id)!.find((f) => f.code === "SUPPRESSED")?.label).toBe("Do not contact: On the do-not-contact list");
    expect(flags.get(rows.find((r) => r.clientId === bakery.id)!.id)!.some((f) => f.code === "SUPPRESSED")).toBe(false);
  });

  it("a client not on Bookkeeping Clients never gets bookkeeping (business view) permissions from a batch", async () => {
    const { tabitha, daria, rosa, bakery } = await world();
    const batch = await createInviteBatch(daria, { clientIds: [rosa.id, bakery.id] });
    const rows = await prisma.portalInviteBatchRow.findMany({ where: { batchId: batch.id } });
    const flags = await flagsFor(rows);
    expect(flags.get(rows.find((r) => r.clientId === rosa.id)!.id)!.some((f) => f.code === "BOOKKEEPING_NO")).toBe(true);
    expect(flags.get(rows.find((r) => r.clientId === bakery.id)!.id)!.some((f) => f.code === "BOOKKEEPING_YES")).toBe(true);
    const rosaRow = rows.find((r) => r.clientId === rosa.id)!;
    // Nobody can choose it in a batch, not even Tabitha, and not by sneaking it into the stored row.
    await expect(editInviteRow(tabitha, rosaRow.id, { inviteeName: "Rosa", email: "rosa@fictional.example", role: "OWNER", permissions: { canViewBookkeeping: true } })).rejects.toThrow(/turned on separately/);
    await prisma.portalInviteBatchRow.update({ where: { id: rosaRow.id }, data: { permissions: { canMessage: true, canViewBookkeeping: true } } });
    await approveInviteRows(tabitha, batch.id, "ALL");
    await authorize(tabitha);
    await sendInviteBatch(tabitha, batch.id);
    const rosaMail = sent.find((m) => m.to[0] === "rosa@fictional.example")!;
    const user = await acceptPortalInvite(/\/client\/invite\/([A-Za-z0-9_-]+)/.exec(rosaMail.text)![1], "Rosa-Fictional-Pass-2026");
    const access = await prisma.portalAccess.findFirstOrThrow({ where: { portalUserId: user.id } });
    expect(access.canViewBookkeeping).toBe(false);
    expect((await prisma.portalInvite.findFirstOrThrow({ where: { clientId: rosa.id } })).permissions).toMatchObject({ canViewBookkeeping: false });
    // Only an Admin may change who sees ID documents (as on the Portal tab).
    const b2 = await createInviteBatch(daria, { clientIds: [bakery.id] });
    const r2 = await rowFor(b2.id, bakery.id);
    await expect(editInviteRow(daria, r2.id, { inviteeName: "Pat", email: "owner@pretend-bakery.example", role: "OWNER", permissions: { canViewIdentity: false } })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("rows that already have portal access are flagged, and rows that gain access before Send are skipped", async () => {
    const { tabitha, daria, rosa, bakery } = await world();
    const { token } = await invitePortalUser(tabitha, rosa.id, { email: "rosa@fictional.example", name: "Rosa", role: "OWNER" });
    await acceptPortalInvite(token!, "Rosa-Fictional-Pass-2026");
    const batch = await createInviteBatch(daria, { clientIds: [rosa.id, bakery.id] });
    const rosaRow = await rowFor(batch.id, rosa.id);
    expect((await flagsFor([rosaRow])).get(rosaRow.id)!.find((f) => f.code === "HAS_ACCESS")).toMatchObject({ blocking: true, label: "Already has portal access" });
    await expect(approveInviteRows(tabitha, batch.id, "ALL")).rejects.toThrow(/fix or remove/);
    await removeInviteRow(daria, rosaRow.id);
    expect(await prisma.auditLog.count({ where: { action: "portal_invites.row_removed" } })).toBe(1);

    await approveInviteRows(tabitha, batch.id, "ALL");
    // Meanwhile the bakery owner gets in another way (the Portal tab).
    const { token: t2 } = await invitePortalUser(daria, bakery.id, { email: "owner@pretend-bakery.example", name: "Pat", role: "OWNER" });
    await acceptPortalInvite(t2!, "Pretend-Bakery-Pass-2026");
    await authorize(tabitha);
    const t = await sendInviteBatch(tabitha, batch.id);
    expect(t).toMatchObject({ SENT: 0, SKIPPED: 1 });
    const row = await rowFor(batch.id, bakery.id);
    expect([row.result, row.resultDetail]).toEqual(["SKIPPED", "Already has portal access."]);
    expect(sent).toHaveLength(0);
  });

  it("an invitation already emailed and still open blocks a second invitation from another batch", async () => {
    const { tabitha, daria, rosa } = await world();
    const b1 = await createInviteBatch(daria, { clientIds: [rosa.id] });
    const b2 = await createInviteBatch(daria, { clientIds: [rosa.id] });
    await approveInviteRows(tabitha, b1.id, "ALL");
    await approveInviteRows(tabitha, b2.id, "ALL");
    await authorize(tabitha);
    await sendInviteBatch(tabitha, b1.id);
    const t = await sendInviteBatch(tabitha, b2.id);
    expect(t).toMatchObject({ SENT: 0, SKIPPED: 1 });
    expect((await rowFor(b2.id, rosa.id)).resultDetail).toMatch(/already emailed/);
    expect(sent).toHaveLength(1);
    // The detail screen shows counts and plain-word permissions.
    const d = await inviteBatchDetail(b1.id);
    expect(d!.rows[0].perms).toMatchObject({ canViewTax: true });
    expect(await addClientsToBatch(daria, b1.id, [rosa.id])).toEqual({ added: 0, alreadyIn: 1 });
  });
});
