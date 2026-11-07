import { beforeEach, describe, expect, it, vi } from "vitest";
import { type ComponentProps, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { grantPerms, makeUser, managed, prisma, resetDb, showOfficeBalancesToClients } from "./db";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import { createClient, ValidationError } from "@/lib/services/clients";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { encryptSecret } from "@/lib/crypto";
import { setupLedger } from "@/lib/services/ledger";
import { recordBalance } from "@/lib/services/banking";
import { businessDashboardFor, portalBankFeed, portalBusinessDashboard } from "@/lib/services/portal-business";
import {
  archiveManualAccount, clientManualBalances, createManualAccount, enterManualBalance, enterManualBalances, firmManualBalanceSheet, manualAccountsForStaff, MANUAL_STALE_DAYS, validLast4,
} from "@/lib/services/manual-bank";
import type { BankFeed } from "@/lib/services/bank-feed";
import { LiveBankCard, LiveBankKpi, LiveBankProvider } from "@/components/portal/business-live";
import { BusinessDashboardView } from "@/components/portal/business-dashboard";

/**
 * Balances entered by our office (until Plaid is live): staff enter each account's balance on the
 * Banking page; the client's dashboard shows the cash total as "Updated by our office". Fictional data only.
 */

let staff: Actor | null = null;
vi.mock("@/lib/auth/session", async (orig) => ({ ...(await orig<object>()), requireUser: async () => staff, getCurrentUser: async () => staff }));
// View as Client is the client's own portal under a signed preview cookie (see tests/vac-harness.ts).
vi.mock("next/headers", async () => (await import("./vac-harness")).headersMock);
const { h } = await import("./vac-harness");
const { previewCookieValue, previewLogins, VAC_COOKIE } = await import("@/lib/portal/viewer");
const { default: PortalHome } = await import("@/app/client/(secure)/page");
/** View as Client of a client's Home (its primary owner login, as the start route picks), for the signed-in staff member. */
async function PortalPreview({ params }: { params: Promise<{ id: string }>; searchParams?: unknown }) {
  const { id } = await params;
  h.jar.clear();
  h.jar.set(VAC_COOKIE, previewCookieValue({ staffId: staff!.id, clientId: id, loginId: (await previewLogins(id))[0]?.id ?? null }));
  return PortalHome({ searchParams: Promise.resolve({ account: id }) });
}

beforeEach(async () => {
  await resetDb();
  h.jar.clear();
  staff = null;
});

const NOW = new Date();
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000);
const NOTE = "Office-only note: checked through delegated access";

async function world() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  staff = tabitha;
  const daria = await makeUser("STAFF", "Daria"); // assigned to the bakery
  const bea = await makeUser("STAFF", "Bea"); // Banking → Edit, not assigned
  const vic = await makeUser("STAFF", "Vic"); // Banking → View only
  const stranger = await makeUser("STAFF", "Stranger");
  await grantPerms(bea.id, ["banking.edit"]);
  await grantPerms(vic.id, ["banking.view"]);
  const bakery = await createClient(tabitha, { businessName: "Lakeside Pretend Bakery LLC", clientType: "BUSINESS", status: "ACTIVE", assignedToId: daria.id });
  const other = await createClient(tabitha, { businessName: "Other Fictional Hauling LLC", clientType: "BUSINESS", status: "ACTIVE", assignedToId: tabitha.id });
  const { token } = await invitePortalUser(tabitha, bakery.id, { email: "pat@fictional.example", name: "Pat Pretend", role: "OWNER" });
  const pat = await acceptPortalInvite(token!, "Pat-Strong-Pass-12345");
  const { token: t2 } = await invitePortalUser(tabitha, other.id, { email: "sam@fictional.example", name: "Sam Sample", role: "OWNER" });
  const sam = await acceptPortalInvite(t2!, "Sam-Strong-Pass-12345");
  await managed(bakery.id, other.id);
  // managed() puts both on the Bookkeeping Clients list (banking information is shown only for those).
  for (const c of [bakery, other]) await prisma.bookkeepingProfile.update({ where: { clientId: c.id }, data: { accountingBasis: "CASH" } });
  return { tabitha, daria, bea, vic, stranger, bakery, other, pat: { id: pat.id, name: pat.name, email: pat.email }, sam: { id: sam.id, name: sam.name, email: sam.email } };
}

/** The bakery's three fictional accounts: two cash accounts and a card (never counted as cash). */
async function bakeryAccounts(w: Awaited<ReturnType<typeof world>>) {
  const chk = await createManualAccount(w.daria, w.bakery.id, { name: "Operating checking", institution: "Pretend National Bank", last4: "4094", kind: "CHECKING" });
  const sav = await createManualAccount(w.daria, w.bakery.id, { name: "Reserve savings", institution: "Pretend National Bank", last4: "", kind: "SAVINGS" });
  const card = await createManualAccount(w.daria, w.bakery.id, { name: "Business card", institution: "Fictional Card Co", last4: "1111", kind: "CREDIT_CARD" });
  await enterManualBalance(w.daria, w.bakery.id, { accountId: chk.id, amount: "12,480.55", asOf: hoursAgo(2), note: NOTE }, NOW);
  await enterManualBalance(w.daria, w.bakery.id, { accountId: sav.id, amount: "5,000.00", asOf: hoursAgo(3) }, NOW);
  await enterManualBalance(w.daria, w.bakery.id, { accountId: card.id, amount: "900.00", asOf: hoursAgo(3) }, NOW);
  return { chk, sav, card };
}

const kpi = (feed: BankFeed) => renderToStaticMarkup(createElement(LiveBankProvider, { account: "x", initial: feed, live: false } as ComponentProps<typeof LiveBankProvider>, createElement(LiveBankKpi, { className: "" })));
const cardHtml = (feed: BankFeed) => renderToStaticMarkup(createElement(LiveBankProvider, { account: "x", initial: feed, live: false } as ComponentProps<typeof LiveBankProvider>, createElement(LiveBankCard, { className: "", canRefresh: true })));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ");

/** A fictional connected Plaid bank, inserted directly (as the office's connection would leave it). */
async function connectPlaid(tabitha: Actor, clientId: string, balanceCents: number) {
  await setupLedger(tabitha, clientId, { basis: "CASH" });
  const checking = await prisma.ledgerAccount.findFirstOrThrow({ where: { clientId, code: "1000" } });
  const conn = await prisma.bankConnection.create({
    data: {
      clientId, itemId: `item-${clientId}`, accessTokenEnc: encryptSecret("access-sandbox-fictional"), institutionName: "Plaid Fictional Bank", environment: "PRODUCTION",
      authorizedByName: "Fictional Owner", authorizationMethod: "CLIENT_PRESENT", consentVersion: "test", connectedById: tabitha.id, lastSuccessAt: new Date(),
      accounts: { create: [{ providerAccountId: "acc-chk", name: "Plaid Checking", mask: "7777", type: "depository", subtype: "checking", ledgerAccountId: checking.id }] },
    },
    include: { accounts: true },
  });
  await recordBalance(conn.accounts[0].id, clientId, { currentBalanceCents: balanceCents, availableBalanceCents: balanceCents, balanceAsOf: new Date() });
}

describe("staff: accounts and balances", () => {
  it("the assigned staff member and staff with Banking → Edit can add accounts and enter balances; every write is audited", async () => {
    const w = await world();
    const { chk } = await bakeryAccounts(w);
    const byBea = await createManualAccount(w.bea, w.bakery.id, { name: "Payroll checking", institution: "Pretend National Bank", last4: "2020", kind: "CHECKING" });
    await enterManualBalance(w.bea, w.bakery.id, { accountId: byBea.id, amount: "-45.10", asOf: hoursAgo(1) }, NOW); // overdrawn is allowed
    const rows = await manualAccountsForStaff(w.vic, w.bakery.id); // View is enough to read
    expect(rows.map((r) => r.name)).toEqual(["Operating checking", "Reserve savings", "Business card", "Payroll checking"]);
    const op = rows.find((r) => r.id === chk.id)!;
    expect(op.latest).toMatchObject({ balanceCents: 1_248_055, enteredBy: "Daria", note: NOTE });
    expect(rows.find((r) => r.id === byBea.id)!.latest).toMatchObject({ balanceCents: -4510, enteredBy: "Bea" });
    const log = await prisma.auditLog.findMany({ where: { clientId: w.bakery.id, action: { startsWith: "banking.manual_" } } });
    expect(log.filter((l) => l.action === "banking.manual_account_create")).toHaveLength(4);
    expect(log.filter((l) => l.action === "banking.manual_balance_enter")).toHaveLength(4);
    // Amounts and notes are not copied into the audit log.
    expect(JSON.stringify(log)).not.toContain("Office-only");
    await archiveManualAccount(w.bea, w.bakery.id, byBea.id);
    expect(await prisma.auditLog.count({ where: { clientId: w.bakery.id, action: "banking.manual_account_archive", actorId: w.bea.id } })).toBe(1);
    // Archived accounts stop counting, but keep their history.
    expect((await clientManualBalances(w.bakery.id)).map((a) => a.name)).not.toContain("Payroll checking");
    expect(await prisma.manualBankBalance.count({ where: { accountId: byBea.id } })).toBe(1);
    await expect(enterManualBalance(w.bea, w.bakery.id, { accountId: byBea.id, amount: "10" }, NOW)).rejects.toBeInstanceOf(ValidationError);
  });

  it("staff without Banking → Edit (or with View only) are refused, and nothing is written", async () => {
    const w = await world();
    const { chk } = await bakeryAccounts(w);
    for (const who of [w.stranger, w.vic]) {
      await expect(createManualAccount(who, w.bakery.id, { name: "Sneaky", kind: "CHECKING" })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(enterManualBalance(who, w.bakery.id, { accountId: chk.id, amount: "1.00" }, NOW)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(archiveManualAccount(who, w.bakery.id, chk.id)).rejects.toBeInstanceOf(ForbiddenError);
    }
    await expect(manualAccountsForStaff(w.stranger, w.bakery.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await prisma.manualBankAccount.count()).toBe(3);
    expect(await prisma.manualBankBalance.count()).toBe(3);
    // An account of another business can't be reached through this business.
    await expect(enterManualBalance(w.tabitha, w.other.id, { accountId: chk.id, amount: "1.00" }, NOW)).rejects.toBeInstanceOf(ValidationError);
  });

  it("history is append-only: a correction is a new row and the earlier entry is unchanged", async () => {
    const w = await world();
    const { chk } = await bakeryAccounts(w);
    const first = await prisma.manualBankBalance.findFirstOrThrow({ where: { accountId: chk.id } });
    await enterManualBalance(w.daria, w.bakery.id, { accountId: chk.id, amount: "12,840.55", asOf: first.asOf, note: "typo", correctsId: first.id }, NOW);
    const all = await prisma.manualBankBalance.findMany({ where: { accountId: chk.id }, orderBy: { enteredAt: "asc" } });
    expect(all).toHaveLength(2);
    expect(all[0]).toEqual(first); // never edited
    expect(all[1]).toMatchObject({ balanceCents: 1_284_055, correctsId: first.id });
    expect((await manualAccountsForStaff(w.daria, w.bakery.id)).find((r) => r.id === chk.id)!.latest!.balanceCents).toBe(1_284_055);
    expect((await clientManualBalances(w.bakery.id)).find((a) => a.id === chk.id)!.balanceCents).toBe(1_284_055);
    expect(await prisma.auditLog.count({ where: { action: "banking.manual_balance_correct" } })).toBe(1);
    // A correction points only at an entry of the same account.
    const other = await createManualAccount(w.tabitha, w.other.id, { name: "Hauling checking", kind: "CHECKING" });
    await expect(enterManualBalance(w.tabitha, w.other.id, { accountId: other.id, amount: "1", correctsId: first.id }, NOW)).rejects.toBeInstanceOf(ValidationError);
    // A later entry is the current figure.
    await enterManualBalance(w.daria, w.bakery.id, { accountId: chk.id, amount: "13,000", asOf: hoursAgo(1) }, NOW);
    expect((await clientManualBalances(w.bakery.id)).find((a) => a.id === chk.id)!.balanceCents).toBe(1_300_000);
    expect(await prisma.manualBankBalance.count({ where: { accountId: chk.id } })).toBe(3);
  });

  it("last 4 must be exactly four digits; a full account number is refused, never trimmed", async () => {
    const w = await world();
    expect(validLast4("4094")).toBe("4094");
    expect(validLast4("")).toBeNull();
    for (const bad of ["123456789", "12345", "4094 1234 5678 9012", "12a4", "123"]) {
      expect(() => validLast4(bad)).toThrow(ValidationError);
      await expect(createManualAccount(w.daria, w.bakery.id, { name: "Checking", kind: "CHECKING", last4: bad })).rejects.toBeInstanceOf(ValidationError);
    }
    // Credentials or full numbers in the name or institution are refused too.
    await expect(createManualAccount(w.daria, w.bakery.id, { name: "Checking password hunter2", kind: "CHECKING" })).rejects.toBeInstanceOf(ValidationError);
    await expect(createManualAccount(w.daria, w.bakery.id, { name: "Checking 000123456789", kind: "CHECKING" })).rejects.toBeInstanceOf(ValidationError);
    await expect(createManualAccount(w.daria, w.bakery.id, { name: "Checking", kind: "BROKERAGE" })).rejects.toBeInstanceOf(ValidationError);
    expect(await prisma.manualBankAccount.count()).toBe(0);
    // The database refuses it as well.
    await expect(prisma.manualBankAccount.create({ data: { clientId: w.bakery.id, name: "Direct", kind: "CHECKING", last4: "123456789", createdById: w.daria.id } })).rejects.toThrow();
  });

  it("amounts and as-of times are validated on the server", async () => {
    const w = await world();
    const { chk } = await bakeryAccounts(w);
    for (const amount of ["", "abc", "1.234", "99999999999"]) await expect(enterManualBalance(w.daria, w.bakery.id, { accountId: chk.id, amount }, NOW)).rejects.toBeInstanceOf(ValidationError);
    await expect(enterManualBalance(w.daria, w.bakery.id, { accountId: chk.id, amount: "1", asOf: hoursAgo(-2) }, NOW)).rejects.toThrow(/future/);
    await expect(enterManualBalance(w.daria, w.bakery.id, { accountId: chk.id, amount: "1", note: "username is pat123" }, NOW)).rejects.toBeInstanceOf(ValidationError);
    // As-of defaults to now.
    const b = await enterManualBalance(w.daria, w.bakery.id, { accountId: chk.id, amount: "(25.00)" }, NOW);
    expect(b).toMatchObject({ balanceCents: -2500, asOf: NOW });
  });

  it("Enter today's balances: only businesses the staff member may edit; every entry is checked before any is saved", async () => {
    const w = await world();
    const { chk, sav } = await bakeryAccounts(w);
    const haul = await createManualAccount(w.tabitha, w.other.id, { name: "Hauling checking", kind: "CHECKING" });
    expect((await firmManualBalanceSheet(w.daria)).map((c) => c.name)).toEqual(["Lakeside Pretend Bakery LLC"]); // assigned only
    expect((await firmManualBalanceSheet(w.bea)).map((c) => c.name)).toEqual(["Lakeside Pretend Bakery LLC", "Other Fictional Hauling LLC"]);
    expect(await firmManualBalanceSheet(w.vic)).toEqual([]);
    // Daria may not enter the hauling company's balance: nothing in the batch is saved.
    await expect(enterManualBalances(w.daria, [
      { clientId: w.bakery.id, accountId: chk.id, amount: "100" },
      { clientId: w.other.id, accountId: haul.id, amount: "200" },
    ], NOW)).rejects.toBeInstanceOf(ForbiddenError);
    // One bad amount: nothing saved either.
    await expect(enterManualBalances(w.bea, [
      { clientId: w.bakery.id, accountId: chk.id, amount: "100" },
      { clientId: w.bakery.id, accountId: sav.id, amount: "oops" },
    ], NOW)).rejects.toBeInstanceOf(ValidationError);
    expect(await prisma.manualBankBalance.count()).toBe(3);
    const rows = await enterManualBalances(w.bea, [
      { clientId: w.bakery.id, accountId: chk.id, amount: "100" },
      { clientId: w.other.id, accountId: haul.id, amount: "200" },
    ], NOW);
    expect(rows).toHaveLength(2);
    expect(await prisma.auditLog.count({ where: { action: "banking.manual_balance_enter", actorId: w.bea.id } })).toBe(2);
  });
});

describe("client dashboard: Bank Balance from our office", () => {
  beforeEach(showOfficeBalancesToClients);
  it("shows the cash total with (N Accounts) and 'Updated by our office · as of', never 'live', never notes", async () => {
    const w = await world();
    await bakeryAccounts(w);
    const d = await portalBusinessDashboard(w.pat, w.bakery.id);
    if (!d.feed) throw new Error("expected a bank feed");
    expect(d.feed).toMatchObject({ source: "MANUAL", connected: false, stale: false, transactions: [] });
    expect(d.feed.accounts.map((a) => [a.name, a.kind, a.currentCents])).toEqual([["Operating checking", "CASH", 1_248_055], ["Reserve savings", "CASH", 500_000], ["Business card", "CREDIT", 90_000]]);
    expect(d.feed.netCents).toBe(1_248_055 + 500_000 - 90_000);
    const html = kpi(d.feed);
    expect(html).toContain("(2 Accounts)");
    expect(html).toContain("$17,480.55"); // checking + savings; the card is owed, not cash
    expect(text(html)).toMatch(/Updated by our office · as of [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} [AP]M/);
    expect(html).not.toMatch(/live/i);
    expect(html).not.toContain("Bank feed being set up");
    const c = text(cardHtml(d.feed));
    expect(c).toContain("Updated by our office");
    expect(c).toContain("Operating checking ••4094");
    expect(c).not.toMatch(/\blive\b/i);
    expect(c).not.toContain("Refresh now");
    // Notes, who entered it and the history never reach the client.
    const payload = JSON.stringify(d) + JSON.stringify(await portalBankFeed(w.pat, w.bakery.id));
    expect(payload).not.toContain("Office-only");
    expect(payload).not.toContain("Daria");
    expect(payload).not.toContain("enteredBy");
    expect(payload).not.toMatch(/"note"/);
  });

  it(`is labeled "Not current" once the newest balance is older than ${MANUAL_STALE_DAYS} days`, async () => {
    const w = await world();
    const chk = await createManualAccount(w.daria, w.bakery.id, { name: "Operating checking", kind: "CHECKING" });
    await enterManualBalance(w.daria, w.bakery.id, { accountId: chk.id, amount: "800", asOf: hoursAgo(24 * MANUAL_STALE_DAYS - 1) }, NOW);
    expect((await portalBankFeed(w.pat, w.bakery.id)).stale).toBe(false);
    await prisma.manualBankBalance.deleteMany(); // test reset only — the app never deletes
    await enterManualBalance(w.daria, w.bakery.id, { accountId: chk.id, amount: "800", asOf: hoursAgo(24 * MANUAL_STALE_DAYS + 1) }, NOW);
    const feed = await portalBankFeed(w.pat, w.bakery.id);
    expect(feed.stale).toBe(true);
    const t = text(kpi(feed));
    expect(t).toMatch(/Not current · as of [A-Z][a-z]{2} \d{1,2}, \d{4}/);
    expect(t).not.toContain("Updated by our office");
    expect(text(cardHtml(feed))).toContain("Not current: our office last updated these balances");
  });

  it("a Plaid connection for a different account doesn't hide the office's accounts", async () => {
    const w = await world();
    await bakeryAccounts(w);
    await connectPlaid(w.tabitha, w.bakery.id, 333_300);
    const feed = await portalBankFeed(w.pat, w.bakery.id);
    expect(feed).toMatchObject({ source: "MIXED", connected: true, cashCents: 333_300 + 1_248_055 + 500_000, creditCents: 90_000 });
    expect(feed.accounts.map((a) => [a.name, a.source])).toEqual([["Plaid Checking", "PLAID"], ["Operating checking", "OFFICE"], ["Reserve savings", "OFFICE"], ["Business card", "OFFICE"]]);
    expect(text(kpi(feed))).toContain("includes balances updated by our office");
  });

  it("another business's balances never appear, and its owner can't read this business's", async () => {
    const w = await world();
    await bakeryAccounts(w);
    const haul = await createManualAccount(w.tabitha, w.other.id, { name: "Hauling checking", kind: "CHECKING", last4: "8080" });
    await enterManualBalance(w.tabitha, w.other.id, { accountId: haul.id, amount: "777.77", note: "hauling secret note" }, NOW);
    const bakeryFeed = await portalBankFeed(w.pat, w.bakery.id);
    expect(JSON.stringify(bakeryFeed)).not.toContain("Hauling");
    expect(JSON.stringify(bakeryFeed)).not.toContain("77777");
    const haulFeed = await portalBankFeed(w.sam, w.other.id);
    expect(haulFeed.accounts.map((a) => a.name)).toEqual(["Hauling checking"]);
    expect(JSON.stringify(haulFeed)).not.toContain("hauling secret note");
    await expect(portalBankFeed(w.sam, w.bakery.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(portalBankFeed(w.pat, w.other.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(portalBusinessDashboard(w.sam, w.bakery.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("View as Client shows the same Bank Balance (and no notes)", async () => {
    const w = await world();
    await bakeryAccounts(w);
    staff = w.tabitha;
    const tree = (await PortalPreview({ params: Promise.resolve({ id: w.bakery.id }), searchParams: Promise.resolve({}) })) as ReactNode;
    const dash = find(tree, BusinessDashboardView);
    expect(dash).not.toBeNull();
    const d = (dash!.props as { d: Awaited<ReturnType<typeof businessDashboardFor>> }).d;
    if (!d.feed) throw new Error("expected a bank feed");
    expect(d.feed).toMatchObject({ source: "MANUAL", netCents: 1_658_055 });
    expect(JSON.stringify(d)).not.toContain("Office-only");
    expect(text(kpi(d.feed))).toContain("Updated by our office");
  });
});

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

describe('owner switch "Show office-entered bank balances to clients" (off by default)', () => {
  const OFFICE_FIGURES = [/1248055/, /12,480\.55/, /Operating checking/, /Reserve savings/, /Business card/, /Updated by our office/];

  it("off by default: no client response (dashboard, bank API, refresh, View as Client) carries office-entered balances; staff still see them", async () => {
    const w = await world();
    await bakeryAccounts(w);
    expect(await prisma.integrationSettings.findUnique({ where: { id: "default" } })).toBeNull(); // never set = off
    const { ownerSwitches } = await import("@/lib/services/owner-switches");
    expect((await ownerSwitches()).clientBankBalances.on).toBe(false);

    // Bookkeeping client: server responses, not just the screen.
    const dash = await portalBusinessDashboard(w.pat, w.bakery.id);
    const api = await portalBankFeed(w.pat, w.bakery.id); // what /api/client/.../bank returns
    expect(api.accounts).toEqual([]);
    expect(api.source).toBe("NONE");
    expect([api.cashCents ?? 0, api.creditCents ?? 0, api.netCents ?? 0]).toEqual([0, 0, 0]);
    for (const payload of [JSON.stringify(dash), JSON.stringify(api)]) for (const re of OFFICE_FIGURES) expect(payload).not.toMatch(re);
    expect(text(kpi(api))).not.toContain("Updated by our office");
    // "Refresh now" can't reveal them either (it returns the same feed; live banking is off so it's refused first).
    const { portalRefreshBank } = await import("@/lib/services/portal-business");
    await expect(portalRefreshBank(w.pat, w.bakery.id)).rejects.toThrow(/isn't turned on/);

    // View as Client (the owner's preview) matches what the client gets.
    staff = w.tabitha;
    const tree = (await PortalPreview({ params: Promise.resolve({ id: w.bakery.id }), searchParams: Promise.resolve({}) })) as ReactNode;
    const preview = (find(tree, BusinessDashboardView)!.props as { d: Awaited<ReturnType<typeof businessDashboardFor>> }).d;
    for (const re of OFFICE_FIGURES) expect(JSON.stringify(preview)).not.toMatch(re);

    // Staff with banking access keep the whole workflow: accounts, latest balances and history.
    for (const who of [w.tabitha, w.daria, w.vic]) {
      const rows = await manualAccountsForStaff(who, w.bakery.id);
      expect(rows.map((r) => r.name).sort()).toEqual(["Business card", "Operating checking", "Reserve savings"]);
      expect(rows.find((r) => r.name === "Operating checking")!.latest).toMatchObject({ balanceCents: 1_248_055, source: "STAFF_ENTRY" });
    }
    // Staff without banking access still can't.
    await expect(manualAccountsForStaff(w.stranger, w.bakery.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("only the primary owner can change it; every change is in both audit logs; it takes effect on the server immediately", async () => {
    const w = await world();
    await bakeryAccounts(w);
    const { setOwnerSwitch } = await import("@/lib/services/owner-switches");
    const otherAdmin = await makeUser("ADMIN", "Other Admin");
    for (const who of [w.daria, w.bea, w.vic, w.stranger, otherAdmin]) await expect(setOwnerSwitch(who, "clientBankBalances", true)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await portalBankFeed(w.pat, w.bakery.id)).accounts).toEqual([]);

    await setOwnerSwitch(w.tabitha, "clientBankBalances", true);
    const on = await portalBankFeed(w.pat, w.bakery.id);
    expect(on.accounts.map((a) => [a.name, a.source])).toEqual([["Operating checking", "OFFICE"], ["Reserve savings", "OFFICE"], ["Business card", "OFFICE"]]);
    expect(text(kpi(on))).toMatch(/Updated by our office · as of /); // distinguished from a live bank balance, with its as-of date

    await setOwnerSwitch(w.tabitha, "clientBankBalances", false);
    expect((await portalBankFeed(w.pat, w.bakery.id)).accounts).toEqual([]);

    const logs = await prisma.auditLog.findMany({ where: { action: { startsWith: "banking.client_balances_visible" } }, orderBy: { createdAt: "asc" } });
    expect(logs.map((l) => [l.action, l.actorId])).toEqual([["banking.client_balances_visible_on", w.tabitha.id], ["banking.client_balances_visible_off", w.tabitha.id]]);
    expect(await prisma.ownerAuditLog.count({ where: { action: { startsWith: "banking.client_balances_visible" }, actorId: w.tabitha.id } })).toBe(2);
    const s = await prisma.integrationSettings.findUniqueOrThrow({ where: { id: "default" } });
    expect([s.clientBankBalancesVisible, s.clientBankBalancesChangedById]).toEqual([false, w.tabitha.id]);
  });

  it("even when on: another business's owner can't read them, and nothing is sent to anyone", async () => {
    const w = await world();
    await bakeryAccounts(w);
    const { setOwnerSwitch } = await import("@/lib/services/owner-switches");
    const before = await Promise.all([prisma.notification.count(), prisma.message.count()]);
    await setOwnerSwitch(w.tabitha, "clientBankBalances", true);
    await expect(portalBankFeed(w.sam, w.bakery.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await portalBankFeed(w.sam, w.other.id)).accounts).toEqual([]);
    await enterManualBalance(w.daria, w.bakery.id, { accountId: (await clientManualBalances(w.bakery.id))[0].id, amount: "100.00", asOf: hoursAgo(1) }, NOW);
    expect(await Promise.all([prisma.notification.count(), prisma.message.count()])).toEqual(before);
    // Plaid stays off: live bank connections are a different switch, untouched.
    const { ownerSwitches } = await import("@/lib/services/owner-switches");
    expect((await ownerSwitches()).liveBanking.on).toBe(false);
  });
});
