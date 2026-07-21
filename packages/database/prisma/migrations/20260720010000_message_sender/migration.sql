-- Per-agent SMS attribution: record which CRM user sent each outbound message, so
-- "sent from the wrong caller ID" can be spotted (sender's own line vs. from_number).
ALTER TABLE "messages" ADD COLUMN "sender_id" UUID;

CREATE INDEX "messages_sender_id_idx" ON "messages"("sender_id");

ALTER TABLE "messages"
  ADD CONSTRAINT "messages_sender_id_fkey"
  FOREIGN KEY ("sender_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
