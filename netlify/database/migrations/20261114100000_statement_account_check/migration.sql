-- Statement account check: is a bank/card statement this client's and this account's (name + last 4
-- read from the statement), before its transactions are imported. Additive only.
CREATE TABLE "StatementAccountCheck" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "accountId" TEXT,
    "status" TEXT NOT NULL,
    "reasons" JSONB NOT NULL DEFAULT '[]',
    "readLast4" TEXT,
    "confirmedById" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "confirmNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StatementAccountCheck_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StatementAccountCheck_documentId_key" ON "StatementAccountCheck"("documentId");
CREATE INDEX "StatementAccountCheck_clientId_status_idx" ON "StatementAccountCheck"("clientId", "status");
