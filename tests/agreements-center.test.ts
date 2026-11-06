import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import { makeUser, prisma, resetDb } from "./db";
import { ForbiddenError } from "@/lib/auth/actor";
import { createClient } from "@/lib/services/clients";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { createService, setServiceStatus } from "@/lib/services/service-agreements";
import { assignContract } from "@/lib/services/contracts";
import {
  addInvoiceToAgreement, approveClause, askToSend, bulkCandidates, bulkCreate, createAgreement, createClientForAgreement, declineClientAgreement, library, listAgreements, newSigningLink, ownerQueue,
  portalAgreement, portalAgreementList, prefillOptions, prepareRenewal, renderFor, resolveSigningLink, saveClause, sendAgreement, sendSelected, signClientAgreement, updateAgreement, type SignInput,
} from "@/lib/services/agreements";
import { CLAUSE_SEEDS, defaultOptions, displayStatus, type AgreementOptions } from "@/lib/agreements/catalog";

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
  const daria = await makeUser("STAFF", "Daria");
  // Fictional clients.
  const a = await createClient(tabitha, { firstName: "Avery", lastName: "Fictional", clientType: "INDIVIDUAL", status: "ACTIVE", email: "avery@example.test", phone: "205-555-0101", addressLine1: "1 Test Way", city: "Birmingham", state: "AL", postalCode: "35203" });
  const b = await createClient(tabitha, { firstName: "Blake", lastName: "Sample", clientType: "INDIVIDUAL", status: "ACTIVE", email: "blake@example.test" });
  const portal = async (clientId: string, email: string, name: string) => {
    const { token } = await invitePortalUser(tabitha, clientId, { email, name, role: "OWNER", permissions: { canMessage: true, canUpload: true, canViewBookkeeping: false, canViewTax: true, canViewContracts: true, canViewIdentity: false } });
    const u = await acceptPortalInvite(token!, "Fictional-Portal-Pass-12");
    return { id: u.id, name: u.name, email: u.email };
  };
  const avery = await portal(a.id, "avery@example.test", "Avery Fictional");
  const blake = await portal(b.id, "blake@example.test", "Blake Sample");
  return { tabitha, daria, a, b, avery, blake };
}

async function approveAll(tabitha: Awaited<ReturnType<typeof setup>>["tabitha"]) {
  for (const c of await library()) if (c.status !== "APPROVED") await approveClause(tabitha, c.key);
}

/** A payment-plan agreement in her Jotform style: every clause is hers, verbatim, so it can be sent as is. */
const planOptions = (over: Partial<AgreementOptions> = {}): Partial<AgreementOptions> =>
  defaultOptions({
    services: ["TAX_INDIVIDUAL"],
    taxYear: 2025,
    fees: [{ label: "2025 Form 1040 preparation", cents: 150_000 }],
    invoiceNumber: "INV-2026-0042",
    depositCents: 50_000,
    installments: [{ cents: 50_000, date: "2026-12-01" }, { cents: 50_000, date: "2027-01-02" }],
    paymentMethods: ["ZELLE", "CASH_APP", "APPLE_PAY", "PAYMENT_LINK"],
    toggles: { latePayment: true, nonCancellable: true, bundledService: true, clientResponsibilities: false, confidentiality: false, esign: true },
    bundledMonthlyCents: 25_000,
    bundledPeriod: "January–December 2025",
    askServiceSelection: true,
    askPaymentMethod: true,
    ...over,
  });

async function sentPlan(s: Awaited<ReturnType<typeof setup>>, via: "PORTAL" | "LINK" = "PORTAL", clientId = s.a.id) {
  const ag = await createAgreement(s.daria, { clientId, templateKey: "PAYMENT_PLAN", options: planOptions() });
  const r = await sendAgreement(s.tabitha, ag.id, via);
  return { id: ag.id, ...r };
}

async function signInput(id: string, over: Partial<SignInput> = {}): Promise<SignInput> {
  const ag = await prisma.clientAgreement.findUniqueOrThrow({ where: { id } });
  const f = ag.frozenClauses as unknown as { clauses: { key: string; kind: string }[] };
  return {
    acknowledged: f.clauses.filter((c) => c.kind === "ACK").map((c) => c.key),
    consent: true,
    fullName: "Avery Fictional",
    address: "1 Test Way, Birmingham, AL 35203",
    phone: "205-555-0101",
    email: "avery@example.test",
    signature: "Avery Fictional",
    answers: { serviceSelection: "Yes, begin now", paymentMethod: "Zelle" },
    shownHash: ag.textHash!,
    ip: "203.0.113.7",
    userAgent: "Mozilla/5.0 (iPhone; fictional test)",
    ...over,
  };
}

describe("clause library and templates", () => {
  it("seeds her Jotform clauses verbatim as APPROVED and every other clause as DRAFT; only Tabitha edits", async () => {
    const { tabitha, daria } = await setup();
    const lib = await library();
    expect(lib).toHaveLength(CLAUSE_SEEDS.length);
    const jot = lib.filter((c) => c.source === "JOTFORM");
    expect(jot.every((c) => c.status === "APPROVED")).toBe(true);
    expect(lib.filter((c) => c.source === "DRAFTED").every((c) => c.status === "DRAFT")).toBe(true);
    expect(jot.find((c) => c.key === "non_cancellable")!.body).toBe("I understand this agreement cannot be cancelled or voided because the work has already been completed and delivered.");
    expect(jot.find((c) => c.key === "esign")!.body).toBe("I agree to sign electronically.");
    await expect(saveClause(daria, "fees", { body: "Changed by staff", approve: true })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(approveClause(daria, "fees")).rejects.toBeInstanceOf(ForbiddenError);
    expect(await saveClause(tabitha, "fees", { body: "Fees: {{FEE_SUMMARY}}.", approve: false })).toBe(2);
    expect((await library()).find((c) => c.key === "fees")).toMatchObject({ version: 2, status: "DRAFT" });
  });

  it("fills her Payment Plan wording from the options, exactly", async () => {
    const s = await setup();
    const ag = await createAgreement(s.daria, { clientId: s.a.id, templateKey: "PAYMENT_PLAN", options: planOptions() });
    const r = await renderFor({ ...ag, client: { displayName: "Avery Fictional", businessName: null, clientType: "INDIVIDUAL" } });
    const t = Object.fromEntries(r.clauses.map((c) => [c.key, c.text]));
    expect(t.pp_invoice_total).toBe("I have received and reviewed Invoice #INV-2026-0042 and agree that the total amount due is $1,500.00.");
    expect(t.pp_payment_schedule).toBe("I agree to pay $500.00 upon signing, $500.00 by December 1, 2026, and $500.00 by January 2, 2027.");
    expect(t.pp_early_delivery).toBe("I understand that I am receiving all completed documents early, after my first payment, as a courtesy, and that I still owe the remaining $1,000.00.");
    expect(t.bundled_bookkeeping).toBe("I understand my 2025 tax return cannot be prepared without complete 2025 bookkeeping. The January–December 2025 bookkeeping ($250.00 per month) is required as part of my 2025 tax return, cannot be separated from it, is not included in the $1,500.00, and begins when I notify the Firm.");
    expect(t.payment_methods).toBe("I understand payments may be made by Zelle, Cash App, Apple Pay, or payment link, and that a credit card processing fee will be added if I pay by payment link.");
    expect(r.questions.map((q) => q.text)).toEqual(["Do you want to begin the January–December 2025 bookkeeping now?", "How do you plan to make your payments?"]);
    expect(r.missing).toEqual([]);
    expect(r.drafts).toEqual([]);
  });

  it("prefills bookkeeping from the bookkeeping profile's fee and frequency", async () => {
    const s = await setup();
    await prisma.bookkeepingProfile.create({ data: { clientId: s.a.id, active: true, frequency: "QUARTERLY" } });
    await prisma.bookkeepingBilling.create({ data: { clientId: s.a.id, monthlyFeeCents: 32_500 } });
    const o = await prefillOptions(s.a.id, "BOOKKEEPING");
    expect(o.fees).toEqual([{ label: "Quarterly bookkeeping", cents: 32_500 }]);
    expect(o.billingFrequency).toBe("QUARTERLY");
    expect(o.renewalIncreasePct).toBe(3);
    expect(o.terminationNoticeDays).toBeNull(); // never invented
  });
});

describe("sending", () => {
  it("only Tabitha sends; staff ask her, which puts it on her overview", async () => {
    const s = await setup();
    const ag = await createAgreement(s.daria, { clientId: s.a.id, templateKey: "PAYMENT_PLAN", options: planOptions() });
    await expect(sendAgreement(s.daria, ag.id, "PORTAL")).rejects.toBeInstanceOf(ForbiddenError);
    await askToSend(s.daria, ag.id);
    expect((await prisma.clientAgreement.findUniqueOrThrow({ where: { id: ag.id } })).status).toBe("WAITING_FOR_OWNER");
    expect((await ownerQueue()).waiting.map((x) => x.id)).toEqual([ag.id]);
    expect((await listAgreements({ status: "WAITING_FOR_OWNER" })).map((x) => x.id)).toEqual([ag.id]);
    const r = await sendAgreement(s.tabitha, ag.id, "PORTAL");
    expect(r).toMatchObject({ recipients: 1, url: null });
    const n = await prisma.notification.findMany({ where: { portalUserId: s.avery.id } });
    expect(n.map((x) => x.kind)).toContain("AGREEMENT_READY");
  });

  it("a DRAFT clause blocks sending until Tabitha approves it", async () => {
    const s = await setup();
    const ag = await createAgreement(s.daria, { clientId: s.a.id, templateKey: "BOOKKEEPING", options: { ...(await prefillOptions(s.a.id, "BOOKKEEPING")), fees: [{ label: "Monthly bookkeeping", cents: 30_000 }], terminationNoticeDays: 30 } });
    await expect(sendAgreement(s.tabitha, ag.id, "PORTAL")).rejects.toThrow(/DRAFT clause/);
    await approveAll(s.tabitha);
    await expect(sendAgreement(s.tabitha, ag.id, "PORTAL")).resolves.toMatchObject({ recipients: 1 });
  });

  it("a blank option blocks sending (nothing is invented)", async () => {
    const s = await setup();
    const ag = await createAgreement(s.daria, { clientId: s.a.id, templateKey: "PAYMENT_PLAN", options: planOptions({ invoiceNumber: "" }) });
    await expect(sendAgreement(s.tabitha, ag.id, "PORTAL")).rejects.toThrow(/invoice number/);
  });

  it("freezes the exact text and versions when sent; later edits change nothing", async () => {
    const s = await setup();
    const { id } = await sentPlan(s);
    const before = await prisma.clientAgreement.findUniqueOrThrow({ where: { id } });
    expect(before.frozenText).toContain("I agree to sign electronically.");
    expect((before.frozenClauses as { clauses: { key: string; version: number }[] }).clauses.find((c) => c.key === "esign")!.version).toBe(1);
    await saveClause(s.tabitha, "esign", { body: "Changed wording after sending.", approve: true });
    const r = await renderFor({ ...before, client: { displayName: "Avery Fictional", businessName: null, clientType: "INDIVIDUAL" } });
    expect(r.frozen).toBe(true);
    expect(r.clauses.find((c) => c.key === "esign")!.text).toBe("I agree to sign electronically.");
    await expect(updateAgreement(s.tabitha, id, { options: planOptions({ fees: [{ label: "x", cents: 1 }] }) })).rejects.toThrow(/can't be changed/);
    expect((await prisma.clientAgreement.findUniqueOrThrow({ where: { id } })).textHash).toBe(before.textHash);
  });
});

describe("client signing", () => {
  it("isolation: a client can't see, open or sign another client's agreement", async () => {
    const s = await setup();
    const { id } = await sentPlan(s);
    await expect(portalAgreement(s.blake, id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(portalAgreementList(s.blake, s.a.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(signClientAgreement({ portalUser: s.blake }, id, await signInput(id))).rejects.toBeInstanceOf(ForbiddenError);
    expect(await portalAgreementList(s.blake, s.b.id)).toEqual([]);
    // Drafts are never visible.
    const draft = await createAgreement(s.daria, { clientId: s.a.id, templateKey: "PAYMENT_PLAN", options: planOptions() });
    await expect(portalAgreement(s.avery, draft.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await portalAgreementList(s.avery, s.a.id)).map((x) => x.id)).toEqual([id]);
  });

  it("records the evidence, stores one signed PDF in Contracts and tells Tabitha", async () => {
    const s = await setup();
    const { id } = await sentPlan(s);
    await expect(signClientAgreement({ portalUser: s.avery }, id, await signInput(id, { acknowledged: ["esign"] }))).rejects.toThrow(/Tick each acknowledgment/);
    await expect(signClientAgreement({ portalUser: s.avery }, id, await signInput(id, { consent: false }))).rejects.toThrow(/consent/);
    await expect(signClientAgreement({ portalUser: s.avery }, id, await signInput(id, { signature: "Someone Else" }))).rejects.toThrow(/signature/);
    await expect(signClientAgreement({ portalUser: s.avery }, id, await signInput(id, { shownHash: "stale" }))).rejects.toThrow(/changed since/);
    await expect(signClientAgreement({ portalUser: s.avery }, id, await signInput(id, { answers: {} }))).rejects.toThrow(/Answer/);
    await signClientAgreement({ portalUser: s.avery }, id, await signInput(id));
    const ag = await prisma.clientAgreement.findUniqueOrThrow({ where: { id } });
    expect(ag).toMatchObject({ status: "SIGNED", signerName: "Avery Fictional", signerEmail: "avery@example.test", signerIp: "203.0.113.7", signerAgent: "Mozilla/5.0 (iPhone; fictional test)", signedByPortalId: s.avery.id, signedViaLinkId: null });
    expect(ag.signerPhone).toBeTruthy();
    expect(ag.signerAnswers).toEqual([{ question: "Do you want to begin the January–December 2025 bookkeeping now?", answer: "Yes, begin now" }, { question: "How do you plan to make your payments?", answer: "Zelle" }]);
    expect(ag.textHash).toMatch(/^[0-9a-f]{64}$/);
    const docs = await prisma.document.findMany({ where: { clientId: s.a.id, docType: "CLIENT_AGREEMENT" }, include: { file: true } });
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ category: "CONTRACTS", visibility: "PUBLISHED", scanStatus: "CLEAN", id: ag.pdfDocumentId });
    expect(docs[0].file.mimeType).toBe("application/pdf");
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "agreement_center.signed", entityId: id } });
    expect(audit.details).toMatchObject({ textHash: ag.textHash, portalUserId: s.avery.id });
    expect((await ownerQueue()).recent.map((x) => x.id)).toEqual([id]);
    // Signing twice is refused, and no second PDF is stored.
    await expect(signClientAgreement({ portalUser: s.avery }, id, await signInput(id))).rejects.toThrow(/already signed/);
    expect(await prisma.document.count({ where: { docType: "CLIENT_AGREEMENT" } })).toBe(1);
  });

  it("the signed PDF is a real PDF with the agreement and signature", async () => {
    const { renderSignedAgreementPdf } = await import("@/lib/agreements/pdf");
    const bytes = await renderSignedAgreementPdf({ title: "Client Service & Payment Agreement", intro: "Between the Firm and Avery Fictional.", clientName: "Avery Fictional", clauses: [{ key: "esign", title: "Electronic signature", kind: "ACK", version: 1, text: "I agree to sign electronically." }] }, { signerName: "Avery Fictional", address: "1 Test Way", phone: "205-555-0101", email: "avery@example.test", answers: [], acknowledged: ["esign"], signedAtChicago: "November 6, 2026", dateSigned: "November 6, 2026", ip: "203.0.113.7", userAgent: "test", textHash: "a".repeat(64), via: "client portal", templateVersion: "PAYMENT_PLAN v1" });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(0);
    expect(doc.getTitle()).toContain("Avery Fictional");
  });

  it("a client can decline with a reason", async () => {
    const s = await setup();
    const { id } = await sentPlan(s);
    await expect(declineClientAgreement({ portalUser: s.avery }, id, "")).rejects.toThrow(/why/);
    await declineClientAgreement({ portalUser: s.avery }, id, "I'd like to talk first.");
    expect(await prisma.clientAgreement.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "DECLINED", declineReason: "I'd like to talk first." });
  });

  it("secure link: works once, expires, and an older link stops working when a new one is made", async () => {
    const s = await setup();
    const c = await createClient(s.tabitha, { firstName: "Casey", lastName: "Nologin", clientType: "INDIVIDUAL", status: "ACTIVE", email: "casey@example.test" });
    const ag = await createAgreement(s.daria, { clientId: c.id, templateKey: "PAYMENT_PLAN", options: planOptions() });
    await expect(sendAgreement(s.tabitha, ag.id, "PORTAL")).rejects.toThrow(/no portal login/);
    const { url } = await sendAgreement(s.tabitha, ag.id, "LINK");
    const token = url!.split("/agreement-sign/")[1];
    expect(token.length).toBeGreaterThan(30);
    expect(await prisma.agreementSigningLink.count({ where: { tokenHash: token } })).toBe(0); // only the hash is stored
    expect((await resolveSigningLink(token)).state).toBe("OK");

    // A new link replaces the first.
    const second = (await newSigningLink(s.tabitha, ag.id)).url.split("/agreement-sign/")[1];
    expect((await resolveSigningLink(token)).state).toBe("REVOKED");
    await expect(newSigningLink(s.daria, ag.id)).rejects.toBeInstanceOf(ForbiddenError);

    // Expired.
    await prisma.agreementSigningLink.updateMany({ where: { agreementId: ag.id, revokedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await resolveSigningLink(second)).state).toBe("EXPIRED");
    await expect(signClientAgreement({ token: second }, null, await signInput(ag.id, { fullName: "Casey Nologin", signature: "Casey Nologin" }))).rejects.toThrow(/expired/);

    // A fresh link signs once.
    const third = (await newSigningLink(s.tabitha, ag.id)).url.split("/agreement-sign/")[1];
    await signClientAgreement({ token: third }, null, await signInput(ag.id, { fullName: "Casey Nologin", signature: "Casey Nologin", email: "casey@example.test" }));
    const signed = await prisma.clientAgreement.findUniqueOrThrow({ where: { id: ag.id } });
    expect(signed.status).toBe("SIGNED");
    expect(signed.signedViaLinkId).toBeTruthy();
    expect(signed.signedByPortalId).toBeNull();
    expect((await resolveSigningLink(third)).state).toBe("USED");
    await expect(signClientAgreement({ token: third }, null, await signInput(ag.id))).rejects.toThrow(/already used/);
  });

  it("the link email goes out only on Tabitha's explicit click (never on send)", async () => {
    const s = await setup();
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (u: string) => {
      calls.push(String(u));
      return new Response(JSON.stringify({ clean: true, id: "em_1" }), { status: 200 });
    });
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("EMAIL_FROM_ADDRESS", "office@example.test");
    const c = await createClient(s.tabitha, { firstName: "Casey", lastName: "Nologin", clientType: "INDIVIDUAL", status: "ACTIVE", email: "casey@example.test" });
    const ag = await createAgreement(s.daria, { clientId: c.id, templateKey: "PAYMENT_PLAN", options: planOptions() });
    await sendAgreement(s.tabitha, ag.id, "LINK");
    expect(calls.filter((u) => u.includes("/emails"))).toHaveLength(0);
    const r = await newSigningLink(s.tabitha, ag.id, { email: true });
    expect(r.emailed).toBe("casey@example.test");
    expect(calls.filter((u) => u.includes("/emails"))).toHaveLength(1);
  });
});

describe("add invoice, bulk and renewals", () => {
  it("Add invoice to this agreement: draft invoices from the fees, one per scheduled payment, linked both ways", async () => {
    const s = await setup();
    const ag = await createAgreement(s.daria, { clientId: s.a.id, templateKey: "PAYMENT_PLAN", options: planOptions() });
    await expect(addInvoiceToAgreement(s.daria, ag.id)).rejects.toBeInstanceOf(ForbiddenError); // Billing → Create needed
    const made = await addInvoiceToAgreement(s.tabitha, ag.id);
    expect(made).toHaveLength(3);
    const inv = await prisma.invoice.findMany({ where: { agreementId: ag.id }, include: { lines: true }, orderBy: { dueDate: "asc" } });
    expect(inv.map((i) => i.state)).toEqual(["DRAFT", "DRAFT", "DRAFT"]);
    expect(inv.map((i) => i.lines[0].unitCents)).toEqual([50_000, 50_000, 50_000]);
    expect(inv.slice(1).map((i) => i.dueDate.toISOString().slice(0, 10))).toEqual(["2026-12-01", "2027-01-02"]);
    expect((await listAgreements({ clientId: s.a.id }))[0].invoices).toHaveLength(3);
    await expect(addInvoiceToAgreement(s.tabitha, ag.id)).rejects.toThrow(/already has/);
    expect(await prisma.notification.count()).toBe(0); // nothing sent

    // Without a schedule: one invoice, every fee a line.
    const flat = await createAgreement(s.daria, { clientId: s.a.id, templateKey: "FORMATION", options: defaultOptions({ services: ["BUSINESS_FORMATION"], fees: [{ label: "LLC formation", cents: 60_000 }, { label: "Operating agreement", cents: 20_000 }] }) });
    const one = await addInvoiceToAgreement(s.tabitha, flat.id);
    const lines = await prisma.invoiceLine.findMany({ where: { invoiceId: one[0].id }, orderBy: { sortOrder: "asc" } });
    expect(lines.map((l) => [l.service, l.unitCents])).toEqual([["LLC formation", 60_000], ["Operating agreement", 20_000]]);
  });

  it("bulk: one draft per client with its own fee; sent only by Tabitha's Send selected", async () => {
    const s = await setup();
    await approveAll(s.tabitha);
    for (const [c, fee] of [[s.a, 30_000], [s.b, 45_000]] as const) {
      await prisma.bookkeepingProfile.create({ data: { clientId: c.id, active: true } });
      await prisma.bookkeepingBilling.create({ data: { clientId: c.id, monthlyFeeCents: fee } });
    }
    const candidates = await bulkCandidates("ACTIVE_BOOKKEEPING");
    expect(candidates.map((c) => c.id).sort()).toEqual([s.a.id, s.b.id].sort());
    const batch = await bulkCreate(s.daria, "BOOKKEEPING", candidates.map((c) => c.id));
    const drafts = await prisma.clientAgreement.findMany({ where: { bulkBatchId: batch } });
    expect(drafts).toHaveLength(2);
    expect(drafts.every((d) => d.status === "DRAFT")).toBe(true);
    const fee = (id: string) => (drafts.find((d) => d.clientId === id)!.options as unknown as AgreementOptions).fees[0].cents;
    expect([fee(s.a.id), fee(s.b.id)]).toEqual([30_000, 45_000]);
    expect(await prisma.notification.count()).toBe(0);
    await expect(sendSelected(s.daria, drafts.map((d) => d.id))).rejects.toBeInstanceOf(ForbiddenError);
    // Month-to-month notice days aren't invented: fill them, then send.
    for (const d of drafts) await updateAgreement(s.tabitha, d.id, { options: { ...(d.options as unknown as AgreementOptions), terminationNoticeDays: 30 } });
    const res = await sendSelected(s.tabitha, drafts.map((d) => d.id));
    expect(res.every((r) => r.ok)).toBe(true);
  });

  it("renewal: Renewal due 30 days before the end; Prepare renewal makes a +3% draft, never sent", async () => {
    const s = await setup();
    await approveAll(s.tabitha);
    const start = new Date();
    start.setUTCFullYear(start.getUTCFullYear() - 1);
    start.setUTCDate(start.getUTCDate() + 20); // ends in about 20 days
    const ag = await createAgreement(s.daria, { clientId: s.a.id, templateKey: "BOOKKEEPING", options: { ...defaultOptions({ services: ["BOOKKEEPING"], fees: [{ label: "Monthly bookkeeping", cents: 30_000 }], feeStructure: "MONTHLY", billingFrequency: "MONTHLY", term: "TWELVE_MONTHS", autoRenew: true, renewalIncreasePct: 3, terminationNoticeDays: 30, paymentMethods: ["ZELLE"] }), startDate: start.toISOString().slice(0, 10) } });
    await sendAgreement(s.tabitha, ag.id, "PORTAL");
    await signClientAgreement({ portalUser: s.avery }, ag.id, await signInput(ag.id, { answers: {} }));
    const row = (await listAgreements({ clientId: s.a.id }))[0];
    expect(row.display).toBe("RENEWAL_DUE");
    expect((await listAgreements({ status: "RENEWAL_DUE" })).map((x) => x.id)).toEqual([ag.id]);
    const next = await prepareRenewal(s.daria, ag.id);
    expect(next.status).toBe("DRAFT");
    expect(next.renewsId).toBe(ag.id);
    expect((next.options as unknown as AgreementOptions).fees[0].cents).toBe(30_900);
    const end = (await prisma.clientAgreement.findUniqueOrThrow({ where: { id: ag.id } })).termEndDate!;
    end.setUTCDate(end.getUTCDate() + 1);
    expect((next.options as unknown as AgreementOptions).startDate).toBe(end.toISOString().slice(0, 10));
    await expect(prepareRenewal(s.daria, ag.id)).rejects.toThrow(/already prepared/);
    expect(displayStatus({ ...(await prisma.clientAgreement.findUniqueOrThrow({ where: { id: ag.id }, include: { renewals: true } })) }, new Date().toISOString().slice(0, 10))).toBe("SIGNED");
  });
});

describe("gates, clients and Jotform", () => {
  it("tax work may begin once a signed agreement covers the service and year", async () => {
    const s = await setup();
    const svc = await createService(s.daria, { clientId: s.a.id, type: "TAX_INDIVIDUAL", taxYear: 2025 });
    await prisma.clientService.update({ where: { id: svc.id }, data: { status: "APPROVED_TO_BEGIN" } });
    await expect(setServiceStatus(s.daria, svc.id, "IN_PROGRESS")).rejects.toThrow(/hasn't signed/);
    // An agreement for another year doesn't count.
    const other = await createAgreement(s.daria, { clientId: s.a.id, templateKey: "PAYMENT_PLAN", options: planOptions({ taxYear: 2024 }) });
    await sendAgreement(s.tabitha, other.id, "PORTAL");
    await signClientAgreement({ portalUser: s.avery }, other.id, await signInput(other.id));
    await expect(setServiceStatus(s.daria, svc.id, "IN_PROGRESS")).rejects.toThrow(/hasn't signed/);
    const { id } = await sentPlan(s);
    await signClientAgreement({ portalUser: s.avery }, id, await signInput(id));
    await setServiceStatus(s.daria, svc.id, "IN_PROGRESS");
    expect((await prisma.clientService.findUniqueOrThrow({ where: { id: svc.id } })).status).toBe("IN_PROGRESS");
  });

  it("New client never creates a duplicate", async () => {
    const s = await setup();
    await expect(createClientForAgreement(s.daria, { clientType: "INDIVIDUAL", firstName: "Someone", lastName: "New", email: "AVERY@example.test" })).rejects.toThrow(/Possible existing client: Avery Fictional/);
    await expect(createClientForAgreement(s.daria, { clientType: "INDIVIDUAL", firstName: "Avery", lastName: "Fictional" })).rejects.toThrow(/Possible existing client/);
    const before = await prisma.client.count();
    const c = await createClientForAgreement(s.daria, { clientType: "BUSINESS", businessName: "Brand New Fictional LLC", email: "new@example.test" });
    expect(c.status).toBe("PROSPECT");
    expect(await prisma.client.count()).toBe(before + 1);
  });

  it("Jotform contracts keep working alongside", async () => {
    const s = await setup();
    const j = await assignContract(s.daria, { clientId: s.a.id, title: "Older engagement letter", jotformFormId: "123456789" });
    expect(j.status).toBe("ASSIGNED");
    expect(await prisma.contractAssignment.count({ where: { clientId: s.a.id } })).toBe(1);
  });
});
