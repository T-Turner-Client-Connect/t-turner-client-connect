-- Jotform webhook: staff-review inbox for unmatched/held questionnaire submissions, and the
-- owner's auto-filing switch (OFF by default). Additive only.

-- CreateTable
CREATE TABLE "JotformInbox" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "formId" TEXT NOT NULL,
    "questionnaireId" TEXT,
    "taxYear" INTEGER,
    "suggestedClientId" TEXT,
    "reason" TEXT NOT NULL,
    "emails" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "filedClientId" TEXT,

    CONSTRAINT "JotformInbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "jotformAutoFileEnabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "JotformInbox_submissionId_key" ON "JotformInbox"("submissionId");

-- CreateIndex
CREATE INDEX "JotformInbox_status_receivedAt_idx" ON "JotformInbox"("status", "receivedAt");

ALTER TABLE "JotformInbox" ADD CONSTRAINT "JotformInbox_status_check" CHECK ("status" IN ('PENDING','FILED','DISMISSED'));
