import { beforeEach, describe, expect, it } from "vitest";
import { prisma, resetDb } from "./db";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import { hashPassword } from "@/lib/auth/password";
import { assertOwner, claimOwnerOffice, grantOwnerAccess, ownerNavState, revokeOwnerAccess } from "@/lib/auth/owner";
import { addMonths, agingBucket, collectedCents, computeBreakdown, scheduleStatus, validatePricing, type PricingInput } from "@/lib/billing/pricing";
import {
  billingSettings,
  createQuote,
  invoiceRows,
  issueInvoice,
  monthlySummary,
  offerQuote,
  portalAcceptQuote,
  portalBilling,
  portalDeclineQuote,
  quoteTermsHash,
  breakdownOf,
  receivables,
  recordPayment,
  updateBillingSettings,
  updateDraft,
  voidInvoice,
  withdrawQuote,
  type QuoteInput,
} from "@/lib/services/owner-billing";
import { createExpense, deleteExpense, listExpenses, readReceipt } from "@/lib/services/owner-expenses";
import { createClient } from "@/lib/services/clients";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";

beforeEach(resetDb);

const PASSWORD = "Owner-Strong-Pass-1";
const PDF = new TextEncoder().encode("%PDF-1.4\n% fictional receipt\n");

async function staffAccount(email: string, name: string, role: "ADMIN" | "STAFF"): Promise<Actor> {
  const u = await prisma.user.create({ data: { email, name, role, passwordHash: await hashPassword(PASSWORD), mfaEnabledAt: new Date() } });
  return { id: u.id, role: u.role, name: u.name, email: u.email };
}

async function office() {
  const tab = await staffAccount("tabitha@tturnerassociates.com", "Tabitha", "ADMIN");
  const daria = await staffAccount("daria@tturnerassociates.com", "Daria", "STAFF");
  const otherAdmin = await staffAccount("admin2@tturnerassociates.com", "Second Admin", "ADMIN");
  await claimOwnerOffice(tab, PASSWORD);
  return { tab, daria, otherAdmin };
}

async function portalClients(staff: Actor) {
  const acme = await createClient(staff, { businessName: "Acme Fictional LLC", clientType: "BUSINESS", status: "ACTIVE" });
  const other = await createClient(staff, { firstName: "Other", lastName: "Person", clientType: "INDIVIDUAL", status: "ACTIVE" });
  const join = async (clientId: string, email: string) => {
    const { token } = await invitePortalUser(staff, clientId, { email, name: email.split("@")[0], role: "OWNER" });
    const u = await acceptPortalInvite(token!, "Portal-Pass-123");
    return { id: u.id, name: u.name, email: u.email };
  };
  return { acme, other, acmeUser: await join(acme.id, "acme@example.com"), otherUser: await join(other.id, "other@example.com") };
}

const quote = (clientId: string, over: Partial<QuoteInput> = {}): QuoteInput => ({
  clientId,
  title: "2026 bookkeeping cleanup",
  issueDate: "2026-10-01",
  dueDate: "2026-10-31",
  memo: "Thank you for your business.",
  paymentTerms: "Due within 30 days.",
  privateNote: "OWNER-ONLY NOTE",
  lines: [
    { service: "Bookkeeping cleanup", quantity: 1, unitCents: 90000 },
    { service: "Payroll setup", quantity: 2, unitCents: 15000 },
  ],
  allowFull: true,
  allowPlan: true,
  depositType: "NONE",
  depositValue: 0,
  discountType: "NONE",
  discountValue: 0,
  discountCoversPlanFee: false,
  taxRateBps: 0,
  planInstallments: 3,
  planFirstDueDate: "2026-11-01",
  planIntervalMonths: 1,
  ...over,
});

async function setFee(tab: Actor, type: "FLAT" | "PERCENT", value: number) {
  await updateBillingSettings(tab, {
    planFeeType: type,
    planFeeValue: value,
    maxInstallments: 4,
    defaultInstallments: 3,
    defaultDiscountType: "NONE",
    defaultDiscountValue: 0,
    defaultTaxRateBps: 0,
    defaultDepositType: "NONE",
    defaultDepositValue: 0,
    defaultPaymentTerms: null,
    planFeeRulesConfirmed: true,
  });
}

describe("pricing math", () => {
  const base: PricingInput = {
    lines: [{ service: "Tax prep", quantity: 1, unitCents: 100000 }],
    discountType: "PERCENT",
    discountValue: 1000, // 10%
    discountCoversPlanFee: false,
    taxRateBps: 400, // 4%
    planFeeType: "PERCENT",
    planFeeValue: 500, // 5%
    depositType: "FLAT",
    depositValue: 20000,
    allowFull: true,
    allowPlan: true,
    issueDate: "2026-10-01",
    dueDate: "2026-10-31",
    planInstallments: 3,
    planFirstDueDate: "2026-11-15",
    planIntervalMonths: 1,
  };

  it("shows every step: discount, tax, plan fee, deposit and installments that add up exactly", () => {
    const b = computeBreakdown(base);
    expect(b.subtotalCents).toBe(100000);
    expect(b.serviceDiscountCents).toBe(10000);
    expect(b.taxCents).toBe(3600); // 4% of 900.00
    expect(b.fullTotalCents).toBe(93600);
    expect(b.options.FULL!.planFeeCents).toBe(0);
    expect(b.options.FULL!.schedule.map((s) => [s.label, s.amountCents])).toEqual([["Deposit", 20000], ["Balance", 73600]]);
    const plan = b.options.PLAN!;
    expect(plan.planFeeCents).toBe(4500); // 5% of 900.00 (after discount, before tax)
    expect(plan.totalCents).toBe(98100);
    expect(plan.schedule.map((s) => s.amountCents)).toEqual([20000, 26033, 26033, 26034]);
    expect(plan.schedule.reduce((s, x) => s + x.amountCents, 0)).toBe(plan.totalCents);
    expect(plan.schedule.map((s) => s.dueDate)).toEqual(["2026-10-01", "2026-11-15", "2026-12-15", "2027-01-15"]);
    expect(b.explanation.join(" ")).toMatch(/Payment-plan fee: 5% of the services after discount/);
    expect(b.explanation.join(" ")).not.toMatch(/convenience/i);
  });

  it("discount can also reduce the plan fee (percent and flat)", () => {
    const pctBoth = computeBreakdown({ ...base, discountCoversPlanFee: true });
    expect(pctBoth.options.PLAN!.planFeeDiscountCents).toBe(450);
    const flat = computeBreakdown({ ...base, lines: [{ service: "Tax prep", quantity: 1, unitCents: 5000 }], discountType: "FLAT", discountValue: 6000, discountCoversPlanFee: true, planFeeType: "FLAT", planFeeValue: 2500, depositType: "NONE" });
    expect(flat.serviceDiscountCents).toBe(5000); // capped at services
    expect(flat.options.PLAN!.planFeeDiscountCents).toBe(1000); // the leftover $10 goes to the fee
    expect(flat.options.PLAN!.totalCents).toBe(1500);
    const servicesOnly = computeBreakdown({ ...base, discountCoversPlanFee: false });
    expect(servicesOnly.options.PLAN!.planFeeDiscountCents).toBe(0);
  });

  it("refuses plans without the configured fee, typed-in fee lines, and bad installment counts", () => {
    expect(() => validatePricing({ ...base, planFeeType: "NONE", planFeeValue: 0 }, { maxInstallments: 4 })).toThrow(/payment-plan fee in Billing settings/);
    expect(() => validatePricing({ ...base, lines: [...base.lines, { service: "Payment plan fee", quantity: 1, unitCents: 500 }] }, { maxInstallments: 4 })).toThrow(/added automatically/);
    expect(() => validatePricing({ ...base, lines: [{ service: "Card convenience fee", quantity: 1, unitCents: 300 }] }, { maxInstallments: 4 })).toThrow();
    expect(() => validatePricing({ ...base, planInstallments: 6 }, { maxInstallments: 4 })).toThrow(/2 to 4 installments/);
    expect(() => validatePricing({ ...base, allowFull: false, allowPlan: false }, { maxInstallments: 4 })).toThrow(/full payment, a payment plan, or both/);
    expect(() => validatePricing({ ...base, discountType: "PERCENT", discountValue: 15000 }, { maxInstallments: 4 })).toThrow(/100%/);
  });

  it("only successful payments minus refunds count as collected; aging and overdue use the schedule", () => {
    expect(collectedCents([
      { kind: "PAYMENT", status: "SUCCEEDED", amountCents: 5000 },
      { kind: "PAYMENT", status: "FAILED", amountCents: 9999 },
      { kind: "PAYMENT", status: "PENDING", amountCents: 9999 },
      { kind: "REFUND", status: "SUCCEEDED", amountCents: 1000 },
    ])).toBe(4000);
    const s = scheduleStatus([
      { seq: 1, label: "A", dueDate: "2026-09-01", amountCents: 1000 },
      { seq: 2, label: "B", dueDate: "2026-10-01", amountCents: 1000 },
      { seq: 3, label: "C", dueDate: "2026-12-01", amountCents: 1000 },
    ], 1500, "2026-10-20");
    expect(s.map((x) => x.state)).toEqual(["PAID", "OVERDUE", "DUE"]);
    expect(s[1].dueCents).toBe(500);
    expect(s[1].daysOverdue).toBe(19);
    expect([0, 1, 30, 31, 61, 91].map(agingBucket)).toEqual(["Current", "1–30 days", "1–30 days", "31–60 days", "61–90 days", "Over 90 days"]);
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
  });
});

describe("Owner's Office access", () => {
  it("is bound to the owner's account ID, not the email or the Admin role", async () => {
    const { tab, daria, otherAdmin } = await office();
    expect(await ownerNavState(tab)).toBe("full");
    expect(await ownerNavState(daria)).toBe("none");
    expect(await ownerNavState(otherAdmin)).toBe("none");
    for (const who of [daria, otherAdmin]) {
      await expect(assertOwner(who)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(createQuote(who, quote("x"))).rejects.toBeInstanceOf(ForbiddenError);
      await expect(invoiceRows(who)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(receivables(who)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(monthlySummary(who, 2026)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(listExpenses(who, { year: 2026 })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(billingSettings().then(() => setFee(who, "FLAT", 2500))).rejects.toBeInstanceOf(ForbiddenError);
    }
    // A forged actor carrying the owner's email (but a different account ID) gets nothing.
    await expect(assertOwner({ ...daria, email: "tabitha@tturnerassociates.com", role: "ADMIN" })).rejects.toBeInstanceOf(ForbiddenError);
    // Changing the owner's sign-in email doesn't remove access; giving that email to someone else doesn't grant it.
    await prisma.user.update({ where: { id: tab.id }, data: { email: "tab.new@tturnerassociates.com" } });
    await assertOwner({ ...tab, email: "tab.new@tturnerassociates.com" });
    // Deactivated owner account: no access.
    await prisma.user.update({ where: { id: tab.id }, data: { active: false } });
    await expect(assertOwner(tab)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("can be claimed once, only by the owner email's Admin account with its password", async () => {
    const imposter = await staffAccount("someone@tturnerassociates.com", "Imposter", "ADMIN");
    await expect(claimOwnerOffice(imposter, PASSWORD)).rejects.toBeInstanceOf(ForbiddenError);
    const tabStaff = await staffAccount("tabitha@tturnerassociates.com", "Tabitha", "STAFF");
    await expect(claimOwnerOffice(tabStaff, PASSWORD)).rejects.toBeInstanceOf(ForbiddenError); // not an Admin
    await prisma.user.update({ where: { id: tabStaff.id }, data: { role: "ADMIN" } });
    const tab = { ...tabStaff, role: "ADMIN" as const };
    expect(await ownerNavState(tab)).toBe("claim");
    await expect(claimOwnerOffice(tab, "wrong-password")).rejects.toThrow(/password/);
    await claimOwnerOffice(tab, PASSWORD);
    await expect(claimOwnerOffice(tab, PASSWORD)).rejects.toBeInstanceOf(ForbiddenError);
    // Once claimed, nobody else can claim even with the same email later.
    await prisma.user.update({ where: { id: tab.id }, data: { email: "moved@tturnerassociates.com" } });
    const later = await staffAccount("tabitha@tturnerassociates.com", "Later", "ADMIN");
    expect(await ownerNavState(later)).toBe("none");
    await expect(claimOwnerOffice(later, PASSWORD)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("only the owner can grant access; billing-only delegates can't see expenses or totals", async () => {
    const { tab, daria, otherAdmin } = await office();
    await expect(grantOwnerAccess(otherAdmin, { userId: daria.id, scope: "FULL", password: PASSWORD })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(grantOwnerAccess(tab, { userId: daria.id, scope: "BILLING", password: "nope" })).rejects.toThrow(/password/);
    await grantOwnerAccess(tab, { userId: daria.id, scope: "BILLING", password: PASSWORD });
    expect(await ownerNavState(daria)).toBe("billing");
    await assertOwner(daria, "billing");
    await expect(listExpenses(daria, { year: 2026 })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(monthlySummary(daria, 2026)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(receivables(daria)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setFee(daria, "FLAT", 100)).rejects.toBeInstanceOf(ForbiddenError);
    // A delegate can't grant onward.
    await expect(grantOwnerAccess(daria, { userId: otherAdmin.id, scope: "BILLING", password: PASSWORD })).rejects.toBeInstanceOf(ForbiddenError);
    // A delegate can't override the plan fee.
    await setFee(tab, "FLAT", 2500);
    const { acme } = await portalClients(tab);
    await expect(createQuote(daria, quote(acme.id, { planFeeOverride: { type: "FLAT", value: 1 } }))).rejects.toBeInstanceOf(ForbiddenError);
    await revokeOwnerAccess(tab, daria.id);
    await expect(assertOwner(daria, "billing")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(revokeOwnerAccess(tab, tab.id)).rejects.toThrow(/your own/);
  });

  it("owner activity never appears in the shared audit log", async () => {
    const { tab } = await office();
    await setFee(tab, "FLAT", 2500);
    const { acme } = await portalClients(tab);
    const inv = await createQuote(tab, quote(acme.id));
    await offerQuote(tab, inv.id);
    await createExpense(tab, { spentOn: "2026-10-02", vendor: "Office Depot", category: "Office supplies", amountCents: 4599 });
    expect(await prisma.auditLog.count({ where: { OR: [{ entityType: "Invoice" }, { entityType: "Expense" }, { action: { startsWith: "billing." } }, { action: { startsWith: "expense." } }] } })).toBe(0);
    expect(await prisma.ownerAuditLog.count()).toBeGreaterThan(2);
  });
});

describe("quotes, acceptance and payments", () => {
  it("client sees only published quotes for their own account, without private notes, and accepts exact terms", async () => {
    const { tab } = await office();
    await setFee(tab, "PERCENT", 500);
    const { acme, other, acmeUser, otherUser } = await portalClients(tab);
    const inv = await createQuote(tab, quote(acme.id, { discountType: "PERCENT", discountValue: 1000, depositType: "PERCENT", depositValue: 2500 }));
    expect(await portalBilling(acmeUser, acme.id)).toEqual([]); // drafts are invisible
    await offerQuote(tab, inv.id);
    await expect(updateDraft(tab, inv.id, quote(acme.id))).rejects.toThrow(/Only drafts/);

    const [shown] = await portalBilling(acmeUser, acme.id);
    expect(JSON.stringify(shown)).not.toContain("OWNER-ONLY NOTE");
    expect(shown.breakdown.options.PLAN!.planFeeCents).toBe(5400); // 5% of 1,080.00
    await expect(portalBilling(otherUser, acme.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await portalBilling(otherUser, other.id)).toEqual([]);

    const full = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id }, include: { lines: true } });
    const hash = quoteTermsHash(full, "Acme Fictional LLC", breakdownOf(full), "PLAN");
    await expect(portalAcceptQuote(otherUser, { invoiceId: inv.id, option: "PLAN", termsHash: hash, agreed: true, ip: null })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(portalAcceptQuote(acmeUser, { invoiceId: inv.id, option: "PLAN", termsHash: "stale", agreed: true, ip: null })).rejects.toThrow(/changed/);
    await expect(portalAcceptQuote(acmeUser, { invoiceId: inv.id, option: "PLAN", termsHash: hash, agreed: false, ip: null })).rejects.toThrow(/agree/);
    const accepted = await portalAcceptQuote(acmeUser, { invoiceId: inv.id, option: "PLAN", termsHash: hash, agreed: true, ip: "203.0.113.5" });
    expect(accepted.terms.automaticCharges).toBe(false);
    await expect(portalAcceptQuote(acmeUser, { invoiceId: inv.id, option: "FULL", termsHash: hash, agreed: true, ip: null })).rejects.toThrow(/isn't open/);
    await expect(withdrawQuote(tab, inv.id)).rejects.toThrow();

    const saved = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id }, include: { installments: true } });
    expect(saved.state).toBe("ACCEPTED");
    expect(saved.acceptedOption).toBe("PLAN");
    expect(saved.acceptedTermsHash).toBe(hash);
    expect(saved.installments.reduce((s, i) => s + i.amountCents, 0)).toBe(accepted.terms.totalCents);
    // Fee settings changing later never touch accepted terms.
    await setFee(tab, "FLAT", 99999);
    const [after] = await portalBilling(acmeUser, acme.id);
    expect(after.totalCents).toBe(accepted.terms.totalCents);
  });

  it("tracks deposits, partial payments, refunds and failures; never over-collects", async () => {
    const { tab } = await office();
    await setFee(tab, "FLAT", 2500);
    const { acme, acmeUser } = await portalClients(tab);
    const inv = await createQuote(tab, quote(acme.id, { allowPlan: false }));
    await expect(recordPayment(tab, { invoiceId: inv.id, kind: "PAYMENT", status: "SUCCEEDED", amountCents: 100, receivedOn: "2026-10-02", method: "CHECK" })).rejects.toThrow(/accepted quotes and issued invoices/);
    await issueInvoice(tab, inv.id); // total 1,200.00, full payment
    await recordPayment(tab, { invoiceId: inv.id, kind: "PAYMENT", status: "SUCCEEDED", amountCents: 50000, receivedOn: "2026-10-05", method: "ZELLE" });
    await recordPayment(tab, { invoiceId: inv.id, kind: "PAYMENT", status: "FAILED", amountCents: 70000, receivedOn: "2026-10-06", method: "ACH", note: "Insufficient funds" });
    await expect(recordPayment(tab, { invoiceId: inv.id, kind: "PAYMENT", status: "SUCCEEDED", amountCents: 70001, receivedOn: "2026-10-07", method: "CHECK" })).rejects.toThrow(/remaining balance of \$700.00/);
    await expect(recordPayment(tab, { invoiceId: inv.id, kind: "REFUND", status: "SUCCEEDED", amountCents: 50001, receivedOn: "2026-10-07", method: "CHECK" })).rejects.toThrow(/exceed/);
    await recordPayment(tab, { invoiceId: inv.id, kind: "REFUND", status: "SUCCEEDED", amountCents: 10000, receivedOn: "2026-10-08", method: "ZELLE" });
    const [row] = await invoiceRows(tab);
    expect(row.totalCents).toBe(120000);
    expect(row.collectedCents).toBe(40000);
    expect(row.balanceCents).toBe(80000);
    const [client] = await portalBilling(acmeUser, acme.id);
    expect(client.balanceCents).toBe(80000);
    expect(client.payments.every((p) => p.amountCents !== 70000)).toBe(true); // failed attempt isn't shown as paid
    await expect(voidInvoice(tab, inv.id, "mistake")).rejects.toThrow(/Refund/);
  });

  it("monthly totals separate invoiced revenue from cash collected and subtract expenses", async () => {
    const { tab } = await office();
    await setFee(tab, "FLAT", 2500);
    const { acme, acmeUser } = await portalClients(tab);
    const paid = await createQuote(tab, quote(acme.id, { allowPlan: false }));
    await issueInvoice(tab, paid.id); // 1,200.00 invoiced in October (issue date)
    await recordPayment(tab, { invoiceId: paid.id, kind: "PAYMENT", status: "SUCCEEDED", amountCents: 30000, receivedOn: "2026-10-10", method: "CASH" });
    const unpaid = await createQuote(tab, quote(acme.id, { allowPlan: false, issueDate: "2026-09-01", dueDate: "2026-09-15" }));
    await issueInvoice(tab, unpaid.id); // 1,200.00 invoiced in September, nothing paid
    const offered = await createQuote(tab, quote(acme.id)); // offered but not accepted: not revenue
    await offerQuote(tab, offered.id);
    await createExpense(tab, { spentOn: "2026-10-03", vendor: "Software Co", category: "Software", amountCents: 5000, receipt: { bytes: PDF, originalName: "r.pdf" } });
    const gone = await createExpense(tab, { spentOn: "2026-10-04", vendor: "Typo", category: "Other", amountCents: 999999 });
    await deleteExpense(tab, gone.id);

    const { months, total } = await monthlySummary(tab, 2026);
    expect(months[8]).toMatchObject({ invoicedCents: 120000, collectedCents: 0 });
    expect(months[9]).toMatchObject({ invoicedCents: 120000, collectedCents: 30000, expensesCents: 5000, netCashCents: 25000 });
    expect(total.collectedCents).toBe(30000);

    const r = await receivables(tab);
    expect(r.totalOutstandingCents).toBe(210000);
    expect(r.clients[0]).toMatchObject({ clientName: "Acme Fictional LLC", balanceCents: 210000 });
    expect(r.clients[0].services).toContain("Bookkeeping cleanup");
    expect(r.aging["Over 90 days"] + r.aging["31–60 days"] + r.aging["1–30 days"] + r.aging["61–90 days"] + r.aging.Current).toBe(210000);

    const exp = (await listExpenses(tab, { year: 2026, month: 10 }))[0];
    expect((await readReceipt(tab, exp.id))?.mime).toBe("application/pdf");
    // The client portal only ever shows its own published invoices — never expenses or totals.
    expect(JSON.stringify(await portalBilling(acmeUser, acme.id))).not.toMatch(/Software Co|expens/i);
  });

  it("declining and void work only in the right states", async () => {
    const { tab } = await office();
    await setFee(tab, "FLAT", 2500);
    const { acme, acmeUser, otherUser } = await portalClients(tab);
    const inv = await createQuote(tab, quote(acme.id));
    await expect(portalDeclineQuote(acmeUser, inv.id)).rejects.toThrow(/isn't open/);
    await offerQuote(tab, inv.id);
    await expect(portalDeclineQuote(otherUser, inv.id)).rejects.toBeInstanceOf(ForbiddenError);
    await portalDeclineQuote(acmeUser, inv.id);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).state).toBe("DECLINED");
    await voidInvoice(tab, inv.id, "Client declined");
  });
});
