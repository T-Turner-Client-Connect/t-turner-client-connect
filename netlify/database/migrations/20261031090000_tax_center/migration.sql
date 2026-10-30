-- AlterTable
ALTER TABLE "Announcement" ADD COLUMN     "audience" TEXT,
ADD COLUMN     "pinned" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "topic" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "entityType" TEXT,
ADD COLUMN     "fiscalYearEnd" INTEGER;

-- AlterTable
ALTER TABLE "PortalUser" ADD COLUMN     "identityVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "identityVerifiedById" TEXT;

-- AlterTable
ALTER TABLE "StoredFile" ADD COLUMN     "sha256" TEXT;


-- CreateTable
CREATE TABLE "TaxDeadline" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "taxYear" INTEGER NOT NULL,
    "jurisdiction" TEXT NOT NULL DEFAULT 'US',
    "reliefState" TEXT NOT NULL DEFAULT '',
    "dueDate" TEXT NOT NULL,
    "timeNote" TEXT,
    "notes" TEXT,
    "sourceUrl" TEXT,
    "lastReviewedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaxDeadline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxQuestionnaire" (
    "id" TEXT NOT NULL,
    "taxYear" INTEGER NOT NULL,
    "audience" TEXT NOT NULL DEFAULT 'ALL',
    "title" TEXT NOT NULL,
    "jotformFormId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaxQuestionnaire_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuestionnaireSubmission" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "taxYear" INTEGER NOT NULL,
    "questionnaireId" TEXT,
    "jotformFormId" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "source" TEXT NOT NULL,
    "answersEnc" TEXT,
    "matchNote" TEXT,
    "linkedById" TEXT,
    "documentIds" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuestionnaireSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxYearProgress" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "taxYear" INTEGER NOT NULL,
    "documentsStatus" TEXT NOT NULL DEFAULT 'NOT_STARTED',
    "documentsUpdatedAt" TIMESTAMP(3),
    "estimatedCompletion" TIMESTAMP(3),
    "estimateNote" TEXT,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaxYearProgress_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TaxDeadline_kind_taxYear_jurisdiction_reliefState_key" ON "TaxDeadline"("kind", "taxYear", "jurisdiction", "reliefState");

-- CreateIndex
CREATE UNIQUE INDEX "TaxQuestionnaire_taxYear_audience_key" ON "TaxQuestionnaire"("taxYear", "audience");

-- CreateIndex
CREATE UNIQUE INDEX "QuestionnaireSubmission_submissionId_key" ON "QuestionnaireSubmission"("submissionId");

-- CreateIndex
CREATE INDEX "QuestionnaireSubmission_clientId_taxYear_idx" ON "QuestionnaireSubmission"("clientId", "taxYear");

-- CreateIndex
CREATE UNIQUE INDEX "TaxYearProgress_clientId_taxYear_key" ON "TaxYearProgress"("clientId", "taxYear");

-- CreateIndex
CREATE INDEX "StoredFile_sha256_idx" ON "StoredFile"("sha256");

-- AddForeignKey
ALTER TABLE "QuestionnaireSubmission" ADD CONSTRAINT "QuestionnaireSubmission_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionnaireSubmission" ADD CONSTRAINT "QuestionnaireSubmission_questionnaireId_fkey" FOREIGN KEY ("questionnaireId") REFERENCES "TaxQuestionnaire"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxYearProgress" ADD CONSTRAINT "TaxYearProgress_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

