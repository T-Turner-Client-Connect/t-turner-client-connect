-- Invoice requests that say who and what ("Pay with an Invoice"), and firm billing schedules:
-- recurring invoices, deposits and installment plans for tax-prep / individually billed clients.
-- Each cycle is an ordinary Invoice made through the existing Create Invoice / send path.
-- Bookkeeping subscriptions in Square are not touched. Additive only: three new tables.

-- CreateTable
CREATE TABLE "InvoiceRequest" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "portalUserId" TEXT,
    "requesterName" TEXT NOT NULL,
    "requesterEmail" TEXT,
    "businessName" TEXT,
    "items" JSONB NOT NULL,
    "taxYear" INTEGER,
    "note" TEXT,
    "amountCents" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "conversationId" TEXT,
    "invoiceId" TEXT,
    "invoiceCreatedAt" TIMESTAMP(3),
    "invoiceSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvoiceRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingSchedule" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROPOSED',
    "service" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amountCents" INTEGER,
    "totalCents" INTEGER,
    "cadence" TEXT,
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "maxInvoices" INTEGER,
    "invoiceDay" INTEGER NOT NULL DEFAULT 1,
    "dueInDays" INTEGER NOT NULL DEFAULT 14,
    "autoSend" BOOLEAN NOT NULL DEFAULT false,
    "offeredMethods" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "privateNote" TEXT,
    "requestId" TEXT,
    "skipBefore" DATE,
    "proposedById" TEXT NOT NULL,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "declinedAt" TIMESTAMP(3),
    "pausedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "lastProblem" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingScheduleItem" (
    "id" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "periodKey" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "issueDate" DATE,
    "invoiceId" TEXT,
    "generatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingScheduleItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceRequest_conversationId_key" ON "InvoiceRequest"("conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceRequest_invoiceId_key" ON "InvoiceRequest"("invoiceId");

-- CreateIndex
CREATE INDEX "InvoiceRequest_clientId_status_idx" ON "InvoiceRequest"("clientId", "status");

-- CreateIndex
CREATE INDEX "InvoiceRequest_status_idx" ON "InvoiceRequest"("status");

-- CreateIndex
CREATE INDEX "BillingSchedule_clientId_status_idx" ON "BillingSchedule"("clientId", "status");

-- CreateIndex
CREATE INDEX "BillingSchedule_status_idx" ON "BillingSchedule"("status");

-- CreateIndex
CREATE UNIQUE INDEX "BillingScheduleItem_invoiceId_key" ON "BillingScheduleItem"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingScheduleItem_scheduleId_periodKey_key" ON "BillingScheduleItem"("scheduleId", "periodKey");

-- AddForeignKey
ALTER TABLE "InvoiceRequest" ADD CONSTRAINT "InvoiceRequest_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceRequest" ADD CONSTRAINT "InvoiceRequest_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceRequest" ADD CONSTRAINT "InvoiceRequest_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingSchedule" ADD CONSTRAINT "BillingSchedule_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingScheduleItem" ADD CONSTRAINT "BillingScheduleItem_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "BillingSchedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingScheduleItem" ADD CONSTRAINT "BillingScheduleItem_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

