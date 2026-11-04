import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { createClient } from "@/lib/services/clients";
import { saveProfile } from "@/lib/services/bookkeeping-clients";
import { setupLedger } from "@/lib/services/ledger";
import { completeBankLink, startBankLink, syncConnection } from "@/lib/services/banking";
import { monitorConnectionAccount, prepareReconciliation, registerAccount } from "@/lib/services/bank-accounts";
import { runWorkflowMonitor } from "@/lib/services/monthly-workflow";
import { optionalProducts } from "@/lib/plaid";

/**
 * Plaid Statements and Liabilities (simulated Plaid; fictional data). Both stay off unless their
 * flag is set; when on, Link asks for consent, statements are filed instead of requested, and the
 * card issuer's last statement balance feeds the reconciliation.
 */

const calls: { path: string; body: Record<string, unknown> }[] = [];
const PDF = new TextEncoder().encode("%PDF-1.4\n% fictional statement from the bank\n");

beforeEach(async () => {
  await resetDb();
  calls.length = 0;
  process.env.PLAID_CLIENT_ID = "fictional-client-id";
  process.env.PLAID_SECRET = "fictional-sandbox-secret";
  process.env.PLAID_ENV = "sandbox";
  process.env.APP_URL = "https://clientconnect.example";
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const u = new URL(url);
    if (u.host !== "sandbox.plaid.com") throw new Error(`Unexpected host: ${url}`);
    const body = JSON.parse(String(init.body));
    calls.push({ path: u.pathname, body });
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    switch (u.pathname) {
      case "/link/token/create": return json({ link_token: "link-sandbox-fictional", expiration: "2026-11-05T00:00:00Z" });
      case "/item/public_token/exchange": return json({ access_token: "access-sandbox-fictional", item_id: "item-fictional" });
      case "/accounts/get": return json({ accounts: [{ account_id: "p-chk", name: "Operating", mask: "0042", type: "depository", subtype: "checking" }, { account_id: "p-card", name: "Pretend Card", mask: "7001", type: "credit", subtype: "credit card" }], item: {} });
      case "/transactions/sync": return json({ added: [], modified: [], removed: [], next_cursor: "c-1", has_more: false });
      case "/statements/list": return json({ accounts: [{ account_id: "p-chk", account_mask: "0042", statements: [{ statement_id: "st-oct", month: 10, year: 2026, date_posted: "2026-11-02" }] }] });
      case "/statements/download": return new Response(PDF, { status: 200, headers: { "Content-Type": "application/pdf" } });
      case "/liabilities/get": return json({ accounts: [], liabilities: { credit: [{ account_id: "p-card", aprs: [{ apr_percentage: 21.99, apr_type: "purchase_apr" }], is_overdue: true, last_statement_balance: 642.18, last_statement_issue_date: "2026-10-31", minimum_payment_amount: 35, next_payment_due_date: "2026-11-25" }], mortgage: null, student: null } });
      default: return new Response(JSON.stringify({ error_code: "NOT_FOUND" }), { status: 404 });
    }
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ["PLAID_CLIENT_ID", "PLAID_SECRET", "PLAID_ENV", "APP_URL", "PLAID_STATEMENTS_ENABLED", "PLAID_LIABILITIES_ENABLED"]) delete process.env[k];
});

async function world() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const daria = await makeUser("STAFF", "Daria");
  const biz = await createClient(tabitha, { businessName: "Lakeside Pretend Bakery LLC", clientType: "BUSINESS", status: "ACTIVE", assignedToId: daria.id });
  await saveProfile(tabitha, biz.id, { active: true, frequency: "MONTHLY", payroll: false });
  await setupLedger(daria, biz.id, { basis: "CASH" });
  const chk = await registerAccount(daria, biz.id, { institution: "Pretend National Bank", accountType: "CHECKING", last4: "0042" });
  const card = await registerAccount(daria, biz.id, { institution: "Pretend Card Co", accountType: "CREDIT_CARD", last4: "7001", openingBalance: "500.00", openingBalanceDate: "2026-09-30" });
  const conn = await completeBankLink(daria, biz.id, { publicToken: "tok", authorizedByName: "Pat Pretend", authorizationMethod: "CLIENT_PRESENT", institutionName: "Pretend National Bank", confirmed: true });
  await monitorConnectionAccount(daria, biz.id, conn.accounts.find((a) => a.mask === "0042")!.id, chk.id);
  await monitorConnectionAccount(daria, biz.id, conn.accounts.find((a) => a.mask === "7001")!.id, card.id);
  return { tabitha, daria, biz, chk, card, conn };
}

describe("off by default", () => {
  it("Link asks only for Transactions, and no Statements or Liabilities call is made", async () => {
    const w = await world();
    await startBankLink(w.daria, w.biz.id);
    expect(calls.find((c) => c.path === "/link/token/create")!.body).toMatchObject({ products: ["transactions"] });
    expect(calls.find((c) => c.path === "/link/token/create")!.body.additional_consented_products).toBeUndefined();
    await syncConnection(w.conn.id, "MANUAL", w.daria);
    await runWorkflowMonitor(null, w.biz.id, 2026, 10, { today: "2026-11-04" });
    expect(calls.some((c) => c.path.startsWith("/statements") || c.path === "/liabilities/get")).toBe(false);
    expect(await prisma.documentRequest.count({ where: { clientId: w.biz.id, kind: "STATEMENT" } })).toBe(2); // requested from the client instead
  });
});

describe("when Tabitha enables them", () => {
  it("Link adds consent for the enabled products only", () => {
    expect(optionalProducts({ PLAID_STATEMENTS_ENABLED: "true" }, new Date("2026-11-04T12:00:00Z"))).toEqual({ additional_consented_products: ["statements"], statements: { start_date: "2025-11-04", end_date: "2026-11-04" } });
    expect(optionalProducts({ PLAID_LIABILITIES_ENABLED: "true" })).toEqual({ additional_consented_products: ["liabilities"] });
    expect(optionalProducts({})).toEqual({});
  });

  it("Statements: the bank's statement is filed for the account and month, so it isn't requested", async () => {
    process.env.PLAID_STATEMENTS_ENABLED = "true";
    const w = await world();
    await runWorkflowMonitor(null, w.biz.id, 2026, 10, { today: "2026-11-04" });
    expect(calls.filter((c) => c.path === "/statements/download").map((c) => c.body.statement_id)).toEqual(["st-oct"]);
    expect(await prisma.document.count({ where: { clientId: w.biz.id, bookkeepingAccountId: w.chk.id, docType: "BANK_STATEMENT", visibility: "STAFF_ONLY" } })).toBe(1);
    const reqs = await prisma.documentRequest.findMany({ where: { clientId: w.biz.id, kind: "STATEMENT" } });
    expect(reqs.map((r) => r.bookkeepingAccountId)).toEqual([w.card.id]); // the card's statement isn't available from the bank: requested
    expect(await prisma.auditLog.count({ where: { action: "coetha.statement_retrieved" } })).toBe(1);
  });

  it("Liabilities: APR, minimum payment, due date and last statement are stored; the statement balance feeds the reconciliation; overdue is flagged", async () => {
    process.env.PLAID_LIABILITIES_ENABLED = "true";
    const w = await world();
    await syncConnection(w.conn.id, "MANUAL", w.daria);
    const ca = await prisma.bankConnectionAccount.findFirstOrThrow({ where: { connectionId: w.conn.id, mask: "7001" } });
    expect(ca).toMatchObject({ aprPercent: 21.99, minimumPaymentCents: 3500, lastStatementBalanceCents: 64218, liabilityOverdue: true });
    expect(ca.nextPaymentDueDate!.toISOString().slice(0, 10)).toBe("2026-11-25");
    const rec = await prepareReconciliation(w.biz.id, w.card.id, 2026, 10, { today: "2026-11-04" });
    expect(rec).toMatchObject({ endingBalanceCents: 64218, balanceSource: "PLAID_LIABILITIES", beginningBalanceCents: 50000 });
    expect(rec!.exceptions.join(" ")).toMatch(/payment as overdue/);
    // The card's statement balance is known, so Coetha doesn't ask the client for it.
    await runWorkflowMonitor(null, w.biz.id, 2026, 10, { today: "2026-11-04" });
    expect(await prisma.documentRequest.count({ where: { clientId: w.biz.id, kind: "STATEMENT", bookkeepingAccountId: w.card.id } })).toBe(0);
  });

  it("production still needs Tabitha's live switch: no product call while it's off", async () => {
    process.env.PLAID_LIABILITIES_ENABLED = "true";
    const w = await world();
    process.env.PLAID_ENV = "production";
    calls.length = 0;
    await expect(syncConnection(w.conn.id, "MANUAL", w.daria)).rejects.toThrow();
    expect(calls.length).toBe(0);
  });
});
