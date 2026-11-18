-- State compliance: each business's state registrations, its recurring state filings (annual reports,
-- licenses, renewals...) with their own state's due dates, and one filing record per period.
-- Internal to the office. New tables only; nothing existing changes.
CREATE TABLE "ComplianceRegistration" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'FORMATION',
    "entityId" TEXT,
    "agency" TEXT,
    "formedOn" DATE,
    "note" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ComplianceRegistration_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ComplianceRegistration_clientId_idx" ON "ComplianceRegistration"("clientId");
ALTER TABLE "ComplianceRegistration" ADD CONSTRAINT "ComplianceRegistration_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ComplianceRequirement" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "registrationId" TEXT,
    "state" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "agency" TEXT,
    "filingUrl" TEXT,
    "frequency" TEXT NOT NULL DEFAULT 'ANNUAL',
    "dueMonth" INTEGER NOT NULL,
    "dueDay" INTEGER NOT NULL,
    "startYear" INTEGER NOT NULL,
    "note" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ComplianceRequirement_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ComplianceRequirement_clientId_idx" ON "ComplianceRequirement"("clientId");
ALTER TABLE "ComplianceRequirement" ADD CONSTRAINT "ComplianceRequirement_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ComplianceRequirement" ADD CONSTRAINT "ComplianceRequirement_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "ComplianceRegistration"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ComplianceFiling" (
    "id" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "period" INTEGER NOT NULL,
    "dueDate" DATE NOT NULL,
    "finalDeadline" DATE,
    "status" TEXT NOT NULL DEFAULT 'NOT_STARTED',
    "urgent" BOOLEAN NOT NULL DEFAULT false,
    "urgentReason" TEXT,
    "filedOn" DATE,
    "confirmationNumber" TEXT,
    "confirmationDocumentId" TEXT,
    "completedById" TEXT,
    "completedAt" TIMESTAMP(3),
    "note" TEXT,
    "remindersSent" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ComplianceFiling_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ComplianceFiling_requirementId_period_key" ON "ComplianceFiling"("requirementId", "period");
CREATE INDEX "ComplianceFiling_status_dueDate_idx" ON "ComplianceFiling"("status", "dueDate");
CREATE INDEX "ComplianceFiling_clientId_idx" ON "ComplianceFiling"("clientId");
ALTER TABLE "ComplianceFiling" ADD CONSTRAINT "ComplianceFiling_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "ComplianceRequirement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ComplianceFiling" ADD CONSTRAINT "ComplianceFiling_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
