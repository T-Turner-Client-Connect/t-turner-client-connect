-- AlterTable
ALTER TABLE "BillingSettings" ADD COLUMN     "squareAcceptBank" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "squareDelivery" TEXT NOT NULL DEFAULT 'SHARE_MANUALLY',
ADD COLUMN     "squareSendingEnabledAt" TIMESTAMP(3),
ADD COLUMN     "squareSendingEnabledById" TEXT;

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "squareCustomerId" TEXT,
ADD COLUMN     "squareEmailSentAt" TIMESTAMP(3),
ADD COLUMN     "squareError" TEXT,
ADD COLUMN     "squareInvoiceId" TEXT,
ADD COLUMN     "squareInvoiceVersion" INTEGER,
ADD COLUMN     "squareOrderId" TEXT,
ADD COLUMN     "squarePublicUrl" TEXT,
ADD COLUMN     "squareRevision" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "squareSentAt" TIMESTAMP(3),
ADD COLUMN     "squareSentById" TEXT,
ADD COLUMN     "squareStatus" TEXT,
ADD COLUMN     "squareSyncedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "SquareWebhookEvent" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "objectId" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "result" TEXT,

    CONSTRAINT "SquareWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SquarePaymentSeen" (
    "id" TEXT NOT NULL,
    "squarePaymentId" TEXT NOT NULL,
    "squareOrderId" TEXT,
    "squareCustomerId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "paidAt" TIMESTAMP(3),
    "sourceType" TEXT,
    "state" TEXT NOT NULL,
    "invoiceId" TEXT,
    "paymentId" TEXT,
    "note" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SquarePaymentSeen_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SquareWebhookEvent_eventId_key" ON "SquareWebhookEvent"("eventId");

-- CreateIndex
CREATE INDEX "SquareWebhookEvent_receivedAt_idx" ON "SquareWebhookEvent"("receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SquarePaymentSeen_squarePaymentId_key" ON "SquarePaymentSeen"("squarePaymentId");

-- CreateIndex
CREATE INDEX "SquarePaymentSeen_state_idx" ON "SquarePaymentSeen"("state");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_squareOrderId_key" ON "Invoice"("squareOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_squareInvoiceId_key" ON "Invoice"("squareInvoiceId");

