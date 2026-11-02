-- Records where each billing record's Square customer ID came from.
ALTER TABLE "BookkeepingBilling" ADD COLUMN "squareCustomerIdSource" TEXT;
ALTER TABLE "BookkeepingBilling" ADD COLUMN "squareCustomerIdVerifiedAt" TIMESTAMP(3);

-- Existing IDs are kept exactly as they are and are NOT treated as verified.
-- An ID that a card was saved to through the portal came back from Square itself;
-- every other existing ID was typed by hand.
UPDATE "BookkeepingBilling" SET "squareCustomerIdSource" = CASE WHEN "squareCardId" IS NOT NULL THEN 'CLIENT_CONNECT' ELSE 'MANUAL' END
WHERE "squareCustomerId" IS NOT NULL;
