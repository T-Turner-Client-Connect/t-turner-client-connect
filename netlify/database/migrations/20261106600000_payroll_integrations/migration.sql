-- AlterEnum
ALTER TYPE "ChallengePurpose" ADD VALUE 'PAYROLL_APPROVAL';

-- AlterTable
ALTER TABLE "BookkeepingProfile" ADD COLUMN     "payrollConnection" TEXT,
ADD COLUMN     "payrollSystem" TEXT;

-- CreateTable
CREATE TABLE "PayrollImport" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSha256" TEXT NOT NULL,
    "documentId" TEXT,
    "rows" INTEGER NOT NULL,
    "payDates" INTEGER NOT NULL,
    "created" INTEGER NOT NULL,
    "duplicates" INTEGER NOT NULL,
    "mapping" JSONB NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollRun" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "origin" TEXT NOT NULL DEFAULT 'IMPORT',
    "importId" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "checkDate" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "currentVersionId" TEXT,
    "approvalRound" INTEGER NOT NULL DEFAULT 0,
    "approvalRequestedAt" TIMESTAMP(3),
    "approvalRequestedById" TEXT,
    "fullyApprovedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "submittedById" TEXT,
    "submissionMethod" TEXT,
    "submissionNote" TEXT,
    "cashAccountId" TEXT,
    "journalEntryId" TEXT,
    "postedAt" TIMESTAMP(3),
    "postedById" TEXT,
    "discardedAt" TIMESTAMP(3),
    "discardedById" TEXT,
    "discardReason" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollRunVersion" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "checkDate" DATE NOT NULL,
    "periodStart" DATE,
    "periodEnd" DATE,
    "employees" INTEGER NOT NULL,
    "hoursHundredths" INTEGER NOT NULL DEFAULT 0,
    "grossCents" INTEGER NOT NULL,
    "federalWhCents" INTEGER NOT NULL DEFAULT 0,
    "ssEeCents" INTEGER NOT NULL DEFAULT 0,
    "medicareEeCents" INTEGER NOT NULL DEFAULT 0,
    "stateWhCents" INTEGER NOT NULL DEFAULT 0,
    "otherEeTaxCents" INTEGER NOT NULL DEFAULT 0,
    "employerTaxCents" INTEGER NOT NULL DEFAULT 0,
    "deductionsCents" INTEGER NOT NULL DEFAULT 0,
    "netPayCents" INTEGER NOT NULL,
    "reason" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollRunVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollRunLine" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "employeeName" TEXT NOT NULL,
    "hoursHundredths" INTEGER NOT NULL DEFAULT 0,
    "grossCents" INTEGER NOT NULL,
    "federalWhCents" INTEGER NOT NULL DEFAULT 0,
    "ssEeCents" INTEGER NOT NULL DEFAULT 0,
    "medicareEeCents" INTEGER NOT NULL DEFAULT 0,
    "stateWhCents" INTEGER NOT NULL DEFAULT 0,
    "otherEeTaxCents" INTEGER NOT NULL DEFAULT 0,
    "employerTaxCents" INTEGER NOT NULL DEFAULT 0,
    "deductionsCents" INTEGER NOT NULL DEFAULT 0,
    "netPayCents" INTEGER NOT NULL,

    CONSTRAINT "PayrollRunLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollApprover" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "portalUserId" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "showEmployeeDetail" BOOLEAN NOT NULL DEFAULT true,
    "notifyChannel" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "designatedById" TEXT NOT NULL,
    "removedAt" TIMESTAMP(3),
    "removedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollApprover_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollApproval" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "clientId" TEXT NOT NULL,
    "portalUserId" TEXT NOT NULL,
    "approverName" TEXT NOT NULL,
    "approverEmail" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "comment" TEXT,
    "channel" TEXT NOT NULL,
    "verifiedBy" TEXT NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "linkId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollApprovalLink" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "portalUserId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "verifyNonceHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollApprovalLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollNotice" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "portalUserId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "detail" TEXT,
    "linkId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "PayrollNotice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollRunEvent" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "versionNumber" INTEGER,
    "actorUserId" TEXT,
    "portalUserId" TEXT,
    "actorName" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollRunEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollConnection" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NOT_CONNECTED',
    "externalCompanyId" TEXT,
    "note" TEXT,
    "requestedAt" TIMESTAMP(3),
    "connectedAt" TIMESTAMP(3),
    "lastSyncAt" TIMESTAMP(3),
    "lastSyncError" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PayrollImport_clientId_idx" ON "PayrollImport"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollRun_currentVersionId_key" ON "PayrollRun"("currentVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollRun_journalEntryId_key" ON "PayrollRun"("journalEntryId");

-- CreateIndex
CREATE INDEX "PayrollRun_clientId_checkDate_idx" ON "PayrollRun"("clientId", "checkDate");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollRun_clientId_dedupeKey_key" ON "PayrollRun"("clientId", "dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollRunVersion_runId_number_key" ON "PayrollRunVersion"("runId", "number");

-- CreateIndex
CREATE INDEX "PayrollRunLine_versionId_idx" ON "PayrollRunLine"("versionId");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollApprover_clientId_portalUserId_key" ON "PayrollApprover"("clientId", "portalUserId");

-- CreateIndex
CREATE INDEX "PayrollApproval_portalUserId_idx" ON "PayrollApproval"("portalUserId");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollApproval_runId_round_portalUserId_key" ON "PayrollApproval"("runId", "round", "portalUserId");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollApprovalLink_tokenHash_key" ON "PayrollApprovalLink"("tokenHash");

-- CreateIndex
CREATE INDEX "PayrollApprovalLink_runId_idx" ON "PayrollApprovalLink"("runId");

-- CreateIndex
CREATE INDEX "PayrollApprovalLink_portalUserId_idx" ON "PayrollApprovalLink"("portalUserId");

-- CreateIndex
CREATE INDEX "PayrollNotice_runId_round_idx" ON "PayrollNotice"("runId", "round");

-- CreateIndex
CREATE INDEX "PayrollNotice_status_idx" ON "PayrollNotice"("status");

-- CreateIndex
CREATE INDEX "PayrollRunEvent_runId_createdAt_idx" ON "PayrollRunEvent"("runId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollConnection_clientId_provider_key" ON "PayrollConnection"("clientId", "provider");

-- AddForeignKey
ALTER TABLE "PayrollImport" ADD CONSTRAINT "PayrollImport_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRun" ADD CONSTRAINT "PayrollRun_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRun" ADD CONSTRAINT "PayrollRun_importId_fkey" FOREIGN KEY ("importId") REFERENCES "PayrollImport"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRunVersion" ADD CONSTRAINT "PayrollRunVersion_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PayrollRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRunLine" ADD CONSTRAINT "PayrollRunLine_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "PayrollRunVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollApprover" ADD CONSTRAINT "PayrollApprover_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollApprover" ADD CONSTRAINT "PayrollApprover_portalUserId_fkey" FOREIGN KEY ("portalUserId") REFERENCES "PortalUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollApproval" ADD CONSTRAINT "PayrollApproval_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PayrollRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollApproval" ADD CONSTRAINT "PayrollApproval_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "PayrollRunVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollApproval" ADD CONSTRAINT "PayrollApproval_portalUserId_fkey" FOREIGN KEY ("portalUserId") REFERENCES "PortalUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollApprovalLink" ADD CONSTRAINT "PayrollApprovalLink_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PayrollRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollNotice" ADD CONSTRAINT "PayrollNotice_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PayrollRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRunEvent" ADD CONSTRAINT "PayrollRunEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PayrollRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollConnection" ADD CONSTRAINT "PayrollConnection_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

