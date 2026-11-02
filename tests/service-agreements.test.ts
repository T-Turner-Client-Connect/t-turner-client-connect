import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { ForbiddenError } from "@/lib/auth/actor";
import { createClient } from "@/lib/services/clients";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { readDocumentBytes, authorizeDownload, downloadToken } from "@/lib/services/documents";
import { CARD_SURCHARGE_CAP_BPS, quoteAll, quoteMethod, type FeeSetting } from "@/lib/billing/payment-fees";
import type { AgreementTerms } from "@/lib/billing/agreement-terms";
import {
  clientServices, createService, ownerOverride, portalAgreements, prepareAgreement, recordPaymentAuthorization, requestMethodChange, saveFeeSetting,
  sendAgreement, setServiceStatus, signAgreement, signingHash, viewAgreement,
} from "@/lib/services/service-agreements";

beforeEach(async () => {
  await resetDb();
  vi.stubEnv("MALWARE_SCAN_URL", "https://scanner.test/scan");
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ clean: true }), { status: 200 }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const on = (method: string, percentBps: number, flatCents = 0, extra: Partial<FeeSetting> = {}): FeeSetting => ({ method, enabled: true, percentBps, flatCents, verifiedAt: new Date(), ...extra });
const fee = (m: Parameters<typeof quoteMethod>[0], base: number, s: FeeSetting[], kind: "SERVICE" | "TAX_PAYMENT_SELECTION" = "TAX_PAYMENT_SELECTION", rt?: { eligible: boolean; feeCents: number }) => quoteMethod(m, base, s, { kind, refundTransfer: rt ?? null });

describe("payment-method fees", () => {
  it("cash and Zelle never carry a fee; debit cards are never surcharged; nothing applies until turned on and verified", () => {
    const all = [on("CARD_CREDIT", 350), on("CHECK", 0, 200), on("VENMO", 190), on("CASH_APP", 275)];
    for (const m of ["CASH", "ZELLE", "CARD_DEBIT", "APPLE_PAY_DEBIT"] as const) expect(fee(m, 40_000, all).feeCents).toBe(0);
    // Configured but not verified (or off): no fee.
    const unverified = [{ ...on("CARD_CREDIT", 300), verifiedAt: null }, { ...on("VENMO", 190), enabled: false }];
    expect([fee("CARD_CREDIT", 40_000, unverified).feeCents, fee("VENMO", 40_000, unverified).feeCents]).toEqual([0, 0]);
  });

  it("a 3.5% card target is reduced to the 3% cap; Apple Pay with a credit card matches; other methods use their own settings", () => {
    const s = [on("CARD_CREDIT", 350), on("CHECK", 0, 200), on("VENMO", 190), on("CASH_APP", 275)];
    expect(CARD_SURCHARGE_CAP_BPS).toBe(300);
    const card = fee("CARD_CREDIT", 40_000, s);
    expect([card.feeCents, card.totalCents]).toEqual([1_200, 41_200]);
    expect(card.note).toMatch(/reduced to the 3% card-network maximum/);
    expect(fee("APPLE_PAY_CREDIT", 40_000, s).feeCents).toBe(1_200);
    expect(fee("CARD_CREDIT", 40_000, [on("CARD_CREDIT", 250)]).feeCents).toBe(1_000);
    expect([fee("CHECK", 40_000, s).feeCents, fee("VENMO", 40_000, s).feeCents, fee("CASH_APP", 40_000, s).feeCents]).toEqual([200, 760, 1_100]);
  });

  it("refund transfer: tax only, needs a configured provider and an eligible return; includes the provider's fee", () => {
    const rt = on("REFUND_TRANSFER", 0, 0, { providerName: "Fictional Bank Products" });
    expect(fee("REFUND_TRANSFER", 40_000, [rt], "TAX_PAYMENT_SELECTION", { eligible: true, feeCents: 3_995 })).toMatchObject({ available: true, feeCents: 3_995, totalCents: 43_995 });
    expect(fee("REFUND_TRANSFER", 40_000, [rt], "TAX_PAYMENT_SELECTION", { eligible: false, feeCents: 3_995 }).available).toBe(false);
    expect(fee("REFUND_TRANSFER", 40_000, [], "TAX_PAYMENT_SELECTION", { eligible: true, feeCents: 3_995 }).available).toBe(false);
    expect(quoteAll(40_000, [rt], { kind: "SERVICE" }).map((q) => q.method)).not.toContain("REFUND_TRANSFER");
  });
});

async function setup() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const daria = await makeUser("STAFF", "Daria");
  const jane = await createClient(tabitha, { firstName: "Jane", lastName: "Williams", clientType: "INDIVIDUAL", status: "ACTIVE", email: "jane@fictional.example" });
  const other = await createClient(tabitha, { firstName: "Omar", lastName: "Other", clientType: "INDIVIDUAL", status: "ACTIVE", email: "omar@fictional.example" });
  const portal = async (clientId: string, email: string) => {
    const { token } = await invitePortalUser(tabitha, clientId, { email, name: email.split("@")[0], role: "OWNER" });
    const u = await acceptPortalInvite(token!, "Portal-Pass-123456");
    return { id: u.id, name: u.name, email: u.email };
  };
  return { tabitha, daria, jane, other, janeLogin: await portal(jane.id, "jane@fictional.example"), omarLogin: await portal(other.id, "omar@fictional.example") };
}

describe("services and pricing agreements", () => {
  it("only the owner sets fees, and only with a verification note", async () => {
    const { tabitha, daria } = await setup();
    await expect(saveFeeSetting(daria, { method: "CARD_CREDIT", enabled: true, percentBps: 300, flatCents: 0, verifiedNote: "Checked processor terms" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(saveFeeSetting(tabitha, { method: "CARD_CREDIT", enabled: true, percentBps: 350, flatCents: 0 })).rejects.toThrow(/verified/);
    await expect(saveFeeSetting(tabitha, { method: "ZELLE", enabled: true, percentBps: 100, flatCents: 0, verifiedNote: "n/a — business policy" })).rejects.toThrow(/can carry a fee/);
    await saveFeeSetting(tabitha, { method: "CARD_CREDIT", enabled: true, percentBps: 350, flatCents: 0, verifiedNote: "Processor and card-network rules checked 11/2; credit only" });
    expect((await prisma.paymentFeeSetting.findUniqueOrThrow({ where: { method: "CARD_CREDIT" } })).verifiedById).toBe(tabitha.id);
  });

  it("one client, several tax years and services, each with its own agreement; work can't begin until signed; owner override is documented", async () => {
    const { tabitha, daria, jane } = await setup();
    const t26 = await createService(daria, { clientId: jane.id, type: "TAX_INDIVIDUAL", taxYear: 2026, assignedToId: daria.id });
    const amended = await createService(daria, { clientId: jane.id, type: "TAX_AMENDED", taxYear: 2025 });
    const books = await createService(daria, { clientId: jane.id, type: "BOOKKEEPING", periodLabel: "January–December 2026" });
    await expect(createService(daria, { clientId: jane.id, type: "TAX_INDIVIDUAL" })).rejects.toThrow(/tax year/);
    expect((await clientServices(jane.id)).map((s) => [s.title, s.taxYear])).toEqual(expect.arrayContaining([["2026 Individual tax return", 2026], ["2025 Amended tax return", 2025], ["January–December 2026 Bookkeeping", null]]));

    const a = await prepareAgreement(daria, t26.id, { lines: [{ label: "2026 individual return", cents: 40_000 }] });
    const b = await prepareAgreement(daria, books.id, { lines: [{ label: "Monthly bookkeeping", cents: 25_000 }] });
    expect([a.kind, b.kind]).toEqual(["TAX_PAYMENT_SELECTION", "SERVICE"]);
    expect(a.serviceId).not.toBe(b.serviceId);

    // Not signed: In Progress refused for staff and owner alike.
    for (const who of [daria, tabitha]) await expect(setServiceStatus(who, t26.id, "IN_PROGRESS")).rejects.toThrow(/hasn't signed/);
    // Owner override: staff can't; the owner must give a reason; it's logged.
    await expect(ownerOverride(daria, amended.id, "Client is traveling")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(ownerOverride(tabitha, amended.id, "ok")).rejects.toThrow(/Document why/);
    await ownerOverride(tabitha, amended.id, "IRS deadline tomorrow; client approved by phone 11/2, agreement to follow");
    await setServiceStatus(daria, amended.id, "IN_PROGRESS");
    expect(await prisma.auditLog.count({ where: { action: "service.owner_override", entityId: amended.id } })).toBe(1);
  });

  it("send → viewed → sign: unticked box, wrong total and other clients refused; signed PDF stored in the tax-year folder; then approved to begin", async () => {
    const { tabitha, daria, jane, janeLogin, omarLogin } = await setup();
    await saveFeeSetting(tabitha, { method: "CARD_CREDIT", enabled: true, percentBps: 350, flatCents: 0, verifiedNote: "Processor and card-network rules checked; credit only" });
    const s = await createService(daria, { clientId: jane.id, type: "TAX_INDIVIDUAL", taxYear: 2026 });
    const draft = await prepareAgreement(daria, s.id, { lines: [{ label: "Federal and state return", cents: 40_000 }, { label: "Schedule C", cents: 10_000 }] });
    // Drafts are invisible to the client.
    expect(await portalAgreements(janeLogin, jane.id)).toEqual([]);
    await expect(viewAgreement(janeLogin, draft.id)).rejects.toBeInstanceOf(ForbiddenError);
    await sendAgreement(daria, draft.id);
    // Another client can't open or sign it.
    await expect(viewAgreement(omarLogin, draft.id)).rejects.toBeInstanceOf(ForbiddenError);
    const viewed = await viewAgreement(janeLogin, draft.id);
    expect(viewed.status).toBe("VIEWED");
    expect((await prisma.clientService.findUniqueOrThrow({ where: { id: s.id } })).status).toBe("AGREEMENT_VIEWED");

    const terms = viewed.terms as unknown as AgreementTerms;
    expect(terms.baseCents).toBe(50_000);
    expect(terms.options.find((o) => o.method === "CARD_CREDIT")!.totalCents).toBe(51_500); // 3% cap
    expect(terms.options.find((o) => o.method === "CASH")!.totalCents).toBe(50_000);
    const base = { agreementId: draft.id, method: "CARD_CREDIT", signerName: "Jane Williams", ip: "203.0.113.5" };
    await expect(signAgreement(janeLogin, { ...base, agreed: false, shownHash: signingHash(terms, "CARD_CREDIT") })).rejects.toThrow(/Check the box/);
    await expect(signAgreement(janeLogin, { ...base, agreed: true, shownHash: signingHash(terms, "CASH") })).rejects.toThrow(/total changed/);
    await expect(signAgreement(janeLogin, { ...base, signerName: "J", agreed: true, shownHash: signingHash(terms, "CARD_CREDIT") })).rejects.toThrow(/full name/);
    await expect(signAgreement(omarLogin, { ...base, agreed: true, shownHash: signingHash(terms, "CARD_CREDIT") })).rejects.toBeInstanceOf(ForbiddenError);
    const r = await signAgreement(janeLogin, { ...base, agreed: true, shownHash: signingHash(terms, "CARD_CREDIT") });
    expect(r.selection).toMatchObject({ method: "CARD_CREDIT", feeCents: 1_500, totalCents: 51_500 });
    await expect(signAgreement(janeLogin, { ...base, agreed: true, shownHash: signingHash(terms, "CARD_CREDIT") })).rejects.toThrow(/already signed/);

    const signed = await prisma.pricingAgreement.findUniqueOrThrow({ where: { id: draft.id } });
    expect([signed.status, signed.signerName, signed.signedByPortalId, signed.signerIp]).toEqual(["SIGNED", "Jane Williams", janeLogin.id, "203.0.113.5"]);
    const doc = await prisma.document.findUniqueOrThrow({ where: { id: signed.pdfDocumentId! }, include: { file: true } });
    expect([doc.clientId, doc.category, doc.year, doc.docType, doc.visibility]).toEqual([jane.id, "CONTRACTS", 2026, "PRICING_AGREEMENT", "PUBLISHED"]);
    const bytes = await readDocumentBytes(doc.file);
    expect(new TextDecoder().decode(bytes!.slice(0, 5))).toBe("%PDF-");
    // The client can open their own signed copy; the other client can't.
    expect(await authorizeDownload(downloadToken(doc.id, { portalUserId: janeLogin.id }), { portalUserId: janeLogin.id })).not.toBeNull();
    expect(await authorizeDownload(downloadToken(doc.id, { portalUserId: omarLogin.id }), { portalUserId: omarLogin.id })).toBeNull();

    expect((await prisma.clientService.findUniqueOrThrow({ where: { id: s.id } })).status).toBe("APPROVED_TO_BEGIN");
    await setServiceStatus(daria, s.id, "IN_PROGRESS");
  });

  it("required payment authorization holds the start; changing the payment method after signing is a new version signed again; prices never change silently", async () => {
    const { tabitha, daria, jane, janeLogin } = await setup();
    await saveFeeSetting(tabitha, { method: "VENMO", enabled: true, percentBps: 190, flatCents: 0, verifiedNote: "Venmo business fee passed through; permitted" });
    const s = await createService(daria, { clientId: jane.id, type: "BUSINESS_FORMATION", periodLabel: "November 2026", requiresPaymentAuth: true });
    const v1 = await prepareAgreement(daria, s.id, { lines: [{ label: "LLC formation", cents: 60_000 }] });
    await sendAgreement(daria, v1.id);
    const t1 = (await viewAgreement(janeLogin, v1.id)).terms as unknown as AgreementTerms;
    await signAgreement(janeLogin, { agreementId: v1.id, method: "ZELLE", signerName: "Jane Williams", agreed: true, shownHash: signingHash(t1, "ZELLE") });
    expect((await prisma.clientService.findUniqueOrThrow({ where: { id: s.id } })).status).toBe("AWAITING_PAYMENT_AUTHORIZATION");
    await expect(setServiceStatus(daria, s.id, "IN_PROGRESS")).rejects.toThrow(/payment authorization/);

    // Switch to Venmo: version 2 with the recalculated total; v1 stays signed until v2 is.
    const v2 = await requestMethodChange(janeLogin, v1.id);
    expect([v2.version, v2.status]).toEqual([2, "SENT"]);
    const t2 = v2.terms as unknown as AgreementTerms;
    expect(t2.options.find((o) => o.method === "VENMO")!.totalCents).toBe(61_140);
    expect((await prisma.pricingAgreement.findUniqueOrThrow({ where: { id: v1.id } })).status).toBe("SIGNED");
    await signAgreement(janeLogin, { agreementId: v2.id, method: "VENMO", signerName: "Jane Williams", agreed: true, shownHash: signingHash(t2, "VENMO") });
    const [old, cur] = await Promise.all([prisma.pricingAgreement.findUniqueOrThrow({ where: { id: v1.id } }), prisma.pricingAgreement.findUniqueOrThrow({ where: { id: v2.id } })]);
    expect([old.status, old.selectedMethod, cur.status, cur.selectedMethod]).toEqual(["SUPERSEDED", "ZELLE", "SIGNED", "VENMO"]);
    expect((old.selection as { totalCents: number }).totalCents).toBe(60_000); // original kept as signed

    await recordPaymentAuthorization(daria, s.id, "Deposit received by Venmo 11/2");
    await setServiceStatus(daria, s.id, "IN_PROGRESS");

    // A price change is a new draft version; the signed one is untouched.
    const v3 = await prepareAgreement(daria, s.id, { lines: [{ label: "LLC formation", cents: 65_000 }] });
    expect([v3.version, v3.status]).toEqual([3, "DRAFT"]);
    expect(((await prisma.pricingAgreement.findUniqueOrThrow({ where: { id: v2.id } })).terms as unknown as AgreementTerms).baseCents).toBe(60_000);
  });
});
