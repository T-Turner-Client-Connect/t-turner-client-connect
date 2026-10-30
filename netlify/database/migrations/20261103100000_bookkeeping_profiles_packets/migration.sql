-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ReportType" ADD VALUE 'GROSS_RECEIPTS';
ALTER TYPE "ReportType" ADD VALUE 'BANK_RECONCILIATION';
ALTER TYPE "ReportType" ADD VALUE 'SUPPORTING_SCHEDULE';
ALTER TYPE "ReportType" ADD VALUE 'FINANCIAL_PACKET';

-- AlterTable
ALTER TABLE "BookkeepingProfile" ADD COLUMN     "accountingBasis" TEXT,
ADD COLUMN     "businessAddress1" TEXT,
ADD COLUMN     "businessAddress2" TEXT,
ADD COLUMN     "businessCity" TEXT,
ADD COLUMN     "businessEmail" TEXT,
ADD COLUMN     "businessPostalCode" TEXT,
ADD COLUMN     "businessStartDate" TIMESTAMP(3),
ADD COLUMN     "businessState" TEXT,
ADD COLUMN     "contactName" TEXT,
ADD COLUMN     "contactPhone" TEXT,
ADD COLUMN     "contactTitle" TEXT,
ADD COLUMN     "dba" TEXT,
ADD COLUMN     "einEncrypted" TEXT,
ADD COLUMN     "einLast4" TEXT,
ADD COLUMN     "legalName" TEXT,
ADD COLUMN     "payrollAccessStatus" TEXT,
ADD COLUMN     "payrollReports" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "workingYear" INTEGER;

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "bookkeepingAccountId" TEXT,
ADD COLUMN     "reportAsOf" TIMESTAMP(3),
ADD COLUMN     "reportBasis" TEXT,
ADD COLUMN     "reportIncludesYtd" BOOLEAN,
ADD COLUMN     "reportPeriodType" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "bookkeepingBillingAccess" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "bookkeepingBillingGrantedAt" TIMESTAMP(3),
ADD COLUMN     "bookkeepingBillingGrantedBy" TEXT;


-- CreateTable
CREATE TABLE "BookkeepingAccount" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "institution" TEXT NOT NULL,
    "accountType" TEXT NOT NULL,
    "last4" TEXT,
    "nickname" TEXT,
    "loginUrl" TEXT,
    "accessStatus" TEXT NOT NULL DEFAULT 'NOT_REQUESTED',
    "accessNote" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookkeepingAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookkeepingBilling" (
    "clientId" TEXT NOT NULL,
    "monthlyFeeCents" INTEGER,
    "billingStartDate" TIMESTAMP(3),
    "billingDay" INTEGER,
    "paymentStatus" TEXT NOT NULL DEFAULT 'NOT_SET_UP',
    "squareCustomerId" TEXT,
    "squareCardId" TEXT,
    "notes" TEXT,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookkeepingBilling_pkey" PRIMARY KEY ("clientId")
);

-- CreateTable
CREATE TABLE "RecurringChargeAuthorization" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "frequency" TEXT NOT NULL DEFAULT 'MONTHLY',
    "startDate" TIMESTAMP(3) NOT NULL,
    "method" TEXT NOT NULL,
    "authorizedByName" TEXT NOT NULL,
    "authorizedAt" TIMESTAMP(3) NOT NULL,
    "evidenceDocumentId" TEXT,
    "recordedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "revokeReason" TEXT,

    CONSTRAINT "RecurringChargeAuthorization_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BookkeepingAccount_clientId_idx" ON "BookkeepingAccount"("clientId");

-- CreateIndex
CREATE INDEX "RecurringChargeAuthorization_clientId_idx" ON "RecurringChargeAuthorization"("clientId");

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_bookkeepingAccountId_fkey" FOREIGN KEY ("bookkeepingAccountId") REFERENCES "BookkeepingAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookkeepingAccount" ADD CONSTRAINT "BookkeepingAccount_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookkeepingBilling" ADD CONSTRAINT "BookkeepingBilling_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringChargeAuthorization" ADD CONSTRAINT "RecurringChargeAuthorization_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

