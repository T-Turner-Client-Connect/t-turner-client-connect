import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { ForbiddenError } from "@/lib/auth/actor";
import { createClient } from "@/lib/services/clients";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { portalUploadDocument, setVisibility, staffUploadDocument } from "@/lib/services/documents";
import { handleJotformWebhook } from "@/lib/services/contracts";
import {
  confirmPortalIdentity, linkSubmission, parseJotformId, parseQuestionnaireRef, questionnaireLink, questionnaireRef, requestFilingCopy, retrieveFilings, saveQuestionnaire, setTaxYearProgress, submissionAnswers, taxYearStatuses,
} from "@/lib/services/tax-center";
import { announcementsForClient, countdownsFor, saveAnnouncement, saveDeadline } from "@/lib/services/news";

let seq = 0;
const pdf = () => new TextEncoder().encode(`%PDF-1.4\n% fictional ${seq++}\n`);

beforeEach(async () => {
  await resetDb();
  vi.stubEnv("MALWARE_SCAN_URL", "https://scanner.test/scan");
  vi.stubGlobal("fetch", jotformFetch);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// Fake Jotform API + scanner.
const submissions: Record<string, unknown> = {};
async function jotformFetch(url: string | URL) {
  const u = String(url);
  if (u.includes("scanner.test")) return new Response(JSON.stringify({ clean: true }), { status: 200 });
  const m = /\/submission\/(\d+)$/.exec(u);
  if (m) return submissions[m[1]] ? new Response(JSON.stringify({ content: submissions[m[1]] }), { status: 200 }) : new Response("{}", { status: 404 });
  if (u.startsWith("https://www.jotform.com/uploads/")) return new Response(pdf(), { status: 200 });
  return new Response("not found", { status: 404 });
}

async function portal(email: string, name: string, opts: { emailed?: boolean } = {}) {
  const tab = await makeUser("ADMIN");
  const c = await createClient(tab, { firstName: name, lastName: "Client", clientType: "INDIVIDUAL", status: "ACTIVE", email });
  const { token } = await invitePortalUser(tab, c.id, { email, name, role: "OWNER" });
  if (opts.emailed) await prisma.portalInvite.updateMany({ where: { clientId: c.id }, data: { sentByEmail: true } });
  const u = await acceptPortalInvite(token!, "Client-Pass-1234");
  return { tab, client: c, user: { id: u.id, name: u.name, email: u.email } };
}

describe("tax questionnaires", () => {
  it("only accept real Jotform IDs and sign each client/year link", async () => {
    expect(parseJotformId("241234567890123")).toBe("241234567890123");
    expect(parseJotformId("https://form.jotform.com/241234567890123")).toBe("241234567890123");
    expect(() => parseJotformId("https://evil.example.com/241234567890123")).toThrow();
    const { tab, client, user } = await portal("ana@example.com", "Ana");
    // No form ID yet → no link (never a guessed URL).
    await prisma.taxQuestionnaire.create({ data: { taxYear: 2025, title: "2025 Tax Questionnaire" } });
    expect(await questionnaireLink(user, client.id, 2025)).toBeNull();
    const q = await prisma.taxQuestionnaire.findFirstOrThrow({ where: { taxYear: 2025 } });
    await saveQuestionnaire(tab, { taxYear: 2025, audience: "ALL", title: "2025 Tax Questionnaire", jotformFormId: "241234567890123", active: true }, q.id);
    const link = await questionnaireLink(user, client.id, 2025);
    expect(link).toMatch(/^https:\/\/form\.jotform\.com\/241234567890123\?assignment_ref=q\./);
    const ref = decodeURIComponent(link!.split("=")[1]);
    expect(parseQuestionnaireRef(ref)).toEqual({ clientId: client.id, taxYear: 2025 });
    expect(parseQuestionnaireRef(ref.replace("2025", "2024"))).toBeNull();
  });

  it("a webhook submission is verified through the API and filed to the right client and year", async () => {
    vi.stubEnv("JOTFORM_API_KEY", "jf_key");
    vi.stubEnv("JOTFORM_WEBHOOK_SECRET", "hook");
    const { client } = await portal("ana@example.com", "Ana");
    await prisma.taxQuestionnaire.create({ data: { taxYear: 2025, title: "2025", jotformFormId: "241234567890123" } });
    submissions["5551112223334"] = {
      id: "5551112223334", form_id: "241234567890123", created_at: "2026-02-01 10:00:00",
      answers: { 1: { name: "assignment_ref", answer: questionnaireRef(client.id, 2025) }, 2: { type: "control_email", text: "Email", answer: "ana@example.com" }, 3: { type: "control_textbox", text: "Dependents", answer: "2" }, 4: { type: "control_fileupload", answer: ["https://www.jotform.com/uploads/x/w2.pdf", "https://evil.example.com/a.pdf"] } },
    };
    expect(await handleJotformWebhook("hook", "5551112223334")).toEqual({ status: 200, result: "Recorded" });
    const row = await prisma.questionnaireSubmission.findUniqueOrThrow({ where: { submissionId: "5551112223334" } });
    expect(row).toMatchObject({ clientId: client.id, taxYear: 2025, source: "jotform_webhook" });
    expect(row.documentIds).toHaveLength(1); // the non-Jotform link was ignored
    expect(row.answersEnc).not.toContain("Dependents"); // stored encrypted
    expect(submissionAnswers(row)).toContainEqual({ q: "Dependents", a: "2" });
    expect(await prisma.document.findUniqueOrThrow({ where: { id: row.documentIds[0] } })).toMatchObject({ year: 2025, docType: "QUESTIONNAIRE_UPLOAD", needsReview: true });
    expect((await handleJotformWebhook("hook", "5551112223334")).result).toBe("Already recorded");
  });

  it("staff import an existing submission only after the client match is verified", async () => {
    vi.stubEnv("JOTFORM_API_KEY", "jf_key");
    const { tab, client } = await portal("ana@example.com", "Ana");
    const other = await createClient(tab, { firstName: "Ben", lastName: "B", clientType: "INDIVIDUAL", status: "ACTIVE", email: "ben@example.com" });
    submissions["7770001112223"] = { id: "7770001112223", form_id: "241234567890123", answers: { 2: { type: "control_email", answer: "ANA@example.com" }, 4: { type: "control_fileupload", answer: ["https://www.jotform.com/uploads/x/1099.pdf"] } } };
    // Wrong client: email doesn't match, so it needs explicit confirmation and a note.
    await expect(linkSubmission(tab, { clientId: other.id, taxYear: 2024, submissionId: "7770001112223", confirmed: false })).rejects.toThrow(/doesn't match Ben B/);
    const r = await linkSubmission(tab, { clientId: client.id, taxYear: 2024, submissionId: "7770001112223", confirmed: false });
    expect(r.imported).toBe(1);
    expect(r.row.matchNote).toMatch(/Email matched/);
    const doc = await prisma.document.findUniqueOrThrow({ where: { id: r.row.documentIds[0] } });
    expect(doc).toMatchObject({ visibility: "STAFF_ONLY", uploadedByStaffId: tab.id, year: 2024 });
    expect(await prisma.documentAccessLog.count({ where: { documentId: doc.id, action: "LINK", staffUserId: tab.id } })).toBe(1);
    await expect(linkSubmission(tab, { clientId: other.id, taxYear: 2024, submissionId: "7770001112223", confirmed: true, matchNote: "x" })).rejects.toThrow(/different client/);
  });
});

describe("uploads", () => {
  it("keep one copy of each original per client", async () => {
    const { tab, client, user } = await portal("ana@example.com", "Ana");
    const bytes = pdf();
    await portalUploadDocument(user, { clientId: client.id, year: 2025, docType: "W2", bytes, originalName: "w2.pdf" });
    await expect(portalUploadDocument(user, { clientId: client.id, year: 2025, bytes, originalName: "w2-again.pdf" })).rejects.toThrow(/already have this exact file/);
    await expect(staffUploadDocument(tab, { clientId: client.id, category: "TAXES", visibility: "STAFF_ONLY", year: 2025, bytes, originalName: "w2.pdf" })).rejects.toThrow(/already saved under 2025/);
    // Another client can store the same file.
    const b = await createClient(tab, { firstName: "Ben", lastName: "B", clientType: "INDIVIDUAL", status: "ACTIVE" });
    await expect(staffUploadDocument(tab, { clientId: b.id, category: "TAXES", visibility: "STAFF_ONLY", bytes, originalName: "w2.pdf" })).resolves.toBeTruthy();
  });
});

describe("Retrieve Tax Filings", () => {
  it("needs a verified account, shows only published clean records by group, and Request a Copy makes one task", async () => {
    const { tab, client, user } = await portal("ana@example.com", "Ana");
    await expect(retrieveFilings(user, client.id, 2024)).rejects.toThrow(/verify your account/);
    await confirmPortalIdentity(tab, client.id, user.id, "Called the number on file");
    const fed = await staffUploadDocument(tab, { clientId: client.id, category: "TAXES", visibility: "PUBLISHED", year: 2024, docType: "FEDERAL_RETURN", bytes: pdf(), originalName: "1040.pdf" });
    await staffUploadDocument(tab, { clientId: client.id, category: "TAXES", visibility: "PUBLISHED", year: 2024, docType: "STATE_RETURN", bytes: pdf(), originalName: "al40.pdf" });
    await staffUploadDocument(tab, { clientId: client.id, category: "TAXES", visibility: "PUBLISHED", year: 2024, docType: "AMENDED_RETURN", bytes: pdf(), originalName: "1040x.pdf" });
    const draft = await staffUploadDocument(tab, { clientId: client.id, category: "TAXES", visibility: "STAFF_ONLY", year: 2024, docType: "FEDERAL_RETURN", bytes: pdf(), originalName: "draft.pdf" });
    const r = await retrieveFilings(user, client.id, 2024);
    expect(r.groups.FEDERAL.map((d) => d.id)).toEqual([fed.id]);
    expect(r.groups.STATE).toHaveLength(1);
    expect(r.groups.AMENDED).toHaveLength(1);
    expect(r.total).toBe(3); // staff-only draft hidden
    await setVisibility(tab, draft.id, "PUBLISHED");
    expect((await retrieveFilings(user, client.id, 2024)).total).toBe(4);

    expect((await retrieveFilings(user, client.id, 2021)).total).toBe(0);
    const first = await requestFilingCopy(user, client.id, 2021);
    const again = await requestFilingCopy(user, client.id, 2021);
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(await prisma.task.count({ where: { clientId: client.id, status: "OPEN" } })).toBe(1);
    expect((await retrieveFilings(user, client.id, 2021)).openRequest).not.toBeNull();
    await expect(retrieveFilings(user, client.id, 2019)).rejects.toThrow(/Choose a year/);
  });

  it("an emailed invitation counts as verified; other clients' records stay out of reach", async () => {
    const a = await portal("a@example.com", "A", { emailed: true });
    const b = await portal("b@example.com", "B", { emailed: true });
    expect((await retrieveFilings(a.user, a.client.id, 2024)).total).toBe(0);
    await expect(retrieveFilings(a.user, b.client.id, 2024)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(requestFilingCopy(a.user, b.client.id, 2024)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await prisma.task.count()).toBe(0);
  });
});

describe("separate tax-year statuses", () => {
  it("questionnaire, documents, preparation, filing and acceptance don't imply each other", async () => {
    const { tab, client } = await portal("ana@example.com", "Ana");
    await setTaxYearProgress(tab, client.id, 2025, { documentsStatus: "ALL_RECEIVED", estimatedCompletion: new Date("2026-03-01T12:00:00Z") });
    let [y] = await taxYearStatuses(client.id, [2025]);
    expect(y.steps.map((s) => [s.key, s.done])).toEqual([["questionnaire", false], ["documents", true], ["preparation", false], ["filing", false], ["acceptance", false]]);
    await prisma.filingRecord.create({ data: { clientId: client.id, taxYear: 2025, returnType: "1040", jurisdiction: "FEDERAL", filingStatus: "SUBMITTED", prepStatus: "READY_TO_FILE" } });
    [y] = await taxYearStatuses(client.id, [2025]);
    expect(y.steps.find((s) => s.key === "filing")!.done).toBe(true);
    expect(y.steps.find((s) => s.key === "acceptance")!.value).toBe("Not yet");
  });
});

describe("news and countdowns", () => {
  it("announcements reach the chosen audience, respect schedule and expiry, pinned first, and send nothing", async () => {
    const { tab, client } = await portal("ana@example.com", "Ana");
    const biz = await createClient(tab, { businessName: "Bakery", clientType: "BUSINESS", status: "ACTIVE" });
    const base = { body: "Body", topic: "GENERAL", pinned: false, publishAt: null, expiresAt: null };
    await saveAnnouncement(tab, { ...base, title: "Everyone", audience: "ALL" });
    await saveAnnouncement(tab, { ...base, title: "Businesses", audience: "BUSINESS" });
    await saveAnnouncement(tab, { ...base, title: "Pinned hours", audience: "ALL", topic: "OFFICE_HOURS", pinned: true, publishAt: new Date(Date.now() - 86400_000) });
    await saveAnnouncement(tab, { ...base, title: "Later", audience: "ALL", publishAt: new Date(Date.now() + 86400_000) });
    await saveAnnouncement(tab, { ...base, title: "Over", audience: "ALL", publishAt: new Date(Date.now() - 2 * 86400_000), expiresAt: new Date(Date.now() - 60_000) });
    expect((await announcementsForClient(client.id)).map((a) => a.title)).toEqual(["Pinned hours", "Everyone"]);
    expect((await announcementsForClient(biz.id)).map((a) => a.title)).toEqual(["Pinned hours", "Businesses", "Everyone"]);
    expect(await prisma.notification.count()).toBe(0);
    const daria = await makeUser("STAFF");
    await expect(saveAnnouncement(daria, { ...base, title: "x", audience: "ALL" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("deadline dates need an official https source and are stamped with who reviewed them", async () => {
    const { tab, client } = await portal("ana@example.com", "Ana");
    await expect(saveDeadline(tab, { kind: "INDIVIDUAL", taxYear: 2026, jurisdiction: "US", dueDate: "2027-04-15", sourceUrl: "" })).rejects.toThrow(/source/);
    const d = await saveDeadline(tab, { kind: "INDIVIDUAL", taxYear: 2026, jurisdiction: "US", dueDate: "2027-04-15", sourceUrl: "https://www.irs.gov/filing/individuals/when-to-file" });
    expect(d.reviewedById).toBe(tab.id);
    await expect(saveDeadline(tab, { kind: "INDIVIDUAL", taxYear: 2026, jurisdiction: "US", dueDate: "2027-04-15", sourceUrl: "https://www.irs.gov/" })).rejects.toThrow(/already exists/);
    await expect(saveDeadline(tab, { kind: "INDIVIDUAL", taxYear: 2026, jurisdiction: "US", reliefState: "LA", dueDate: "2027-05-17", sourceUrl: "https://www.irs.gov/" })).rejects.toThrow(/Describe the relief/);
    const { cards } = await countdownsFor(client.id, new Date("2026-10-29T15:00:00Z"));
    expect(cards.find((c) => c.key === "individual")!.lines[0]).toMatchObject({ dueDate: "2027-04-15", basis: "VERIFIED", appliesToYou: true });
  });
});
