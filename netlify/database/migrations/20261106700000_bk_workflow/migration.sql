-- Monthly bookkeeping workflow and Banking & Credit Card Connections.
-- Additive only: new columns are nullable or defaulted; no data is changed or removed.
-- (The one index change lets several employee cards on ONE shared credit account feed the same
-- liability account; one-to-one mapping for everything else is still enforced in code.)

-- AlterEnum
ALTER TYPE "RequestStatus" ADD VALUE 'DRAFT';

-- DropIndex
DROP INDEX "BankConnectionAccount_ledgerAccountId_key";

-- AlterTable
ALTER TABLE "BankConnectionAccount" ADD COLUMN     "balanceAsOf" TIMESTAMP(3),
ADD COLUMN     "creditLimitCents" INTEGER,
ADD COLUMN     "currentBalanceCents" INTEGER,
ADD COLUMN     "sharedReason" TEXT,
ADD COLUMN     "sharedStatus" TEXT,
ADD COLUMN     "sharedWithId" TEXT;

-- AlterTable
ALTER TABLE "BankTransaction" ADD COLUMN     "providerAccountId" TEXT;

-- AlterTable
ALTER TABLE "BookkeepingAccount" ADD COLUMN     "cardholderLabel" TEXT,
ADD COLUMN     "ledgerAccountId" TEXT,
ADD COLUMN     "monitored" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "openingBalanceCents" INTEGER,
ADD COLUMN     "openingBalanceDate" DATE,
ADD COLUMN     "parentAccountId" TEXT,
ADD COLUMN     "statementDay" INTEGER;

-- AlterTable
ALTER TABLE "DocumentRequest" ADD COLUMN     "bookkeepingAccountId" TEXT,
ADD COLUMN     "docType" TEXT,
ADD COLUMN     "draftKey" TEXT,
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'GENERAL',
ADD COLUMN     "periodEnd" DATE,
ADD COLUMN     "periodStart" DATE,
ADD COLUMN     "sentAt" TIMESTAMP(3),
ADD COLUMN     "sentById" TEXT,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'STAFF',
ADD COLUMN     "taxYear" INTEGER;

-- AlterTable
ALTER TABLE "IntegrationSettings" ADD COLUMN     "coethaAutoSendChangedAt" TIMESTAMP(3),
ADD COLUMN     "coethaAutoSendChangedById" TEXT,
ADD COLUMN     "coethaAutoSendRequests" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "AccountReconciliation" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "bookkeepingAccountId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "statementClosingDate" DATE,
    "beginningBalanceCents" INTEGER,
    "endingBalanceCents" INTEGER,
    "balanceSource" TEXT,
    "transactionsImported" INTEGER NOT NULL DEFAULT 0,
    "paymentsCreditsCents" INTEGER NOT NULL DEFAULT 0,
    "chargesDebitsCents" INTEGER NOT NULL DEFAULT 0,
    "unmatchedCount" INTEGER NOT NULL DEFAULT 0,
    "differenceCents" INTEGER,
    "statementStatus" TEXT NOT NULL DEFAULT 'MISSING',
    "statementDocumentId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NOT_DUE',
    "exceptions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "preparedAt" TIMESTAMP(3),
    "preparedById" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "bankReconciliationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountReconciliation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccountReconciliation_clientId_year_month_idx" ON "AccountReconciliation"("clientId", "year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "AccountReconciliation_bookkeepingAccountId_year_month_key" ON "AccountReconciliation"("bookkeepingAccountId", "year", "month");

-- CreateIndex
CREATE INDEX "BankConnectionAccount_ledgerAccountId_idx" ON "BankConnectionAccount"("ledgerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "BookkeepingAccount_ledgerAccountId_key" ON "BookkeepingAccount"("ledgerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentRequest_clientId_draftKey_key" ON "DocumentRequest"("clientId", "draftKey");

-- AddForeignKey
ALTER TABLE "DocumentRequest" ADD CONSTRAINT "DocumentRequest_bookkeepingAccountId_fkey" FOREIGN KEY ("bookkeepingAccountId") REFERENCES "BookkeepingAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookkeepingAccount" ADD CONSTRAINT "BookkeepingAccount_ledgerAccountId_fkey" FOREIGN KEY ("ledgerAccountId") REFERENCES "LedgerAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookkeepingAccount" ADD CONSTRAINT "BookkeepingAccount_parentAccountId_fkey" FOREIGN KEY ("parentAccountId") REFERENCES "BookkeepingAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountReconciliation" ADD CONSTRAINT "AccountReconciliation_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountReconciliation" ADD CONSTRAINT "AccountReconciliation_bookkeepingAccountId_fkey" FOREIGN KEY ("bookkeepingAccountId") REFERENCES "BookkeepingAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

