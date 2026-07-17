-- Remove VLC column and add new lead management columns
ALTER TABLE "leads" DROP COLUMN IF EXISTS "vlc";

ALTER TABLE "leads" ADD COLUMN "call_status" TEXT;
ALTER TABLE "leads" ADD COLUMN "first_contact" TIMESTAMP(3);
ALTER TABLE "leads" ADD COLUMN "last_contact" TIMESTAMP(3);
ALTER TABLE "leads" ADD COLUMN "followup_count" INTEGER;
ALTER TABLE "leads" ADD COLUMN "meeting_date" TIMESTAMP(3);
ALTER TABLE "leads" ADD COLUMN "lost_reason" TEXT;
