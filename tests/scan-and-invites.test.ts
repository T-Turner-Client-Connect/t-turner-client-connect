import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { ForbiddenError } from "@/lib/auth/actor";
import { createClient } from "@/lib/services/clients";
import { scanHealth, scanQuarantined, staffUploadDocument } from "@/lib/services/documents";
import { approveReport, saveProfile, submitReportForReview, uploadMonthlyReport } from "@/lib/services/bookkeeping-clients";
import { scanState } from "@/lib/scan-labels";
import { inviteStaff } from "@/lib/services/staff-invitations";
import { acceptInvite } from "@/lib/services/users";

let n = 0;
const pdf = () => new TextEncoder().encode(`%PDF-1.4\n% fictional ${n++}\n`);
const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

beforeEach(async () => {
  await resetDb();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("malware scan status (local scanner stub — not a live check)", () => {
  it("shows Pending without a scanner, Scanning with reasons, Passed/Failed — and never releases a file except on a clean scan", async () => {
    const tabitha = await makeUser("ADMIN", "Tabitha");
    await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
    const c = await createClient(tabitha, { businessName: "Fictional Co", clientType: "BUSINESS", status: "ACTIVE" });
    await saveProfile(tabitha, c.id, { active: true, frequency: "MONTHLY", payroll: false });
    await prisma.bookkeepingProfile.update({ where: { clientId: c.id }, data: { accountingBasis: "CASH" } });

    // 1) No scanner configured: quarantined, labelled Pending with the setup reason.
    const r1 = await uploadMonthlyReport(tabitha, { clientId: c.id, year: 2026, month: 9, reportType: "PROFIT_AND_LOSS", bytes: pdf(), originalName: "pl.pdf" });
    let d1 = await prisma.document.findUniqueOrThrow({ where: { id: r1.document.id } });
    expect(d1.scanStatus).toBe("NOT_SCANNED");
    expect(scanState(d1, { configured: false, recheckRunning: false, lastRecheckAt: null })).toMatchObject({ label: "Unavailable" });
    expect(scanState(d1, { configured: false, recheckRunning: false, lastRecheckAt: null }).explain).toMatch(/isn't set up/);
    await expect(submitReportForReview(tabitha, d1.id)).rejects.toThrow(/malware scan/);

    // 2) Scanner configured but not answering: Scanning, with the reason and attempt count.
    vi.stubEnv("MALWARE_SCAN_URL", "https://scanner.test/scan");
    vi.stubGlobal("fetch", async () => new Response("bad gateway", { status: 502 }));
    await scanQuarantined(25, "scheduled");
    d1 = await prisma.document.findUniqueOrThrow({ where: { id: d1.id } });
    expect([d1.scanStatus, d1.scanAttempts]).toEqual(["PENDING", 1]);
    expect(d1.lastScanError).toMatch(/HTTP 502/);
    const health = await scanHealth();
    expect(health).toMatchObject({ configured: true, recheckRunning: true });
    expect(scanState(d1, health)).toMatchObject({ label: "Scanning" });

    // 3) Scanner answers clean: Passed — and the report is still a staff-only draft (scan ≠ approval).
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ clean: true }), { status: 200 }));
    await scanQuarantined();
    d1 = await prisma.document.findUniqueOrThrow({ where: { id: d1.id } });
    expect([d1.scanStatus, d1.visibility, d1.reviewStatus]).toEqual(["CLEAN", "STAFF_ONLY", "DRAFT"]);
    expect(scanState(d1, health).label).toBe("Passed");
    await submitReportForReview(tabitha, d1.id);
    await approveReport(tabitha, d1.id);
    expect((await prisma.document.findUniqueOrThrow({ where: { id: d1.id } })).visibility).toBe("STAFF_ONLY");

    // 4) The standard antivirus test file is refused at upload.
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
      const body = new TextDecoder().decode(init.body as Uint8Array);
      return new Response(JSON.stringify({ clean: !body.includes("EICAR") }), { status: 200 });
    });
    await expect(staffUploadDocument(tabitha, { clientId: c.id, category: "BOOKKEEPING", visibility: "STAFF_ONLY", bytes: new TextEncoder().encode(`%PDF-1.4\n${EICAR}\n`), originalName: "eicar.pdf" })).rejects.toThrow(/flagged by the virus scanner/);
    expect(scanState({ scanStatus: "INFECTED" }, health).label).toBe("Failed");
  });
});

describe("staff invitations", () => {
  it("are Admin-only, invitation-only, and carry the chosen permissions; only Tabitha can include billing", async () => {
    const tabitha = await makeUser("ADMIN", "Tabitha");
    await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
    const otherAdmin = await makeUser("ADMIN", "Second");
    const daria = await makeUser("STAFF", "Daria");
    await expect(inviteStaff(daria, { email: "new@staff.example", name: "New Person", role: "STAFF" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(inviteStaff(otherAdmin, { email: "new@staff.example", name: "New Person", role: "STAFF", grants: { billing: true } })).rejects.toThrow(/Only Tabitha/);
    const out = await inviteStaff(tabitha, { email: "new@staff.example", name: "New Person", role: "STAFF", grants: { identityAll: true, billing: true } });
    expect(out.inviteId).toBeTruthy();
    // No email provider in tests: a private link fallback is offered instead.
    const inv = await prisma.invite.findUniqueOrThrow({ where: { id: out.inviteId } });
    expect([inv.role, inv.grantIdentityAccessAll, inv.grantBillingAccess]).toEqual(["STAFF", true, true]);
    const token = out.privateLink?.split("/").pop()?.split("?")[0];
    expect(token).toBeTruthy();
    const user = await acceptInvite(token!, "New-Staff-Pass-2026!");
    expect([user.role, user.identityAccessAll, user.bookkeepingBillingAccess, user.mfaEnabledAt]).toEqual(["STAFF", true, true, null]);
    await expect(acceptInvite(token!, "New-Staff-Pass-2026!")).rejects.toThrow();
  });
});

describe("automatic re-check status counts only scheduled runs", () => {
  it("a manual scan never shows as the automatic re-check; the cron route refuses without CRON_SECRET and records the refusal", async () => {
    vi.stubEnv("MALWARE_SCAN_URL", "https://scanner.test/scan");
    vi.stubEnv("CRON_SECRET", "");
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ clean: true }), { status: 200 }));
    // An older row from before runs were labeled doesn't count either.
    await prisma.systemHeartbeat.create({ data: { key: "quarantine-scan", at: new Date(), detail: { configured: true, scanned: 0 } as never } });
    await scanQuarantined(50, "manual");
    let h = await scanHealth();
    expect([h.recheckRunning, h.lastRecheckAt, h.cronSecretSet]).toEqual([false, null, false]);
    expect(h.lastManualAt).toBeInstanceOf(Date);

    const { POST } = await import("@/app/api/cron/notifications/route");
    const call = (auth?: string) => POST(new Request("https://site.test/api/cron/notifications", { method: "POST", headers: auth ? { authorization: auth } : {} }));
    expect((await call("Bearer undefined")).status).toBe(401);
    h = await scanHealth();
    expect([h.recheckRunning, h.lastRefusedAt instanceof Date]).toEqual([false, true]);

    vi.stubEnv("CRON_SECRET", "test-secret-0123456789abcdef0123");
    expect((await call("Bearer wrong-secret-0123456789abcdef01")).status).toBe(401);
    expect((await call("Bearer test-secret-0123456789abcdef0123")).status).toBe(200);
    h = await scanHealth();
    expect([h.recheckRunning, h.cronSecretSet, h.lastRecheck?.configured]).toEqual([true, true, true]);
  });
});
