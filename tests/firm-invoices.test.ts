import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, resetDb } from "./db";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import { hashPassword } from "@/lib/auth/password";
import { claimOwnerOffice, grantOwnerAccess } from "@/lib/auth/owner";
import { createClient, setArchived } from "@/lib/services/clients";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { savePaymentInstruction } from "@/lib/services/installment-plans";
import { invoiceRows, issueInvoice, monthlySummary, offerQuote, portalBilling, receivables, recordPayment, todayYmd, voidInvoice } from "@/lib/services/owner-billing";
import {
  approveAndSend,
  createFirmInvoice,
  firmInvoiceDoc,
  invoiceClientChoices,
  invoiceHistory,
  markInvoiceViewed,
  returnToDraft,
  setRefundTransferFeeNote,
  setSquareLinksEnabled,
  submitForApproval,
  updateFirmInvoice,
  type FirmInvoiceInput,
} from "@/lib/services/firm-invoices";
import { invoiceStatus, isSquarePaymentUrl } from "@/lib/billing/invoice-status";
import { addMonths } from "@/lib/billing/pricing";

/** Fictional office and clients only. Nothing here reaches Square, Resend or a phone. */
const PASSWORD = "Owner-Strong-Pass-1";
const today = todayYmd();
const lastMonth = addMonths(today, -1);
const nextMonth = addMonths(today, 1);

const emails: { url: string; body: { to: string[]; subject: string } }[] = [];
const fakeFetch = async (url: string | URL, init?: RequestInit) => {
  const u = String(url);
  if (u.startsWith("https://mail.test/")) {
    emails.push({ url: u, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ id: `em_${emails.length}` }), { status: 200 });
  }
  throw new Error(`Unexpected network call in a test: ${u}`);
};

beforeEach(async () => {
  await resetDb();
  emails.length = 0;
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("EMAIL_FROM_ADDRESS", "Office <office@example.com>");
  vi.stubEnv("RESEND_API_BASE", "https://mail.test");
  vi.stubEnv("NOTIFICATIONS_ENABLED", "true");
  vi.stubEnv("SQUARE_ACCESS_TOKEN", "");
  vi.stubGlobal("fetch", fakeFetch);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function staffAccount(email: string, name: string, role: "ADMIN" | "STAFF"): Promise<Actor> {
  const u = await prisma.user.create({ data: { email, name, role, passwordHash: await hashPassword(PASSWORD), mfaEnabledAt: new Date() } });
  return { id: u.id, role: u.role, name: u.name, email: u.email };
}

/** Tabitha (owner), Daria (authorized billing staff), Marcus (staff with no billing access). */
async function office() {
  const tab = await staffAccount("tabitha@tturnerassociates.com", "Tabitha", "ADMIN");
  const daria = await staffAccount("daria@tturnerassociates.com", "Daria", "STAFF");
  const marcus = await staffAccount("marcus@tturnerassociates.com", "Marcus", "STAFF");
  await claimOwnerOffice(tab, PASSWORD);
  await grantOwnerAccess(tab, { userId: daria.id, scope: "BILLING", password: PASSWORD });
  // The owner approves these methods for business use (Venmo stays unapproved).
  await savePaymentInstruction(tab, "ZELLE", { details: "Send to: Tabitha Turner\nPhone: 205-420-1825", active: true });
  await savePaymentInstruction(tab, "CASH_APP", { details: "Send to: $TThompson25", active: true });
  await savePaymentInstruction(tab, "CASH", { details: "Cash is accepted in our office only.", active: true });
  await savePaymentInstruction(tab, "SQUARE_INVOICE", { details: "Pay by card through the secure Square link.", active: true });
  await savePaymentInstruction(tab, "REFUND_TRANSFER", { details: "Eligible tax returns only.", active: true });
  return { tab, daria, marcus };
}

async function clients(staff: Actor) {
  const rosa = await createClient(staff, { firstName: "Rosa", lastName: "Fictional", clientType: "INDIVIDUAL", status: "ACTIVE", email: "rosa.fictional@example.com", phone: "205-555-0142", addressLine1: "12 Sample Lane", city: "Bessemer", state: "AL", postalCode: "35020" });
  const other = await createClient(staff, { businessName: "Other Fictional LLC", clientType: "BUSINESS", status: "ACTIVE" });
  const join = async (clientId: string, email: string) => {
    const { token } = await invitePortalUser(staff, clientId, { email, name: email.split("@")[0], role: "OWNER" });
    const u = await acceptPortalInvite(token!, "Portal-Pass-123");
    return { id: u.id, name: u.name, email: u.email };
  };
  return { rosa, other, rosaUser: await join(rosa.id, "rosa.portal@example.com"), otherUser: await join(other.id, "other.portal@example.com") };
}

const input = (clientId: string, over: Partial<FirmInvoiceInput> = {}): FirmInvoiceInput => ({
  clientId,
  service: "Tax Preparation",
  amountCents: 45000,
  description: "2025 federal and Alabama individual returns",
  issueDate: today,
  dueDate: nextMonth,
  privateNote: "INTERNAL-ONLY: discount discussed by phone",
  offeredMethods: ["ZELLE", "CASH_APP", "CASH"],
  ...over,
});

describe("Create Invoice: client selection and numbering", () => {
  it("fills the client's name, billing contact and client ID from the master record", async () => {
    const { tab, daria, marcus } = await office();
    const { rosa, other } = await clients(tab);
    await prisma.contact.create({ data: { clientId: other.id, name: "Pat Billing", email: "billing@other.example.com", phone: "205-555-0199" } });
    const choices = await invoiceClientChoices(daria);
    expect(choices.find((c) => c.id === rosa.id)).toMatchObject({ name: "Rosa Fictional", email: "rosa.fictional@example.com", phone: "(205) 555-0142", address: "12 Sample Lane\nBessemer, AL 35020" });
    const inv = await createFirmInvoice(daria, input(rosa.id));
    expect(inv).toMatchObject({ clientId: rosa.id, formType: "INVOICE", state: "DRAFT", title: "Tax Preparation", billingName: "Rosa Fictional", billingEmail: "rosa.fictional@example.com", billingPhone: "(205) 555-0142", billingAddress: "12 Sample Lane\nBessemer, AL 35020" });
    // A business with no email of its own uses its first contact's.
    const biz = await createFirmInvoice(tab, input(other.id, { service: "Bookkeeping" }));
    expect(biz).toMatchObject({ billingName: "Other Fictional LLC", billingEmail: "billing@other.example.com", billingPhone: "205-555-0199" });
    // Only existing, active clients can be invoiced.
    await expect(createFirmInvoice(tab, input("not-a-client"))).rejects.toThrow(/Choose a client/);
    await setArchived(tab, other.id, true);
    await expect(createFirmInvoice(tab, input(other.id))).rejects.toThrow(/Choose a client/);
    expect((await invoiceClientChoices(tab)).some((c) => c.id === other.id)).toBe(false);
    // Staff without owner/billing access can't see the client list for invoicing or create one.
    await expect(invoiceClientChoices(marcus)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createFirmInvoice(marcus, input(rosa.id))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("numbers invoices automatically and never repeats a number, even when created at once", async () => {
    const { tab, daria } = await office();
    const { rosa } = await clients(tab);
    const year = today.slice(0, 4);
    const made = await Promise.all(Array.from({ length: 8 }, (_, i) => createFirmInvoice(i % 2 ? daria : tab, input(rosa.id, { amountCents: 1000 + i }))));
    const numbers = made.map((m) => m.number).sort();
    expect(new Set(numbers).size).toBe(8);
    expect(numbers[0]).toBe(`INV-${year}-0001`);
    expect(numbers[7]).toBe(`INV-${year}-0008`);
    // The next number follows the highest one, not a count, so a gap can't cause a repeat.
    await prisma.invoice.update({ where: { id: made[0].id }, data: { number: `INV-${year}-0050` } });
    expect((await createFirmInvoice(tab, input(rosa.id))).number).toBe(`INV-${year}-0051`);
    // The database itself refuses a duplicate number.
    await expect(prisma.invoice.update({ where: { id: made[1].id }, data: { number: `INV-${year}-0051` } })).rejects.toMatchObject({ code: "P2002" });
  });
});

describe("drafts, approval and permissions", () => {
  it("creates and edits drafts, with each edit in the history; sent invoices can't be edited", async () => {
    const { tab, daria } = await office();
    const { rosa } = await clients(tab);
    const inv = await createFirmInvoice(daria, input(rosa.id));
    await updateFirmInvoice(daria, inv.id, input(rosa.id, { amountCents: 52500, description: "2025 returns plus Schedule C", dueDate: addMonths(today, 2) }));
    const saved = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id }, include: { lines: true } });
    expect(saved.lines).toHaveLength(1);
    expect(saved.lines[0]).toMatchObject({ service: "Tax Preparation", unitCents: 52500, description: "2025 returns plus Schedule C" });
    expect(saved.number).toBe(inv.number);
    const hist = await invoiceHistory(tab, inv.id);
    expect(hist.map((h) => h.action)).toEqual(["Created as a draft", "Edited"]);
    expect(hist[1].details?.changed).toEqual(expect.arrayContaining(["amount", "description", "dueDate"]));
    expect(hist[1].who).toBe("Daria");
    // Validation: amount, description, dates and approved payment options.
    await expect(updateFirmInvoice(daria, inv.id, input(rosa.id, { amountCents: 0 }))).rejects.toThrow(/greater than \$0/);
    await expect(updateFirmInvoice(daria, inv.id, input(rosa.id, { description: " " }))).rejects.toThrow(/Describe/);
    await expect(updateFirmInvoice(daria, inv.id, input(rosa.id, { dueDate: lastMonth }))).rejects.toThrow(/before the invoice date/);
    await expect(updateFirmInvoice(daria, inv.id, input(rosa.id, { offeredMethods: ["VENMO"] }))).rejects.toThrow(/hasn't been approved/);
    await expect(updateFirmInvoice(daria, inv.id, input(rosa.id, { service: "Bookkeeping", offeredMethods: ["REFUND_TRANSFER"] }))).rejects.toThrow(/eligible tax returns only/);
    await approveAndSend(tab, inv.id);
    await expect(updateFirmInvoice(tab, inv.id, input(rosa.id))).rejects.toThrow(/Only drafts/);
  });

  it("staff submit drafts for approval but can't approve, void, record refunds or credits, or change settings", async () => {
    const { tab, daria } = await office();
    const { rosa, rosaUser } = await clients(tab);
    const inv = await createFirmInvoice(daria, input(rosa.id));
    await expect(approveAndSend(daria, inv.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(issueInvoice(daria, inv.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(offerQuote(daria, inv.id)).rejects.toBeInstanceOf(ForbiddenError);
    await submitForApproval(daria, inv.id);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).state).toBe("PENDING_APPROVAL");
    await expect(approveAndSend(daria, inv.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(voidInvoice(daria, inv.id, "no")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setSquareLinksEnabled(daria, true)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setRefundTransferFeeNote(daria, "$1")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(savePaymentInstruction(daria, "VENMO", { details: "x", active: true })).rejects.toBeInstanceOf(ForbiddenError);
    // While pending it can't be edited or seen by the client.
    await expect(updateFirmInvoice(daria, inv.id, input(rosa.id))).rejects.toThrow(/Only drafts/);
    expect(await portalBilling(rosaUser, rosa.id)).toHaveLength(0);
    // The owner sends it back; the staff member fixes and resubmits; the owner approves.
    await returnToDraft(tab, inv.id, "Please add the Schedule C");
    await updateFirmInvoice(daria, inv.id, input(rosa.id, { amountCents: 60000 }));
    await submitForApproval(daria, inv.id);
    await approveAndSend(tab, inv.id);
    const sent = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(sent).toMatchObject({ state: "ISSUED", approvedById: tab.id, submittedById: daria.id });
    expect(sent.publishedAt).not.toBeNull();
    // Billing staff record payments received (square-invoicing.test.ts); refunds and credits stay with the owner.
    await expect(recordPayment(daria, { invoiceId: inv.id, kind: "REFUND", status: "SUCCEEDED", amountCents: 100, receivedOn: today, method: "CASH" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(recordPayment(daria, { invoiceId: inv.id, kind: "CREDIT", status: "SUCCEEDED", amountCents: 100, receivedOn: today, method: "OTHER", note: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    expect((await invoiceHistory(tab, inv.id)).map((h) => h.action)).toEqual([
      "Created as a draft", "Submitted for owner approval", "Returned to draft", "Edited", "Submitted for owner approval", "Approved by the owner", "Sent to the client's portal",
    ]);
  });

  it("the owner's approval sends it: the client is emailed through sendEmail and sees it only then", async () => {
    const { tab } = await office();
    const { rosa, rosaUser } = await clients(tab);
    const inv = await createFirmInvoice(tab, input(rosa.id));
    expect(await portalBilling(rosaUser, rosa.id)).toHaveLength(0);
    expect(emails).toHaveLength(0);
    await approveAndSend(tab, inv.id);
    const [row] = await portalBilling(rosaUser, rosa.id);
    expect(row).toMatchObject({ id: inv.id, status: "SENT", totalCents: 45000, balanceCents: 45000 });
    expect(emails).toHaveLength(1);
    expect(emails[0].body.to).toEqual(["rosa.portal@example.com"]);
    expect(emails[0].body.subject).toMatch(/new invoice is available/i);
    // The notice holds no amount or invoice details.
    expect(JSON.stringify(emails[0].body)).not.toMatch(/450|INTERNAL|Tax Preparation/);
    // Sending twice is refused and doesn't email again.
    await expect(approveAndSend(tab, inv.id)).rejects.toThrow(/Only drafts/);
    expect(emails).toHaveLength(1);
    // If an approved method was turned off after the draft was made, approval stops.
    const later = await createFirmInvoice(tab, input(rosa.id, { offeredMethods: ["CASH_APP"] }));
    await savePaymentInstruction(tab, "CASH_APP", { details: "Send to: $TThompson25", active: false });
    await expect(approveAndSend(tab, later.id)).rejects.toThrow(/no longer approved/);
  });
});

describe("payments and balances", () => {
  it("tracks Sent → Viewed → Partially Paid → Paid, computes Overdue, and never over-collects", async () => {
    const { tab } = await office();
    const { rosa, rosaUser } = await clients(tab);
    const inv = await createFirmInvoice(tab, input(rosa.id, { amountCents: 40000 }));
    await approveAndSend(tab, inv.id);
    await markInvoiceViewed(rosaUser, inv.id);
    expect((await portalBilling(rosaUser, rosa.id))[0].status).toBe("VIEWED");
    await recordPayment(tab, { invoiceId: inv.id, kind: "PAYMENT", status: "SUCCEEDED", amountCents: 15000, receivedOn: today, method: "ZELLE", reference: "ZL-1001" });
    await recordPayment(tab, { invoiceId: inv.id, kind: "PAYMENT", status: "FAILED", amountCents: 25000, receivedOn: today, method: "CASH_APP", note: "Reversed" });
    let [row] = await invoiceRows(tab, { clientId: rosa.id });
    expect(row).toMatchObject({ status: "PARTIALLY_PAID", totalCents: 40000, collectedCents: 15000, balanceCents: 25000 });
    expect((await portalBilling(rosaUser, rosa.id))[0]).toMatchObject({ status: "PARTIALLY_PAID", balanceCents: 25000 });
    await expect(recordPayment(tab, { invoiceId: inv.id, kind: "PAYMENT", status: "SUCCEEDED", amountCents: 25001, receivedOn: today, method: "CASH" })).rejects.toThrow(/remaining balance of \$250.00/);
    await expect(recordPayment(tab, { invoiceId: inv.id, kind: "PAYMENT", status: "SUCCEEDED", amountCents: 100, receivedOn: nextMonth, method: "CASH" })).rejects.toThrow(/not in the future/);
    // An owner adjustment (credit) lowers the balance but isn't cash.
    await expect(recordPayment(tab, { invoiceId: inv.id, kind: "CREDIT", status: "SUCCEEDED", amountCents: 5000, receivedOn: today, method: "OTHER" })).rejects.toThrow(/reason/);
    await recordPayment(tab, { invoiceId: inv.id, kind: "CREDIT", status: "SUCCEEDED", amountCents: 5000, receivedOn: today, method: "OTHER", note: "Returning-client courtesy" });
    expect((await receivables(tab)).totalOutstandingCents).toBe(20000);
    const year = Number(today.slice(0, 4));
    const month = Number(today.slice(5, 7)) - 1;
    expect((await monthlySummary(tab, year)).months[month].collectedCents).toBe(15000);
    await recordPayment(tab, { invoiceId: inv.id, kind: "PAYMENT", status: "SUCCEEDED", amountCents: 20000, receivedOn: today, method: "CASH" });
    [row] = await invoiceRows(tab, { clientId: rosa.id });
    expect(row).toMatchObject({ status: "PAID", balanceCents: 0 });
    await expect(recordPayment(tab, { invoiceId: inv.id, kind: "PAYMENT", status: "SUCCEEDED", amountCents: 1, receivedOn: today, method: "CASH" })).rejects.toThrow(/remaining balance of \$0.00/);
    const doc = await firmInvoiceDoc({ number: inv.number, status: "PAID", issueDate: today, dueDate: nextMonth, billTo: { name: null, email: null, phone: null, address: null }, lines: [{ service: "Tax Preparation", description: "", quantity: 1, unitCents: 40000 }], totalCents: 40000, payments: (await prisma.payment.findMany({ where: { invoiceId: inv.id } })).map((p) => ({ ...p, receivedOn: today })), offeredMethods: [], squarePaymentUrl: null });
    expect(doc).toMatchObject({ paidCents: 35000, creditedCents: 5000, balanceCents: 0 });
    expect(doc.payments).toHaveLength(3); // the failed attempt isn't shown

    // Overdue: a balance past its due date.
    const late = await createFirmInvoice(tab, input(rosa.id, { issueDate: addMonths(today, -2), dueDate: lastMonth }));
    await approveAndSend(tab, late.id);
    expect((await invoiceRows(tab, { clientId: rosa.id })).find((r) => r.id === late.id)?.status).toBe("OVERDUE");
    expect(invoiceStatus({ state: "ISSUED", viewedAt: null, dueDate: lastMonth, totalCents: 100, appliedCents: 100 }, today)).toBe("PAID");
  });

  it("refuses duplicate payments: double submits, a reused reference, and the same amount/date/reference", async () => {
    const { tab } = await office();
    const { rosa } = await clients(tab);
    const a = await createFirmInvoice(tab, input(rosa.id, { amountCents: 90000 }));
    const b = await createFirmInvoice(tab, input(rosa.id, { amountCents: 90000 }));
    await approveAndSend(tab, a.id);
    await approveAndSend(tab, b.id);
    const pay = (over: Partial<Parameters<typeof recordPayment>[1]> = {}) => recordPayment(tab, { invoiceId: a.id, kind: "PAYMENT", status: "SUCCEEDED", amountCents: 10000, receivedOn: today, method: "ZELLE", reference: "ZL-77", idempotencyKey: "form-key-1", ...over });
    // The same form submitted twice at once records one payment.
    const results = await Promise.allSettled([pay(), pay()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: expect.objectContaining({ message: expect.stringMatching(/already recorded/) }) });
    // The same reference again — on this invoice or another of the client's — is refused.
    await expect(pay({ idempotencyKey: "form-key-2" })).rejects.toThrow(/already recorded|duplicate/);
    await expect(pay({ invoiceId: b.id, idempotencyKey: "form-key-3", reference: "zl-77" })).rejects.toThrow(/reference number is already recorded/);
    // Same amount, date and method with no reference: a duplicate.
    await pay({ reference: null, idempotencyKey: "k4", method: "CASH" });
    await expect(pay({ reference: null, idempotencyKey: "k5", method: "CASH" })).rejects.toThrow(/duplicate/);
    // A genuinely different payment (new reference) is fine.
    await pay({ reference: "ZL-78", idempotencyKey: "k6" });
    expect(await prisma.payment.count({ where: { invoiceId: a.id, status: "SUCCEEDED" } })).toBe(3);
    expect((await invoiceRows(tab, { clientId: rosa.id })).find((r) => r.id === a.id)?.balanceCents).toBe(60000);
  });
});

describe("client portal visibility", () => {
  it("shows a client only their own sent invoices, never drafts, internal notes or unapproved options", async () => {
    const { tab, daria } = await office();
    const { rosa, other, rosaUser, otherUser } = await clients(tab);
    const sent = await createFirmInvoice(daria, input(rosa.id, { offeredMethods: ["SQUARE_INVOICE", "ZELLE", "CASH", "REFUND_TRANSFER"], squarePaymentUrl: "https://square.link/u/FICTIONAL1" }));
    await createFirmInvoice(daria, input(rosa.id, { amountCents: 777 })); // draft
    const pending = await createFirmInvoice(daria, input(rosa.id, { amountCents: 888 }));
    await submitForApproval(daria, pending.id);
    const othersInvoice = await createFirmInvoice(tab, input(other.id, { service: "Bookkeeping", privateNote: "OTHER-CLIENT-SECRET" }));
    await approveAndSend(tab, sent.id);
    await approveAndSend(tab, othersInvoice.id);

    const mine = await portalBilling(rosaUser, rosa.id);
    expect(mine.map((r) => r.id)).toEqual([sent.id]);
    const json = JSON.stringify(mine);
    expect(json).not.toMatch(/INTERNAL-ONLY|OTHER-CLIENT-SECRET|privateNote|createdById|approvedById/);
    // Another client's login can't read this account, open this invoice, or mark it viewed.
    await expect(portalBilling(otherUser, rosa.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(markInvoiceViewed(otherUser, sent.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await portalBilling(otherUser, other.id)).map((r) => r.id)).toEqual([othersInvoice.id]);

    // Payment options: Square shows as not enabled (no link) until the owner turns links on AND Square is configured.
    const docOf = async () => {
      const [r] = await portalBilling(rosaUser, rosa.id);
      return firmInvoiceDoc({ ...r, lines: r.breakdown.lines });
    };
    let doc = await docOf();
    expect(doc.options.map((o) => o.method)).toEqual(["SQUARE_INVOICE", "ZELLE", "CASH", "REFUND_TRANSFER"]);
    expect(doc.options[0]).toMatchObject({ url: null, notEnabled: true });
    const rt = doc.options.find((o) => o.method === "REFUND_TRANSFER")!;
    expect(rt.sub).toBe("Eligible tax returns only, subject to staff approval and bank-product requirements");
    expect(rt.terms!.join(" ")).toMatch(/does not guarantee payment/);
    expect(rt.terms!.join(" ")).toMatch(/disclosures/);
    expect(rt.feeNote).toBeNull(); // no unconfirmed fee amounts
    expect(JSON.stringify(doc)).not.toMatch(/3\.5%|surcharge|INTERNAL-ONLY/);
    await setSquareLinksEnabled(tab, true);
    expect((await docOf()).options[0].url).toBeNull(); // Square isn't configured here
    vi.stubEnv("SQUARE_ACCESS_TOKEN", "sandbox-token");
    vi.stubEnv("SQUARE_LOCATION_ID", "L-FICTIONAL");
    vi.stubEnv("SQUARE_APPLICATION_ID", "sandbox-app");
    doc = await docOf();
    expect(doc.options[0]).toMatchObject({ url: "https://square.link/u/FICTIONAL1", notEnabled: false });
    await setRefundTransferFeeNote(tab, "Confirmed by our office: see Republic Bank's fee schedule.");
    expect((await docOf()).options.find((o) => o.method === "REFUND_TRANSFER")!.feeNote).toMatch(/Confirmed by our office/);
    // Only Square's own https pages can be attached.
    expect(isSquarePaymentUrl("https://square.link/u/abc")).toBe(true);
    expect(isSquarePaymentUrl("http://square.link/u/abc")).toBe(false);
    expect(isSquarePaymentUrl("https://square.link.evil.example/u")).toBe(false);
    await expect(createFirmInvoice(tab, input(rosa.id, { offeredMethods: ["SQUARE_INVOICE"], squarePaymentUrl: "https://evil.example/pay" }))).rejects.toThrow(/Square payment link/);
    // Viewing marks it Viewed once, with one history entry.
    await markInvoiceViewed(rosaUser, sent.id);
    await markInvoiceViewed(rosaUser, sent.id);
    expect((await invoiceHistory(tab, sent.id)).filter((h) => h.action === "Viewed by the client")).toHaveLength(1);
  });
});

describe("void", () => {
  it("only the owner voids; paid invoices must be refunded first; the client sees Voided with nothing owed", async () => {
    const { tab, daria } = await office();
    const { rosa, rosaUser } = await clients(tab);
    const draft = await createFirmInvoice(daria, input(rosa.id));
    await voidInvoice(tab, draft.id, "Created by mistake");
    expect(await portalBilling(rosaUser, rosa.id)).toHaveLength(0); // never sent, never shown

    const inv = await createFirmInvoice(daria, input(rosa.id, { amountCents: 30000 }));
    await approveAndSend(tab, inv.id);
    await recordPayment(tab, { invoiceId: inv.id, kind: "PAYMENT", status: "SUCCEEDED", amountCents: 10000, receivedOn: today, method: "CASH" });
    await expect(voidInvoice(daria, inv.id, "x")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(voidInvoice(tab, inv.id, "Wrong client")).rejects.toThrow(/Refund/);
    await recordPayment(tab, { invoiceId: inv.id, kind: "REFUND", status: "SUCCEEDED", amountCents: 10000, receivedOn: today, method: "CASH" });
    await expect(voidInvoice(tab, inv.id, " ")).rejects.toThrow(/reason/);
    await voidInvoice(tab, inv.id, "Wrong client");
    await expect(voidInvoice(tab, inv.id, "again")).rejects.toThrow(/Already void/);
    const [row] = await portalBilling(rosaUser, rosa.id);
    expect(row).toMatchObject({ id: inv.id, status: "VOIDED", balanceCents: 0 });
    expect((await receivables(tab)).totalOutstandingCents).toBe(0);
    await expect(recordPayment(tab, { invoiceId: inv.id, kind: "PAYMENT", status: "SUCCEEDED", amountCents: 100, receivedOn: today, method: "CASH" })).rejects.toThrow(/issued invoices only/);
    const hist = await invoiceHistory(tab, inv.id);
    expect(hist.map((h) => h.action)).toEqual(["Created as a draft", "Approved by the owner", "Sent to the client's portal", "Payment recorded", "Refund recorded", "Voided"]);
    expect(hist.at(-1)?.details?.reason).toBe("Wrong client");
  });
});
