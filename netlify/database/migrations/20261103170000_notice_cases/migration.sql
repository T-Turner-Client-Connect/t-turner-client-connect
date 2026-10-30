-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "noticeCaseId" TEXT;


-- CreateTable
CREATE TABLE "NoticeCase" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "taxYear" INTEGER,
    "agency" TEXT NOT NULL,
    "agencyDetail" TEXT,
    "receivedOn" TIMESTAMP(3),
    "responseDueOn" TIMESTAMP(3),
    "clientMessage" TEXT,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "createdByPortalId" TEXT,
    "createdByStaffId" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NoticeCase_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NoticeCase_clientId_taxYear_idx" ON "NoticeCase"("clientId", "taxYear");

-- CreateIndex
CREATE INDEX "NoticeCase_status_responseDueOn_idx" ON "NoticeCase"("status", "responseDueOn");

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_noticeCaseId_fkey" FOREIGN KEY ("noticeCaseId") REFERENCES "NoticeCase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoticeCase" ADD CONSTRAINT "NoticeCase_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

