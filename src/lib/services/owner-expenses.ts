import "server-only";
import { randomBytes } from "node:crypto";
import type { PaymentMethod } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { Actor } from "@/lib/auth/actor";
import { assertOwner, ownerAudit } from "@/lib/auth/owner";
import { storage } from "@/lib/storage";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL, sniffType } from "@/lib/files";
import { ValidationError } from "./clients";

export const EXPENSE_CATEGORIES = [
  "Advertising & marketing",
  "Bank & payment processing fees",
  "Continuing education",
  "Contract labor",
  "Insurance",
  "Licenses, dues & subscriptions",
  "Meals (business)",
  "Office supplies",
  "Payroll",
  "Phone & internet",
  "Professional fees",
  "Rent",
  "Software",
  "Travel",
  "Utilities",
  "Other",
] as const;

const dateOnly = (s: string) => new Date(`${s}T00:00:00.000Z`);

export type ExpenseInput = {
  spentOn: string;
  vendor: string;
  category: string;
  amountCents: number;
  method?: PaymentMethod | null;
  note?: string | null;
  receipt?: { bytes: Uint8Array; originalName: string } | null;
};

/** Owner's private expenses. Receipts go to the owner-only store, never the client document center. */
export async function createExpense(actor: Actor, input: ExpenseInput) {
  await assertOwner(actor, "full");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.spentOn)) throw new ValidationError("Enter the expense date.");
  if (!input.vendor.trim()) throw new ValidationError("Enter who you paid.");
  if (!(EXPENSE_CATEGORIES as readonly string[]).includes(input.category)) throw new ValidationError("Choose a category.");
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw new ValidationError("Enter an amount greater than $0.");
  let receipt: { key: string; name: string; mime: string } | null = null;
  if (input.receipt) {
    if (input.receipt.bytes.byteLength > MAX_UPLOAD_BYTES) throw new ValidationError(`Receipts can be up to ${MAX_UPLOAD_LABEL}.`);
    const type = sniffType(input.receipt.bytes);
    if (!type) throw new ValidationError("Receipts must be PDF, PNG or JPG.");
    receipt = { key: `owner_private/receipts/${randomBytes(16).toString("hex")}`, name: input.receipt.originalName.slice(0, 200), mime: type.mime };
    await storage.put(receipt.key, input.receipt.bytes);
  }
  try {
    const e = await prisma.expense.create({
      data: {
        spentOn: dateOnly(input.spentOn),
        vendor: input.vendor.trim().slice(0, 200),
        category: input.category,
        amountCents: input.amountCents,
        method: input.method ?? null,
        note: input.note?.trim() || null,
        receiptKey: receipt?.key ?? null,
        receiptName: receipt?.name ?? null,
        receiptMime: receipt?.mime ?? null,
        createdById: actor.id,
      },
    });
    await ownerAudit(actor.id, "expense.created", "Expense", e.id);
    return e;
  } catch (err) {
    if (receipt) await storage.remove(receipt.key).catch(() => {});
    throw err;
  }
}

/** Soft delete: the row stays for the audit trail but no longer counts. */
export async function deleteExpense(actor: Actor, id: string) {
  await assertOwner(actor, "full");
  const res = await prisma.expense.updateMany({ where: { id, deletedAt: null }, data: { deletedAt: new Date() } });
  if (res.count !== 1) throw new ValidationError("Not found.");
  await ownerAudit(actor.id, "expense.deleted", "Expense", id);
}

export async function listExpenses(actor: Actor, filter: { year: number; month?: number | null; category?: string | null }) {
  await assertOwner(actor, "full");
  const start = new Date(Date.UTC(filter.year, filter.month ? filter.month - 1 : 0, 1));
  const end = filter.month ? new Date(Date.UTC(filter.year, filter.month, 1)) : new Date(Date.UTC(filter.year + 1, 0, 1));
  return prisma.expense.findMany({
    where: { deletedAt: null, spentOn: { gte: start, lt: end }, ...(filter.category ? { category: filter.category } : {}) },
    orderBy: { spentOn: "desc" },
  });
}

export async function readReceipt(actor: Actor, expenseId: string) {
  await assertOwner(actor, "full");
  const e = await prisma.expense.findUnique({ where: { id: expenseId } });
  if (!e?.receiptKey) return null;
  const bytes = await storage.get(e.receiptKey);
  return bytes ? { bytes, name: e.receiptName ?? "receipt", mime: e.receiptMime ?? "application/octet-stream" } : null;
}
