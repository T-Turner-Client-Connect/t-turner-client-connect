-- Import review + joint clients + duplicate merge: per-field approvals after the TaxAct vs
-- Client Connect comparison, batch staff/groups, the client's middle name and spouse details,
-- and a merged-into marker for archived duplicates. Additive only: new nullable columns.
-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "mergedIntoId" TEXT,
ADD COLUMN     "middleName" TEXT,
ADD COLUMN     "spouseEmail" TEXT,
ADD COLUMN     "spouseFirstName" TEXT,
ADD COLUMN     "spouseLastName" TEXT,
ADD COLUMN     "spouseMiddleName" TEXT,
ADD COLUMN     "spousePhone" TEXT,
ADD COLUMN     "spousePhoneNormalized" TEXT;

-- AlterTable
ALTER TABLE "ImportBatch" ADD COLUMN     "batchAssignedToId" TEXT,
ADD COLUMN     "batchGroupIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "ImportRow" ADD COLUMN     "approvedFields" TEXT[] DEFAULT ARRAY[]::TEXT[];


