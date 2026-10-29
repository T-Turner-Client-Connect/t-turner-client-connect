"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { AmountType, PaymentMethod } from "@prisma/client";
import { requireUser } from "@/lib/auth/session";
import { claimOwnerOffice, grantOwnerAccess, revokeOwnerAccess } from "@/lib/auth/owner";
import { run, str, type ActionState } from "@/lib/action";
import { ValidationError } from "@/lib/services/clients";
import {
  createQuote,
  issueInvoice,
  offerQuote,
  recordPayment,
  updateBillingSettings,
  updateDraft,
  voidInvoice,
  withdrawQuote,
  type QuoteInput,
} from "@/lib/services/owner-billing";
import { createExpense, deleteExpense } from "@/lib/services/owner-expenses";

/** "1,234.56" or "$80" → cents. */
function cents(raw: string, label: string): number {
  const v = raw.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(v)) throw new ValidationError(`Enter ${label} as dollars and cents, e.g. 125.00.`);
  return Math.round(Number(v) * 100);
}

/** "5" or "2.5" (%) → basis points. */
function bps(raw: string, label: string): number {
  const v = raw.replace(/[%\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(v)) throw new ValidationError(`Enter ${label} as a percentage, e.g. 5 or 2.5.`);
  return Math.round(Number(v) * 100);
}

const amountType = (v: string): AmountType => (v === "FLAT" || v === "PERCENT" ? v : "NONE");
const amountValue = (type: AmountType, raw: string, label: string) => (type === "FLAT" ? cents(raw || "0", label) : type === "PERCENT" ? bps(raw || "0", label) : 0);
const METHODS: PaymentMethod[] = ["CASH", "CHECK", "CARD", "ACH", "ZELLE", "CASH_APP", "OTHER"];

function quoteFromForm(fd: FormData): QuoteInput {
  const services = fd.getAll("line_service").map(String);
  const descriptions = fd.getAll("line_description").map(String);
  const quantities = fd.getAll("line_quantity").map(String);
  const prices = fd.getAll("line_price").map(String);
  const lines = services
    .map((service, i) => ({ service, description: descriptions[i] || null, quantity: Number(quantities[i] || "1"), price: prices[i] || "" }))
    .filter((l) => l.service.trim() || l.price.trim())
    .map((l) => ({ service: l.service, description: l.description, quantity: l.quantity, unitCents: cents(l.price, `the price for “${l.service || "a line"}”`) }));
  const discountType = amountType(str(fd, "discountType"));
  const depositType = amountType(str(fd, "depositType"));
  const feeOverride = str(fd, "feeOverrideType");
  return {
    clientId: str(fd, "clientId"),
    title: str(fd, "title"),
    issueDate: str(fd, "issueDate"),
    dueDate: str(fd, "dueDate"),
    memo: str(fd, "memo"),
    paymentTerms: str(fd, "paymentTerms"),
    privateNote: str(fd, "privateNote"),
    lines,
    allowFull: fd.get("allowFull") === "on",
    allowPlan: fd.get("allowPlan") === "on",
    depositType,
    depositValue: amountValue(depositType, str(fd, "depositValue"), "the deposit"),
    discountType,
    discountValue: amountValue(discountType, str(fd, "discountValue"), "the discount"),
    discountCoversPlanFee: fd.get("discountCoversPlanFee") === "on",
    taxRateBps: bps(str(fd, "taxRate") || "0", "the tax rate"),
    planInstallments: Number(str(fd, "planInstallments") || "3"),
    planFirstDueDate: str(fd, "planFirstDueDate") || null,
    planIntervalMonths: Number(str(fd, "planIntervalMonths") || "1"),
    planFeeOverride:
      feeOverride === "FLAT" || feeOverride === "PERCENT" ? { type: feeOverride, value: amountValue(feeOverride, str(fd, "feeOverrideValue"), "the plan fee") } : null,
  };
}

export async function claimOwnerAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  const result = await run(async () => {
    await claimOwnerOffice(actor, str(fd, "password"));
  });
  if (result?.ok) redirect("/owner");
  return result;
}

export async function saveQuoteAction(invoiceId: string | null, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  let id = invoiceId;
  const result = await run(async () => {
    const input = quoteFromForm(fd);
    if (invoiceId) await updateDraft(actor, invoiceId, input);
    else id = (await createQuote(actor, input)).id;
  });
  if (result?.ok) redirect(`/owner/invoices/${id}`);
  return result;
}

export async function offerQuoteAction(invoiceId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await offerQuote(actor, invoiceId);
    revalidatePath(`/owner/invoices/${invoiceId}`);
    return "Quote sent to the client's portal for review and acceptance.";
  });
}

export async function issueInvoiceAction(invoiceId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await issueInvoice(actor, invoiceId);
    revalidatePath(`/owner/invoices/${invoiceId}`);
    return "Invoice published to the client's portal.";
  });
}

export async function withdrawQuoteAction(invoiceId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await withdrawQuote(actor, invoiceId);
    revalidatePath(`/owner/invoices/${invoiceId}`);
    return "Quote withdrawn and back in draft.";
  });
}

export async function voidInvoiceAction(invoiceId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await voidInvoice(actor, invoiceId, str(fd, "reason"));
    revalidatePath(`/owner/invoices/${invoiceId}`);
    return "Voided.";
  });
}

export async function recordPaymentAction(invoiceId: string, _prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const method = str(fd, "method") as PaymentMethod;
    if (!METHODS.includes(method)) throw new ValidationError("Choose how it was paid.");
    const kind = str(fd, "kind") === "REFUND" ? "REFUND" : "PAYMENT";
    const status = str(fd, "status") === "FAILED" ? "FAILED" : "SUCCEEDED";
    await recordPayment(actor, { invoiceId, kind, status, amountCents: cents(str(fd, "amount"), "the amount"), receivedOn: str(fd, "receivedOn"), method, reference: str(fd, "reference"), note: str(fd, "note") });
    revalidatePath(`/owner/invoices/${invoiceId}`);
    return status === "FAILED" ? "Failed payment recorded (it doesn't count toward the balance)." : kind === "REFUND" ? "Refund recorded." : "Payment recorded.";
  });
}

export async function saveBillingSettingsAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const planFeeType = amountType(str(fd, "planFeeType"));
    const discountType = amountType(str(fd, "defaultDiscountType"));
    const depositType = amountType(str(fd, "defaultDepositType"));
    await updateBillingSettings(actor, {
      planFeeType,
      planFeeValue: amountValue(planFeeType, str(fd, "planFeeValue"), "the payment-plan fee"),
      maxInstallments: Number(str(fd, "maxInstallments") || "4"),
      defaultInstallments: Number(str(fd, "defaultInstallments") || "3"),
      defaultDiscountType: discountType,
      defaultDiscountValue: amountValue(discountType, str(fd, "defaultDiscountValue"), "the default discount"),
      defaultTaxRateBps: bps(str(fd, "defaultTaxRate") || "0", "the default tax rate"),
      defaultDepositType: depositType,
      defaultDepositValue: amountValue(depositType, str(fd, "defaultDepositValue"), "the default deposit"),
      defaultPaymentTerms: str(fd, "defaultPaymentTerms"),
      planFeeRulesConfirmed: fd.get("planFeeRulesConfirmed") === "on",
    });
    revalidatePath("/owner/settings");
    return "Billing settings saved. Quotes already sent keep the terms they were sent with.";
  });
}

export async function grantOwnerAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await grantOwnerAccess(actor, { userId: str(fd, "userId"), scope: str(fd, "scope") === "FULL" ? "FULL" : "BILLING", password: str(fd, "password") });
    revalidatePath("/owner/settings");
    return "Access granted.";
  });
}

export async function revokeOwnerAction(userId: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await revokeOwnerAccess(actor, userId);
    revalidatePath("/owner/settings");
    return "Access removed.";
  });
}

export async function createExpenseAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    const f = fd.get("receipt");
    const receipt = f instanceof File && f.size > 0 ? { bytes: new Uint8Array(await f.arrayBuffer()), originalName: f.name } : null;
    const method = str(fd, "method") as PaymentMethod;
    await createExpense(actor, {
      spentOn: str(fd, "spentOn"),
      vendor: str(fd, "vendor"),
      category: str(fd, "category"),
      amountCents: cents(str(fd, "amount"), "the amount"),
      method: METHODS.includes(method) ? method : null,
      note: str(fd, "note"),
      receipt,
    });
    revalidatePath("/owner/expenses");
    return "Expense saved.";
  });
}

export async function deleteExpenseAction(id: string, _prev: ActionState): Promise<ActionState> {
  const actor = await requireUser();
  return run(async () => {
    await deleteExpense(actor, id);
    revalidatePath("/owner/expenses");
    return "Expense removed.";
  });
}
