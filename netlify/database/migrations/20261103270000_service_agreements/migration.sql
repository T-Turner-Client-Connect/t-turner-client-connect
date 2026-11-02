-- Services & pricing agreements: one record per billable service (per tax year or period),
-- versioned signed pricing agreements, and payment-method fee settings. New tables only; existing data unchanged.

-- CreateEnum
CREATE TYPE "ServiceType" AS ENUM ('TAX_INDIVIDUAL', 'TAX_BUSINESS', 'TAX_AMENDED', 'TAX_NONPROFIT', 'BOOKKEEPING', 'PAYROLL', 'NONPROFIT_SERVICES', 'BUSINESS_FORMATION', 'CONSULTING', 'PROPERTY_MANAGEMENT', 'IRS_CORRESPONDENCE', 'OTHER');

-- CreateEnum
CREATE TYPE "ServiceStatus" AS ENUM ('AGREEMENT_PENDING', 'AGREEMENT_SENT', 'AGREEMENT_VIEWED', 'AGREEMENT_SIGNED', 'AWAITING_PAYMENT_AUTHORIZATION', 'APPROVED_TO_BEGIN', 'IN_PROGRESS', 'COMPLETED', 'CLOSED');

-- CreateEnum
CREATE TYPE "AgreementKind" AS ENUM ('SERVICE', 'TAX_PAYMENT_SELECTION');

-- CreateEnum
CREATE TYPE "AgreementStatus" AS ENUM ('DRAFT', 'SENT', 'VIEWED', 'SIGNED', 'SUPERSEDED', 'VOID');

-- CreateTable
CREATE TABLE "ClientService" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "type" "ServiceType" NOT NULL,
    "taxYear" INTEGER,
    "periodLabel" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "ServiceStatus" NOT NULL DEFAULT 'AGREEMENT_PENDING',
    "assignedToId" TEXT,
    "requiresPaymentAuth" BOOLEAN NOT NULL DEFAULT false,
    "paymentAuthAt" TIMESTAMP(3),
    "paymentAuthNote" TEXT,
    "paymentAuthById" TEXT,
    "overrideAt" TIMESTAMP(3),
    "overrideReason" TEXT,
    "overrideById" TEXT,
    "completedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientService_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricingAgreement" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "kind" "AgreementKind" NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "AgreementStatus" NOT NULL DEFAULT 'DRAFT',
    "terms" JSONB NOT NULL,
    "selectedMethod" TEXT,
    "selection" JSONB,
    "termsHash" TEXT,
    "sentAt" TIMESTAMP(3),
    "viewedAt" TIMESTAMP(3),
    "signedAt" TIMESTAMP(3),
    "signerName" TEXT,
    "signedByPortalId" TEXT,
    "signerIp" TEXT,
    "signerAgent" TEXT,
    "consentText" TEXT,
    "pdfDocumentId" TEXT,
    "supersededAt" TIMESTAMP(3),
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PricingAgreement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentFeeSetting" (
    "method" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "percentBps" INTEGER NOT NULL DEFAULT 0,
    "flatCents" INTEGER NOT NULL DEFAULT 0,
    "verifiedNote" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "verifiedById" TEXT,
    "providerName" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentFeeSetting_pkey" PRIMARY KEY ("method")
);

-- CreateIndex
CREATE INDEX "ClientService_clientId_taxYear_idx" ON "ClientService"("clientId", "taxYear");

-- CreateIndex
CREATE INDEX "ClientService_status_idx" ON "ClientService"("status");

-- CreateIndex
CREATE UNIQUE INDEX "PricingAgreement_pdfDocumentId_key" ON "PricingAgreement"("pdfDocumentId");

-- CreateIndex
CREATE INDEX "PricingAgreement_clientId_status_idx" ON "PricingAgreement"("clientId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PricingAgreement_serviceId_version_key" ON "PricingAgreement"("serviceId", "version");

-- AddForeignKey
ALTER TABLE "ClientService" ADD CONSTRAINT "ClientService_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientService" ADD CONSTRAINT "ClientService_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PricingAgreement" ADD CONSTRAINT "PricingAgreement_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "ClientService"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
