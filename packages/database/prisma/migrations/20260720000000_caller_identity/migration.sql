-- Caller identity: each employee dials from a unique caller ID, and every call
-- records the line it was placed from.

-- Enforce a unique caller identity per user. Postgres treats NULLs as distinct, so
-- many users may remain unassigned (openphone_number IS NULL) while no two users can
-- share the same number. If this fails, two existing users share a number — fix the
-- duplicate before applying.
CREATE UNIQUE INDEX "users_openphone_number_key" ON "users"("openphone_number");

-- Persist the caller identity (OpenPhone line) used for each call, so call logs /
-- recordings / history stay consistent with the employee who made the call,
-- independent of later changes to that user's assigned number.
ALTER TABLE "calls" ADD COLUMN "from_number" TEXT;
