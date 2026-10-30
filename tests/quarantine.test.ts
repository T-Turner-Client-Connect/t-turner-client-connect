import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { createClient } from "@/lib/services/clients";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { acknowledgeDocuments, authorizeDownload, downloadToken, portalDocuments, portalUploadDocument, scanQuarantined, staffUploadDocument } from "@/lib/services/documents";
import { interpretScanResponse, scanBytes, scannerSelfTest } from "@/lib/scan";
import { dispatchStaffAlerts, updateStaffAlertSettings } from "@/lib/services/staff-alerts";
import { storage } from "@/lib/storage";
import { chicagoLocalToUtc } from "@/lib/tz";

let pdfSeq = 0;
// Each upload gets unique bytes: the vault keeps one copy of identical files.
const pdfBytes = () => new TextEncoder().encode(`%PDF-1.4\n% fictional ${pdfSeq++}\n`);
type Call = { url: string; headers: Record<string, string>; body: unknown };
let calls: Call[] = [];
let verdict: (body: unknown) => unknown = () => ({ clean: true });

function stubNetwork() {
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, headers: (init.headers ?? {}) as Record<string, string>, body: init.body });
    if (url.includes("twilio")) return new Response(JSON.stringify({ sid: `SM${calls.length}` }), { status: 201 });
    if (url.includes("resend")) return new Response(JSON.stringify({ id: `re_${calls.length}` }), { status: 200 });
    return new Response(JSON.stringify(verdict(init.body)), { status: 200 });
  });
}

beforeEach(async () => {
  await resetDb();
  calls = [];
  verdict = () => ({ clean: true });
  stubNetwork();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function setup() {
  const tab = await makeUser("ADMIN");
  const c = await createClient(tab, { firstName: "Quinn", lastName: "Q", clientType: "INDIVIDUAL", status: "ACTIVE" });
  const { token } = await invitePortalUser(tab, c.id, { email: "quinn@example.com", name: "Quinn", role: "OWNER" });
  const u = await acceptPortalInvite(token!, "Quinn-Portal-Pass-1");
  return { tab, client: c, user: { id: u.id, name: u.name, email: u.email } };
}

describe("scanner adapters", () => {
  it("read ClamAV REST, Cloudmersive and generic answers", () => {
    expect(interpretScanResponse({ success: true, data: { result: [{ name: "f", is_infected: false, viruses: [] }] } })).toBe("CLEAN");
    expect(interpretScanResponse({ success: true, data: { result: [{ name: "f", is_infected: true, viruses: ["Eicar"] }] } })).toBe("INFECTED");
    expect(interpretScanResponse({ CleanResult: true, FoundViruses: null })).toBe("CLEAN");
    expect(interpretScanResponse({ CleanResult: false })).toBe("INFECTED");
    expect(interpretScanResponse({ Status: "FOUND" })).toBe("INFECTED");
    expect(interpretScanResponse({ clean: true })).toBe("CLEAN");
    expect(interpretScanResponse({ unexpected: 1 })).toBe("PENDING");
    expect(interpretScanResponse(null)).toBe("PENDING");
  });

  it("call each provider the documented way, and the self-test needs EICAR caught and a clean file passed", async () => {
    expect(await scanBytes(pdfBytes())).toBe("NOT_SCANNED");
    vi.stubEnv("MALWARE_SCAN_PROVIDER", "cloudmersive");
    vi.stubEnv("CLOUDMERSIVE_API_KEY", "cm_key");
    verdict = () => ({ CleanResult: true });
    expect(await scanBytes(pdfBytes(), "a.pdf")).toBe("CLEAN");
    expect(calls.at(-1)!.url).toBe("https://api.cloudmersive.com/virus/scan/file");
    expect(calls.at(-1)!.headers.Apikey).toBe("cm_key");
    expect((calls.at(-1)!.body as FormData).get("inputFile")).toBeInstanceOf(Blob);

    vi.stubEnv("MALWARE_SCAN_PROVIDER", "clamav-rest");
    vi.stubEnv("MALWARE_SCAN_URL", "https://clamav.example.com/api/v1/scan");
    expect(await scanBytes(pdfBytes(), "a.pdf")).toBe("CLEAN");
    expect((calls.at(-1)!.body as FormData).get("FILES")).toBeInstanceOf(Blob);

    // A scanner that passes everything fails the self-test (EICAR must be caught).
    verdict = () => ({ data: { result: [{ is_infected: false }] } });
    expect((await scannerSelfTest()).ok).toBe(false);
    verdict = (body) => ({ data: { result: [{ is_infected: ((body as FormData).get("FILES") as File).name === "eicar-test.txt" }] } });
    expect(await scannerSelfTest()).toMatchObject({ ok: true, eicar: "INFECTED", clean: "CLEAN" });
  });
});

describe("quarantine", () => {
  it("blocks download and client visibility until the scan passes, then releases and notifies", async () => {
    const { tab, client, user } = await setup();
    const doc = await staffUploadDocument(tab, { clientId: client.id, category: "TAXES", visibility: "PUBLISHED", year: 2025, docType: "TAX_RETURN", bytes: pdfBytes(), originalName: "1040.pdf" });
    expect(doc.scanStatus).toBe("NOT_SCANNED");
    expect(await authorizeDownload(downloadToken(doc.id, { staffId: tab.id }), { staffId: tab.id })).toBeNull();
    expect(await authorizeDownload(downloadToken(doc.id, { portalUserId: user.id }), { portalUserId: user.id })).toBeNull();
    expect(await portalDocuments(user, client.id)).toEqual([]);
    expect(await prisma.notification.count()).toBe(0); // no "new document" notice yet
    expect(await scanQuarantined()).toEqual({ scanned: 0, clean: 0, infected: 0 }); // no scanner → stays quarantined

    vi.stubEnv("MALWARE_SCAN_URL", "https://scanner.test/scan");
    expect(await scanQuarantined()).toMatchObject({ scanned: 1, clean: 1 });
    expect(await authorizeDownload(downloadToken(doc.id, { portalUserId: user.id }), { portalUserId: user.id })).not.toBeNull();
    expect((await portalDocuments(user, client.id)).map((d) => d.id)).toEqual([doc.id]);
    expect(await prisma.notification.count({ where: { kind: "NEW_DOCUMENT" } })).toBeGreaterThan(0);
    // Labeling a document never changes a filing.
    expect(await prisma.filingRecord.count()).toBe(0);
  });

  it("destroys infected files and keeps only the record", async () => {
    const { tab, client } = await setup();
    const doc = await staffUploadDocument(tab, { clientId: client.id, category: "OTHER", visibility: "PUBLISHED", bytes: pdfBytes(), originalName: "x.pdf" });
    const file = await prisma.storedFile.findUniqueOrThrow({ where: { id: doc.fileId } });
    vi.stubEnv("MALWARE_SCAN_URL", "https://scanner.test/scan");
    verdict = () => ({ clean: false });
    expect(await scanQuarantined()).toMatchObject({ infected: 1 });
    const after = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
    expect(after).toMatchObject({ scanStatus: "INFECTED", visibility: "STAFF_ONLY" });
    expect(await storage.get(file.storageKey)).toBeNull();
  });

  it("a scanner that doesn't answer leaves files quarantined", async () => {
    const { tab, client } = await setup();
    vi.stubEnv("MALWARE_SCAN_URL", "https://scanner.test/scan");
    vi.stubGlobal("fetch", async () => new Response("down", { status: 503 }));
    const doc = await staffUploadDocument(tab, { clientId: client.id, category: "OTHER", visibility: "STAFF_ONLY", bytes: pdfBytes(), originalName: "y.pdf" });
    expect(doc.scanStatus).toBe("PENDING");
    await scanQuarantined();
    expect((await prisma.document.findUniqueOrThrow({ where: { id: doc.id } })).scanStatus).toBe("PENDING");
  });
});

describe("client uploads", () => {
  it("stay Needs Review until acknowledged, keep the confirmed year, and alert the office once per batch", async () => {
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC_test");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "t");
    vi.stubEnv("TWILIO_MESSAGING_SERVICE_SID", "MG_test");
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("EMAIL_FROM_ADDRESS", "TTurner & Associates <alerts@mail.example.com>");
    const { tab, client, user } = await setup();
    await updateStaffAlertSettings(tab, { smsEnabled: true, phone: "205-659-5448", windowStart: "08:00", windowEnd: "17:00", emailEnabled: true, email: "info@tturnerassociates.com" });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(chicagoLocalToUtc("2026-11-03T10:00")!); // Tuesday
    const a = await portalUploadDocument(user, { clientId: client.id, year: 2025, title: "W-2", bytes: pdfBytes(), originalName: "w2.pdf" });
    const b = await portalUploadDocument(user, { clientId: client.id, year: "unsure", title: "Receipt", bytes: pdfBytes(), originalName: "r.pdf" });
    expect(a).toMatchObject({ needsReview: true, year: 2025 });
    expect(b.year).toBeNull();

    expect(calls.filter((c) => c.url.includes("twilio") || c.url.includes("resend"))).toHaveLength(0); // grouped, not sent per upload
    const pending = await prisma.staffAlert.findMany({ where: { status: "PENDING" } });
    expect(pending.map((p) => p.channel).sort()).toEqual(["EMAIL", "SMS"]);
    expect(pending.every((p) => p.documentIds.length === 2)).toBe(true);

    vi.setSystemTime(chicagoLocalToUtc("2026-11-03T10:06")!);
    await dispatchStaffAlerts();
    await dispatchStaffAlerts();
    const sms = calls.filter((c) => c.url.includes("twilio"));
    expect(sms).toHaveLength(1);
    const smsBody = new URLSearchParams(String(sms[0].body));
    expect(smsBody.get("To")).toBe("+12056595448");
    expect(smsBody.get("Body")).toBe("TTurner Client Connect: A client uploaded new documents. Sign in to review them.");
    const emails = calls.filter((c) => c.url.includes("resend"));
    expect(emails).toHaveLength(1);
    const email = JSON.parse(String(emails[0].body));
    expect(email.to).toEqual(["info@tturnerassociates.com"]);
    expect(email.text).toMatch(/Quinn Q uploaded a document: Client uploads, tax year 2025/);
    expect(email.text).toMatch(/tax year not given/);
    expect(email.attachments).toBeUndefined();

    expect(await acknowledgeDocuments(tab, client.id)).toBe(2);
    // Reviewed before a later text window: that alert is skipped.
    const c = await portalUploadDocument(user, { clientId: client.id, year: 2025, bytes: pdfBytes(), originalName: "late.pdf" });
    await acknowledgeDocuments(tab, client.id, [c.id]);
    vi.setSystemTime(chicagoLocalToUtc("2026-11-03T10:30")!);
    await dispatchStaffAlerts();
    expect(await prisma.staffAlert.count({ where: { status: "SKIPPED" } })).toBeGreaterThan(0);
  });
});
