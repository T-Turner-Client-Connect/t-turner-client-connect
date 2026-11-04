-- Pay From My Refund (Republic Bank Refund Transfer) tracking. Adds tables only; changes no existing data.

-- DropTable

-- CreateTable
CREATE TABLE "RefundTransferPayment" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "taxYear" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "amountCents" INTEGER,
    "receivedCents" INTEGER,
    "receivedOn" DATE,
    "debtCheck" TEXT,
    "offsetRisk" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RefundTransferPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefundTransferEvent" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT,
    "amountCents" INTEGER,
    "actorUserId" TEXT,
    "actorPortalUserId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefundTransferEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RefundTransferPayment_status_idx" ON "RefundTransferPayment"("status");

-- CreateIndex
CREATE UNIQUE INDEX "RefundTransferPayment_clientId_taxYear_key" ON "RefundTransferPayment"("clientId", "taxYear");

-- CreateIndex
CREATE INDEX "RefundTransferEvent_paymentId_createdAt_idx" ON "RefundTransferEvent"("paymentId", "createdAt");

-- AddForeignKey
ALTER TABLE "RefundTransferPayment" ADD CONSTRAINT "RefundTransferPayment_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefundTransferEvent" ADD CONSTRAINT "RefundTransferEvent_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "RefundTransferPayment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

