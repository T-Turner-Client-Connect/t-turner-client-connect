import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { ForbiddenError } from "@/lib/auth/actor";
import { createClient } from "@/lib/services/clients";
import { attachFilingDocument, correctFilingForm, createFiling, setFilingStatusByStaff } from "@/lib/services/tax";
import { staffUploadDocument } from "@/lib/services/documents";
import { fileReturn } from "@/lib/services/tax-returns";

const pdf = (tag: string) => new TextEncoder().encode(`%PDF-1.4\n% fictional state return ${tag}\n`);

beforeEach(async () => {
  await resetDb();
  vi.stubEnv("MALWARE_SCAN_URL", "https://scanner.test/scan");
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ clean: true }), { status: 200 }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function setup() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const otherAdmin = await makeUser("ADMIN", "Other Admin");
  const daria = await makeUser("STAFF", "Daria");
  const client = await createClient(tabitha, { firstName: "Fictional", lastName: "Taxpayer", clientType: "INDIVIDUAL", status: "ACTIVE" });
  // The mistake: an Alabama state return recorded as form "1040" instead of 40.
  const al = await createFiling(tabitha, { clientId: client.id, taxYear: 2025, returnType: "1040", jurisdiction: "AL", filingType: "ORIGINAL" });
  await setFilingStatusByStaff(tabitha, al.id, { status: "ACCEPTED", verificationNote: "Checked state ack in TaxAct (fictional)", submission: { form8879Confirmed: true, overrideReason: "Fictional test filing" } });
  return { tabitha, otherAdmin, daria, client, al };
}

describe("Correct a filing's form number (owner only)", () => {
  it("fixes AL 1040 → 40, keeps the Accepted status, renames the delivered return and records why", async () => {
    const { tabitha, client, al } = await setup();
    const doc = await fileReturn(tabitha, { clientId: client.id, taxYear: 2025, returnType: "1040", jurisdiction: "AL", filingType: "ORIGINAL", bytes: pdf("a"), originalName: "state.pdf" });
    expect(doc.title).toBe("2025 1040 — AL");

    const r = await correctFilingForm(tabitha, al.id, "40", "Entered as 1040 by mistake");
    expect(r).toEqual({ from: "1040", to: "40", renamed: 1 });

    const f = await prisma.filingRecord.findUniqueOrThrow({ where: { id: al.id } });
    expect(f.returnType).toBe("40");
    expect(f.filingStatus).toBe("ACCEPTED");
    expect((await prisma.document.findUniqueOrThrow({ where: { id: doc.id } })).title).toBe("2025 40 — AL");

    const ev = await prisma.filingStatusEvent.findFirstOrThrow({ where: { filingId: al.id, field: "FORM" } });
    expect([ev.fromValue, ev.toValue, ev.verificationNote]).toEqual(["1040", "40", "Entered as 1040 by mistake"]);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: "filing.form_corrected", entityId: al.id } });
    expect(log.actorId).toBe(tabitha.id);
  });

  it("lets the state return be delivered under the corrected form 40 afterwards", async () => {
    const { tabitha, client, al } = await setup();
    await expect(fileReturn(tabitha, { clientId: client.id, taxYear: 2025, returnType: "40", jurisdiction: "AL", filingType: "ORIGINAL", bytes: pdf("b"), originalName: "state.pdf" })).rejects.toThrow(/no filing record/);
    await correctFilingForm(tabitha, al.id, "40", "Typo");
    const doc = await fileReturn(tabitha, { clientId: client.id, taxYear: 2025, returnType: "40", jurisdiction: "AL", filingType: "ORIGINAL", bytes: pdf("b"), originalName: "state.pdf" });
    expect(doc.title).toBe("2025 40 — AL");
  });

  it("only Tabitha can correct it, and a reason is required", async () => {
    const { otherAdmin, daria, tabitha, al } = await setup();
    await expect(correctFilingForm(otherAdmin, al.id, "40", "x")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(correctFilingForm(daria, al.id, "40", "x")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(correctFilingForm(tabitha, al.id, "40", "   ")).rejects.toThrow(/Say why/);
    await expect(correctFilingForm(tabitha, al.id, "1040", "same")).rejects.toThrow(/already form 1040/);
    expect((await prisma.filingRecord.findUniqueOrThrow({ where: { id: al.id } })).returnType).toBe("1040");
  });

  it("refuses a correction that would duplicate an existing filing", async () => {
    const { tabitha, client, al } = await setup();
    await createFiling(tabitha, { clientId: client.id, taxYear: 2025, returnType: "40", jurisdiction: "AL", filingType: "ORIGINAL" });
    await expect(correctFilingForm(tabitha, al.id, "40", "Typo")).rejects.toThrow(/already has a 2025 form 40 filing for AL/);
  });

  it("doesn't rename unrelated document titles that merely contain the digits", async () => {
    const { tabitha, client, al } = await setup();
    const up = await staffUploadDocument(tabitha, { clientId: client.id, category: "TAXES", title: "Notice 10401 follow-up", year: 2025, visibility: "STAFF_ONLY", bytes: pdf("n"), originalName: "notice.pdf" });
    await attachFilingDocument(tabitha, al.id, up.id, "CORRESPONDENCE");
    const doc = { id: up.id };
    const r = await correctFilingForm(tabitha, al.id, "40", "Typo");
    expect(r.renamed).toBe(0);
    expect((await prisma.document.findUniqueOrThrow({ where: { id: doc.id } })).title).toBe("Notice 10401 follow-up");
  });
});
