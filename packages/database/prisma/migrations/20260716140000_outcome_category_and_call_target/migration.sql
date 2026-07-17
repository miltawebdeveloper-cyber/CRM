-- CreateEnum
CREATE TYPE "OutcomeCategory" AS ENUM ('cold', 'warm', 'hot', 'connected', 'closed_positive', 'closed_negative');

-- AlterTable
ALTER TABLE "outcomes" ADD COLUMN     "category" "OutcomeCategory";

-- AlterTable
ALTER TABLE "employees" ADD COLUMN     "daily_call_target" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "target_miss_reason" TEXT;

-- Seed the funnel buckets for the statuses shipped with the app, matching the
-- team's existing call report. Admin-created statuses stay NULL (ungrouped)
-- until someone assigns them a bucket.
UPDATE "outcomes" SET "category" = 'cold' WHERE "slug" IN
  ('no_answer', 'voice_mail', 'answering_machine', 'disconnected', 'wrong_number', 'dormant', 'not_available', 'do_not_disturb');

UPDATE "outcomes" SET "category" = 'warm' WHERE "slug" IN
  ('call_back', 'opposite_call_back', 'email', 'zoom');

UPDATE "outcomes" SET "category" = 'hot' WHERE "slug" IN
  ('negotiation', 'proposal_sent');

UPDATE "outcomes" SET "category" = 'connected' WHERE "slug" IN
  ('follow_up_required', 'meeting_scheduled', 'follow_up_1', 'follow_up_2', 'follow_up_3', 'follow_up_4', 'follow_up_5');

UPDATE "outcomes" SET "category" = 'closed_positive' WHERE "slug" IN ('closed_won');

UPDATE "outcomes" SET "category" = 'closed_negative' WHERE "slug" IN
  ('closed_lost', 'not_interested', 'dm_not_interested', 'do_not_contact');
