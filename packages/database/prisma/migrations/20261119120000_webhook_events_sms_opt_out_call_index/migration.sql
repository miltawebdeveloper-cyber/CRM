-- Webhook event dedupe, SMS opt-out, and an index for the incoming-call poll.
-- Additive only: one new table, one nullable column, one index.

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "webhook_events_received_at_idx" ON "webhook_events"("received_at");

-- AlterTable
ALTER TABLE "leads" ADD COLUMN "sms_opt_out_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "calls_caller_id_direction_created_at_idx" ON "calls"("caller_id", "direction", "created_at");
