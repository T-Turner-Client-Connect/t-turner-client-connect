-- "Ask Coetha": up to three files with one question (additive; nothing existing changes).
-- [{ "documentId": "...", "name": "..." }]; documentId/attachmentName keep the first file.
ALTER TABLE "CoethaChatMessage" ADD COLUMN "attachments" JSONB;
