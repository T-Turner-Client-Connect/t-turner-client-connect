import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { grantPerms, prisma, resetDb } from "./db";
import { ForbiddenError, type Actor } from "@/lib/auth/actor";
import { hashPassword } from "@/lib/auth/password";
import { assertOffice, claimOwnerOffice, officeTabs, ownerNavState } from "@/lib/auth/owner";
import {
  applyPermissionPreset,
  assertCanApproveCoethaWork,
  can,
  canApproveCoethaWork,
  officeAccessFor,
  permissionHistory,
  setStaffPermissions,
  staffAccessBoard,
} from "@/lib/auth/permissions";
import { ALL_KEYS, DARIA_PRESET, GRANTABLE_KEYS, OWNER_ONLY_KEYS, PRESETS, type PermKey } from "@/lib/permissions";
import { createClient } from "@/lib/services/clients";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import { approvePlan, savePaymentInstruction, saveLateFeePolicy } from "@/lib/services/installment-plans";
import { invoiceRows, issueInvoice, monthlySummary, portalBilling, receivables, recordPayment, todayYmd, updateBillingSettings, voidInvoice } from "@/lib/services/owner-billing";
import { approveAndSend, createFirmInvoice, invoiceHistory, setRefundTransferFeeNote, setSquareLinksEnabled, submitForApproval, updateFirmInvoice, type FirmInvoiceInput } from "@/lib/services/firm-invoices";
import { recordRefundDeposit, setRefundTransferAmount } from "@/lib/services/refund-transfers";
import { createExpense, deleteExpense, listExpenses } from "@/lib/services/owner-expenses";
import { canManageBilling, canOpenCoetha, saveBillingNotes, setBillingAccess } from "@/lib/services/bookkeeping-profile";
import { canUseLedger } from "@/lib/services/ledger";
import { approveBusinessAccess, pendingBusinessRequests, setConversionRequester } from "@/lib/services/business-access";
import { openMonth, ownerApprove } from "@/lib/services/appointments";
import { addMonths } from "@/lib/billing/pricing";

/** Fictional office only: "Daria Fictional", "Marcus Fictional", fictional clients. No network. */
const PASSWORD = "Owner-Strong-Pass-1";
const today = todayYmd();

beforeEach(async () => {
  await resetDb();
  vi.stubEnv("NOTIFICATIONS_ENABLED", "false");
  vi.stubEnv("SQUARE_ACCESS_TOKEN", "");
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
  const marcus = await staffAccount("marcus.fictional@example.com", "Marcus Fictional", "STAFF");
  await claimOwnerOffice(tab, PASSWORD);
  for (const m of ["ZELLE", "CASH", "SQUARE_INVOICE"]) await savePaymentInstruction(tab, m, { details: `Fictional ${m} instructions`, active: true });
  return { tab, daria, marcus };
}

async function rosaClient(staff: Actor) {
  const rosa = await createClient(staff, { firstName: "Rosa", lastName: "Fictional", clientType: "INDIVIDUAL", status: "ACTIVE", email: "rosa.fictional@example.com" });
  const { token } = await invitePortalUser(staff, rosa.id, { email: "rosa.portal@example.com", name: "Rosa", role: "OWNER" });
  const u = await acceptPortalInvite(token!, "Portal-Pass-123");
  return { rosa, rosaUser: { id: u.id, name: u.name, email: u.email } };
}

const invoice = (clientId: string, over: Partial<FirmInvoiceInput> = {}): FirmInvoiceInput => ({
  clientId,
  service: "Tax Preparation",
  amountCents: 45000,
  description: "2025 federal and Alabama individual returns",
  issueDate: today,
  dueDate: addMonths(today, 1),
  offeredMethods: ["ZELLE", "CASH"],
  ...over,
});

const keysOf = async (userId: string) => [...(await officeAccessFor(userId)).keys].sort();

/** Resolves to "forbidden" if the server's permission gate refused, otherwise "passed the gate". */
async function gate(p: Promise<unknown>) {
  try {
    await p;
    return "passed";
  } catch (e) {
    return e instanceof ForbiddenError ? "forbidden" : "passed";
  }
}

describe("grants take effect immediately", () => {
  it("grant and revoke apply on the very next call, with no re-login", async () => {
    const { tab, daria } = await office();
    const { rosa } = await rosaClient(tab);
    // The same signed-in actor object throughout: nothing is cached in the session.
    await expect(createFirmInvoice(daria, invoice(rosa.id))).rejects.toBeInstanceOf(ForbiddenError);
    expect(await ownerNavState(daria)).toBe("none");
    await setStaffPermissions(tab, daria.id, ["billing.view", "billing.create"]);
    const inv = await createFirmInvoice(daria, invoice(rosa.id));
    expect(await ownerNavState(daria)).toBe("/owner/invoices");
    expect(officeTabs(await officeAccessFor(daria.id)).map((t) => t.label)).toEqual(["Quotes & invoices", "Billing dashboard", "Payment plans", "Pay by Refund"]);
    await setStaffPermissions(tab, daria.id, ["billing.view"]);
    await expect(createFirmInvoice(daria, invoice(rosa.id))).rejects.toBeInstanceOf(ForbiddenError);
    expect((await invoiceRows(daria)).map((r) => r.id)).toContain(inv.id);
    await setStaffPermissions(tab, daria.id, []);
    await expect(invoiceRows(daria)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await ownerNavState(daria)).toBe("none");
  });

  it("a deactivated account holds nothing, even with grants on file", async () => {
    const { tab, daria } = await office();
    await setStaffPermissions(tab, daria.id, ["billing.view"]);
    await prisma.user.update({ where: { id: daria.id }, data: { active: false } });
    expect(await can(daria, "billing", "view")).toBe(false);
  });
});

describe("the server rejects unauthorized attempts in every area's gated services", () => {
  it("each permission opens exactly its gate", async () => {
    const { tab, daria, marcus } = await office();
    const { rosa } = await rosaClient(tab);
    const nope = "missing-id";
    const checks: [PermKey, () => Promise<unknown>][] = [
      ["billing.view", () => invoiceRows(marcus)],
      ["billing.create", () => createFirmInvoice(marcus, invoice(rosa.id))],
      ["billing.edit", () => submitForApproval(marcus, nope)],
      ["billing.approve", () => approvePlan(marcus, nope)],
      ["billing.send", () => issueInvoice(marcus, nope)],
      ["billing.record_payment", () => recordPayment(marcus, { invoiceId: nope, kind: "PAYMENT", status: "SUCCEEDED", amountCents: 100, receivedOn: today, method: "CASH" })],
      ["billing.refund", () => recordPayment(marcus, { invoiceId: nope, kind: "REFUND", status: "SUCCEEDED", amountCents: 100, receivedOn: today, method: "CASH" })],
      ["billing.void", () => voidInvoice(marcus, nope, "Entered twice")],
      ["billing.adjust", () => recordPayment(marcus, { invoiceId: nope, kind: "CREDIT", status: "SUCCEEDED", amountCents: 100, receivedOn: today, method: "OTHER", note: "Goodwill" })],
      ["billing.settings", () => setRefundTransferFeeNote(marcus, "Fictional fee note")],
      ["square.view", async () => { if (!(await canManageBilling(marcus, "view"))) throw new ForbiddenError(); }],
      ["square.edit", () => saveBillingNotes(marcus, rosa.id, "Fictional note")],
      ["square.integrations", () => setSquareLinksEnabled(marcus, false)],
      ["receivables.view", () => receivables(marcus)],
      ["receivables.reconcile", () => recordRefundDeposit(marcus, nope, { amount: "1.00", receivedOn: today })],
      ["revenue.view", () => listExpenses(marcus, { year: 2026 })],
      ["revenue.create", () => createExpense(marcus, { spentOn: today, vendor: "Fictional Supply Co", category: "Office supplies", amountCents: 1200 })],
      ["revenue.edit", () => deleteExpense(marcus, nope)],
      ["banking.view", async () => { if (!(await canUseLedger(marcus, rosa.id, "banking", "view"))) throw new ForbiddenError(); }],
      ["banking.edit", async () => { if (!(await canUseLedger(marcus, rosa.id, "banking", "edit"))) throw new ForbiddenError(); }],
      ["ledger.view", async () => { if (!(await canUseLedger(marcus, rosa.id, "ledger", "view"))) throw new ForbiddenError(); }],
      ["ledger.edit", async () => { if (!(await canUseLedger(marcus, rosa.id, "ledger", "edit"))) throw new ForbiddenError(); }],
      ["business_access.view", () => pendingBusinessRequests(marcus)],
      ["business_access.approve", () => approveBusinessAccess(marcus, nope)],
      ["business_access.manage", () => setConversionRequester(marcus, daria.id, true)],
      ["coetha.view", async () => { if (!(await canOpenCoetha(marcus, rosa.id))) throw new ForbiddenError(); }],
      ["appointments.approve", () => ownerApprove(marcus, nope)],
      ["appointments.manage", () => openMonth(marcus, 2026, 12)],
      ["staff.view", () => staffAccessBoard(marcus)],
      ["staff.manage", () => setStaffPermissions(marcus, daria.id, [])],
    ];
    const clear = () => prisma.staffPermission.deleteMany({ where: { userId: marcus.id } });
    for (const [key, call] of checks) {
      await clear();
      expect([key, await gate(call())]).toEqual([key, "forbidden"]);
      // Every OTHER grantable permission together still doesn't open this gate…
      await grantPerms(marcus.id, GRANTABLE_KEYS.filter((k) => k !== key && !(key === "staff.view" && k === "staff.manage")));
      expect([key, await gate(call())]).toEqual([key, "forbidden"]);
      // …and this one alone does.
      await clear();
      await grantPerms(marcus.id, [key]);
      expect([key, await gate(call())]).toEqual([key, "passed"]);
    }
  });
});

describe("nobody but the owner holds Owner, and nobody edits their own row or hers", () => {
  it("staff can't edit themselves or the owner, can't grant Owner-level access, and can't escalate", async () => {
    const { tab, daria, marcus } = await office();
    const otherAdmin = await staffAccount("admin.fictional@example.com", "Second Admin", "ADMIN");
    // An Admin role alone changes nothing.
    await expect(setStaffPermissions(otherAdmin, daria.id, ["billing.view"])).rejects.toBeInstanceOf(ForbiddenError);
    // Tabitha lets Daria manage staff, with billing view/create.
    await setStaffPermissions(tab, daria.id, ["staff.view", "staff.manage", "billing.view", "billing.create"]);
    await expect(setStaffPermissions(daria, daria.id, [...GRANTABLE_KEYS])).rejects.toThrow(/your own/);
    await expect(setStaffPermissions(daria, tab.id, [])).rejects.toThrow(/permanent/);
    await expect(applyPermissionPreset(daria, tab.id, "none")).rejects.toThrow(/permanent/);
    await expect(setStaffPermissions(tab, tab.id, [])).rejects.toThrow(/permanent/);
    // Owner-level: Staff management can't be passed on, and owner-only actions can't be granted at all.
    await expect(setStaffPermissions(daria, marcus.id, ["staff.manage"])).rejects.toThrow(/Only the owner/);
    for (const k of OWNER_ONLY_KEYS) {
      await expect(setStaffPermissions(daria, marcus.id, [k])).rejects.toBeInstanceOf(ForbiddenError);
      await expect(setStaffPermissions(tab, marcus.id, [k])).rejects.toBeInstanceOf(ForbiddenError);
    }
    // Only what she holds herself.
    await expect(setStaffPermissions(daria, marcus.id, ["billing.void"])).rejects.toThrow(/hold yourself/);
    await setStaffPermissions(daria, marcus.id, ["billing.view"]);
    expect(await keysOf(marcus.id)).toEqual(["billing.view"]);
    // A second owner can't be created: the claim is one-time and bound to the owner's account.
    await expect(claimOwnerOffice(daria, PASSWORD)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(claimOwnerOffice(otherAdmin, PASSWORD)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await prisma.ownerAccess.count({ where: { isPrimary: true } })).toBe(1);
    // Removing Daria's Staff management stops her immediately.
    await setStaffPermissions(tab, daria.id, ["billing.view"]);
    await expect(setStaffPermissions(daria, marcus.id, [])).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("the owner is always full, with no rows, and can't be reduced", async () => {
    const { tab, daria } = await office();
    const mine = await officeAccessFor(tab.id);
    expect(mine.isOwner).toBe(true);
    expect([...mine.keys].sort()).toEqual([...ALL_KEYS].sort());
    for (const k of ALL_KEYS) {
      const [area, action] = k.split(".") as [never, never];
      expect([k, await can(tab, area, action)]).toEqual([k, true]);
    }
    expect(await prisma.staffPermission.count({ where: { userId: tab.id } })).toBe(0);
    await setStaffPermissions(tab, daria.id, ["staff.view", "staff.manage"]);
    await expect(setStaffPermissions(daria, tab.id, [])).rejects.toBeInstanceOf(ForbiddenError);
    expect((await officeAccessFor(tab.id)).keys.size).toBe(ALL_KEYS.length);
    const board = await staffAccessBoard(tab);
    expect(board.staff.find((s) => s.id === tab.id)).toMatchObject({ isOwner: true });
  });
});

describe("Coetha approval", () => {
  it("is owner-only, even for staff holding every grant (and a forged row)", async () => {
    const { tab, daria } = await office();
    await setStaffPermissions(tab, daria.id, [...GRANTABLE_KEYS]);
    // Even a row written straight into the database doesn't count.
    await prisma.staffPermission.create({ data: { userId: daria.id, area: "coetha", action: "approve" } });
    expect(await canApproveCoethaWork(daria)).toBe(false);
    expect(await can(daria, "coetha", "approve")).toBe(false);
    await expect(assertCanApproveCoethaWork(daria)).rejects.toThrow(/Only Tabitha/);
    expect((await officeAccessFor(daria.id)).keys.has("coetha.approve")).toBe(false);
    // Daria keeps her normal duties (she may open Coetha and work the books).
    expect(await can(daria, "coetha", "view")).toBe(true);
    expect(await canApproveCoethaWork(tab)).toBe(true);
    await expect(assertCanApproveCoethaWork(tab)).resolves.toBe(true);
    // An Admin who isn't the owner can't either.
    const otherAdmin = await staffAccount("admin.fictional@example.com", "Second Admin", "ADMIN");
    expect(await canApproveCoethaWork(otherAdmin)).toBe(false);
  });
});

describe("audit history", () => {
  it("records who changed whom, area, action, old → new and when", async () => {
    const { tab, daria } = await office();
    const before = new Date();
    await setStaffPermissions(tab, daria.id, ["billing.view", "billing.create"]);
    await setStaffPermissions(tab, daria.id, ["billing.view", "billing.send"]);
    const rows = await prisma.staffPermissionEvent.findMany({ where: { userId: daria.id }, orderBy: [{ createdAt: "asc" }, { action: "asc" }] });
    expect(rows.map((r) => [r.actorId, r.area, r.action, r.fromAllowed, r.toAllowed, r.source])).toEqual([
      [tab.id, "billing", "create", false, true, "matrix"],
      [tab.id, "billing", "view", false, true, "matrix"],
      [tab.id, "billing", "create", true, false, "matrix"],
      [tab.id, "billing", "send", false, true, "matrix"],
    ]);
    expect(rows.every((r) => r.createdAt >= before)).toBe(true);
    // Saving the same set again records nothing.
    await setStaffPermissions(tab, daria.id, ["billing.view", "billing.send"]);
    expect(await prisma.staffPermissionEvent.count({ where: { userId: daria.id } })).toBe(4);
    expect(await prisma.ownerAuditLog.count({ where: { action: "staff.permissions_changed", entityId: daria.id } })).toBe(2);
    const history = await permissionHistory(tab);
    expect(history[0]).toMatchObject({ actorName: "Tabitha Turner", userName: "Daria Fictional", area: "billing" });
    // Staff without Staff management → View can't read the history.
    await expect(permissionHistory(daria)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("the Settings → Team billing toggle writes the same grants and history", async () => {
    const { tab, daria } = await office();
    await setBillingAccess(tab, daria.id, true);
    expect(await keysOf(daria.id)).toEqual(["square.edit", "square.view"]);
    expect(await canManageBilling(daria, "edit")).toBe(true);
    await setBillingAccess(tab, daria.id, false);
    expect(await keysOf(daria.id)).toEqual([]);
    expect(await prisma.staffPermissionEvent.count({ where: { userId: daria.id, source: "legacy:bookkeeping_billing" } })).toBe(4);
  });
});

describe("Daria's billing-clerk preset", () => {
  it("is never applied automatically", async () => {
    const { daria } = await office();
    expect(await keysOf(daria.id)).toEqual([]);
    expect(DARIA_PRESET.label).toBe("Billing clerk (Daria's request)");
  });

  it("grants exactly the listed actions to Daria Fictional and denies the rest", async () => {
    const { tab, daria } = await office();
    const { rosa, rosaUser } = await rosaClient(tab);
    await setStaffPermissions(tab, daria.id, ["revenue.view"]); // replaced by the preset
    await applyPermissionPreset(tab, daria.id, DARIA_PRESET.key);
    expect(await keysOf(daria.id)).toEqual([
      "billing.create", "billing.edit", "billing.record_payment", "billing.send", "billing.view", "receivables.reconcile", "receivables.view", "square.view",
    ]);
    expect(await prisma.staffPermissionEvent.count({ where: { userId: daria.id, source: `preset:${DARIA_PRESET.key}` } })).toBe(DARIA_PRESET.keys.length + 1);

    // Allowed: create for a firm client, edit the draft, send it, see balance/history, record a verified payment (marks it Paid).
    const inv = await createFirmInvoice(daria, invoice(rosa.id));
    await updateFirmInvoice(daria, inv.id, invoice(rosa.id, { amountCents: 50000 }));
    await approveAndSend(daria, inv.id);
    expect(await portalBilling(rosaUser, rosa.id)).toHaveLength(1);
    expect((await invoiceRows(daria)).find((r) => r.id === inv.id)).toMatchObject({ balanceCents: 50000 });
    expect((await receivables(daria)).totalOutstandingCents).toBe(50000);
    await expect(recordPayment(daria, { invoiceId: inv.id, kind: "PAYMENT", status: "SUCCEEDED", amountCents: 50000, receivedOn: today, method: "ZELLE", reference: "ZL-FICT-1" })).resolves.toBeTruthy();
    expect((await invoiceRows(daria)).find((r) => r.id === inv.id)).toMatchObject({ balanceCents: 0, status: "PAID" });
    expect((await invoiceHistory(daria, inv.id)).map((h) => h.action)).toContain("Payment recorded");
    // Reconcile against confirmed records (a Refund Transfer deposit that arrived).
    const rt = await setRefundTransferAmount(tab, { clientId: rosa.id, taxYear: 2025, amount: "300.00" });
    await recordRefundDeposit(daria, rt.id, { amount: "300.00", receivedOn: today });
    expect((await prisma.refundTransferPayment.findUniqueOrThrow({ where: { id: rt.id } })).status).toBe("RECEIVED");
    expect(await canManageBilling(daria, "view")).toBe(true);

    // Denied: refunds, voids, payment integrations, billing settings, credits, Coetha approval.
    const second = await createFirmInvoice(daria, invoice(rosa.id, { amountCents: 20000 }));
    await approveAndSend(daria, second.id);
    await recordPayment(tab, { invoiceId: second.id, kind: "PAYMENT", status: "SUCCEEDED", amountCents: 10000, receivedOn: today, method: "CASH" });
    await expect(recordPayment(daria, { invoiceId: second.id, kind: "REFUND", status: "SUCCEEDED", amountCents: 100, receivedOn: today, method: "CASH" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(voidInvoice(daria, second.id, "Mistake")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setSquareLinksEnabled(daria, true)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(savePaymentInstruction(daria, "VENMO", { details: "x", active: true })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setRefundTransferFeeNote(daria, "$0")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updateBillingSettings(daria, {} as never)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(saveLateFeePolicy(daria, { enabled: false, graceDays: 5, periodDays: 5, rateBps: 0, capBps: null, reviewedNote: "" } as never)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(recordPayment(daria, { invoiceId: second.id, kind: "CREDIT", status: "SUCCEEDED", amountCents: 100, receivedOn: today, method: "OTHER", note: "Goodwill" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(assertCanApproveCoethaWork(daria)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(saveBillingNotes(daria, rosa.id, "x")).rejects.toBeInstanceOf(ForbiddenError); // Square → Edit not included
    await expect(monthlySummary(daria, 2026)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(assertOffice(daria, "staff", "manage")).rejects.toBeInstanceOf(ForbiddenError);
    // No "delete payment history" exists anywhere; the permission is reserved and not in the preset.
    expect(DARIA_PRESET.keys).not.toContain("billing.delete_history");
    for (const k of ["billing.refund", "billing.void", "billing.delete_history", "square.integrations", "billing.settings", "coetha.approve"]) expect(DARIA_PRESET.keys).not.toContain(k);
  });

  it("every preset grants only grantable keys", () => {
    for (const p of PRESETS) for (const k of p.keys) expect(GRANTABLE_KEYS).toContain(k);
  });
});

describe("the data migration preserves today's access", () => {
  it("maps BILLING, FULL and bookkeeping billing to equivalent grants", async () => {
    const tab = await staffAccount("tabitha@tturnerassociates.com", "Tabitha Turner", "ADMIN");
    const billing = await staffAccount("billing.fictional@example.com", "Billing Fictional", "STAFF");
    const full = await staffAccount("full.fictional@example.com", "Full Fictional", "STAFF");
    const bk = await staffAccount("bk.fictional@example.com", "Bookkeeping Fictional", "STAFF");
    const revoked = await staffAccount("gone.fictional@example.com", "Revoked Fictional", "STAFF");
    const none = await staffAccount("none.fictional@example.com", "Nobody Fictional", "STAFF");
    // State before the migration (the old columns and rows).
    await prisma.ownerAccess.create({ data: { userId: tab.id, isPrimary: true, scope: "FULL" } });
    await prisma.user.update({ where: { id: tab.id }, data: { bookkeepingBillingAccess: true } });
    await prisma.ownerAccess.create({ data: { userId: billing.id, scope: "BILLING", grantedById: tab.id } });
    await prisma.ownerAccess.create({ data: { userId: full.id, scope: "FULL", grantedById: tab.id } });
    await prisma.ownerAccess.create({ data: { userId: revoked.id, scope: "BILLING", revokedAt: new Date() } });
    await prisma.user.update({ where: { id: bk.id }, data: { bookkeepingBillingAccess: true, bookkeepingBillingGrantedBy: tab.id } });
    await prisma.user.update({ where: { id: billing.id }, data: { bookkeepingBillingAccess: true } });

    const sql = readFileSync(path.resolve(import.meta.dirname, "../netlify/database/migrations/20261106205000_staff_permissions/migration.sql"), "utf8");
    await prisma.$executeRawUnsafe(sql.slice(sql.indexOf('WITH "map"')));

    expect(await keysOf(billing.id)).toEqual(["billing.create", "billing.edit", "billing.record_payment", "billing.view", "receivables.reconcile", "square.edit", "square.view"]);
    expect(await keysOf(bk.id)).toEqual(["square.edit", "square.view"]);
    expect(await keysOf(revoked.id)).toEqual([]);
    expect(await keysOf(none.id)).toEqual([]);
    expect(await prisma.staffPermission.count({ where: { userId: tab.id } })).toBe(0);
    expect((await officeAccessFor(tab.id)).isOwner).toBe(true);
    const fullKeys = await keysOf(full.id);
    expect(fullKeys).toEqual([
      "appointments.approve", "appointments.manage", "appointments.view",
      "billing.adjust", "billing.approve", "billing.create", "billing.edit", "billing.record_payment", "billing.refund", "billing.send", "billing.settings", "billing.view", "billing.void",
      "business_access.approve", "business_access.manage", "business_access.view",
      "receivables.reconcile", "receivables.view", "revenue.create", "revenue.edit", "revenue.view", "square.integrations",
    ]);
    expect(fullKeys.some((k) => k.startsWith("staff."))).toBe(false);
    // History rows from "system".
    expect(await prisma.staffPermissionEvent.count({ where: { actorId: "system", userId: billing.id } })).toBe(7);

    // Behavior: what each could do before still works; what they couldn't still doesn't.
    const { rosa } = await rosaClient(tab);
    for (const m of ["ZELLE", "CASH"]) await savePaymentInstruction(tab, m, { details: "Fictional", active: true });
    const inv = await createFirmInvoice(billing, invoice(rosa.id));
    await submitForApproval(billing, inv.id);
    await expect(approveAndSend(billing, inv.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(monthlySummary(billing, 2026)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await canManageBilling(bk, "edit")).toBe(true);
    await approveAndSend(full, inv.id);
    await expect(monthlySummary(full, 2026)).resolves.toBeTruthy();
    await expect(setStaffPermissions(full, billing.id, [])).rejects.toBeInstanceOf(ForbiddenError);
    await expect(invoiceRows(revoked)).rejects.toBeInstanceOf(ForbiddenError);
  });
});
