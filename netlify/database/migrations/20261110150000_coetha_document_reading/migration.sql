-- Coetha reads documents in the background (additive; nothing existing changes).

-- A large file sent in pieces: each piece is stored (encrypted) until the file is put back together.
CREATE TABLE "CoethaUpload" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "chunks" INTEGER NOT NULL,
    "parts" JSONB NOT NULL DEFAULT '[]',
    "documentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CoethaUpload_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CoethaUpload_clientId_createdAt_idx" ON "CoethaUpload"("clientId", "createdAt");
ALTER TABLE "CoethaUpload" ADD CONSTRAINT "CoethaUpload_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "LedgerBook"("clientId") ON DELETE CASCADE ON UPDATE CASCADE;

-- One reading job per document: read once, a few pages per step, its place saved after each step.
CREATE TABLE "CoethaDocJob" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "kind" TEXT,
    "pages" INTEGER NOT NULL DEFAULT 0,
    "pagesDone" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseUntil" TIMESTAMP(3),
    "notBefore" TIMESTAMP(3),
    "error" TEXT,
    "text" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),
    CONSTRAINT "CoethaDocJob_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CoethaDocJob_documentId_key" ON "CoethaDocJob"("documentId");
CREATE INDEX "CoethaDocJob_status_leaseUntil_idx" ON "CoethaDocJob"("status", "leaseUntil");
CREATE INDEX "CoethaDocJob_clientId_createdAt_idx" ON "CoethaDocJob"("clientId", "createdAt");
ALTER TABLE "CoethaDocJob" ADD CONSTRAINT "CoethaDocJob_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "LedgerBook"("clientId") ON DELETE CASCADE ON UPDATE CASCADE;

-- What Coetha found on each page (checks, deposits, receipts...), de-identified, with its bank-row match.
CREATE TABLE "CoethaDocFinding" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "page" INTEGER NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "checkNumber" TEXT,
    "date" TEXT,
    "payee" TEXT,
    "amountCents" INTEGER,
    "memo" TEXT,
    "details" TEXT,
    "bankTransactionId" TEXT,
    "matchNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CoethaDocFinding_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CoethaDocFinding_jobId_page_seq_key" ON "CoethaDocFinding"("jobId", "page", "seq");
CREATE INDEX "CoethaDocFinding_clientId_idx" ON "CoethaDocFinding"("clientId");
ALTER TABLE "CoethaDocFinding" ADD CONSTRAINT "CoethaDocFinding_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "CoethaDocJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A question waiting for Coetha to finish reading its documents.
ALTER TABLE "CoethaChatMessage" ADD COLUMN "status" TEXT;
ALTER TABLE "CoethaChatMessage" ADD COLUMN "jobIds" JSONB;
