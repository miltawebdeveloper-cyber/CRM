-- CreateTable
CREATE TABLE "call_recordings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "call_id" UUID NOT NULL,
    "quo_recording_id" TEXT,
    "url" TEXT NOT NULL,
    "duration_secs" INTEGER,
    "start_time" TIMESTAMP(3),
    "status" TEXT,
    "mime_type" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "call_recordings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "call_recordings_quo_recording_id_key" ON "call_recordings"("quo_recording_id");

-- CreateIndex
CREATE INDEX "call_recordings_call_id_idx" ON "call_recordings"("call_id");

-- AddForeignKey
ALTER TABLE "call_recordings" ADD CONSTRAINT "call_recordings_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "calls"("id") ON DELETE CASCADE ON UPDATE CASCADE;
