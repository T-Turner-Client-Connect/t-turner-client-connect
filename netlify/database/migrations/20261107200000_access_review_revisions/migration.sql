-- Owner's Office -> Access review: owner corrections to a completed review.
-- Additive only: one new table (plus an append-only guard on it). Nothing existing is changed;
-- AccessReview rows (including completedAt, which drives the 90-day schedule) are untouched.

-- CreateTable
CREATE TABLE "AccessReviewRevision" (
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "revisionNumber" INTEGER NOT NULL,
    "editedById" TEXT NOT NULL,
    "editedByName" TEXT NOT NULL,
    "editedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT NOT NULL,
    "previous" JSONB NOT NULL,
    "updated" JSONB NOT NULL,
    "changedFields" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "AccessReviewRevision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AccessReviewRevision_reviewId_revisionNumber_key" ON "AccessReviewRevision"("reviewId", "revisionNumber");

-- AddForeignKey
ALTER TABLE "AccessReviewRevision" ADD CONSTRAINT "AccessReviewRevision_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "AccessReview"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Append-only: correction history can be added to, never changed or removed.
CREATE OR REPLACE FUNCTION "access_review_revision_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AccessReviewRevision is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AccessReviewRevision_append_only"
  BEFORE UPDATE OR DELETE ON "AccessReviewRevision"
  FOR EACH ROW EXECUTE FUNCTION "access_review_revision_append_only"();
