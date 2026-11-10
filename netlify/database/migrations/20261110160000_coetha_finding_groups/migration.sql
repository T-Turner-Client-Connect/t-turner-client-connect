-- Coetha's review of each item she read: its group, proposed account, why, and the evidence that
-- would settle it (additive; nothing existing changes). Proposals only; nothing is posted.
ALTER TABLE "CoethaDocFinding" ADD COLUMN "reviewGroup" TEXT;
ALTER TABLE "CoethaDocFinding" ADD COLUMN "proposedAccount" TEXT;
ALTER TABLE "CoethaDocFinding" ADD COLUMN "reason" TEXT;
ALTER TABLE "CoethaDocFinding" ADD COLUMN "evidenceNeeded" TEXT;
ALTER TABLE "CoethaDocFinding" ADD COLUMN "confidence" DOUBLE PRECISION;
ALTER TABLE "CoethaDocFinding" ADD COLUMN "reviewedAt" TIMESTAMP(3);
CREATE INDEX "CoethaDocFinding_jobId_reviewedAt_idx" ON "CoethaDocFinding"("jobId", "reviewedAt");
