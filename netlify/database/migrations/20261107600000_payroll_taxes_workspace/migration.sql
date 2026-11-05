-- ADP Payroll & Taxes workspace, Stage 1 (payroll). Additive only: new tables plus two nullable
-- columns on PayrollRunVersion (the document a version was shown with). Nothing is dropped or
-- rewritten. Access is a Staff Access & Permissions area (payroll_taxes), so no grants change here.

-- AlterTable
ALTER TABLE "PayrollRunVersion" ADD COLUMN     "documentId" TEXT,
ADD COLUMN     "documentSha256" TEXT;

-- CreateTable
CREATE TABLE "PayrollSchedule" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "frequency" TEXT NOT NULL,
    "anchorPayDate" DATE NOT NULL,
    "semiMonthlyDays" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "periodEndLagDays" INTEGER NOT NULL DEFAULT 5,
    "hoursRequestLeadDays" INTEGER NOT NULL DEFAULT 5,
    "hoursDueDays" INTEGER NOT NULL DEFAULT 3,
    "approvalDueDays" INTEGER NOT NULL DEFAULT 2,
    "adpCutoffDays" INTEGER NOT NULL DEFAULT 2,
    "assignedStaffId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "clientRemindersEnabled" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollCycle" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "payDate" DATE NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "hoursRequestDate" DATE NOT NULL,
    "hoursDueDate" DATE NOT NULL,
    "approvalDueDate" DATE NOT NULL,
    "adpCutoffDate" DATE NOT NULL,
    "assignedStaffId" TEXT,
    "hoursRequestedAt" TIMESTAMP(3),
    "hoursSubmittedAt" TIMESTAMP(3),
    "hoursSubmittedByPortal" TEXT,
    "hoursSubmittedByStaff" TEXT,
    "hoursSubmission" JSONB,
    "payrollRunId" TEXT,
    "errorFlaggedAt" TIMESTAMP(3),
    "errorFlaggedById" TEXT,
    "errorNote" TEXT,
    "processedAt" TIMESTAMP(3),
    "processedById" TEXT,
    "confirmationDocumentId" TEXT,
    "confirmationNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollCycle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollReminderPlan" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "steps" JSONB NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollReminderPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollReminder" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "round" INTEGER,
    "audience" TEXT NOT NULL,
    "recipientKey" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "detail" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollReminder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollTaxSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "clientRemindersAuthorized" BOOLEAN NOT NULL DEFAULT false,
    "changedAt" TIMESTAMP(3),
    "changedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollTaxSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PayrollSchedule_clientId_key" ON "PayrollSchedule"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollCycle_payrollRunId_key" ON "PayrollCycle"("payrollRunId");

-- CreateIndex
CREATE INDEX "PayrollCycle_payDate_idx" ON "PayrollCycle"("payDate");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollCycle_clientId_payDate_key" ON "PayrollCycle"("clientId", "payDate");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollReminderPlan_key_key" ON "PayrollReminderPlan"("key");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollReminder_dedupeKey_key" ON "PayrollReminder"("dedupeKey");

-- CreateIndex
CREATE INDEX "PayrollReminder_cycleId_idx" ON "PayrollReminder"("cycleId");

-- CreateIndex
CREATE INDEX "PayrollReminder_status_createdAt_idx" ON "PayrollReminder"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "PayrollSchedule" ADD CONSTRAINT "PayrollSchedule_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollCycle" ADD CONSTRAINT "PayrollCycle_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollCycle" ADD CONSTRAINT "PayrollCycle_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "PayrollSchedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollReminder" ADD CONSTRAINT "PayrollReminder_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "PayrollCycle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

