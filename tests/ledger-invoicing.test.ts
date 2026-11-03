import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { ForbiddenError } from "@/lib/auth/actor";
import { createClient } from "@/lib/services/clients";
import { accountBalance, categorizeBankTransaction, importBankCsv, ledgerFlags, postOpeningBalances, profitAndLoss, reconcileAccount, setupLedger, balanceSheet } from "@/lib/services/ledger";
import { addRule, closeChecklist, suggestCategories } from "@/lib/services/ledger-review";
import {
  addCustomer, addRecurringInvoice, createInvoice, generateRecurringDrafts, issueInvoice, linkStripeTestAccount, receivablesAging, recordInvoicePayment, stripeMode, voidInvoice,
} from "@/lib/services/client-invoicing";

// Fictional businesses, customers and amounts only. No Stripe calls are made.
beforeEach(async () => {
  await resetDb();
  delete process.env.STRIPE_SECRET_KEY;
});
afterEach(() => {
  delete process.env.STRIPE_SECRET_KEY;
});

async function setup() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const daria = await makeUser("STAFF", "Daria");
  const stranger = await makeUser("STAFF", "Stranger");
  const harbor = await createClient(tabitha, { businessName: "Harbor Example Co (fictional)", clientType: "BUSINESS", status: "ACTIVE", assignedToId: daria.id });
  const maple = await createClient(tabitha, { businessName: "Maple Example LLC (fictional)", clientType: "BUSINESS", status: "ACTIVE" });
  await setupLedger(daria, harbor.id, { basis: "CASH" });
  await setupLedger(tabitha, maple.id, { basis: "CASH" });
  const acct = async (clientId: string, code: string) => (await prisma.ledgerAccount.findFirstOrThrow({ where: { clientId, code } })).id;
  return { tabitha, daria, stranger, harbor, maple, acct };
}
const CSV = (rows: string[]) => ["Date,Description,Amount", ...rows].join("\n");

describe("Coetha groundwork: suggestions only", () => {
  it("suggests from staff rules (longest match) and consistent history; never posts and never guesses", async () => {
    const { daria, harbor, acct } = await setup();
    const [bank, software, fees, sales, meals] = [await acct(harbor.id, "1000"), await acct(harbor.id, "6600"), await acct(harbor.id, "6100"), await acct(harbor.id, "4000"), await acct(harbor.id, "6900")];
    await importBankCsv(daria, harbor.id, bank, { fileName: "jan.csv", text: CSV(["01/03/2026,PNC SERVICE CHARGE,-8.10", "01/04/2026,CLOVER SOFTWARE 123,-38.50", "01/06/2026,Corner Diner,-22.00", "01/07/2026,Corner Diner,-18.00"]) });
    await addRule(daria, harbor.id, { matchText: "clover", direction: "OUT", accountId: software });
    await addRule(daria, harbor.id, { matchText: "service charge", accountId: fees });
    await expect(addRule(daria, harbor.id, { matchText: "ab", accountId: fees })).rejects.toThrow(/at least 3/);
    const rows = await prisma.bankTransaction.findMany({ where: { accountId: bank }, orderBy: { date: "asc" } });
    let s = await suggestCategories(daria, harbor.id);
    expect(s.get(rows[0].id)).toMatchObject({ accountId: fees, source: "RULE" });
    expect(s.get(rows[1].id)).toMatchObject({ accountId: software, source: "RULE" });
    expect(s.has(rows[2].id)).toBe(false); // no rule, no history: no guess
    expect(await prisma.journalEntry.count()).toBe(0); // suggestions never post
    // Once staff post the diner as meals, the next identical row gets that suggestion.
    await categorizeBankTransaction(daria, harbor.id, rows[2].id, { accountId: meals });
    s = await suggestCategories(daria, harbor.id);
    expect(s.get(rows[3].id)).toMatchObject({ accountId: meals, source: "HISTORY" });
    await importBankCsv(daria, harbor.id, bank, { fileName: "feb.csv", text: CSV(["02/06/2026,Corner Diner,-25.00"]) });
    const feb = await prisma.bankTransaction.findFirstOrThrow({ where: { accountId: bank, date: new Date("2026-02-06T00:00:00Z") } });
    expect((await suggestCategories(daria, harbor.id)).get(feb.id)).toMatchObject({ accountId: meals, source: "HISTORY" });
    // Staff post the second visit differently: history now conflicts, so no suggestion is made.
    expect(sales).toBeTruthy();
    await categorizeBankTransaction(daria, harbor.id, rows[3].id, { accountId: await acct(harbor.id, "6000") });
    s = await suggestCategories(daria, harbor.id);
    expect(s.has(feb.id)).toBe(false);
  });

  it("the monthly close checklist reports what's missing and is ready only when everything checks out", async () => {
    const { daria, harbor, acct } = await setup();
    const [bank, sales, fees] = [await acct(harbor.id, "1000"), await acct(harbor.id, "4000"), await acct(harbor.id, "6100")];
    let c = await closeChecklist(daria, harbor.id, "2026-01");
    expect(c.readyForReview).toBe(false);
    expect(c.items.find((i) => i.key === "opening")!.ok).toBe(false);
    await postOpeningBalances(daria, harbor.id, { date: "2026-01-01", balances: [{ accountId: bank, amount: "1000" }] });
    await importBankCsv(daria, harbor.id, bank, { fileName: "jan.csv", text: CSV(["01/05/2026,Deposit,500", "01/31/2026,Fee,-8.10"]) });
    c = await closeChecklist(daria, harbor.id, "2026-01");
    expect(c.items.filter((i) => !i.ok).map((i) => i.label)).toEqual(expect.arrayContaining([expect.stringMatching(/every transaction reviewed/), expect.stringMatching(/reconciled/)]));
    const rows = await prisma.bankTransaction.findMany({ where: { accountId: bank }, orderBy: { date: "asc" } });
    await categorizeBankTransaction(daria, harbor.id, rows[0].id, { accountId: sales });
    await categorizeBankTransaction(daria, harbor.id, rows[1].id, { accountId: fees });
    await reconcileAccount(daria, harbor.id, bank, { statementDate: "2026-01-31", statementBalance: "1491.90" });
    c = await closeChecklist(daria, harbor.id, "2026-01");
    // Only the client's other default card account (no statement) is still open.
    expect(c.items.filter((i) => !i.ok).every((i) => i.label.startsWith("Business Credit Card"))).toBe(true);
  });
});

describe("Client Invoicing foundation", () => {
  it("Stripe is test mode only: live keys are refused; a client's own connected account is recorded once", async () => {
    const { daria, harbor, maple, tabitha } = await setup();
    expect(stripeMode({})).toBe("NOT_CONFIGURED");
    expect(stripeMode({ STRIPE_SECRET_KEY: "sk_live_abc" })).toBe("LIVE_BLOCKED");
    expect(stripeMode({ STRIPE_SECRET_KEY: "sk_test_abc" })).toBe("TEST");
    process.env.STRIPE_SECRET_KEY = "sk_live_fictional";
    await expect(linkStripeTestAccount(daria, harbor.id, "acct_FICTIONAL0001")).rejects.toThrow(/Live payments are turned off/);
    process.env.STRIPE_SECRET_KEY = "sk_test_fictional";
    const a = await linkStripeTestAccount(daria, harbor.id, "acct_FICTIONAL0001");
    expect(a.livemode).toBe(false);
    await expect(linkStripeTestAccount(tabitha, maple.id, "acct_FICTIONAL0001")).rejects.toThrow(/different client/);
  });

  it("issue → partial payment → paid: receivable, cash income, fee and receipts; a Stripe payout in the bank isn't counted twice", async () => {
    const { daria, harbor, acct } = await setup();
    process.env.STRIPE_SECRET_KEY = "sk_test_fictional";
    const [bank, sales, ar, clearing, fees] = [await acct(harbor.id, "1000"), await acct(harbor.id, "4000"), await acct(harbor.id, "1100"), await acct(harbor.id, "1200"), await acct(harbor.id, "6150")];
    const cust = await addCustomer(daria, harbor.id, { name: "Lakeside Example Store (fictional)", email: "ap@lakeside.example" });
    const inv = await createInvoice(daria, harbor.id, { customerId: cust.id, issueDate: "2026-03-01", dueDate: "2026-03-31", lines: [{ description: "Monthly service", quantity: 2, unitPrice: "250", incomeAccountId: sales }] });
    expect(inv).toMatchObject({ number: "INV-1001", status: "DRAFT", totalCents: 50000 });
    await expect(recordInvoicePayment(daria, harbor.id, inv.id, { amount: "100", receivedOn: "2026-03-05", method: "CHECK" })).rejects.toThrow(/Issue the invoice/);
    await issueInvoice(daria, harbor.id, inv.id);
    expect(await accountBalance(harbor.id, ar, "2026-03-31", "ACCRUAL")).toBe(50000);
    expect(await accountBalance(harbor.id, ar, "2026-03-31", "CASH")).toBe(0);

    const p1 = await recordInvoicePayment(daria, harbor.id, inv.id, { amount: "200", receivedOn: "2026-03-10", method: "CHECK", reference: "1042" });
    expect(p1.receiptNumber).toBe("R-0001");
    await expect(recordInvoicePayment(daria, harbor.id, inv.id, { amount: "400", receivedOn: "2026-03-11", method: "CHECK" })).rejects.toThrow(/more than/);
    const p2 = await recordInvoicePayment(daria, harbor.id, inv.id, { amount: "300", fee: "9.00", receivedOn: "2026-04-02", method: "STRIPE_TEST", stripePaymentIntentId: "pi_FICTIONAL00001" });
    expect(p2.receiptNumber).toBe("R-0002");
    expect((await prisma.clientInvoice.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe("PAID");
    await expect(recordInvoicePayment(daria, harbor.id, inv.id, { amount: "1", receivedOn: "2026-04-02", method: "STRIPE_TEST", stripePaymentIntentId: "pi_FICTIONAL00001" })).rejects.toThrow(/already recorded/);

    // Cash basis: income when paid; accrual: income when issued. Same totals over time.
    const cash = await profitAndLoss(daria, harbor.id, { from: "2026-03-01", to: "2026-04-30", basis: "CASH" });
    const accrual = await profitAndLoss(daria, harbor.id, { from: "2026-03-01", to: "2026-04-30", basis: "ACCRUAL" });
    expect(cash.income[0].months).toEqual([20000, 30000]);
    expect(accrual.income[0].months).toEqual([50000, 0]);
    expect(cash.expenses.find((r) => r.code === "6150")!.total).toBe(900);
    expect(await accountBalance(harbor.id, ar, "2026-04-30", "ACCRUAL")).toBe(0);

    // The bank shows the check deposit and Stripe's net payout; both go to Payments in Transit.
    await importBankCsv(daria, harbor.id, bank, { fileName: "apr.csv", text: CSV(["03/12/2026,Mobile deposit check 1042,200", "04/04/2026,STRIPE TRANSFER,291.00"]) });
    for (const t of await prisma.bankTransaction.findMany({ where: { accountId: bank } })) await categorizeBankTransaction(daria, harbor.id, t.id, { accountId: clearing });
    expect(await accountBalance(harbor.id, clearing, "2026-04-30")).toBe(0);
    expect(await accountBalance(harbor.id, bank, "2026-04-30")).toBe(49100);
    const after = await profitAndLoss(daria, harbor.id, { from: "2026-03-01", to: "2026-04-30", basis: "CASH" });
    expect(after.income[0].total).toBe(50000); // not 99,100
    expect((await balanceSheet(daria, harbor.id, { asOf: "2026-04-30", basis: "ACCRUAL" })).balanced).toBe(true);
    expect((await balanceSheet(daria, harbor.id, { asOf: "2026-04-30", basis: "CASH" })).balanced).toBe(true);
    expect(fees).toBeTruthy();
  });

  it("flags a Stripe payout posted to income (which would double it) and payments not yet seen in the bank", async () => {
    const { daria, harbor, acct } = await setup();
    const [bank, sales] = [await acct(harbor.id, "1000"), await acct(harbor.id, "4000")];
    const cust = await addCustomer(daria, harbor.id, { name: "Example Customer (fictional)" });
    const inv = await createInvoice(daria, harbor.id, { customerId: cust.id, issueDate: "2026-03-01", dueDate: "2026-03-15", lines: [{ description: "Work", unitPrice: "100", incomeAccountId: sales }] });
    await issueInvoice(daria, harbor.id, inv.id);
    await recordInvoicePayment(daria, harbor.id, inv.id, { amount: "100", receivedOn: "2026-03-02", method: "ACH" });
    let kinds = (await ledgerFlags(daria, harbor.id, "2026-04-01")).map((f) => f.kind);
    expect(kinds).toContain("UNDEPOSITED");
    await importBankCsv(daria, harbor.id, bank, { fileName: "m.csv", text: CSV(["03/04/2026,STRIPE PAYOUT,100"]) });
    const row = await prisma.bankTransaction.findFirstOrThrow({ where: { accountId: bank } });
    await categorizeBankTransaction(daria, harbor.id, row.id, { accountId: sales }); // the mistake
    kinds = (await ledgerFlags(daria, harbor.id, "2026-04-01")).map((f) => f.kind);
    expect(kinds).toContain("POSSIBLE_DUPLICATE_INCOME");
  });

  it("voids keep the invoice and reverse the receivable; paid invoices can't be voided; other clients' data is untouchable", async () => {
    const { daria, stranger, harbor, maple, acct } = await setup();
    const sales = await acct(harbor.id, "4000");
    const cust = await addCustomer(daria, harbor.id, { name: "Example Customer (fictional)" });
    const inv = await createInvoice(daria, harbor.id, { customerId: cust.id, issueDate: "2026-03-01", dueDate: "2026-03-15", lines: [{ description: "Work", unitPrice: "100", incomeAccountId: sales }] });
    await issueInvoice(daria, harbor.id, inv.id);
    await voidInvoice(daria, harbor.id, inv.id, { date: "2026-03-05", reason: "Billed the wrong customer" });
    expect(await prisma.clientInvoice.findUniqueOrThrow({ where: { id: inv.id } })).toMatchObject({ status: "VOID", voidReason: "Billed the wrong customer" });
    expect(await accountBalance(harbor.id, await acct(harbor.id, "1100"), "2026-03-31", "ACCRUAL")).toBe(0);
    const paid = await createInvoice(daria, harbor.id, { customerId: cust.id, issueDate: "2026-03-01", dueDate: "2026-03-15", lines: [{ description: "Work", unitPrice: "50", incomeAccountId: sales }] });
    await issueInvoice(daria, harbor.id, paid.id);
    await recordInvoicePayment(daria, harbor.id, paid.id, { amount: "50", receivedOn: "2026-03-03", method: "CASH" });
    await expect(voidInvoice(daria, harbor.id, paid.id, { date: "2026-03-05", reason: "Changed my mind" })).rejects.toThrow(/refund or credit/);
    // Isolation: another client's income account and another client's invoice are refused; unassigned staff are refused.
    const mapleSales = await acct(maple.id, "4000");
    await expect(createInvoice(daria, harbor.id, { customerId: cust.id, issueDate: "2026-03-01", dueDate: "2026-03-15", lines: [{ description: "x", unitPrice: "1", incomeAccountId: mapleSales }] })).rejects.toThrow(/income accounts/);
    await expect(issueInvoice(daria, maple.id, paid.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(receivablesAging(stranger, harbor.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("recurring invoices create one draft per period (never sent automatically) and receivables age correctly", async () => {
    const { daria, harbor, acct } = await setup();
    const sales = await acct(harbor.id, "4000");
    const cust = await addCustomer(daria, harbor.id, { name: "Example Tenant (fictional)" });
    await addRecurringInvoice(daria, harbor.id, { customerId: cust.id, cadence: "MONTHLY", startDate: "2026-01-31", dueDays: 10, lines: [{ description: "Monthly service", unitPrice: "300", incomeAccountId: sales }] });
    expect(await generateRecurringDrafts(daria, harbor.id, "2026-03-31")).toEqual(["INV-1001", "INV-1002", "INV-1003"]);
    expect(await generateRecurringDrafts(daria, harbor.id, "2026-03-31")).toEqual([]); // run again: nothing new
    const drafts = await prisma.clientInvoice.findMany({ where: { clientId: harbor.id }, orderBy: { number: "asc" } });
    expect(drafts.map((d) => d.issueDate.toISOString().slice(0, 10))).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
    expect(drafts.every((d) => d.status === "DRAFT")).toBe(true);
    for (const d of drafts.slice(0, 2)) await issueInvoice(daria, harbor.id, d.id);
    const aging = await receivablesAging(daria, harbor.id, "2026-04-15");
    expect(aging.rows.map((r) => [r.number, r.bucket])).toEqual([["INV-1001", "d61_90"], ["INV-1002", "d31_60"]]);
    expect(aging.totalCents).toBe(60000);
  });
});

describe("cash-basis client books stay separate", () => {
  it("one client's invoices, payments and bank rows never appear in another client's statements", async () => {
    const { tabitha, daria, harbor, maple, acct } = await setup();
    const cust = await addCustomer(daria, harbor.id, { name: "Example (fictional)" });
    const inv = await createInvoice(daria, harbor.id, { customerId: cust.id, issueDate: "2026-03-01", dueDate: "2026-03-15", lines: [{ description: "Work", unitPrice: "100", incomeAccountId: await acct(harbor.id, "4000") }] });
    await issueInvoice(daria, harbor.id, inv.id);
    await recordInvoicePayment(daria, harbor.id, inv.id, { amount: "100", receivedOn: "2026-03-02", method: "CASH" });
    const m = await profitAndLoss(tabitha, maple.id, { from: "2026-01-01", to: "2026-12-31" });
    expect(m.income).toEqual([]);
    expect(await prisma.journalEntry.count({ where: { clientId: maple.id } })).toBe(0);
  });
});
