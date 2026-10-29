-- CreateEnum
CREATE TYPE "ContentCategory" AS ENUM ('SERVICE', 'TAX_SEASON', 'BOOKKEEPING_TIP', 'BUSINESS_SETUP', 'NONPROFIT', 'OFFICE_ANNOUNCEMENT', 'HOLIDAY');

-- AlterTable
ALTER TABLE "SocialPost" ADD COLUMN     "claimsVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "claimsVerifiedById" TEXT,
ADD COLUMN     "generatorVariant" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "timeSuggested" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "topicId" TEXT;

-- AlterTable
ALTER TABLE "SocialPostTarget" ADD COLUMN     "hashtags" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "reminderAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "SocialPostRevision" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SocialPostRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentTopic" (
    "id" TEXT NOT NULL,
    "category" "ContentCategory" NOT NULL,
    "title" TEXT NOT NULL,
    "keyMessage" TEXT NOT NULL,
    "callToAction" TEXT,
    "hashtags" TEXT[],
    "eventDate" DATE,
    "createdById" TEXT NOT NULL,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentTopic_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SocialPostRevision_postId_createdAt_idx" ON "SocialPostRevision"("postId", "createdAt");

-- CreateIndex
CREATE INDEX "SocialPost_topicId_idx" ON "SocialPost"("topicId");

-- AddForeignKey
ALTER TABLE "SocialPost" ADD CONSTRAINT "SocialPost_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "ContentTopic"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialPostRevision" ADD CONSTRAINT "SocialPostRevision_postId_fkey" FOREIGN KEY ("postId") REFERENCES "SocialPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

