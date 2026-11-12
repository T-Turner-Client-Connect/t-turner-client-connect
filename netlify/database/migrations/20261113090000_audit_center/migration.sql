-- Tax Audit Preparation Center: audit fields on NoticeCase, audit items and their supporting-document links. Additive only.
ALTER TABLE "NoticeCase" ADD COLUMN "auditKind" TEXT;
ALTER TABLE "NoticeCase" ADD COLUMN "stateCode" TEXT;
ALTER TABLE "NoticeCase" ADD COLUMN "auditType" TEXT;
ALTER TABLE "NoticeCase" ADD COLUMN "noticeReference" TEXT;
ALTER TABLE "NoticeCase" ADD COLUMN "auditStatus" TEXT;
ALTER TABLE "NoticeCase" ADD COLUMN "respondTo" TEXT;
ALTER TABLE "NoticeCase" ADD COLUMN "responseInstructions" TEXT;
ALTER TABLE "NoticeCase" ADD COLUMN "filingId" TEXT;
ALTER TABLE "NoticeCase" ADD COLUMN "packageDocumentId" TEXT;
ALTER TABLE "NoticeCase" ADD COLUMN "releasedAt" TIMESTAMP(3);
ALTER TABLE "NoticeCase" ADD COLUMN "releasedById" TEXT;
ALTER TABLE "NoticeCase" ADD COLUMN "submittedAt" TIMESTAMP(3);
ALTER TABLE "NoticeCase" ADD COLUMN "submittedByPortalId" TEXT;
ALTER TABLE "NoticeCase" ADD COLUMN "submissionMethod" TEXT;
ALTER TABLE "NoticeCase" ADD COLUMN "resolution" TEXT;
ALTER TABLE "NoticeCase" ADD COLUMN "closedAt" TIMESTAMP(3);
ALTER TABLE "NoticeCase" ADD COLUMN "coethaReading" JSONB;
CREATE INDEX "NoticeCase_auditStatus_idx" ON "NoticeCase"("auditStatus");

CREATE TABLE "AuditItem" (
  "id" TEXT NOT NULL,
  "caseId" TEXT NOT NULL,
  "position" INTEGER NOT NULL DEFAULT 0,
  "label" TEXT NOT NULL,
  "schedule" TEXT,
  "returnLine" TEXT,
  "reportedCents" INTEGER,
  "requested" TEXT,
  "explanation" TEXT,
  "note" TEXT,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AuditItem_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AuditItem_caseId_position_idx" ON "AuditItem"("caseId", "position");
ALTER TABLE "AuditItem" ADD CONSTRAINT "AuditItem_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "NoticeCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AuditItemDocument" (
  "id" TEXT NOT NULL,
  "itemId" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "amountCents" INTEGER,
  "note" TEXT,
  "addedById" TEXT,
  "addedBy" TEXT NOT NULL DEFAULT 'STAFF',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuditItemDocument_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AuditItemDocument_itemId_documentId_key" ON "AuditItemDocument"("itemId", "documentId");
ALTER TABLE "AuditItemDocument" ADD CONSTRAINT "AuditItemDocument_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "AuditItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AuditItemDocument" ADD CONSTRAINT "AuditItemDocument_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DocumentRequest" ADD COLUMN "auditItemId" TEXT;
ALTER TABLE "DocumentRequest" ADD CONSTRAINT "DocumentRequest_auditItemId_fkey" FOREIGN KEY ("auditItemId") REFERENCES "AuditItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
