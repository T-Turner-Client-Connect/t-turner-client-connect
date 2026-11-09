-- Owner switch "Show office-entered bank balances to clients". Additive only: three nullable
-- IntegrationSettings columns. NULL means never set, which is OFF: clients see no office-entered
-- balances until the primary owner turns this on. No existing data changes.

-- AlterTable
ALTER TABLE "IntegrationSettings" ADD COLUMN "clientBankBalancesVisible" BOOLEAN,
ADD COLUMN "clientBankBalancesChangedById" TEXT,
ADD COLUMN "clientBankBalancesChangedAt" TIMESTAMP(3);
