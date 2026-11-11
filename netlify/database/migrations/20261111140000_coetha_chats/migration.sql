-- Ask Coetha: separate chats per business. Additive only: earlier messages keep chatId NULL and
-- show as one "Earlier conversation".
ALTER TABLE "CoethaChatMessage" ADD COLUMN "chatId" TEXT;
CREATE INDEX "CoethaChatMessage_clientId_chatId_createdAt_idx" ON "CoethaChatMessage"("clientId", "chatId", "createdAt");
