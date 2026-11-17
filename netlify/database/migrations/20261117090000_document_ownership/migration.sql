-- Document ownership checks: when each document was last checked against the client it is filed
-- under, and a staff-only review hold when another client's identifiers are on it but ownership
-- can't be proven. Additive only: two nullable columns and an index.
ALTER TABLE "Document" ADD COLUMN "ownershipCheckedAt" TIMESTAMP(3);
ALTER TABLE "Document" ADD COLUMN "ownershipHold" JSONB;
-- A staff upload marked "publish" stays staff-only until its ownership check clears it.
ALTER TABLE "Document" ADD COLUMN "publishAfterCheck" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "Document_ownershipCheckedAt_idx" ON "Document"("ownershipCheckedAt");

-- Tabitha answers Coetha's question herself, right on the request card: the answer, when, and by whom.
ALTER TABLE "DocumentRequest" ADD COLUMN "officeAnswer" TEXT;
ALTER TABLE "DocumentRequest" ADD COLUMN "officeAnsweredAt" TIMESTAMP(3);
ALTER TABLE "DocumentRequest" ADD COLUMN "officeAnsweredById" TEXT;
