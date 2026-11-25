-- Chunked lead import. A file is uploaded a few thousand rows at a time into
-- lead_import_rows under one lead_import_sessions row, so no request carries the
-- whole file; the duplicate check and the import run as background jobs over the
-- staged rows, and the check's verdicts land in lead_import_duplicates for the
-- review to page through.

CREATE TABLE "lead_import_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "created_by_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'uploading',
    "total_rows" INTEGER NOT NULL DEFAULT 0,
    "check_options" JSONB,
    "summary" JSONB,
    "created_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_import_sessions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "lead_import_sessions_created_at_idx" ON "lead_import_sessions"("created_at");

CREATE TABLE "lead_import_rows" (
    "session_id" UUID NOT NULL,
    "idx" INTEGER NOT NULL,
    "data" JSONB NOT NULL,

    CONSTRAINT "lead_import_rows_pkey" PRIMARY KEY ("session_id","idx")
);

CREATE TABLE "lead_import_duplicates" (
    "session_id" UUID NOT NULL,
    "idx" INTEGER NOT NULL,
    "result" JSONB NOT NULL,

    CONSTRAINT "lead_import_duplicates_pkey" PRIMARY KEY ("session_id","idx")
);

ALTER TABLE "lead_import_rows" ADD CONSTRAINT "lead_import_rows_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "lead_import_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "lead_import_duplicates" ADD CONSTRAINT "lead_import_duplicates_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "lead_import_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
