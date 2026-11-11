import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { makeUser, managed, prisma, resetDb } from "./db";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import type { PortalActor } from "@/lib/portal/session";
import { createClient } from "@/lib/services/clients";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { inviteBusinessOwner, saveBusinessOwner } from "@/lib/services/business-owners";
import { authorizeDownload, downloadToken, portalDocuments, portalUploadDocument } from "@/lib/services/documents";
import { loadPortalDocuments, loadPortalHome } from "@/lib/portal/views";
import { loadPortalTaxes } from "@/lib/portal/tax-view";
import { portalDocumentScope, requireClientAccess } from "@/lib/portal/access";
import { assertPersonalTaxAccount } from "@/lib/portal/account";
import { serviceProfile } from "@/lib/services/service-profile";
import { questionnaireLink, vaultYears } from "@/lib/services/tax-center";
import { requestRefundTransfer } from "@/lib/services/refund-transfers";
import { myOwnerRequests, openIdentityRequest, requestOwnerDocument } from "@/lib/services/owner-personal-docs";
import { ownerIdentityOverview, portalIdentityOverview, uploadIdentityDocument } from "@/lib/services/identity";
import { staffSendMessage } from "@/lib/services/messaging";
import { businessChecklist } from "@/lib/services/portal-business";
import { businessBucketOf, businessVaultData, BUSINESS_VAULT_CATEGORIES } from "@/components/portal/vault-page";
import { TaxUploadForm } from "@/components/portal/tax-upload-form";

/**
 * Business owners' own personal tax documents (and identity documents on request) on a
 * business-only account. Fictional people and businesses only; the malware scanner is a stub.
 */

let portalSession: { id: string } | null = null;
vi.mock("@/lib/portal/session", async (orig) => ({ ...(await orig<object>()), getPortalUser: async () => portalSession }));
const { POST: uploadRoute } = await import("@/app/api/client/upload/route");

beforeEach(async () => {
  await resetDb();
  portalSession = null;
  vi.stubEnv("MALWARE_SCAN_URL", "https://scanner.test/scan");
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ clean: true }), { status: 200 }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

let seq = 0;
const pdf = () => new TextEncoder().encode(`%PDF-1.4\n% fictional ${seq++}\n`);
const BUSINESS_SERVICES = "Business tax return (1065/1120-S/1120), K-1 preparation for owners";

/** A fictional four-partner LLC, business tax only (no personal tax preparation), with each partner's own login. */
async function partners() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const daria = await makeUser("STAFF", "Daria");
  const stranger = await makeUser("STAFF", "Stranger");
  const biz = await createClient(tabitha, { businessName: "Pretend Four Partners LLC", clientType: "BUSINESS", status: "ACTIVE", services: BUSINESS_SERVICES, assignedToId: daria.id });
  const names = ["Avery Partner", "Blake Partner", "Casey Partner", "Devon Partner"];
  const owners = [];
  for (const [i, name] of names.entries()) {
    const { owner } = await saveBusinessOwner(tabitha, biz.id, null, { name, email: `${name.split(" ")[0].toLowerCase()}@partners.example`, phone: `205555020${i}`, ownership: "25", title: "MEMBER", receivesK1: true });
    const { token } = await inviteBusinessOwner(tabitha, biz.id, owner.id);
    const u = await acceptPortalInvite(token!, "Partner-Pass-12345");
    owners.push({ owner, login: { id: u.id, name: u.name, email: u.email } as PortalActor });
  }
  return { tabitha, daria, stranger, biz, owners };
}

const ids = (docs: { id: string }[]) => docs.map((d) => d.id).sort();
const canOpen = async (docId: string, who: { portalUserId?: string; staffId?: string }) => !!(await authorizeDownload(downloadToken(docId, who), who));

describe("business-only owners send their own personal tax documents", () => {
  it("each of four partners' documents is stored with that owner and tax year, and partitioned per owner and per year everywhere", async () => {
    const { tabitha, daria, stranger, biz, owners } = await partners();
    const [a, b, c, d] = owners;
    const before = await prisma.client.findUniqueOrThrow({ where: { id: biz.id }, select: { services: true } });
    const servicesBefore = await prisma.clientService.count({ where: { clientId: biz.id } });
    expect((await serviceProfile(biz.id)).businessOnly).toBe(true);
    // Partner owner logins have no upload access to the business's files, yet may send their own personal documents.
    expect((await requireClientAccess(a.login.id, biz.id)).canUpload).toBe(false);

    // Through the real Tax Center upload route (one file per request).
    const viaRoute = async (who: PortalActor, year: string, docType: string, title: string) => {
      portalSession = { id: who.id };
      const fd = new FormData();
      fd.set("account", biz.id);
      fd.set("year", year);
      fd.set("docType", docType);
      fd.set("title", title);
      fd.set("file", new File([pdf()], `${title}.pdf`, { type: "application/pdf" }));
      const res = await uploadRoute(new Request("https://portal.example.com/api/client/upload", { method: "POST", body: fd }));
      portalSession = null;
      return res;
    };
    expect((await viaRoute(a.login, "2025", "FORM_1098", "1098 – Mortgage interest")).status).toBe(200);
    expect((await viaRoute(b.login, "2025", "CLIENT_OTHER", "Property taxes")).status).toBe(200);
    expect((await viaRoute(c.login, "2024", "CLIENT_OTHER", "Car tag")).status).toBe(200);
    expect((await viaRoute(d.login, "2025", "W2", "W-2")).status).toBe(200);
    // A business owner's personal document always has a tax year.
    expect((await viaRoute(a.login, "unsure", "W2", "W-2")).status).toBe(400);
    await portalUploadDocument(c.login, { clientId: biz.id, year: 2025, docType: "CLIENT_OTHER", title: "Charitable contributions", bytes: pdf(), originalName: "charity.pdf", personal: true });

    const docs = await prisma.document.findMany({ where: { clientId: biz.id }, orderBy: { createdAt: "asc" } });
    expect(docs.map((x) => [x.title, x.category, x.businessOwnerId, x.year])).toEqual([
      ["1098 – Mortgage interest", "OWNER_PERSONAL", a.owner.id, 2025],
      ["Property taxes", "OWNER_PERSONAL", b.owner.id, 2025],
      ["Car tag", "OWNER_PERSONAL", c.owner.id, 2024],
      ["W-2", "OWNER_PERSONAL", d.owner.id, 2025],
      ["Charitable contributions", "OWNER_PERSONAL", c.owner.id, 2025],
    ]);
    const mine = (o: (typeof owners)[number]) => docs.filter((x) => x.businessOwnerId === o.owner.id);

    for (const o of owners) {
      const access = await requireClientAccess(o.login.id, biz.id);
      // Lists: the portal document list and the vault list show only this owner's own.
      expect(ids(await portalDocuments(o.login, biz.id))).toEqual(ids(mine(o)));
      expect(ids(await loadPortalDocuments(biz.id, access, { viewer: o.login.id }))).toEqual(ids(mine(o)));
      // Per year: the year filter and the vault's year list ("search" by year) only ever show their own.
      expect(ids(await loadPortalDocuments(biz.id, access, { viewer: o.login.id, year: 2024 }))).toEqual(ids(mine(o).filter((x) => x.year === 2024)));
      expect((await vaultYears(biz.id, portalDocumentScope(access, o.login.id))).map((y) => y.year).sort()).toEqual([...new Set(mine(o).map((x) => x.year))].sort());
      // Downloads and previews (the same signed-link check): their own only.
      for (const x of docs) expect(await canOpen(x.id, { portalUserId: o.login.id }), `${o.owner.id} → ${x.title}`).toBe(x.businessOwnerId === o.owner.id);
      // The business-only vault groups them under Personal Tax Documents.
      const v = businessVaultData(await loadPortalDocuments(biz.id, access, { viewer: o.login.id }));
      expect(v["personal-tax"].map((r) => r.id).sort()).toEqual(ids(mine(o)));
      expect(v["business-tax"]).toEqual([]);
    }
    // Tabitha and the assigned staff member see them all; View as Client (no viewer) shows none.
    for (const x of docs) {
      expect(await canOpen(x.id, { staffId: tabitha.id })).toBe(true);
      expect(await canOpen(x.id, { staffId: daria.id })).toBe(true);
    }
    expect(await loadPortalDocuments(biz.id, { canViewBookkeeping: true, canViewTax: true, canViewContracts: true, canViewDocuments: true, canViewPayroll: true } as never, { viewer: null })).toEqual([]);
    // Never attached to a shared message thread.
    await expect(staffSendMessage(daria, { clientId: biz.id, subject: "Your 1098", body: "Attached.", channel: "PORTAL", attachmentIds: [docs[0].id] })).rejects.toThrow(/private to that owner/);
    void stranger;

    // Sending personal documents never added personal tax preparation.
    expect((await prisma.client.findUniqueOrThrow({ where: { id: biz.id }, select: { services: true } })).services).toEqual(before.services);
    expect(await prisma.clientService.count({ where: { clientId: biz.id } })).toBe(servicesBefore);
    expect((await serviceProfile(biz.id)).businessOnly).toBe(true);
  });

  it("staff request a personal document from one partner: only that partner sees, answers and is notified; it's filed to them and the year", async () => {
    const { daria, stranger, biz, owners } = await partners();
    const [a, b] = owners;
    await expect(requestOwnerDocument(stranger, biz.id, { businessOwnerId: a.owner.id, docType: "FORM_1098", taxYear: 2025 })).rejects.toBeInstanceOf(ForbiddenError);
    const req = await requestOwnerDocument(daria, biz.id, { businessOwnerId: a.owner.id, docType: "CLIENT_OTHER", taxYear: 2025, title: "2025 property tax bill — home" });
    expect(req).toMatchObject({ businessOwnerId: a.owner.id, taxYear: 2025, kind: "OWNER_PERSONAL", status: "OPEN" });
    // Notified: partner A only.
    const notes = await prisma.notification.findMany({ where: { idempotencyKey: { contains: req.id } } });
    expect(notes.length).toBeGreaterThan(0);
    expect(new Set(notes.map((n) => n.portalUserId))).toEqual(new Set([a.login.id]));
    // Seen by A only: their requests, the client Home and the Taxes page.
    expect((await myOwnerRequests(a.login, biz.id)).map((r) => r.id)).toEqual([req.id]);
    expect(await myOwnerRequests(b.login, biz.id)).toEqual([]);
    const homeA = await loadPortalHome(biz.id, await requireClientAccess(a.login.id, biz.id), a.login.id);
    const homeB = await loadPortalHome(biz.id, await requireClientAccess(b.login.id, biz.id), b.login.id);
    expect(homeA.requests.map((r) => r.id)).toContain(req.id);
    expect(homeB.requests.map((r) => r.id)).not.toContain(req.id);
    expect((await loadPortalTaxes(biz.id, b.login.id)).requests.map((r) => r.id)).not.toContain(req.id);
    expect((await loadPortalTaxes(biz.id, null)).requests.map((r) => r.id)).not.toContain(req.id); // View as Client
    // B can't answer it; A can.
    await expect(portalUploadDocument(b.login, { clientId: biz.id, requestId: req.id, bytes: pdf(), originalName: "x.pdf" })).rejects.toBeInstanceOf(ForbiddenError);
    const doc = await portalUploadDocument(a.login, { clientId: biz.id, requestId: req.id, bytes: pdf(), originalName: "property-tax.pdf" });
    expect(doc).toMatchObject({ category: "OWNER_PERSONAL", businessOwnerId: a.owner.id, year: 2025, requestId: req.id, docType: "CLIENT_OTHER" });
    expect((await prisma.documentRequest.findUniqueOrThrow({ where: { id: req.id } })).status).toBe("SUBMITTED");
    expect(await canOpen(doc.id, { portalUserId: b.login.id })).toBe(false);
    expect(await canOpen(doc.id, { portalUserId: a.login.id })).toBe(true);
    // Never part of a bookkeeping client's "What we need" list.
    await managed(biz.id);
    expect((await businessChecklist(biz.id, 2026)).map((r) => r.id)).not.toContain(req.id);
  });

  it("identity documents only on request, private to that partner; Admin-only types stay Admin-only", async () => {
    const { tabitha, daria, biz, owners } = await partners();
    const [a, b] = owners;
    const future = `${new Date().getFullYear() + 3}-06-30`;
    // No request: the Identity page stays closed to a business-only account.
    expect(await ownerIdentityOverview(a.login, biz.id)).toBeNull();
    expect(await openIdentityRequest(a.login.id, biz.id)).toBeNull();
    await requestOwnerDocument(daria, biz.id, { businessOwnerId: a.owner.id, docType: "DRIVERS_LICENSE" });
    expect(await openIdentityRequest(a.login.id, biz.id)).not.toBeNull();
    expect(await openIdentityRequest(b.login.id, biz.id)).toBeNull();
    expect(await ownerIdentityOverview(b.login, biz.id)).toBeNull();
    const ov = (await ownerIdentityOverview(a.login, biz.id))!;
    expect(ov.map((e) => [e.person.role, e.person.businessOwnerId])).toEqual([["OWNER", a.owner.id]]);
    const person = ov[0].person;
    // B can't send into A's record; A can't send a type the office didn't ask for.
    await expect(uploadIdentityDocument({ portal: b.login }, { clientId: biz.id, personId: person.id, type: "DRIVERS_LICENSE", expiresOn: future, bytes: pdf(), originalName: "dl.jpg" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(uploadIdentityDocument({ portal: a.login }, { clientId: biz.id, personId: person.id, type: "SOCIAL_SECURITY_CARD", bytes: pdf(), originalName: "ss.pdf" })).rejects.toBeInstanceOf(ForbiddenError);
    const rec = await uploadIdentityDocument({ portal: a.login }, { clientId: biz.id, personId: person.id, type: "DRIVERS_LICENSE", expiresOn: future, bytes: pdf(), originalName: "dl.pdf" });
    const doc = await prisma.document.findUniqueOrThrow({ where: { id: rec.documentId } });
    expect(doc).toMatchObject({ category: "IDENTITY", businessOwnerId: a.owner.id });
    expect((await prisma.documentRequest.findFirstOrThrow({ where: { clientId: biz.id, docType: "DRIVERS_LICENSE" } })).status).toBe("SUBMITTED");
    // Once uploaded, identity files are office-only: Tabitha and the assigned staff member open it;
    // neither partner does (not even A, who sent it).
    expect(await canOpen(doc.id, { portalUserId: a.login.id })).toBe(false);
    expect(await canOpen(doc.id, { portalUserId: b.login.id })).toBe(false);
    expect(await canOpen(doc.id, { staffId: tabitha.id })).toBe(true);
    expect(await canOpen(doc.id, { staffId: daria.id })).toBe(true);
    // B's identity overview (if B has identity access) never lists A's record.
    const bAccess = await requireClientAccess(b.login.id, biz.id);
    if (bAccess.canViewIdentity) expect((await portalIdentityOverview(b.login, biz.id)).some((e) => e.person.businessOwnerId === a.owner.id)).toBe(false);
    // A Social Security card, when requested: A may send it but never open it (Admin-only, as always).
    await requestOwnerDocument(daria, biz.id, { businessOwnerId: a.owner.id, docType: "SOCIAL_SECURITY_CARD" });
    const ss = await uploadIdentityDocument({ portal: a.login }, { clientId: biz.id, personId: person.id, type: "SOCIAL_SECURITY_CARD", bytes: pdf(), originalName: "ss.pdf" });
    expect(await canOpen(ss.documentId, { portalUserId: a.login.id })).toBe(false);
    expect(await canOpen(ss.documentId, { staffId: daria.id })).toBe(false);
    expect(await canOpen(ss.documentId, { staffId: tabitha.id })).toBe(true);
    // Once answered, the page shows A's own record only (their documents are assigned to them); never B.
    expect((await ownerIdentityOverview(a.login, biz.id))!.map((e) => e.person.businessOwnerId)).toEqual([a.owner.id]);
    expect(await ownerIdentityOverview(b.login, biz.id)).toBeNull();
  });

  it("Tax Summary & Approval, refund options and the questionnaire stay closed to business-only accounts", async () => {
    const { biz, owners } = await partners();
    const [a] = owners;
    await expect(assertPersonalTaxAccount(biz.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(questionnaireLink(a.login, biz.id, 2025)).rejects.toBeInstanceOf(ForbiddenError);
    await prisma.portalAccess.updateMany({ where: { clientId: biz.id }, data: { canViewBilling: true } });
    await expect(requestRefundTransfer(a.login, biz.id, { taxYear: 2025, debtCheck: "CHECKED", offsetRisk: "NO", acknowledged: true })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("unchanged elsewhere", () => {
  it("an individual tax client's uploads are ordinary uploads, with the usual list and upload form", async () => {
    const tabitha = await makeUser("ADMIN", "Tabitha");
    const pat = await createClient(tabitha, { firstName: "Pat", lastName: "Pretend", clientType: "INDIVIDUAL", status: "ACTIVE", email: "pat@fictional.example" });
    const { token } = await invitePortalUser(tabitha, pat.id, { email: "pat@fictional.example", name: "Pat Pretend", role: "OWNER" });
    const u = await acceptPortalInvite(token!, "Pat-Strong-Pass-12345");
    const login = { id: u.id, name: u.name, email: u.email } as PortalActor;
    const doc = await portalUploadDocument(login, { clientId: pat.id, year: 2025, docType: "FORM_1098", title: "1098", bytes: pdf(), originalName: "1098.pdf", personal: true });
    expect(doc).toMatchObject({ category: "CLIENT_UPLOADS", businessOwnerId: null, year: 2025 });
    expect((await serviceProfile(pat.id)).businessOnly).toBe(false);
    // The individual upload form keeps its list and its "Not sure" year; the owner form adds property taxes and drops "Not sure".
    const indiv = renderToStaticMarkup(createElement(TaxUploadForm, { account: pat.id, years: [2025, 2024], defaultYear: "2025", vaultHref: "/client/documents" }));
    const owner = renderToStaticMarkup(createElement(TaxUploadForm, { account: pat.id, years: [2025, 2024], defaultYear: "2025", vaultHref: "/client/documents", owner: true }));
    expect(indiv).toContain("Not sure");
    expect(indiv).not.toContain("Property taxes");
    expect(owner).not.toContain("Not sure");
    expect(owner).toContain("Property taxes");
  });

  it("the business vault categories map to the existing categories and document types", () => {
    expect(BUSINESS_VAULT_CATEGORIES.map((c) => c.label)).toEqual(["All Documents", "Business Tax Documents", "Personal Tax Documents", "Payroll Documents", "K-1 Documents", "Other Supporting Documents"]);
    const b = (category: string, docType: string | null = null, filingDocType: string | null = null) => businessBucketOf({ category, docType, filingDocType } as never);
    expect([b("TAXES"), b("BOOKKEEPING"), b("CLIENT_UPLOADS", "AGENCY_LETTER"), b("OWNER_PERSONAL"), b("PAYROLL"), b("CLIENT_UPLOADS", "PAYROLL_REPORT"), b("OWNER_K1"), b("CLIENT_UPLOADS", "FORM_K1"), b("CLIENT_UPLOADS"), b("OTHER"), b("CONTRACTS")]).toEqual([
      "business-tax", "business-tax", "business-tax", "personal-tax", "payroll", "payroll", "k1", "k1", "other", "other", "other",
    ]);
  });
});

export type { Actor };
