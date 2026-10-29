-- CreateEnum
CREATE TYPE "OwnerScope" AS ENUM ('FULL', 'BILLING');

-- CreateEnum
CREATE TYPE "InvoiceState" AS ENUM ('DRAFT', 'OFFERED', 'ACCEPTED', 'ISSUED', 'DECLINED', 'VOID');

-- CreateEnum
CREATE TYPE "AmountType" AS ENUM ('NONE', 'FLAT', 'PERCENT');

-- CreateEnum
CREATE TYPE "PaymentOption" AS ENUM ('FULL', 'PLAN');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'CHECK', 'CARD', 'ACH', 'ZELLE', 'CASH_APP', 'OTHER');

-- CreateEnum
CREATE TYPE "PaymentKind" AS ENUM ('PAYMENT', 'REFUND');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('SUCCEEDED', 'FAILED', 'PENDING');

-- AlterTable
ALTER TABLE "PortalAccess" ADD COLUMN     "canViewBilling" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "OwnerAccess" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "scope" "OwnerScope" NOT NULL DEFAULT 'FULL',
    "grantedById" TEXT,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "OwnerAccess_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OwnerAuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OwnerAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "state" "InvoiceState" NOT NULL DEFAULT 'DRAFT',
    "title" TEXT NOT NULL,
    "issueDate" DATE NOT NULL,
    "dueDate" DATE NOT NULL,
    "memo" TEXT,
    "paymentTerms" TEXT,
    "privateNote" TEXT,
    "allowFull" BOOLEAN NOT NULL DEFAULT true,
    "allowPlan" BOOLEAN NOT NULL DEFAULT false,
    "depositType" "AmountType" NOT NULL DEFAULT 'NONE',
    "depositValue" INTEGER NOT NULL DEFAULT 0,
    "discountType" "AmountType" NOT NULL DEFAULT 'NONE',
    "discountValue" INTEGER NOT NULL DEFAULT 0,
    "discountCoversPlanFee" BOOLEAN NOT NULL DEFAULT false,
    "taxRateBps" INTEGER NOT NULL DEFAULT 0,
    "planFeeType" "AmountType" NOT NULL DEFAULT 'NONE',
    "planFeeValue" INTEGER NOT NULL DEFAULT 0,
    "planInstallments" INTEGER NOT NULL DEFAULT 3,
    "planFirstDueDate" DATE,
    "planIntervalMonths" INTEGER NOT NULL DEFAULT 1,
    "publishedAt" TIMESTAMP(3),
    "acceptedOption" "PaymentOption",
    "acceptedAt" TIMESTAMP(3),
    "acceptedByPortalId" TEXT,
    "acceptedTerms" JSONB,
    "acceptedTermsHash" TEXT,
    "acceptedFromIp" TEXT,
    "declinedAt" TIMESTAMP(3),
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceLine" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "description" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitCents" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "InvoiceLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Installment" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "dueDate" DATE NOT NULL,
    "amountCents" INTEGER NOT NULL,

    CONSTRAINT "Installment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "kind" "PaymentKind" NOT NULL DEFAULT 'PAYMENT',
    "status" "PaymentStatus" NOT NULL DEFAULT 'SUCCEEDED',
    "amountCents" INTEGER NOT NULL,
    "receivedOn" DATE NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "providerRef" TEXT,
    "reference" TEXT,
    "note" TEXT,
    "failureNote" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "planFeeType" "AmountType" NOT NULL DEFAULT 'NONE',
    "planFeeValue" INTEGER NOT NULL DEFAULT 0,
    "maxInstallments" INTEGER NOT NULL DEFAULT 4,
    "defaultInstallments" INTEGER NOT NULL DEFAULT 3,
    "defaultDiscountType" "AmountType" NOT NULL DEFAULT 'NONE',
    "defaultDiscountValue" INTEGER NOT NULL DEFAULT 0,
    "defaultTaxRateBps" INTEGER NOT NULL DEFAULT 0,
    "defaultDepositType" "AmountType" NOT NULL DEFAULT 'NONE',
    "defaultDepositValue" INTEGER NOT NULL DEFAULT 0,
    "defaultPaymentTerms" TEXT,
    "planFeeRulesConfirmedAt" TIMESTAMP(3),
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Expense" (
    "id" TEXT NOT NULL,
    "spentOn" DATE NOT NULL,
    "vendor" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "method" "PaymentMethod",
    "note" TEXT,
    "receiptKey" TEXT,
    "receiptName" TEXT,
    "receiptMime" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OwnerAccess_userId_key" ON "OwnerAccess"("userId");

-- CreateIndex
CREATE INDEX "OwnerAuditLog_createdAt_idx" ON "OwnerAuditLog"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_number_key" ON "Invoice"("number");

-- CreateIndex
CREATE INDEX "Invoice_clientId_state_idx" ON "Invoice"("clientId", "state");

-- CreateIndex
CREATE INDEX "Invoice_issueDate_idx" ON "Invoice"("issueDate");

-- CreateIndex
CREATE UNIQUE INDEX "Installment_invoiceId_seq_key" ON "Installment"("invoiceId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_providerRef_key" ON "Payment"("providerRef");

-- CreateIndex
CREATE INDEX "Payment_receivedOn_idx" ON "Payment"("receivedOn");

-- CreateIndex
CREATE INDEX "Payment_invoiceId_idx" ON "Payment"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "Expense_receiptKey_key" ON "Expense"("receiptKey");

-- CreateIndex
CREATE INDEX "Expense_spentOn_idx" ON "Expense"("spentOn");

-- AddForeignKey
ALTER TABLE "OwnerAccess" ADD CONSTRAINT "OwnerAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Installment" ADD CONSTRAINT "Installment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

