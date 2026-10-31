import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { createClient } from "@/lib/services/clients";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { authorizeDownload, downloadToken, portalUploadDocument, scanQuarantined } from "@/lib/services/documents";
import { ensureClientPerson, uploadIdentityDocument } from "@/lib/services/identity";
import { clientScanState } from "@/lib/scan-labels";

const pdf = () => new TextEncoder().encode(`%PDF-1.4\n% fictional ${Math.random()}\n`);
let scanner: "down" | "clean" = "down";
beforeEach(async () => {
  await resetDb();
  scanner = "down";
  vi.stubEnv("MALWARE_SCAN_URL", "https://scanner.test/scan");
  vi.stubGlobal("fetch", async () => (scanner === "clean" ? new Response(JSON.stringify({ clean: true }), { status: 200 }) : new Response("unavailable", { status: 503 })));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("client upload receipts and the virus check", () => {
  it("names four states: Pending scan, Scanning, Passed, Failed/unavailable", () => {
    expect(clientScanState({ scanStatus: "NOT_SCANNED" }, { configured: true }).label).toBe("Pending scan");
    expect(clientScanState({ scanStatus: "PENDING", scanAttempts: 1 }, { configured: true }).label).toBe("Scanning");
    expect(clientScanState({ scanStatus: "CLEAN" }, { configured: true }).label).toBe("Passed");
    expect(clientScanState({ scanStatus: "INFECTED" }, { configured: true }).label).toBe("Failed");
    expect(clientScanState({ scanStatus: "PENDING", scanAttempts: 2, lastScanError: "The scanner answered with an error (HTTP 503)." }, { configured: true }).label).toBe("Unavailable");
    expect(clientScanState({ scanStatus: "NOT_SCANNED" }, { configured: false }).label).toBe("Unavailable");
  });

  it("a quarantined upload can't be opened by anyone until it passes; identity cards stay Admin-only after passing", async () => {
    const tabitha = await makeUser("ADMIN", "Tabitha");
    const c = await createClient(tabitha, { businessName: "Fictional Insulation LLC", clientType: "BUSINESS", status: "ACTIVE" });
    const { token } = await invitePortalUser(tabitha, c.id, { email: "pat@fictional.example", name: "Pat Owner", role: "OWNER" });
    const login = await acceptPortalInvite(token!, "Owner-Pass-12345");
    const user = { id: login.id, name: login.name, email: login.email };

    // Scanner unreachable: received and held, never marked clean.
    const doc = await portalUploadDocument(user, { clientId: c.id, year: 2026, docType: "W2", bytes: pdf(), originalName: "statement.pdf" });
    expect((await prisma.document.findUniqueOrThrow({ where: { id: doc.id } })).scanStatus).not.toBe("CLEAN");
    expect(await authorizeDownload(downloadToken(doc.id, { portalUserId: login.id }), { portalUserId: login.id })).toBeNull();
    expect(await authorizeDownload(downloadToken(doc.id, { staffId: tabitha.id }), { staffId: tabitha.id })).toBeNull();
    await scanQuarantined();
    expect((await prisma.document.findUniqueOrThrow({ where: { id: doc.id } })).scanStatus).toBe("PENDING");

    // Scanner back: the re-check passes it, and only then does it open.
    scanner = "clean";
    const r = await scanQuarantined();
    expect(r.clean).toBeGreaterThanOrEqual(1);
    expect(await authorizeDownload(downloadToken(doc.id, { portalUserId: login.id }), { portalUserId: login.id })).not.toBeNull();

    // A Social Security card the client uploads: receipt only, even after a clean scan.
    const person = await ensureClientPerson(c.id);
    const id = await uploadIdentityDocument({ portal: user }, { clientId: c.id, personId: person.id, type: "SOCIAL_SECURITY_CARD", bytes: pdf(), originalName: "ss-card.pdf" });
    const idDoc = await prisma.document.findFirstOrThrow({ where: { clientId: c.id, category: "IDENTITY" } });
    expect(idDoc.scanStatus).toBe("CLEAN");
    expect(await authorizeDownload(downloadToken(idDoc.id, { portalUserId: login.id }), { portalUserId: login.id })).toBeNull();
    expect(await authorizeDownload(downloadToken(idDoc.id, { staffId: tabitha.id }), { staffId: tabitha.id })).not.toBeNull();
    expect(id).toBeTruthy();
  });
});
