-- What a bookkeeping upload covers (date range). Adds two empty columns; existing documents are not changed.
ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "periodStart" TIMESTAMP(3);
ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "periodEnd" TIMESTAMP(3);
