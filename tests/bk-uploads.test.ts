import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { createClient } from "@/lib/services/clients";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { portalUploadDocument, staffUploadDocument } from "@/lib/services/documents";
import { openPeriod } from "@/lib/services/bookkeeping";
import { BK_UPLOAD_TYPES, missingInfo, parseAsOf, parseCoverage, periodText, uploadFieldsFromForm } from "@/lib/bk-uploads";

const pdf = () => new TextEncoder().encode(`%PDF-1.4\n% fictional ${Math.random()}\n`);
beforeEach(async () => {
  await resetDb();
  vi.stubEnv("MALWARE_SCAN_URL", "https://scanner.test/scan");
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ clean: true }), { status: 200 }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const form = (o: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(o)) fd.set(k, v);
  return fd;
};

describe("what's uploaded, the period it covers, and its as-of date", () => {
  it("offers the office's full list in order", () => {
    expect(Object.values(BK_UPLOAD_TYPES)).toEqual(["P&L (profit & loss)", "Balance Sheet", "Full financial packet", "Bank statement", "Credit-card statement", "Payroll report", "Receipts", "Supporting schedule", "Other"]);
  });

  it("requires a category and a month, quarter or date range — nothing is guessed", () => {
    expect(() => uploadFieldsFromForm(form({ periodKind: "MONTH", periodYear: "2026", periodMonth: "1" }))).toThrow(/what you're uploading/);
    expect(() => uploadFieldsFromForm(form({ docType: "BANK_STATEMENT", periodKind: "", periodYear: "2026" }))).toThrow(/reporting period/);
    expect(() => uploadFieldsFromForm(form({ docType: "BANK_STATEMENT", periodKind: "MONTH", periodYear: "2026", periodMonth: "" }))).toThrow(/month/);
    expect(() => uploadFieldsFromForm(form({ docType: "PNL", periodKind: "QUARTER", periodYear: "2026", periodQuarter: "" }))).toThrow(/quarter/);
    expect(() => uploadFieldsFromForm(form({ docType: "RECEIPTS", periodKind: "RANGE", periodStart: "2026-02-10", periodEnd: "2026-01-01" }))).toThrow(/before the start/);
    expect(() => uploadFieldsFromForm(form({ docType: "BALANCE_SHEET", periodKind: "MONTH", periodYear: "2026", periodMonth: "3" }))).toThrow(/as of/);

    const q = uploadFieldsFromForm(form({ docType: "PNL", periodKind: "QUARTER", periodYear: "2026", periodQuarter: "1" }));
    expect([q.coverage.start.toISOString().slice(0, 10), q.coverage.end.toISOString().slice(0, 10), q.asOf]).toEqual(["2026-01-01", "2026-03-31", null]);
    const r = parseCoverage({ kind: "RANGE", start: "2026-01-05", end: "2026-02-04" });
    expect(periodText({ year: r.year, month: r.month, reportPeriodType: r.kind, periodStart: r.start, periodEnd: r.end })).toBe("Jan 5, 2026 – Feb 4, 2026");
    expect(parseAsOf("BALANCE_SHEET", "2026-03-31")?.toISOString().slice(0, 10)).toBe("2026-03-31");
  });

  it("flags older files with missing details instead of assigning a period", () => {
    expect(missingInfo({ docType: null, year: null, month: null })).toEqual(["Category not recorded", "Reporting period not recorded"]);
    expect(missingInfo({ docType: "BALANCE_SHEET", year: 2026, month: 3 })).toEqual(["“As of” date missing"]);
    expect(missingInfo({ docType: "BANK_STATEMENT", year: 2026, month: 3 })).toEqual([]);
  });

  it("records the period and as-of date separately from when and by whom it was uploaded; client uploads stay for staff review", async () => {
    const tabitha = await makeUser("ADMIN", "Tabitha");
    const biz = await createClient(tabitha, { businessName: "Fictional Bakery LLC", clientType: "BUSINESS", status: "ACTIVE" });
    const period = await openPeriod(tabitha, biz.id, 2026, 3);
    const { token } = await invitePortalUser(tabitha, biz.id, { email: "owner@fictional.example", name: "Pat Owner", role: "OWNER" });
    const login = await acceptPortalInvite(token!, "Owner-Pass-12345");
    const f = uploadFieldsFromForm(form({ docType: "BALANCE_SHEET", periodKind: "MONTH", periodYear: "2026", periodMonth: "3", asOf: "2026-03-31" }));
    const before = new Date();
    const doc = await portalUploadDocument({ id: login.id, name: login.name, email: login.email }, { clientId: biz.id, periodId: period.id, docType: f.type, coverage: f.coverage, asOf: f.asOf, bytes: pdf(), originalName: "bs.pdf" });
    const saved = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
    expect(saved).toMatchObject({ docType: "BALANCE_SHEET", reportPeriodType: "MONTH", uploadedByPortalId: login.id, needsReview: true, reportType: null, approvedAt: null });
    expect(saved.reportAsOf?.toISOString().slice(0, 10)).toBe("2026-03-31");
    expect(saved.periodStart?.toISOString().slice(0, 10)).toBe("2026-03-01");
    expect(saved.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);

    // Staff upload of a client-provided statement keeps its own coverage and uploader.
    const g = uploadFieldsFromForm(form({ kind: "CARD_STATEMENT", periodKind: "RANGE", periodStart: "2026-02-15", periodEnd: "2026-03-14" }), "kind");
    const s = await staffUploadDocument(tabitha, { clientId: biz.id, category: "BOOKKEEPING", visibility: "STAFF_ONLY", periodId: period.id, year: 2026, month: 3, docType: g.type, coverage: g.coverage, asOf: g.asOf, bytes: pdf(), originalName: "card.pdf" });
    const st = await prisma.document.findUniqueOrThrow({ where: { id: s.id } });
    expect([st.uploadedByStaffId, st.reportPeriodType, periodText(st)]).toEqual([tabitha.id, "RANGE", "Feb 15, 2026 – Mar 14, 2026"]);

    // An older file without these details is left as is — and flagged.
    const old = await staffUploadDocument(tabitha, { clientId: biz.id, category: "BOOKKEEPING", visibility: "STAFF_ONLY", bytes: pdf(), originalName: "old.pdf" });
    const o = await prisma.document.findUniqueOrThrow({ where: { id: old.id } });
    expect([o.periodStart, o.year, o.month]).toEqual([null, null, null]);
    expect(missingInfo(o)).toEqual(["Category not recorded", "Reporting period not recorded"]);
  });
});
