-- CreateEnum
CREATE TYPE "TaxSummaryStatus" AS ENUM ('DRAFT', 'SENT', 'CHANGES_REQUESTED', 'CLIENT_APPROVED', 'SUPERSEDED', 'WITHDRAWN');


-- CreateTable
CREATE TABLE "TaxReturnSummary" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "taxYear" INTEGER NOT NULL,
    "filingType" TEXT NOT NULL DEFAULT 'ORIGINAL',
    "version" INTEGER NOT NULL DEFAULT 1,
    "replacesId" TEXT,
    "status" "TaxSummaryStatus" NOT NULL DEFAULT 'DRAFT',
    "filingStatus" TEXT NOT NULL,
    "taxpayerName" TEXT NOT NULL,
    "spouseName" TEXT,
    "dependents" JSONB NOT NULL DEFAULT '[]',
    "wagesCents" INTEGER NOT NULL DEFAULT 0,
    "otherIncomeCents" INTEGER NOT NULL DEFAULT 0,
    "totalIncomeCents" INTEGER NOT NULL DEFAULT 0,
    "agiCents" INTEGER NOT NULL DEFAULT 0,
    "deductionType" TEXT NOT NULL DEFAULT 'STANDARD',
    "deductionCents" INTEGER NOT NULL DEFAULT 0,
    "taxableIncomeCents" INTEGER NOT NULL DEFAULT 0,
    "federalResultCents" INTEGER NOT NULL DEFAULT 0,
    "stateResults" JSONB NOT NULL DEFAULT '[]',
    "depositBankName" TEXT,
    "depositAccountType" TEXT,
    "depositRoutingLast4" TEXT,
    "depositAccountLast4" TEXT,
    "officeNote" TEXT,
    "figuresHash" TEXT NOT NULL,
    "preparedById" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3),
    "sentById" TEXT,
    "changesRequestedAt" TIMESTAMP(3),
    "changesRequestNote" TEXT,
    "changesRequestedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "invalidatedAt" TIMESTAMP(3),
    "invalidatedReason" TEXT,
    "taxpayerSsnLast4" TEXT,
    "spouseSsnLast4" TEXT,
    "returnDocumentId" TEXT,
    "extractedAt" TIMESTAMP(3),
    "returnTotals" JSONB,
    "changesRequestItems" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaxReturnSummary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxSummarySignature" (
    "id" TEXT NOT NULL,
    "summaryId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "signerName" TEXT NOT NULL,
    "portalUserId" TEXT,
    "signedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "consentText" TEXT NOT NULL,
    "figuresHash" TEXT NOT NULL,
    "invalidatedAt" TIMESTAMP(3),

    CONSTRAINT "TaxSummarySignature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxSummaryItem" (
    "id" TEXT NOT NULL,
    "summaryId" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "formType" TEXT NOT NULL,
    "payerName" TEXT NOT NULL,
    "recipient" TEXT NOT NULL DEFAULT 'TAXPAYER',
    "documentAmounts" JSONB,
    "returnAmounts" JSONB,
    "source" TEXT NOT NULL,
    "sourceDocumentId" TEXT,
    "sourcePage" INTEGER,
    "evidence" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NEEDS_REVIEW',
    "onReturn" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "verifiedById" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaxSummaryItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxSummaryCheck" (
    "id" TEXT NOT NULL,
    "summaryId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'BLOCKING',
    "message" TEXT NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "resolutionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaxSummaryCheck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TaxReturnSummary_clientId_taxYear_idx" ON "TaxReturnSummary"("clientId", "taxYear");

-- CreateIndex
CREATE INDEX "TaxReturnSummary_status_idx" ON "TaxReturnSummary"("status");

-- CreateIndex
CREATE UNIQUE INDEX "TaxSummarySignature_summaryId_role_key" ON "TaxSummarySignature"("summaryId", "role");

-- CreateIndex
CREATE INDEX "TaxSummaryItem_summaryId_idx" ON "TaxSummaryItem"("summaryId");

-- CreateIndex
CREATE UNIQUE INDEX "TaxSummaryCheck_summaryId_code_key" ON "TaxSummaryCheck"("summaryId", "code");

-- AddForeignKey
ALTER TABLE "TaxReturnSummary" ADD CONSTRAINT "TaxReturnSummary_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxSummarySignature" ADD CONSTRAINT "TaxSummarySignature_summaryId_fkey" FOREIGN KEY ("summaryId") REFERENCES "TaxReturnSummary"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxSummaryItem" ADD CONSTRAINT "TaxSummaryItem_summaryId_fkey" FOREIGN KEY ("summaryId") REFERENCES "TaxReturnSummary"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxSummaryCheck" ADD CONSTRAINT "TaxSummaryCheck_summaryId_fkey" FOREIGN KEY ("summaryId") REFERENCES "TaxReturnSummary"("id") ON DELETE CASCADE ON UPDATE CASCADE;

