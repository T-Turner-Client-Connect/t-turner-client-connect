import { beforeEach, describe, expect, it } from "vitest";
import { makeUser, prisma, resetDb } from "./db";
import { ForbiddenError } from "@/lib/auth/actor";
import { createClient } from "@/lib/services/clients";
import { acceptPortalInvite, invitePortalUser } from "@/lib/services/portal-accounts";
import {
  cancelRefundTransfer,
  markRefundNotReceived,
  portalRefundTransfers,
  recordRefundDeposit,
  refundTransferBoard,
  requestRefundTransfer,
  setRefundTransferAmount,
  undoRefundDeposit,
} from "@/lib/services/refund-transfers";

// Pay From My Refund tracking — fictional clients only.
beforeEach(resetDb);
const Y = new Date().getFullYear() - 1;

async function world() {
  const tabitha = await makeUser("ADMIN", "Tabitha");
  await prisma.ownerAccess.create({ data: { userId: tabitha.id, isPrimary: true } });
  const staff = await makeUser("STAFF", "Daria");
  const ana = await createClient(tabitha, { firstName: "Ana", lastName: "Fictional", clientType: "INDIVIDUAL", status: "ACTIVE" });
  const bo = await createClient(tabitha, { firstName: "Bo", lastName: "Fictional", clientType: "INDIVIDUAL", status: "ACTIVE" });
  const login = async (clientId: string, email: string) => {
    const { token } = await invitePortalUser(tabitha, clientId, { email, name: email, role: "OWNER" });
    const u = await acceptPortalInvite(token!, "Client-Pass-12345");
    return { id: u.id, name: u.name, email: u.email };
  };
  return { tabitha, staff, ana, bo, anaLogin: await login(ana.id, "ana@fictional.example"), boLogin: await login(bo.id, "bo@fictional.example") };
}
const ask = (user: { id: string; name: string; email: string }, clientId: string, over: Partial<{ debtCheck: string; offsetRisk: string; acknowledged: boolean }> = {}) =>
  requestRefundTransfer(user, clientId, { taxYear: Y, debtCheck: "CHECKED", offsetRisk: "NO", acknowledged: true, ...over });

describe("Pay From My Refund", () => {
  it("a client request needs the debt-check answers and the acknowledgment, and waits for office review", async () => {
    const { ana, anaLogin } = await world();
    await expect(ask(anaLogin, ana.id, { acknowledged: false })).rejects.toThrow(/acknowledgment/);
    await expect(ask(anaLogin, ana.id, { debtCheck: "" })).rejects.toThrow(/checked for outstanding debts/);
    const p = await ask(anaLogin, ana.id, { debtCheck: "NOT_CHECKED", offsetRisk: "NOT_SURE" });
    expect(p).toMatchObject({ status: "REQUESTED", amountCents: null, debtCheck: "NOT_CHECKED", offsetRisk: "NOT_SURE" });
    expect(p.acknowledgedAt).not.toBeNull();
    const ev = await prisma.refundTransferEvent.findFirstOrThrow({ where: { paymentId: p.id } });
    expect(ev.note).toMatch(/Flag: check for possible refund offset/);
    await expect(ask(anaLogin, ana.id)).rejects.toThrow(/already chose/);
  });

  it("a client can't request or see another client's record", async () => {
    const { ana, bo, anaLogin, boLogin } = await world();
    await expect(ask(anaLogin, bo.id)).rejects.toBeInstanceOf(ForbiddenError);
    await ask(anaLogin, ana.id);
    await expect(portalRefundTransfers(boLogin, ana.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await portalRefundTransfers(boLogin, bo.id)).toEqual([]);
  });

  it("only the owner (or billing access) sets the fee, and it's never paid until the deposit is recorded", async () => {
    const { tabitha, staff, ana, anaLogin } = await world();
    await ask(anaLogin, ana.id);
    await expect(setRefundTransferAmount(staff, { clientId: ana.id, taxYear: Y, amount: "300" })).rejects.toBeInstanceOf(ForbiddenError);
    const p = await setRefundTransferAmount(tabitha, { clientId: ana.id, taxYear: Y, amount: "$300.00" });
    expect(p).toMatchObject({ status: "AWAITING_DEPOSIT", amountCents: 30000, receivedCents: null });
    let board = await refundTransferBoard(tabitha, Y);
    expect(board.totals).toMatchObject({ awaitingCount: 1, awaitingCents: 30000, receivedCents: 0 });
    await expect(recordRefundDeposit(staff, p.id, { amount: "300", receivedOn: "2026-02-20" })).rejects.toBeInstanceOf(ForbiddenError);
    await recordRefundDeposit(tabitha, p.id, { amount: "300", receivedOn: "2026-02-20" });
    board = await refundTransferBoard(tabitha, Y);
    expect(board.rows[0]).toMatchObject({ status: "RECEIVED", receivedCents: 30000 });
    expect(board.totals).toMatchObject({ awaitingCount: 0, receivedCents: 30000, followUpCount: 0 });
    await expect(recordRefundDeposit(tabitha, p.id, { amount: "300", receivedOn: "2026-02-20" })).rejects.toThrow(/fee owed before/); // no double clearing
  });

  it("a smaller deposit is Short with the balance to follow up; not received and cancel need a reason; undo keeps history", async () => {
    const { tabitha, ana, bo } = await world();
    const a = await setRefundTransferAmount(tabitha, { clientId: ana.id, taxYear: Y, amount: "400" });
    await recordRefundDeposit(tabitha, a.id, { amount: "250", receivedOn: "2026-03-01" });
    const b = await setRefundTransferAmount(tabitha, { clientId: bo.id, taxYear: Y, amount: "300" });
    await expect(markRefundNotReceived(tabitha, b.id, " ")).rejects.toThrow(/reason/);
    await markRefundNotReceived(tabitha, b.id, "Refund offset by Treasury");
    const board = await refundTransferBoard(tabitha, Y);
    expect(board.totals).toMatchObject({ followUpCount: 2, followUpCents: 15000 + 30000, receivedCents: 25000 });
    await undoRefundDeposit(tabitha, a.id, "Typed the wrong amount");
    expect((await prisma.refundTransferPayment.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("AWAITING_DEPOSIT");
    expect((await prisma.refundTransferEvent.findMany({ where: { paymentId: a.id } })).map((e) => e.action)).toEqual(expect.arrayContaining(["ADDED", "DEPOSIT_RECEIVED", "DEPOSIT_UNDONE"]));
    await cancelRefundTransfer(tabitha, b.id, "Paid by Zelle instead");
    expect((await prisma.refundTransferPayment.findUniqueOrThrow({ where: { id: b.id } })).status).toBe("CANCELLED");
  });
});
