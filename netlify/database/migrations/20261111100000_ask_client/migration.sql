-- Ask Client: a client may answer a supporting-document request with a written explanation
-- instead of (or as well as) a file. The explanation is evidence for the office, never an
-- authorization to post anything. Additive only.
ALTER TABLE "DocumentRequest" ADD COLUMN "clientExplanation" TEXT;
ALTER TABLE "DocumentRequest" ADD COLUMN "explainedAt" TIMESTAMP(3);
ALTER TABLE "DocumentRequest" ADD COLUMN "explainedByPortalId" TEXT;
