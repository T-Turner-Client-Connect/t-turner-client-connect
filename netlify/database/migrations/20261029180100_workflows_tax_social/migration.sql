-- CreateEnum
CREATE TYPE "AutomationKind" AS ENUM ('MISSING_DOCUMENT_REMINDER', 'APPOINTMENT_REMINDER', 'CONTRACT_FOLLOW_UP');

-- CreateEnum
CREATE TYPE "FilingType" AS ENUM ('ORIGINAL', 'EXTENSION', 'AMENDED');

-- CreateEnum
CREATE TYPE "PrepStatus" AS ENUM ('AWAITING_INFORMATION', 'IN_PROGRESS', 'UNDER_REVIEW', 'AWAITING_SIGNATURE', 'READY_TO_FILE');

-- CreateEnum
CREATE TYPE "FilingStatus" AS ENUM ('NOT_SUBMITTED', 'SUBMITTED', 'PENDING_ACKNOWLEDGMENT', 'ACCEPTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "FilingMethod" AS ENUM ('ELECTRONIC', 'PAPER');

-- CreateEnum
CREATE TYPE "AmendmentOutcome" AS ENUM ('NONE', 'PROCESSING', 'PROCESSING_COMPLETE', 'CHANGES_APPROVED', 'CHANGES_ADJUSTED', 'REFUND_ISSUED', 'BALANCE_DUE_NOTICE');

-- CreateEnum
CREATE TYPE "StatusSource" AS ENUM ('STAFF', 'TAXACT_IMPORT');

-- CreateEnum
CREATE TYPE "SocialPlatform" AS ENUM ('FACEBOOK', 'INSTAGRAM', 'TIKTOK');

-- CreateEnum
CREATE TYPE "SocialPostStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SCHEDULED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SocialTargetStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'PUBLISHED', 'FAILED', 'REQUIRES_MANUAL_POSTING', 'POSTED_MANUALLY', 'CANCELLED');

-- AlterEnum
ALTER TYPE "MessageChannel" ADD VALUE 'INTERNAL_NOTE';

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "taxSoftwareId" TEXT;

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "filingDocType" TEXT,
ADD COLUMN     "filingId" TEXT;

-- CreateTable
CREATE TABLE "Appointment" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "location" TEXT,
    "staffId" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Appointment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PipelineStage" (
    "id" TEXT NOT NULL,
    "pipeline" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "isWon" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PipelineStage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PipelineCard" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "note" TEXT,
    "ownerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PipelineCard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationRule" (
    "id" TEXT NOT NULL,
    "kind" "AutomationKind" NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "offsetDays" INTEGER NOT NULL,
    "repeatEveryDays" INTEGER,
    "maxReminders" INTEGER NOT NULL DEFAULT 3,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomationRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationRun" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "targetKey" TEXT NOT NULL,
    "clientId" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutomationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FilingRecord" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "taxYear" INTEGER NOT NULL,
    "returnType" TEXT NOT NULL,
    "jurisdiction" TEXT NOT NULL,
    "filingType" "FilingType" NOT NULL DEFAULT 'ORIGINAL',
    "method" "FilingMethod" NOT NULL DEFAULT 'ELECTRONIC',
    "prepStatus" "PrepStatus" NOT NULL DEFAULT 'AWAITING_INFORMATION',
    "filingStatus" "FilingStatus" NOT NULL DEFAULT 'NOT_SUBMITTED',
    "amendmentOutcome" "AmendmentOutcome" NOT NULL DEFAULT 'NONE',
    "submittedAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "filingReference" TEXT,
    "rejectionCodes" TEXT,
    "statusSource" "StatusSource",
    "statusAsOf" TIMESTAMP(3),
    "lastVerifiedAt" TIMESTAMP(3),
    "lastVerifiedById" TEXT,
    "visibleToClient" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FilingRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FilingStatusEvent" (
    "id" TEXT NOT NULL,
    "filingId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "fromValue" TEXT,
    "toValue" TEXT NOT NULL,
    "source" "StatusSource" NOT NULL,
    "actorId" TEXT,
    "importBatchId" TEXT,
    "evidenceDocumentId" TEXT,
    "verificationNote" TEXT,
    "eventAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FilingStatusEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxImportBatch" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mapping" JSONB NOT NULL,
    "statusFilter" TEXT[],
    "status" "ImportStatus" NOT NULL DEFAULT 'REVIEW',
    "importedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "committedAt" TIMESTAMP(3),
    "appliedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "TaxImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxImportRow" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "data" JSONB,
    "errors" TEXT[],
    "warnings" TEXT[],
    "match" TEXT NOT NULL,
    "clientId" TEXT,
    "filingId" TEXT,
    "decision" TEXT,
    "applied" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "TaxImportRow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialPost" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" "SocialPostStatus" NOT NULL DEFAULT 'DRAFT',
    "scheduledAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvalNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialPostTarget" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "platform" "SocialPlatform" NOT NULL,
    "caption" TEXT NOT NULL DEFAULT '',
    "mediaIds" TEXT[],
    "status" "SocialTargetStatus" NOT NULL DEFAULT 'DRAFT',
    "publishMode" TEXT NOT NULL DEFAULT 'MANUAL',
    "idempotencyKey" TEXT NOT NULL,
    "externalPostId" TEXT,
    "permalink" TEXT,
    "errorDetail" TEXT,
    "publishedAt" TIMESTAMP(3),
    "confirmedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialPostTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialAccount" (
    "id" TEXT NOT NULL,
    "platform" "SocialPlatform" NOT NULL,
    "accountName" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "tokenEnc" TEXT NOT NULL,
    "scopes" TEXT[],
    "approvalState" TEXT,
    "connectedById" TEXT NOT NULL,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disconnectedAt" TIMESTAMP(3),

    CONSTRAINT "SocialAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Appointment_startsAt_idx" ON "Appointment"("startsAt");

-- CreateIndex
CREATE INDEX "PipelineStage_pipeline_position_idx" ON "PipelineStage"("pipeline", "position");

-- CreateIndex
CREATE INDEX "PipelineCard_stageId_idx" ON "PipelineCard"("stageId");

-- CreateIndex
CREATE UNIQUE INDEX "PipelineCard_clientId_stageId_key" ON "PipelineCard"("clientId", "stageId");

-- CreateIndex
CREATE UNIQUE INDEX "AutomationRule_kind_key" ON "AutomationRule"("kind");

-- CreateIndex
CREATE UNIQUE INDEX "AutomationRun_dedupeKey_key" ON "AutomationRun"("dedupeKey");

-- CreateIndex
CREATE INDEX "AutomationRun_ruleId_createdAt_idx" ON "AutomationRun"("ruleId", "createdAt");

-- CreateIndex
CREATE INDEX "FilingRecord_filingStatus_idx" ON "FilingRecord"("filingStatus");

-- CreateIndex
CREATE INDEX "FilingRecord_prepStatus_idx" ON "FilingRecord"("prepStatus");

-- CreateIndex
CREATE UNIQUE INDEX "FilingRecord_clientId_taxYear_returnType_jurisdiction_filin_key" ON "FilingRecord"("clientId", "taxYear", "returnType", "jurisdiction", "filingType");

-- CreateIndex
CREATE INDEX "FilingStatusEvent_filingId_createdAt_idx" ON "FilingStatusEvent"("filingId", "createdAt");

-- CreateIndex
CREATE INDEX "TaxImportRow_batchId_rowNumber_idx" ON "TaxImportRow"("batchId", "rowNumber");

-- CreateIndex
CREATE INDEX "SocialPost_scheduledAt_idx" ON "SocialPost"("scheduledAt");

-- CreateIndex
CREATE UNIQUE INDEX "SocialPostTarget_idempotencyKey_key" ON "SocialPostTarget"("idempotencyKey");

-- CreateIndex
CREATE INDEX "SocialPostTarget_status_idx" ON "SocialPostTarget"("status");

-- CreateIndex
CREATE UNIQUE INDEX "SocialPostTarget_postId_platform_key" ON "SocialPostTarget"("postId", "platform");

-- CreateIndex
CREATE UNIQUE INDEX "SocialAccount_platform_externalId_key" ON "SocialAccount"("platform", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "Client_taxSoftwareId_key" ON "Client"("taxSoftwareId");

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_filingId_fkey" FOREIGN KEY ("filingId") REFERENCES "FilingRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PipelineCard" ADD CONSTRAINT "PipelineCard_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PipelineCard" ADD CONSTRAINT "PipelineCard_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "PipelineStage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationRun" ADD CONSTRAINT "AutomationRun_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "AutomationRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FilingRecord" ADD CONSTRAINT "FilingRecord_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FilingStatusEvent" ADD CONSTRAINT "FilingStatusEvent_filingId_fkey" FOREIGN KEY ("filingId") REFERENCES "FilingRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxImportRow" ADD CONSTRAINT "TaxImportRow_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "TaxImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxImportRow" ADD CONSTRAINT "TaxImportRow_filingId_fkey" FOREIGN KEY ("filingId") REFERENCES "FilingRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialPostTarget" ADD CONSTRAINT "SocialPostTarget_postId_fkey" FOREIGN KEY ("postId") REFERENCES "SocialPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

