-- Audit Center: final resolution, closing date and Coetha's notice reading. Additive only.
ALTER TABLE "NoticeCase" ADD COLUMN "resolution" TEXT;
ALTER TABLE "NoticeCase" ADD COLUMN "closedAt" TIMESTAMP(3);
ALTER TABLE "NoticeCase" ADD COLUMN "coethaReading" JSONB;
