-- "Ask Coetha": a file sent with a question (additive; nothing existing changes).
ALTER TABLE "CoethaChatMessage" ADD COLUMN "documentId" TEXT;
ALTER TABLE "CoethaChatMessage" ADD COLUMN "attachmentName" TEXT;
