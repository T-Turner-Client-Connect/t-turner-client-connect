import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { ForbiddenError } from "@/lib/auth/actor";
import { createClient } from "@/lib/services/clients";
import { acceptPortalInvite, invitePortalUser, updatePortalAccess } from "@/lib/services/portal-accounts";
import { accessibleClients, allowedCategories, requireClientAccess } from "@/lib/portal/access";
import { resolveAccount } from "@/lib/portal/account";
import { portalUploadDocument, portalDocuments } from "@/lib/services/documents";
import { openPeriod } from "@/lib/services/bookkeeping";
import { ledgerFlags, ledgerOverview, postJournalEntry, setupLedger } from "@/lib/services/ledger";
import { addCustomer } from "@/lib/services/client-invoicing";
import { startBankLink } from "@/lib/services/banking";
import { completeSignup, saveOnboardingDetails, startSignup, submitOnboarding } from "@/lib/services/client-signup";
import {
  approveBusinessAccess,
  cancelBusinessAccessRequest,
  conversionCandidates,
  declineBusinessAccess,
  removeBusinessAccess,
  requestBusinessAccess,
  setConversionRequester,
} from "@/lib/services/business-access";
import { GET as packetRoute } from "@/app/api/bookkeeping/packet/route";

/**
 * Managed Business access is the foundation for Banking, Coetha, Financial Statements and
 * Client Invoicing. Every test uses fictional people and businesses.
 */

let sent: { to: string; text: string }[] = [];
const PDF = new TextEncoder().encode("%PDF-1.4\n% fictional\n");

beforeEach(async () => {
  await resetDb();
  sent = [];
  vi.stubEnv("MALWARE_SCAN_URL", "https://scanner.test/scan");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("EMAIL_FROM_ADDRESS", "TTurner & Associates <portal@mail.example.com>");
  vi.stubEnv("APP_URL", "https://portal.example.com");
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (String(url).includes("scanner.test")) return new Response(JSON.stringify({ clean: true }), { status: 200 });
    const b = JSON.parse(String(init?.body ?? "{}"));
    sent.push({ to: b.to?.[0], text: b.text });
    return new Response(JSON.stringify({ id: `re_${sent.length}` }), { status: 200 });
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

let portalSession: { id: string } | null = null;
vi.mock("@/lib/portal/session", async (orig) => ({ ...(await orig<object>()), getPortalUser: async () => portalSession }));
vi.mock("@/lib/auth/session", async (orig) => ({ ...(await orig<object>()), getCurrentUser: async () => null }));

async function world() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const daria = await makeUser("STAFF", "Daria");
  const other = await makeUser("ADMIN", "Other Admin");
  // Ten-business owner: one person, several businesses, none managed by the firm.
  const marcus = await createClient(tabitha, { firstName: "Marcus", lastName: "Fictional", clientType: "INDIVIDUAL", status: "ACTIVE", email: "marcus@fictional.example" });
  const llc = await createClient(tabitha, { businessName: "Fictional Bakery LLC", clientType: "BUSINESS", status: "ACTIVE" });
  const corp = await createClient(tabitha, { businessName: "Fictional Hauling Corp", clientType: "BUSINESS", status: "ACTIVE" });
  const nonprofit = await createClient(tabitha, { businessName: "Fictional Youth League", clientType: "NONPROFIT", status: "ACTIVE" });
  const stranger = await createClient(tabitha, { businessName: "Unrelated Fictional Co", clientType: "BUSINESS", status: "ACTIVE" });
  const { token } = await invitePortalUser(tabitha, marcus.id, { email: "marcus@fictional.example", name: "Marcus Fictional", role: "OWNER" });
  const u = await acceptPortalInvite(token!, "Marcus-Strong-Pass-1");
  const login = { id: u.id, name: u.name, email: u.email };
  for (const b of [llc, corp, nonprofit]) await invitePortalUser(tabitha, b.id, { email: login.email, name: login.name, role: "OWNER" });
  return { tabitha, daria, other, marcus, llc, corp, nonprofit, stranger, login };
}
const req = (actor: Awaited<ReturnType<typeof world>>["tabitha"], clientId: string) => requestBusinessAccess(actor, clientId, { services: ["Bookkeeping"], reason: "Monthly bookkeeping and payroll since January." });

describe("everyone starts as a Regular Tax Client", () => {
  it("business, LLC, corporation and nonprofit records are created with business access OFF", async () => {
    const { marcus, llc, corp, nonprofit } = await world();
    for (const c of [marcus, llc, corp, nonprofit]) expect((await prisma.client.findUniqueOrThrow({ where: { id: c.id } })).businessAccess).toBe("OFF");
  });

  it("choosing Business (and even Bookkeeping) at sign-up grants nothing", async () => {
    await prisma.authSettings.create({ data: { id: "default", emailDeliveryVerifiedAt: new Date() } });
    const { token } = await startSignup({ name: "Bea Business", email: "bea@fictional.example", password: "Bea-Strong-Pass-123", confirm: "Bea-Strong-Pass-123", ip: "203.0.113.7" });
    const code = sent.at(-1)!.text.match(/is (\d{6})/)![1];
    const user = await completeSignup(token, code);
    const actor = { id: user.id, name: user.name, email: user.email };
    await saveOnboardingDetails(actor, { clientType: "BUSINESS", firstName: "Bea", lastName: "Business", businessName: "Bea's Fictional Boutique LLC", phone: "(205) 555-0177", addressLine1: "1 Fictional Way", city: "Birmingham", state: "AL", postalCode: "35203", services: ["Bookkeeping"], notes: "", smsService: false, smsMarketing: false, emailMarketing: false });
    await submitOnboarding(actor);
    const grant = await prisma.portalAccess.findFirstOrThrow({ where: { portalUserId: user.id }, include: { client: true } });
    expect(grant.client.clientType).toBe("BUSINESS");
    expect(grant.client.businessAccess).toBe("OFF");
    expect(grant.canViewBookkeeping).toBe(false);
    expect((await accessibleClients(user.id))[0].canViewBookkeeping).toBe(false);
  });

  it("new portal invitations never include the business view, even if asked", async () => {
    const { tabitha, llc } = await world();
    await expect(invitePortalUser(tabitha, llc.id, { email: "x@fictional.example", name: "X", role: "OWNER", permissions: { canViewBookkeeping: true } })).rejects.toThrow(/turned on separately/);
  });
});

describe("the server blocks the Business side for Regular Tax Clients", () => {
  it("a legacy per-login flag alone opens nothing: pages, documents, uploads, API routes and direct URLs", async () => {
    const { tabitha, llc, login } = await world();
    // Simulate an old grant created before this change (flag ON) on a business that is not managed.
    await prisma.portalAccess.updateMany({ where: { clientId: llc.id }, data: { canViewBookkeeping: true } });
    const period = await openPeriod(tabitha, llc.id, 2026, 9);
    // A delivered, scanned-clean bookkeeping file the business view would show.
    const file = await prisma.storedFile.create({ data: { kind: "CLIENT_DOCUMENT", storageKey: "test/pl.pdf", originalName: "pl.pdf", title: "Fictional P&L", mimeType: "application/pdf", sizeBytes: 10 } });
    await prisma.document.create({ data: { clientId: llc.id, category: "BOOKKEEPING", title: "Fictional P&L", visibility: "PUBLISHED", publishedAt: new Date(), scanStatus: "CLEAN", reportType: "PROFIT_AND_LOSS", reviewStatus: "APPROVED", fileId: file.id, periodId: period.id } });

    // Gate used by every page and action.
    const g = await requireClientAccess(login.id, llc.id);
    expect(g.canViewBookkeeping).toBe(false);
    await expect(requireClientAccess(login.id, llc.id, "bookkeeping")).rejects.toBeInstanceOf(ForbiddenError);
    expect(allowedCategories(g)).not.toContain("BOOKKEEPING");
    // The account switcher and /client/bookkeeping (resolveAccount) see the same.
    const { current } = await resolveAccount(login.id, llc.id);
    expect(current!.canViewBookkeeping).toBe(false);
    // The document vault never lists bookkeeping files.
    const docs = await portalDocuments(login, llc.id);
    expect(JSON.stringify(docs)).not.toMatch(/Fictional P&L/);
    // Uploading into a bookkeeping month is refused.
    await expect(portalUploadDocument(login, { clientId: llc.id, periodId: period.id, bytes: PDF, originalName: "bank.pdf" })).rejects.toBeInstanceOf(ForbiddenError);
    // Direct API request for the month's financial packet is refused.
    portalSession = { id: login.id };
    const res = await packetRoute(new Request(`https://portal.example.com/api/bookkeeping/packet?period=${period.id}&type=MONTH`));
    expect(res.status).toBe(403);
    portalSession = null;
    // Control: once Tabitha approves this business, the same login sees the same file.
    await approveBusinessAccess(tabitha, (await req(tabitha, llc.id)).id);
    expect(JSON.stringify(await portalDocuments(login, llc.id))).toMatch(/Fictional P&L/);
  });

  it("staff can't build business books, bank feeds or business invoices for a Regular Tax Client", async () => {
    const { tabitha, llc } = await world();
    await expect(setupLedger(tabitha, llc.id, { basis: "CASH" })).rejects.toThrow(/Regular Tax Client/);
    await expect(startBankLink(tabitha, llc.id)).rejects.toThrow(/Regular Tax Client/);
    await expect(addCustomer(tabitha, llc.id, { name: "Fictional Customer" })).rejects.toThrow(/Regular Tax Client/);
    // Opening the Books page for a Regular Tax Client must not fail (it shows a notice instead).
    expect((await ledgerOverview(tabitha, llc.id)).book).toBeNull();
  });
});

describe("conversion: requested by owner or authorized staff, approved only by the owner", () => {
  it("unauthorized staff (even an Admin) can't request, and nobody but the owner can approve, decline or remove", async () => {
    const { tabitha, daria, other, llc } = await world();
    await expect(req(daria, llc.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(req(other, llc.id)).rejects.toBeInstanceOf(ForbiddenError);
    await setConversionRequester(tabitha, daria.id, true);
    await expect(setConversionRequester(daria, other.id, true)).rejects.toBeInstanceOf(ForbiddenError);
    const r = await req(daria, llc.id);
    await expect(req(daria, llc.id)).rejects.toThrow(/already waiting/);
    await expect(approveBusinessAccess(daria, r.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(approveBusinessAccess(other, r.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(declineBusinessAccess(other, r.id, "no")).rejects.toBeInstanceOf(ForbiddenError);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: llc.id } })).businessAccess).toBe("OFF");
    await approveBusinessAccess(tabitha, r.id, "Bookkeeping engagement signed");
    await expect(approveBusinessAccess(tabitha, r.id)).rejects.toThrow(/already decided/);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: llc.id } })).businessAccess).toBe("ACTIVE");
    await expect(removeBusinessAccess(daria, llc.id, "x")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("decline and withdraw leave the client a Regular Tax Client", async () => {
    const { tabitha, daria, llc, corp } = await world();
    await setConversionRequester(tabitha, daria.id, true);
    const a = await req(daria, llc.id);
    await declineBusinessAccess(tabitha, a.id, "Tax preparation only");
    const b = await req(daria, corp.id);
    await expect(cancelBusinessAccessRequest(await makeUser("STAFF", "Someone"), b.id)).rejects.toBeInstanceOf(ForbiddenError);
    await cancelBusinessAccessRequest(daria, b.id);
    for (const c of [llc, corp]) expect((await prisma.client.findUniqueOrThrow({ where: { id: c.id } })).businessAccess).toBe("OFF");
  });

  it("approval converts the same record — same login, documents and history, no duplicate profile", async () => {
    const { tabitha, llc, login } = await world();
    const before = await prisma.client.count();
    await approveBusinessAccess(tabitha, (await req(tabitha, llc.id)).id);
    expect(await prisma.client.count()).toBe(before);
    expect(await prisma.portalAccess.count({ where: { portalUserId: login.id, clientId: llc.id, revokedAt: null } })).toBe(1);
  });
});

describe("only the businesses assigned to a login, each kept separate", () => {
  it("a Managed Business shows only after the owner turns on that login's view; other businesses stay Regular", async () => {
    const { tabitha, daria, llc, corp, nonprofit, login } = await world();
    await approveBusinessAccess(tabitha, (await req(tabitha, llc.id)).id);
    const grant = await prisma.portalAccess.findFirstOrThrow({ where: { portalUserId: login.id, clientId: llc.id } });
    expect((await requireClientAccess(login.id, llc.id)).canViewBookkeeping).toBe(false); // business approved, login not yet
    await expect(updatePortalAccess(daria, grant.id, { canViewBookkeeping: true })).rejects.toBeInstanceOf(ForbiddenError);
    await updatePortalAccess(tabitha, grant.id, { canViewBookkeeping: true });
    expect((await requireClientAccess(login.id, llc.id, "bookkeeping")).canViewBookkeeping).toBe(true);
    // The same person's other businesses are untouched.
    const corpGrant = await prisma.portalAccess.findFirstOrThrow({ where: { portalUserId: login.id, clientId: corp.id } });
    await expect(updatePortalAccess(tabitha, corpGrant.id, { canViewBookkeeping: true })).rejects.toThrow(/Regular Tax Client/);
    for (const c of [corp, nonprofit]) await expect(requireClientAccess(login.id, c.id, "bookkeeping")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("a login can never reach a business it wasn't assigned, managed or not", async () => {
    const { tabitha, stranger, login } = await world();
    await approveBusinessAccess(tabitha, (await req(tabitha, stranger.id)).id);
    await expect(requireClientAccess(login.id, stranger.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await accessibleClients(login.id)).map((a) => a.clientId)).not.toContain(stranger.id);
  });

  it("each managed business keeps its own ledger", async () => {
    const { tabitha, llc, corp } = await world();
    for (const c of [llc, corp]) await approveBusinessAccess(tabitha, (await req(tabitha, c.id)).id);
    await setupLedger(tabitha, llc.id, { basis: "CASH" });
    await setupLedger(tabitha, corp.id, { basis: "CASH" });
    const llcCash = await prisma.ledgerAccount.findFirstOrThrow({ where: { clientId: llc.id, code: "1000" } });
    const corpIncome = await prisma.ledgerAccount.findFirstOrThrow({ where: { clientId: corp.id, type: "INCOME" } });
    const llcIncome = await prisma.ledgerAccount.findFirstOrThrow({ where: { clientId: llc.id, type: "INCOME" } });
    await prisma.ledgerBook.update({ where: { clientId: llc.id }, data: { openingDate: new Date("2026-01-01") } });
    // Mixing another business's account into a journal entry is refused.
    await expect(postJournalEntry(tabitha, llc.id, { date: "2026-02-01", memo: "x", lines: [{ accountId: llcCash.id, debit: "10" }, { accountId: corpIncome.id, credit: "10" }] })).rejects.toThrow();
    await postJournalEntry(tabitha, llc.id, { date: "2026-02-01", memo: "Fictional sale", lines: [{ accountId: llcCash.id, debit: "10" }, { accountId: llcIncome.id, credit: "10" }] });
    expect(await prisma.journalEntry.count({ where: { clientId: corp.id } })).toBe(0);
  });
});

describe("removal blocks at once and deletes nothing", () => {
  it("removing access closes the Business side immediately, keeps the ledger and history, and logs every change", async () => {
    const { tabitha, llc, login } = await world();
    const r = await req(tabitha, llc.id);
    await approveBusinessAccess(tabitha, r.id);
    const grant = await prisma.portalAccess.findFirstOrThrow({ where: { portalUserId: login.id, clientId: llc.id } });
    await updatePortalAccess(tabitha, grant.id, { canViewBookkeeping: true });
    await setupLedger(tabitha, llc.id, { basis: "CASH" });
    const ledgerRows = await prisma.ledgerAccount.count({ where: { clientId: llc.id } });
    expect((await requireClientAccess(login.id, llc.id, "bookkeeping")).canViewBookkeeping).toBe(true);

    await removeBusinessAccess(tabitha, llc.id, "Engagement ended");
    await expect(requireClientAccess(login.id, llc.id, "bookkeeping")).rejects.toBeInstanceOf(ForbiddenError);
    expect((await requireClientAccess(login.id, llc.id)).canViewTax).toBe(true); // regular tax access stays
    expect(await prisma.ledgerAccount.count({ where: { clientId: llc.id } })).toBe(ledgerRows);
    expect(await prisma.ledgerBook.count({ where: { clientId: llc.id } })).toBe(1);
    await expect(addCustomer(tabitha, llc.id, { name: "After removal" })).rejects.toThrow(/Regular Tax Client/);
    // Staff can still OPEN the books and review flags — history stays readable after removal.
    expect((await ledgerOverview(tabitha, llc.id)).book).not.toBeNull();
    await expect(ledgerFlags(tabitha, llc.id)).resolves.toBeDefined();

    const actions = (await prisma.businessAccessEvent.findMany({ where: { clientId: llc.id }, orderBy: { createdAt: "asc" } })).map((e) => e.action);
    expect(actions).toEqual(["REQUESTED", "APPROVED", "LOGIN_VIEW_ON", "REMOVED"]);
    expect(await prisma.auditLog.count({ where: { action: { startsWith: "business_access." }, clientId: llc.id } })).toBe(4);
  });
});

describe("existing clients are never upgraded automatically", () => {
  it("bookkeeping history only puts a client on the review list — it stays a Regular Tax Client", async () => {
    const { tabitha, daria, llc, corp } = await world();
    await openPeriod(tabitha, llc.id, 2026, 8);
    await prisma.ledgerBook.create({ data: { clientId: corp.id, basis: "CASH", createdById: tabitha.id } }); // legacy books
    const list = await conversionCandidates(tabitha);
    expect(list.map((c) => c.id).sort()).toEqual([llc.id, corp.id].sort());
    for (const c of [llc, corp]) expect((await prisma.client.findUniqueOrThrow({ where: { id: c.id } })).businessAccess).toBe("OFF");
    await expect(conversionCandidates(daria)).rejects.toBeInstanceOf(ForbiddenError);
  });
});
