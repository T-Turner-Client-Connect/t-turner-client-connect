import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { grantPerms, makeUser, managed, prisma, resetDb } from "./db";
import { elements, expand, find, functionProps, h, nextTarget, reset, signInPortal, startPreview, testIds, textOf } from "./vac-harness";
import { createClient } from "@/lib/services/clients";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { openMonth, setMonthPublished } from "@/lib/services/appointments";
import { chicagoLocalToUtc } from "@/lib/tz";

vi.mock("next/headers", async () => (await import("./vac-harness")).headersMock);
vi.mock("@/lib/auth/session", async (orig) => ({ ...(await orig<object>()), ...(await import("./vac-harness")).sessionMock }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("next/server", async (orig) => ({ ...(await orig<object>()), connection: async () => {} }));
vi.mock("next/navigation", async (orig) => ({ ...(await orig<object>()), useRouter: () => ({ push() {}, replace() {}, refresh() {} }), usePathname: () => "/client", useSearchParams: () => new URLSearchParams() }));

/**
 * View as Client: the staff member's screen becomes the client's own portal, read-only.
 * - Server-side read-only: every portal Server Action and /api/client write refuses a staff preview.
 * - The real client login works exactly as before (regression).
 * - The preview shows what the chosen login sees — same data, same menu, same exclusions — for
 *   tax-only, business-only and bookkeeping clients, and nothing of any other client.
 * Fictional data only.
 */

const viewer = await import("@/lib/portal/viewer");
const preview = await import("@/app/actions/preview");
const { PREVIEW_OFF } = await import("@/lib/portal/preview-off");
const { default: PortalLayout } = await import("@/app/client/(secure)/layout");
const { PortalNav } = await import("@/components/portal/portal-nav");

// Every portal-facing action module: none of these may be reachable from a preview page.
const ACTION_MODULES = {
  agreements: await import("@/app/actions/agreements"),
  appointments: await import("@/app/actions/appointments"),
  "business-owners": await import("@/app/actions/business-owners"),
  identity: await import("@/app/actions/identity"),
  "installment-plans": await import("@/app/actions/installment-plans"),
  "invoice-requests": await import("@/app/actions/invoice-requests"),
  notices: await import("@/app/actions/notices"),
  onboarding: await import("@/app/actions/onboarding"),
  "payroll-portal": await import("@/app/actions/payroll-portal"),
  "payroll-taxes-portal": await import("@/app/actions/payroll-taxes-portal"),
  "portal-billing": await import("@/app/actions/portal-billing"),
  "portal-invoicing": await import("@/app/actions/portal-invoicing"),
  portal: await import("@/app/actions/portal"),
  "refund-transfers": await import("@/app/actions/refund-transfers"),
  resources: await import("@/app/actions/resources"),
  "service-agreements": await import("@/app/actions/service-agreements"),
  signup: await import("@/app/actions/signup"),
  "tax-center": await import("@/app/actions/tax-center"),
  "tax-returns": await import("@/app/actions/tax-returns"),
  "tax-summary": await import("@/app/actions/tax-summary"),
  verification: await import("@/app/actions/verification"),
} as Record<string, Record<string, unknown>>;
const REAL_ACTION_NAMES = new Set(Object.values(ACTION_MODULES).flatMap((m) => Object.entries(m).filter(([, v]) => typeof v === "function").map(([k]) => k)));

// The portal actions that act for a signed-in client (they read the portal session).
const PORTAL_ACTIONS: [string, string][] = [
  ["agreements", "portalSignAction"], ["agreements", "portalDeclineAction"],
  ["appointments", "bookAppointmentAction"], ["appointments", "rescheduleAppointmentAction"], ["appointments", "cancelAppointmentByClientAction"], ["appointments", "answerProposalAction"],
  ["business-owners", "portalRequestPersonalTaxAction"],
  ["identity", "portalIdentityUploadAction"], ["identity", "portalAddPersonAction"], ["identity", "portalRemovePersonAction"],
  ["installment-plans", "portalRequestPlanAction"], ["installment-plans", "portalAcceptPlanAction"], ["installment-plans", "portalChooseMethodAction"],
  ["invoice-requests", "requestInvoiceAction"],
  ["notices", "submitNoticeAction"], ["notices", "requestTaxYearAction"],
  ["onboarding", "eligibilityAction"], ["onboarding", "businessInfoAction"], ["onboarding", "businessDocumentAction"], ["onboarding", "paymentMethodAction"], ["onboarding", "acceptTermsAction"],
  ["payroll-portal", "portalPayrollDecisionAction"], ["payroll-portal", "portalNotifyChannelAction"],
  ["payroll-taxes-portal", "submitPortalHoursAction"],
  ["portal-billing", "acceptQuoteAction"], ["portal-billing", "declineQuoteAction"],
  ["portal-invoicing", "requestCustomerInvoiceAction"],
  ["portal", "portalMessageAction"], ["portal", "portalUploadAction"], ["portal", "portalJointFilingAction"], ["portal", "portalMarkReadAction"], ["portal", "portalPrefsAction"], ["portal", "portalCommPrefsAction"], ["portal", "revokeDeviceAction"], ["portal", "removeAuthenticatorAction"], ["portal", "acknowledgeLetterAction"],
  ["refund-transfers", "requestRefundTransferAction"],
  ["resources", "setStateAction"], ["resources", "resourceHelpAction"],
  ["service-agreements", "signAgreementAction"], ["service-agreements", "changeMethodAction"],
  ["signup", "saveOnboardingAction"], ["signup", "uploadOnboardingAction"], ["signup", "submitOnboardingAction"],
  ["tax-center", "requestCopyAction"], ["tax-center", "referralAction"],
  ["tax-returns", "emailMyCopyAction"],
  ["tax-summary", "approveSummaryAction"], ["tax-summary", "requestSummaryChangesAction"],
];

const page = async (path: string) => (await import(`@/app/client/(secure)/${path}page`)).default as (p: unknown) => Promise<ReactNode>;
const render = async (path: string, sp: Record<string, string> = {}) => expand(await (await page(path))({ searchParams: Promise.resolve(sp), params: Promise.resolve({}) }));

beforeEach(async () => {
  await resetDb();
  reset();
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ clean: true }), { status: 200 }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function world() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  // A tax-only client and a bookkeeping business owned by the same fictional person.
  const pat = await createClient(tabitha, { firstName: "Pat", lastName: "Pretend", clientType: "INDIVIDUAL", status: "ACTIVE", email: "pat@fictional.example" });
  const bakery = await createClient(tabitha, { businessName: "Lakeside Pretend Bakery LLC", clientType: "BUSINESS", status: "ACTIVE", assignedToId: tabitha.id });
  // A business-only client (no bookkeeping, no personal tax).
  const hauling = await createClient(tabitha, { businessName: "Other Fictional Hauling LLC", clientType: "BUSINESS", status: "ACTIVE" });
  // A client with no portal login.
  const nolog = await createClient(tabitha, { firstName: "Noel", lastName: "Nologin", clientType: "INDIVIDUAL", status: "ACTIVE" });
  const { token } = await invitePortalUser(tabitha, pat.id, { email: "pat@fictional.example", name: "Pat Pretend", role: "OWNER" });
  const patLogin = await acceptPortalInvite(token!, "Pat-Strong-Pass-12345");
  await invitePortalUser(tabitha, bakery.id, { email: "pat@fictional.example", name: "Pat Pretend", role: "OWNER" });
  const { token: t2 } = await invitePortalUser(tabitha, bakery.id, { email: "casey@fictional.example", name: "Casey Contact", role: "AUTHORIZED_CONTACT" });
  const casey = await acceptPortalInvite(t2!, "Casey-Strong-Pass-12345");
  const { token: t3 } = await invitePortalUser(tabitha, hauling.id, { email: "sam@fictional.example", name: "Sam Sample", role: "OWNER" });
  const sam = await acceptPortalInvite(t3!, "Sam-Strong-Pass-12345");
  await managed(bakery.id);
  h.staff = tabitha;
  return { tabitha, pat, bakery, hauling, nolog, patLogin, casey, sam };
}

/** Row counts of every table, to prove a refused call wrote nothing. */
async function counts() {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('_prisma_migrations', '_local_migrations') ORDER BY tablename`;
  const rows = await prisma.$queryRawUnsafe<{ t: string; n: bigint }[]>(tables.map((t) => `SELECT '${t.tablename}' AS t, count(*) AS n FROM "${t.tablename}"`).join(" UNION ALL "));
  return Object.fromEntries(rows.map((r) => [r.t, Number(r.n)]));
}

const fd = (entries: Record<string, string | Blob> = {}) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.append(k, v);
  return f;
};

/** True when the tree carries one of the portal's own actions (bound or not). */
const realActions = (tree: ReactNode) => functionProps(tree).map((f) => f.name.replace(/^bound /, "")).filter((n) => REAL_ACTION_NAMES.has(n));

describe("starting, keeping and ending View as Client", () => {
  it("the start route needs staff, picks the primary owner login, sets the signed cookie and opens the client's own portal", async () => {
    const { bakery, patLogin, sam } = await world();
    const { GET } = await import("@/app/view-as-client/[clientId]/route");
    const res = await GET(new Request(`http://localhost/view-as-client/${bakery.id}?as=${sam.id}`), { params: Promise.resolve({ clientId: bakery.id }) });
    // A login of another client is ignored: the bakery's primary owner login is used.
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`/client?account=${bakery.id}`);
    expect(viewer.parsePreviewCookie(h.jar.get(viewer.VAC_COOKIE))).toMatchObject({ s: h.staff!.id, c: bakery.id, l: patLogin.id });
    expect(await prisma.auditLog.count({ where: { action: "portal.staff_preview", entityId: bakery.id } })).toBe(1);
    // Another valid login of this client can be chosen.
    const casey = await prisma.portalUser.findFirstOrThrow({ where: { email: "casey@fictional.example" } });
    await GET(new Request(`http://localhost/view-as-client/${bakery.id}?as=${casey.id}`), { params: Promise.resolve({ clientId: bakery.id }) });
    expect(viewer.parsePreviewCookie(h.jar.get(viewer.VAC_COOKIE))?.l).toBe(casey.id);
    // Only a /client page may follow.
    const out = await GET(new Request(`http://localhost/view-as-client/${bakery.id}?to=https://evil.example`), { params: Promise.resolve({ clientId: bakery.id }) });
    expect(out.headers.get("location")).toBe(`/client?account=${bakery.id}`);
    // No staff session: refused before anything is set.
    reset();
    await expect(GET(new Request(`http://localhost/view-as-client/${bakery.id}`), { params: Promise.resolve({ clientId: bakery.id }) })).rejects.toSatisfy((e) => nextTarget(e) === "/staff/login");
    expect(h.jar.size).toBe(0);
  });

  it("the cookie only works with the same staff member signed in, unaltered and unexpired; Exit removes it", async () => {
    const { bakery, patLogin } = await world();
    await startPreview(bakery.id, patLogin.id);
    expect(await viewer.getPreviewSession()).toMatchObject({ clientId: bakery.id, loginId: patLogin.id });
    // Another staff member's browser can't reuse it.
    const tabitha = h.staff!;
    h.staff = await makeUser("STAFF", "Daria");
    expect(await viewer.getPreviewSession()).toBeNull();
    h.staff = null;
    expect(await viewer.getPreviewSession()).toBeNull();
    h.staff = tabitha;
    // Tampered (another client) or expired.
    const v = h.jar.get(viewer.VAC_COOKIE)!;
    const [body, sig] = v.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), c: "someone-else" })).toString("base64url");
    h.jar.set(viewer.VAC_COOKIE, `${forged}.${sig}`);
    expect(await viewer.getPreviewSession()).toBeNull();
    expect(viewer.parsePreviewCookie(viewer.previewCookieValue({ staffId: tabitha.id, clientId: bakery.id, loginId: null }, Date.now() - 11 * 60 * 60 * 1000))).toBeNull();
    // Exit.
    await startPreview(bakery.id, patLogin.id);
    const { GET } = await import("@/app/view-as-client/exit/route");
    const res = await GET();
    expect(res.headers.get("location")).toBe(`/clients/${bakery.id}`);
    expect(h.jar.has(viewer.VAC_COOKIE)).toBe(false);
  });

  it("strict isolation: the preview shows only the previewed client, even when the login has other accounts", async () => {
    const { pat, bakery, patLogin } = await world();
    await startPreview(bakery.id, patLogin.id);
    const base = await viewer.portalViewerBase();
    expect(base.user?.id).toBe(patLogin.id);
    expect(base.accounts.map((a) => a.clientId)).toEqual([bakery.id]);
    // Asking for the login's other (personal) account is a 404, on every page.
    await expect(viewer.portalViewer("home", pat.id)).rejects.toSatisfy((e) => nextTarget(e) === "http:404");
    await expect(render("documents/", { account: pat.id })).rejects.toSatisfy((e) => nextTarget(e) === "http:404");
    // The client's own menu lists only this account.
    const nav = find(await PortalLayout({ children: null }), PortalNav)!;
    expect((nav.props.accounts as { id: string }[]).map((a) => a.id)).toEqual([bakery.id]);
  });

  it("a client with no portal login previews from the client's own services with owner-level access, and the banner says so", async () => {
    const { nolog } = await world();
    await startPreview(nolog.id, null);
    const base = await viewer.portalViewerBase();
    expect(base.user).toBeNull();
    expect(base.accounts[0]).toMatchObject({ clientId: nolog.id, role: "OWNER", canViewBookkeeping: false, canViewBilling: true });
    const tree = await expand(await PortalLayout({ children: null }));
    expect(testIds(tree)).toContain("view-as-client-banner");
    expect(textOf(tree)).toContain("no portal login yet");
    expect(textOf(tree)).toContain("Simulated view");
  });

  it("a client with a real portal login is previewed as that login and is NOT labelled simulated", async () => {
    const { bakery, patLogin } = await world();
    await startPreview(bakery.id, patLogin.id);
    const tree = await expand(await PortalLayout({ children: null }));
    expect(testIds(tree)).not.toContain("preview-simulated");
    expect(textOf(tree)).not.toContain("Simulated view");
    expect(textOf(tree)).toContain(`login: ${patLogin.name}`);
  });

  it("staff permissions still apply: billing stays hidden from staff without billing access", async () => {
    const { bakery, patLogin } = await world();
    h.staff = await makeUser("STAFF", "Daria");
    await startPreview(bakery.id, patLogin.id);
    expect((await viewer.portalViewerBase()).accounts[0].canViewBilling).toBe(false);
    expect(testIds(await render("billing/", { account: bakery.id }))).not.toContain("billing-payments");
    await grantPerms(h.staff.id, ["billing.view"]);
    expect(testIds(await render("billing/", { account: bakery.id }))).toContain("billing-payments");
  });
});

describe("read-only is enforced on the server", () => {
  it("every portal Server Action refuses a staff preview (no portal session) and writes nothing", async () => {
    const { bakery, patLogin } = await world();
    await startPreview(bakery.id, patLogin.id);
    const before = await counts();
    const outcomes: Record<string, string> = {};
    for (const [mod, name] of PORTAL_ACTIONS) {
      const fn = ACTION_MODULES[mod][name] as (...a: unknown[]) => Promise<unknown>;
      expect(typeof fn, `${mod}.${name}`).toBe("function");
      const lead = Math.max(0, fn.length - 2);
      const args = [...Array.from({ length: lead }, () => bakery.id), null, fd({ subject: "General question", body: "Hello", note: "x", item: "OTHER|", name: "Someone", contact: "x@example.com" })];
      try {
        const r = (await fn(...args)) as { ok?: unknown; error?: string } | string | null | undefined;
        // Answered without acting: never a success.
        expect(r && typeof r === "object" ? r.ok : undefined, `${mod}.${name} succeeded`).toBeUndefined();
        outcomes[name] = r && typeof r === "object" && "error" in r ? "error" : "no-op";
      } catch (err) {
        outcomes[name] = nextTarget(err) ?? `threw ${(err as Error).name}`;
      }
    }
    expect(await counts()).toEqual(before);
    // The ones that send, upload, sign, approve, book or pay go to the client sign-in page.
    for (const n of ["portalMessageAction", "portalUploadAction", "requestInvoiceAction", "bookAppointmentAction", "portalSignAction", "signAgreementAction", "approveSummaryAction", "portalPayrollDecisionAction", "portalIdentityUploadAction", "requestRefundTransferAction", "acceptQuoteAction", "requestCustomerInvoiceAction", "submitPortalHoursAction", "submitNoticeAction", "referralAction", "portalCommPrefsAction", "cancelAppointmentByClientAction", "answerProposalAction"]) {
      expect(outcomes[n], n).toMatch(/^\/client\/(login|mfa)/);
    }
  });

  it("the /api/client upload and bank refresh refuse a staff preview", async () => {
    const { bakery, patLogin } = await world();
    await startPreview(bakery.id, patLogin.id);
    const before = await counts();
    const { POST: upload } = await import("@/app/api/client/upload/route");
    const body = fd({ account: bakery.id, year: "2025", docType: "W2", file: new File([new Uint8Array([37, 80, 68, 70])], "w2.pdf", { type: "application/pdf" }) });
    expect((await upload(new Request("http://localhost/api/client/upload", { method: "POST", body }))).status).toBe(401);
    const { POST: refresh } = await import("@/app/api/client/bank/refresh/route");
    expect((await refresh(new Request("http://localhost/api/client/bank/refresh", { method: "POST", body: JSON.stringify({ account: bakery.id }) }))).status).toBe(401);
    expect(await counts()).toEqual(before);
  });

  it("the preview stand-ins refuse, save nothing, and need a staff session", async () => {
    await world();
    const before = await counts();
    expect(await preview.previewFormAction(null, fd({ body: "x" }))).toMatchObject({ error: PREVIEW_OFF });
    expect(await preview.previewBookAction("c", {})).toEqual({ error: PREVIEW_OFF });
    expect(await preview.previewReschedulePickAction("c", "a", "2027-03-02", "09:00")).toEqual({ error: PREVIEW_OFF });
    expect(await counts()).toEqual(before);
    h.staff = null;
    await expect(preview.previewFormAction(null, fd())).rejects.toSatisfy((e) => nextTarget(e) === "/staff/login");
  });
});

describe("the real client login is unchanged (regression)", () => {
  it("a fictional client can still send a message, upload, request an invoice, send a referral and book an appointment", async () => {
    const { pat, patLogin, tabitha } = await world();
    await signInPortal(patLogin.id);
    const { portalMessageAction, portalUploadAction } = ACTION_MODULES.portal as Record<string, (...a: unknown[]) => Promise<{ ok?: string; error?: string }>>;
    expect(await portalMessageAction(pat.id, null, fd({ subject: "General question", body: "Hello from a fictional client" }))).toMatchObject({ ok: expect.any(String) });
    expect(await prisma.message.count({ where: { conversation: { clientId: pat.id }, channel: "PORTAL", direction: "INBOUND" } })).toBe(1);
    const file = new File([new TextEncoder().encode("%PDF-1.4 fictional w2")], "w2.pdf", { type: "application/pdf" });
    expect(await portalUploadAction(pat.id, null, fd({ year: "2025", docType: "W2", file }))).toMatchObject({ ok: expect.any(String) });
    expect(await prisma.document.count({ where: { clientId: pat.id, uploadedByPortalId: patLogin.id } })).toBe(1);
    const { requestInvoiceAction } = ACTION_MODULES["invoice-requests"] as Record<string, (...a: unknown[]) => Promise<{ ok?: string }>>;
    expect(await requestInvoiceAction(pat.id, null, fd({ item: "OTHER|", note: "Amended 2024 return (fictional)" }))).toMatchObject({ ok: expect.any(String) });
    expect(await prisma.invoiceRequest.count({ where: { clientId: pat.id } })).toBe(1);
    const { referralAction } = ACTION_MODULES["tax-center"] as Record<string, (...a: unknown[]) => Promise<{ ok?: string }>>;
    expect(await referralAction(pat.id, null, fd({ name: "Friend Fictional", contact: "friend@fictional.example" }))).toMatchObject({ ok: expect.any(String) });
    // Booking: a published month, the office's date at a fixed "now".
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(chicagoLocalToUtc("2027-02-25T12:00")!);
    await signInPortal(patLogin.id); // a fresh sign-in at that time
    await prisma.portalUser.update({ where: { id: patLogin.id }, data: { phone: "(205) 555-0142", phoneNormalized: "+12055550142" } });
    await openMonth(tabitha, 2027, 3);
    await setMonthPublished(tabitha, 2027, 3, true);
    const { bookAppointmentAction } = ACTION_MODULES.appointments as Record<string, (...a: unknown[]) => Promise<{ ok?: unknown; error?: string }>>;
    const booked = await bookAppointmentAction(pat.id, { services: ["TAX_1040"], date: "2027-03-02", time: "09:00", info: { meetingType: "IN_OFFICE", reason: "Review my return" } });
    expect(booked.error).toBeUndefined();
    expect(await prisma.appointment.count({ where: { clientId: pat.id } })).toBe(1);
  });

  it("the client's own pages bind the portal's real actions, with no preview banner or stand-ins", async () => {
    const { pat, patLogin } = await world();
    h.staff = null;
    await signInPortal(patLogin.id);
    for (const path of ["messages/", "documents/", "billing/"]) {
      const tree = await render(path, { account: pat.id });
      expect(realActions(tree).length, path).toBeGreaterThan(0);
      expect(functionProps(tree).filter((f) => f.name.startsWith("preview"))).toHaveLength(0);
      expect(testIds(tree)).not.toContain("preview-off");
    }
    expect(testIds(await expand(await PortalLayout({ children: null })))).not.toContain("view-as-client-banner");
  });
});

describe("preview pages are the client's real pages, read-only", () => {
  const PERSONAL_PAGES = ["", "billing/", "appointments/", "messages/", "documents/", "identity/", "taxes/summary/", "taxes/", "taxes/filings/", "tax-center/", "tax-center/upload/", "tax-center/notice/", "agreements/", "contracts/", "news/", "resources/", "referrals/", "nonprofit/", "account/"];
  const BUSINESS_PAGES = ["", "billing/", "appointments/", "messages/", "documents/", "agreements/", "bookkeeping/", "payroll/", "licenses/", "year-end/", "invoicing/", "tax-center/upload/"];

  it("no page of a tax client's or a bookkeeping client's preview carries any portal action, and each view is audited", async () => {
    const { pat, bakery, patLogin } = await world();
    for (const [client, pages] of [[pat, PERSONAL_PAGES], [bakery, BUSINESS_PAGES]] as const) {
      await startPreview(client.id, patLogin.id);
      for (const path of pages) {
        const tree = await render(path, { account: client.id });
        expect(realActions(tree), `${client.id} /client/${path}`).toEqual([]);
      }
    }
    const views = (await prisma.auditLog.findMany({ where: { action: "portal.staff_preview" } })).map((a) => (a.details as { view: string }).view);
    for (const v of ["home", "billing", "appointments", "messages", "documents", "identity", "summary", "bookkeeping", "payroll", "licenses", "invoicing", "agreements"]) expect(views).toContain(v);
    expect(new Set((await prisma.auditLog.findMany({ where: { action: "portal.staff_preview" } })).map((a) => a.actorId))).toEqual(new Set([h.staff!.id]));
  });

  it("Billing, Appointments, Messages and the Document Vault render their controls disabled, with the note", async () => {
    const { pat, patLogin } = await world();
    const c0 = await prisma.conversation.create({ data: { clientId: pat.id, subject: "Fictional question" } });
    await prisma.message.create({ data: { conversationId: c0.id, channel: "PORTAL", direction: "OUTBOUND", body: "Hello Pat (fictional)", status: "DELIVERED" } });
    await startPreview(pat.id, patLogin.id);

    const billing = await render("billing/", { account: pat.id });
    expect(testIds(billing)).toEqual(expect.arrayContaining(["billing-payments", "your-invoices", "make-a-payment", "pay-with-invoice", "pay-ZELLE", "pay-CASH_APP", "pay-APPLE_PAY", "pay-VENMO", "preview-disabled", "preview-off"]));

    const appts = (await (await page("appointments/"))({ searchParams: Promise.resolve({ account: pat.id }) })) as ReactNode;
    const { AppointmentsView } = await import("@/components/portal/appointments-view");
    const av = find(appts, AppointmentsView)!;
    const acts = av.props.actions as Record<string, unknown>;
    expect(av.props.readOnly).toBe(true);
    expect(acts.book).toBe(preview.previewBookAction);
    expect(acts.reschedulePick).toBe(preview.previewReschedulePickAction);
    expect(acts.loadMonth).toBe(preview.previewAvailabilityAction);

    const messages = await render("messages/", { account: pat.id });
    const { MessageComposer } = await import("@/components/portal/message-composer");
    const mc = find(messages, MessageComposer)!;
    expect(mc.props).toMatchObject({ readOnly: true, action: preview.previewFormAction });
    expect(testIds(messages)).toContain("message-center");
    expect(textOf(messages)).toContain("Fictional question");
    // Opening a thread in the preview never marks it read.
    const conv = await prisma.conversation.findFirstOrThrow({ where: { clientId: pat.id } });
    const thread = await render("messages/", { account: pat.id, c: conv.id });
    expect(testIds(thread)).toEqual(expect.arrayContaining(["message-threads", "preview-disabled"]));
    expect(await prisma.message.count({ where: { conversationId: conv.id, readByClientAt: { not: null } } })).toBe(0);

    const vault = await render("documents/", { account: pat.id });
    expect(functionProps(vault)).toContain(preview.previewFormAction);
    expect(testIds(vault)).toEqual(expect.arrayContaining(["document-vault", "vault-upload", "preview-disabled", "vault-empty"]));

    // Identity: the client's own upload buttons, disabled — never a dead end.
    const identity = await render("identity/", { account: pat.id });
    expect(testIds(identity)).toEqual(expect.arrayContaining(["identity-section", "preview-disabled"]));
  });

  it("documents open with a staff link in the preview, never a portal one", async () => {
    const { pat, patLogin } = await world();
    await startPreview(pat.id, patLogin.id);
    const v = await viewer.portalViewer("documents", pat.id);
    expect(v.linkFor("doc-1")).toMatch(/^\/api\/documents\/doc-1\.s:/);
    expect(v.readOnly).toBe(true);
  });
});

describe("the preview shows exactly what the client's login sees", () => {
  /** The same page, as the client's own login and as View as Client of that login. */
  async function both(clientId: string, loginId: string, path: string) {
    h.jar.clear();
    const staff = h.staff;
    h.staff = null;
    await signInPortal(loginId);
    const real = await render(path, { account: clientId });
    const realNav = find(await PortalLayout({ children: null }), PortalNav)!.props.accounts as { id: string }[];
    h.jar.clear();
    h.staff = staff;
    await startPreview(clientId, loginId);
    const prev = await render(path, { account: clientId });
    const prevNav = find(await PortalLayout({ children: null }), PortalNav)!.props.accounts as { id: string }[];
    return { real, prev, realNav: realNav.find((a) => a.id === clientId), prevNav: prevNav.find((a) => a.id === clientId) };
  }
  // What a page shows, without the parts meant to differ: the preview notes, and the "which of your
  // accounts" line a multi-account login sees (the preview shows the previewed client only).
  const ACCOUNT_CHROME = new Set(["message-target", "personal-upload"]);
  const shown = (tree: ReactNode) => textOf(tree, ACCOUNT_CHROME).replace(/Turned off in View as Client/g, "").replace(/\s+/g, " ").trim();
  const ids = (tree: ReactNode) => testIds(tree).filter((t) => !t.startsWith("preview-") && !ACCOUNT_CHROME.has(t));

  it("a tax-only client, a business-only client and a bookkeeping client: same menu, same pages, same exclusions", async () => {
    const { pat, bakery, hauling, patLogin, sam } = await world();
    const cases = [
      { name: "tax-only", clientId: pat.id, loginId: patLogin.id, pages: ["", "documents/", "messages/", "billing/", "taxes/summary/", "identity/", "agreements/", "appointments/"] },
      { name: "business-only", clientId: hauling.id, loginId: sam.id, pages: ["", "documents/", "messages/", "billing/", "agreements/", "appointments/", "tax-center/upload/"] },
      { name: "bookkeeping", clientId: bakery.id, loginId: patLogin.id, pages: ["", "documents/", "messages/", "billing/", "bookkeeping/", "payroll/", "licenses/", "invoicing/"] },
    ];
    for (const c of cases) {
      for (const path of c.pages) {
        const r = await both(c.clientId, c.loginId, path);
        expect(r.prevNav, `${c.name} menu`).toEqual(r.realNav);
        expect(ids(r.prev), `${c.name} /client/${path} sections`).toEqual(ids(r.real));
        expect(shown(r.prev), `${c.name} /client/${path} content`).toBe(shown(r.real));
      }
    }
    // Exclusions hold in both: a tax-only client has no business side; a business-only client has
    // no personal tax pages; only the bookkeeping client's menu has the business view.
    const tax = await both(pat.id, patLogin.id, "");
    expect(tax.prevNav).toMatchObject({ business: false, businessOnly: false });
    const biz = await both(hauling.id, sam.id, "");
    expect(biz.prevNav).toMatchObject({ business: false, businessOnly: true });
    expect((biz.prevNav as unknown as { hide: string[] }).hide).toEqual(expect.arrayContaining(["/client/tax-center", "/client/taxes/summary"]));
    const bk = await both(bakery.id, patLogin.id, "");
    expect(bk.prevNav).toMatchObject({ business: true });
    expect(testIds(bk.real)).toContain("business-dashboard");
    expect(testIds(bk.prev)).toContain("business-dashboard");
    expect(testIds(tax.prev)).not.toContain("business-dashboard");
    expect(testIds(tax.real)).not.toContain("business-dashboard");
    // A business-only client's personal tax pages send both views back to the business Home.
    h.jar.clear();
    await startPreview(hauling.id, sam.id);
    await expect(render("taxes/summary/", { account: hauling.id })).rejects.toSatisfy((e) => nextTarget(e)?.startsWith("/client?account=") ?? false);
    // 23 pages rendered twice each (real and preview): more than the 5-second default on a busy machine.
  }, 30_000);

  it("an authorized contact's preview shows that contact's narrower access", async () => {
    const { bakery, casey } = await world();
    await prisma.portalAccess.updateMany({ where: { portalUserId: casey.id, clientId: bakery.id }, data: { canViewBilling: false } });
    const r = await both(bakery.id, casey.id, "billing/");
    expect(testIds(r.prev)).not.toContain("billing-payments");
    expect(shown(r.prev)).toBe(shown(r.real));
    expect(elements(r.prev).length).toBeGreaterThan(0);
  });
});
