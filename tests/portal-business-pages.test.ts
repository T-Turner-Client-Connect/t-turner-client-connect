import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { makeUser, prisma, resetDb } from "./db";
import type { Actor } from "@/lib/auth/actor";
import { ForbiddenError } from "@/lib/auth/actor";
import type { PortalActor } from "@/lib/portal/session";
import { createClient } from "@/lib/services/clients";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { setupLedger } from "@/lib/services/ledger";
import { addCustomer, createInvoice, issueInvoice, recordInvoicePayment, voidInvoice } from "@/lib/services/client-invoicing";
import { portalUploadDocument } from "@/lib/services/documents";
import { licenseStatus, licensesPageFor, payrollPageFor, portalLicensesPage, portalPayrollPage, portalYearEndPage, upcomingPayDates, yearEndPageFor } from "@/lib/services/portal-business-pages";
import { clientInvoicingFor, CUSTOMER_INVOICE_SUBJECT, portalClientInvoicing, previewClientInvoicing, requestCustomerInvoice } from "@/lib/services/portal-client-invoicing";
import { businessDashboardFor } from "@/lib/services/portal-business";
import { OWNER_PREVIEW_PERMS } from "@/lib/portal/views";
import { InvoicingPageView, LicensesPageView, NotBusinessNotice, PayrollPageView, YearEndPageView } from "@/components/portal/business-pages";
import { BusinessDashboardView } from "@/components/portal/business-dashboard";

/**
 * The portal pages behind the business dashboard's cards: Payroll, Business Licenses, 1099 / W-2
 * and Client Invoicing (Your Customers). Fictional businesses, people and amounts only.
 */

let staff: Actor | null = null;
let portalLogin: PortalActor | null = null;
vi.mock("@/lib/auth/session", async (orig) => ({ ...(await orig<object>()), requireUser: async () => staff, getCurrentUser: async () => staff }));
// The dashboard's month picker is a client component that needs the app router.
vi.mock("next/navigation", async (orig) => ({ ...(await orig<object>()), useRouter: () => ({ push: () => {}, refresh: () => {} }) }));
vi.mock("@/lib/portal/session", async (orig) => ({ ...(await orig<object>()), requirePortalUser: async () => portalLogin, getPortalUser: async () => portalLogin }));
const { default: PayrollPage } = await import("@/app/client/(secure)/payroll/page");
const { default: LicensesPage } = await import("@/app/client/(secure)/licenses/page");
const { default: YearEndPage } = await import("@/app/client/(secure)/year-end/page");
const { default: InvoicingPage } = await import("@/app/client/(secure)/invoicing/page");
const { default: PortalHome } = await import("@/app/client/(secure)/page");
// View as Client: the client's own pages under a signed preview cookie (see tests/vac-harness.ts).
vi.mock("next/headers", async () => (await import("./vac-harness")).headersMock);
const { h } = await import("./vac-harness");
const { previewCookieValue, previewLogins, VAC_COOKIE } = await import("@/lib/portal/viewer");
/** Starts View as Client of a client (its primary owner login, as the start route picks) for the signed-in staff member. */
const viewAsClient = async (clientId: string) => {
  h.jar.clear();
  h.jar.set(VAC_COOKIE, previewCookieValue({ staffId: staff!.id, clientId, loginId: (await previewLogins(clientId))[0]?.id ?? null }));
};

const PDF = () => new TextEncoder().encode(`%PDF-1.4\n% fictional ${Math.random()}\n`);

beforeEach(async () => {
  await resetDb();
  h.jar.clear();
  staff = null;
  portalLogin = null;
});

/** The first element of a component type anywhere in a rendered server-component tree. */
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
const actor = (u: { id: string; name: string; email: string }): PortalActor => ({ id: u.id, name: u.name, email: u.email });

async function world() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  staff = tabitha;
  const bakery = await createClient(tabitha, { businessName: "Lakeside Pretend Bakery LLC", clientType: "BUSINESS", status: "ACTIVE", assignedToId: tabitha.id });
  const other = await createClient(tabitha, { businessName: "Other Fictional Hauling LLC", clientType: "BUSINESS", status: "ACTIVE", assignedToId: tabitha.id });
  // Both on the Bookkeeping Client list: an OWNER login gets the business view, a contact doesn't.
  await prisma.bookkeepingProfile.create({ data: { clientId: bakery.id, accountingBasis: "CASH", payroll: true, payrollProvider: "Gusto", payrollFrequency: "BIWEEKLY", payrollPayDate: new Date("2026-10-30T00:00:00Z"), payrollAccessStatus: "ACCOUNTANT_ACCESS" } });
  await prisma.bookkeepingProfile.create({ data: { clientId: other.id, accountingBasis: "CASH", payroll: true, payrollProvider: "ADP", payrollFrequency: "MONTHLY", payrollPayDate: new Date("2026-10-15T00:00:00Z") } });
  const { token } = await invitePortalUser(tabitha, bakery.id, { email: "pat@fictional.example", name: "Pat Pretend", role: "OWNER" });
  const pat = actor(await acceptPortalInvite(token!, "Pat-Strong-Pass-12345"));
  const { token: t2 } = await invitePortalUser(tabitha, bakery.id, { email: "casey@fictional.example", name: "Casey Contact", role: "AUTHORIZED_CONTACT" });
  const casey = actor(await acceptPortalInvite(t2!, "Casey-Strong-Pass-12345"));
  const { token: t3 } = await invitePortalUser(tabitha, other.id, { email: "sam@fictional.example", name: "Sam Sample", role: "OWNER" });
  const sam = actor(await acceptPortalInvite(t3!, "Sam-Strong-Pass-12345"));
  return { tabitha, bakery, other, pat, casey, sam };
}

let fileN = 0;
async function doc(clientId: string, data: { title: string; category: "PAYROLL" | "BOOKKEEPING" | "OTHER" | "CLIENT_UPLOADS"; docType?: string; visibility?: "PUBLISHED" | "STAFF_ONLY"; scanStatus?: "CLEAN" | "NOT_SCANNED"; year?: number; month?: number }) {
  fileN++;
  const file = await prisma.storedFile.create({ data: { kind: "CLIENT_DOCUMENT", storageKey: `test/pages-${fileN}.pdf`, originalName: `f${fileN}.pdf`, title: data.title, mimeType: "application/pdf", sizeBytes: 10 } });
  return prisma.document.create({ data: { clientId, fileId: file.id, title: data.title, category: data.category, docType: data.docType ?? null, visibility: data.visibility ?? "PUBLISHED", publishedAt: new Date("2026-10-20T15:00:00Z"), scanStatus: data.scanStatus ?? "CLEAN", year: data.year ?? 2026, month: data.month ?? null } });
}

const html = (el: ReactElement) => renderToStaticMarkup(el);
const link = (id: string) => `/api/documents/test-${id}`;

describe("Payroll page", () => {
  it("an owner of an active bookkeeping client sees the profile, schedule, history and only released payroll documents", async () => {
    const { bakery, other, pat, tabitha } = await world();
    const released = await doc(bakery.id, { title: "Q3 2026 Form 941 (fictional)", category: "PAYROLL", year: 2026 });
    const report = await doc(bakery.id, { title: "October payroll register (fictional)", category: "OTHER", docType: "PAYROLL_REPORT", year: 2026, month: 10 });
    // A bookkeeping-category file reaches the client only as an approved report (clientReceivableWhere).
    await doc(bakery.id, { title: "Unreleased bookkeeping payroll summary", category: "BOOKKEEPING", docType: "PAYROLL_REPORT" });
    await doc(bakery.id, { title: "Staff-only payroll worksheet", category: "PAYROLL", visibility: "STAFF_ONLY" });
    await doc(bakery.id, { title: "Unscanned payroll file", category: "PAYROLL", scanStatus: "NOT_SCANNED" });
    await doc(bakery.id, { title: "Bakery bank statement", category: "OTHER", docType: "BANK_STATEMENT" });
    const otherDoc = await doc(other.id, { title: "Hauling 941 (fictional)", category: "PAYROLL" });
    await prisma.payrollRun.createMany({
      data: [
        { clientId: bakery.id, provider: "GUSTO", dedupeKey: "k1", checkDate: new Date("2026-10-16T00:00:00Z"), status: "PROCESSED", createdById: tabitha.id },
        { clientId: bakery.id, provider: "GUSTO", dedupeKey: "k2", checkDate: new Date("2026-10-30T00:00:00Z"), status: "SUBMITTED", createdById: tabitha.id },
        { clientId: bakery.id, provider: "GUSTO", dedupeKey: "k3", checkDate: new Date("2026-11-13T00:00:00Z"), status: "DRAFT", createdById: tabitha.id },
        { clientId: other.id, provider: "ADP_RUN", dedupeKey: "k4", checkDate: new Date("2026-10-15T00:00:00Z"), status: "PROCESSED", createdById: tabitha.id },
      ],
    });

    const d = await portalPayrollPage(pat, bakery.id);
    expect(d.client.name).toBe("Lakeside Pretend Bakery LLC");
    expect(d.profile).toMatchObject({ provider: "Gusto", frequency: "Every two weeks", status: "On Schedule", reports: "Accountant access granted" });
    // The same next pay date the dashboard card shows.
    const dash = await businessDashboardFor(bakery.id, null, { canUpload: true, canMessage: true, canViewBilling: false }, null);
    expect(d.profile!.next).toBe(dash.payroll!.next);
    expect(d.schedule[0]).toBe(dash.payroll!.next);
    expect(d.schedule).toHaveLength(4);
    // History: the business's own runs, never office drafts.
    expect(d.history.map((h) => h.payDate)).toEqual(["2026-10-30", "2026-10-16"]);
    expect(d.history[1].status).toBe("Processed by provider");
    // Released, scanned-clean payroll documents of this business only.
    expect(d.documents.map((x) => x.id).sort()).toEqual([released.id, report.id].sort());
    expect(JSON.stringify(d)).not.toContain(otherDoc.id);
    expect(JSON.stringify(d)).not.toMatch(/Hauling|Staff-only|Unscanned|bank statement|Unreleased/);

    const out = html(createElement(PayrollPageView, { d, linkFor: link, back: "/client" }));
    expect(out).toContain("Q3 2026 Form 941 (fictional)");
    expect(out).toContain(`/api/documents/test-${released.id}`);
    expect(out).not.toContain('data-testid="payroll-docs-empty"');
  });

  it("an authorized contact without the business view is refused, and the page shows the business-account notice", async () => {
    const { bakery, casey } = await world();
    await expect(portalPayrollPage(casey, bakery.id)).rejects.toBeInstanceOf(ForbiddenError);
    portalLogin = casey;
    const tree = (await PayrollPage({ searchParams: Promise.resolve({ account: bakery.id }) })) as ReactNode;
    expect(find(tree, NotBusinessNotice)).not.toBeNull();
    expect(find(tree, PayrollPageView)).toBeNull();
  });

  it("another business's payroll is never visible", async () => {
    const { bakery, other, pat, sam } = await world();
    await expect(portalPayrollPage(pat, other.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(portalPayrollPage(sam, bakery.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await portalPayrollPage(sam, other.id)).profile?.provider).toBe("ADP");
  });

  it("renders friendly empty states with no payroll data", async () => {
    const { bakery, pat } = await world();
    await prisma.bookkeepingProfile.update({ where: { clientId: bakery.id }, data: { payroll: false } });
    portalLogin = pat;
    const tree = (await PayrollPage({ searchParams: Promise.resolve({ account: bakery.id }) })) as ReactNode;
    const view = find(tree, PayrollPageView)!;
    expect(view).not.toBeNull();
    const out = html(view as ReactElement);
    expect(out).toContain('data-testid="payroll-not-set-up"');
    expect(out).toContain('data-testid="payroll-history-empty"');
    expect(out).toContain('data-testid="payroll-docs-empty"');
    expect((view.props as { back: string }).back).toBe(`/client?account=${bakery.id}`);
  });

  it("pay dates follow the frequency from the known pay date", () => {
    expect(upcomingPayDates("2026-10-30", "BIWEEKLY", "2026-11-05")).toEqual(["2026-11-13", "2026-11-27", "2026-12-11", "2026-12-25"]);
    expect(upcomingPayDates("2026-10-15", "MONTHLY", "2026-11-05", 2)).toEqual(["2026-11-15", "2026-12-15"]);
    expect(upcomingPayDates(null, "WEEKLY", "2026-11-05")).toEqual([]);
  });
});

describe("Business Licenses page", () => {
  it("an owner sees each license with jurisdiction, status and renewal date, and released license documents; never staff notes", async () => {
    const { bakery, other, pat, tabitha } = await world();
    await prisma.businessLicense.createMany({
      data: [
        { clientId: bakery.id, name: "City business license (fictional)", jurisdiction: "City of Pretendville", licenseNumber: "BL-0001", renewalDate: new Date("2026-12-01T00:00:00Z"), note: "Internal: call the clerk", createdById: tabitha.id },
        { clientId: bakery.id, name: "Food service permit (fictional)", jurisdiction: "Sample County", renewalDate: new Date("2026-09-30T00:00:00Z"), createdById: tabitha.id },
        { clientId: bakery.id, name: "Archived permit", archivedAt: new Date(), createdById: tabitha.id },
        { clientId: other.id, name: "Hauling permit (fictional)", createdById: tabitha.id },
      ],
    });
    const copy = await doc(bakery.id, { title: "City license 2026 (fictional)", category: "OTHER", docType: "BUSINESS_LICENSE" });
    await doc(other.id, { title: "Hauling license copy", category: "OTHER", docType: "BUSINESS_LICENSE" });

    const d = await portalLicensesPage(pat, bakery.id);
    expect(d.licenses.map((l) => l.name)).toEqual(["Food service permit (fictional)", "City business license (fictional)"]);
    expect(d.licenses[1]).toMatchObject({ jurisdiction: "City of Pretendville", renewal: "2026-12-01", number: "BL-0001" });
    expect(d.expired).toBe(1);
    expect(d.documents.map((x) => x.id)).toEqual([copy.id]);
    const json = JSON.stringify(d);
    expect(json).not.toMatch(/Internal: call the clerk|Hauling|Archived permit/);
    const out = html(createElement(LicensesPageView, { d, linkFor: link, back: "/client" }));
    expect(out).toContain("City of Pretendville");
    expect(out).toContain("Expired");
  });

  it("license status comes from the renewal date", () => {
    expect(licenseStatus(null, "2026-11-05")).toBe("NO_DATE");
    expect(licenseStatus("2026-11-04", "2026-11-05")).toBe("EXPIRED");
    expect(licenseStatus("2026-12-15", "2026-11-05")).toBe("RENEWS_SOON");
    expect(licenseStatus("2027-06-01", "2026-11-05")).toBe("CURRENT");
  });

  it("refuses an authorized contact without the business view and another business's owner; empty state renders", async () => {
    const { bakery, casey, sam, pat } = await world();
    await expect(portalLicensesPage(casey, bakery.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(portalLicensesPage(sam, bakery.id)).rejects.toBeInstanceOf(ForbiddenError);
    portalLogin = casey;
    expect(find((await LicensesPage({ searchParams: Promise.resolve({ account: bakery.id }) })) as ReactNode, NotBusinessNotice)).not.toBeNull();
    const out = html(createElement(LicensesPageView, { d: await portalLicensesPage(pat, bakery.id), linkFor: link, back: null }));
    expect(out).toContain('data-testid="licenses-empty"');
    expect(out).toContain('data-testid="license-docs-empty"');
  });
});

describe("1099 / W-2 page", () => {
  it("an owner sees the year-end stage, forms requested and received, and can upload against a request", async () => {
    const { bakery, other, pat, tabitha } = await world();
    await prisma.yearEndFiling.create({ data: { clientId: bakery.id, taxYear: 2025, stage: "CONTRACTOR_REVIEW", note: "Internal: three contractors missing W-9s", updatedById: tabitha.id } });
    await prisma.yearEndFiling.create({ data: { clientId: other.id, taxYear: 2025, stage: "FILED", updatedById: tabitha.id } });
    const w2 = await prisma.documentRequest.create({ data: { clientId: bakery.id, kind: "YEAR_END", taxYear: 2025, title: "2025 W-2s issued to employees", docType: "FORM_W2_ISSUED", reason: "Needed for the 2025 year-end tax filings.", createdById: tabitha.id } });
    await prisma.documentRequest.create({ data: { clientId: bakery.id, kind: "YEAR_END", taxYear: 2025, title: "2025 1099-NEC forms", docType: "NEC_1099", createdById: tabitha.id } });
    await prisma.documentRequest.create({ data: { clientId: bakery.id, kind: "YEAR_END", taxYear: 2025, title: "Draft — not sent", status: "DRAFT", createdById: tabitha.id } });
    await prisma.documentRequest.create({ data: { clientId: bakery.id, kind: "YEAR_END", taxYear: 2025, title: "Cancelled request", status: "CANCELLED", createdById: tabitha.id } });
    await prisma.documentRequest.create({ data: { clientId: other.id, kind: "YEAR_END", taxYear: 2025, title: "Hauling W-2s", createdById: tabitha.id } });

    let d = await portalYearEndPage(pat, bakery.id);
    expect(d.years).toHaveLength(1);
    const y = d.years[0];
    expect(y).toMatchObject({ taxYear: 2025, stage: "CONTRACTOR_REVIEW", stageLabel: "Contractor Review in Progress", step: 1, requested: 2, received: 0 });
    expect(y.items.map((i) => i.title).sort()).toEqual(["2025 1099-NEC forms", "2025 W-2s issued to employees"]);
    expect(JSON.stringify(d)).not.toMatch(/Internal: three|Draft — not sent|Cancelled request|Hauling/);
    expect(d.canUpload).toBe(true);
    const out = html(createElement(YearEndPageView, { d, canUpload: true, back: "/client" }));
    expect(out).toContain(`data-testid="upload-${w2.id}"`);

    // The existing request upload flow: the file is linked to the request, which is then received.
    await portalUploadDocument(pat, { clientId: bakery.id, requestId: w2.id, bytes: PDF(), originalName: "w2s-2025.pdf" });
    d = await portalYearEndPage(pat, bakery.id);
    expect(d.years[0].received).toBe(1);
    expect(d.years[0].items.find((i) => i.id === w2.id)!.status).toBe("UPLOADED");
  });

  it("refuses an authorized contact without the business view and other businesses; empty state renders", async () => {
    const { bakery, casey, sam, pat } = await world();
    await expect(portalYearEndPage(casey, bakery.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(portalYearEndPage(sam, bakery.id)).rejects.toBeInstanceOf(ForbiddenError);
    portalLogin = casey;
    expect(find((await YearEndPage({ searchParams: Promise.resolve({ account: bakery.id }) })) as ReactNode, NotBusinessNotice)).not.toBeNull();
    const d = await portalYearEndPage(pat, bakery.id);
    expect(d.years).toEqual([]);
    expect(html(createElement(YearEndPageView, { d, canUpload: true, back: null }))).toContain('data-testid="year-end-empty"');
  });

  it("the read-only View as Client version shows the client's upload, turned off (it posts only to the preview stand-in)", async () => {
    const { bakery, tabitha } = await world();
    await prisma.yearEndFiling.create({ data: { clientId: bakery.id, taxYear: 2025, stage: "FORMS_PREPARED", updatedById: tabitha.id } });
    const r = await prisma.documentRequest.create({ data: { clientId: bakery.id, kind: "YEAR_END", taxYear: 2025, title: "2025 W-2s", createdById: tabitha.id } });
    const out = html(createElement(YearEndPageView, { d: await yearEndPageFor(bakery.id), canUpload: true, back: null, readOnly: true }));
    expect(out).toContain(`upload-${r.id}`);
    expect(out).toContain('data-testid="preview-disabled"');
    expect(out).toMatch(/<fieldset[^>]*disabled=""/);
    expect(out).toContain("Turned off in View as Client");
  });
});

describe("Client Invoicing — Your Customers", () => {
  async function books(w: Awaited<ReturnType<typeof world>>) {
    await setupLedger(w.tabitha, w.bakery.id, { basis: "CASH" });
    await setupLedger(w.tabitha, w.other.id, { basis: "CASH" });
    const sales = (await prisma.ledgerAccount.findFirstOrThrow({ where: { clientId: w.bakery.id, code: "4000" } })).id;
    const cust = await addCustomer(w.tabitha, w.bakery.id, { name: "Pretend Cafe Co (fictional)" });
    const paid = await createInvoice(w.tabitha, w.bakery.id, { customerId: cust.id, issueDate: "2026-09-01", dueDate: "2026-09-30", lines: [{ description: "Wholesale bread", unitPrice: "400", incomeAccountId: sales }] });
    await issueInvoice(w.tabitha, w.bakery.id, paid.id);
    await recordInvoicePayment(w.tabitha, w.bakery.id, paid.id, { amount: "400", receivedOn: "2026-09-20", method: "CHECK", reference: "2201" });
    const open = await createInvoice(w.tabitha, w.bakery.id, { customerId: cust.id, issueDate: "2026-10-01", dueDate: "2026-10-31", lines: [{ description: "Pastry trays", unitPrice: "250", incomeAccountId: sales }] });
    await issueInvoice(w.tabitha, w.bakery.id, open.id);
    const voided = await createInvoice(w.tabitha, w.bakery.id, { customerId: cust.id, issueDate: "2026-10-05", dueDate: "2026-11-30", lines: [{ description: "Cancelled order", unitPrice: "90", incomeAccountId: sales }] });
    await issueInvoice(w.tabitha, w.bakery.id, voided.id);
    await voidInvoice(w.tabitha, w.bakery.id, voided.id, { date: "2026-10-06", reason: "Order cancelled" });
    const draft = await createInvoice(w.tabitha, w.bakery.id, { customerId: cust.id, issueDate: "2026-11-01", dueDate: "2026-11-30", lines: [{ description: "Office draft", unitPrice: "75", incomeAccountId: sales }] });
    const otherSales = (await prisma.ledgerAccount.findFirstOrThrow({ where: { clientId: w.other.id, code: "4000" } })).id;
    const oc = await addCustomer(w.tabitha, w.other.id, { name: "Hauling Customer (fictional)" });
    const oi = await createInvoice(w.tabitha, w.other.id, { customerId: oc.id, issueDate: "2026-10-01", dueDate: "2026-10-15", lines: [{ description: "Hauling", unitPrice: "999", incomeAccountId: otherSales }] });
    await issueInvoice(w.tabitha, w.other.id, oi.id);
    return { cust, paid, open, voided, draft, oi };
  }

  it("an owner sees their invoices (never office drafts), payment history and totals", async () => {
    const w = await world();
    const b = await books(w);
    const d = await portalClientInvoicing(w.pat, w.bakery.id);
    expect(d.invoices.map((i) => i.number)).toEqual([b.voided.number, b.open.number, b.paid.number]);
    expect(d.invoices.find((i) => i.id === b.open.id)).toMatchObject({ customer: "Pretend Cafe Co (fictional)", issued: "2026-10-01", due: "2026-10-31", totalCents: 25000, balanceCents: 25000, status: "OPEN" });
    expect(d.invoices.find((i) => i.id === b.paid.id)).toMatchObject({ status: "PAID", balanceCents: 0 });
    expect(d.invoices.find((i) => i.id === b.voided.id)!.status).toBe("VOID");
    expect(d.payments).toHaveLength(1);
    expect(d.payments[0]).toMatchObject({ receivedOn: "2026-09-20", amountCents: 40000, method: "Check", invoice: b.paid.number, customer: "Pretend Cafe Co (fictional)" });
    expect(d.totals).toMatchObject({ openCents: 25000, openCount: 1, collectedYtdCents: 40000 });
    expect(d.customers.map((c) => c.name)).toEqual(["Pretend Cafe Co (fictional)"]);
    const json = JSON.stringify(d);
    expect(json).not.toContain(b.draft.id);
    expect(json).not.toMatch(/Hauling|Office draft|feeCents|stripe/i);
    // Overdue is read from the invoice's own due date.
    expect((await clientInvoicingFor(w.bakery.id, "2026-11-05")).invoices.find((i) => i.id === b.open.id)!.display).toBe("OVERDUE");
    expect((await clientInvoicingFor(w.bakery.id, "2026-10-15")).invoices.find((i) => i.id === b.open.id)!.display).toBe("OPEN");
    const out = html(createElement(InvoicingPageView, { d, back: "/client" }));
    expect(out).toContain("Pretend Cafe Co (fictional)");
    expect(out).toContain('data-testid="send-invoice-request"');
  });

  it("an authorized contact without the business view is refused; other businesses are never visible", async () => {
    const w = await world();
    await books(w);
    await expect(portalClientInvoicing(w.casey, w.bakery.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(portalClientInvoicing(w.sam, w.bakery.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(portalClientInvoicing(w.pat, w.other.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(requestCustomerInvoice(w.casey, { clientId: w.bakery.id, customerName: "X", amount: "10", description: "x", dueDate: "2099-01-01" })).rejects.toBeInstanceOf(ForbiddenError);
    expect((await portalClientInvoicing(w.sam, w.other.id)).invoices.map((i) => i.customer)).toEqual(["Hauling Customer (fictional)"]);
    portalLogin = w.casey;
    expect(find((await InvoicingPage({ searchParams: Promise.resolve({ account: w.bakery.id }) })) as ReactNode, NotBusinessNotice)).not.toBeNull();
  });

  it("empty states render with no invoices or payments", async () => {
    const w = await world();
    const d = await portalClientInvoicing(w.pat, w.bakery.id);
    expect(d.invoices).toEqual([]);
    const out = html(createElement(InvoicingPageView, { d, back: null }));
    expect(out).toContain('data-testid="invoices-empty"');
    expect(out).toContain('data-testid="payments-empty"');
  });

  it("an invoice request creates the office request (a portal message with a staff alert) but no invoice", async () => {
    const w = await world();
    const b = await books(w);
    const invoicesBefore = await prisma.clientInvoice.count();
    const r = await requestCustomerInvoice(w.pat, { clientId: w.bakery.id, customerId: b.cust.id, amount: "1,250.00", description: "December holiday orders", dueDate: "2099-12-15", idempotencyKey: "fictional-key-1" });
    const convo = await prisma.conversation.findUniqueOrThrow({ where: { id: r.conversationId }, include: { messages: true } });
    expect(convo.clientId).toBe(w.bakery.id);
    expect(convo.subject).toBe(`${CUSTOMER_INVOICE_SUBJECT} from Pat Pretend for Lakeside Pretend Bakery LLC: Pretend Cafe Co (fictional), $1,250.00`);
    expect(convo.awaitingStaff).toBe(true);
    expect(convo.messages).toHaveLength(1);
    expect(convo.messages[0]).toMatchObject({ channel: "PORTAL", direction: "INBOUND", portalAuthorId: w.pat.id });
    expect(convo.messages[0].body).toContain("Due date: Dec 15, 2099");
    expect(convo.messages[0].body).toContain("For: December holiday orders");
    expect(convo.unreadByStaff).toBe(true); // in the office's shared inbox (staff alert queued when alerts are configured)
    expect(await prisma.auditLog.count({ where: { action: "client_invoice_request.created", entityId: r.conversationId } })).toBe(1);
    // No invoice of any kind was created or sent.
    expect(await prisma.clientInvoice.count()).toBe(invoicesBefore);
    expect(await prisma.invoice.count()).toBe(0);
    expect(await prisma.invoiceRequest.count()).toBe(0);
    // A retry with the same key doesn't duplicate it; the page lists it.
    expect((await requestCustomerInvoice(w.pat, { clientId: w.bakery.id, customerId: b.cust.id, amount: "1250", description: "December holiday orders", dueDate: "2099-12-15", idempotencyKey: "fictional-key-1" })).conversationId).toBe(r.conversationId);
    const d = await portalClientInvoicing(w.pat, w.bakery.id);
    expect(d.requests.map((x) => x.id)).toEqual([r.conversationId]);
    // A new customer by name works too.
    await requestCustomerInvoice(w.pat, { clientId: w.bakery.id, customerName: "Brand New Diner (fictional)", amount: "80", description: "Bread", dueDate: "2099-01-10" });
    expect(await prisma.clientInvoice.count()).toBe(invoicesBefore);
  });

  it("validates the request and never accepts another business's customer", async () => {
    const w = await world();
    const b = await books(w);
    const base = { clientId: w.bakery.id, amount: "100", description: "Bread", dueDate: "2099-01-01" };
    const otherCustomer = await prisma.invoiceCustomer.findFirstOrThrow({ where: { clientId: w.other.id } });
    await expect(requestCustomerInvoice(w.pat, { ...base, customerId: otherCustomer.id })).rejects.toThrow(/Choose one of your customers/);
    await expect(requestCustomerInvoice(w.pat, { ...base, customerName: "" })).rejects.toThrow(/who the invoice is for/);
    await expect(requestCustomerInvoice(w.pat, { ...base, customerId: b.cust.id, amount: "abc" })).rejects.toThrow(/valid amount/);
    await expect(requestCustomerInvoice(w.pat, { ...base, customerId: b.cust.id, amount: "0" })).rejects.toThrow(/amount to invoice/);
    await expect(requestCustomerInvoice(w.pat, { ...base, customerId: b.cust.id, description: "  " })).rejects.toThrow(/Describe/);
    await expect(requestCustomerInvoice(w.pat, { ...base, customerId: b.cust.id, dueDate: "2020-01-01" })).rejects.toThrow(/past/);
    await expect(requestCustomerInvoice(w.pat, { ...base, customerId: b.cust.id, dueDate: "soon" })).rejects.toThrow(/due/);
    await expect(requestCustomerInvoice(w.sam, { ...base, clientId: w.bakery.id, customerName: "X" })).rejects.toBeInstanceOf(ForbiddenError);
    // A login without messaging can view invoices but not request one.
    await prisma.portalAccess.updateMany({ where: { portalUserId: w.pat.id, clientId: w.bakery.id }, data: { canMessage: false } });
    await expect(requestCustomerInvoice(w.pat, { ...base, customerId: b.cust.id })).rejects.toBeInstanceOf(ForbiddenError);
    expect((await portalClientInvoicing(w.pat, w.bakery.id)).canRequest).toBe(false);
    expect(await prisma.conversation.count()).toBe(0);
  });
});

describe("Dashboard links and View as Client", () => {
  it("the dashboard cards link to the new pages for the account in view", async () => {
    const { bakery } = await world();
    await prisma.businessLicense.create({ data: { clientId: bakery.id, name: "City license (fictional)", createdById: staff!.id } });
    const d = await businessDashboardFor(bakery.id, null, { canUpload: true, canMessage: true, canViewBilling: false }, null);
    const q = `?account=${bakery.id}`;
    const out = html(createElement(BusinessDashboardView, { d, tiles: [], q, base: `/client${q}`, linkFor: link, personalQ: null }));
    const hrefOf = (testId: string) => new RegExp(`<a[^>]*data-testid="${testId}"[^>]*href="([^"]*)"`).exec(out)?.[1]?.replace(/&amp;/g, "&");
    expect(hrefOf("view-payroll")).toBe(`/client/payroll${q}`);
    expect(hrefOf("view-licenses")).toBe(`/client/licenses${q}`);
    expect(hrefOf("view-year-end")).toBe(`/client/year-end${q}`);
    expect(hrefOf("view-invoices")).toBe(`/client/invoicing${q}`);
    expect(hrefOf("payment-history")).toBe(`/client/invoicing${q}#payments`);
    expect(hrefOf("request-invoice")).toBe(`/client/invoicing${q}#request`);
  });

  it("View as Client opens the client's own pages, read-only, with staff document links", async () => {
    const { bakery } = await world();
    await doc(bakery.id, { title: "Q3 2026 Form 941 (fictional)", category: "PAYROLL" });
    await viewAsClient(bakery.id);
    const dash = find((await PortalHome({ searchParams: Promise.resolve({ account: bakery.id }) })) as ReactNode, BusinessDashboardView)!;
    const props = dash.props as { previewHref: (p: string) => string | null; tiles: { testId: string; href: string | null }[] };
    // Every card opens the client's own page; the preview stays on through the cookie.
    const q = `?account=${bakery.id}`;
    expect(props.previewHref("/client/payroll")).toBe(`/client/payroll${q}`);
    expect(props.previewHref("/client/licenses")).toBe(`/client/licenses${q}`);
    expect(props.previewHref("/client/year-end")).toBe(`/client/year-end${q}`);
    expect(props.previewHref("/client/invoicing")).toBe(`/client/invoicing${q}`);
    expect(props.previewHref("/client/payroll-approval")).toBe(`/client/payroll-approval${q}`);
    expect(props.tiles.find((t) => t.testId === "biz-payroll")?.href).toBe(`/client/payroll${q}`);

    const sp = { searchParams: Promise.resolve({ account: bakery.id }) };
    const payroll = find((await PayrollPage(sp)) as ReactNode, PayrollPageView)!;
    const pd = payroll.props as { d: Awaited<ReturnType<typeof payrollPageFor>>; linkFor: (id: string) => string };
    expect(pd.d.documents).toHaveLength(1);
    expect(pd.linkFor("doc-1")).toMatch(/^\/api\/documents\/doc-1\.s:/);
    expect(find((await LicensesPage(sp)) as ReactNode, LicensesPageView)).not.toBeNull();
    expect((find((await YearEndPage(sp)) as ReactNode, YearEndPageView)!.props as { readOnly: boolean }).readOnly).toBe(true);
    const inv = find((await InvoicingPage(sp)) as ReactNode, InvoicingPageView)!;
    expect((inv.props as { readOnly: boolean }).readOnly).toBe(true);
    // The request form shows as the client sees it, disabled, with the note.
    const markup = html(inv as ReactElement);
    expect(markup).toContain('data-testid="preview-off"');
    expect(markup).toContain('data-testid="preview-disabled"');
    expect(await previewClientInvoicing(bakery.id)).toMatchObject({ invoices: [], requests: [] });
    expect(await licensesPageFor(bakery.id, OWNER_PREVIEW_PERMS, null)).toMatchObject({ licenses: [] });
  });

  it("a regular tax client's preview shows the business-account notice for these views", async () => {
    const { tabitha } = await world();
    const pat = await createClient(tabitha, { firstName: "Riley", lastName: "Fictional", clientType: "INDIVIDUAL", status: "ACTIVE" });
    await viewAsClient(pat.id);
    const tree = (await PayrollPage({ searchParams: Promise.resolve({ account: pat.id }) })) as ReactNode;
    expect(find(tree, NotBusinessNotice)).not.toBeNull();
    expect(find(tree, PayrollPageView)).toBeNull();
  });
});
