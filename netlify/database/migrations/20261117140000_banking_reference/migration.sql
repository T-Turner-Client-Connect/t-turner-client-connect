-- The client's banks and account endings as Tabitha's banking list gives them: a reference Coetha
-- checks registered accounts against, together with the statements on file. Additive only.
ALTER TABLE "BookkeepingProfile" ADD COLUMN "bankingReference" JSONB;
ALTER TABLE "BookkeepingProfile" ADD COLUMN "bankingReferenceAt" TIMESTAMP(3);
