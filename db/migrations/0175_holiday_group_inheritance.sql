-- R18 a519a96e: Public-holiday group INHERITANCE (parent-child holiday groups) + per-GROUP additional
-- holidays. Extends the existing Holiday Group machinery (ADR-0040 named state bundles + ADR-0067
-- archetype calendars) with two additive, backfill-safe columns — no new table, no materialized copy:
--
--   1. holiday_group.parent_group_id — a group may inherit from ONE parent (single level: the parent must
--      itself be parentless, service-enforced). The resolver reads the parent LIVE at query time, so a
--      holiday added to the parent instantly applies to every child location (the reporter's auto-sync,
--      with zero sync jobs). ON DELETE SET NULL: deleting a parent detaches children rather than erroring;
--      the deleteHolidayGroup service guard (block-while-children) is the friendly primary path, this FK
--      the backstop. The CHECK forbids self-parenting at the DB even if service validation is bypassed.
--
--   2. holiday.holiday_group_id — a THIRD scope axis on the holiday row: a GROUP-scoped "additional
--      holiday" that applies ONLY to staff whose calendar resolves through that group (or through a child
--      inheriting from it). This is what lets "Company Family Day" apply to OKR Office without appearing
--      for Bangsar Office (the existing company-scoped extras are company-subtree-wide, not per-office).
--      ON DELETE CASCADE: a deleted group takes its own extra days with it. The widened scope CHECK keeps
--      a row single-axis (national XOR state XOR company XOR group); the widened holiday_uq lets the same
--      date exist at each scope without collision. Existing rows all have the new column NULL, so every
--      existing query/constraint accepts exactly the same rows as today (byte-identical default paths).
--
-- holiday (0006) and holiday_group (0100) already carry RLS + ai_hr_app grants; new COLUMNS inherit both.
-- No new policy. Statements are idempotent (IF EXISTS / IF NOT EXISTS / drop-then-add) so a re-run or a
-- renumber at integration time is safe.

ALTER TABLE "holiday_group" ADD COLUMN IF NOT EXISTS "parent_group_id" uuid;--> statement-breakpoint
ALTER TABLE "holiday_group" DROP CONSTRAINT IF EXISTS "holiday_group_parent_group_id_holiday_group_id_fk";--> statement-breakpoint
ALTER TABLE "holiday_group" ADD CONSTRAINT "holiday_group_parent_group_id_holiday_group_id_fk" FOREIGN KEY ("parent_group_id") REFERENCES "public"."holiday_group"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holiday_group" DROP CONSTRAINT IF EXISTS "holiday_group_no_self_parent";--> statement-breakpoint
ALTER TABLE "holiday_group" ADD CONSTRAINT "holiday_group_no_self_parent" CHECK ("parent_group_id" IS NULL OR "parent_group_id" <> "id");--> statement-breakpoint
ALTER TABLE "holiday" ADD COLUMN IF NOT EXISTS "holiday_group_id" uuid;--> statement-breakpoint
ALTER TABLE "holiday" DROP CONSTRAINT IF EXISTS "holiday_holiday_group_id_holiday_group_id_fk";--> statement-breakpoint
ALTER TABLE "holiday" ADD CONSTRAINT "holiday_holiday_group_id_holiday_group_id_fk" FOREIGN KEY ("holiday_group_id") REFERENCES "public"."holiday_group"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holiday" DROP CONSTRAINT IF EXISTS "holiday_scope_excl";--> statement-breakpoint
ALTER TABLE "holiday" ADD CONSTRAINT "holiday_scope_excl" CHECK (num_nonnulls("state", "company_id", "holiday_group_id") <= 1);--> statement-breakpoint
DROP INDEX IF EXISTS "holiday_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "holiday_uq" ON "holiday" USING btree ("tenant_id","country","holiday_date",coalesce("state", ''),coalesce("company_id", '00000000-0000-0000-0000-000000000000'::uuid),coalesce("holiday_group_id", '00000000-0000-0000-0000-000000000000'::uuid));
