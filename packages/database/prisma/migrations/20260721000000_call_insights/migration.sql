-- CreateTable
CREATE TABLE "call_insights" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "call_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "summary" JSONB,
    "transcript" JSONB,
    "summary_text" TEXT,
    "transcript_text" TEXT,
    "model" TEXT,
    "source" TEXT,
    "error" TEXT,
    "generated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "call_insights_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "call_insights_call_id_key" ON "call_insights"("call_id");

-- CreateIndex
CREATE INDEX "call_insights_status_idx" ON "call_insights"("status");

-- AddForeignKey
ALTER TABLE "call_insights" ADD CONSTRAINT "call_insights_call_id_fkey" FOREIGN KEY ("call_id") REFERENCES "calls"("id") ON DELETE CASCADE ON UPDATE CASCADE;
