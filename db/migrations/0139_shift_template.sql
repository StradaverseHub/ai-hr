-- R7 Multi-Shift Attendance — PHASE 1 (shift template). Additive ALTER TABLE shift, modelled on 0136:
--   • code            — short per-company identifier. Nullable in DB, REQUIRED by the form/service; every
--                       existing row is backfilled below so no legacy shift is left codeless (uneditable).
--   • break_periods   — jsonb array of { start, end } 'HH:MM:SS' windows. STORAGE-ONLY this phase: the
--                       engine / punch import / hourly clamp keep reading the canonical break_minutes
--                       scalar (= Σ break durations), persisted alongside by the service.
--   • normal_minutes_override — manual normal-working-minutes figure; when set it is what workday OT is
--                       measured against (core/attendance.ts deriveAttendance). NULL ⇒ auto (span − break).
--
-- RLS/policies on shift already exist and are unchanged; grants are table-level (0075), so the added
-- columns need no new grants.

ALTER TABLE "shift" ADD COLUMN "code" text;--> statement-breakpoint
ALTER TABLE "shift" ADD COLUMN "break_periods" jsonb;--> statement-breakpoint
ALTER TABLE "shift" ADD COLUMN "normal_minutes_override" integer;--> statement-breakpoint

-- Backfill every existing row with a deterministic, unique-ish code: the first 6 alphanumerics of the name
-- (uppercased) + the first 4 chars of the id. Leaves zero NULL codes behind.
UPDATE "shift"
SET "code" = upper(left(regexp_replace("name", '[^A-Za-z0-9]', '', 'g'), 6)) || '-' || left("id"::text, 4)
WHERE "code" IS NULL;--> statement-breakpoint

-- Code unique per company among NON-archived rows (mirrors shift_company_name_uq; archive frees the code
-- for reuse, exactly like the name). Case-insensitive via lower().
CREATE UNIQUE INDEX "shift_company_code_uq" ON "shift" ("tenant_id", "company_id", lower("code")) WHERE "archived_at" IS NULL;
