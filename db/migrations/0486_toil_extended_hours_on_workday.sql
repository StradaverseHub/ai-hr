-- r334 · 928f0454 — Extended-Hours Replacement Leave Credit.
--
-- Work past a workday's SCHEDULED SHIFT END can now earn a Leave Credit, behind a per-company switch that is
-- OFF on every existing row. Before r334 only a rest day, an off day or a public holiday could earn one
-- (core/toil.ts RL_ELIGIBLE_DAY_TYPES — the "RL Control Engine (0113)" rule); that named rule is untouched,
-- and this opens a separate tiered path beside it rather than widening its membership.
--
-- ⚠️ MONEY: a credit suppresses the worked day's overtime PAY (core/payroll.ts EXCLUDE_TOIL_BANKED_DAYS, both
-- reads, unconditional). `extended_hours_enabled` defaulting to false is what keeps every existing company's
-- payslips byte-identical on release.
--
-- ALTER, not CREATE: `toil_policy` already carries its grants (CLAUDE.md §6 only requires a GRANT for a table
-- this migration creates), so no GRANT is needed and adding one would be noise.
ALTER TABLE "toil_policy" ADD COLUMN IF NOT EXISTS "extended_hours_enabled" boolean NOT NULL DEFAULT false;
ALTER TABLE "toil_policy" ADD COLUMN IF NOT EXISTS "extended_half_day_minutes" integer NOT NULL DEFAULT 240;
ALTER TABLE "toil_policy" ADD COLUMN IF NOT EXISTS "extended_full_day_minutes" integer NOT NULL DEFAULT 480;
ALTER TABLE "toil_policy" ADD COLUMN IF NOT EXISTS "extended_break_minutes" integer NOT NULL DEFAULT 0;
ALTER TABLE "toil_policy" ADD COLUMN IF NOT EXISTS "extended_grace_minutes" integer NOT NULL DEFAULT 0;
