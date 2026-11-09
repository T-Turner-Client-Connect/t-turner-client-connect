import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { renderToStaticMarkup } from "react-dom/server";
import { redirect } from "next/navigation";
import { grantPerms, prisma, resetDb } from "./db";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import { hashPassword } from "@/lib/auth/password";
import { claimOwnerOffice, officeTabs } from "@/lib/auth/owner";
import { officeAccessFor } from "@/lib/auth/permissions";
import { GRANTABLE_KEYS } from "@/lib/permissions";
import { storage } from "@/lib/storage";
import { looksEncrypted, openStoredBytes } from "@/lib/crypto";
import {
  adpFiscalQuarter,
  allocate,
  buildReport,
  mapCsvRows,
  parseCents,
  parseLineType,
  statementTotalCheck,
  totalWarning,
  UNMATCHED_KEY,
  type CsvMapping,
  type ReportLine,
} from "@/lib/adp-revenue-share";
import * as svc from "@/lib/services/adp-revenue-share";

/**
 * Owner's Office → ADP Revenue Share. Fictional office only: "Tabitha Turner" (owner), "Daria
 * Fictional" (staff holding every grant), "Marcus Fictional" (an Admin who isn't the owner), a
 * fictional portal login, and fictional client businesses. No network.
 */
const PASSWORD = "Owner-Strong-Pass-1";

let signedIn: Actor | null = null;
vi.mock("@/lib/auth/session", async (orig) => ({
  ...(await orig<object>()),
  // As the real requireUser: no staff session (a portal login has none) → the staff sign-in page.
  requireUser: async () => signedIn ?? redirect("/staff/login"),
  getCurrentUser: async () => signedIn,
}));
vi.mock("next/navigation", async (orig) => ({ ...(await orig<object>()), useRouter: () => ({ push: () => {}, refresh: () => {} }) }));
vi.mock("next/cache", async (orig) => ({ ...(await orig<object>()), revalidatePath: () => {} }));

const actions = await import("@/app/actions/adp-revenue-share");
const { default: OverviewPage } = await import("@/app/(app)/owner/(office)/adp-revenue-share/page");
const { default: ReferralsPage } = await import("@/app/(app)/owner/(office)/adp-revenue-share/referrals/page");
const { default: ReferralPage } = await import("@/app/(app)/owner/(office)/adp-revenue-share/referrals/[id]/page");
const { default: StatementsPage } = await import("@/app/(app)/owner/(office)/adp-revenue-share/statements/page");
const { default: StatementPage } = await import("@/app/(app)/owner/(office)/adp-revenue-share/statements/[id]/page");
const { default: PaymentsPage } = await import("@/app/(app)/owner/(office)/adp-revenue-share/payments/page");
const { default: PaymentPage } = await import("@/app/(app)/owner/(office)/adp-revenue-share/payments/[id]/page");
const { default: ReportsPage } = await import("@/app/(app)/owner/(office)/adp-revenue-share/reports/page");
const { GET: fileRoute } = await import("@/app/api/owner/adp-revenue-share/statements/[id]/file/route");
const { GET: exportRoute } = await import("@/app/api/owner/adp-revenue-share/export/route");

beforeEach(async () => {
  await resetDb();
  signedIn = null;
  vi.stubEnv("NOTIFICATIONS_ENABLED", "false");
  vi.stubGlobal("fetch", async (url: string | URL) => {
    throw new Error(`Unexpected network call in a test: ${String(url)}`);
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function staffAccount(email: string, name: string, role: "ADMIN" | "STAFF"): Promise<Actor> {
  const u = await prisma.user.create({ data: { email, name, role, passwordHash: await hashPassword(PASSWORD), mfaEnabledAt: new Date() } });
  return { id: u.id, role: u.role, name: u.name, email: u.email };
}

async function office() {
  const tab = await staffAccount("tabitha@tturnerassociates.com", "Tabitha Turner", "ADMIN");
  const daria = await staffAccount("daria.fictional@example.com", "Daria Fictional", "STAFF");
  const marcus = await staffAccount("marcus.fictional@example.com", "Marcus Fictional", "ADMIN");
  await claimOwnerOffice(tab, PASSWORD);
  await grantPerms(daria.id, GRANTABLE_KEYS);
  await grantPerms(marcus.id, GRANTABLE_KEYS);
  const portal = await prisma.portalUser.create({ data: { email: "portal.fictional@example.com", name: "Pat Portal", passwordHash: "x" } });
  // A portal login can't hold a staff session; even a forged actor with its id is refused.
  const portalActor: Actor = { id: portal.id, role: "ADMIN", name: portal.name, email: portal.email };
  const bakery = await prisma.client.create({ data: { displayName: "Fictional Bluebird Bakery LLC", businessName: "Fictional Bluebird Bakery LLC", clientType: "BUSINESS" } });
  const dental = await prisma.client.create({ data: { displayName: "Fictional Maple Dental", businessName: "Fictional Maple Dental", clientType: "BUSINESS" } });
  return { tab, daria, marcus, portalActor, bakery, dental };
}

const header = (over: Partial<svc.StatementHeaderInput> = {}): svc.StatementHeaderInput => ({ periodLabel: "ADP FY2027 Q1 (FICTIONAL)", periodStart: "2026-07-01", periodEnd: "2026-09-30", statementDate: "2026-10-20", reportedTotalCents: 50000, ...over });
const html = async (el: Promise<unknown>) => renderToStaticMarkup((await el) as ReactElement);
const isNotFound = (e: unknown) => typeof e === "object" && e !== null && String((e as { digest?: string }).digest ?? "").includes("404");
const isRedirect = (e: unknown) => typeof e === "object" && e !== null && String((e as { digest?: string }).digest ?? "").startsWith("NEXT_REDIRECT");
const fd = (o: Record<string, string>) => {
  const f = new FormData();
  Object.entries(o).forEach(([k, v]) => f.set(k, v));
  return f;
};
const pdf = (text: string) => new TextEncoder().encode(`%PDF-1.4\n% FICTIONAL ADP statement ${text}\n%%EOF`);
const tableCounts = async () => ({
  referrals: await prisma.adpReferral.count(),
  statements: await prisma.adpStatement.count(),
  lines: await prisma.adpStatementLine.count(),
  payments: await prisma.adpPayment.count(),
  revisions: await prisma.adpStatementRevision.count(),
  matches: await prisma.adpPaymentMatchEvent.count(),
  history: await prisma.adpReferralStatusChange.count(),
  settings: await prisma.adpRevenueShareSettings.count(),
});

/** A referral, a statement with two lines and a matched payment, all made by the owner. */
async function seeded(o: Awaited<ReturnType<typeof office>>) {
  const referral = await svc.createReferral(o.tab, { clientId: o.bakery.id, referredOn: "2026-02-10", product: "RUN" });
  const statement = await svc.createStatement(o.tab, header());
  const line = await svc.addLine(o.tab, statement.id, { type: "COMMISSION", amountCents: 40000, referralId: referral.id });
  await svc.addLine(o.tab, statement.id, { type: "RESIDUAL", amountCents: 10000, clientId: o.dental.id });
  const payment = await svc.createPayment(o.tab, { receivedOn: "2026-11-14", amountCents: 50000, method: "ACH" });
  return { referral, statement, line, payment };
}

describe("owner-only enforcement", () => {
  it("shows the ADP Revenue Share tab to the owner only — not to staff or Admins holding every grant", async () => {
    const o = await office();
    expect(officeTabs(await officeAccessFor(o.tab.id))).toContainEqual({ href: "/owner/adp-revenue-share", label: "ADP Revenue Share" });
    for (const who of [o.daria, o.marcus]) expect(officeTabs(await officeAccessFor(who.id)).map((t) => t.href)).not.toContain("/owner/adp-revenue-share");
  });

  it("refuses every service call from staff, a non-owner Admin and a portal login, and changes nothing", async () => {
    const o = await office();
    const s = await seeded(o);
    const before = await tableCounts();
    const auditsBefore = await prisma.ownerAuditLog.count();
    const csv = "Name,Amount\nFictional,10.00\n";
    const mapping: CsvMapping = { headerRow: true, amount: 1, type: null, fixedType: "RESIDUAL", name: 0, note: null };
    for (const who of [o.daria, o.marcus, o.portalActor]) {
      const calls: (() => Promise<unknown>)[] = [
        () => svc.adpClientChoices(who),
        () => svc.createReferral(who, { clientId: o.bakery.id, referredOn: "2026-01-01", product: "RUN" }),
        () => svc.updateReferral(who, s.referral.id, { prospectName: "X", referredOn: "2026-01-01", product: "RUN" }),
        () => svc.changeReferralStatus(who, s.referral.id, { status: "SOLD" }),
        () => svc.archiveReferral(who, s.referral.id, "Not allowed"),
        () => svc.listReferrals(who),
        () => svc.getReferral(who, s.referral.id),
        () => svc.referralChoices(who),
        () => svc.createStatement(who, header()),
        () => svc.updateStatement(who, s.statement.id, header({ periodLabel: "Changed" })),
        () => svc.attachStatementFile(who, s.statement.id, { bytes: pdf("not allowed"), originalName: "x.pdf" }),
        () => svc.addLine(who, s.statement.id, { type: "BONUS", amountCents: 100 }),
        () => svc.updateLine(who, s.line.id, { type: "BONUS", amountCents: 100 }),
        () => svc.removeLine(who, s.line.id, "Not allowed"),
        () => svc.finalizeStatement(who, s.statement.id),
        () => svc.archiveStatement(who, s.statement.id, "Not allowed"),
        () => svc.listStatements(who),
        () => svc.getStatement(who, s.statement.id),
        () => svc.statementChoices(who),
        () => svc.readStatementFile(who, s.statement.id),
        () => svc.previewLineImport(who, { csvText: csv }),
        () => svc.importLines(who, s.statement.id, { csvText: csv, mapping }),
        () => svc.createPayment(who, { receivedOn: "2026-11-01", amountCents: 100, method: "ACH" }),
        () => svc.updatePayment(who, s.payment.id, { receivedOn: "2026-11-01", amountCents: 100, method: "ACH" }),
        () => svc.matchPayment(who, s.payment.id, s.statement.id),
        () => svc.unmatchPayment(who, s.payment.id, "Not allowed"),
        () => svc.archivePayment(who, s.payment.id, "Not allowed"),
        () => svc.listPayments(who),
        () => svc.getPayment(who, s.payment.id),
        () => svc.fiscalNote(who),
        () => svc.saveFiscalNote(who, "Not allowed"),
        () => svc.adpReport(who, { year: 2026 }),
        () => svc.adpOverview(who, "2026-11-05"),
      ];
      for (const call of calls) {
        await expect(call()).rejects.toBeInstanceOf(ForbiddenError);
        await expect(call()).rejects.toThrow("Not found.");
      }
    }
    expect(await tableCounts()).toEqual(before);
    expect(await prisma.ownerAuditLog.count()).toBe(auditsBefore);
  });

  it("server actions answer staff and non-owner Admins with “Not found.” and save nothing; no staff session → sign-in redirect", async () => {
    const o = await office();
    const s = await seeded(o);
    const before = await tableCounts();
    const A = actions;
    const formCalls: [string, (f: FormData) => Promise<unknown>, Record<string, string>][] = [
      ["createReferral", (f) => A.createReferralAction(null, f), { clientId: o.bakery.id, referredOn: "2026-01-01", product: "RUN" }],
      ["updateReferral", (f) => A.updateReferralAction(s.referral.id, null, f), { prospectName: "X", referredOn: "2026-01-01", product: "RUN" }],
      ["referralStatus", (f) => A.referralStatusAction(s.referral.id, null, f), { status: "SOLD" }],
      ["archiveReferral", (f) => A.archiveReferralAction(s.referral.id, null, f), { reason: "Not allowed" }],
      ["createStatement", (f) => A.createStatementAction(null, f), { periodLabel: "X", periodStart: "2026-01-01", periodEnd: "2026-03-31", statementDate: "2026-04-20", reportedTotal: "1.00" }],
      ["updateStatement", (f) => A.updateStatementAction(s.statement.id, null, f), { periodLabel: "X", periodStart: "2026-01-01", periodEnd: "2026-03-31", statementDate: "2026-04-20", reportedTotal: "1.00" }],
      ["addLine", (f) => A.addLineAction(s.statement.id, null, f), { type: "BONUS", amount: "1.00" }],
      ["updateLine", (f) => A.updateLineAction(s.statement.id, s.line.id, null, f), { type: "BONUS", amount: "1.00" }],
      ["removeLine", (f) => A.removeLineAction(s.statement.id, s.line.id, null, f), { reason: "Not allowed" }],
      ["finalize", (f) => A.finalizeStatementAction(s.statement.id, null, f), {}],
      ["archiveStatement", (f) => A.archiveStatementAction(s.statement.id, null, f), { reason: "Not allowed" }],
      ["createPayment", (f) => A.createPaymentAction(null, f), { receivedOn: "2026-11-01", amount: "1.00", method: "ACH" }],
      ["updatePayment", (f) => A.updatePaymentAction(s.payment.id, null, f), { receivedOn: "2026-11-01", amount: "1.00", method: "ACH" }],
      ["matchPayment", (f) => A.matchPaymentAction(s.payment.id, null, f), { statementId: s.statement.id }],
      ["unmatchPayment", (f) => A.unmatchPaymentAction(s.payment.id, null, f), { reason: "Not allowed" }],
      ["archivePayment", (f) => A.archivePaymentAction(s.payment.id, null, f), { reason: "Not allowed" }],
      ["fiscalNote", (f) => A.saveFiscalNoteAction(null, f), { fiscalNote: "Not allowed" }],
    ];
    const withFile = fd({});
    withFile.set("file", new File([pdf("x")], "x.pdf", { type: "application/pdf" }));
    for (const who of [o.daria, o.marcus]) {
      signedIn = who;
      for (const [name, call, body] of formCalls) expect({ name, r: await call(fd(body)) }).toMatchObject({ name, r: { error: "Not found." } });
      expect(await A.attachStatementFileAction(s.statement.id, null, withFile)).toMatchObject({ error: "Not found." });
      expect(await A.previewImportAction({ csvText: "A,B\n1,2\n" })).toEqual({ ok: false, error: "Not found." });
      expect(await A.importLinesAction(s.statement.id, { csvText: "A,B\nX,2\n", mapping: { headerRow: true, amount: 1, fixedType: "BONUS" } })).toMatchObject({ error: "Not found." });
    }
    signedIn = null; // e.g. a portal login: it has no staff session
    for (const [, call, body] of formCalls) await expect(call(fd(body))).rejects.toSatisfy(isRedirect);
    await expect(A.previewImportAction({ csvText: "A\n1\n" })).rejects.toSatisfy(isRedirect);
    expect(await tableCounts()).toEqual(before);
  });

  it("every page is a plain 404 for staff and non-owner Admins, and sends a session-less visitor to sign-in", async () => {
    const o = await office();
    const s = await seeded(o);
    const pages = [
      () => OverviewPage(),
      () => ReferralsPage({ searchParams: Promise.resolve({}) }),
      () => ReferralPage({ params: Promise.resolve({ id: s.referral.id }) }),
      () => StatementsPage({ searchParams: Promise.resolve({}) }),
      () => StatementPage({ params: Promise.resolve({ id: s.statement.id }) }),
      () => PaymentsPage({ searchParams: Promise.resolve({}) }),
      () => PaymentPage({ params: Promise.resolve({ id: s.payment.id }) }),
      () => ReportsPage({ searchParams: Promise.resolve({}) }),
    ];
    for (const who of [o.daria, o.marcus]) {
      signedIn = who;
      for (const page of pages) await expect(page()).rejects.toSatisfy(isNotFound);
    }
    signedIn = null;
    for (const page of pages) await expect(page()).rejects.toSatisfy(isRedirect);
    signedIn = o.tab;
    const rendered = await Promise.all(pages.map((p) => html(p())));
    expect(rendered[0]).toContain("ADP Revenue Share");
    for (const tab of ["Overview", "Referrals", "Statements", "Payments", "Reports"]) expect(rendered[0]).toContain(`>${tab}</a>`);
    expect(rendered[4]).toContain("Fictional Bluebird Bakery LLC");
    expect(rendered[6]).toContain("Match payment to statement");
    expect(rendered[6]).toContain("Suggested matches");
  });

  it("the statement file and CSV export routes are 404 for anyone but the owner", async () => {
    const o = await office();
    const s = await svc.createStatement(o.tab, { ...header(), file: { bytes: pdf("routes"), originalName: "fictional.pdf" } });
    const ctx = { params: Promise.resolve({ id: s.id }) };
    const exportReq = () => new Request("http://localhost/api/owner/adp-revenue-share/export?type=report&year=2026");
    for (const who of [o.daria, o.marcus, null]) {
      signedIn = who;
      expect((await fileRoute(new Request("http://localhost/x"), ctx)).status).toBe(404);
      expect((await exportRoute(exportReq())).status).toBe(404);
    }
    signedIn = o.tab;
    const file = await fileRoute(new Request("http://localhost/x"), { params: Promise.resolve({ id: s.id }) });
    expect(file.status).toBe(200);
    expect(file.headers.get("Content-Type")).toBe("application/pdf");
    expect(file.headers.get("Cache-Control")).toBe("private, no-store");
    const exp = await exportRoute(exportReq());
    expect(exp.status).toBe(200);
    expect(await exp.text()).toContain("View,Period / group,Earned,Received,Outstanding");
  });

  it("is never reachable from a client's portal: no portal code imports the tracker", () => {
    const files: string[] = [];
    const walk = (dir: string) => readdirSync(dir).forEach((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : files.push(join(dir, n))));
    ["src/app/client", "src/lib/portal", "src/components/portal"].forEach(walk);
    const offenders = files.filter((f) => /adp-revenue-share|adpReferral|adpStatement|adpPayment/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
    // And statement files live in the owner-only store (owner_private/… → its own Blobs store).
    expect(readFileSync("src/lib/services/adp-revenue-share.ts", "utf8")).toContain("owner_private/adp/statements/");
  });
});

describe("statement total vs lines", () => {
  it("is a pure check that ignores removed lines", () => {
    expect(statementTotalCheck(1000, [{ amountCents: 600 }, { amountCents: 400 }])).toMatchObject({ matches: true, linesCents: 1000, differenceCents: 0 });
    const off = statementTotalCheck(1000, [{ amountCents: 600 }, { amountCents: 300 }, { amountCents: 100, archivedAt: new Date() }]);
    expect(off).toMatchObject({ matches: false, linesCents: 900, differenceCents: 100 });
    expect(totalWarning(off)).toContain("$1.00 more than the sum of its lines ($9.00)");
    expect(totalWarning(statementTotalCheck(800, [{ amountCents: 900 }]))).toContain("less than");
  });

  it("shows a warning on the statement until the lines add up", async () => {
    const o = await office();
    const s = await svc.createStatement(o.tab, header({ reportedTotalCents: 50000 }));
    await svc.addLine(o.tab, s.id, { type: "COMMISSION", amountCents: 40000 });
    signedIn = o.tab;
    let page = await html(StatementPage({ params: Promise.resolve({ id: s.id }) }));
    expect(page).toContain('data-testid="total-warning"');
    expect(page).toContain("is $100.00 more than the sum of its lines ($400.00)");
    expect((await svc.listStatements(o.tab))[0].check.matches).toBe(false);
    await svc.addLine(o.tab, s.id, { type: "ADJUSTMENT", amountCents: 10000 });
    page = await html(StatementPage({ params: Promise.resolve({ id: s.id }) }));
    expect(page).not.toContain('data-testid="total-warning"');
    expect(page).toContain('data-testid="total-ok"');
  });

  it("won't mark a mismatched statement Final without an explicit acknowledgement", async () => {
    const o = await office();
    const s = await svc.createStatement(o.tab, header({ reportedTotalCents: 50000 }));
    await expect(svc.finalizeStatement(o.tab, s.id)).rejects.toThrow("Add the statement's lines");
    await svc.addLine(o.tab, s.id, { type: "COMMISSION", amountCents: 49000 });
    await expect(svc.finalizeStatement(o.tab, s.id)).rejects.toThrow("doesn't match its lines");
    await svc.finalizeStatement(o.tab, s.id, { acknowledgeMismatch: true });
    const rev = await prisma.adpStatementRevision.findFirstOrThrow({ where: { statementId: s.id } });
    expect(rev).toMatchObject({ kind: "FINALIZED", revisionNumber: 1 });
    expect(rev.updated).toMatchObject({ totalMatches: false, linesCents: 49000 });
  });

  it("refuses negative amounts except adjustments", async () => {
    const o = await office();
    const s = await svc.createStatement(o.tab, header());
    await expect(svc.addLine(o.tab, s.id, { type: "COMMISSION", amountCents: -100 })).rejects.toThrow("Only an adjustment can be negative");
    await svc.addLine(o.tab, s.id, { type: "ADJUSTMENT", amountCents: -100 });
    expect(parseCents("(12.50)", { allowNegative: true })).toBe(-1250);
    expect(parseCents("$1,234.56")).toBe(123456);
    expect(parseCents("-5")).toBeNull();
    expect(parseCents("abc")).toBeNull();
  });
});

describe("Final lock and revision history", () => {
  it("edits freely while Draft (no revisions), then requires a revision note and keeps an append-only history", async () => {
    const o = await office();
    const { statement: s, line } = await seeded(o);
    await svc.updateStatement(o.tab, s.id, header({ notes: "Draft edit" }));
    await svc.updateLine(o.tab, line.id, { type: "COMMISSION", amountCents: 39000 });
    await svc.updateLine(o.tab, line.id, { type: "COMMISSION", amountCents: 40000 });
    expect(await prisma.adpStatementRevision.count()).toBe(0);

    await svc.finalizeStatement(o.tab, s.id);
    expect((await prisma.adpStatement.findUniqueOrThrow({ where: { id: s.id } })).status).toBe("FINAL");
    await expect(svc.finalizeStatement(o.tab, s.id)).rejects.toThrow("already Final");

    // Every kind of change now needs a note…
    await expect(svc.updateStatement(o.tab, s.id, header({ periodLabel: "Renamed" }))).rejects.toThrow("revision note");
    await expect(svc.addLine(o.tab, s.id, { type: "BONUS", amountCents: 500 })).rejects.toThrow("revision note");
    await expect(svc.updateLine(o.tab, line.id, { type: "COMMISSION", amountCents: 1 })).rejects.toThrow("revision note");
    await expect(svc.attachStatementFile(o.tab, s.id, { bytes: pdf("final"), originalName: "f.pdf" })).rejects.toThrow("revision note");
    await expect(svc.importLines(o.tab, s.id, { csvText: "N,A\nX,1.00\n", mapping: { headerRow: true, amount: 1, type: null, fixedType: "BONUS", name: 0, note: null } })).rejects.toThrow("revision note");
    expect((await prisma.adpStatement.findUniqueOrThrow({ where: { id: s.id } })).periodLabel).toBe("ADP FY2027 Q1 (FICTIONAL)");

    // …and is kept, numbered, with before/after.
    await svc.updateStatement(o.tab, s.id, { ...header({ reportedTotalCents: 52000 }), reason: "ADP corrected the statement total" });
    await svc.addLine(o.tab, s.id, { type: "BONUS", amountCents: 2000, reason: "ADP added a bonus line" });
    await svc.updateLine(o.tab, line.id, { type: "COMMISSION", amountCents: 41000, referralId: line.referralId, reason: "Commission was $410" });
    await svc.removeLine(o.tab, line.id, "Duplicate line on ADP's statement");
    const revs = await prisma.adpStatementRevision.findMany({ where: { statementId: s.id }, orderBy: { revisionNumber: "asc" } });
    expect(revs.map((r) => [r.revisionNumber, r.kind])).toEqual([[1, "FINALIZED"], [2, "HEADER_EDITED"], [3, "LINE_ADDED"], [4, "LINE_EDITED"], [5, "LINE_REMOVED"]]);
    expect(revs[1]).toMatchObject({ reason: "ADP corrected the statement total", previous: { reportedTotalCents: 50000 }, updated: { reportedTotalCents: 52000 }, editedByName: "Tabitha Turner" });
    expect(revs[3].previous).toMatchObject({ amountCents: 40000 });
    expect(revs[3].updated).toMatchObject({ amountCents: 41000 });

    // Append-only at the database too.
    await expect(prisma.adpStatementRevision.update({ where: { id: revs[1].id }, data: { reason: "rewritten" } })).rejects.toThrow(/append-only/);
    await expect(prisma.adpStatementRevision.delete({ where: { id: revs[1].id } })).rejects.toThrow(/append-only/);

    signedIn = o.tab;
    const page = await html(StatementPage({ params: Promise.resolve({ id: s.id }) }));
    expect(page).toContain('data-testid="final-lock"');
    expect(page).toContain("Revision note (required)");
    expect(page).toContain("ADP corrected the statement total");
    expect(page).toContain("Line removed");
    expect(page).toContain("Duplicate line on ADP&#x27;s statement");
    expect(await prisma.ownerAuditLog.count({ where: { action: { startsWith: "adp.statement." }, entityId: s.id } })).toBeGreaterThanOrEqual(9);
  });

  it("referral status history and payment match history are append-only and audited", async () => {
    const o = await office();
    const { referral, statement, payment } = await seeded(o);
    await svc.changeReferralStatus(o.tab, referral.id, { status: "SOLD", effectiveOn: "2026-03-02", note: "Signed" });
    await svc.changeReferralStatus(o.tab, referral.id, { status: "ACTIVE" });
    await expect(svc.changeReferralStatus(o.tab, referral.id, { status: "ACTIVE" })).rejects.toThrow("already");
    const hist = await prisma.adpReferralStatusChange.findMany({ where: { referralId: referral.id }, orderBy: { changedAt: "asc" } });
    expect(hist.map((h) => [h.fromStatus, h.toStatus])).toEqual([[null, "REFERRED"], ["REFERRED", "SOLD"], ["SOLD", "ACTIVE"]]);
    await expect(prisma.adpReferralStatusChange.delete({ where: { id: hist[0].id } })).rejects.toThrow(/append-only/);

    await svc.matchPayment(o.tab, payment.id, statement.id, "Amounts agree");
    await expect(svc.matchPayment(o.tab, payment.id, statement.id)).rejects.toThrow("already matched");
    await expect(svc.archiveStatement(o.tab, statement.id, "Wrong")).rejects.toThrow("Unmatch it");
    await svc.unmatchPayment(o.tab, payment.id, "Was for another quarter");
    const ev = await prisma.adpPaymentMatchEvent.findMany({ where: { paymentId: payment.id }, orderBy: { at: "asc" } });
    expect(ev.map((e) => [e.action, e.note])).toEqual([["MATCHED", "Amounts agree"], ["UNMATCHED", "Was for another quarter"]]);
    await expect(prisma.adpPaymentMatchEvent.update({ where: { id: ev[0].id }, data: { note: "x" } })).rejects.toThrow(/append-only/);
    const actionsLogged = (await prisma.ownerAuditLog.findMany({ where: { action: { startsWith: "adp." } }, select: { action: true } })).map((a) => a.action);
    for (const a of ["adp.referral.created", "adp.referral.status_changed", "adp.statement.created", "adp.statement.line_added", "adp.payment.created", "adp.payment.matched", "adp.payment.unmatched"]) expect(actionsLogged).toContain(a);
  });
});

describe("report math", () => {
  const L = (o: Partial<ReportLine> & { amountCents: number; statementId: string; statementDate: string }): ReportLine => ({
    type: "COMMISSION",
    periodEnd: o.statementDate,
    clientKey: "client:a",
    clientLabel: "Client A",
    productKey: "product:RUN",
    productLabel: "RUN",
    ...o,
  });
  const lines: ReportLine[] = [
    L({ amountCents: 30000, statementId: "s1", statementDate: "2026-01-20", periodEnd: "2025-12-31", clientKey: "client:a", clientLabel: "A" }),
    L({ amountCents: 10000, statementId: "s1", statementDate: "2026-01-20", periodEnd: "2025-12-31", clientKey: "client:b", clientLabel: "B", productKey: "product:WFN", productLabel: "WFN" }),
    L({ amountCents: 20000, statementId: "s2", statementDate: "2026-04-20", periodEnd: "2026-03-31", clientKey: "client:a", clientLabel: "A" }),
    L({ amountCents: -1000, type: "ADJUSTMENT", statementId: "s2", statementDate: "2026-04-20", periodEnd: "2026-03-31", clientKey: "client:b", clientLabel: "B", productKey: "product:WFN", productLabel: "WFN" }),
    L({ amountCents: 5000, statementId: "s0", statementDate: "2025-10-20", clientKey: "client:a", clientLabel: "A" }),
  ];
  const payments = [
    { id: "p1", amountCents: 40000, receivedOn: "2026-03-05", statementId: "s1" },
    { id: "p2", amountCents: 9500, receivedOn: "2026-05-30", statementId: "s2" },
    { id: "p3", amountCents: 2500, receivedOn: "2026-05-02", statementId: null },
  ];

  it("months and years: earned by statement date, received by payment date, outstanding = earned − received", () => {
    const r = buildReport({ lines, payments, year: 2026 });
    const m = (n: number) => r.months[n - 1];
    expect(m(1)).toMatchObject({ earnedCents: 40000, receivedCents: 0, outstandingCents: 40000 });
    expect(m(3)).toMatchObject({ earnedCents: 0, receivedCents: 40000, outstandingCents: -40000 });
    expect(m(4)).toMatchObject({ earnedCents: 19000, receivedCents: 0 });
    expect(m(5)).toMatchObject({ earnedCents: 0, receivedCents: 12000 });
    expect(r.yearTotal).toMatchObject({ earnedCents: 59000, receivedCents: 52000, outstandingCents: 7000 });
    expect(r.years.map((y) => [y.key, y.earnedCents, y.receivedCents, y.outstandingCents])).toEqual([["2025", 5000, 0, 5000], ["2026", 59000, 52000, 7000]]);
    expect(r.allTime).toMatchObject({ earnedCents: 64000, receivedCents: 52000, outstandingCents: 12000 });
  });

  it("can date earnings by the statement period end instead", () => {
    const r = buildReport({ lines, payments, year: 2026, basis: "periodEnd" });
    expect(r.months[0].earnedCents).toBe(0);
    expect(r.months[2].earnedCents).toBe(19000);
    expect(r.years.find((y) => y.key === "2025")!.earnedCents).toBe(45000);
  });

  it("by client and by product: received split over the matched statement's lines; unmatched payments on their own row", () => {
    const r = buildReport({ lines, payments, year: 2026 });
    const c = Object.fromEntries(r.byClient.map((x) => [x.key, x]));
    // p1 40000 over s1 (30000 A / 10000 B) → 30000 / 10000; p2 9500 over s2 (20000 A / -1000 B) → 10000 / -500.
    expect(c["client:a"]).toMatchObject({ earnedCents: 50000, receivedCents: 40000, outstandingCents: 10000 });
    expect(c["client:b"]).toMatchObject({ earnedCents: 9000, receivedCents: 9500, outstandingCents: -500 });
    expect(c[UNMATCHED_KEY]).toMatchObject({ earnedCents: 0, receivedCents: 2500, outstandingCents: -2500 });
    expect(r.byClient.at(-1)!.key).toBe(UNMATCHED_KEY);
    const p = Object.fromEntries(r.byProduct.map((x) => [x.key, x]));
    expect(p["product:RUN"]).toMatchObject({ earnedCents: 50000, receivedCents: 40000 });
    expect(p["product:WFN"]).toMatchObject({ earnedCents: 9000, receivedCents: 9500 });
    // Rows always add up to the period total.
    const sum = (k: "earnedCents" | "receivedCents") => r.byClient.reduce((t, x) => t + x[k], 0);
    expect([sum("earnedCents"), sum("receivedCents")]).toEqual([r.total.earnedCents, r.total.receivedCents]);
  });

  it("a single month narrows the client and product views", () => {
    const r = buildReport({ lines, payments, year: 2026, month: 4 });
    expect(r.total).toMatchObject({ earnedCents: 19000, receivedCents: 0, outstandingCents: 19000 });
    expect(r.byClient.map((x) => [x.key, x.earnedCents])).toEqual([["client:a", 20000], ["client:b", -1000]]);
    expect(r.months).toHaveLength(12);
  });

  it("allocates to the cent", () => {
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocate(1001, [500, 500]).reduce((a, b) => a + b)).toBe(1001);
    expect(allocate(9500, [20000, -1000])).toEqual([10000, -500]);
    expect(allocate(100, [])).toEqual([]);
  });

  it("ADP's fiscal quarters run July–June and pay ~45 days after quarter end", () => {
    expect(adpFiscalQuarter("2026-11-05")).toMatchObject({ fy: 2027, q: 2, start: "2026-10-01", end: "2026-12-31", expectedPaymentBy: "2027-02-14" });
    expect(adpFiscalQuarter("2026-07-01")).toMatchObject({ fy: 2027, q: 1, end: "2026-09-30", expectedPaymentBy: "2026-11-14" });
    expect(adpFiscalQuarter("2026-02-28")).toMatchObject({ fy: 2026, q: 3, start: "2026-01-01", end: "2026-03-31" });
    expect(adpFiscalQuarter("2026-06-30")).toMatchObject({ fy: 2026, q: 4, start: "2026-04-01", end: "2026-06-30" });
  });

  it("the service report uses only counted lines and payments (removed, deleted and archived are left out)", async () => {
    const o = await office();
    const { statement, line, payment } = await seeded(o);
    await svc.matchPayment(o.tab, payment.id, statement.id);
    const gone = await svc.createStatement(o.tab, header({ periodLabel: "Deleted one", statementDate: "2026-10-21" }));
    await svc.addLine(o.tab, gone.id, { type: "BONUS", amountCents: 99999 });
    await svc.archiveStatement(o.tab, gone.id, "Entered twice");
    const p2 = await svc.createPayment(o.tab, { receivedOn: "2026-11-20", amountCents: 7777, method: "CHECK" });
    await svc.archivePayment(o.tab, p2.id, "Bounced");
    let r = await svc.adpReport(o.tab, { year: 2026 });
    expect(r.yearTotal).toMatchObject({ earnedCents: 50000, receivedCents: 50000, outstandingCents: 0 });
    expect(r.byClient.map((c) => c.label).sort()).toEqual(["Fictional Bluebird Bakery LLC", "Fictional Maple Dental"]);
    expect(r.byProduct.map((c) => c.label).sort()).toEqual(["Not linked to a referral", "RUN Powered by ADP"]);
    await svc.removeLine(o.tab, line.id, "Duplicate");
    r = await svc.adpReport(o.tab, { year: 2026 });
    expect(r.yearTotal.earnedCents).toBe(10000);
    // The whole payment now sits on the remaining line.
    expect(r.byClient.find((c) => c.label === "Fictional Maple Dental")).toMatchObject({ earnedCents: 10000, receivedCents: 50000, outstandingCents: -40000 });
  });
});

describe("CSV import mapping", () => {
  const grid = [
    ["Client", "Description", "Amount", "Memo"],
    ["BLUEBIRD BAKERY", "Residual", "$45.00", "Q1"],
    ["MAPLE ST DENTAL", "Commission", "1,200.00", ""],
    ["MAPLE ST DENTAL", "Chargeback adjustment", "(15.00)", "one employee"],
    ["", "", "", ""],
    ["TOTAL", "", "1230.00", ""],
    ["ODD CO", "Mystery", "10.00", ""],
    ["BAD AMOUNT", "Bonus", "ten dollars", ""],
  ];

  it("applies only the columns the owner chose, flags rows it can't read, and lets her untick rows", () => {
    const m: CsvMapping = { headerRow: true, amount: 2, type: 1, fixedType: null, name: 0, note: 3 };
    const rows = mapCsvRows(grid, m, [6]);
    expect(rows.map((r) => r.rowNumber)).toEqual([2, 3, 4, 6, 7, 8]); // the blank row is skipped
    expect(rows[0]).toMatchObject({ include: true, name: "BLUEBIRD BAKERY", type: "RESIDUAL", amountCents: 4500, note: "Q1", error: null });
    expect(rows[1]).toMatchObject({ type: "COMMISSION", amountCents: 120000 });
    expect(rows[2]).toMatchObject({ type: "ADJUSTMENT", amountCents: -1500, include: true });
    expect(rows[3]).toMatchObject({ rowNumber: 6, include: false }); // the TOTAL row has no type, so it's refused
    expect(rows[3].error).toContain("isn't Commission");
    expect(rows[4].error).toContain("“Mystery”");
    expect(rows[5].error).toContain("“ten dollars” isn't an amount");
    // One type for every row instead of a type column.
    const fixed = mapCsvRows(grid, { ...m, type: null, fixedType: "RESIDUAL" }, [6]);
    expect(fixed.find((r) => r.rowNumber === 4)).toMatchObject({ error: "Only adjustments can be negative", include: false });
    expect(fixed.find((r) => r.rowNumber === 6)).toMatchObject({ include: false, error: null }); // unticked by the owner
  });

  it("requires the mapping to be chosen (nothing is guessed)", () => {
    expect(() => mapCsvRows(grid, { headerRow: true, amount: 9, type: 1, fixedType: null, name: null, note: null })).toThrow("amount");
    expect(() => mapCsvRows(grid, { headerRow: true, amount: 2, type: null, fixedType: null, name: null, note: null })).toThrow("line type");
    expect(parseLineType("Residual payment")).toBe("RESIDUAL");
    expect(parseLineType("Commission bonus")).toBeNull(); // two candidates: ambiguous, so refused
  });

  it("previews without saving, then imports only the confirmed rows with the owner's referral links", async () => {
    const o = await office();
    const referral = await svc.createReferral(o.tab, { clientId: o.bakery.id, referredOn: "2026-02-10", product: "RUN" });
    const s = await svc.createStatement(o.tab, header({ reportedTotalCents: 123000 }));
    const csvText = grid.map((r) => r.map((c) => (c.includes(",") ? `"${c}"` : c)).join(",")).join("\n");
    const first = await svc.previewLineImport(o.tab, { csvText });
    expect(first.headers).toEqual(["Client", "Description", "Amount", "Memo"]);
    expect(first.rows).toBeNull();
    const mapping: CsvMapping = { headerRow: true, amount: 2, type: 1, fixedType: null, name: 0, note: 3 };
    const preview = await svc.previewLineImport(o.tab, { csvText, mapping, excluded: [] });
    expect(preview.rows!.filter((r) => r.include)).toHaveLength(3);
    expect(await prisma.adpStatementLine.count()).toBe(0);

    // A tampered referral id is refused; the owner's own link is kept.
    await expect(svc.importLines(o.tab, s.id, { csvText, mapping, links: { "maple st dental": "nope" } })).rejects.toThrow("referral wasn't found");
    const r = await svc.importLines(o.tab, s.id, { csvText, mapping, excluded: [4], links: { "bluebird bakery": referral.id }, fileName: "fictional-adp.csv" });
    expect(r).toEqual({ count: 2, totalCents: 124500 });
    const lines = await prisma.adpStatementLine.findMany({ where: { statementId: s.id }, orderBy: { sortOrder: "asc" } });
    expect(lines.map((l) => [l.adpName, l.type, l.amountCents, l.referralId])).toEqual([
      ["BLUEBIRD BAKERY", "RESIDUAL", 4500, referral.id],
      ["MAPLE ST DENTAL", "COMMISSION", 120000, null],
    ]);
    const log = await prisma.ownerAuditLog.findFirstOrThrow({ where: { action: "adp.statement.lines_imported" } });
    expect(log.details).toMatchObject({ count: 2, excludedRows: [4], fileName: "fictional-adp.csv", linked: 1 });
  });
});

describe("statement file upload", () => {
  it("keeps PDF/CSV/XLSX in the owner-only store and refuses the same file twice (sha256)", async () => {
    const o = await office();
    const bytes = pdf("dedupe");
    const a = await svc.createStatement(o.tab, { ...header(), file: { bytes, originalName: "ADP Q1.pdf" } });
    expect(a.fileKey).toMatch(/^owner_private\/adp\/statements\/[0-9a-f]{32}$/);
    expect(a.fileSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(a.fileMime).toBe("application/pdf");
    // Stored encrypted at rest; it opens to the original bytes.
    const stored = (await storage.get(a.fileKey!))!;
    expect(looksEncrypted(stored)).toBe(true);
    expect(openStoredBytes(stored)).toEqual(bytes);

    const dup = svc.createStatement(o.tab, { ...header({ periodLabel: "Another" }), file: { bytes, originalName: "renamed.pdf" } });
    await expect(dup).rejects.toThrow("already uploaded with the statement “ADP FY2027 Q1 (FICTIONAL)”");
    const b = await svc.createStatement(o.tab, header({ periodLabel: "Second" }));
    await expect(svc.attachStatementFile(o.tab, b.id, { bytes, originalName: "again.pdf" })).rejects.toThrow("already uploaded");
    expect(await prisma.adpStatement.count({ where: { fileSha256: a.fileSha256 } })).toBe(1);

    // The duplicate's bytes weren't left behind in the store.
    expect(await prisma.adpStatement.count()).toBe(2);
    // CSV and XLSX are accepted; anything else isn't.
    const csv = await svc.attachStatementFile(o.tab, b.id, { bytes: new TextEncoder().encode("Client,Amount\nFictional,1.00\n"), originalName: "adp.csv" });
    expect(csv.fileMime).toBe("text/csv");
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    await expect(svc.createStatement(o.tab, { ...header({ periodLabel: "Image" }), file: { bytes: png, originalName: "adp.png" } })).rejects.toThrow("PDF, CSV or Excel");

    // After the first statement is deleted, its file may be uploaded again.
    await svc.archiveStatement(o.tab, a.id, "Entered under the wrong period");
    const c = await svc.createStatement(o.tab, { ...header({ periodLabel: "Re-entered" }), file: { bytes, originalName: "ADP Q1.pdf" } });
    expect(c.fileSha256).toBe(a.fileSha256);
    expect(c.fileKey).not.toBe(a.fileKey);
    const audits = await prisma.ownerAuditLog.findMany({ where: { action: { in: ["adp.statement.created", "adp.statement.file_attached"] } } });
    // a, b, the CSV on b and c — the refused uploads wrote nothing.
    expect(audits.length).toBe(4);
  });
});

describe("soft delete", () => {
  it("referrals, statements, lines and payments are archived with a reason, kept, audited, and no longer counted", async () => {
    const o = await office();
    const { referral, statement, line, payment } = await seeded(o);
    await expect(svc.archiveReferral(o.tab, referral.id, "")).rejects.toThrow("at least 3 characters");
    await svc.archiveReferral(o.tab, referral.id, "Duplicate referral");
    await svc.removeLine(o.tab, line.id, "Entered twice");
    await svc.archivePayment(o.tab, payment.id, "Recorded in error");
    await svc.archiveStatement(o.tab, statement.id, "Wrong period");

    for (const [model, id, reason] of [
      [prisma.adpReferral, referral.id, "Duplicate referral"],
      [prisma.adpStatementLine, line.id, "Entered twice"],
      [prisma.adpPayment, payment.id, "Recorded in error"],
      [prisma.adpStatement, statement.id, "Wrong period"],
    ] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const row = await (model as any).findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({ archivedById: o.tab.id, archivedReason: reason });
      expect(row.archivedAt).toBeInstanceOf(Date);
    }
    expect(await svc.listReferrals(o.tab)).toHaveLength(0);
    expect((await svc.listReferrals(o.tab, { archived: true }))[0].archivedReason).toBe("Duplicate referral");
    expect(await svc.listStatements(o.tab)).toHaveLength(0);
    expect(await svc.listPayments(o.tab)).toHaveLength(0);
    expect((await svc.adpReport(o.tab, { year: 2026 })).allTime).toMatchObject({ earnedCents: 0, receivedCents: 0 });
    // Deleted things can't be changed or deleted again.
    await expect(svc.archivePayment(o.tab, payment.id, "Again")).rejects.toThrow("Not found.");
    await expect(svc.addLine(o.tab, statement.id, { type: "BONUS", amountCents: 1 })).rejects.toThrow("Not found.");
    await expect(svc.updateReferral(o.tab, referral.id, { prospectName: "X", referredOn: "2026-01-01", product: "RUN" })).rejects.toThrow("Not found.");
    const logged = (await prisma.ownerAuditLog.findMany({ where: { action: { endsWith: "deleted" } } })).map((a) => [a.action, (a.details as { reason: string; soft: boolean }).soft]);
    expect(logged.sort()).toEqual([["adp.payment.deleted", true], ["adp.referral.deleted", true], ["adp.statement.deleted", true], ["adp.statement.line_deleted", true]]);
  });
});

describe("referrals", () => {
  it("links existing clients only (never creates one), allows a prospect name, and links the client later", async () => {
    const o = await office();
    const clients = await prisma.client.count();
    await expect(svc.createReferral(o.tab, { referredOn: "2026-01-01", product: "RUN" })).rejects.toThrow("prospect's name");
    await expect(svc.createReferral(o.tab, { clientId: "not-a-client", referredOn: "2026-01-01", product: "RUN" })).rejects.toThrow("clients are never created here");
    await expect(svc.createReferral(o.tab, { prospectName: "FICTIONAL Co", referredOn: "2026-01-01", product: "OTHER" })).rejects.toThrow("which ADP product");
    const r = await svc.createReferral(o.tab, { prospectName: "FICTIONAL Northwind Florist", referredOn: "2026-10-05", product: "OTHER", productOther: "ADP TotalSource", adpReference: "FICT-1" });
    expect(svc.referralName(r)).toBe("FICTIONAL Northwind Florist (prospect)");
    await svc.updateReferral(o.tab, r.id, { clientId: o.dental.id, prospectName: "FICTIONAL Northwind Florist", referredOn: "2026-10-05", product: "RUN" });
    const after = await svc.getReferral(o.tab, r.id);
    expect(after).toMatchObject({ clientId: o.dental.id, prospectName: "FICTIONAL Northwind Florist", product: "RUN", productOther: null });
    expect(await prisma.client.count()).toBe(clients);
    const log = await prisma.ownerAuditLog.findFirstOrThrow({ where: { action: "adp.referral.updated" } });
    expect(log.details).toMatchObject({ clientLinked: true });
    await prisma.client.update({ where: { id: o.bakery.id }, data: { archivedAt: new Date() } });
    await expect(svc.createReferral(o.tab, { clientId: o.bakery.id, referredOn: "2026-01-01", product: "RUN" })).rejects.toThrow("isn't in the client list");
  });

  it("saves the editable fiscal-quarter note", async () => {
    const o = await office();
    expect((await svc.fiscalNote(o.tab)).isDefault).toBe(true);
    await svc.saveFiscalNote(o.tab, "ADP FY = Jul–Jun. FICTIONAL note.");
    expect(await svc.fiscalNote(o.tab)).toMatchObject({ text: "ADP FY = Jul–Jun. FICTIONAL note.", isDefault: false });
    signedIn = o.tab;
    expect(await html(ReportsPage({ searchParams: Promise.resolve({ year: "2026" }) }))).toContain("FICTIONAL note.");
  });
});

describe("fictional demo seed", () => {
  const seed = (env: Record<string, string>) => {
    try {
      execFileSync("npx", ["tsx", "prisma/adp-demo-seed.ts"], { env: { ...process.env, CONTEXT: "", NETLIFY: "", NODE_ENV: "development", ...env }, stdio: "pipe" });
      return { code: 0, out: "" };
    } catch (e) {
      const err = e as { status: number; stderr: Buffer };
      return { code: err.status, out: err.stderr.toString() };
    }
  };
  it("refuses production, Netlify and non-local databases", () => {
    expect(seed({ DATABASE_URL: "postgresql://u:p@db.example.com:5432/prod" })).toMatchObject({ code: 1, out: expect.stringContaining("not a local database") });
    expect(seed({ DATABASE_URL: "postgresql://u:p@localhost.evil.example.com:5432/x" })).toMatchObject({ code: 1, out: expect.stringContaining("not a local database") });
    expect(seed({ DATABASE_URL: "postgresql://crm:crm@localhost:5432/crm_test", NODE_ENV: "production" })).toMatchObject({ code: 1, out: expect.stringContaining("production") });
    expect(seed({ DATABASE_URL: "postgresql://crm:crm@localhost:5432/crm_test", NETLIFY: "true" })).toMatchObject({ code: 1, out: expect.stringContaining("Netlify") });
  }, 60_000);
});
