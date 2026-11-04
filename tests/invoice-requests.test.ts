import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { grantPerms, prisma, resetDb } from "./db";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import { hashPassword } from "@/lib/auth/password";
import { claimOwnerOffice } from "@/lib/auth/owner";
import { applyPermissionPreset } from "@/lib/auth/permissions";
import { DARIA_PRESET } from "@/lib/permissions";
import { createClient } from "@/lib/services/clients";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { savePaymentInstruction } from "@/lib/services/installment-plans";
import { createService, prepareAgreement, sendAgreement } from "@/lib/services/service-agreements";
import { todayYmd } from "@/lib/services/owner-billing";
import { addMonths } from "@/lib/billing/pricing";
import { approveAndSend, createFirmInvoice, type FirmInvoiceInput } from "@/lib/services/firm-invoices";
import { conversationLabels, invoicePrefill, invoiceRequestCard, invoiceRequestChoices, LEGACY_SUBJECT, requestInvoice } from "@/lib/services/invoice-requests";
import { dispatchStaffAlerts } from "@/lib/services/staff-alerts";

/** Fictional office, clients and money. Nothing reaches Square, a phone or a real inbox. */
const PASSWORD = "Owner-Strong-Pass-1";
const today = todayYmd();
const lastYear = new Date().getFullYear() - 1;
vi.setConfig({ testTimeout: 30_000 });

const emails: { to: string[]; subject: string; text: string }[] = [];
beforeEach(async () => {
  await resetDb();
  emails.length = 0;
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("EMAIL_FROM_ADDRESS", "Office <office@example.com>");
  vi.stubEnv("RESEND_API_BASE", "https://mail.test");
  vi.stubEnv("APP_URL", "https://portal.example.test");
  vi.stubEnv("NOTIFICATIONS_ENABLED", "true");
  vi.stubEnv("SQUARE_ACCESS_TOKEN", "");
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    if (String(url).startsWith("https://mail.test/")) {
      emails.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ id: `em_${emails.length}` }), { status: 200 });
    }
    throw new Error(`Unexpected network call in a test: ${url}`);
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function staff(email: string, name: string, role: "ADMIN" | "STAFF"): Promise<Actor> {
  const u = await prisma.user.create({ data: { email, name, role, passwordHash: await hashPassword(PASSWORD), mfaEnabledAt: new Date() } });
  return { id: u.id, role: u.role, name: u.name, email: u.email };
}

async function setup() {
  const tab = await staff("tabitha@tturnerassociates.com", "Tabitha", "ADMIN");
  const daria = await staff("daria@tturnerassociates.example", "Daria", "STAFF");
  const marcus = await staff("marcus@tturnerassociates.example", "Marcus", "STAFF");
  await claimOwnerOffice(tab, PASSWORD);
  await applyPermissionPreset(tab, daria.id, DARIA_PRESET.key);
  await savePaymentInstruction(tab, "ZELLE", { details: "Send to: Tabitha Turner", active: true });
  const rosa = await createClient(tab, { firstName: "Rosa", lastName: "Fictional", clientType: "INDIVIDUAL", status: "ACTIVE", email: "rosa.fictional@example.com", phone: "205-555-0142" });
  const acme = await createClient(tab, { businessName: "Acme Fictional LLC", clientType: "BUSINESS", status: "ACTIVE", email: "acme@example.com" });
  const join = async (clientId: string, email: string, name: string) => {
    const { token } = await invitePortalUser(tab, clientId, { email, name, role: "OWNER" });
    const u = await acceptPortalInvite(token!, "Portal-Pass-123");
    return { id: u.id, name: u.name, email: u.email };
  };
  const rosaUser = await join(rosa.id, "rosa.portal@example.com", "Rosa Fictional");
  const pat = await join(acme.id, "pat.owner@example.com", "Pat Owner");
  // Rosa's 2025 return, with a price on the agreement she was sent.
  const svc = await createService(tab, { clientId: rosa.id, type: "TAX_INDIVIDUAL", taxYear: lastYear });
  const agr = await prepareAgreement(tab, svc.id, { lines: [{ label: "Federal and Alabama returns", cents: 40000 }] });
  await sendAgreement(tab, agr.id);
  const books = await createService(tab, { clientId: acme.id, type: "BOOKKEEPING", periodLabel: "January–December 2026" });
  return { tab, daria, marcus, rosa, acme, rosaUser, pat, svc, books };
}

const invoiceFor = (clientId: string, over: Partial<FirmInvoiceInput> = {}): FirmInvoiceInput => ({ clientId, service: "Tax Preparation", amountCents: 40000, description: "2025 returns", issueDate: today, dueDate: addMonths(today, 1), offeredMethods: ["ZELLE"], ...over });

describe("Pay with an Invoice: the request says who and what", () => {
  it("records who asked, for which client, the item, tax year, note and amount — and the message still lands in Communication History", async () => {
    const { rosa, rosaUser, svc } = await setup();
    const { choices } = await invoiceRequestChoices(rosaUser, rosa.id);
    expect(choices.map((c) => c.label)).toContain(svc.title);
    const r = await requestInvoice(rosaUser, { clientId: rosa.id, items: [{ kind: "SERVICE", ref: svc.id }], note: "Please split if possible", amountCents: 40000, idempotencyKey: "req-1" });
    expect(r).toMatchObject({ clientId: rosa.id, portalUserId: rosaUser.id, requesterName: "Rosa Fictional", requesterEmail: "rosa.portal@example.com", businessName: null, taxYear: lastYear, note: "Please split if possible", amountCents: 40000, status: "OPEN" });
    expect(r.items).toEqual([{ kind: "SERVICE", ref: svc.id, label: svc.title }]);
    const convo = await prisma.conversation.findUniqueOrThrow({ where: { id: r.conversationId! }, include: { messages: true } });
    expect(convo).toMatchObject({ clientId: rosa.id, awaitingStaff: true, unreadByStaff: true });
    expect(convo.subject).toBe(`Invoice request from Rosa Fictional for Rosa Fictional: ${svc.title}`);
    expect(convo.messages[0]).toMatchObject({ channel: "PORTAL", direction: "INBOUND", portalAuthorId: rosaUser.id });
    expect(convo.messages[0].body).toContain(`For: ${svc.title}`);
    expect(convo.messages[0].body).toContain("Amount (if known): $400.00");
    // A double tap doesn't make a second request.
    const again = await requestInvoice(rosaUser, { clientId: rosa.id, items: [{ kind: "SERVICE", ref: svc.id }], idempotencyKey: "req-1" });
    expect(again.id).toBe(r.id);
    expect(await prisma.invoiceRequest.count()).toBe(1);
  });

  it("requires a choice or a note, and Other needs a note", async () => {
    const { rosa, rosaUser } = await setup();
    await expect(requestInvoice(rosaUser, { clientId: rosa.id, items: [] })).rejects.toThrow(/pick an item or write a short note/);
    await expect(requestInvoice(rosaUser, { clientId: rosa.id, items: [{ kind: "OTHER", ref: null }] })).rejects.toThrow(/short note/);
    const r = await requestInvoice(rosaUser, { clientId: rosa.id, items: [{ kind: "OTHER", ref: null }], note: "Amended 2024 return", taxYear: lastYear - 1 });
    expect(r).toMatchObject({ note: "Amended 2024 return", taxYear: lastYear - 1 });
  });

  it("a client can't request an invoice for another client, or name another client's service", async () => {
    const { rosa, acme, rosaUser, pat, books } = await setup();
    await expect(requestInvoice(rosaUser, { clientId: acme.id, items: [{ kind: "OTHER", ref: null }], note: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(requestInvoice(rosaUser, { clientId: rosa.id, items: [{ kind: "SERVICE", ref: books.id }] })).rejects.toThrow(/from the list/);
    await expect(invoiceRequestChoices(pat, rosa.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await prisma.invoiceRequest.count()).toBe(0);
  });
});

describe("Staff see who and what, and can create the invoice", () => {
  it("names the requester and client everywhere; prices and invoices only for billing staff", async () => {
    const { daria, marcus, acme, pat, books } = await setup();
    const r = await requestInvoice(pat, { clientId: acme.id, items: [{ kind: "SERVICE", ref: books.id }], taxYear: lastYear });
    const labels = await conversationLabels([r.conversationId!]);
    expect(labels.get(r.conversationId!)).toMatchObject({ requestId: r.id, legacy: false, title: `Invoice request from Pat Owner for Acme Fictional LLC: ${books.title}, tax year ${lastYear}` });
    const card = (await invoiceRequestCard(daria, r.conversationId!))!;
    expect(card).toMatchObject({ requester: { name: "Pat Owner", email: "pat.owner@example.com" }, client: { id: acme.id, businessName: "Acme Fictional LLC" }, mayView: true, mayCreate: true, status: "OPEN" });
    expect(card.lines[0]).toMatchObject({ kind: "SERVICE", service: "Bookkeeping", priceCents: null });
    expect(card.invoices).not.toBeNull();
    // Marcus (no billing access) sees who and what, never prices or invoices, and no Create button.
    const m = (await invoiceRequestCard(marcus, r.conversationId!))!;
    expect(m).toMatchObject({ title: card.title, mayView: false, mayCreate: false, invoices: null });
    expect(m.lines[0].priceCents).toBeNull();
    expect(await invoicePrefill(marcus, { requestId: r.id })).toBeNull();
  });

  it("Create invoice prefills the client, service, agreed price and description", async () => {
    const { daria, rosa, rosaUser, svc } = await setup();
    const r = await requestInvoice(rosaUser, { clientId: rosa.id, items: [{ kind: "SERVICE", ref: svc.id }], note: "Thanks" });
    const p = (await invoicePrefill(daria, { requestId: r.id }))!;
    expect(p).toMatchObject({ clientId: rosa.id, service: "Tax Preparation", amount: "400.00", description: svc.title });
    expect(p.card.lines[0]).toMatchObject({ priceCents: 40000, priceNote: "Sent, not yet signed agreement v1" });
    // With no agreed price, the amount the client gave is used.
    const other = await requestInvoice(rosaUser, { clientId: rosa.id, items: [{ kind: "OTHER", ref: null }], note: "Notary", amountCents: 2500 });
    expect(await invoicePrefill(daria, { requestId: other.id })).toMatchObject({ amount: "25.00", service: "Other", description: "Notary" });
  });

  it("moves to Invoice created, then Invoice sent, and stops needing a reply — only after the normal send", async () => {
    const { tab, daria, rosa, rosaUser, acme, svc } = await setup();
    const r = await requestInvoice(rosaUser, { clientId: rosa.id, items: [{ kind: "SERVICE", ref: svc.id }] });
    // The request can't be attached to another client's invoice.
    await expect(createFirmInvoice(daria, invoiceFor(acme.id), { requestId: r.id })).rejects.toThrow(/different client/);
    const inv = await createFirmInvoice(daria, invoiceFor(rosa.id), { requestId: r.id });
    expect(await prisma.invoiceRequest.findUniqueOrThrow({ where: { id: r.id } })).toMatchObject({ status: "INVOICE_CREATED", invoiceId: inv.id });
    expect(await prisma.conversation.findUniqueOrThrow({ where: { id: r.conversationId! } })).toMatchObject({ awaitingStaff: true });
    expect((await conversationLabels([r.conversationId!])).get(r.conversationId!)?.status).toBe("INVOICE_CREATED");
    await expect(createFirmInvoice(daria, invoiceFor(rosa.id), { requestId: r.id })).rejects.toThrow(/already created/);
    // Nothing sent yet: the invoice is a draft and the client has no invoice notice.
    expect(inv.state).toBe("DRAFT");
    expect(await prisma.notification.count({ where: { kind: "NEW_INVOICE" } })).toBe(0);
    await approveAndSend(tab, inv.id);
    expect(await prisma.invoiceRequest.findUniqueOrThrow({ where: { id: r.id } })).toMatchObject({ status: "INVOICE_SENT" });
    expect(await prisma.conversation.findUniqueOrThrow({ where: { id: r.conversationId! } })).toMatchObject({ awaitingStaff: false });
    const notes = await prisma.message.findMany({ where: { conversationId: r.conversationId!, channel: "INTERNAL_NOTE" }, orderBy: { createdAt: "asc" } });
    expect(notes.map((n) => n.body)).toEqual([expect.stringContaining(`Invoice ${inv.number} was created`), expect.stringContaining(`Invoice ${inv.number} was sent`)]);
  });

  it("older generic requests still display as “details not given” with who and which client, and can be answered", async () => {
    const { daria, tab, rosa, rosaUser } = await setup();
    const convo = await prisma.conversation.create({ data: { clientId: rosa.id, subject: LEGACY_SUBJECT, awaitingStaff: true, unreadByStaff: true } });
    await prisma.message.create({ data: { conversationId: convo.id, channel: "PORTAL", direction: "INBOUND", body: "I'd like to pay with an invoice. Please send my invoice to my portal.", portalAuthorId: rosaUser.id, status: "DELIVERED" } });
    expect((await conversationLabels([convo.id])).get(convo.id)).toMatchObject({ title: "Invoice request (details not given) from Rosa Fictional for Rosa Fictional", legacy: true, requestId: null });
    const card = (await invoiceRequestCard(daria, convo.id))!;
    expect(card).toMatchObject({ legacy: true, requester: { name: "Rosa Fictional" }, client: { id: rosa.id }, createHref: `/owner/invoices/create?client=${rosa.id}&conversation=${convo.id}` });
    const inv = await createFirmInvoice(daria, invoiceFor(rosa.id), { conversationId: convo.id });
    const row = await prisma.invoiceRequest.findUniqueOrThrow({ where: { conversationId: convo.id } });
    expect(row).toMatchObject({ status: "INVOICE_CREATED", invoiceId: inv.id, requesterName: "Rosa Fictional", items: [] });
    expect((await conversationLabels([convo.id])).get(convo.id)?.title).toBe("Invoice request (details not given) from Rosa Fictional for Rosa Fictional");
    await approveAndSend(tab, inv.id);
    expect(await prisma.conversation.findUniqueOrThrow({ where: { id: convo.id } })).toMatchObject({ awaitingStaff: false });
  });

  it("the staff alert email names the client and links to the request — no amounts or details", async () => {
    const { rosa, rosaUser, svc } = await setup();
    const r = await requestInvoice(rosaUser, { clientId: rosa.id, items: [{ kind: "SERVICE", ref: svc.id }], amountCents: 40000 });
    await dispatchStaffAlerts(new Date(Date.now() + 60 * 60 * 1000));
    const mail = emails.find((e) => e.subject.startsWith("New client activity"))!;
    expect(mail.text).toContain(`Invoice request from Rosa Fictional`);
    expect(mail.text).toContain(`/clients/${rosa.id}?tab=messages&c=${r.conversationId}`);
    expect(mail.text).not.toContain("$400");
    expect(mail.text).not.toContain(svc.title);
  });

  it("staff without billing grants still can't create the invoice", async () => {
    const { marcus, rosa, rosaUser } = await setup();
    const r = await requestInvoice(rosaUser, { clientId: rosa.id, items: [{ kind: "OTHER", ref: null }], note: "Notary" });
    await expect(createFirmInvoice(marcus, invoiceFor(rosa.id), { requestId: r.id })).rejects.toBeInstanceOf(ForbiddenError);
    await grantPerms(marcus.id, ["billing.view"]);
    await expect(createFirmInvoice(marcus, invoiceFor(rosa.id), { requestId: r.id })).rejects.toBeInstanceOf(ForbiddenError);
  });
});
