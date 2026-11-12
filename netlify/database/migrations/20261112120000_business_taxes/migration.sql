-- Business taxes & filings per client (sales, local, liquor, Business Privilege Tax, payroll returns...). Additive only.
CREATE TABLE "BusinessTaxObligation" (
  "id" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "agency" TEXT,
  "accountNumber" TEXT,
  "frequency" TEXT NOT NULL,
  "dueDay" INTEGER NOT NULL,
  "dueMonth" INTEGER,
  "coversPriorYear" BOOLEAN NOT NULL DEFAULT true,
  "trackFrom" DATE NOT NULL,
  "note" TEXT,
  "archivedAt" TIMESTAMP(3),
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BusinessTaxObligation_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "BusinessTaxObligation_clientId_idx" ON "BusinessTaxObligation"("clientId");
ALTER TABLE "BusinessTaxObligation" ADD CONSTRAINT "BusinessTaxObligation_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE TABLE "BusinessTaxFiling" (
  "id" TEXT NOT NULL,
  "obligationId" TEXT NOT NULL,
  "period" TEXT NOT NULL,
  "dueDate" DATE NOT NULL,
  "status" TEXT NOT NULL,
  "amountCents" INTEGER,
  "confirmation" TEXT,
  "filedOn" DATE,
  "note" TEXT,
  "recordedById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BusinessTaxFiling_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BusinessTaxFiling_obligationId_period_key" ON "BusinessTaxFiling"("obligationId", "period");
ALTER TABLE "BusinessTaxFiling" ADD CONSTRAINT "BusinessTaxFiling_obligationId_fkey" FOREIGN KEY ("obligationId") REFERENCES "BusinessTaxObligation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
