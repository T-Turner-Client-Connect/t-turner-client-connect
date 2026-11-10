-- "Ask Coetha": one conversation thread per business (additive; nothing existing changes).
-- CreateTable
CREATE TABLE "CoethaChatMessage" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "authorId" TEXT,
    "model" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "requestId" TEXT,
    "inputHash" TEXT,
    "documentId" TEXT,
    "attachmentName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CoethaChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CoethaChatMessage_clientId_createdAt_idx" ON "CoethaChatMessage"("clientId", "createdAt");

-- AddForeignKey
ALTER TABLE "CoethaChatMessage" ADD CONSTRAINT "CoethaChatMessage_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "LedgerBook"("clientId") ON DELETE CASCADE ON UPDATE CASCADE;
