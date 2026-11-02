import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import { makeUser, prisma, resetDb } from "./db";
import { ForbiddenError } from "@/lib/auth/actor";
import { createClient } from "@/lib/services/clients";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { createAndLinkBusiness, grantOwnerPortalAccess } from "@/lib/services/related-businesses";
import { staffUploadDocument } from "@/lib/services/documents";
import { sendAgreement, signAgreement, signingHash, viewAgreement } from "@/lib/services/service-agreements";
import type { AgreementTerms } from "@/lib/billing/agreement-terms";
import {
  applyStateTemplate, assignPackage, bundleFiles, GRANT_DISCLAIMER, portalPortfolio, releaseItemFile, savePackage, saveStateTemplate, updateChecklistItem, uploadItemFile, type PackageDeliverable,
} from "@/lib/services/nonprofit-portfolio";
import { combinePrintable } from "@/lib/file-bundle";

beforeEach(async () => {
  await resetDb();
  vi.stubEnv("MALWARE_SCAN_URL", "https://scanner.test/scan");
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ clean: true }), { status: 200 }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const pdf = async (label: string) => {
  const d = await PDFDocument.create();
  d.addPage([300, 300]).drawText(label);
  d.setTitle(`${label} ${Math.random()}`);
  return d.save();
};
const enc = new TextEncoder();
// A minimal stand-in for a .docx package: the ZIP signature plus the parts a Word file contains.
const docx = (macros = false) =>
  Uint8Array.from([0x50, 0x4b, 0x03, 0x04, ...enc.encode(`[Content_Types].xml word/document.xml ${macros ? "word/vbaProject.bin " : ""}${Math.random()}`)]);

const FORMATION: PackageDeliverable[] = [
  { key: "sos_formation", label: "Filed Articles of Incorporation", section: "FORMATION" },
  { key: "incorporator_statement", label: "Statement of the Incorporator", section: "FORMATION" },
  { key: "ein", label: "EIN / Tax ID confirmation", section: "FORMATION" },
  { key: "org_minutes", label: "Organizational meeting minutes", section: "FORMATION" },
  { key: "bylaws", label: "Corporate bylaws", section: "FORMATION" },
  { key: "bank_resolution", label: "Banking resolution", section: "FORMATION" },
  { key: "irs_application", label: "501(c)(3) application preparation and filing assistance", section: "IRS" },
];
const COMPLETE: PackageDeliverable[] = [...FORMATION, { key: "sam_registration", label: "SAM.gov registration assistance", section: "SAM" }, { key: "grant_checklist", label: "Grant-readiness checklist", section: "GRANT" }];

async function setup() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const daria = await makeUser("STAFF", "Daria");
  const rb = await createClient(tabitha, { businessName: "RB Industrial LLC", firstName: "James", lastName: "Bradley", clientType: "BUSINESS", status: "ACTIVE", email: "james@rb-fictional.example" });
  const org = await createAndLinkBusiness(tabitha, rb.id, { businessName: "Bradley Community Foundation", clientType: "NONPROFIT" });
  const { token } = await invitePortalUser(tabitha, rb.id, { email: "james@rb-fictional.example", name: "James Bradley", role: "OWNER" });
  const j = await acceptPortalInvite(token!, "James-Portal-Pass-12");
  const james = { id: j.id, name: j.name, email: j.email };
  await grantOwnerPortalAccess(tabitha, rb.id, org.id, james.id);
  await savePackage(tabitha, "AL_BASIC", { name: "Alabama Basic Nonprofit Formation", priceCents: 250000, govFeesMode: "ADDED", deliverables: FORMATION, grantDisclaimer: false, active: true });
  await savePackage(tabitha, "OTHER_STATE", { name: "Other-State Nonprofit Formation", priceCents: 350000, priceNote: "Starting at", statePrices: { GA: 375000 }, govFeesMode: "INCLUDED", deliverables: FORMATION, grantDisclaimer: false, active: true });
  await savePackage(tabitha, "COMPLETE", { name: "Complete Nonprofit Portfolio", priceCents: 500000, govFeesMode: "ADDED", deliverables: COMPLETE, grantDisclaimer: true, active: true });
  // The client signs the package agreement in the portal.
  const sign = async (agreementId: string) => {
    await sendAgreement(daria, agreementId);
    const t = (await viewAgreement(james, agreementId)).terms as unknown as AgreementTerms;
    await signAgreement(james, { agreementId, method: "ZELLE", signerName: "James Bradley", agreed: true, shownHash: signingHash(t, "ZELLE") });
    return t;
  };
  return { tabitha, daria, org, james, sign };
}

describe("formation packages", () => {
  it("only the owner edits packages; prices by state; government fees included or added", async () => {
    const { tabitha, daria, org } = await setup();
    await expect(savePackage(daria, "X_PKG", { name: "x", priceCents: 1, govFeesMode: "ADDED", deliverables: FORMATION, grantDisclaimer: false, active: true })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(savePackage(tabitha, "X_PKG", { name: "x", priceCents: 100, govFeesMode: "MAYBE", deliverables: FORMATION, grantDisclaimer: false, active: true })).rejects.toThrow(/included in the price or added/);

    // Alabama: fees added as their own line.
    const r = await assignPackage(daria, org.id, { packageKey: "AL_BASIC", govFeeCents: 45000 });
    let t = (await prisma.pricingAgreement.findUniqueOrThrow({ where: { id: r.agreementId } })).terms as unknown as AgreementTerms;
    expect(t.lines).toEqual([{ label: "Alabama Basic Nonprofit Formation", cents: 250000 }, { label: "Government filing fees (paid to the state and IRS; added to the package price)", cents: 45000 }]);
    expect(t.disclaimers).toBeUndefined();

    // Other state priced for Georgia, fees included: new agreement version, same service.
    await prisma.nonprofitPortfolio.update({ where: { clientId: org.id }, data: { formationState: "GA" } });
    const r2 = await assignPackage(daria, org.id, { packageKey: "OTHER_STATE" });
    t = (await prisma.pricingAgreement.findUniqueOrThrow({ where: { id: r2.agreementId } })).terms as unknown as AgreementTerms;
    expect(r2.serviceId).toBe(r.serviceId);
    expect(t.lines).toEqual([{ label: "Other-State Nonprofit Formation (government filing fees included)", cents: 375000 }]);
  });

  it("deliverables stay separate from government requirements: one item when both, flagged each way; nothing removed for not being legally required", async () => {
    const { tabitha, daria, org } = await setup();
    await assignPackage(daria, org.id, { packageKey: "AL_BASIC" });
    await saveStateTemplate(tabitha, "AL", { items: [{ key: "sos_formation", label: "SOS formation filing", category: "STATE", required: true }, { key: "ein", label: "EIN", category: "FEDERAL", required: true }, { key: "ag_charitable", label: "AG registration or exemption review", category: "STATE", required: false }], markVerified: false });
    await applyStateTemplate(daria, org.id, "AL");
    const items = await prisma.nonprofitChecklistItem.findMany({ where: { portfolioId: org.id } });
    const by = (k: string) => items.find((i) => i.templateKey === k)!;
    expect(items.filter((i) => i.templateKey === "ein")).toHaveLength(1);
    expect([by("ein").deliverable, by("ein").requirement, by("ein").label]).toEqual([true, true, "EIN / Tax ID confirmation"]);
    expect([by("bylaws").deliverable, by("bylaws").requirement]).toEqual([true, false]); // our document, not a legal mandate — kept
    expect([by("ag_charitable").deliverable, by("ag_charitable").requirement, by("ag_charitable").section]).toEqual([false, true, "STATE"]);
    expect(by("irs_application").section).toBe("IRS");
  });

  it("package work waits for the signed agreement; the $5,000 portfolio's agreement carries the grant disclaimer; SAM.gov and grant sections appear", async () => {
    const { daria, org, james, sign } = await setup();
    const r = await assignPackage(daria, org.id, { packageKey: "COMPLETE" });
    const ein = await prisma.nonprofitChecklistItem.findFirstOrThrow({ where: { portfolioId: org.id, templateKey: "ein" } });
    await expect(updateChecklistItem(daria, ein.id, { status: "PREPARING" })).rejects.toThrow(/hasn't signed/);
    await updateChecklistItem(daria, ein.id, { status: "INFORMATION_NEEDED" }); // gathering information is fine
    const f = await uploadItemFile(daria, ein.id, { origin: "GOVERNMENT_ISSUED", bytes: await pdf("CP 575"), originalName: "cp575.pdf" });
    await expect(releaseItemFile(daria, f.id)).rejects.toThrow(/hasn't signed/);

    const t = await sign(r.agreementId);
    expect(t.disclaimers).toEqual([GRANT_DISCLAIMER]);
    expect(GRANT_DISCLAIMER.text).toMatch(/does not guarantee grant eligibility, grant approval, grant awards, funding amounts, or funding timelines/);
    await updateChecklistItem(daria, ein.id, { status: "PREPARING" });
    await releaseItemFile(daria, f.id);
    const view = (await portalPortfolio(james, org.id))!;
    expect(view.package).toEqual({ name: "Complete Nonprofit Portfolio", grantDisclaimer: true });
    expect(new Set(view.items.map((i) => i.section))).toEqual(new Set(["FORMATION", "IRS", "SAM", "GRANT"]));
  });

  it("one document, several formats: PDF and Word on the same item, each released; Word accepted only for portfolio items and never with macros", async () => {
    const { tabitha, daria, org, james, sign } = await setup();
    await sign((await assignPackage(daria, org.id, { packageKey: "AL_BASIC" })).agreementId);
    const bylaws = await prisma.nonprofitChecklistItem.findFirstOrThrow({ where: { portfolioId: org.id, templateKey: "bylaws" } });
    await expect(uploadItemFile(daria, bylaws.id, { origin: "FINAL_PREPARED", bytes: docx(true), originalName: "bylaws.docm" })).rejects.toThrow(/no macros/);
    await expect(uploadItemFile(daria, bylaws.id, { origin: "FINAL_PREPARED", bytes: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]), originalName: "bylaws.xls" })).rejects.toThrow(/Word/);
    const a = await uploadItemFile(daria, bylaws.id, { origin: "FINAL_PREPARED", bytes: await pdf("Bylaws"), originalName: "Bylaws.pdf" });
    const b = await uploadItemFile(daria, bylaws.id, { origin: "FINAL_PREPARED", bytes: docx(), originalName: "Bylaws.docx" });
    // Other upload paths still refuse Word files.
    await expect(staffUploadDocument(tabitha, { clientId: org.id, category: "OTHER", visibility: "STAFF_ONLY", bytes: docx(), originalName: "x.docx" })).rejects.toThrow(/PDF, JPG, or PNG/);
    await releaseItemFile(daria, a.id);
    await releaseItemFile(daria, b.id);
    const item = (await portalPortfolio(james, org.id))!.items.find((i) => i.id === bylaws.id)!;
    expect(item.files.map((f) => f.mime).sort()).toEqual(["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"]);
    expect([item.deliverable, item.section]).toEqual([true, "FORMATION"]);
    // Download All includes both formats; Print All prints the PDF and skips the Word file.
    const files = await bundleFiles(james, org.id, null);
    expect(files).toHaveLength(2);
    const printable = await combinePrintable(files.map((x) => ({ name: x.doc.file.originalName, mime: x.doc.file.mimeType, bytes: new Uint8Array() })));
    expect(printable.skipped).toContain("Bylaws.docx");
  });
});
