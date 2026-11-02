import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import { makeUser, prisma, resetDb } from "./db";
import { ForbiddenError } from "@/lib/auth/actor";
import { createClient } from "@/lib/services/clients";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { createAndLinkBusiness, grantOwnerPortalAccess } from "@/lib/services/related-businesses";
import { authorizeDownload, downloadToken, setVisibility } from "@/lib/services/documents";
import { saveNonprofitProfile } from "@/lib/services/nonprofits";
import { setFilingService } from "@/lib/services/nonprofit-links";
import {
  addChecklistItem, annualDeadline, applyStateTemplate, bundleFiles, ensurePortfolio, irsStatus, portalPortfolio, recordIrsEvent, releaseItemFile, resendReleaseNotice,
  saveClassification, savePortfolio, saveStateTemplate, stateTemplate, updateChecklistItem, uploadItemFile,
} from "@/lib/services/nonprofit-portfolio";
import { combinePrintable, zipFiles } from "@/lib/file-bundle";

const sent: { to: string[]; subject: string; text: string; attachments?: unknown }[] = [];
beforeEach(async () => {
  await resetDb();
  sent.length = 0;
  vi.stubEnv("MALWARE_SCAN_URL", "https://scanner.test/scan");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("EMAIL_FROM_ADDRESS", "TTurner <info@fictional.example>");
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/emails")) {
      sent.push(JSON.parse(String(init!.body)));
      return new Response(JSON.stringify({ id: `em_${sent.length}` }), { status: 200 });
    }
    return new Response(JSON.stringify({ clean: true }), { status: 200 });
  });
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

async function setup() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  const daria = await makeUser("STAFF", "Daria");
  // James's business stays a business; his nonprofit is its own record in his group.
  const rb = await createClient(tabitha, { businessName: "RB Industrial LLC", firstName: "James", lastName: "Bradley", clientType: "BUSINESS", status: "ACTIVE", email: "james@rb-fictional.example" });
  const org = await createAndLinkBusiness(tabitha, rb.id, { businessName: "Bradley Community Foundation", clientType: "NONPROFIT" });
  const { token } = await invitePortalUser(tabitha, rb.id, { email: "james@rb-fictional.example", name: "James Bradley", role: "OWNER" });
  const j = await acceptPortalInvite(token!, "James-Portal-Pass-12");
  const james = { id: j.id, name: j.name, email: j.email };
  await grantOwnerPortalAccess(tabitha, rb.id, org.id, james.id);
  const other = await createClient(tabitha, { businessName: "Fictional Other Fund", clientType: "NONPROFIT", status: "ACTIVE", email: "x@other.example" });
  const { token: t2 } = await invitePortalUser(tabitha, other.id, { email: "x@other.example", name: "Other Person", role: "OWNER" });
  const o = await acceptPortalInvite(t2!, "Other-Portal-Pass-12");
  return { tabitha, daria, rb, org, james, outsider: { id: o.id, name: o.name, email: o.email } };
}

describe("Nonprofit Portfolio", () => {
  it("only a nonprofit organization record gets a portfolio; formation facts are validated", async () => {
    const { daria, rb, org } = await setup();
    await expect(ensurePortfolio(daria, rb.id)).rejects.toThrow(/nonprofit organization record/);
    await ensurePortfolio(daria, org.id);
    await expect(savePortfolio(daria, org.id, { formationState: "ZZ" })).rejects.toThrow(/state/);
    await expect(savePortfolio(daria, org.id, { ein: "123" })).rejects.toThrow(/EIN/);
    await expect(savePortfolio(daria, org.id, { uei: "SHORT" })).rejects.toThrow(/Unique Entity ID/);
    await expect(savePortfolio(daria, org.id, { agStatus: "EXEMPT" })).rejects.toThrow(/exemption/);
    await savePortfolio(daria, org.id, { formationState: "AL", ein: "123456789", uei: "ab12cd34ef56", agStatus: "REVIEW_NEEDED", samStatus: "IN_PROGRESS" });
    const p = await prisma.nonprofitPortfolio.findUniqueOrThrow({ where: { clientId: org.id } });
    expect([p.ein, p.uei, p.formationState]).toEqual(["12-3456789", "AB12CD34EF56", "AL"]);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: rb.id } })).clientType).toBe("BUSINESS");
  });

  it("classifications are owner-editable, aren't all Form 1023, and need a source note to be marked verified; IRS steps stay separate", async () => {
    const { tabitha, daria, org } = await setup();
    await saveClassification(tabitha, "501C3", { label: "501(c)(3)", process: "Form 1023 or 1023-EZ", form: "1023 / 1023-EZ", active: true, markVerified: false });
    await saveClassification(tabitha, "501C4", { label: "501(c)(4)", process: "Form 8976 notice; Form 1024-A optional", form: "8976; 1024-A", active: true, markVerified: false });
    await expect(saveClassification(tabitha, "501C6", { label: "501(c)(6)", process: "Form 1024", form: "1024", active: true, markVerified: true })).rejects.toThrow(/IRS page/);
    expect((await prisma.nonprofitClassification.findUniqueOrThrow({ where: { key: "501C4" } })).form).not.toMatch(/1023/);
    await savePortfolio(daria, org.id, { classification: "501C4" });
    await expect(savePortfolio(daria, org.id, { classification: "NOPE" })).rejects.toThrow(/classification/);
    await recordIrsEvent(daria, org.id, { kind: "SUBMITTED", at: new Date("2026-03-01T15:00:00Z") });
    await recordIrsEvent(daria, org.id, { kind: "INFO_REQUESTED", at: new Date("2026-05-01T15:00:00Z"), note: "Letter 1312" });
    await expect(recordIrsEvent(daria, org.id, { kind: "MAYBE", at: new Date() })).rejects.toThrow(/IRS step/);
    const events = await prisma.nonprofitIrsEvent.findMany({ where: { portfolioId: org.id } });
    expect([events.length, irsStatus(events)]).toEqual([2, "INFO_REQUESTED"]);
  });

  it("state templates: baseline (unverified) until saved; applying is idempotent; Attorney General review isn't marked mandatory; staff can add items", async () => {
    const { tabitha, daria, org } = await setup();
    const base = await stateTemplate("GA");
    expect([base.saved, base.verifiedAt]).toEqual([false, null]);
    expect(base.items.find((i) => i.key === "charitable_registration")!.required).toBe(false);
    await expect(stateTemplate("XX")).rejects.toThrow(/state/);
    await expect(saveStateTemplate(tabitha, "AL", { items: [{ key: "sos", label: "SOS filing", category: "STATE", required: true }], markVerified: true })).rejects.toThrow(/official sources/);
    await saveStateTemplate(tabitha, "AL", { items: [{ key: "sos", label: "SOS filing", category: "STATE", required: true }, { key: "ag", label: "AG registration or exemption review", category: "STATE", required: false }], markVerified: true, verifiedNote: "Checked sos.alabama.gov and alabamaag.gov on 11/2" });
    expect((await stateTemplate("AL")).verifiedAt).not.toBeNull();
    expect((await applyStateTemplate(daria, org.id, "AL")).added).toBe(2);
    expect((await applyStateTemplate(daria, org.id, "AL")).added).toBe(0);
    await addChecklistItem(daria, org.id, { label: "City business license review", category: "OTHER" });
    expect(await prisma.nonprofitChecklistItem.count({ where: { portfolioId: org.id } })).toBe(3);
  });

  it("files: drafts never released or published; release publishes, marks delivered and emails a sign-in link once (resend is deliberate); clients see only their own released files", async () => {
    const { daria, org, james, outsider } = await setup();
    await applyStateTemplate(daria, org.id, "AL"); // baseline items
    const ein = await prisma.nonprofitChecklistItem.findFirstOrThrow({ where: { portfolioId: org.id, templateKey: "ein" } });
    await expect(uploadItemFile(daria, ein.id, { origin: "WHATEVER", bytes: await pdf("x"), originalName: "x.pdf" })).rejects.toThrow(/government-issued/);
    const draft = await uploadItemFile(daria, ein.id, { origin: "INTERNAL_DRAFT", bytes: await pdf("draft"), originalName: "draft.pdf" });
    await expect(releaseItemFile(daria, draft.id)).rejects.toThrow(/never released/);
    await expect(setVisibility(daria, draft.documentId, "PUBLISHED")).rejects.toThrow(/Nonprofit Portfolio/);
    expect(sent).toHaveLength(0);
    await expect(updateChecklistItem(daria, ein.id, { status: "DELIVERED" })).rejects.toThrow(/Release a document/);

    const letter = await uploadItemFile(daria, ein.id, { origin: "GOVERNMENT_ISSUED", bytes: await pdf("CP 575"), originalName: "cp575.pdf" });
    // Not released yet: the client sees nothing.
    expect((await portalPortfolio(james, org.id))!.files).toEqual([]);
    const r = await releaseItemFile(daria, letter.id);
    expect(r).toEqual({ sent: 1, failed: 0, skipped: 0 });
    await expect(releaseItemFile(daria, letter.id)).rejects.toThrow(/Already released/);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe("Your Nonprofit Formation Update — EIN confirmation (IRS) Completed");
    expect(sent[0].text).toMatch(/Bradley Community Foundation/);
    expect(sent[0].text).toMatch(/\/client\/nonprofit/);
    expect(sent[0].attachments).toBeUndefined();
    expect((await prisma.nonprofitChecklistItem.findUniqueOrThrow({ where: { id: ein.id } })).status).toBe("DELIVERED");
    await resendReleaseNotice(daria, letter.id);
    expect(sent).toHaveLength(2);
    expect(await prisma.notification.count({ where: { kind: "NONPROFIT_DOCUMENT", status: "SENT" } })).toBe(2);

    const view = (await portalPortfolio(james, org.id))!;
    expect(view.files.map((f) => f.id)).toEqual([letter.id]);
    expect(view.progress.done).toBe(1);
    // The released file opens for James, not for another client; the draft opens for no one in the portal.
    expect(await authorizeDownload(downloadToken(letter.documentId, { portalUserId: james.id }), { portalUserId: james.id })).not.toBeNull();
    expect(await authorizeDownload(downloadToken(draft.documentId, { portalUserId: james.id }), { portalUserId: james.id })).toBeNull();
    await expect(portalPortfolio(outsider, org.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(bundleFiles(outsider, org.id, null)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(bundleFiles(james, org.id, [draft.id])).rejects.toBeInstanceOf(ForbiddenError);
    expect((await bundleFiles(james, org.id, null)).map((f) => f.id)).toEqual([letter.id]);
  });

  it("Download All is a valid ZIP; Print All combines PDFs and images into one PDF and skips anything else", async () => {
    const a = await pdf("A"), b = await pdf("B");
    const zip = zipFiles([{ name: "a.pdf", bytes: a }, { name: "a.pdf", bytes: b }]);
    expect([...zip.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const text = new TextDecoder("latin1").decode(zip);
    expect(text).toContain("a.pdf");
    expect(text).toContain("a (2).pdf");
    const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
    const out = await combinePrintable([{ name: "a.pdf", mime: "application/pdf", bytes: a }, { name: "p.png", mime: "image/png", bytes: png }, { name: "n.txt", mime: "text/plain", bytes: new Uint8Array([1]) }]);
    expect((await PDFDocument.load(out.bytes!)).getPageCount()).toBe(2);
    expect(out.skipped).toEqual(["n.txt"]);
  });

  it("annual deadline: shown to the client, but 'we prepare it' only with an active filing service", async () => {
    const { tabitha, org } = await setup();
    await prisma.client.update({ where: { id: org.id }, data: { fiscalYearEnd: 12 } });
    await saveNonprofitProfile(tabitha, org.id, { formType: "990-EZ", formBasis: "Receipts $120k, assets $60k" });
    const c = () => prisma.client.findUniqueOrThrow({ where: { id: org.id }, select: { fiscalYearEnd: true, nonprofitProfile: true } });
    expect(annualDeadline(await c(), "2026-04-15")).toMatchObject({ taxYear: 2025, due: "2026-05-15", preparedByUs: false });
    await setFilingService(tabitha, org.id, "YES");
    expect(annualDeadline(await c(), "2026-04-15")!.preparedByUs).toBe(true);
  });
});
