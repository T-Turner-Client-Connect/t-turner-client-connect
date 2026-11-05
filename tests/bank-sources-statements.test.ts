import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ComponentProps, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { grantPerms, makeUser, managed, prisma, resetDb } from "./db";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import { createClient, ValidationError } from "@/lib/services/clients";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { encryptSecret } from "@/lib/crypto";
import { importBankCsv, setupLedger } from "@/lib/services/ledger";
import { recordBalance } from "@/lib/services/banking";
import { businessDashboardFor, portalBankFeed, portalBusinessDashboard } from "@/lib/services/portal-business";
import { portalDocuments } from "@/lib/services/documents";
import { hasBookkeepingService } from "@/lib/portal/access";
import { centralDay, createManualAccount, enterManualBalance, MANUAL_STALE_DAYS, morningPull, updateManualAccountLinks } from "@/lib/services/manual-bank";
import { fileStatement } from "@/lib/services/office-statements";
import { RepeatedSubmission } from "@/lib/services/office-actions";
import type { BankFeed } from "@/lib/services/bank-feed";
import { LiveBankCard, LiveBankKpi, LiveBankProvider, LiveBankTicker } from "@/components/portal/business-live";
import { BusinessDashboardView } from "@/components/portal/business-dashboard";

/**
 * Account-by-account balance sources (bank feed vs. our office), cash vs. credit, statements our
 * office files, one-time form keys, "Needs attention", and banking shown only for Bookkeeping
 * Clients. Plaid stays off: bank-feed rows are inserted directly (simulated). Fictional data only.
 */

let staff: Actor | null = null;
vi.mock("@/lib/auth/session", async (orig) => ({ ...(await orig<object>()), requireUser: async () => staff, getCurrentUser: async () => staff }));
const { default: PortalPreview } = await import("@/app/(app)/clients/[id]/portal-preview/page");

beforeEach(async () => {
  await resetDb();
  staff = null;
  vi.stubEnv("MALWARE_SCAN_URL", "https://scanner.test/scan");
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ clean: true }), { status: 200 }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const NOW = new Date();
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000);
let seq = 0;
const pdf = (tag = `${seq++}`) => new TextEncoder().encode(`%PDF-1.4\n% fictional statement ${tag}\n`);
const lastMonth = () => {
  const [y, m] = centralDay(NOW).split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return { ym: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`, y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 };
};

async function world(opts: { bookkeeping?: boolean } = {}) {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  staff = tabitha;
  const daria = await makeUser("STAFF", "Daria");
  const stranger = await makeUser("STAFF", "Stranger");
  const vic = await makeUser("STAFF", "Vic");
  await grantPerms(vic.id, ["banking.view"]);
  const bakery = await createClient(tabitha, { businessName: "Lakeside Pretend Bakery LLC", clientType: "BUSINESS", status: "ACTIVE", assignedToId: daria.id });
  const { token } = await invitePortalUser(tabitha, bakery.id, { email: "pat@fictional.example", name: "Pat Pretend", role: "OWNER" });
  const pat = await acceptPortalInvite(token!, "Pat-Strong-Pass-12345");
  await managed(bakery.id);
  if (opts.bookkeeping !== false) await prisma.bookkeepingProfile.create({ data: { clientId: bakery.id, accountingBasis: "CASH" } });
  await setupLedger(tabitha, bakery.id, { basis: "CASH" });
  const gl = async (code: string) => prisma.ledgerAccount.findFirstOrThrow({ where: { clientId: bakery.id, code } });
  return { tabitha, daria, stranger, vic, bakery, pat: { id: pat.id, name: pat.name, email: pat.email }, checking: await gl("1000"), cardGl: await gl("2100") };
}

/** A simulated bank-feed (Plaid) account — rows inserted directly; nothing calls Plaid. */
async function plaidAccount(w: Awaited<ReturnType<typeof world>>, a: { name: string; mask: string; type: "depository" | "credit"; cents: number; asOf?: Date; ledgerAccountId?: string | null; status?: string }) {
  seq++;
  const conn = await prisma.bankConnection.create({
    data: {
      clientId: w.bakery.id, itemId: `item-sim-${seq}`, accessTokenEnc: encryptSecret("access-sandbox-simulated"), institutionName: "Pretend National Bank", environment: "PRODUCTION", status: a.status ?? "ACTIVE",
      authorizedByName: "Fictional Owner", authorizationMethod: "CLIENT_PRESENT", consentVersion: "test", connectedById: w.tabitha.id, lastSuccessAt: a.asOf ?? new Date(),
      accounts: { create: [{ providerAccountId: `acc-${seq}`, name: a.name, mask: a.mask, type: a.type, subtype: a.type === "credit" ? "credit card" : "checking", ledgerAccountId: a.ledgerAccountId ?? null }] },
    },
    include: { accounts: true },
  });
  await recordBalance(conn.accounts[0].id, w.bakery.id, { currentBalanceCents: a.cents, availableBalanceCents: null, balanceAsOf: a.asOf ?? new Date() });
  return conn.accounts[0];
}

const wrap = (feed: BankFeed, child: ReactElement) => renderToStaticMarkup(createElement(LiveBankProvider, { account: "x", initial: feed, live: false } as ComponentProps<typeof LiveBankProvider>, child));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ");
function find(node: ReactNode, type: unknown): ReactElement<Record<string, unknown>> | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = find(n, type);
      if (hit) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  if (node.type === type) return node as ReactElement<Record<string, unknown>>;
  return find((node.props as { children?: ReactNode }).children, type);
}

describe("balance source, account by account", () => {
  it("a mixed business shows its bank-feed account and its office account, each once, cash apart from cards", async () => {
    const w = await world();
    await plaidAccount(w, { name: "Feed Checking", mask: "7777", type: "depository", cents: 400_000 });
    const sav = await createManualAccount(w.daria, w.bakery.id, { name: "Reserve savings", institution: "Credit Union of Pretend", last4: "2210", kind: "SAVINGS" });
    const card = await createManualAccount(w.daria, w.bakery.id, { name: "Business card", institution: "Fictional Card Co", last4: "1111", kind: "CREDIT_CARD" });
    await enterManualBalance(w.daria, w.bakery.id, { accountId: sav.id, amount: "5,000.00", asOf: hoursAgo(2) }, NOW);
    await enterManualBalance(w.daria, w.bakery.id, { accountId: card.id, amount: "912.40", asOf: hoursAgo(2) }, NOW);
    const feed = await portalBankFeed(w.pat, w.bakery.id);
    expect(feed.source).toBe("MIXED");
    expect(feed.accounts.map((a) => [a.name, a.source, a.kind])).toEqual([["Feed Checking", "PLAID", "CASH"], ["Reserve savings", "OFFICE", "CASH"], ["Business card", "OFFICE", "CREDIT"]]);
    // Cash in bank and cards owed are separate figures; the net is only for the ticker.
    expect(feed).toMatchObject({ cashCents: 900_000, creditCents: 91_240, netCents: 900_000 - 91_240 });
    const card$ = text(wrap(feed, createElement(LiveBankCard, { className: "", canRefresh: false })));
    expect(card$).toMatch(/Cash in bank \$9,000\.00/);
    expect(card$).toMatch(/Credit cards owed \$912\.40/);
    expect(card$).toContain("Updated by our office · as of");
    expect(card$).not.toContain("$8,087.60"); // never netted in the client card
    expect(text(wrap(feed, createElement(LiveBankKpi, { className: "" })))).toContain("$9,000.00");
    const ticker = text(wrap(feed, createElement(LiveBankTicker)));
    expect(ticker).toContain("Net, cash less cards owed: $8,087.60");
  });

  it("the same real account on both sources counts once: bank feed while current, ours otherwise or when set to Office-entered", async () => {
    const w = await world();
    const op = await createManualAccount(w.daria, w.bakery.id, { name: "Operating checking", institution: "Pretend National Bank", last4: "4094", kind: "CHECKING", ledgerAccountId: w.checking.id });
    await enterManualBalance(w.daria, w.bakery.id, { accountId: op.id, amount: "12,000.00", asOf: hoursAgo(3) }, NOW);
    const feedAcct = await plaidAccount(w, { name: "Feed Checking", mask: "4094", type: "depository", cents: 1_250_000, ledgerAccountId: w.checking.id });
    let feed = await portalBankFeed(w.pat, w.bakery.id);
    expect(feed.accounts.map((a) => [a.name, a.source])).toEqual([["Feed Checking", "PLAID"]]);
    expect(feed.cashCents).toBe(1_250_000);
    // The feed goes stale: our figure takes over (still once).
    await prisma.bankConnectionAccount.update({ where: { id: feedAcct.id }, data: { balanceAsOf: hoursAgo(72) } });
    feed = await portalBankFeed(w.pat, w.bakery.id);
    expect(feed.accounts.map((a) => [a.name, a.source])).toEqual([["Operating checking", "OFFICE"]]);
    expect(feed.cashCents).toBe(1_200_000);
    // Fresh again, but staff chose Office-entered for this account.
    await prisma.bankConnectionAccount.update({ where: { id: feedAcct.id }, data: { balanceAsOf: new Date() } });
    await updateManualAccountLinks(w.daria, w.bakery.id, op.id, { balanceSource: "OFFICE" });
    feed = await portalBankFeed(w.pat, w.bakery.id);
    expect(feed.accounts.map((a) => a.source)).toEqual(["OFFICE"]);
    await expect(updateManualAccountLinks(w.daria, w.bakery.id, op.id, { balanceSource: "PLAID_ONLY" })).rejects.toBeInstanceOf(ValidationError);
    await expect(updateManualAccountLinks(w.stranger, w.bakery.id, op.id, { balanceSource: "AUTO" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("matches the same institution and last 4 even without a GL link; a broken connection falls back to ours", async () => {
    const w = await world();
    const card = await createManualAccount(w.daria, w.bakery.id, { name: "Business card", institution: "Pretend National Bank", last4: "1111", kind: "CREDIT_CARD" });
    await enterManualBalance(w.daria, w.bakery.id, { accountId: card.id, amount: "500.00", asOf: hoursAgo(1) }, NOW);
    await plaidAccount(w, { name: "Feed Card", mask: "1111", type: "credit", cents: 64_000, status: "NEEDS_REAUTH" });
    const feed = await portalBankFeed(w.pat, w.bakery.id);
    expect(feed.accounts.map((a) => [a.name, a.source])).toEqual([["Business card", "OFFICE"]]);
    expect(feed).toMatchObject({ cashCents: null, creditCents: 50_000 });
  });
});

describe("banking information only for Bookkeeping Clients", () => {
  it("a Managed Business not on the list, a paused profile, or a sign-up choice never shows banking", async () => {
    const w = await world({ bookkeeping: false });
    const op = await createManualAccount(w.tabitha, w.bakery.id, { name: "Operating checking", kind: "CHECKING" });
    await enterManualBalance(w.tabitha, w.bakery.id, { accountId: op.id, amount: "1,000.00" }, NOW);
    await prisma.client.update({ where: { id: w.bakery.id }, data: { services: ["Bookkeeping"] } }); // picked at sign-up
    expect(hasBookkeepingService({ bookkeepingProfile: null })).toBe(false);
    expect(hasBookkeepingService({ bookkeepingProfile: { active: false } })).toBe(false);
    expect(hasBookkeepingService({ bookkeepingProfile: { active: true } })).toBe(true);
    // Managed Business only: the dashboard opens, with no banking at all.
    const d = await portalBusinessDashboard(w.pat, w.bakery.id);
    expect(d.feed).toBeNull();
    await expect(portalBankFeed(w.pat, w.bakery.id)).rejects.toBeInstanceOf(ForbiddenError);
    const html = renderToStaticMarkup(createElement(LiveBankProvider, { account: w.bakery.id, initial: d.feed, live: false } as ComponentProps<typeof LiveBankProvider>, createElement(LiveBankKpi, { className: "" }), createElement(LiveBankCard, { className: "", canRefresh: false }), createElement(LiveBankTicker)));
    expect(html).toBe("");
    // View as Client: the same.
    const tree = (await PortalPreview({ params: Promise.resolve({ id: w.bakery.id }), searchParams: Promise.resolve({}) })) as ReactNode;
    expect((find(tree, BusinessDashboardView)!.props as { d: Awaited<ReturnType<typeof businessDashboardFor>> }).d.feed).toBeNull();
    // On the list: shown. Paused: hidden again.
    await prisma.bookkeepingProfile.create({ data: { clientId: w.bakery.id, accountingBasis: "CASH" } });
    expect((await portalBankFeed(w.pat, w.bakery.id)).cashCents).toBe(100_000);
    await prisma.bookkeepingProfile.update({ where: { clientId: w.bakery.id }, data: { active: false } });
    await expect(portalBankFeed(w.pat, w.bakery.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await portalBusinessDashboard(w.pat, w.bakery.id)).feed).toBeNull();
    // Staff pages are unaffected: the morning pull still lists the business.
    expect((await morningPull(w.tabitha, NOW)).rows.some((r) => r.clientId === w.bakery.id)).toBe(true);
  });
});

describe("statements our office files", () => {
  it("files under the right client, account and period, staff-only, by who and when", async () => {
    const w = await world();
    const op = await createManualAccount(w.daria, w.bakery.id, { name: "Operating checking", last4: "4094", kind: "CHECKING", ledgerAccountId: w.checking.id });
    const reg = await prisma.bookkeepingAccount.create({ data: { clientId: w.bakery.id, institution: "Pretend National Bank", accountType: "CHECKING", last4: "4094", ledgerAccountId: w.checking.id } });
    const lm = lastMonth();
    const r = await fileStatement(w.daria, w.bakery.id, { manualAccountId: op.id, periodKind: "MONTH", month: lm.ym, bytes: pdf("a"), originalName: "statement.pdf" }, { now: NOW });
    expect(r.status).toBe("FILED");
    expect(r.document).toMatchObject({
      clientId: w.bakery.id, category: "BOOKKEEPING", docType: "BANK_STATEMENT", visibility: "STAFF_ONLY", publishedAt: null, scanStatus: "CLEAN",
      year: lm.y, month: lm.m, reportPeriodType: "MONTH", manualBankAccountId: op.id, bookkeepingAccountId: reg.id, uploadedByStaffId: w.daria.id,
    });
    expect(r.document.periodStart!.toISOString().slice(0, 10)).toBe(`${lm.ym}-01`);
    expect(await prisma.auditLog.count({ where: { action: "bookkeeping.statement_filed", actorId: w.daria.id } })).toBe(1);
    // Never reaches the client portal.
    expect(await portalDocuments(w.pat, w.bakery.id)).toEqual([]);
    // On file for that month on the morning page.
    const row = (await morningPull(w.daria, NOW)).rows.find((x) => x.manualAccountId === op.id)!;
    expect(row.statement).toMatchObject({ month: lm.ym, state: "ON_FILE", by: "Daria" });
    // The same file again for the same account and period: nothing new.
    const again = await fileStatement(w.daria, w.bakery.id, { manualAccountId: op.id, periodKind: "MONTH", month: lm.ym, bytes: pdf("a"), originalName: "statement-copy.pdf" }, { now: NOW });
    expect(again.status).toBe("ALREADY_ON_FILE");
    expect(await prisma.document.count({ where: { manualBankAccountId: op.id } })).toBe(1);
    // A card account files as a card statement; a quarter is filed by its last month.
    const card = await createManualAccount(w.daria, w.bakery.id, { name: "Business card", kind: "CREDIT_CARD" });
    const q = await fileStatement(w.daria, w.bakery.id, { manualAccountId: card.id, periodKind: "QUARTER", month: "2026-09", bytes: pdf("q3"), originalName: "q3.pdf" }, { now: NOW });
    expect(q.document).toMatchObject({ docType: "CARD_STATEMENT", reportPeriodType: "QUARTER", year: 2026, month: 9 });
    expect(q.document.periodStart!.toISOString().slice(0, 10)).toBe("2026-07-01");
    await expect(fileStatement(w.daria, w.bakery.id, { manualAccountId: card.id, periodKind: "QUARTER", month: "2026-08", bytes: pdf(), originalName: "x.pdf" }, { now: NOW })).rejects.toBeInstanceOf(ValidationError);
    await expect(fileStatement(w.daria, w.bakery.id, { manualAccountId: card.id, periodKind: "MONTH", month: lm.ym, bytes: new TextEncoder().encode("not a pdf"), originalName: "x.pdf" }, { now: NOW })).rejects.toThrow(/PDF/);
  });

  it("an unscanned statement doesn't count as on file; staff without Banking → Edit can't file", async () => {
    const w = await world();
    vi.unstubAllEnvs(); // no scanner configured: the upload stays NOT_SCANNED
    const op = await createManualAccount(w.daria, w.bakery.id, { name: "Operating checking", kind: "CHECKING" });
    const lm = lastMonth();
    const r = await fileStatement(w.daria, w.bakery.id, { manualAccountId: op.id, periodKind: "MONTH", month: lm.ym, bytes: pdf(), originalName: "s.pdf" }, { now: NOW });
    expect(r.document.scanStatus).toBe("NOT_SCANNED");
    const row = (await morningPull(w.daria, NOW)).rows.find((x) => x.manualAccountId === op.id)!;
    expect(row.statement.state).toBe("WAITING_SCAN");
    for (const who of [w.stranger, w.vic]) {
      await expect(fileStatement(who, w.bakery.id, { manualAccountId: op.id, periodKind: "MONTH", month: lm.ym, bytes: pdf(), originalName: "s.pdf" }, { now: NOW })).rejects.toBeInstanceOf(ForbiddenError);
    }
    // An unlinked GL account row: its office account is created and the statement filed on it.
    const viaGl = await fileStatement(w.daria, w.bakery.id, { ledgerAccountId: w.cardGl.id, periodKind: "MONTH", month: lm.ym, bytes: pdf(), originalName: "card.pdf" }, { now: NOW });
    expect(viaGl.account.ledgerAccountId).toBe(w.cardGl.id);
  });
});

describe("a double-click can't save twice", () => {
  it("entering a balance, importing a file and filing a statement with the same form key run once", async () => {
    const w = await world();
    const op = await createManualAccount(w.daria, w.bakery.id, { name: "Operating checking", kind: "CHECKING", ledgerAccountId: w.checking.id });
    const k1 = "form-key-balance-0001";
    await enterManualBalance(w.daria, w.bakery.id, { accountId: op.id, amount: "100.00" }, NOW, { idempotencyKey: k1 });
    await expect(enterManualBalance(w.daria, w.bakery.id, { accountId: op.id, amount: "100.00" }, NOW, { idempotencyKey: k1 })).rejects.toBeInstanceOf(RepeatedSubmission);
    expect(await prisma.manualBankBalance.count()).toBe(1);
    // A failed attempt releases the key, so fixing the typo and resending works.
    const k2 = "form-key-balance-0002";
    await expect(enterManualBalance(w.daria, w.bakery.id, { accountId: op.id, amount: "abc" }, NOW, { idempotencyKey: k2 })).rejects.toBeInstanceOf(ValidationError);
    await enterManualBalance(w.daria, w.bakery.id, { accountId: op.id, amount: "101.00" }, NOW, { idempotencyKey: k2 });
    expect(await prisma.manualBankBalance.count()).toBe(2);

    const csv = "Date,Description,Amount\n11/02/2026,Card deposits,300.00\n";
    const k3 = "form-key-import-0001";
    await importBankCsv(w.daria, w.bakery.id, w.checking.id, { fileName: "a.csv", text: csv }, { idempotencyKey: k3 });
    await expect(importBankCsv(w.daria, w.bakery.id, w.checking.id, { fileName: "a.csv", text: csv }, { idempotencyKey: k3 })).rejects.toBeInstanceOf(RepeatedSubmission);
    expect(await prisma.bankImport.count()).toBe(1);

    const k4 = "form-key-statement-0001";
    const lm = lastMonth();
    await fileStatement(w.daria, w.bakery.id, { manualAccountId: op.id, periodKind: "MONTH", month: lm.ym, bytes: pdf("k4"), originalName: "s.pdf" }, { idempotencyKey: k4, now: NOW });
    await expect(fileStatement(w.daria, w.bakery.id, { manualAccountId: op.id, periodKind: "MONTH", month: lm.ym, bytes: pdf("k4"), originalName: "s.pdf" }, { idempotencyKey: k4, now: NOW })).rejects.toBeInstanceOf(RepeatedSubmission);
    expect(await prisma.document.count({ where: { manualBankAccountId: op.id } })).toBe(1);
  });
});

describe("Morning bank pull: done only when today's work happened", () => {
  it(`an old balance (older than ${MANUAL_STALE_DAYS} days) needs attention, even if typed in today; a current one entered today is done`, async () => {
    const w = await world();
    const a = await createManualAccount(w.daria, w.bakery.id, { name: "Old checking", kind: "CHECKING" });
    const b = await createManualAccount(w.daria, w.bakery.id, { name: "Typed old today", kind: "SAVINGS" });
    const c = await createManualAccount(w.daria, w.bakery.id, { name: "Current today", kind: "CHECKING" });
    await enterManualBalance(w.daria, w.bakery.id, { accountId: a.id, amount: "10.00", asOf: hoursAgo(24 * 9) }, NOW);
    await prisma.manualBankBalance.updateMany({ where: { accountId: a.id }, data: { enteredAt: hoursAgo(24 * 9) } }); // entered back then
    await enterManualBalance(w.daria, w.bakery.id, { accountId: b.id, amount: "20.00", asOf: hoursAgo(24 * 9) }, NOW); // e.g. "as of Oct 27", entered today
    await enterManualBalance(w.daria, w.bakery.id, { accountId: c.id, amount: "30.00", asOf: hoursAgo(1) }, NOW);
    const p = await morningPull(w.daria, NOW);
    const st = (id: string) => p.rows.find((r) => r.manualAccountId === id)!.status;
    expect(st(a.id)).toMatchObject({ state: "NEEDS_ATTENTION", lastBalance: { balanceCents: 1000 } });
    expect(st(b.id)).toMatchObject({ state: "NEEDS_ATTENTION", by: "Daria" });
    expect(st(c.id)).toMatchObject({ state: "DONE_BALANCE" });
    expect(p.done).toBe(1);
    // Needs attention first, done today last.
    expect(p.rows.at(-1)!.manualAccountId).toBe(c.id);
    expect(["NEEDS_ATTENTION", "PROBLEM"]).toContain(p.rows[0].status.state);
  });
});
