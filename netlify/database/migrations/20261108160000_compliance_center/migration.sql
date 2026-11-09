-- Tax & Compliance Center: compliance entities (many per client), versioned rules library,
-- obligations, filing periods, evidence, return versions + client approvals, filing accounts &
-- portals (no passwords), authorizations, reminders (deduped) and office settings.
-- Additive only: new tables, no existing table or column is changed. Rules are loaded from
-- src/lib/compliance/rules-data.ts by the app (versioned, idempotent), not by this file.
-- Safety switches (ComplianceSettings) default OFF.


-- CreateTable
CREATE TABLE "ComplianceEntity" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "legalName" TEXT,
    "dba" TEXT,
    "einEncrypted" TEXT,
    "einLast4" TEXT,
    "einHash" TEXT,
    "stateOfFormation" TEXT,
    "statesOfOperation" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "industry" TEXT,
    "naicsCode" TEXT,
    "activityDescription" TEXT,
    "activityTags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "legalEntityType" TEXT,
    "taxClassification" TEXT,
    "sCorpEffectiveDate" DATE,
    "fiscalYearEndMonth" INTEGER,
    "payrollStatus" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "employeeCount" INTEGER,
    "payrollProvider" TEXT,
    "issues1099" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "ownerHasNonprofit" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "linkedEntityId" TEXT,
    "nonprofitClientId" TEXT,
    "irsExemptionStatus" TEXT,
    "services" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "factSources" JSONB NOT NULL DEFAULT '{}',
    "portalVisible" BOOLEAN NOT NULL DEFAULT false,
    "clientNotificationsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "proposalKey" TEXT,
    "proposalRole" TEXT,
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "ComplianceEntity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComplianceEntityOwner" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "businessOwnerId" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComplianceEntityOwner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComplianceEntityViewer" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "portalUserId" TEXT NOT NULL,
    "grantedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "ComplianceEntityViewer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComplianceLocation" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "label" TEXT,
    "address1" TEXT,
    "city" TEXT,
    "county" TEXT,
    "state" TEXT,
    "postalCode" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComplianceLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComplianceTaxAccount" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "agency" TEXT NOT NULL,
    "jurisdictionLevel" TEXT,
    "jurisdictionName" TEXT,
    "accountNumberEnc" TEXT,
    "accountLast4" TEXT,
    "filingFrequency" TEXT,
    "effectiveDate" DATE,
    "status" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "source" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComplianceTaxAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComplianceEntityLicense" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "businessLicenseId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComplianceEntityLicense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComplianceRule" (
    "id" TEXT NOT NULL,
    "ruleKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "jurisdictionLevel" TEXT NOT NULL,
    "jurisdictionName" TEXT NOT NULL,
    "formName" TEXT NOT NULL,
    "obligationName" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "conditions" JSONB NOT NULL DEFAULT '{}',
    "frequency" TEXT NOT NULL,
    "dueRuleCode" TEXT NOT NULL,
    "dueRuleDescription" TEXT NOT NULL,
    "weekendRule" TEXT NOT NULL,
    "sourceUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "effectiveFrom" DATE,
    "effectiveTo" DATE,
    "verificationStatus" TEXT NOT NULL DEFAULT 'NEEDS_VERIFICATION',
    "lastReviewedAt" TIMESTAMP(3),
    "lastReviewedBy" TEXT,
    "notes" TEXT,
    "clientApprovalDefault" BOOLEAN NOT NULL DEFAULT false,
    "portalKind" TEXT,
    "requiredDocs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "serviceTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "origin" TEXT NOT NULL DEFAULT 'SEED',
    "changeReason" TEXT,
    "editedById" TEXT,
    "seedHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComplianceRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComplianceIndustryTemplate" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "ruleKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "activityTags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "builtIn" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "ComplianceIndustryTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComplianceObligation" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "ruleId" TEXT,
    "ruleKey" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "formName" TEXT NOT NULL,
    "jurisdictionLevel" TEXT NOT NULL,
    "jurisdictionName" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "frequency" TEXT NOT NULL,
    "dueRuleCode" TEXT NOT NULL,
    "dueRuleDescription" TEXT NOT NULL,
    "weekendRule" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROPOSED',
    "verification" TEXT NOT NULL DEFAULT 'NEEDS_VERIFICATION',
    "verifyItems" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "assignedStaffId" TEXT,
    "reviewerId" TEXT,
    "clientApprovalRequired" BOOLEAN NOT NULL DEFAULT false,
    "clientVisible" BOOLEAN NOT NULL DEFAULT false,
    "serviceType" TEXT,
    "taxAccountId" TEXT,
    "filingAccountId" TEXT,
    "accessReference" TEXT,
    "requiredDocs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "prepLeadDays" INTEGER NOT NULL DEFAULT 10,
    "extensionMonths" INTEGER,
    "source" TEXT NOT NULL DEFAULT 'GENERATOR',
    "startDate" DATE,
    "notes" TEXT,
    "activatedAt" TIMESTAMP(3),
    "activatedById" TEXT,
    "suspendedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComplianceObligation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComplianceFilingPeriod" (
    "id" TEXT NOT NULL,
    "obligationId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'ORIGINAL',
    "parentPeriodId" TEXT,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "statutoryDue" DATE,
    "adjustedDue" DATE,
    "extendedDue" DATE,
    "prepDeadline" DATE,
    "dueCertainty" TEXT NOT NULL DEFAULT 'NEEDS_VERIFICATION',
    "dueNote" TEXT,
    "filingStatus" TEXT NOT NULL DEFAULT 'NOT_STARTED',
    "paymentStatus" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "amountDueCents" INTEGER,
    "zeroReturn" BOOLEAN NOT NULL DEFAULT false,
    "filingChannel" TEXT NOT NULL DEFAULT 'MANUAL',
    "submittedAt" TIMESTAMP(3),
    "actualFilingDate" DATE,
    "confirmationNumber" TEXT,
    "verifiedById" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "acceptedById" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "paidAt" TIMESTAMP(3),
    "paidById" TEXT,
    "paymentConfirmation" TEXT,
    "completedAt" TIMESTAMP(3),
    "prepTaskId" TEXT,
    "nextCreatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComplianceFilingPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComplianceEvidence" (
    "id" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "documentId" TEXT,
    "reference" TEXT,
    "note" TEXT,
    "recordedById" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComplianceEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComplianceDocument" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "obligationId" TEXT,
    "periodId" TEXT,
    "kind" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "publishedById" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComplianceDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComplianceReturnVersion" (
    "id" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "documentIds" TEXT[],
    "documentShas" TEXT[],
    "amountDueCents" INTEGER,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "dueDate" DATE,
    "contentHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "note" TEXT,
    "preparedById" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3),
    "sentById" TEXT,
    "invalidatedAt" TIMESTAMP(3),
    "invalidatedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComplianceReturnVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComplianceApproval" (
    "id" TEXT NOT NULL,
    "returnVersionId" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "portalUserId" TEXT NOT NULL,
    "signerName" TEXT NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "contentHash" TEXT NOT NULL,
    "comments" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComplianceApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComplianceFilingAccount" (
    "id" TEXT NOT NULL,
    "entityId" TEXT,
    "firmLevel" BOOLEAN NOT NULL DEFAULT false,
    "portalKind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "portalUrl" TEXT NOT NULL,
    "accessMethod" TEXT,
    "accessReference" TEXT,
    "firmAccountId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComplianceFilingAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComplianceAuthorization" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "filingAccountId" TEXT,
    "formType" TEXT NOT NULL,
    "documentId" TEXT,
    "effectiveDate" DATE,
    "expiresAt" DATE,
    "status" TEXT NOT NULL DEFAULT 'ON_FILE',
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComplianceAuthorization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComplianceReminder" (
    "id" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "detail" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComplianceReminder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComplianceSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "clientNotificationsAuthorized" BOOLEAN NOT NULL DEFAULT false,
    "staffEmailReminders" BOOLEAN NOT NULL DEFAULT false,
    "reminderDays" INTEGER[] DEFAULT ARRAY[30, 15, 7, 3, 1]::INTEGER[],
    "prepTaskDays" INTEGER NOT NULL DEFAULT 30,
    "defaultPrepLeadDays" INTEGER NOT NULL DEFAULT 10,
    "approvalEscalationDays" INTEGER NOT NULL DEFAULT 5,
    "approvalReminderEveryDays" INTEGER NOT NULL DEFAULT 3,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComplianceSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ComplianceEntity_clientId_idx" ON "ComplianceEntity"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "ComplianceEntity_clientId_proposalKey_proposalRole_key" ON "ComplianceEntity"("clientId", "proposalKey", "proposalRole");

-- CreateIndex
CREATE UNIQUE INDEX "ComplianceEntityOwner_entityId_businessOwnerId_key" ON "ComplianceEntityOwner"("entityId", "businessOwnerId");

-- CreateIndex
CREATE UNIQUE INDEX "ComplianceEntityViewer_entityId_portalUserId_key" ON "ComplianceEntityViewer"("entityId", "portalUserId");

-- CreateIndex
CREATE UNIQUE INDEX "ComplianceEntityLicense_businessLicenseId_key" ON "ComplianceEntityLicense"("businessLicenseId");

-- CreateIndex
CREATE INDEX "ComplianceRule_isCurrent_idx" ON "ComplianceRule"("isCurrent");

-- CreateIndex
CREATE UNIQUE INDEX "ComplianceRule_ruleKey_version_key" ON "ComplianceRule"("ruleKey", "version");

-- CreateIndex
CREATE UNIQUE INDEX "ComplianceIndustryTemplate_key_key" ON "ComplianceIndustryTemplate"("key");

-- CreateIndex
CREATE INDEX "ComplianceObligation_clientId_idx" ON "ComplianceObligation"("clientId");

-- CreateIndex
CREATE INDEX "ComplianceObligation_status_idx" ON "ComplianceObligation"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ComplianceObligation_entityId_dedupeKey_key" ON "ComplianceObligation"("entityId", "dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "ComplianceFilingPeriod_prepTaskId_key" ON "ComplianceFilingPeriod"("prepTaskId");

-- CreateIndex
CREATE INDEX "ComplianceFilingPeriod_clientId_idx" ON "ComplianceFilingPeriod"("clientId");

-- CreateIndex
CREATE INDEX "ComplianceFilingPeriod_adjustedDue_idx" ON "ComplianceFilingPeriod"("adjustedDue");

-- CreateIndex
CREATE INDEX "ComplianceFilingPeriod_filingStatus_idx" ON "ComplianceFilingPeriod"("filingStatus");

-- CreateIndex
CREATE UNIQUE INDEX "ComplianceFilingPeriod_obligationId_periodKey_kind_key" ON "ComplianceFilingPeriod"("obligationId", "periodKey", "kind");

-- CreateIndex
CREATE INDEX "ComplianceEvidence_periodId_idx" ON "ComplianceEvidence"("periodId");

-- CreateIndex
CREATE UNIQUE INDEX "ComplianceDocument_documentId_key" ON "ComplianceDocument"("documentId");

-- CreateIndex
CREATE INDEX "ComplianceDocument_entityId_idx" ON "ComplianceDocument"("entityId");

-- CreateIndex
CREATE INDEX "ComplianceDocument_periodId_idx" ON "ComplianceDocument"("periodId");

-- CreateIndex
CREATE UNIQUE INDEX "ComplianceReturnVersion_periodId_version_key" ON "ComplianceReturnVersion"("periodId", "version");

-- CreateIndex
CREATE INDEX "ComplianceApproval_periodId_idx" ON "ComplianceApproval"("periodId");

-- CreateIndex
CREATE INDEX "ComplianceFilingAccount_entityId_idx" ON "ComplianceFilingAccount"("entityId");

-- CreateIndex
CREATE UNIQUE INDEX "ComplianceReminder_dedupeKey_key" ON "ComplianceReminder"("dedupeKey");

-- CreateIndex
CREATE INDEX "ComplianceReminder_periodId_idx" ON "ComplianceReminder"("periodId");

-- CreateIndex
CREATE INDEX "ComplianceReminder_recipient_readAt_idx" ON "ComplianceReminder"("recipient", "readAt");

-- AddForeignKey
ALTER TABLE "ComplianceEntity" ADD CONSTRAINT "ComplianceEntity_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceEntity" ADD CONSTRAINT "ComplianceEntity_linkedEntityId_fkey" FOREIGN KEY ("linkedEntityId") REFERENCES "ComplianceEntity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceEntityOwner" ADD CONSTRAINT "ComplianceEntityOwner_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "ComplianceEntity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceEntityOwner" ADD CONSTRAINT "ComplianceEntityOwner_businessOwnerId_fkey" FOREIGN KEY ("businessOwnerId") REFERENCES "BusinessOwner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceEntityViewer" ADD CONSTRAINT "ComplianceEntityViewer_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "ComplianceEntity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceLocation" ADD CONSTRAINT "ComplianceLocation_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "ComplianceEntity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceTaxAccount" ADD CONSTRAINT "ComplianceTaxAccount_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "ComplianceEntity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceEntityLicense" ADD CONSTRAINT "ComplianceEntityLicense_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "ComplianceEntity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceEntityLicense" ADD CONSTRAINT "ComplianceEntityLicense_businessLicenseId_fkey" FOREIGN KEY ("businessLicenseId") REFERENCES "BusinessLicense"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceObligation" ADD CONSTRAINT "ComplianceObligation_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "ComplianceEntity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceObligation" ADD CONSTRAINT "ComplianceObligation_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "ComplianceRule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceObligation" ADD CONSTRAINT "ComplianceObligation_taxAccountId_fkey" FOREIGN KEY ("taxAccountId") REFERENCES "ComplianceTaxAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceObligation" ADD CONSTRAINT "ComplianceObligation_filingAccountId_fkey" FOREIGN KEY ("filingAccountId") REFERENCES "ComplianceFilingAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceFilingPeriod" ADD CONSTRAINT "ComplianceFilingPeriod_obligationId_fkey" FOREIGN KEY ("obligationId") REFERENCES "ComplianceObligation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceFilingPeriod" ADD CONSTRAINT "ComplianceFilingPeriod_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "ComplianceEntity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceEvidence" ADD CONSTRAINT "ComplianceEvidence_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "ComplianceFilingPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceDocument" ADD CONSTRAINT "ComplianceDocument_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceDocument" ADD CONSTRAINT "ComplianceDocument_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "ComplianceEntity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceDocument" ADD CONSTRAINT "ComplianceDocument_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "ComplianceFilingPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceReturnVersion" ADD CONSTRAINT "ComplianceReturnVersion_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "ComplianceFilingPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceApproval" ADD CONSTRAINT "ComplianceApproval_returnVersionId_fkey" FOREIGN KEY ("returnVersionId") REFERENCES "ComplianceReturnVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceFilingAccount" ADD CONSTRAINT "ComplianceFilingAccount_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "ComplianceEntity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceFilingAccount" ADD CONSTRAINT "ComplianceFilingAccount_firmAccountId_fkey" FOREIGN KEY ("firmAccountId") REFERENCES "ComplianceFilingAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceAuthorization" ADD CONSTRAINT "ComplianceAuthorization_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "ComplianceEntity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceAuthorization" ADD CONSTRAINT "ComplianceAuthorization_filingAccountId_fkey" FOREIGN KEY ("filingAccountId") REFERENCES "ComplianceFilingAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceReminder" ADD CONSTRAINT "ComplianceReminder_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "ComplianceFilingPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Append-only: evidence and client approvals are never changed or removed.
CREATE OR REPLACE FUNCTION "compliance_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ComplianceEvidence_append_only"
  BEFORE UPDATE OR DELETE ON "ComplianceEvidence"
  FOR EACH ROW EXECUTE FUNCTION "compliance_append_only"();

CREATE TRIGGER "ComplianceApproval_append_only"
  BEFORE UPDATE OR DELETE ON "ComplianceApproval"
  FOR EACH ROW EXECUTE FUNCTION "compliance_append_only"();
