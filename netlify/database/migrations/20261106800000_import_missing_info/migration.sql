-- TaxAct import: complete missing address/contact info in the preview.
-- Additive only: nullable columns, no drops.

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "mailingSameAsAddress" BOOLEAN,
ADD COLUMN     "mailingAddressLine1" TEXT,
ADD COLUMN     "mailingAddressLine2" TEXT,
ADD COLUMN     "mailingCity" TEXT,
ADD COLUMN     "mailingState" TEXT,
ADD COLUMN     "mailingPostalCode" TEXT;

-- AlterTable
ALTER TABLE "ImportRow" ADD COLUMN     "edits" JSONB,
ADD COLUMN     "editedById" TEXT,
ADD COLUMN     "editedAt" TIMESTAMP(3),
ADD COLUMN     "missingInfo" TEXT[] DEFAULT ARRAY[]::TEXT[];
