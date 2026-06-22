-- ADR-0038 2C: state-specific holidays. employment.work_state + company.default_work_state capture
-- where an employee works; holiday.state tags a holiday to a state (null = national). The applicable
-- set for an employee is national ∪ their effective state. The holiday uniqueness widens to include the
-- state (coalesced so the national/NULL case stays unique on PG14). All additive + backfill-safe
-- (existing rows: work_state null, holidays national).
ALTER TABLE employment ADD COLUMN work_state text;--> statement-breakpoint
ALTER TABLE company ADD COLUMN default_work_state text;--> statement-breakpoint
ALTER TABLE holiday ADD COLUMN state text;--> statement-breakpoint
DROP INDEX IF EXISTS "holiday_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "holiday_uq" ON "holiday" USING btree ("tenant_id","country","holiday_date",coalesce("state", ''));
