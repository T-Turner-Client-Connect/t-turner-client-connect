-- Import review: per-field approvals after the TaxAct vs Client Connect comparison, and
-- batch-wide staff assignment and groups. Additive only.
-- AlterTable
ALTER TABLE "ImportBatch" ADD COLUMN     "batchAssignedToId" TEXT,
ADD COLUMN     "batchGroupIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "ImportRow" ADD COLUMN     "approvedFields" TEXT[] DEFAULT ARRAY[]::TEXT[];


