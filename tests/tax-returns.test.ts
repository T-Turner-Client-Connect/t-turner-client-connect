import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { ForbiddenError } from "@/lib/auth/actor";
import { createClient } from "@/lib/services/clients";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { authorizeDownload, downloadToken, setVisibility, staffUploadDocument } from "@/lib/services/documents";
import { confirmPortalIdentity, retrieveFilings } from "@/lib/services/tax-center";
import { setFilingStatusByStaff } from "@/lib/services/tax";
import { createAndLinkBusiness, grantOwnerPortalAccess } from "@/lib/services/related-businesses";
import { bulkUploadReturns, confirmIntake, discardIntake, emailMyCopy, fileReturn, filingLabel, releaseReturn, returnsQueue, submitReturnForRelease } from "@/lib/services/tax-returns";

const pdf = (tag: string | number = Math.random()) => new TextEncoder().encode(`%PDF-1.4\n% fictional return ${tag}\n`);
const sent: { to: string; text: string; html: string }[] = [];
let emailOk = true;
beforeEach(async () => {
  await resetDb();
  sent.length = 0;
  emailOk = true;
  vi.stubEnv("MALWARE_SCAN_URL", "https://scanner.test/scan");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("EMAIL_FROM_ADDRESS", "TTurner & Associates <info@tturnerassociates.com>");
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (String(url).includes("/emails")) {
      if (!emailOk) return new Response(JSON.stringify({ message: "domain not verified" }), { status: 403 });
      const b = JSON.parse(String(init?.body ?? "{}"));
      sent.push({ to: Array.isArray(b.to) ? b.to[0] : b.to, text: b.text ?? "", html: b.html ?? "" });
      return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
    }
    return new Response(JSON.stringify({ clean: true }), { status: 200 });
  });
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
  const energy = await createClient(tabitha, { firstName: "Steven", lastName: "Cox", businessName: "Energy Solutions Insulation, LLC", clientType: "BUSINESS", status: "ACTIVE" });
  const drive = await createAndLinkBusiness(tabitha, energy.id, { businessName: "Drive Time", clientType: "BUSINESS" });
  const { token } = await invitePortalUser(tabitha, energy.id, { email: "steven@fictional.example", name: "Steven Cox", role: "OWNER" });
  const login = await acceptPortalInvite(token!, "Steven-Pass-12345");
  await grantOwnerPortalAccess(tabitha, energy.id, drive.id, login.id);
  await confirmPortalIdentity(tabitha, energy.id, login.id, "In person with photo ID");
  const steven = { id: login.id, name: login.name, email: login.email };
  return { tabitha, otherAdmin, daria, energy, drive, login, steven };
}

describe("Tax Return Delivery", () => {
  it("files a single return as a staff-only draft; only Tabitha releases it; revisions and duplicates", async () => {
    const { tabitha, otherAdmin, daria, energy, steven } = await setup();
    const bytes = pdf("energy-1120s-2025");
    const v1 = await fileReturn(daria, { clientId: energy.id, taxYear: 2025, returnType: "1120-S", jurisdiction: "FEDERAL", filingType: "ORIGINAL", bytes, originalName: "1120s.pdf" });
    expect([v1.visibility, v1.reviewStatus, v1.docType, v1.year]).toEqual(["STAFF_ONLY", "DRAFT", "FEDERAL_RETURN", 2025]);
    expect((await retrieveFilings(steven, energy.id, 2025)).total).toBe(0);
    // The same file can't be filed twice; the generic paths can't publish a return.
    await expect(fileReturn(daria, { clientId: energy.id, taxYear: 2025, returnType: "1120-S", jurisdiction: "FEDERAL", filingType: "ORIGINAL", bytes, originalName: "again.pdf" })).rejects.toThrow(/already saved/);
    await expect(setVisibility(tabitha, v1.id, "PUBLISHED")).rejects.toThrow(/Tabitha releases/);
    await expect(staffUploadDocument(tabitha, { clientId: energy.id, category: "TAXES", visibility: "PUBLISHED", year: 2025, docType: "FEDERAL_RETURN", bytes: pdf(), originalName: "x.pdf" })).rejects.toThrow(/Tabitha releases/);
    // Release: needs review first; only Tabitha.
    await expect(releaseReturn(tabitha, v1.id)).rejects.toThrow(/review first/);
    await submitReturnForRelease(daria, v1.id);
    await expect(releaseReturn(daria, v1.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(releaseReturn(otherAdmin, v1.id)).rejects.toBeInstanceOf(ForbiddenError);
    await releaseReturn(tabitha, v1.id);
    let r = await retrieveFilings(steven, energy.id, 2025);
    expect(r.groups.FEDERAL.map((d) => d.id)).toEqual([v1.id]);
    // A corrected copy becomes version 2; the client sees only the newest released version.
    const v2 = await fileReturn(daria, { clientId: energy.id, taxYear: 2025, returnType: "1120-S", jurisdiction: "FEDERAL", filingType: "ORIGINAL", bytes: pdf("v2"), originalName: "1120s-corrected.pdf" });
    expect([v2.version, v2.replacesId]).toEqual([2, v1.id]);
    expect((await retrieveFilings(steven, energy.id, 2025)).groups.FEDERAL.map((d) => d.id)).toEqual([v1.id]); // v2 still a draft
    await submitReturnForRelease(daria, v2.id);
    await releaseReturn(tabitha, v2.id);
    r = await retrieveFilings(steven, energy.id, 2025);
    expect(r.groups.FEDERAL.map((d) => d.id)).toEqual([v2.id]);
    expect((await prisma.document.findUniqueOrThrow({ where: { id: v1.id } })).supersededAt).not.toBeNull(); // history kept
  });

  it("bulk: suggestions need confirmation; ambiguous and unmatched files stay staff-only; duplicates skipped; business and year separation", async () => {
    const { tabitha, daria, energy, drive, steven } = await setup();
    await createClient(tabitha, { businessName: "Drive Time, Inc.", clientType: "BUSINESS", status: "ACTIVE" }); // a second "Drive Time" makes the file name ambiguous
    const dup = pdf("dup");
    const out = await bulkUploadReturns(daria, [
      { bytes: pdf("e"), originalName: "2025 Energy Solutions Insulation 1120-S.pdf" },
      { bytes: pdf("d"), originalName: "2024 Drive Time 1065.pdf" },
      { bytes: pdf("u"), originalName: "scan0042.pdf" },
      { bytes: dup, originalName: "dup.pdf" },
      { bytes: dup, originalName: "dup-copy.pdf" },
    ]);
    expect(out.map((o) => o.duplicate)).toEqual([false, false, false, false, true]);
    const q = await returnsQueue();
    const by = (n: string) => q.intakes.find((i) => i.originalName.startsWith(n))!;
    expect([by("2025 Energy").suggestedClientId, by("2025 Energy").suggestedYear, by("2025 Energy").suggestedType]).toEqual([energy.id, 2025, "1120-S"]);
    expect(by("2024 Drive").suggestedClientId).toBeNull(); // ambiguous
    expect(by("2024 Drive").matchReason).toMatch(/Ambiguous/);
    expect(by("scan0042").suggestedClientId).toBeNull();
    // Nothing reaches a client before confirmation.
    expect(await prisma.document.count({ where: { filingDocType: "RETURN" } })).toBe(0);
    const e = await confirmIntake(daria, by("2025 Energy").id, { clientId: energy.id, taxYear: 2025, returnType: "1120-S", jurisdiction: "FEDERAL", filingType: "ORIGINAL" });
    const d = await confirmIntake(daria, by("2024 Drive").id, { clientId: drive.id, taxYear: 2024, returnType: "40", jurisdiction: "AL", filingType: "ORIGINAL" });
    await discardIntake(daria, by("scan0042").id, "Not a return");
    for (const x of [e, d]) { await submitReturnForRelease(daria, x.id); await releaseReturn(tabitha, x.id); }
    // Separate by business and year.
    expect((await retrieveFilings(steven, energy.id, 2025)).groups.FEDERAL.map((x) => x.id)).toEqual([e.id]);
    expect((await retrieveFilings(steven, drive.id, 2025)).total).toBe(0);
    expect((await retrieveFilings(steven, drive.id, 2024)).groups.STATE.map((x) => x.id)).toEqual([d.id]);
    expect((await retrieveFilings(steven, energy.id, 2024)).total).toBe(0);
  });

  it("Accepted only from a verified acknowledgment; Email My Copy sends a sign-in link to the verified email; other clients can't open it", async () => {
    const { tabitha, daria, energy, steven, login } = await setup();
    const doc = await fileReturn(daria, { clientId: energy.id, taxYear: 2025, returnType: "1120-S", jurisdiction: "FEDERAL", filingType: "ORIGINAL", bytes: pdf(), originalName: "r.pdf" });
    await submitReturnForRelease(daria, doc.id);
    await releaseReturn(tabitha, doc.id);
    const filing = await prisma.filingRecord.findUniqueOrThrow({ where: { id: doc.filingId! } });
    expect(filingLabel(filing.filingStatus)).toBeNull(); // uploading a PDF claims nothing
    await setFilingStatusByStaff(daria, filing.id, { status: "SUBMITTED", eventAt: new Date(Date.now() - 3_600_000) });
    expect(filingLabel("SUBMITTED")?.label).toBe("Submitted — awaiting acknowledgment");
    await expect(setFilingStatusByStaff(daria, filing.id, { status: "ACCEPTED" })).rejects.toThrow(/acknowledgment/);
    await setFilingStatusByStaff(daria, filing.id, { status: "ACCEPTED", verificationNote: "IRS acknowledgment in TaxAct E-file Center" });
    expect((await retrieveFilings(steven, energy.id, 2025)).groups.FEDERAL[0].filing?.filingStatus).toBe("ACCEPTED");
    expect(filingLabel("REJECTED")?.label).toBe("Rejected");

    // Email My Copy: verified email only; a link, never the file; result recorded.
    await expect(emailMyCopy(steven, energy.id, doc.id)).rejects.toThrow(/Verify your email/);
    await prisma.portalUser.update({ where: { id: login.id }, data: { emailVerifiedAt: new Date() } });
    const ok = await emailMyCopy(steven, energy.id, doc.id);
    expect(ok.ok).toBe(true);
    expect(sent.at(-1)?.to).toBe("steven@fictional.example");
    expect(sent.at(-1)?.text).toMatch(/\/client\/taxes\/filings\?account=/);
    expect(sent.at(-1)?.text).not.toMatch(/\/api\/documents\//);
    emailOk = false;
    const failed = await emailMyCopy(steven, energy.id, doc.id);
    expect(failed.ok).toBe(false);
    const notes = await prisma.notification.findMany({ where: { portalUserId: login.id, kind: "RETURN_COPY" }, orderBy: { createdAt: "asc" } });
    expect(notes.map((n) => n.status)).toEqual(["SENT", "FAILED"]);

    // Another client can't reach this return.
    const other = await createClient(tabitha, { firstName: "Other", lastName: "Client", clientType: "INDIVIDUAL", status: "ACTIVE" });
    const { token } = await invitePortalUser(tabitha, other.id, { email: "other@fictional.example", name: "Other Client", role: "OWNER" });
    const o = await acceptPortalInvite(token!, "Other-Pass-12345");
    expect(await authorizeDownload(downloadToken(doc.id, { portalUserId: o.id }), { portalUserId: o.id })).toBeNull();
    await expect(retrieveFilings({ id: o.id, name: o.name, email: o.email }, energy.id, 2025)).rejects.toThrow();
    await expect(emailMyCopy({ id: o.id, name: o.name, email: o.email }, energy.id, doc.id)).rejects.toThrow();
  });
});
