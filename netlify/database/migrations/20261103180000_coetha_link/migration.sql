-- "Work with Coetha": per-client Claude Project/conversation link (staff only).
ALTER TABLE "BookkeepingProfile" ADD COLUMN "coethaUrl" TEXT,
ADD COLUMN "coethaUpdatedById" TEXT,
ADD COLUMN "coethaUpdatedAt" TIMESTAMP(3);
