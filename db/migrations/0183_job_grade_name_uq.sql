-- Grade Management for Leave Entitlement (feedback 728a7db6): the reporter requires the Grade master to
-- reject DUPLICATE grade NAMES (only the code was unique before). Add a partial-unique index on
-- (tenant_id, lower(name)) scoped to non-archived rows, mirroring the shape of job_grade_code_uq. Archived
-- grades are exempt so a name can be freed by archiving (same trade-off as the code index). Case-insensitive
-- via lower(name) so "Executive" and "executive" collide, matching the friendly-warning intent.
CREATE UNIQUE INDEX IF NOT EXISTS "job_grade_name_uq" ON "job_grade" ("tenant_id", lower("name")) WHERE archived_at IS NULL;
