import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { makeUser, prisma, resetDb } from "./db";
import type { Actor } from "@/lib/auth/actor";
import { createClient } from "@/lib/services/clients";
import { bookkeepingWorkspace, openWorkPeriod, saveProfile } from "@/lib/services/bookkeeping-clients";
import { monthlyChecklist } from "@/lib/services/monthly-workflow";
import { chicagoMonth, earlierMonth, statementMonth, statementTabMonths, yearMonths } from "@/lib/bookkeeping-months";

// All data here is fictional.
let staff: Actor | null = null;
vi.mock("@/lib/auth/session", async (orig) => ({ ...(await orig<object>()), requireUser: async () => staff, getCurrentUser: async () => staff }));
vi.mock("next/server", async (orig) => ({ ...(await orig<object>()), connection: async () => {} }));
vi.mock("next/navigation", async (orig) => ({ ...(await orig<object>()), useRouter: () => ({ push() {}, replace() {}, refresh() {} }) }));
const { default: StatementsPage } = await import("@/app/(app)/bookkeeping/[clientId]/statements/page");
const { default: BookkeepingDashboard } = await import("@/app/(app)/bookkeeping/[clientId]/page");
const render = async (page: (a: never) => Promise<unknown>, clientId: string, sp: Record<string, string> = {}) =>
  renderToStaticMarkup((await page({ params: Promise.resolve({ clientId }), searchParams: Promise.resolve(sp) } as never)) as ReactElement);
const NOV_10 = new Date("2026-11-10T16:00:00Z");
const months = (list: { month: number }[]) => list.map((x) => x.month);

describe("bookkeeping month lists (pure)", () => {
  it("statement dates in late May / early June stay in May / June", () => {
    // Date-only values: text, or Dates stored at UTC midnight / noon (how @db.Date columns come back).
    expect(statementMonth("2026-05-31")).toEqual({ year: 2026, month: 5 });
    expect(statementMonth("2026-06-01")).toEqual({ year: 2026, month: 6 });
    expect(statementMonth(new Date("2026-05-31T00:00:00Z"))).toEqual({ year: 2026, month: 5 });
    expect(statementMonth(new Date("2026-06-01T00:00:00Z"))).toEqual({ year: 2026, month: 6 });
    expect(statementMonth(new Date("2026-06-30T12:00:00Z"))).toEqual({ year: 2026, month: 6 });
    // Real instants (upload times, "now") are read on the America/Chicago clock.
    expect(chicagoMonth(new Date("2026-05-31T23:30:00-05:00"))).toEqual({ year: 2026, month: 5 }); // 04:30 UTC on June 1
    expect(chicagoMonth(new Date("2026-06-01T00:00:00-05:00"))).toEqual({ year: 2026, month: 6 });
    expect(chicagoMonth(new Date("2026-07-01T03:00:00Z"))).toEqual({ year: 2026, month: 6 }); // 10 pm June 30 in Chicago
  });

  it("lists every month of the year with no gaps, newest first, through the current month", () => {
    const records = [1, 2, 3, 4, 7, 8, 9, 10].map((month) => ({ year: 2026, month }));
    expect(months(statementTabMonths(2026, { records, now: NOV_10 }))).toEqual([11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    // A past year runs through December; a future year with no records lists nothing.
    expect(months(statementTabMonths(2025, { now: NOV_10 }))).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(statementTabMonths(2027, { now: NOV_10 })).toEqual([]);
    // Books that start mid-year begin at their first month; a record before it is still listed.
    expect(months(statementTabMonths(2026, { first: { year: 2026, month: 3 }, now: NOV_10 }))).toEqual([11, 10, 9, 8, 7, 6, 5, 4, 3]);
    expect(months(statementTabMonths(2026, { first: { year: 2026, month: 3 }, records: [{ year: 2026, month: 2 }], now: NOV_10 }))).toEqual([11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
    expect(months(statementTabMonths(2026, { first: { year: 2025, month: 12 }, now: NOV_10 }))).toHaveLength(11);
    expect(earlierMonth({ year: 2026, month: 3 }, { year: 2025, month: 12 })).toEqual({ year: 2025, month: 12 });
    expect(earlierMonth(null, { year: 2026, month: 1 })).toEqual({ year: 2026, month: 1 });
  });

  it("the progress strip covers January to December in order", () => {
    expect(months(yearMonths(2026))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });
});

describe("months without records", () => {
  beforeEach(async () => {
    await resetDb();
    vi.useFakeTimers({ now: NOV_10, toFake: ["Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    staff = null;
  });

  it("May and June appear (empty) beside months that have records, and viewing them creates nothing", async () => {
    const admin = await makeUser("ADMIN", "Owner Test");
    const biz = await createClient(admin, { businessName: "Pretend Months LLC", clientType: "BUSINESS", status: "ACTIVE" });
    await saveProfile(admin, biz.id, { active: true, frequency: "MONTHLY", payroll: false });
    for (const m of [1, 2, 3, 4, 7, 8, 9, 10]) await openWorkPeriod(admin, biz.id, 2026, m);

    const ws = await bookkeepingWorkspace(biz.id);
    expect(ws.periods).toHaveLength(8);
    const tabs = statementTabMonths(2026, { records: ws.periods, now: NOV_10 });
    expect(months(tabs)).toEqual([11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    const withRecord = new Set(ws.periods.map((p) => p.month));
    expect(tabs.filter((t) => !withRecord.has(t.month)).map((t) => t.month)).toEqual([11, 6, 5]);

    // The progress strip's per-month computation runs for every month, record or not.
    const strip = await Promise.all(yearMonths(2026).map((t) => monthlyChecklist(biz.id, t.year, t.month, { today: "2026-11-10" })));
    expect(strip).toHaveLength(12);
    for (const c of strip) expect(c.percent).toBeGreaterThanOrEqual(0);

    // Display only: no month records, checklist items or documents were created.
    expect(await prisma.bookkeepingPeriod.count({ where: { clientId: biz.id } })).toBe(8);
    expect(await prisma.bookkeepingPeriod.count({ where: { clientId: biz.id, month: { in: [5, 6] } } })).toBe(0);
    expect(await prisma.document.count({ where: { clientId: biz.id } })).toBe(0);

    // The statements page lists all eleven months so far this year, May and June shown empty.
    staff = admin;
    const html = await render(StatementsPage as never, biz.id);
    const tabMonths = [...html.matchAll(/data-testid="statement-month" data-month="([\d-]+)"/g)].map((m) => m[1]);
    expect(tabMonths).toEqual(["2026-11", "2026-10", "2026-09", "2026-08", "2026-07", "2026-06", "2026-05", "2026-04", "2026-03", "2026-02", "2026-01"]);
    expect(html).toMatch(/data-month="2026-05" data-empty="true"[^>]*>.*?No statements yet/);
    // Opening an empty month shows it, empty, without opening it.
    const may = await render(StatementsPage as never, biz.id, { year: "2026", month: "5" });
    expect(may).toContain("Statements &amp; approvals — May 2026");
    expect(may).toContain("No statements yet for May 2026.");
    expect(may).toMatch(/aria-current="page"[^>]*data-month="2026-05"|data-month="2026-05"[^>]*aria-current="page"/);

    // The dashboard strip: twelve tiles, January to December, the month shown highlighted.
    const dash = await render(BookkeepingDashboard as never, biz.id, { year: "2026", month: "6" });
    const tiles = [...dash.matchAll(/data-testid="month-tile" data-month="(\d+)"/g)].map((m) => Number(m[1]));
    expect(tiles).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(dash).toMatch(/data-month="6" data-state="[A-Z_]+" aria-current="true"/);
    expect((dash.match(/aria-current="true"/g) ?? []).length).toBe(1);

    // Still nothing created by rendering.
    expect(await prisma.bookkeepingPeriod.count({ where: { clientId: biz.id } })).toBe(8);
  });
});
