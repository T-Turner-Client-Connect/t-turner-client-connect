import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { ForbiddenError } from "@/lib/auth/actor";
import { createClient } from "@/lib/services/clients";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { saveFeeSetting } from "@/lib/services/service-agreements";
import { createQuote, offerQuote } from "@/lib/services/owner-billing";
import { PROPOSED_LATE_FEE } from "@/lib/billing/installment-plan";
import {
  acceptPlan, approvePlan, chargeAllowed, chooseInvoiceMethod, decideMethodChange, declinePlan, lateFeePolicy, planOptions, planProgress, recordCardAuthorization, recordPlanPayment,
  requestPlan, saveLateFeePolicy, waiveFee,
} from "@/lib/services/installment-plans";

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
  const delegate = await makeUser("ADMIN", "Billing Delegate");
  await prisma.ownerAccess.create({ data: { userId: delegate.id, scope: "BILLING" } });
  const jane = await createClient(tabitha, { firstName: "Jane", lastName: "Williams", clientType: "INDIVIDUAL", status: "ACTIVE", email: "jane@fictional.example" });
  const omar = await createClient(tabitha, { firstName: "Omar", lastName: "Other", clientType: "INDIVIDUAL", status: "ACTIVE", email: "omar@fictional.example" });
  const login = async (clientId: string, email: string) => {
    const { token } = await invitePortalUser(tabitha, clientId, { email, name: email, role: "OWNER" });
    const u = await acceptPortalInvite(token!, "Portal-Pass-123456");
    return { id: u.id, name: u.name, email: u.email };
  };
  await saveFeeSetting(tabitha, { method: "CARD_CREDIT", enabled: true, percentBps: 350, flatCents: 0, verifiedNote: "Fictional test: processor and card-network rules checked; credit only" });
  return { tabitha, daria, delegate, jane, omar, janeLogin: await login(jane.id, "jane@fictional.example"), omarLogin: await login(omar.id, "omar@fictional.example") };
}

describe("in-house plan workflow", () => {
  it("client sees only qualifying terms; requests need an amount set by the office; terms are server-computed and accepted exactly", async () => {
    const { tabitha, daria, jane, janeLogin, omarLogin } = await setup();
    expect((await planOptions(250_000, "CARD_CREDIT")).map((o) => [o.months, o.feeCents, o.totalCents, o.depositCents])).toEqual([[2, 7_500, 257_500, 77_250], [3, 7_500, 257_500, 77_250]]);
    expect((await planOptions(200_000, "CARD_CREDIT")).map((o) => o.months)).toEqual([2]);
    // The client can't invent an amount.
    await expect(requestPlan({ portal: janeLogin }, { clientId: jane.id, title: "x", serviceCents: 1, months: 2, card: "CARD_CREDIT" })).rejects.toBeInstanceOf(ForbiddenError);
    // From an invoice: the amount comes from the invoice, whatever the request says.
    const q = await createQuote(tabitha, { clientId: jane.id, title: "2026 Nonprofit formation", issueDate: "2026-11-02", dueDate: "2026-11-30", lines: [{ service: "Formation", quantity: 1, unitCents: 250_000 }], allowFull: true, allowPlan: false, depositType: "NONE", depositValue: 0, discountType: "NONE", discountValue: 0, discountCoversPlanFee: false, taxRateBps: 0, planInstallments: 3, planFirstDueDate: null, planIntervalMonths: 1, planFeeOverride: null } as never);
    await offerQuote(tabitha, q.id);
    await expect(requestPlan({ portal: janeLogin }, { clientId: jane.id, title: "x", serviceCents: 1, months: 4, card: "CARD_CREDIT", invoiceId: q.id })).rejects.toThrow(/isn't available/);
    const plan = await requestPlan({ portal: janeLogin }, { clientId: jane.id, title: "x", serviceCents: 1, months: 3, card: "CARD_CREDIT", invoiceId: q.id });
    expect([plan.serviceCents, plan.feeCents, plan.totalCents, plan.depositCents, plan.status]).toEqual([250_000, 7_500, 257_500, 77_250, "REQUESTED"]);
    expect((plan.schedule as { amountCents: number }[]).map((i) => i.amountCents)).toEqual([60_083, 60_083, 60_084]);
    await expect(requestPlan({ portal: janeLogin }, { clientId: jane.id, title: "x", serviceCents: 1, months: 2, card: "CARD_CREDIT", invoiceId: q.id })).rejects.toThrow(/already open/);
    // Another client can't see or accept it; tampered terms or an unticked box are refused.
    await expect(acceptPlan(omarLogin, { planId: plan.id, termsHash: plan.termsHash, agreed: true, name: "Omar Other" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(acceptPlan(janeLogin, { planId: plan.id, termsHash: "tampered", agreed: true, name: "Jane Williams" })).rejects.toThrow(/changed/);
    await expect(acceptPlan(janeLogin, { planId: plan.id, termsHash: plan.termsHash, agreed: false, name: "Jane Williams" })).rejects.toThrow(/Check the box/);
    await prisma.installmentPlan.update({ where: { id: plan.id }, data: { totalCents: 1 } }); // a direct database change doesn't alter what was agreed
    expect((await prisma.installmentPlan.findUniqueOrThrow({ where: { id: plan.id } })).termsHash).toBe(plan.termsHash);
    await prisma.installmentPlan.update({ where: { id: plan.id }, data: { totalCents: plan.totalCents } });
    // Staff can't approve; approval before acceptance is refused.
    await expect(approvePlan(daria, plan.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(approvePlan(tabitha, plan.id)).rejects.toThrow(/hasn't accepted/);
    await acceptPlan(janeLogin, { planId: plan.id, termsHash: plan.termsHash, agreed: true, name: "Jane Williams", ip: "203.0.113.9" });
    expect((await prisma.installmentPlan.findUniqueOrThrow({ where: { id: plan.id } })).status).toBe("PENDING_APPROVAL");
  });

  it("only the owner approves; no charge without acceptance, approval and a card on file; a debit card can't carry the credit fee", async () => {
    const { tabitha, daria, delegate, jane, janeLogin } = await setup();
    const plan = await requestPlan({ staff: daria }, { clientId: jane.id, title: "Formation", serviceCents: 250_000, months: 3, card: "CARD_CREDIT" });
    expect(chargeAllowed(plan)).toMatchObject({ ok: false, reason: expect.stringMatching(/hasn't accepted/) });
    await acceptPlan(janeLogin, { planId: plan.id, termsHash: plan.termsHash, agreed: true, name: "Jane Williams" });
    await expect(approvePlan(delegate, plan.id)).rejects.toBeInstanceOf(ForbiddenError); // billing-only access can't approve
    await approvePlan(tabitha, plan.id);
    let p = await prisma.installmentPlan.findUniqueOrThrow({ where: { id: plan.id } });
    expect([p.status, chargeAllowed(p).ok, chargeAllowed(p).reason]).toEqual(["APPROVED", false, "No card-on-file authorization."]);
    await expect(recordCardAuthorization(plan.id, { reference: "ccof:fictional", cardType: "DEBIT" })).rejects.toThrow(/re-quoted for a debit card/);
    await recordCardAuthorization(plan.id, { reference: "ccof:fictional", cardType: "CREDIT" });
    p = await prisma.installmentPlan.findUniqueOrThrow({ where: { id: plan.id } });
    expect([p.status, chargeAllowed(p).ok, p.cardAuthorizationRef]).toEqual(["DEPOSIT_PENDING", true, "ccof:fictional"]);
    expect(await prisma.ownerAuditLog.count({ where: { entityId: plan.id } })).toBe(4); // requested, accepted, approved, card authorized
    expect(await prisma.auditLog.count({ where: { entityId: plan.id } })).toBe(0); // owner financials stay out of the shared log
  });

  it("declines with a reason; tracks deposit, partial payments, past due and paid in full; never over-collects", async () => {
    const { tabitha, daria, jane, janeLogin } = await setup();
    const other = await requestPlan({ staff: daria }, { clientId: jane.id, title: "Other", serviceCents: 100_000, months: 2, card: "CARD_DEBIT" });
    await expect(declinePlan(tabitha, other.id, "")).rejects.toThrow(/reason/);
    await declinePlan(tabitha, other.id, "Please pay in full for this service.");

    const plan = await requestPlan({ staff: daria }, { clientId: jane.id, title: "Formation", serviceCents: 250_000, months: 3, card: "CARD_DEBIT" });
    expect([plan.feeCents, plan.totalCents, plan.depositCents]).toEqual([0, 250_000, 75_000]); // debit: no fee
    await acceptPlan(janeLogin, { planId: plan.id, termsHash: plan.termsHash, agreed: true, name: "Jane Williams" });
    await approvePlan(tabitha, plan.id);
    await expect(recordPlanPayment(daria, plan.id, 75_000, "x")).rejects.toBeInstanceOf(ForbiddenError);
    await recordPlanPayment(tabitha, plan.id, 75_000, "Deposit by card");
    let p = await prisma.installmentPlan.findUniqueOrThrow({ where: { id: plan.id } });
    expect(p.status).toBe("ACTIVE");
    const firstDue = (p.schedule as { dueDate: string }[])[0].dueDate;
    const late = planProgress(p, firstDue.replace(/-(\d\d)$/, (_, d) => `-${String(Number(d) + 1).padStart(2, "0")}`), PROPOSED_LATE_FEE);
    expect([late.status, late.overdueCents, late.lateFeesCents]).toEqual(["PAST_DUE", 58_333, 0]); // late fees off
    await recordPlanPayment(tabitha, plan.id, 30_000, "Partial");
    p = await prisma.installmentPlan.findUniqueOrThrow({ where: { id: plan.id } });
    expect(planProgress(p, "2026-01-01", PROPOSED_LATE_FEE).rows.map((r) => [r.label, r.paidCents, r.unpaidCents])).toEqual([["Deposit", 75_000, 0], ["Installment 1", 30_000, 28_333], ["Installment 2", 0, 58_333], ["Installment 3", 0, 58_334]]);
    await expect(recordPlanPayment(tabitha, plan.id, 200_000, "too much")).rejects.toThrow(/remaining balance \(\$1,450\.00\)/);
    await recordPlanPayment(tabitha, plan.id, 145_000, "Rest");
    expect((await prisma.installmentPlan.findUniqueOrThrow({ where: { id: plan.id } })).status).toBe("PAID_IN_FULL");
  });
});

describe("late fees, waivers and payment methods", () => {
  it("late-fee policy is stored disabled; only the owner changes it, and turning it on needs a recorded legal review", async () => {
    const { tabitha, daria, jane } = await setup();
    expect((await lateFeePolicy()).enabled).toBe(false);
    const on = { enabled: true, graceDays: 5, periodDays: 5, rateBps: 1_000, capBps: null };
    await expect(saveLateFeePolicy(daria, on)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(saveLateFeePolicy(tabitha, on)).rejects.toThrow(/legal review/);
    await saveLateFeePolicy(tabitha, { ...on, enabled: false, capBps: 2_000 });
    expect(await lateFeePolicy()).toMatchObject({ enabled: false, capBps: 2_000 });
    await expect(waiveFee(daria, { clientId: jane.id, amountCents: 100, reason: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    await waiveFee(tabitha, { clientId: jane.id, amountCents: 6_000, reason: "First late payment" });
    expect(await prisma.feeWaiver.count()).toBe(1);
  });

  it("one payment method per invoice; later changes wait for the owner's approval and are logged", async () => {
    const { tabitha, daria, jane, janeLogin, omarLogin } = await setup();
    const q = await createQuote(tabitha, { clientId: jane.id, title: "Bookkeeping", issueDate: "2026-11-02", dueDate: "2026-11-30", lines: [{ service: "Monthly bookkeeping", quantity: 1, unitCents: 30_000 }], allowFull: true, allowPlan: false, depositType: "NONE", depositValue: 0, discountType: "NONE", discountValue: 0, discountCoversPlanFee: false, taxRateBps: 0, planInstallments: 3, planFirstDueDate: null, planIntervalMonths: 1, planFeeOverride: null } as never);
    await offerQuote(tabitha, q.id);
    await expect(chooseInvoiceMethod({ portal: omarLogin }, q.id, "ZELLE")).rejects.toBeInstanceOf(ForbiddenError);
    expect(await chooseInvoiceMethod({ portal: janeLogin }, q.id, "ZELLE")).toEqual({ changed: true, pending: false });
    expect(await chooseInvoiceMethod({ portal: janeLogin }, q.id, "CASH_APP", "Easier for me")).toEqual({ changed: false, pending: true });
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: q.id } })).paymentMethod).toBe("ZELLE"); // unchanged until approved
    await expect(chooseInvoiceMethod({ portal: janeLogin }, q.id, "VENMO")).rejects.toThrow(/already waiting/);
    const change = await prisma.paymentMethodChange.findFirstOrThrow({ where: { invoiceId: q.id } });
    await expect(decideMethodChange(daria, change.id, true)).rejects.toBeInstanceOf(ForbiddenError);
    await decideMethodChange(tabitha, change.id, true, "OK");
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: q.id } })).paymentMethod).toBe("CASH_APP");
    expect(await prisma.ownerAuditLog.count({ where: { action: { in: ["billing.method_selected", "billing.method_change_approved"] } } })).toBe(2);
  });
});
