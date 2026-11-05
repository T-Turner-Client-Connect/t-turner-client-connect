import { beforeEach, describe, expect, it } from "vitest";
import { type ComponentProps, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { grantPerms, makeUser, managed, prisma, resetDb } from "./db";
import { ForbiddenError } from "@/lib/auth/actor";
import { createClient, ValidationError } from "@/lib/services/clients";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { importBankCsv, newestBalance, parseBankCsv, setupLedger } from "@/lib/services/ledger";
import { portalBankFeed } from "@/lib/services/portal-business";
import { centralDay, createManualAccount, endOfDayCentral, enterManualBalance, morningImport, morningPull, updateManualAccountLinks, validSignInUrl } from "@/lib/services/manual-bank";
import { chicagoLocalToUtc } from "@/lib/tz";
import type { BankFeed } from "@/lib/services/bank-feed";
import { LiveBankKpi, LiveBankProvider } from "@/components/portal/business-live";

/**
 * The morning routine: a bank CSV's running balance becomes the "Updated by our office" balance,
 * and the Morning bank pull page's rows, status and imports. Fictional data only.
 */

beforeEach(resetDb);

const NOW = new Date();
/** MM/DD/YYYY, n days before today in Central time. */
const us = (daysAgo: number) => {
  const [y, m, d] = centralDay(new Date(NOW.getTime() - daysAgo * 86_400_000)).split("-");
  return `${m}/${d}/${y}`;
};
const ymd = (daysAgo: number) => centralDay(new Date(NOW.getTime() - daysAgo * 86_400_000));
const CSV = (rows: string[], head = "Date,Description,Amount,Running Balance") => [head, ...rows].join("\n");

async function world() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const daria = await makeUser("STAFF", "Daria");
  const bea = await makeUser("STAFF", "Bea");
  const stranger = await makeUser("STAFF", "Stranger");
  await grantPerms(bea.id, ["banking.edit"]);
  const bakery = await createClient(tabitha, { businessName: "Lakeside Pretend Bakery LLC", clientType: "BUSINESS", status: "ACTIVE", assignedToId: daria.id });
  const other = await createClient(tabitha, { businessName: "Other Fictional Hauling LLC", clientType: "BUSINESS", status: "ACTIVE", assignedToId: tabitha.id });
  const { token } = await invitePortalUser(tabitha, bakery.id, { email: "pat@fictional.example", name: "Pat Pretend", role: "OWNER" });
  const pat = await acceptPortalInvite(token!, "Pat-Strong-Pass-12345");
  await managed(bakery.id, other.id);
  for (const c of [bakery, other]) await prisma.bookkeepingProfile.create({ data: { clientId: c.id, accountingBasis: "CASH" } });
  await setupLedger(daria, bakery.id, { basis: "CASH" });
  await setupLedger(tabitha, other.id, { basis: "CASH" });
  const checking = await prisma.ledgerAccount.findFirstOrThrow({ where: { clientId: bakery.id, code: "1000" } });
  return { tabitha, daria, bea, stranger, bakery, other, checking, pat: { id: pat.id, name: pat.name, email: pat.email } };
}
const kpi = (feed: BankFeed) => renderToStaticMarkup(createElement(LiveBankProvider, { account: "x", initial: feed, live: false } as ComponentProps<typeof LiveBankProvider>, createElement(LiveBankKpi, { className: "" })));

describe("bank CSV running balance", () => {
  it("detects an optional balance column and keeps the old behavior without one", () => {
    for (const h of ["Balance", "Running Balance", "available balance", "LEDGER BALANCE"]) {
      const p = parseBankCsv(`Date,Description,Amount,${h}\n01/05/2026,Coffee,-4.50,"1,995.50"\n`);
      expect(p.hasBalance).toBe(true);
      expect(p.rows[0]).toEqual({ date: "2026-01-05", amountCents: -450, description: "Coffee", balanceCents: 199_550 });
    }
    // Debit/credit files too; the balance column is never mistaken for an amount.
    const dc = parseBankCsv("Posting Date,Payee,Debit,Credit,Balance\n01/08/2026,Rent,950.00,,50.00\n01/09/2026,Client payment,,2500.00,2550.00\n");
    expect(dc.rows.map((r) => [r.amountCents, r.balanceCents])).toEqual([[-95000, 5000], [250000, 255000]]);
    // Prefers the running balance over the available balance.
    expect(parseBankCsv("Date,Description,Amount,Available Balance,Balance\n01/05/2026,Fee,-1,10.00,20.00\n").rows[0].balanceCents).toBe(2000);
    const plain = parseBankCsv("Date,Description,Amount\n01/05/2026,Coffee,-4.50\n");
    expect(plain.hasBalance).toBe(false);
    expect(plain.rows[0]).toStrictEqual({ date: "2026-01-05", amountCents: -450, description: "Coffee" });
    // An unreadable balance never stops the row.
    expect(parseBankCsv("Date,Description,Amount,Balance\n01/05/2026,Coffee,-4.50,n/a\n").rows[0]).toMatchObject({ amountCents: -450, balanceCents: null });
  });

  it("picks the row last in time: oldest-first or newest-first; refuses to guess otherwise", () => {
    const r = (date: string, bal: number) => ({ date, amountCents: 1, description: "x", balanceCents: bal });
    expect(newestBalance([r("2026-11-01", 100), r("2026-11-02", 200), r("2026-11-02", 250)])).toEqual({ status: "OK", date: "2026-11-02", balanceCents: 250 });
    expect(newestBalance([r("2026-11-02", 250), r("2026-11-02", 200), r("2026-11-01", 100)])).toEqual({ status: "OK", date: "2026-11-02", balanceCents: 250 });
    expect(newestBalance([r("2026-11-02", 1), r("2026-11-02", 2)])).toMatchObject({ status: "AMBIGUOUS", reason: expect.stringContaining("Couldn't tell which balance is newest") });
    expect(newestBalance([r("2026-11-01", 1), r("2026-11-03", 2), r("2026-11-02", 3)])).toMatchObject({ status: "AMBIGUOUS" });
    expect(newestBalance([r("2026-11-02", 7)])).toEqual({ status: "OK", date: "2026-11-02", balanceCents: 7 });
  });

  it("oldest-first file: records the newest balance (BANK_FILE, end of that day in Central time) and the client sees it", async () => {
    const w = await world();
    const r = await importBankCsv(w.daria, w.bakery.id, w.checking.id, { fileName: "pretend-bank-yesterday.csv", text: CSV([`${us(2)},Card deposits,500.00,"10,500.00"`, `${us(1)},Flour supplier,-120.00,"10,380.00"`, `${us(1)},Card deposits,300.00,"10,680.00"`]) }, { now: NOW });
    expect(r.added).toBe(3);
    expect(r.balance).toMatchObject({ status: "RECORDED", balanceCents: 1_068_000 });
    const manual = await prisma.manualBankAccount.findUniqueOrThrow({ where: { ledgerAccountId: w.checking.id } });
    expect(manual).toMatchObject({ clientId: w.bakery.id, name: "Business Checking", kind: "CHECKING", createdById: w.daria.id });
    const b = await prisma.manualBankBalance.findFirstOrThrow({ where: { accountId: manual.id } });
    expect(b).toMatchObject({ source: "BANK_FILE", balanceCents: 1_068_000, enteredById: w.daria.id, importId: r.id, note: "From bank file: pretend-bank-yesterday.csv" });
    expect(b.asOf).toEqual(chicagoLocalToUtc(`${ymd(1)}T23:59`));
    expect((await prisma.bankImport.findUniqueOrThrow({ where: { id: r.id } })).balanceStatus).toBe("RECORDED");
    const feed = await portalBankFeed(w.pat, w.bakery.id);
    expect(feed).toMatchObject({ source: "MANUAL", updatedDateOnly: true });
    const t = kpi(feed).replace(/<[^>]+>/g, " ");
    expect(t).toMatch(/Updated by our office · as of [A-Z][a-z]{2} \d{1,2}, \d{4}/);
    expect(t).toContain("$10,680.00");
    expect(JSON.stringify(feed)).not.toContain("pretend-bank-yesterday.csv"); // the note stays in the office
  });

  it("newest-first file: records the top row's balance; links the office's account with the same last 4", async () => {
    const w = await world();
    await prisma.ledgerAccount.update({ where: { id: w.checking.id }, data: { last4: "4094", institution: "Pretend National Bank" } });
    const mine = await createManualAccount(w.daria, w.bakery.id, { name: "Operating checking", last4: "4094", kind: "CHECKING" });
    const r = await importBankCsv(w.daria, w.bakery.id, w.checking.id, { fileName: "newest-first.csv", text: CSV([`${us(1)},Card deposits,300.00,2680.00`, `${us(1)},Flour supplier,-120.00,2380.00`, `${us(3)},Card deposits,500.00,2500.00`]) }, { now: NOW });
    expect(r.balance).toMatchObject({ status: "RECORDED", accountId: mine.id, balanceCents: 268_000 });
    expect((await prisma.manualBankAccount.findUniqueOrThrow({ where: { id: mine.id } })).ledgerAccountId).toBe(w.checking.id);
    expect(await prisma.manualBankAccount.count()).toBe(1);
  });

  it("a file without a balance column changes nothing about balances", async () => {
    const w = await world();
    const r = await importBankCsv(w.daria, w.bakery.id, w.checking.id, { fileName: "plain.csv", text: CSV([`${us(1)},Card deposits,300.00`], "Date,Description,Amount") }, { now: NOW });
    expect(r.added).toBe(1);
    expect(r.balance).toBeNull();
    expect(await prisma.manualBankAccount.count()).toBe(0);
    expect(await prisma.manualBankBalance.count()).toBe(0);
    expect((await prisma.bankImport.findUniqueOrThrow({ where: { id: r.id } })).balanceStatus).toBeNull();
    expect((await portalBankFeed(w.pat, w.bakery.id)).source).toBe("NONE");
  });

  it("an overlapping re-import doesn't record the same balance twice", async () => {
    const w = await world();
    const day1 = CSV([`${us(2)},Card deposits,500.00,1500.00`, `${us(1)},Fee,-5.00,1495.00`]);
    await importBankCsv(w.daria, w.bakery.id, w.checking.id, { fileName: "a.csv", text: day1 }, { now: NOW });
    const again = await importBankCsv(w.daria, w.bakery.id, w.checking.id, { fileName: "a-overlap.csv", text: CSV([`${us(1)},Fee,-5.00,1495.00`]) }, { now: NOW });
    expect(again).toMatchObject({ added: 0, duplicates: 1, balance: { status: "DUPLICATE", balanceCents: 149_500 } });
    expect(await prisma.manualBankBalance.count()).toBe(1);
    // A new day's file adds the new balance.
    await importBankCsv(w.daria, w.bakery.id, w.checking.id, { fileName: "b.csv", text: CSV([`${us(1)},Fee,-5.00,1495.00`, `${us(0)},Deposit,100.00,1595.00`]) }, { now: NOW });
    expect(await prisma.manualBankBalance.count()).toBe(2);
  });

  it("all rows on one day: the balance is skipped and reported, the transactions still import", async () => {
    const w = await world();
    const r = await importBankCsv(w.daria, w.bakery.id, w.checking.id, { fileName: "same-day.csv", text: CSV([`${us(1)},A,1.00,101.00`, `${us(1)},B,2.00,103.00`]) }, { now: NOW });
    expect(r.added).toBe(2);
    expect(r.balance).toMatchObject({ status: "AMBIGUOUS", reason: expect.stringContaining("Couldn't tell which balance is newest") });
    expect(await prisma.manualBankBalance.count()).toBe(0);
  });

  it("end of day is never later than now", () => {
    const now = new Date("2026-11-05T15:00:00Z");
    expect(endOfDayCentral("2026-11-05", now)).toEqual(now);
    expect(endOfDayCentral("2026-11-04", now)).toEqual(new Date("2026-11-05T05:59:00Z"));
  });
});

describe("Morning bank pull", () => {
  it("bank sign-in page: https only, never a username or password in the address; never sent to the client", async () => {
    const w = await world();
    expect(validSignInUrl("https://www.pretendbank.example/sign-in")).toBe("https://www.pretendbank.example/sign-in");
    expect(validSignInUrl("")).toBeNull();
    for (const bad of ["http://www.pretendbank.example/", "javascript:alert(1)", "ftp://x.example", "www.pretendbank.example", "https://pat:secret@pretendbank.example/", "https://pretendbank.example/login?password=hunter2", "https://pretendbank.example/?user=pat"]) {
      expect(() => validSignInUrl(bad)).toThrow(ValidationError);
    }
    await expect(createManualAccount(w.daria, w.bakery.id, { name: "Operating checking", kind: "CHECKING", signInUrl: "http://pretendbank.example" })).rejects.toBeInstanceOf(ValidationError);
    const a = await createManualAccount(w.daria, w.bakery.id, { name: "Operating checking", kind: "CHECKING", signInUrl: "https://www.pretendbank.example/sign-in" });
    await expect(updateManualAccountLinks(w.daria, w.bakery.id, a.id, { signInUrl: "http://evil.example" })).rejects.toBeInstanceOf(ValidationError);
    await expect(updateManualAccountLinks(w.stranger, w.bakery.id, a.id, { signInUrl: "https://ok.example" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(prisma.manualBankAccount.update({ where: { id: a.id }, data: { signInUrl: "http://direct.example" } })).rejects.toThrow(); // the database refuses it too
    await enterManualBalance(w.daria, w.bakery.id, { accountId: a.id, amount: "10" }, NOW);
    expect(JSON.stringify(await portalBankFeed(w.pat, w.bakery.id))).not.toContain("pretendbank");
  });

  it("lists only businesses the staff member may work on, one row per account", async () => {
    const w = await world();
    await createManualAccount(w.daria, w.bakery.id, { name: "Operating checking", kind: "CHECKING", ledgerAccountId: w.checking.id, signInUrl: "https://www.pretendbank.example/sign-in" });
    await createManualAccount(w.tabitha, w.other.id, { name: "Hauling checking", kind: "CHECKING" });
    const names = (p: Awaited<ReturnType<typeof morningPull>>) => p.rows.map((r) => `${r.clientName}: ${r.name}`);
    // Daria (assigned to the bakery): the bakery's linked account and its unlinked card GL account.
    expect(names(await morningPull(w.daria, NOW))).toEqual(["Lakeside Pretend Bakery LLC: Operating checking", "Lakeside Pretend Bakery LLC: Business Credit Card"]);
    const bea = await morningPull(w.bea, NOW); // Banking → Edit: every business
    expect(new Set(bea.rows.map((r) => r.clientName))).toEqual(new Set(["Lakeside Pretend Bakery LLC", "Other Fictional Hauling LLC"]));
    expect((await morningPull(w.stranger, NOW)).rows).toEqual([]);
    await expect(morningImport(w.stranger, w.bakery.id, { ledgerAccountId: w.checking.id, fileName: "x.csv", text: CSV([`${us(1)},A,1.00,1.00`]) }, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(morningImport(w.daria, w.other.id, { ledgerAccountId: w.checking.id, fileName: "x.csv", text: CSV([`${us(1)},A,1.00,1.00`]) }, NOW)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("today's status is computed in Central time; done rows sort last; progress counts them", async () => {
    const w = await world();
    const op = await createManualAccount(w.daria, w.bakery.id, { name: "Operating checking", kind: "CHECKING", ledgerAccountId: w.checking.id });
    // 10:30 PM Central on Nov 4 is 04:30 UTC on Nov 5.
    const late = new Date("2026-11-05T04:30:00Z");
    const r = await morningImport(w.daria, w.bakery.id, { manualAccountId: op.id, fileName: "nov3.csv", text: CSV(["11/02/2026,A,10.00,110.00", "11/03/2026,B,5.00,115.00"]) }, late);
    expect(r.balance).toMatchObject({ status: "RECORDED", balanceCents: 11_500 });
    await prisma.bankImport.update({ where: { id: r.id }, data: { createdAt: new Date("2026-11-05T03:00:00Z") } }); // 9 PM Central, Nov 4
    await prisma.manualBankBalance.updateMany({ data: { enteredAt: new Date("2026-11-05T03:00:00Z") } });
    const p = await morningPull(w.daria, late);
    expect(p.today).toBe("2026-11-04");
    expect(p).toMatchObject({ done: 1, total: 2 });
    expect(p.rows.map((x) => x.name)).toEqual(["Business Credit Card", "Operating checking"]); // done today → bottom
    expect(p.rows[1].status).toMatchObject({ state: "DONE_BALANCE", by: "Daria", balanceCents: 11_500, added: 2, duplicates: 0 });
    // The next Central morning (8 AM Nov 5 = 14:00 UTC): nothing done yet today.
    const next = await morningPull(w.daria, new Date("2026-11-05T14:00:00Z"));
    expect(next.today).toBe("2026-11-05");
    expect(next.done).toBe(0);
    expect(next.rows.every((x) => x.status.state === "NOT_STARTED")).toBe(true);
  });

  it("an import from the morning page de-duplicates exactly like the Books page", async () => {
    const w = await world();
    const op = await createManualAccount(w.daria, w.bakery.id, { name: "Operating checking", kind: "CHECKING" });
    const text = CSV([`${us(2)},Card deposits,500.00,1500.00`, `${us(1)},Fee,-5.00,1495.00`]);
    // Unlinked: a GL account must be chosen; then the account is linked to it.
    await expect(morningImport(w.daria, w.bakery.id, { manualAccountId: op.id, fileName: "a.csv", text }, NOW)).rejects.toThrow(/Choose the GL account/);
    const books = await importBankCsv(w.daria, w.bakery.id, w.checking.id, { fileName: "books.csv", text: CSV([`${us(2)},Card deposits,500.00`], "Date,Description,Amount") }, { now: NOW });
    expect(books.added).toBe(1);
    const r = await morningImport(w.daria, w.bakery.id, { manualAccountId: op.id, ledgerAccountId: w.checking.id, fileName: "a.csv", text }, NOW);
    expect(r).toMatchObject({ added: 1, duplicates: 1, balance: { status: "RECORDED", accountId: op.id, balanceCents: 149_500 } });
    expect((await prisma.manualBankAccount.findUniqueOrThrow({ where: { id: op.id } })).ledgerAccountId).toBe(w.checking.id);
    const again = await morningImport(w.daria, w.bakery.id, { manualAccountId: op.id, fileName: "a.csv", text }, NOW);
    expect(again).toMatchObject({ added: 0, duplicates: 2, balance: { status: "DUPLICATE" } });
    expect(await prisma.bankTransaction.count({ where: { accountId: w.checking.id } })).toBe(2);
    const status = (await morningPull(w.daria, NOW)).rows.find((x) => x.manualAccountId === op.id)!.status;
    expect(status).toMatchObject({ state: "DONE_BALANCE", added: 2, duplicates: 3 }); // all of today's imports into this account, Books page included
  });

  it("a file whose newest balance can't be told shows a Problem for today", async () => {
    const w = await world();
    const op = await createManualAccount(w.daria, w.bakery.id, { name: "Operating checking", kind: "CHECKING", ledgerAccountId: w.checking.id });
    await morningImport(w.daria, w.bakery.id, { manualAccountId: op.id, fileName: "same-day.csv", text: CSV([`${us(1)},A,1.00,101.00`, `${us(1)},B,2.00,103.00`]) }, NOW);
    const row = (await morningPull(w.daria, NOW)).rows.find((x) => x.manualAccountId === op.id)!;
    expect(row.status).toMatchObject({ state: "PROBLEM", problem: expect.stringContaining("Couldn't tell which balance is newest") });
  });
});

