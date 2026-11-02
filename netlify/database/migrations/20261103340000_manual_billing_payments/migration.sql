-- Payments recorded by the office for clients billed outside Square. Additive only.
CREATE TABLE "ManualBillingPayment" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "paidOn" TIMESTAMP(3) NOT NULL,
    "periodMonth" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "reference" TEXT,
    "note" TEXT,
    "recordedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voidedAt" TIMESTAMP(3),
    "voidedById" TEXT,
    "voidReason" TEXT,
    CONSTRAINT "ManualBillingPayment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ManualBillingPayment_clientId_paidOn_idx" ON "ManualBillingPayment"("clientId", "paidOn");
ALTER TABLE "ManualBillingPayment" ADD CONSTRAINT "ManualBillingPayment_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
