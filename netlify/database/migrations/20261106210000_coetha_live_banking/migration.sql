-- Coetha in-app (drafts that only Tabitha approves) and Plaid production readiness.

-- Bank connections may now be made with real banks (PRODUCTION), which the app allows only
-- when the Plaid production keys are set AND Tabitha's "Live bank connections" switch is on.
ALTER TABLE "BankConnection" DROP CONSTRAINT IF EXISTS "BankConnection_sandbox_check";
ALTER TABLE "BankConnection" ADD CONSTRAINT "BankConnection_environment_check" CHECK ("environment" IN ('SANDBOX', 'PRODUCTION'));

-- AlterTable
ALTER TABLE "BankConnection" ADD COLUMN     "errorCode" TEXT,
ADD COLUMN     "lastWebhookAt" TIMESTAMP(3),
ADD COLUMN     "reauthRequiredAt" TIMESTAMP(3);

-- AlterTable (both owner switches default OFF)
ALTER TABLE "IntegrationSettings" ADD COLUMN     "coethaChangedAt" TIMESTAMP(3),
ADD COLUMN     "coethaChangedById" TEXT,
ADD COLUMN     "coethaEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "liveBankingChangedAt" TIMESTAMP(3),
ADD COLUMN     "liveBankingChangedById" TEXT,
ADD COLUMN     "liveBankingEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "CoethaRun" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "startedById" TEXT,
    "model" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "inputHash" TEXT,
    "transactions" INTEGER NOT NULL DEFAULT 0,
    "proposals" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "requestId" TEXT,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "CoethaRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoethaProposal" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROPOSED',
    "payload" JSONB NOT NULL,
    "bankTransactionId" TEXT,
    "confidence" DOUBLE PRECISION,
    "reason" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "approvedAccountId" TEXT,
    "journalEntryId" TEXT,

    CONSTRAINT "CoethaProposal_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "CoethaRun" ADD CONSTRAINT "CoethaRun_status_check" CHECK ("status" IN ('RUNNING', 'OK', 'FAILED'));
ALTER TABLE "CoethaProposal" ADD CONSTRAINT "CoethaProposal_kind_check" CHECK ("kind" IN ('CATEGORY', 'DISCREPANCY', 'ADJUSTING_ENTRY', 'MONTH_SUMMARY'));
ALTER TABLE "CoethaProposal" ADD CONSTRAINT "CoethaProposal_status_check" CHECK ("status" IN ('PROPOSED', 'APPROVED', 'REJECTED', 'SUPERSEDED'));
-- A decided proposal always records who decided it.
ALTER TABLE "CoethaProposal" ADD CONSTRAINT "CoethaProposal_decided_check" CHECK ("status" IN ('PROPOSED', 'SUPERSEDED') OR ("decidedById" IS NOT NULL AND "decidedAt" IS NOT NULL));

-- CreateIndex
CREATE INDEX "CoethaRun_clientId_startedAt_idx" ON "CoethaRun"("clientId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CoethaProposal_journalEntryId_key" ON "CoethaProposal"("journalEntryId");

-- CreateIndex
CREATE INDEX "CoethaProposal_clientId_status_kind_idx" ON "CoethaProposal"("clientId", "status", "kind");

-- CreateIndex
CREATE INDEX "CoethaProposal_bankTransactionId_idx" ON "CoethaProposal"("bankTransactionId");

-- AddForeignKey
ALTER TABLE "CoethaRun" ADD CONSTRAINT "CoethaRun_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "LedgerBook"("clientId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoethaProposal" ADD CONSTRAINT "CoethaProposal_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "LedgerBook"("clientId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoethaProposal" ADD CONSTRAINT "CoethaProposal_runId_fkey" FOREIGN KEY ("runId") REFERENCES "CoethaRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
