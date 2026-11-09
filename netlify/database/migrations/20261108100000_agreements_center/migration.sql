-- Agreements & Contracts center. Additive only: new clause/template/agreement/signing-link tables
-- and one nullable column on Invoice (the agreement an invoice was made from). Nothing is dropped
-- or rewritten; earlier pricing agreements (PricingAgreement, ClientService) are kept as they are.
-- The clause library and templates are seeded by the app on first use, not here.

-- CreateEnum
CREATE TYPE "ClauseStatus" AS ENUM ('DRAFT', 'APPROVED');

-- CreateEnum
CREATE TYPE "ClientAgreementStatus" AS ENUM ('DRAFT', 'WAITING_FOR_OWNER', 'SENT', 'SIGNED', 'DECLINED', 'EXPIRED', 'VOID');

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "agreementId" TEXT;

-- CreateTable
CREATE TABLE "AgreementClause" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'TERM',
    "sortOrder" INTEGER NOT NULL DEFAULT 100,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgreementClause_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgreementClauseVersion" (
    "id" TEXT NOT NULL,
    "clauseId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "status" "ClauseStatus" NOT NULL DEFAULT 'DRAFT',
    "source" TEXT NOT NULL DEFAULT 'DRAFTED',
    "approvedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgreementClauseVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgreementTemplate" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 100,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgreementTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgreementTemplateVersion" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "intro" TEXT NOT NULL,
    "clauseKeys" TEXT[],
    "defaults" JSONB NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgreementTemplateVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientAgreement" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "templateVersion" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "status" "ClientAgreementStatus" NOT NULL DEFAULT 'DRAFT',
    "options" JSONB NOT NULL,
    "serviceTypes" "ServiceType"[],
    "taxYear" INTEGER,
    "startDate" DATE,
    "termEndDate" DATE,
    "frozenText" TEXT,
    "frozenClauses" JSONB,
    "textHash" TEXT,
    "requestedAt" TIMESTAMP(3),
    "requestedById" TEXT,
    "sentAt" TIMESTAMP(3),
    "sentById" TEXT,
    "sentVia" TEXT,
    "signBy" TIMESTAMP(3),
    "signedAt" TIMESTAMP(3),
    "signerName" TEXT,
    "signerAddress" TEXT,
    "signerPhone" TEXT,
    "signerEmail" TEXT,
    "signerAnswers" JSONB,
    "acknowledgments" JSONB,
    "signerIp" TEXT,
    "signerAgent" TEXT,
    "signedByPortalId" TEXT,
    "signedViaLinkId" TEXT,
    "pdfDocumentId" TEXT,
    "declinedAt" TIMESTAMP(3),
    "declineReason" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "renewsId" TEXT,
    "bulkBatchId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientAgreement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgreementSigningLink" (
    "id" TEXT NOT NULL,
    "agreementId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "emailedAt" TIMESTAMP(3),
    "emailedTo" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgreementSigningLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgreementClause_key_key" ON "AgreementClause"("key");

-- CreateIndex
CREATE UNIQUE INDEX "AgreementClauseVersion_clauseId_version_key" ON "AgreementClauseVersion"("clauseId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "AgreementTemplate_key_key" ON "AgreementTemplate"("key");

-- CreateIndex
CREATE UNIQUE INDEX "AgreementTemplateVersion_templateId_version_key" ON "AgreementTemplateVersion"("templateId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "ClientAgreement_pdfDocumentId_key" ON "ClientAgreement"("pdfDocumentId");

-- CreateIndex
CREATE INDEX "ClientAgreement_clientId_status_idx" ON "ClientAgreement"("clientId", "status");

-- CreateIndex
CREATE INDEX "ClientAgreement_status_idx" ON "ClientAgreement"("status");

-- CreateIndex
CREATE INDEX "ClientAgreement_bulkBatchId_idx" ON "ClientAgreement"("bulkBatchId");

-- CreateIndex
CREATE UNIQUE INDEX "AgreementSigningLink_tokenHash_key" ON "AgreementSigningLink"("tokenHash");

-- CreateIndex
CREATE INDEX "AgreementSigningLink_agreementId_idx" ON "AgreementSigningLink"("agreementId");

-- CreateIndex
CREATE INDEX "Invoice_agreementId_idx" ON "Invoice"("agreementId");

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_agreementId_fkey" FOREIGN KEY ("agreementId") REFERENCES "ClientAgreement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgreementClauseVersion" ADD CONSTRAINT "AgreementClauseVersion_clauseId_fkey" FOREIGN KEY ("clauseId") REFERENCES "AgreementClause"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgreementTemplateVersion" ADD CONSTRAINT "AgreementTemplateVersion_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "AgreementTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientAgreement" ADD CONSTRAINT "ClientAgreement_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientAgreement" ADD CONSTRAINT "ClientAgreement_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "AgreementTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientAgreement" ADD CONSTRAINT "ClientAgreement_renewsId_fkey" FOREIGN KEY ("renewsId") REFERENCES "ClientAgreement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgreementSigningLink" ADD CONSTRAINT "AgreementSigningLink_agreementId_fkey" FOREIGN KEY ("agreementId") REFERENCES "ClientAgreement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

