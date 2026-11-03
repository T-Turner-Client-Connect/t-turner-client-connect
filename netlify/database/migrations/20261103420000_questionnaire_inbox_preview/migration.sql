-- Central Questionnaire Inbox: submission date, phones/names for client suggestions, arrival
-- source and who first previewed each submission. Additive only.
-- AlterTable
ALTER TABLE "JotformInbox" ADD COLUMN     "arrivedVia" TEXT NOT NULL DEFAULT 'WEBHOOK',
ADD COLUMN     "names" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "phones" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "previewedAt" TIMESTAMP(3),
ADD COLUMN     "previewedById" TEXT,
ADD COLUMN     "submittedAt" TIMESTAMP(3);


