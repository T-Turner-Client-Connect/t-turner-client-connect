-- Coetha's reference statements: a business's completed financial package (its monthly Profit &
-- Loss lines, read from the PDF on file), kept unchanged so Coetha can prepare categories from it
-- and the books can be compared with it month by month. Additive only: one new table.

-- CreateTable
CREATE TABLE "CoethaReference" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "documentId" TEXT,
    "title" TEXT NOT NULL,
    "months" JSONB NOT NULL,
    "lines" JSONB NOT NULL,
    "mapping" JSONB,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CoethaReference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CoethaReference_clientId_createdAt_idx" ON "CoethaReference"("clientId", "createdAt");

-- AddForeignKey
ALTER TABLE "CoethaReference" ADD CONSTRAINT "CoethaReference_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "LedgerBook"("clientId") ON DELETE CASCADE ON UPDATE CASCADE;
