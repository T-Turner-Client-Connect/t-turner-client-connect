-- Owner's Office -> ADP Revenue Share tracker (owner only): referrals and their status history,
-- statements and their lines, the statement revision history, payments received from ADP, manual
-- payment-to-statement matches and the tracker's settings.
-- Additive only: eight new tables (plus append-only guards on the three history tables).
-- Nothing existing is changed: Client gains no columns (only the new tables point at it).

-- CreateTable
CREATE TABLE "AdpReferral" (
    "id" TEXT NOT NULL,
    "clientId" TEXT,
    "prospectName" TEXT,
    "referredOn" DATE NOT NULL,
    "product" TEXT NOT NULL,
    "productOther" TEXT,
    "adpReference" TEXT,
    "status" TEXT NOT NULL DEFAULT 'REFERRED',
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "archivedById" TEXT,
    "archivedReason" TEXT,

    CONSTRAINT "AdpReferral_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdpReferralStatusChange" (
    "id" TEXT NOT NULL,
    "referralId" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT NOT NULL,
    "effectiveOn" DATE,
    "note" TEXT,
    "changedById" TEXT NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdpReferralStatusChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdpStatement" (
    "id" TEXT NOT NULL,
    "periodLabel" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "statementDate" DATE NOT NULL,
    "reportedTotalCents" INTEGER NOT NULL,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "finalizedAt" TIMESTAMP(3),
    "finalizedById" TEXT,
    "fileKey" TEXT,
    "fileName" TEXT,
    "fileMime" TEXT,
    "fileSize" INTEGER,
    "fileSha256" TEXT,
    "fileUploadedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "archivedById" TEXT,
    "archivedReason" TEXT,

    CONSTRAINT "AdpStatement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdpStatementLine" (
    "id" TEXT NOT NULL,
    "statementId" TEXT NOT NULL,
    "referralId" TEXT,
    "clientId" TEXT,
    "adpName" TEXT,
    "type" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "note" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "archivedById" TEXT,
    "archivedReason" TEXT,

    CONSTRAINT "AdpStatementLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdpStatementRevision" (
    "id" TEXT NOT NULL,
    "statementId" TEXT NOT NULL,
    "revisionNumber" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "reason" TEXT,
    "previous" JSONB,
    "updated" JSONB,
    "editedById" TEXT NOT NULL,
    "editedByName" TEXT NOT NULL,
    "editedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdpStatementRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdpPayment" (
    "id" TEXT NOT NULL,
    "receivedOn" DATE NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "method" TEXT NOT NULL,
    "methodOther" TEXT,
    "periodsCovered" TEXT,
    "reference" TEXT,
    "note" TEXT,
    "statementId" TEXT,
    "matchedAt" TIMESTAMP(3),
    "matchedById" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "archivedById" TEXT,
    "archivedReason" TEXT,

    CONSTRAINT "AdpPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdpPaymentMatchEvent" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "statementId" TEXT,
    "action" TEXT NOT NULL,
    "note" TEXT,
    "actorId" TEXT NOT NULL,
    "actorName" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdpPaymentMatchEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdpRevenueShareSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "fiscalNote" TEXT NOT NULL,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdpRevenueShareSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdpReferral_clientId_idx" ON "AdpReferral"("clientId");

-- CreateIndex
CREATE INDEX "AdpReferral_archivedAt_referredOn_idx" ON "AdpReferral"("archivedAt", "referredOn");

-- CreateIndex
CREATE INDEX "AdpReferralStatusChange_referralId_changedAt_idx" ON "AdpReferralStatusChange"("referralId", "changedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AdpStatement_fileKey_key" ON "AdpStatement"("fileKey");

-- CreateIndex
CREATE INDEX "AdpStatement_fileSha256_idx" ON "AdpStatement"("fileSha256");

-- CreateIndex
CREATE INDEX "AdpStatement_archivedAt_statementDate_idx" ON "AdpStatement"("archivedAt", "statementDate");

-- CreateIndex
CREATE INDEX "AdpStatementLine_statementId_sortOrder_idx" ON "AdpStatementLine"("statementId", "sortOrder");

-- CreateIndex
CREATE INDEX "AdpStatementLine_referralId_idx" ON "AdpStatementLine"("referralId");

-- CreateIndex
CREATE INDEX "AdpStatementLine_clientId_idx" ON "AdpStatementLine"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "AdpStatementRevision_statementId_revisionNumber_key" ON "AdpStatementRevision"("statementId", "revisionNumber");

-- CreateIndex
CREATE INDEX "AdpPayment_archivedAt_receivedOn_idx" ON "AdpPayment"("archivedAt", "receivedOn");

-- CreateIndex
CREATE INDEX "AdpPayment_statementId_idx" ON "AdpPayment"("statementId");

-- CreateIndex
CREATE INDEX "AdpPaymentMatchEvent_paymentId_at_idx" ON "AdpPaymentMatchEvent"("paymentId", "at");

-- AddForeignKey
ALTER TABLE "AdpReferral" ADD CONSTRAINT "AdpReferral_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdpReferralStatusChange" ADD CONSTRAINT "AdpReferralStatusChange_referralId_fkey" FOREIGN KEY ("referralId") REFERENCES "AdpReferral"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdpStatementLine" ADD CONSTRAINT "AdpStatementLine_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "AdpStatement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdpStatementLine" ADD CONSTRAINT "AdpStatementLine_referralId_fkey" FOREIGN KEY ("referralId") REFERENCES "AdpReferral"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdpStatementLine" ADD CONSTRAINT "AdpStatementLine_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdpStatementRevision" ADD CONSTRAINT "AdpStatementRevision_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "AdpStatement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdpPayment" ADD CONSTRAINT "AdpPayment_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "AdpStatement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdpPaymentMatchEvent" ADD CONSTRAINT "AdpPaymentMatchEvent_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "AdpPayment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdpPaymentMatchEvent" ADD CONSTRAINT "AdpPaymentMatchEvent_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "AdpStatement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Append-only: referral status history, statement revisions and payment matches can be added
-- to, never changed or removed.
CREATE OR REPLACE FUNCTION "adp_revenue_share_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AdpReferralStatusChange_append_only"
  BEFORE UPDATE OR DELETE ON "AdpReferralStatusChange"
  FOR EACH ROW EXECUTE FUNCTION "adp_revenue_share_append_only"();

CREATE TRIGGER "AdpStatementRevision_append_only"
  BEFORE UPDATE OR DELETE ON "AdpStatementRevision"
  FOR EACH ROW EXECUTE FUNCTION "adp_revenue_share_append_only"();

CREATE TRIGGER "AdpPaymentMatchEvent_append_only"
  BEFORE UPDATE OR DELETE ON "AdpPaymentMatchEvent"
  FOR EACH ROW EXECUTE FUNCTION "adp_revenue_share_append_only"();

