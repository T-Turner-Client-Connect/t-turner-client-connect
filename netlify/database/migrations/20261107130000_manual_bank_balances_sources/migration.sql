-- Manual bank balances, part 2: the balance source per account, statements our office files
-- (linked to the account) and one-time keys so a double-click can't save twice.
-- 20261107120000_manual_bank_balances is already applied on preview databases and must not
-- change, so these additions live here. Additive only and safe to re-run: one new table, one new
-- column with a default, one new nullable Document column, an index, a foreign key and a check.
-- Nothing is dropped or rewritten.

-- AlterTable
ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "manualBankAccountId" TEXT;

-- AlterTable
ALTER TABLE "ManualBankAccount" ADD COLUMN IF NOT EXISTS "balanceSource" TEXT NOT NULL DEFAULT 'AUTO';

-- CreateTable
CREATE TABLE IF NOT EXISTS "OfficeActionKey" (
    "key" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "resultId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OfficeActionKey_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Document_manualBankAccountId_idx" ON "Document"("manualBankAccountId");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Document_manualBankAccountId_fkey') THEN
    ALTER TABLE "Document" ADD CONSTRAINT "Document_manualBankAccountId_fkey" FOREIGN KEY ("manualBankAccountId") REFERENCES "ManualBankAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Only a known balance source.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ManualBankAccount_balanceSource_check') THEN
    ALTER TABLE "ManualBankAccount" ADD CONSTRAINT "ManualBankAccount_balanceSource_check" CHECK ("balanceSource" IN ('AUTO', 'OFFICE'));
  END IF;
END $$;
