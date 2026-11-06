import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { form8879Pages, jordan, returnPdf, toPdf } from "./fixtures/tax-return-fixture";
import type { Actor } from "@/lib/auth/actor";
import { createClient } from "@/lib/services/clients";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { approveSummary } from "@/lib/services/tax-summary";
import { recordSigned8879, sendAutoSummaryForApproval, summaryTracker, uploadPreparedReturn, type UploadOutcome } from "@/lib/services/auto-tax-summary";

// The signed-in staff member for the download route and the release action (fictional people only).
let staff: Actor | null = null;
vi.mock("@/lib/auth/session", async (orig) => ({ ...(await orig<object>()), requireUser: async () => staff, getCurrentUser: async () => staff, clientIp: async () => "203.0.113.9" }));
vi.mock("@/lib/portal/session", async (orig) => ({ ...(await orig<object>()), getPortalUser: async () => null }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

beforeEach(async () => {
  await resetDb();
  vi.stubEnv("MALWARE_SCAN_URL", "https://scanner.test/scan");
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ clean: true }), { status: 200 }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function signedJordan() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const daria = await makeUser("STAFF", "Daria");
  const client = await createClient(tabitha, { firstName: "Jordan", lastName: "Sample", clientType: "INDIVIDUAL", status: "ACTIVE" });
  const { token } = await invitePortalUser(tabitha, client.id, { email: "jordan@fictional.example", name: "Jordan Sample", role: "OWNER" });
  const login = await acceptPortalInvite(token!, "Fictional-Pass-12345");
  const r = (await uploadPreparedReturn(tabitha, { clientId: client.id, taxYear: 2025, bytes: await returnPdf(jordan()), originalName: "return.pdf" })) as UploadOutcome;
  await sendAutoSummaryForApproval(tabitha, r.summaryId!);
  await approveSummary({ id: login.id, name: login.name, email: login.email }, client.id, r.summaryId!, { role: "TAXPAYER", signerName: "Jordan Sample", agreed: true });
  const s = await recordSigned8879(daria, { clientId: client.id, taxYear: 2025, bytes: await toPdf(form8879Pages({ taxpayer: { first: "Jordan", last: "Sample" }, agi: 62000, totalTax: 0, withheld: 4800, refund: 4935 })), originalName: "8879.pdf" });
  return { tabitha, daria, client, documentId: s.documentId };
}

describe("8879 Signature Page links", () => {
  it("Signed opens the PDF through the secure staff link, and the open is written to the document's access log", async () => {
    const { daria, documentId } = await signedJordan();
    const row = (await summaryTracker(daria, 2025))[0];
    expect(row.statusHref).toMatch(/^\/api\/documents\//);
    staff = daria;
    const { GET } = await import("@/app/api/documents/[token]/route");
    const token = row.statusHref!.replace("/api/documents/", "");
    const res = await GET(new Request(`http://localhost${row.statusHref}`), { params: Promise.resolve({ token }) });
    expect(res.status).toBe(200);
    const log = await prisma.documentAccessLog.findMany({ where: { documentId, action: "VIEW" } });
    expect(log).toHaveLength(1);
    expect(log[0].staffUserId).toBe(daria.id);
    // The link is bound to the viewer: another staff member can't use it.
    staff = await makeUser("STAFF", "Other");
    expect((await GET(new Request(`http://localhost${row.statusHref}`), { params: Promise.resolve({ token }) })).status).toBe(403);
  });

  it("staff who can't open that file see the row but no PDF link (No access)", async () => {
    const { daria, documentId } = await signedJordan();
    // Same rule as the Documents tab: a file that hasn't passed the malware scan opens for no one.
    await prisma.document.update({ where: { id: documentId }, data: { scanStatus: "PENDING" } });
    const row = (await summaryTracker(daria, 2025))[0];
    expect(row.clientName).toBe("Jordan Sample");
    expect(row.form8879.code).toBe("SIGNED");
    expect(row.statusHref).toBeNull();
    expect(row.noAccess).toBe(true);
  });
});

describe("release path", () => {
  it("Tax returns → Send to client also delivers the signed 8879 (and only then)", async () => {
    const { tabitha, client, documentId } = await signedJordan();
    const ret = await prisma.document.create({
      data: { client: { connect: { id: client.id } }, category: "TAXES", title: "2025 1040 — Federal", year: 2025, visibility: "STAFF_ONLY", filingDocType: "RETURN", reviewStatus: "DRAFT", scanStatus: "CLEAN", file: { create: { kind: "CLIENT_DOCUMENT", storageKey: "k-ret-2", originalName: "r.pdf", title: "r", mimeType: "application/pdf", sizeBytes: 1 } } },
    });
    expect((await prisma.document.findUniqueOrThrow({ where: { id: documentId } })).visibility).toBe("STAFF_ONLY");
    staff = tabitha;
    const { returnStepAction } = await import("@/app/actions/tax-returns");
    const r = await returnStepAction(ret.id, "release", null);
    expect(r?.error).toBeUndefined();
    expect(await prisma.document.findUniqueOrThrow({ where: { id: documentId } })).toMatchObject({ visibility: "PUBLISHED", title: "Form 8879 — Tax Year 2025 (signed)" });
  });
});
