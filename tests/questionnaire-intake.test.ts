// Fictional clients and fake Jotform / email / scanner endpoints only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { createClient } from "@/lib/services/clients";
import { linkSubmission } from "@/lib/services/tax-center";
import {
  buildFollowUp, findClientSubmissions, followUpChecklist, intakeStatus, intakeSummary, proposedUpdates, recordQuestionnaireOpened, requestMissingItems, reviewSubmission, sendQuestionnaire, testJotformConnection,
} from "@/lib/services/questionnaire-intake";

const FORM = "241234567890123";
const subs: Record<string, unknown>[] = [];
const emails: { to: string; subject: string; html: string }[] = [];

async function fakeFetch(url: string | URL, init?: RequestInit) {
  const u = String(url);
  if (u.includes("scanner.test")) return new Response(JSON.stringify({ clean: true }), { status: 200 });
  if (u.includes("mail.test/emails")) {
    const body = JSON.parse(String(init?.body));
    emails.push({ to: Array.isArray(body.to) ? body.to[0] : body.to, subject: body.subject, html: body.html });
    return new Response(JSON.stringify({ id: "em_1" }), { status: 200 });
  }
  if (u.endsWith("/user")) return new Response(JSON.stringify({ content: { username: "x" } }), { status: (init?.headers as Record<string, string>)?.APIKEY === "good" ? 200 : 401 });
  if (u.includes(`/form/${FORM}/submissions`)) return new Response(JSON.stringify({ content: subs }), { status: 200 });
  const m = /\/submission\/(\d+)$/.exec(u);
  if (m) {
    const s = subs.find((x) => x.id === m[1]);
    return s ? new Response(JSON.stringify({ content: s }), { status: 200 }) : new Response("{}", { status: 404 });
  }
  if (u.startsWith("https://www.jotform.com/uploads/")) return new Response(new TextEncoder().encode(`%PDF-1.4 fictional ${u}`), { status: 200 });
  return new Response("not found", { status: 404 });
}

beforeEach(async () => {
  await resetDb();
  subs.length = 0;
  emails.length = 0;
  vi.stubEnv("MALWARE_SCAN_URL", "https://scanner.test/scan");
  vi.stubEnv("JOTFORM_API_KEY", "good");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("EMAIL_FROM_ADDRESS", "Office <office@example.com>");
  vi.stubEnv("RESEND_API_BASE", "https://mail.test");
  vi.stubGlobal("fetch", fakeFetch);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function setup() {
  const tab = await makeUser("ADMIN");
  const c = await createClient(tab, { firstName: "Marisol", lastName: "Vance", clientType: "INDIVIDUAL", status: "ACTIVE", email: "marisol.vance@example.com", phone: "205-555-0101" });
  await prisma.taxQuestionnaire.create({ data: { taxYear: 2025, title: "2025 Tax Questionnaire", jotformFormId: FORM } });
  return { tab, c };
}

const sub = (id: string, email: string, extra: Record<string, unknown> = {}) => ({
  id,
  form_id: FORM,
  created_at: "2026-02-01 10:00:00",
  answers: {
    1: { type: "control_fullname", text: "Your name", answer: { first: "Marisol", last: "Vance" }, prettyFormat: "Marisol Vance" },
    2: { type: "control_email", text: "Email", answer: email },
    3: { type: "control_radio", text: "Did you receive a W-2 from an employer?", answer: "Yes" },
    4: { type: "control_radio", text: "Did you pay mortgage interest?", answer: "Yes" },
    5: { type: "control_radio", text: "Did you have self-employment income?", answer: "No" },
    6: { type: "control_phone", text: "Best phone number", answer: "(205) 555-0177", prettyFormat: "(205) 555-0177" },
    7: { type: "control_address", text: "Mailing address", answer: {}, prettyFormat: "Street Address: 40 Sample St<br>City: Bessemer<br>State / Province: AL<br>Postal / Zip Code: 35020<br>" },
    8: { type: "control_fileupload", answer: ["https://www.jotform.com/uploads/x/W-2 Employer.pdf"] },
    ...extra,
  },
});

describe("Tax Questionnaires & Intake", () => {
  it("status moves Not Sent → Sent → In Progress → Needs Review → Completed", async () => {
    const { tab, c } = await setup();
    expect((await intakeSummary(c.id, 2025)).label).toBe("Not Sent");
    await sendQuestionnaire(tab, c.id, 2025);
    expect(emails).toHaveLength(1);
    expect(emails[0].to).toBe("marisol.vance@example.com");
    expect(emails[0].html).toContain(`form.jotform.com/${FORM}`);
    expect((await intakeSummary(c.id, 2025)).label).toBe("Sent");
    await sendQuestionnaire(tab, c.id, 2025); // resend updates, never duplicates
    expect(await prisma.questionnaireRequest.count()).toBe(1);
    expect((await prisma.questionnaireRequest.findFirstOrThrow()).sendCount).toBe(2);
    await recordQuestionnaireOpened(c.id, 2025);
    expect((await intakeSummary(c.id, 2025)).label).toBe("In Progress");

    subs.push(sub("7000000000001", "marisol.vance@example.com"));
    const { row } = await linkSubmission(tab, { clientId: c.id, taxYear: 2025, submissionId: "7000000000001", confirmed: false });
    expect((await intakeSummary(c.id, 2025)).label).toBe("Needs Review");
    await expect(sendQuestionnaire(tab, c.id, 2025)).rejects.toThrow(/already completed/);
    await reviewSubmission(tab, row.id, []);
    expect((await intakeSummary(c.id, 2025)).label).toBe("Completed");
    expect(intakeStatus(null, [])).toBe("NOT_SENT");
  });

  it("finds this client's submissions, marks ones already linked, and never links one twice", async () => {
    const { tab, c } = await setup();
    const other = await createClient(tab, { firstName: "Other", lastName: "Person", clientType: "INDIVIDUAL", status: "ACTIVE", email: "other@example.com" });
    subs.push(sub("7000000000001", "marisol.vance@example.com"), sub("7000000000002", "someone@example.com"), sub("7000000000003", "other@example.com", { 1: { type: "control_fullname", answer: {}, prettyFormat: "Other Person" } }));
    let found = await findClientSubmissions(c.id, 2025);
    expect(found.map((f) => [f.submissionId, f.matchedBy, f.linkedHere])).toEqual([
      ["7000000000001", ["email", "name"], false],
      ["7000000000002", ["name"], false], // same name, different email → needs confirmation to link
    ]);
    await linkSubmission(tab, { clientId: c.id, taxYear: 2025, submissionId: "7000000000001", confirmed: false });
    found = await findClientSubmissions(c.id, 2025);
    expect(found[0].linkedHere).toBe(true);
    await expect(linkSubmission(tab, { clientId: c.id, taxYear: 2025, submissionId: "7000000000001", confirmed: false })).rejects.toThrow(/already linked/);
    await expect(linkSubmission(tab, { clientId: other.id, taxYear: 2025, submissionId: "7000000000001", confirmed: true, matchNote: "x" })).rejects.toThrow(/different client/);
    await expect(linkSubmission(tab, { clientId: c.id, taxYear: 2025, submissionId: "7000000000002", confirmed: false })).rejects.toThrow(/doesn't match/);
    expect(await prisma.questionnaireSubmission.count()).toBe(1);
  });

  it("saves attachments to the client's yearly vault and only applies answers staff approve", async () => {
    const { tab, c } = await setup();
    subs.push(sub("7000000000001", "marisol.vance@example.com"));
    const { row } = await linkSubmission(tab, { clientId: c.id, taxYear: 2025, submissionId: "7000000000001", confirmed: false });
    const doc = await prisma.document.findUniqueOrThrow({ where: { id: row.documentIds[0] } });
    expect(doc).toMatchObject({ clientId: c.id, year: 2025, category: "TAXES", visibility: "STAFF_ONLY" });

    const before = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    const sub1 = await prisma.questionnaireSubmission.findUniqueOrThrow({ where: { id: row.id } });
    const { submissionAnswers } = await import("@/lib/services/tax-center");
    const proposals = proposedUpdates(submissionAnswers(sub1), before as unknown as Record<string, string | null>);
    expect(proposals.map((p) => [p.field, p.to])).toEqual([
      ["phone", "(205) 555-0177"],
      ["addressLine1", "40 Sample St"],
      ["city", "Bessemer"],
      ["state", "AL"],
      ["postalCode", "35020"],
    ]);
    // Linking alone changed nothing on the client record.
    expect((await prisma.client.findUniqueOrThrow({ where: { id: c.id } })).phone).toBe(before.phone);
    const applied = await reviewSubmission(tab, row.id, ["addressLine1", "city", "state", "postalCode"]);
    expect(applied).toEqual(["addressLine1", "city", "state", "postalCode"]);
    const after = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    expect([after.addressLine1, after.city, after.phone]).toEqual(["40 Sample St", "Bessemer", before.phone]); // phone not ticked → unchanged
    expect(await prisma.auditLog.count({ where: { action: "questionnaire.reviewed" } })).toBe(1);
  });

  it("Coetha's checklist finds documents still missing and staff turn it into one request", async () => {
    const { tab, c } = await setup();
    subs.push(sub("7000000000001", "marisol.vance@example.com", { 9: { type: "control_textbox", text: "Childcare provider name", answer: "not sure" } }));
    const { row } = await linkSubmission(tab, { clientId: c.id, taxYear: 2025, submissionId: "7000000000001", confirmed: false });
    const items = await buildFollowUp(tab, row.id);
    expect(items.map((i) => [i.key, i.status])).toEqual([
      ["w2", "RECEIVED"], // the uploaded W-2 is in the vault
      ["mortgage", "MISSING"],
      ["ask:Childcare provider name", "MISSING"],
    ]);
    expect(await prisma.documentRequest.count()).toBe(0); // nothing sent until staff choose
    const req = await requestMissingItems(tab, row.id, ["mortgage"]);
    expect(req.instructions).toContain("1098 Mortgage Interest Statement");
    expect(req.category).toBe("TAXES");
  });

  it("checklist rules ignore No answers", () => {
    expect(followUpChecklist([{ q: "Did you have self-employment income?", a: "No" }], [])).toEqual([]);
  });

  it("the connection test never assumes success and never reveals the key", async () => {
    expect((await testJotformConnection()).ok).toBe(true);
    vi.stubEnv("JOTFORM_API_KEY", "bad");
    const r = await testJotformConnection();
    expect(r).toMatchObject({ ok: false });
    expect(r.detail).toMatch(/HTTP 401/);
    expect(JSON.stringify(r)).not.toContain("bad");
    vi.stubEnv("JOTFORM_API_KEY", "");
    expect((await testJotformConnection()).detail).toMatch(/isn't set/);
  });
});

describe("Jotform webhook", () => {
  const SECRET = "fictional-webhook-secret-0123456789abcdef";
  const signed = async (clientId: string) => (await import("@/lib/services/tax-center")).questionnaireRef(clientId, 2025);
  const withRef = (id: string, email: string, ref: string | null) => {
    const s = sub(id, email) as { answers: Record<string, unknown> };
    if (ref) s.answers[0] = { name: "assignment_ref", answer: ref };
    return s as unknown as Record<string, unknown>;
  };

  it("rejects missing, wrong or too-short secrets and re-reads the submission from the API", async () => {
    const { handleJotformWebhook } = await import("@/lib/services/contracts");
    expect((await handleJotformWebhook("x", "7000000000001")).status).toBe(503); // secret not configured
    vi.stubEnv("JOTFORM_WEBHOOK_SECRET", "short");
    expect((await handleJotformWebhook("short", "7000000000001")).status).toBe(503);
    vi.stubEnv("JOTFORM_WEBHOOK_SECRET", SECRET);
    expect((await handleJotformWebhook(null, "7000000000001")).status).toBe(401);
    expect((await handleJotformWebhook(SECRET.slice(0, -1) + "X", "7000000000001")).status).toBe(401);
    expect((await handleJotformWebhook(SECRET, "7000000000001")).status).toBe(502); // not in Jotform → nothing trusted from the POST
  });

  it("a verified personal-link submission is linked to its client and year automatically, once — answers still need staff review", async () => {
    vi.stubEnv("JOTFORM_WEBHOOK_SECRET", SECRET);
    const { c } = await setup();
    const { handleJotformWebhook } = await import("@/lib/services/contracts");
    subs.push(withRef("7000000000001", "marisol.vance@example.com", await signed(c.id)));
    expect(await handleJotformWebhook(SECRET, "7000000000001")).toEqual({ status: 200, result: "Recorded" });
    expect(await handleJotformWebhook(SECRET, "7000000000001")).toEqual({ status: 200, result: "Already in the inbox" });
    const row = await prisma.questionnaireSubmission.findFirstOrThrow();
    expect(row).toMatchObject({ clientId: c.id, taxYear: 2025, reviewStatus: "NEEDS_REVIEW", source: "jotform_webhook" });
    const before = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    expect(before.addressLine1).toBeNull(); // answers did not change the record
    const { inboxKind, inboxState } = await import("@/lib/services/questionnaire-intake");
    const item = await prisma.jotformInbox.findFirstOrThrow();
    expect(item).toMatchObject({ status: "FILED", filedClientId: c.id, suggestedClientId: c.id });
    expect(inboxKind(item, { source: "Added by staff", createdAt: new Date() })).toBe("VERIFIED_CLIENT");
    expect(inboxKind(item, { source: "Client portal sign-up", createdAt: new Date() })).toBe("NEW_CLIENT");
    expect(inboxState(item, row)).toBe("ASSIGNED");
    expect(await prisma.questionnaireSubmission.count()).toBe(1);
  });

  it("public-link and bad-link submissions wait as Needs Matching; staff approve client + year, choose attachments, or create a client", async () => {
    vi.stubEnv("JOTFORM_WEBHOOK_SECRET", SECRET);
    const { tab, c } = await setup();
    const { fileInboxItem, dismissInboxItem, suggestClients, inboxKind } = await import("@/lib/services/questionnaire-intake");
    const { handleJotformWebhook } = await import("@/lib/services/contracts");
    subs.push(withRef("7000000000002", "marisol.vance@example.com", null)); // public form, client's email
    subs.push(withRef("7000000000003", "stranger@example.com", "q.forged.2025.AAAAAAAAAAAAAAAAAAAAAA"));
    // Same name as an existing client but a different email: must not be pre-selected.
    subs.push({ ...withRef("7000000000004", "someone@example.com", null) });
    expect((await handleJotformWebhook(SECRET, "7000000000002")).result).toBe("Held for staff review (NO_REFERENCE)");
    expect((await handleJotformWebhook(SECRET, "7000000000003")).result).toBe("Held for staff review (BAD_REFERENCE)");
    expect((await handleJotformWebhook(SECRET, "7000000000004")).result).toBe("Held for staff review (NO_REFERENCE)");
    expect(await prisma.questionnaireSubmission.count()).toBe(0);
    const [publicLink, bad, nameOnly] = await prisma.jotformInbox.findMany({ orderBy: { submissionId: "asc" } });
    expect(inboxKind(publicLink)).toBe("NEEDS_MATCHING");
    expect(publicLink).toMatchObject({ taxYear: 2025, emails: ["marisol.vance@example.com"], names: ["Marisol Vance"], phones: ["+12055550177"] });

    const sugg = await suggestClients(publicLink);
    expect(sugg[0]).toMatchObject({ id: c.id, verified: true });
    expect(sugg[0].why).toEqual(["Same email"]);
    const nameSugg = await suggestClients(nameOnly);
    expect(nameSugg).toEqual([expect.objectContaining({ id: c.id, verified: false })]); // name only — never a verified match

    await expect(fileInboxItem(tab, publicLink.id, { clientId: c.id, taxYear: 2025, yearConfirmed: false })).rejects.toThrow(/Confirm the tax year/);
    await fileInboxItem(tab, publicLink.id, { clientId: c.id, taxYear: 2025, yearConfirmed: true, fileIndexes: [] }); // no attachments approved
    const filed = await prisma.questionnaireSubmission.findFirstOrThrow();
    expect(filed).toMatchObject({ clientId: c.id, taxYear: 2025, reviewStatus: "NEEDS_REVIEW" });
    expect(filed.documentIds).toEqual([]);
    expect((await prisma.jotformInbox.findUniqueOrThrow({ where: { id: publicLink.id } })).status).toBe("FILED");
    await expect(fileInboxItem(tab, publicLink.id, { clientId: c.id, taxYear: 2025, yearConfirmed: true })).rejects.toThrow(/already handled/);

    // Staff approve a stranger's submission onto a brand-new client (no portal login is created).
    const newClient = await createClient(tab, { firstName: "Jordan", lastName: "Fictional", clientType: "INDIVIDUAL", status: "ACTIVE", email: "stranger@example.com" });
    await fileInboxItem(tab, bad.id, { clientId: newClient.id, taxYear: 2025, yearConfirmed: true });
    expect(await prisma.portalUser.count()).toBe(0);
    await dismissInboxItem(tab, nameOnly.id, "Test submission");
    expect(await prisma.questionnaireSubmission.count()).toBe(2);
  });

  it("checking Jotform for missed submissions adds each one to the inbox once and files nothing new", async () => {
    const { tab, c } = await setup();
    const { importRecentSubmissions } = await import("@/lib/services/questionnaire-intake");
    subs.push(withRef("7000000000005", "nobody@example.com", null), withRef("7000000000006", "marisol.vance@example.com", await signed(c.id)));
    const first = await importRecentSubmissions(tab);
    expect(first).toEqual({ seen: 2, added: 1 }); // the signed one is linked to its client (Verified Client)
    expect(await importRecentSubmissions(tab)).toEqual({ seen: 2, added: 0 });
    expect(await prisma.jotformInbox.count()).toBe(2);
    expect(await prisma.questionnaireSubmission.count()).toBe(1);
  });
});

describe("Correcting an assignment", () => {
  it("staff can move an unreviewed questionnaire and its files to the right client and year, with a reason", async () => {
    const { tab, c } = await setup();
    const right = await createClient(tab, { firstName: "Marisol", lastName: "Vance-Ortiz", clientType: "INDIVIDUAL", status: "ACTIVE" });
    await prisma.taxQuestionnaire.create({ data: { taxYear: 2024, title: "2024", jotformFormId: FORM } }).catch(() => null);
    subs.push(sub("7000000000001", "marisol.vance@example.com"));
    const { row } = await linkSubmission(tab, { clientId: c.id, taxYear: 2025, submissionId: "7000000000001", confirmed: false });
    const { reassignSubmission } = await import("@/lib/services/questionnaire-intake");
    await expect(reassignSubmission(tab, row.id, { clientId: right.id, taxYear: 2024, note: "" })).rejects.toThrow(/why/);
    await reassignSubmission(tab, row.id, { clientId: right.id, taxYear: 2024, note: "Spouse's separate return" });
    const moved = await prisma.questionnaireSubmission.findUniqueOrThrow({ where: { id: row.id } });
    expect([moved.clientId, moved.taxYear]).toEqual([right.id, 2024]);
    expect(await prisma.document.findUniqueOrThrow({ where: { id: row.documentIds[0] } })).toMatchObject({ clientId: right.id, year: 2024 });
    await reviewSubmission(tab, row.id, []);
    await expect(reassignSubmission(tab, row.id, { clientId: c.id, taxYear: 2025, note: "x" })).rejects.toThrow(/already reviewed/);
  });
});
