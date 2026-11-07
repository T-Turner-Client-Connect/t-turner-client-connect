-- ADP RUN Time Sheet Import: one-time setup per payroll client, employee ID mappings and the
-- record of every CSV produced. Additive only: three new tables, no existing data changes.
-- Nothing here connects to ADP; the CSV is downloaded by staff and imported in RUN by a person.

-- CreateTable
CREATE TABLE "AdpRunSetup" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "companyCodeEnc" TEXT,
    "companyCodeHint" TEXT,
    "companyCodeForm" TEXT,
    "acClientIdEnc" TEXT,
    "acClientIdHint" TEXT,
    "acBranchEnc" TEXT,
    "acCodeEnc" TEXT,
    "identifierType" TEXT NOT NULL DEFAULT 'EMPLOYEE_ID',
    "payFrequency" TEXT,
    "featureConfirmedAt" TIMESTAMP(3),
    "featureConfirmedById" TEXT,
    "templateVersion" TEXT,
    "templateTitles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "templateDocumentId" TEXT,
    "templateSha256" TEXT,
    "templateCheckedAt" TIMESTAMP(3),
    "employeeReportDocumentId" TEXT,
    "employeeReportAt" TIMESTAMP(3),
    "earningsReportDocumentId" TEXT,
    "earningsReportAt" TIMESTAMP(3),
    "usesDepartments" BOOLEAN NOT NULL DEFAULT false,
    "departmentReportAt" TIMESTAMP(3),
    "earningsCatalog" JSONB NOT NULL DEFAULT '[]',
    "regularEarningsCode" TEXT,
    "overtimeEarningsCode" TEXT,
    "testVerifiedAt" TIMESTAMP(3),
    "testVerifiedById" TEXT,
    "testVerifiedNote" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdpRunSetup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdpRunEmployeeMap" (
    "id" TEXT NOT NULL,
    "setupId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "adpEmployeeId" TEXT NOT NULL,
    "payFrequency" TEXT,
    "departmentCode" TEXT,
    "rateCode" TEXT NOT NULL DEFAULT 'BASE',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "source" TEXT NOT NULL DEFAULT 'REPORT',
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdpRunEmployeeMap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdpRunExport" (
    "id" TEXT NOT NULL,
    "setupId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "cycleId" TEXT,
    "isTest" BOOLEAN NOT NULL DEFAULT false,
    "fileName" TEXT NOT NULL,
    "contentEnc" TEXT NOT NULL,
    "contentSha256" TEXT NOT NULL,
    "rows" INTEGER NOT NULL,
    "employees" INTEGER NOT NULL,
    "hoursHundredths" INTEGER NOT NULL,
    "payFrequency" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "replacedAt" TIMESTAMP(3),
    "replacedById" TEXT,
    "replaceReason" TEXT,
    "importedAt" TIMESTAMP(3),
    "importedById" TEXT,
    "downloads" INTEGER NOT NULL DEFAULT 0,
    "lastDownloadedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdpRunExport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdpRunSetup_clientId_key" ON "AdpRunSetup"("clientId");

-- CreateIndex
CREATE INDEX "AdpRunEmployeeMap_setupId_idx" ON "AdpRunEmployeeMap"("setupId");

-- CreateIndex
CREATE UNIQUE INDEX "AdpRunEmployeeMap_clientId_adpEmployeeId_key" ON "AdpRunEmployeeMap"("clientId", "adpEmployeeId");

-- CreateIndex
CREATE UNIQUE INDEX "AdpRunEmployeeMap_clientId_nameKey_key" ON "AdpRunEmployeeMap"("clientId", "nameKey");

-- CreateIndex
CREATE INDEX "AdpRunExport_clientId_cycleId_idx" ON "AdpRunExport"("clientId", "cycleId");

-- CreateIndex
CREATE INDEX "AdpRunExport_setupId_idx" ON "AdpRunExport"("setupId");

-- AddForeignKey
ALTER TABLE "AdpRunSetup" ADD CONSTRAINT "AdpRunSetup_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdpRunEmployeeMap" ADD CONSTRAINT "AdpRunEmployeeMap_setupId_fkey" FOREIGN KEY ("setupId") REFERENCES "AdpRunSetup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdpRunExport" ADD CONSTRAINT "AdpRunExport_setupId_fkey" FOREIGN KEY ("setupId") REFERENCES "AdpRunSetup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

