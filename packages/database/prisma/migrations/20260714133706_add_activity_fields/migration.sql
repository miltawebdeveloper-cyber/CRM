-- AlterTable
ALTER TABLE "activities" ADD COLUMN     "assigned_to_id" UUID,
ADD COLUMN     "call_status" TEXT;

-- AddForeignKey
ALTER TABLE "activities" ADD CONSTRAINT "activities_assigned_to_id_fkey" FOREIGN KEY ("assigned_to_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
