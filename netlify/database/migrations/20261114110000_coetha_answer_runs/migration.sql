-- Coetha answers run as saved, resumable runs (one per question) worked in the background, so an
-- answer is never cut off by the page's time limit. Additive only.
CREATE TABLE "CoethaAnswerRun" (
    "id" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "chatId" TEXT,
    "askerId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "phase" TEXT NOT NULL DEFAULT 'WAITING',
    "state" JSONB,
    "round" INTEGER NOT NULL DEFAULT 0,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "callId" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "notBefore" TIMESTAMP(3),
    "error" TEXT,
    "timings" JSONB NOT NULL DEFAULT '[]',
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "answerId" TEXT,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CoethaAnswerRun_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CoethaAnswerRun_questionId_key" ON "CoethaAnswerRun"("questionId");
CREATE INDEX "CoethaAnswerRun_status_notBefore_idx" ON "CoethaAnswerRun"("status", "notBefore");
CREATE INDEX "CoethaAnswerRun_clientId_chatId_idx" ON "CoethaAnswerRun"("clientId", "chatId");
