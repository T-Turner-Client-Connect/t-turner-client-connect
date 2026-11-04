"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { requirePortalUser } from "@/lib/portal/session";
import { run, str, type ActionState } from "@/lib/action";
import {
  cancelRefundTransfer,
  markRefundNotReceived,
  recordRefundDeposit,
  requestRefundTransfer,
  setRefundTransferAmount,
  undoRefundDeposit,
} from "@/lib/services/refund-transfers";

// Every action re-checks access inside the service (client's own account; office billing access).
const refresh = () => {
  revalidatePath("/owner/refund-payments");
  revalidatePath("/client/billing");
};

export async function requestRefundTransferAction(clientId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requirePortalUser();
  return run(async () => {
    await requestRefundTransfer(user, clientId, { taxYear: Number(str(fd, "taxYear")), debtCheck: str(fd, "debtCheck"), offsetRisk: str(fd, "offsetRisk"), acknowledged: fd.get("ack") === "on" });
    refresh();
    return "Received. Our office will review it and confirm the fee amount before your return is filed.";
  });
}

export async function setRefundAmountAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await setRefundTransferAmount(actor, { clientId: str(fd, "clientId"), taxYear: Number(str(fd, "taxYear")), amount: str(fd, "amount"), note: str(fd, "note") });
    refresh();
    return "Saved. It now shows as Awaiting refund deposit.";
  });
}

export async function recordRefundDepositAction(paymentId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await recordRefundDeposit(actor, paymentId, { amount: str(fd, "amount"), receivedOn: str(fd, "receivedOn"), note: str(fd, "note") });
    refresh();
    return "Deposit recorded.";
  });
}

export async function refundNotReceivedAction(paymentId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await markRefundNotReceived(actor, paymentId, str(fd, "note"));
    refresh();
    return "Marked not received. Ask the client to pay another way.";
  });
}

export async function cancelRefundTransferAction(paymentId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await cancelRefundTransfer(actor, paymentId, str(fd, "note"));
    refresh();
    return "Cancelled.";
  });
}

export async function undoRefundDepositAction(paymentId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await undoRefundDeposit(actor, paymentId, str(fd, "note"));
    refresh();
    return "Deposit undone. Both entries stay in the history.";
  });
}
