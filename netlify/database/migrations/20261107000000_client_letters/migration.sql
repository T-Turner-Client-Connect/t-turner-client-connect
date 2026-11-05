-- Owner's Office -> Client Letters: a batch of versioned client letters, one row per client
-- (status, filed document, portal message, mailed-by-hand date), and "Client prefers no
-- Coetha" (one row per client while set). Additive only: three new tables.

-- CreateTable
CREATE TABLE "ClientLetterBatch" (
    "id" TEXT NOT NULL,
    "templateVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "preparedById" TEXT NOT NULL,
    "sentById" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientLetterBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientLetter" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "templateVersion" TEXT NOT NULL,
    "businessName" TEXT NOT NULL,
    "ownerName" TEXT NOT NULL,
    "ownerFirstName" TEXT NOT NULL,
    "email" TEXT,
    "portalUserId" TEXT,
    "excluded" BOOLEAN NOT NULL DEFAULT false,
    "excludedReason" TEXT,
    "excludedById" TEXT,
    "excludedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "letterDate" DATE,
    "sentAt" TIMESTAMP(3),
    "sentById" TEXT,
    "emailedAt" TIMESTAMP(3),
    "emailProviderId" TEXT,
    "emailError" TEXT,
    "documentId" TEXT,
    "messageId" TEXT,
    "mailedOn" DATE,
    "mailedById" TEXT,
    "mailedRecordedAt" TIMESTAMP(3),
    "resendOfId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientLetter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoethaOptOut" (
    "clientId" TEXT NOT NULL,
    "toldOn" DATE NOT NULL,
    "via" TEXT NOT NULL,
    "note" TEXT,
    "recordedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CoethaOptOut_pkey" PRIMARY KEY ("clientId")
);

-- CreateIndex
CREATE INDEX "ClientLetterBatch_status_idx" ON "ClientLetterBatch"("status");

-- CreateIndex
CREATE INDEX "ClientLetterBatch_createdAt_idx" ON "ClientLetterBatch"("createdAt");

-- CreateIndex
CREATE INDEX "ClientLetter_batchId_idx" ON "ClientLetter"("batchId");

-- CreateIndex
CREATE INDEX "ClientLetter_clientId_createdAt_idx" ON "ClientLetter"("clientId", "createdAt");

-- AddForeignKey
ALTER TABLE "ClientLetter" ADD CONSTRAINT "ClientLetter_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ClientLetterBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientLetter" ADD CONSTRAINT "ClientLetter_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoethaOptOut" ADD CONSTRAINT "CoethaOptOut_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
