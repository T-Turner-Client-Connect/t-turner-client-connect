-- Balances entered by our office: until a Plaid bank feed is live, staff record each account's
-- balance (typed in after looking at the bank, or the running balance in an imported bank CSV)
-- so the client's dashboard shows a current Bank Balance; plus the bank's sign-in page for the
-- morning bank pull, the balance source per account, statements our office files (linked to the
-- account) and one-time keys so a double-click can't save twice.
-- Never usernames, passwords, security answers, PINs or full account numbers: a name, the
-- institution, at most the last 4 digits and an https sign-in page address. Balances are
-- append-only (a correction is a new row pointing at the one it corrects).
-- Additive only: three new tables, two new BankImport columns with defaults and one new nullable
-- Document column. Nothing is dropped or rewritten.

-- AlterTable
ALTER TABLE "BankImport" ADD COLUMN     "balanceStatus" TEXT,
ADD COLUMN     "skipped" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "manualBankAccountId" TEXT;

-- CreateTable
CREATE TABLE "ManualBankAccount" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "institution" TEXT,
    "last4" TEXT,
    "kind" TEXT NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT NOT NULL,
    "ledgerAccountId" TEXT,
    "signInUrl" TEXT,
    "balanceSource" TEXT NOT NULL DEFAULT 'AUTO',

    CONSTRAINT "ManualBankAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManualBankBalance" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "balanceCents" INTEGER NOT NULL,
    "asOf" TIMESTAMP(3) NOT NULL,
    "enteredById" TEXT NOT NULL,
    "enteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    "source" TEXT NOT NULL DEFAULT 'STAFF_ENTRY',
    "importId" TEXT,
    "correctsId" TEXT,

    CONSTRAINT "ManualBankBalance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfficeActionKey" (
    "key" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "resultId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OfficeActionKey_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "Document_manualBankAccountId_idx" ON "Document"("manualBankAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "ManualBankAccount_ledgerAccountId_key" ON "ManualBankAccount"("ledgerAccountId");

-- CreateIndex
CREATE INDEX "ManualBankAccount_clientId_idx" ON "ManualBankAccount"("clientId");

-- CreateIndex
CREATE INDEX "ManualBankBalance_accountId_asOf_idx" ON "ManualBankBalance"("accountId", "asOf");

-- CreateIndex
CREATE INDEX "ManualBankBalance_clientId_asOf_idx" ON "ManualBankBalance"("clientId", "asOf");

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_manualBankAccountId_fkey" FOREIGN KEY ("manualBankAccountId") REFERENCES "ManualBankAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualBankAccount" ADD CONSTRAINT "ManualBankAccount_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualBankAccount" ADD CONSTRAINT "ManualBankAccount_ledgerAccountId_fkey" FOREIGN KEY ("ledgerAccountId") REFERENCES "LedgerAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualBankBalance" ADD CONSTRAINT "ManualBankBalance_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "ManualBankAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualBankBalance" ADD CONSTRAINT "ManualBankBalance_correctsId_fkey" FOREIGN KEY ("correctsId") REFERENCES "ManualBankBalance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Only ever the last 4 digits (never a full account number), only an https sign-in page, and only
-- a known balance source.
ALTER TABLE "ManualBankAccount" ADD CONSTRAINT "ManualBankAccount_last4_check" CHECK ("last4" IS NULL OR "last4" ~ '^[0-9]{4}$');
ALTER TABLE "ManualBankAccount" ADD CONSTRAINT "ManualBankAccount_signInUrl_check" CHECK ("signInUrl" IS NULL OR "signInUrl" LIKE 'https://%');
ALTER TABLE "ManualBankAccount" ADD CONSTRAINT "ManualBankAccount_balanceSource_check" CHECK ("balanceSource" IN ('AUTO', 'OFFICE'));
