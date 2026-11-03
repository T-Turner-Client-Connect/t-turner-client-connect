-- Tax Questionnaires & Intake: one questionnaire request per client per tax year (no
-- duplicates), and staff review of submissions before answers update a client. Additive only.
-- AlterTable
ALTER TABLE "QuestionnaireSubmission" ADD COLUMN     "appliedFields" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "followUp" JSONB,
ADD COLUMN     "reviewStatus" TEXT NOT NULL DEFAULT 'NEEDS_REVIEW',
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "reviewedById" TEXT;


-- CreateTable
CREATE TABLE "QuestionnaireRequest" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "taxYear" INTEGER NOT NULL,
    "questionnaireId" TEXT,
    "sentAt" TIMESTAMP(3),
    "sentById" TEXT,
    "sentTo" TEXT,
    "sendCount" INTEGER NOT NULL DEFAULT 0,
    "openedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuestionnaireRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "QuestionnaireRequest_clientId_taxYear_key" ON "QuestionnaireRequest"("clientId", "taxYear");

-- AddForeignKey
ALTER TABLE "QuestionnaireRequest" ADD CONSTRAINT "QuestionnaireRequest_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "QuestionnaireSubmission" ADD CONSTRAINT "QuestionnaireSubmission_reviewStatus_check" CHECK ("reviewStatus" IN ('NEEDS_REVIEW','REVIEWED'));
