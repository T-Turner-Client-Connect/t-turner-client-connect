-- Audits & Notices (moved from 20261103170000_notice_cases).
-- That version arrived after 20261103180000_coetha_link had already been
-- applied, and Netlify rejects migrations older than the newest applied one,
-- so it never ran on production. Same schema, now ordered after 180000.
-- Written to be safe if any database already has these objects.

ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "noticeCaseId" TEXT;

CREATE TABLE IF NOT EXISTS "NoticeCase" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "taxYear" INTEGER,
    "agency" TEXT NOT NULL,
    "agencyDetail" TEXT,
    "receivedOn" TIMESTAMP(3),
    "responseDueOn" TIMESTAMP(3),
    "clientMessage" TEXT,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "createdByPortalId" TEXT,
    "createdByStaffId" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NoticeCase_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "NoticeCase_clientId_taxYear_idx" ON "NoticeCase"("clientId", "taxYear");
CREATE INDEX IF NOT EXISTS "NoticeCase_status_responseDueOn_idx" ON "NoticeCase"("status", "responseDueOn");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Document_noticeCaseId_fkey') THEN
    ALTER TABLE "Document" ADD CONSTRAINT "Document_noticeCaseId_fkey" FOREIGN KEY ("noticeCaseId") REFERENCES "NoticeCase"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'NoticeCase_clientId_fkey') THEN
    ALTER TABLE "NoticeCase" ADD CONSTRAINT "NoticeCase_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
