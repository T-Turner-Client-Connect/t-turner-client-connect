-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "replacesId" TEXT,
ADD COLUMN     "supersededAt" TIMESTAMP(3),
ADD COLUMN     "version" INTEGER;


-- CreateIndex
CREATE UNIQUE INDEX "Document_replacesId_key" ON "Document"("replacesId");

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_replacesId_fkey" FOREIGN KEY ("replacesId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

