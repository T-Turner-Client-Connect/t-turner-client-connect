-- AlterTable
ALTER TABLE "BookkeepingProfile" ADD COLUMN     "payrollPayDate" DATE;

-- CreateTable
CREATE TABLE "BusinessLicense" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "jurisdiction" TEXT,
    "licenseNumber" TEXT,
    "renewalDate" DATE,
    "note" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessLicense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "YearEndFiling" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "taxYear" INTEGER NOT NULL,
    "stage" TEXT NOT NULL DEFAULT 'NOT_STARTED',
    "note" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "YearEndFiling_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BusinessLicense_clientId_renewalDate_idx" ON "BusinessLicense"("clientId", "renewalDate");

-- CreateIndex
CREATE UNIQUE INDEX "YearEndFiling_clientId_taxYear_key" ON "YearEndFiling"("clientId", "taxYear");

-- AddForeignKey
ALTER TABLE "BusinessLicense" ADD CONSTRAINT "BusinessLicense_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "YearEndFiling" ADD CONSTRAINT "YearEndFiling_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

