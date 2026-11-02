-- In-house payment plans, payment instructions, owner-approved payment-method changes,
-- the late-fee policy (disabled) and fee waivers. One nullable column on Invoice; new tables otherwise.
-- Also removes the payment-plan fee (owner's decision): plans never add a fee.
-- Quotes already accepted keep the terms they were accepted with.

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "paymentMethod" TEXT;

-- CreateTable
CREATE TABLE "InstallmentPlan" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "invoiceId" TEXT,
    "serviceId" TEXT,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "serviceCents" INTEGER NOT NULL,
    "card" TEXT NOT NULL,
    "months" INTEGER NOT NULL,
    "feeCents" INTEGER NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "depositCents" INTEGER NOT NULL,
    "schedule" JSONB NOT NULL,
    "terms" JSONB NOT NULL,
    "termsHash" TEXT NOT NULL,
    "requestedById" TEXT,
    "requestedByPortalId" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "acceptedByPortalId" TEXT,
    "acceptedName" TEXT,
    "acceptedIp" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "declinedAt" TIMESTAMP(3),
    "declinedById" TEXT,
    "declineReason" TEXT,
    "cardAuthorizedAt" TIMESTAMP(3),
    "cardAuthorizationRef" TEXT,
    "verifiedCardType" TEXT,
    "paidCents" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InstallmentPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentInstruction" (
    "method" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "details" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentInstruction_pkey" PRIMARY KEY ("method")
);

-- CreateTable
CREATE TABLE "PaymentMethodChange" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "invoiceId" TEXT,
    "planId" TEXT,
    "fromMethod" TEXT,
    "toMethod" TEXT NOT NULL,
    "reason" TEXT,
    "requestedById" TEXT,
    "requestedByPortalId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentMethodChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LateFeeSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "graceDays" INTEGER NOT NULL DEFAULT 5,
    "periodDays" INTEGER NOT NULL DEFAULT 5,
    "rateBps" INTEGER NOT NULL DEFAULT 1000,
    "capBps" INTEGER,
    "reviewedNote" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LateFeeSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeeWaiver" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "planId" TEXT,
    "invoiceId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "waivedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeeWaiver_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InstallmentPlan_clientId_status_idx" ON "InstallmentPlan"("clientId", "status");

-- CreateIndex
CREATE INDEX "InstallmentPlan_status_idx" ON "InstallmentPlan"("status");

-- CreateIndex
CREATE INDEX "PaymentMethodChange_status_idx" ON "PaymentMethodChange"("status");

-- AddForeignKey
ALTER TABLE "InstallmentPlan" ADD CONSTRAINT "InstallmentPlan_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

UPDATE "BillingSettings" SET "planFeeType" = 'NONE', "planFeeValue" = 0;

-- Late-fee policy as proposed by the owner, stored DISABLED.
INSERT INTO "LateFeeSettings" ("id", "enabled", "graceDays", "periodDays", "rateBps", "updatedAt") VALUES ('default', false, 5, 5, 1000, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
