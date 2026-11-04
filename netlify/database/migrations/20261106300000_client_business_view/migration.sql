-- Client portal business dashboard: bank balances as the bank last reported them, and the
-- client's own rate-limited "Refresh now".
ALTER TABLE "BankConnection" ADD COLUMN "lastClientRefreshAt" TIMESTAMP(3);
ALTER TABLE "BankConnectionAccount" ADD COLUMN "currentBalanceCents" INTEGER;
ALTER TABLE "BankConnectionAccount" ADD COLUMN "availableBalanceCents" INTEGER;
ALTER TABLE "BankConnectionAccount" ADD COLUMN "isoCurrency" TEXT;
ALTER TABLE "BankConnectionAccount" ADD COLUMN "balanceAsOf" TIMESTAMP(3);

-- One balance per bank account per day, for the balance ticker's "today vs yesterday".
CREATE TABLE "BankBalanceDaily" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "currentBalanceCents" INTEGER NOT NULL,
    "availableBalanceCents" INTEGER,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BankBalanceDaily_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BankBalanceDaily_accountId_day_key" ON "BankBalanceDaily"("accountId", "day");
CREATE INDEX "BankBalanceDaily_clientId_day_idx" ON "BankBalanceDaily"("clientId", "day");
ALTER TABLE "BankBalanceDaily" ADD CONSTRAINT "BankBalanceDaily_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "BankConnectionAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Business tax-document requests made from the client's own facts: tax year, upload type and the rule that asked.
ALTER TABLE "DocumentRequest" ADD COLUMN "taxYear" INTEGER;
ALTER TABLE "DocumentRequest" ADD COLUMN "docType" TEXT;
ALTER TABLE "DocumentRequest" ADD COLUMN "ruleKey" TEXT;
CREATE UNIQUE INDEX "DocumentRequest_clientId_taxYear_ruleKey_key" ON "DocumentRequest"("clientId", "taxYear", "ruleKey");
