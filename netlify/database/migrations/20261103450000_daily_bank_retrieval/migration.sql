-- Daily read-only bank retrieval (Plaid, sandbox in this phase). New tables and new nullable/defaulted columns only; no existing data is changed.
-- AlterTable
ALTER TABLE "BankTransaction" ADD COLUMN     "flag" TEXT,
ADD COLUMN     "flagNote" TEXT,
ADD COLUMN     "providerId" TEXT,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'CSV',
ADD COLUMN     "statementFingerprint" TEXT;


-- CreateTable
CREATE TABLE "BankConnection" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'PLAID',
    "environment" TEXT NOT NULL DEFAULT 'SANDBOX',
    "itemId" TEXT NOT NULL,
    "accessTokenEnc" TEXT NOT NULL,
    "institutionName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "cursor" TEXT,
    "lastAttemptAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "lastError" TEXT,
    "authorizedByName" TEXT NOT NULL,
    "authorizationMethod" TEXT NOT NULL,
    "consentVersion" TEXT NOT NULL,
    "connectedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disconnectedAt" TIMESTAMP(3),
    "disconnectedById" TEXT,

    CONSTRAINT "BankConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankConnectionAccount" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mask" TEXT,
    "type" TEXT NOT NULL,
    "subtype" TEXT,
    "ledgerAccountId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankConnectionAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankSyncRun" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "added" INTEGER NOT NULL DEFAULT 0,
    "matched" INTEGER NOT NULL DEFAULT 0,
    "modified" INTEGER NOT NULL DEFAULT 0,
    "removed" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "flagged" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,

    CONSTRAINT "BankSyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BankConnection_itemId_key" ON "BankConnection"("itemId");

-- CreateIndex
CREATE INDEX "BankConnection_clientId_idx" ON "BankConnection"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "BankConnectionAccount_ledgerAccountId_key" ON "BankConnectionAccount"("ledgerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "BankConnectionAccount_connectionId_providerAccountId_key" ON "BankConnectionAccount"("connectionId", "providerAccountId");

-- CreateIndex
CREATE INDEX "BankSyncRun_connectionId_startedAt_idx" ON "BankSyncRun"("connectionId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "BankTransaction_accountId_providerId_key" ON "BankTransaction"("accountId", "providerId");

-- CreateIndex
CREATE UNIQUE INDEX "BankTransaction_accountId_statementFingerprint_key" ON "BankTransaction"("accountId", "statementFingerprint");

-- AddForeignKey
ALTER TABLE "BankConnectionAccount" ADD CONSTRAINT "BankConnectionAccount_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "BankConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankSyncRun" ADD CONSTRAINT "BankSyncRun_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "BankConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Real bank connections stay off until Tabitha approves them.
ALTER TABLE "BankConnection" ADD CONSTRAINT "BankConnection_sandbox_check" CHECK ("environment" = 'SANDBOX');
