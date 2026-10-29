-- AlterTable
ALTER TABLE "PortalUser" ADD COLUMN     "preferredState" TEXT;

-- CreateTable
CREATE TABLE "Resource" (
    "id" TEXT NOT NULL,
    "jurisdiction" TEXT NOT NULL,
    "county" TEXT,
    "city" TEXT,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "agency" TEXT NOT NULL,
    "url" TEXT,
    "phone" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NEEDS_VERIFICATION',
    "verificationMethod" TEXT,
    "notes" TEXT,
    "lastVerifiedAt" TIMESTAMP(3),
    "linkCheckedAt" TIMESTAMP(3),
    "linkCheckStatus" INTEGER,
    "linkCheckOk" BOOLEAN,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Resource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResourceFaq" (
    "id" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "tags" TEXT[],
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResourceFaq_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Resource_jurisdiction_category_idx" ON "Resource"("jurisdiction", "category");

