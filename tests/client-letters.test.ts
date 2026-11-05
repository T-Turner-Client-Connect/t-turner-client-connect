import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, managed, prisma, resetDb } from "./db";
import { ForbiddenError } from "@/lib/auth/actor";
import { createClient, ValidationError } from "@/lib/services/clients";
import { saveProfile } from "@/lib/services/bookkeeping-clients";
import { BK_PORTAL_COETHA_V1, CURRENT_LETTER, letterText } from "@/lib/client-letters/templates";
import { buildLetterPdf } from "@/lib/client-letters/pdf";

// Email is stubbed: nothing leaves this test. Each call is recorded; an address listed in
// `failFor` gets a provider rejection. Fictional businesses and people only.
const mail = vi.hoisted(() => ({ sent: [] as { to: string; subject: string; text: string }[], failFor: new Set<string>() }));
vi.mock("@/lib/email", async (orig) => {
  const real = await orig<typeof import("@/lib/email")>();
  return {
    ...real,
    sendEmail: vi.fn(async (input: { to: string; subject: string; text: string }) => {
      if (mail.failFor.has(input.to)) return { ok: false, reason: "rejected", detail: "The email provider refused the message (HTTP 422: fictional)." };
      mail.sent.push({ to: input.to, subject: input.subject, text: input.text });
      return { ok: true, providerId: `email_${mail.sent.length}` };
    }),
    sendTransactionalEmail: vi.fn(async () => true),
  };
});

const { letterRecipients, markLetterMailed, prepareLetterBatch, resendLetter, sendLetterBatch, setLetterExcluded, letterPdf } = await import("@/lib/services/client-letters");
const { clearCoethaOptOut, COETHA_OPTED_OUT, setCoethaOptOut } = await import("@/lib/services/coetha-opt-out");
const { runCoetha, runDailyCoetha, COETHA_OFF } = await import("@/lib/services/coetha");
const { setupLedger, importBankCsv } = await import("@/lib/services/ledger");
const { setOwnerSwitch } = await import("@/lib/services/owner-switches");
const { createClientRequest } = await import("@/lib/services/client-requests");
const { runWorkflowMonitor } = await import("@/lib/services/monthly-workflow");

beforeEach(async () => {
  await resetDb();
  mail.sent = [];
  mail.failFor = new Set();
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ANTHROPIC_API_KEY;
});

async function portalOwner(clientId: string, email: string, name: string) {
  const u = await prisma.portalUser.create({ data: { email, name, passwordHash: "x" } });
  await prisma.portalAccess.create({ data: { portalUserId: u.id, clientId, role: "OWNER" } });
  return u;
}

async function setup() {
  const tabitha = await makeUser("ADMIN", "Owner");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const admin = await makeUser("ADMIN", "Second Admin");
  const staff = await makeUser("STAFF", "Daria");
  const mk = (businessName: string, email?: string) => createClient(tabitha, { businessName, clientType: "BUSINESS", status: "ACTIVE", ...(email ? { email } : {}) });
  // On the Bookkeeping list: a portal owner, an email-only client, a no-email client and one whose email fails.
  const bakery = await mk("Magnolia Bakery Example LLC");
  await portalOwner(bakery.id, "jordan.owner@bakery.example", "Jordan Example");
  const plumbing = await mk("Riverbend Plumbing Example Co", "office@riverbend.example");
  const garden = await mk("Garden Path Example LLC");
  const failing = await mk("Bounce Example Partners", "bounce@failing.example");
  await portalOwner(failing.id, "bounce@failing.example", "Casey Sample");
  for (const c of [bakery, plumbing, garden, failing]) await saveProfile(tabitha, c.id, { active: true, frequency: "MONTHLY", payroll: false });
  // Not on the list: inactive bookkeeping, archived, and a tax-only client.
  const inactive = await mk("Inactive Example Inc", "x@inactive.example");
  await saveProfile(tabitha, inactive.id, { active: false, frequency: "MONTHLY", payroll: false });
  const archived = await mk("Archived Example LLC", "x@archived.example");
  await saveProfile(tabitha, archived.id, { active: true, frequency: "MONTHLY", payroll: false });
  await prisma.client.update({ where: { id: archived.id }, data: { archivedAt: new Date() } });
  const taxOnly = await mk("Tax Only Example", "x@taxonly.example");
  return { tabitha, admin, staff, bakery, plumbing, garden, failing, inactive, archived, taxOnly };
}

describe("Client Letters: the approved template", () => {
  it("has the approved wording, its version id, and never names the owner", async () => {
    const t = BK_PORTAL_COETHA_V1;
    expect(t.version).toBe("bk-portal-coetha-2026-11-v1");
    expect(CURRENT_LETTER.version).toBe("bk-portal-coetha-2026-11-v1");
    const text = letterText(t, { date: "November 6, 2026", businessName: "Magnolia Bakery Example LLC", ownerName: "Jordan Example", ownerFirstName: "Jordan" });
    expect(text).toContain("T. Turner & Associates, LLC · 1 Perimeter Park S, Suite 465S · Birmingham, AL 35243 · 205-639-1000 · info@tturnerassociates.com");
    expect(text).toContain("November 6, 2026\n\nMagnolia Bakery Example LLC\nAttn: Jordan Example");
    expect(text).toContain("Re: Your bookkeeping, all in one place, and introducing Coetha");
    expect(text).toContain("Dear Jordan,");
    expect(text).toContain("Thank you for trusting T. Turner & Associates with your bookkeeping. We're making some improvements we think you'll appreciate.");
    expect(text).toContain("Why we're making this change. We are building a complete accounting system so everything for your business is kept in one place: TTurner Client Connect, your secure client portal.");
    expect(text).toContain("Coetha runs on secure AI technology from Anthropic.");
    expect(text).toContain("What Coetha does not do. Coetha does not prepare, review or file tax returns.");
    expect(text).toContain("Coetha cannot move money or make changes to your bank accounts.");
    expect(text).toContain("• Before any information goes to Coetha's AI service, your name is left out.");
    expect(text).toContain("• Your books are handled separately from every other client's.");
    expect(text).toContain("Getting started. Sign in at client.tturnerassociates.com. If you haven't set up your portal account yet, use \"Already a client? Activate your portal\" on the sign-in page, or call us and we'll help.");
    expect(text).toContain("client.tturnerassociates.com/privacy-policy");
    expect(text.endsWith("Sincerely,\n\nThe T. Turner & Associates Team")).toBe(true);
    // The owner removed the "Your choice" paragraph before anything was sent.
    expect(text).not.toContain("Your choice.");
    expect(text).not.toContain("You don't need to do anything.");
    expect(text).not.toMatch(/prepare your books without Coetha/);
    // Signed by the team, never by name.
    expect(text).not.toMatch(/Tabitha/i);
    expect(JSON.stringify(t)).not.toMatch(/Tabitha/i);
  });

  it("builds a one- or two-page PDF that records the version", async () => {
    const bytes = await buildLetterPdf(CURRENT_LETTER, { date: "November 6, 2026", businessName: "Magnolia Bakery Example LLC", ownerName: "Jordan Example", ownerFirstName: "Jordan" }, { letterId: "fictional-1" });
    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.load(bytes);
    expect([1, 2]).toContain(doc.getPageCount());
    expect(doc.getKeywords()).toContain("bk-portal-coetha-2026-11-v1");
    expect(Buffer.from(bytes).subarray(0, 5).toString()).toBe("%PDF-");
  });
});

describe("Client Letters: recipients, prepare and send", () => {
  it("recipients are active, unarchived Bookkeeping clients only, with owner and email resolved", async () => {
    const s = await setup();
    const r = await letterRecipients();
    expect(r.map((x) => x.clientId).sort()).toEqual([s.bakery.id, s.plumbing.id, s.garden.id, s.failing.id].sort());
    const bakery = r.find((x) => x.clientId === s.bakery.id)!;
    expect(bakery).toMatchObject({ businessName: "Magnolia Bakery Example LLC", ownerName: "Jordan Example", ownerFirstName: "Jordan", email: "jordan.owner@bakery.example", hasPortal: true });
    expect(r.find((x) => x.clientId === s.plumbing.id)).toMatchObject({ email: "office@riverbend.example", hasPortal: false });
    expect(r.find((x) => x.clientId === s.garden.id)!.email).toBeNull();
    // No person's name on file: addressed to the business and flagged, never a fragment of its name.
    expect(r.find((x) => x.clientId === s.garden.id)).toMatchObject({ noOwnerName: true, ownerName: "Garden Path Example LLC", ownerFirstName: "Garden Path Example LLC" });
    expect(bakery.noOwnerName).toBe(false);
  });

  it("prepare and send are owner-only", async () => {
    const s = await setup();
    await expect(prepareLetterBatch(s.admin)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(prepareLetterBatch(s.staff)).rejects.toBeInstanceOf(ForbiddenError);
    const batch = await prepareLetterBatch(s.tabitha);
    const one = await prisma.clientLetter.findFirstOrThrow({ where: { batchId: batch.id } });
    await expect(setLetterExcluded(s.admin, one.id, true)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(sendLetterBatch(s.admin, batch.id, "SEND")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(letterPdf(s.staff, one.id)).rejects.toBeInstanceOf(ForbiddenError);
    // The typed confirmation is required even for the owner.
    await expect(sendLetterBatch(s.tabitha, batch.id, "yes")).rejects.toBeInstanceOf(ValidationError);
    expect(mail.sent).toHaveLength(0);
    expect(await prisma.clientLetter.count({ where: { status: { not: "DRAFT" } } })).toBe(0);
  });

  it("sends: files a vault document and posts a portal message per client, records SENT / NO_EMAIL / EMAIL_FAILED and the version; exclusions get nothing", async () => {
    const s = await setup();
    mail.failFor.add("bounce@failing.example");
    const batch = await prepareLetterBatch(s.tabitha);
    expect(batch.status).toBe("DRAFT");
    const rows = await prisma.clientLetter.findMany({ where: { batchId: batch.id } });
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.status === "DRAFT" && r.templateVersion === "bk-portal-coetha-2026-11-v1")).toBe(true);
    const plumbingRow = rows.find((r) => r.clientId === s.plumbing.id)!;
    await setLetterExcluded(s.tabitha, plumbingRow.id, true);
    // Preview works before sending.
    const pdf = await letterPdf(s.tabitha, rows[0].id);
    expect(Buffer.from(pdf!.bytes).subarray(0, 5).toString()).toBe("%PDF-");

    const counts = await sendLetterBatch(s.tabitha, batch.id, "send", new Date("2026-11-06T15:00:00Z"));
    expect(counts).toEqual({ SENT: 1, NO_EMAIL: 1, EMAIL_FAILED: 1 });
    expect((await prisma.clientLetterBatch.findUniqueOrThrow({ where: { id: batch.id } })).status).toBe("SENT");

    const after = new Map((await prisma.clientLetter.findMany({ where: { batchId: batch.id } })).map((r) => [r.clientId, r]));
    expect(after.get(s.bakery.id)).toMatchObject({ status: "SENT", templateVersion: "bk-portal-coetha-2026-11-v1", email: "jordan.owner@bakery.example" });
    expect(after.get(s.bakery.id)!.emailedAt).toBeInstanceOf(Date);
    expect(after.get(s.bakery.id)!.letterDate!.toISOString().slice(0, 10)).toBe("2026-11-06");
    expect(after.get(s.garden.id)).toMatchObject({ status: "NO_EMAIL", email: null, messageId: null });
    expect(after.get(s.failing.id)!.status).toBe("EMAIL_FAILED");
    expect(after.get(s.failing.id)!.emailError).toMatch(/refused/);
    expect(after.get(s.plumbing.id)).toMatchObject({ status: "DRAFT", excluded: true, documentId: null });

    // Exactly one email, to the bakery owner, with a sign-in link and no attachment.
    expect(mail.sent.map((m) => m.to)).toEqual(["jordan.owner@bakery.example"]);
    expect(mail.sent[0].text).toContain("/client");

    // Every included client has the letter filed in the vault, published, under Other.
    for (const id of [s.bakery.id, s.garden.id, s.failing.id]) {
      const row = after.get(id)!;
      const doc = await prisma.document.findUniqueOrThrow({ where: { id: row.documentId! }, include: { file: true } });
      expect(doc).toMatchObject({ clientId: id, category: "OTHER", visibility: "PUBLISHED", title: "Client letter: Bookkeeping portal & Coetha (Nov 2026)" });
      expect(doc.file.mimeType).toBe("application/pdf");
    }
    expect(await prisma.document.count({ where: { clientId: s.plumbing.id } })).toBe(0);

    // Portal copies, with the PDF attached, for clients with a portal login.
    for (const id of [s.bakery.id, s.failing.id]) {
      const msg = await prisma.message.findUniqueOrThrow({ where: { id: after.get(id)!.messageId! }, include: { attachments: true, conversation: true } });
      expect(msg.channel).toBe("PORTAL");
      expect(msg.conversation.clientId).toBe(id);
      expect(msg.attachments.map((a) => a.id)).toEqual([after.get(id)!.documentId]);
    }
    expect(await prisma.conversation.count({ where: { clientId: s.garden.id } })).toBe(0);

    // A batch sends once.
    await expect(sendLetterBatch(s.tabitha, batch.id, "SEND")).rejects.toThrow(/already sent/);
    expect(mail.sent).toHaveLength(1);

    // NO_EMAIL: Tabitha records that she mailed it.
    await markLetterMailed(s.tabitha, after.get(s.garden.id)!.id, "2026-11-07");
    expect(await prisma.clientLetter.findUniqueOrThrow({ where: { id: after.get(s.garden.id)!.id } })).toMatchObject({ status: "MAILED_MANUALLY" });
    await expect(markLetterMailed(s.tabitha, after.get(s.bakery.id)!.id, "2026-11-07")).rejects.toBeInstanceOf(ValidationError);

    // Every step is audited.
    expect(await prisma.ownerAuditLog.count({ where: { action: { startsWith: "client_letters." } } })).toBeGreaterThanOrEqual(4);
    expect(await prisma.auditLog.count({ where: { action: "client_letter.sent" } })).toBe(3);
    expect(await prisma.auditLog.count({ where: { action: "client_letter.filed" } })).toBe(3);
    expect(await prisma.auditLog.count({ where: { action: "client_letter.mailed" } })).toBe(1);
  });

  it("re-sending to one client makes a new record and a new filed copy; a new batch never repeats a client automatically", async () => {
    const s = await setup();
    const batch = await prepareLetterBatch(s.tabitha);
    await sendLetterBatch(s.tabitha, batch.id, "SEND");
    const first = await prisma.clientLetter.findFirstOrThrow({ where: { batchId: batch.id, clientId: s.bakery.id } });
    await expect(resendLetter(s.admin, first.id, "SEND")).rejects.toBeInstanceOf(ForbiddenError);
    const again = await resendLetter(s.tabitha, first.id, "SEND");
    expect(again.letterId).not.toBe(first.id);
    const second = await prisma.clientLetter.findUniqueOrThrow({ where: { id: again.letterId } });
    expect(second).toMatchObject({ resendOfId: first.id, status: "SENT", templateVersion: "bk-portal-coetha-2026-11-v1" });
    expect(second.documentId).not.toBe(first.documentId);
    expect(await prisma.document.count({ where: { clientId: s.bakery.id, title: "Client letter: Bookkeeping portal & Coetha (Nov 2026)" } })).toBe(2);
    expect(await prisma.clientLetter.count({ where: { clientId: s.bakery.id } })).toBe(2);
    expect(mail.sent.filter((m) => m.to === "jordan.owner@bakery.example")).toHaveLength(2);

    // A later batch leaves out everyone who already has this version.
    const next = await prepareLetterBatch(s.tabitha);
    const rows = await prisma.clientLetter.findMany({ where: { batchId: next.id } });
    expect(rows.every((r) => r.excluded && /Already sent/.test(r.excludedReason ?? ""))).toBe(true);
    await sendLetterBatch(s.tabitha, next.id, "SEND");
    expect(mail.sent.filter((m) => m.to === "jordan.owner@bakery.example")).toHaveLength(2);
  });
});

describe("Client prefers no Coetha", () => {
  const CSV = ["Date,Description,Amount", "10/02/2026,OFFICE SUPPLY EXAMPLE,-84.20"].join("\n");

  async function coethaSetup() {
    const tabitha = await makeUser("ADMIN", "Owner");
    await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
    const staff = await makeUser("STAFF", "Unassigned Staff");
    const biz = await createClient(tabitha, { businessName: "Lakeside Example LLC (fictional)", clientType: "BUSINESS", status: "ACTIVE" });
    await managed(biz.id);
    await saveProfile(tabitha, biz.id, { active: true, frequency: "MONTHLY", payroll: false });
    await setupLedger(tabitha, biz.id, { basis: "CASH" });
    const checking = (await prisma.ledgerAccount.findFirstOrThrow({ where: { clientId: biz.id, code: "1000" } })).id;
    await importBankCsv(tabitha, biz.id, checking, { fileName: "oct.csv", text: CSV });
    return { tabitha, staff, biz };
  }

  function stubModel() {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-fictional-key";
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
      if (u.host !== "api.anthropic.com") throw new Error(`Unexpected request: ${u.href}`);
      calls.push(String(init?.body ?? ""));
      const req = JSON.parse(String(init?.body));
      const output = { categories: [], discrepancies: [], adjustingEntries: [], monthSummary: { month: "2026-10", summary: "A quiet fictional month with one supply purchase.", highlights: [] } };
      return new Response(JSON.stringify({ id: "msg_fictional", type: "message", role: "assistant", model: req.model, content: [{ type: "text", text: JSON.stringify(output) }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } }), { status: 200, headers: { "content-type": "application/json", "request-id": "req_fictional" } });
    }));
    return calls;
  }

  it("blocks every Coetha run, draft and request; clearing it restores them; both are audited", async () => {
    const s = await coethaSetup();
    const calls = stubModel();
    await setOwnerSwitch(s.tabitha, "coetha", true);
    const opts = { month: "2026-10", today: "2026-11-04" };

    // Only staff who can edit the client's books can set it.
    await expect(setCoethaOptOut(s.staff, s.biz.id, { toldOn: "2026-11-03", via: "PHONE" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setCoethaOptOut(s.tabitha, s.biz.id, { toldOn: "2026-11-03", via: "CARRIER_PIGEON" })).rejects.toBeInstanceOf(ValidationError);
    await setCoethaOptOut(s.tabitha, s.biz.id, { toldOn: "2026-11-03", via: "PHONE", note: "Called the office (fictional)." });

    await expect(runCoetha(s.tabitha, s.biz.id, opts)).rejects.toThrow(COETHA_OPTED_OUT);
    await expect(runWorkflowMonitor(s.tabitha, s.biz.id, 2026, 10, { today: "2026-11-04" })).rejects.toThrow(COETHA_OPTED_OUT);
    await expect(createClientRequest(null, s.biz.id, { kind: "SUPPORTING", title: "Receipts for October (fictional)" }, { send: false, source: "COETHA" })).rejects.toThrow(COETHA_OPTED_OUT);
    // Staff requests are not Coetha's and still work.
    await createClientRequest(s.tabitha, s.biz.id, { kind: "SUPPORTING", title: "Staff request (fictional)" }, { send: false });
    expect((await runDailyCoetha()).ran).toBe(0);
    expect(calls).toHaveLength(0);
    expect(await prisma.coethaRun.count()).toBe(0);
    expect(await prisma.documentRequest.count({ where: { source: "COETHA" } })).toBe(0);

    await expect(clearCoethaOptOut(s.staff, s.biz.id)).rejects.toBeInstanceOf(ForbiddenError);
    await clearCoethaOptOut(s.tabitha, s.biz.id);
    const r = await runCoetha(s.tabitha, s.biz.id, opts);
    expect(r.runId).toBeTruthy();
    expect(calls).toHaveLength(1);
    await createClientRequest(null, s.biz.id, { kind: "SUPPORTING", title: "Receipts for October (fictional)" }, { send: false, source: "COETHA" });
    expect(await prisma.documentRequest.count({ where: { source: "COETHA" } })).toBe(1);

    // The owner switch still applies on its own.
    await setOwnerSwitch(s.tabitha, "coetha", false);
    await expect(runCoetha(s.tabitha, s.biz.id, opts)).rejects.toThrow(COETHA_OFF);

    expect(await prisma.auditLog.count({ where: { action: "coetha.opt_out_set", clientId: s.biz.id } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: "coetha.opt_out_cleared", clientId: s.biz.id } })).toBe(1);
  });
});
