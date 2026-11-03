-- Tax preparation cases (one per client per tax year) with a required Tax Return Type,
-- joint-return spouse details, and import batch options + completion summary. Additive only.
-- AlterTable
ALTER TABLE "ImportBatch" ADD COLUMN     "batchServices" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "summary" JSONB,
ADD COLUMN     "taxYear" INTEGER;


-- CreateTable
CREATE TABLE "TaxPrepCase" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "taxYear" INTEGER NOT NULL,
    "returnType" TEXT,
    "otherReturnForm" TEXT,
    "returnTypeSource" TEXT,
    "returnTypeConfirmedAt" TIMESTAMP(3),
    "returnTypeConfirmedById" TEXT,
    "primaryFirstName" TEXT,
    "primaryMiddleName" TEXT,
    "primaryLastName" TEXT,
    "spouseFirstName" TEXT,
    "spouseMiddleName" TEXT,
    "spouseLastName" TEXT,
    "spouseEmail" TEXT,
    "spousePhone" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaxPrepCase_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TaxPrepCase_taxYear_returnType_idx" ON "TaxPrepCase"("taxYear", "returnType");

-- CreateIndex
CREATE UNIQUE INDEX "TaxPrepCase_clientId_taxYear_key" ON "TaxPrepCase"("clientId", "taxYear");

-- AddForeignKey
ALTER TABLE "TaxPrepCase" ADD CONSTRAINT "TaxPrepCase_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



ALTER TABLE "TaxPrepCase" ADD CONSTRAINT "TaxPrepCase_returnType_check" CHECK ("returnType" IS NULL OR "returnType" IN ('1040_SINGLE','1040_MFJ','1040_MFS','1040_HOH','1040_QSS','1065','1120S','1120','990','1041','OTHER'));
ALTER TABLE "TaxPrepCase" ADD CONSTRAINT "TaxPrepCase_taxYear_check" CHECK ("taxYear" BETWEEN 2000 AND 2100);
