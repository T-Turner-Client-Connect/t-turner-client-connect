-- AlterEnum
ALTER TYPE "InvoiceState" ADD VALUE 'PENDING_APPROVAL';

-- AlterEnum
ALTER TYPE "PaymentKind" ADD VALUE 'CREDIT';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PaymentMethod" ADD VALUE 'VENMO';
ALTER TYPE "PaymentMethod" ADD VALUE 'REFUND_TRANSFER';

-- AlterTable
ALTER TABLE "BillingSettings" ADD COLUMN     "refundTransferFeeNote" TEXT,
ADD COLUMN     "squareLinksEnabledAt" TIMESTAMP(3),
ADD COLUMN     "squareLinksEnabledById" TEXT;

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedById" TEXT,
ADD COLUMN     "billingAddress" TEXT,
ADD COLUMN     "billingEmail" TEXT,
ADD COLUMN     "billingName" TEXT,
ADD COLUMN     "billingPhone" TEXT,
ADD COLUMN     "formType" TEXT NOT NULL DEFAULT 'QUOTE',
ADD COLUMN     "offeredMethods" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "squarePaymentUrl" TEXT,
ADD COLUMN     "submittedAt" TIMESTAMP(3),
ADD COLUMN     "submittedById" TEXT,
ADD COLUMN     "viewedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "idempotencyKey" TEXT;


-- CreateIndex
CREATE UNIQUE INDEX "Payment_idempotencyKey_key" ON "Payment"("idempotencyKey");

