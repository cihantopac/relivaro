-- Drop legacy data
ALTER TABLE "User" DROP COLUMN "legacyId";
ALTER TABLE "Order" ADD COLUMN "status" TEXT NOT NULL;
ALTER TABLE "Order" ADD COLUMN "note" TEXT;
TRUNCATE TABLE "Session";
