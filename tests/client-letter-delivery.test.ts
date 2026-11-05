import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, managed, prisma, resetDb } from "./db";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import { resendSignatureFor } from "@/lib/resend-webhook";

// Coetha's daily run on CSV-imported rows (no Plaid, no notice gate), the owner's "Client rollout
// authorized" lock on Client Letters, and honest letter delivery: provider events, first view by
// the client's own login, and the optional acknowledgment. Email and Anthropic are stubbed;
// nothing leaves this test. Fictional businesses, people and transactions only.

const mail = vi.hoisted(() => ({ sent: [] as { to: string; subject: string }[] }));
vi.mock("@/lib/email", async (orig) => {
  const real = await orig<typeof import("@/lib/email")>();
  return {
    ...real,
    sendEmail: vi.fn(async (input: { to: string; subject: string }) => {
      mail.sent.push({ to: input.to, subject: input.subject });
      return { ok: true, providerId: `email_fict_${mail.sent.length}` };
    }),
    sendTransactionalEmail: vi.fn(async () => true),
  };
});
// Who is signed in, for the document route: a staff session and/or a client portal session.
const who = vi.hoisted(() => ({ staff: null as Actor | null, portal: null as { id: string; name: string; email: string } | null }));
vi.mock("@/lib/auth/session", async (orig) => ({ ...(await orig<typeof import("@/lib/auth/session")>()), getCurrentUser: async () => who.staff, clientIp: async () => "127.0.0.1" }));
vi.mock("@/lib/portal/session", async (orig) => ({ ...(await orig<typeof import("@/lib/portal/session")>()), getPortalUser: async () => who.portal }));

const { createClient } = await import("@/lib/services/clients");
const { saveProfile } = await import("@/lib/services/bookkeeping-clients");
const { setupLedger, importBankCsv } = await import("@/lib/services/ledger");
const { setOwnerSwitch, clientRolloutAuthorized } = await import("@/lib/services/owner-switches");
const { setCoethaOptOut } = await import("@/lib/services/coetha-opt-out");
const { runCoetha, runDailyCoetha } = await import("@/lib/services/coetha");
const L = await import("@/lib/services/client-letters");
const { downloadToken } = await import("@/lib/services/documents");
const { portalConversations } = await import("@/lib/services/messaging");
const { POST: resendWebhook } = await import("@/app/api/webhooks/resend/route");
const { GET: documentRoute } = await import("@/app/api/documents/[token]/route");

let calls: string[] = [];
beforeEach(async () => {
  await resetDb();
  mail.sent = [];
  calls = [];
  who.staff = null;
  who.portal = null;
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-fictional-key";
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
    if (u.host !== "api.anthropic.com") throw new Error(`Unexpected request: ${u.href}`);
    calls.push(String(init?.body ?? ""));
    const req = JSON.parse(String(init?.body));
    const output = { categories: [], discrepancies: [], adjustingEntries: [], monthSummary: { month: "2026-10", summary: "SECRET_PROPOSAL_SUMMARY a quiet fictional month.", highlights: [] } };
    return new Response(JSON.stringify({ id: "msg_fictional", type: "message", role: "assistant", model: req.model, content: [{ type: "text", text: JSON.stringify(output) }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } }), { status: 200, headers: { "content-type": "application/json", "request-id": "req_fictional" } });
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete process.env.ANTHROPIC_API_KEY;
});

const CSV = (rows: string[]) => ["Date,Description,Amount", ...rows].join("\n");

async function office() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const admin = await makeUser("ADMIN", "Second Admin");
  const daria = await makeUser("STAFF", "Daria");
  return { tabitha, admin, daria };
}

async function books(o: Awaited<ReturnType<typeof office>>, names: string[]) {
  const out = [];
  for (const n of names) {
    const c = await createClient(o.tabitha, { businessName: n, clientType: "BUSINESS", status: "ACTIVE" });
    await managed(c.id);
    await setupLedger(o.tabitha, c.id, { basis: "CASH" });
    const checking = (await prisma.ledgerAccount.findFirstOrThrow({ where: { clientId: c.id, code: "1000" } })).id;
    await importBankCsv(o.tabitha, c.id, checking, { fileName: "oct.csv", text: CSV(["10/02/2026,OFFICE SUPPLY PRETEND,-84.20"]) });
    out.push({ ...c, checking });
  }
  return out;
}

describe("daily Coetha run works from CSV imports (no Plaid) and has no notice gate", () => {
  it("picks CSV-only businesses with fresh rows; keeps 20-hour spacing, 2 per hour, opt-out, switch and key", async () => {
    const o = await office();
    const [a, b, c, d] = await books(o, ["Alder Pretend LLC", "Birch Pretend LLC", "Cedar Pretend LLC", "Dogwood Pretend LLC"]);
    expect(await prisma.bankTransaction.count({ where: { source: { not: "CSV" } } })).toBe(0);
    expect(await prisma.clientLetter.count()).toBe(0); // no letters were ever sent: Coetha still runs
    expect(await runDailyCoetha()).toMatchObject({ ran: 0, skipped: "switched off" });
    await setOwnerSwitch(o.tabitha, "coetha", true);
    delete process.env.ANTHROPIC_API_KEY;
    expect(await runDailyCoetha()).toMatchObject({ ran: 0, skipped: "no API key" });
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-fictional-key";

    await setCoethaOptOut(o.tabitha, d.id, { toldOn: "2026-11-03", via: "PHONE" });
    const first = await runDailyCoetha();
    expect(first).toMatchObject({ ran: 2, failed: 0 }); // at most 2 an hour
    const second = await runDailyCoetha();
    expect(second).toMatchObject({ ran: 1, failed: 0 }); // the third; the opted-out client is never picked
    expect(await runDailyCoetha()).toMatchObject({ ran: 0 }); // all ran within 20 hours
    const ran = new Set((await prisma.coethaRun.findMany({ select: { clientId: true } })).map((r) => r.clientId));
    expect(ran).toEqual(new Set([a.id, b.id, c.id]));
    expect(calls).toHaveLength(3);

    // A new CSV import after the run, 21 hours later, is picked up again; no new rows, no run.
    await importBankCsv(o.tabitha, a.id, a.checking, { fileName: "nov.csv", text: CSV(["11/02/2026,PAPER PRETEND CO,-12.00"]) });
    const later = new Date(Date.now() + 21 * 3600_000);
    expect(await runDailyCoetha(later)).toMatchObject({ ran: 1 });
    expect(await prisma.coethaRun.count({ where: { clientId: a.id } })).toBe(2);
    // Manual runs need no letter either; the opt-out still wins.
    await expect(runCoetha(o.tabitha, d.id, { month: "2026-10", today: "2026-11-04" })).rejects.toThrow(/prefers no Coetha/);
  });
});

async function letterSetup() {
  const o = await office();
  const mk = (businessName: string, email?: string) => createClient(o.tabitha, { businessName, clientType: "BUSINESS", status: "ACTIVE", ...(email ? { email } : {}) });
  const bakery = await mk("Magnolia Pretend Bakery LLC");
  const jordan = await prisma.portalUser.create({ data: { email: "jordan@bakery.example", name: "Jordan Example", passwordHash: "x" } });
  await prisma.portalAccess.create({ data: { portalUserId: jordan.id, clientId: bakery.id, role: "OWNER" } });
  const garden = await mk("Garden Pretend LLC");
  const riley = await prisma.portalUser.create({ data: { email: "riley@garden.example", name: "Riley Sample", passwordHash: "x" } });
  await prisma.portalAccess.create({ data: { portalUserId: riley.id, clientId: garden.id, role: "OWNER" } });
  const paper = await mk("Paper Only Pretend Co"); // no email, no portal
  for (const c of [bakery, garden, paper]) await saveProfile(o.tabitha, c.id, { active: true, frequency: "MONTHLY", payroll: false });
  return { ...o, bakery, garden, paper, jordan, riley };
}
const portalActor = (u: { id: string; name: string; email: string }) => ({ id: u.id, name: u.name, email: u.email });

describe("Client rollout authorized: the owner's safety lock on Client Letters", () => {
  it("is off by default: preparing and previewing work, Send and Send again are refused, nothing goes out", async () => {
    const s = await letterSetup();
    expect(await clientRolloutAuthorized()).toBe(false);
    const batch = await L.prepareLetterBatch(s.tabitha);
    const letters = await prisma.clientLetter.findMany({ where: { batchId: batch.id } });
    expect(letters).toHaveLength(3);
    expect((await L.letterPdf(s.tabitha, letters[0].id))?.bytes.byteLength).toBeGreaterThan(500);
    await expect(L.sendLetterBatch(s.tabitha, batch.id, "SEND")).rejects.toThrow(L.ROLLOUT_ON_HOLD);
    expect(L.ROLLOUT_ON_HOLD).toBe("Client letters are on hold until you authorize the client rollout.");
    // Nothing was claimed, filed, posted or emailed.
    expect((await prisma.clientLetterBatch.findUniqueOrThrow({ where: { id: batch.id } })).status).toBe("DRAFT");
    expect(await prisma.clientLetter.count({ where: { status: { not: "DRAFT" } } })).toBe(0);
    expect(await prisma.document.count()).toBe(0);
    expect(await prisma.message.count()).toBe(0);
    expect(mail.sent).toHaveLength(0);
  });

  it("only the owner changes it (audited); on, sending works; back on hold, Send again is refused", async () => {
    const s = await letterSetup();
    await expect(setOwnerSwitch(s.admin, "clientRollout", true)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setOwnerSwitch(s.daria, "clientRollout", true)).rejects.toBeInstanceOf(ForbiddenError);
    await setOwnerSwitch(s.tabitha, "clientRollout", true);
    expect(await prisma.auditLog.count({ where: { action: "client_letters.rollout_authorized_on", actorId: s.tabitha.id } })).toBe(1);
    expect(await prisma.ownerAuditLog.count({ where: { action: "client_letters.rollout_authorized_on" } })).toBe(1);
    const batch = await L.prepareLetterBatch(s.tabitha);
    await L.sendLetterBatch(s.tabitha, batch.id, "SEND");
    expect(mail.sent).toHaveLength(2);
    await setOwnerSwitch(s.tabitha, "clientRollout", false);
    expect(await prisma.auditLog.count({ where: { action: "client_letters.rollout_authorized_off" } })).toBe(1);
    const one = await prisma.clientLetter.findFirstOrThrow({ where: { clientId: s.bakery.id } });
    await expect(L.resendLetter(s.tabitha, one.id, "SEND")).rejects.toThrow(L.ROLLOUT_ON_HOLD);
    expect(mail.sent).toHaveLength(2);
    expect(await prisma.clientLetter.count()).toBe(3);
  });
});

async function sent() {
  const s = await letterSetup();
  await setOwnerSwitch(s.tabitha, "clientRollout", true);
  const batch = await L.prepareLetterBatch(s.tabitha);
  await L.sendLetterBatch(s.tabitha, batch.id, "SEND");
  const of = (clientId: string) => prisma.clientLetter.findFirstOrThrow({ where: { clientId } });
  return { ...s, of };
}

const SECRET = "whsec_" + Buffer.from("fictional-letter-webhook-secret").toString("base64");
function hook(payload: object) {
  const body = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  return resendWebhook(new Request("https://crm.example.com/api/webhooks/resend", { method: "POST", body, headers: { "svix-id": "msg_l1", "svix-timestamp": ts, "svix-signature": resendSignatureFor(SECRET, "msg_l1", ts, body) } }));
}

describe("honest delivery status", () => {
  it("SENT means filed, posted and email ACCEPTED; with no provider events it never reads as delivered", async () => {
    const s = await sent();
    const l = await s.of(s.bakery.id);
    expect(l.status).toBe("SENT");
    expect(L.LETTER_STATUS.SENT).toBe("Filed & posted; email accepted by email service");
    expect(Object.values(L.LETTER_STATUS).join(" ")).not.toMatch(/delivered/i);
    expect(l.filedAt).not.toBeNull();
    expect(l.portalPostedAt).not.toBeNull();
    const f = L.letterFacts(l);
    expect(f.email).toBe("ACCEPTED");
    expect(f.emailDeliveredAt).toBeNull();
    expect(f.flags).toEqual([]);
    // No webhook secret (not set in production yet): events are refused and nothing changes.
    expect((await hook({ type: "email.delivered", data: { email_id: l.emailProviderId } })).status).toBe(503);
    expect(L.letterFacts(await s.of(s.bakery.id)).email).toBe("ACCEPTED");
    // The no-email client needs physical delivery.
    const paper = await s.of(s.paper.id);
    expect(paper.status).toBe("NO_EMAIL");
    expect(L.letterFacts(paper).flags).toEqual(["NEEDS_PHYSICAL_DELIVERY"]);
    await L.markLetterMailed(s.tabitha, paper.id, "2026-11-05");
    expect(L.letterFacts(await s.of(s.paper.id)).flags).toEqual([]);
  });

  it("a signed delivered event records delivery; a bounce moves it to EMAIL_FAILED and flags follow-up", async () => {
    vi.stubEnv("RESEND_WEBHOOK_SECRET", SECRET);
    const s = await sent();
    const ok = await s.of(s.bakery.id);
    const bad = await s.of(s.garden.id);
    expect((await hook({ type: "email.delivered", data: { email_id: ok.emailProviderId } })).status).toBe(204);
    const okNow = await s.of(s.bakery.id);
    expect(okNow.emailDeliveredAt).not.toBeNull();
    expect(okNow.status).toBe("SENT");
    expect(L.letterFacts(okNow).email).toBe("DELIVERED");

    await hook({ type: "email.bounced", data: { email_id: bad.emailProviderId, to: ["riley@garden.example"], bounce: { message: "Mailbox does not exist (fictional)", type: "Permanent" } } });
    const b = await s.of(s.garden.id);
    expect(b.status).toBe("EMAIL_FAILED");
    expect(b.emailBouncedAt).not.toBeNull();
    expect(b.followUpFlaggedAt).not.toBeNull();
    expect(b.followUpReason).toMatch(/bounced.*Mailbox does not exist/);
    expect(L.letterFacts(b).flags).toContain("EMAIL_BOUNCED");
    // A late "delivered" never undoes the bounce.
    await hook({ type: "email.delivered", data: { email_id: bad.emailProviderId } });
    expect((await s.of(s.garden.id)).emailDeliveredAt).toBeNull();
    // The owner sees it in the flagged list; recording it as mailed clears the flag.
    const v = await L.clientLettersView(s.tabitha);
    expect(v.flagged.map((x) => x.l.clientId).sort()).toEqual([s.garden.id, s.paper.id].sort());
    await L.markLetterMailed(s.tabitha, b.id, "2026-11-06");
    expect((await L.clientLettersView(s.tabitha)).flagged.map((x) => x.l.clientId)).toEqual([s.paper.id]);
    expect(await prisma.auditLog.count({ where: { action: "client_letter.email_bounced", entityId: b.id } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: "client_letter.email_delivered", entityId: ok.id } })).toBe(1);
  });

  it("a complaint flags follow-up; not opened after 14 days is flagged", async () => {
    const s = await sent();
    const l = await s.of(s.bakery.id);
    expect(await L.applyLetterEmailEvent("email.complained", l.emailProviderId!)).toBe(true);
    expect(L.letterFacts(await s.of(s.bakery.id)).flags).toContain("EMAIL_COMPLAINT");
    expect(await L.applyLetterEmailEvent("email.delivered", "email_unknown_fictional")).toBe(false);
    const g = await s.of(s.garden.id);
    expect(L.letterFacts(g, { now: new Date(g.sentAt!.getTime() + 15 * 86_400_000) }).flags).toEqual(["NOT_VIEWED"]);
    expect(L.letterFacts(g, { now: new Date(g.sentAt!.getTime() + 13 * 86_400_000) }).flags).toEqual([]);
  });
});

describe("first view and the optional acknowledgment (the client's own login only)", () => {
  it("records the first view from the client's portal (thread or PDF), never from a staff download", async () => {
    const s = await sent();
    const l = await s.of(s.bakery.id);
    await prisma.document.update({ where: { id: l.documentId! }, data: { scanStatus: "CLEAN" } });
    // Staff opening the filed PDF (also what View as Client uses) is not a view.
    who.staff = s.tabitha;
    const staffRes = await documentRoute(new Request("https://crm.example.com/x"), { params: Promise.resolve({ token: downloadToken(l.documentId!, { staffId: s.tabitha.id }) }) });
    expect(staffRes.status).toBe(200);
    expect((await s.of(s.bakery.id)).firstViewedAt).toBeNull();
    // Another client's login gets nothing and records nothing.
    who.staff = null;
    who.portal = portalActor(s.riley);
    const other = await documentRoute(new Request("https://crm.example.com/x"), { params: Promise.resolve({ token: downloadToken(l.documentId!, { portalUserId: s.riley.id }) }) });
    expect(other.status).toBe(403);
    expect((await s.of(s.bakery.id)).firstViewedAt).toBeNull();
    // The client's own login opening the PDF.
    who.portal = portalActor(s.jordan);
    const res = await documentRoute(new Request("https://crm.example.com/x"), { params: Promise.resolve({ token: downloadToken(l.documentId!, { portalUserId: s.jordan.id }) }) });
    expect(res.status).toBe(200);
    const viewed = await s.of(s.bakery.id);
    expect(viewed.firstViewedAt).not.toBeNull();
    expect(viewed).toMatchObject({ firstViewedByPortalUserId: s.jordan.id, firstViewedVia: "DOCUMENT" });
    // Only the first view is kept.
    await L.recordLetterViewed(s.jordan.id, s.bakery.id, { messageIds: [l.messageId!] });
    expect((await s.of(s.bakery.id)).firstViewedAt).toEqual(viewed.firstViewedAt);
    expect(await prisma.auditLog.count({ where: { action: "client_letter.first_viewed" } })).toBe(1);
    // The Message Center path (what the client's thread page calls).
    const g = await s.of(s.garden.id);
    const found = await L.portalLettersForMessages(portalActor(s.riley), s.garden.id, [g.messageId!]);
    expect(found.map((x) => x.id)).toEqual([g.id]);
    await L.recordLetterViewed(s.riley.id, s.garden.id, { messageIds: found.map((x) => x.messageId!) });
    expect(await s.of(s.garden.id)).toMatchObject({ firstViewedVia: "MESSAGE", firstViewedByPortalUserId: s.riley.id });
  });

  it("acknowledgment is optional, idempotent, audited and isolated per client", async () => {
    const s = await sent();
    const l = await s.of(s.bakery.id);
    // Jordan can't acknowledge, or even look up, Garden's letter.
    const g = await s.of(s.garden.id);
    await expect(L.acknowledgeClientLetter(portalActor(s.jordan), g.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(L.portalLettersForMessages(portalActor(s.jordan), s.garden.id, [g.messageId!])).rejects.toBeInstanceOf(ForbiddenError);
    expect(await L.portalLettersForMessages(portalActor(s.jordan), s.bakery.id, [g.messageId!])).toEqual([]);
    expect(await L.acknowledgeClientLetter(portalActor(s.jordan), l.id)).toEqual({ already: false });
    const first = await s.of(s.bakery.id);
    expect(first.acknowledgedAt).not.toBeNull();
    expect(first.acknowledgedByPortalUserId).toBe(s.jordan.id);
    expect(await L.acknowledgeClientLetter(portalActor(s.jordan), l.id)).toEqual({ already: true });
    expect((await s.of(s.bakery.id)).acknowledgedAt).toEqual(first.acknowledgedAt);
    expect(await prisma.auditLog.count({ where: { action: "client_letter.acknowledged" } })).toBe(1);
    expect((await s.of(s.garden.id)).acknowledgedAt).toBeNull();
    // A letter with no portal message (no login) can't be acknowledged.
    const p = await s.of(s.paper.id);
    await expect(L.acknowledgeClientLetter(portalActor(s.jordan), p.id)).rejects.toThrow("Letter not found.");
  });

  it("no Coetha proposal content or staff notes reach any client payload", async () => {
    const s = await sent();
    await setupLedger(s.tabitha, s.bakery.id, { basis: "CASH" });
    await managed(s.bakery.id);
    const checking = (await prisma.ledgerAccount.findFirstOrThrow({ where: { clientId: s.bakery.id, code: "1000" } })).id;
    await importBankCsv(s.tabitha, s.bakery.id, checking, { fileName: "oct.csv", text: CSV(["10/02/2026,OFFICE SUPPLY PRETEND,-84.20"]) });
    await setOwnerSwitch(s.tabitha, "coetha", true);
    await runCoetha(s.tabitha, s.bakery.id, { month: "2026-10", today: "2026-11-04" });
    expect(await prisma.coethaProposal.count({ where: { clientId: s.bakery.id } })).toBeGreaterThan(0);
    await prisma.clientNote.create({ data: { clientId: s.bakery.id, authorId: s.tabitha.id, body: "SECRET_STAFF_NOTE (fictional)" } });
    const l = await s.of(s.bakery.id);
    const me = portalActor(s.jordan);
    const payload = JSON.stringify({
      letters: await L.portalLettersForMessages(me, s.bakery.id, [l.messageId!]),
      conversations: await portalConversations(me, s.bakery.id),
      thread: await prisma.message.findMany({ where: { id: l.messageId! }, select: { body: true } }),
    });
    expect(payload).not.toContain("SECRET_PROPOSAL_SUMMARY");
    expect(payload).not.toContain("SECRET_STAFF_NOTE");
    expect(payload).not.toMatch(/followUp|emailBounce|emailProviderId|sentById/);
    expect(Object.keys((await L.portalLettersForMessages(me, s.bakery.id, [l.messageId!]))[0]).sort()).toEqual(["acknowledgedAt", "id", "messageId"]);
  });
});
