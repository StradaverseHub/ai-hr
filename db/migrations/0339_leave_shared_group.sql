-- Shared Leave Group moves from BENEFIT SCHEME level to LEAVE TYPE level (r88, feedback 1ef1cf95).
--
-- Until now a shared group lived inside a benefit scheme (scheme_leave_combined_limit / _member, migration
-- 0220, extended by 0327). The same shared rule had to be recreated in every scheme it applied to, and the
-- group was described as belonging to a scheme rather than to the leave types that share it. The reporter
-- rejected improving that shape and asked for the group to be its own thing: a name, a shared annual limit,
-- a maximum per application, and a tick list of member leave types.
--
-- THE RESET IS PART OF THE REQUEST, not a side effect: "Remove all existing Shared Leave Group
-- configurations under Benefit Schemes. Reset the current configuration so I can recreate and regroup." So
-- this migration deliberately does NOT carry rows forward.
--
-- BEFORE THE DESTRUCTIVE STEP it captures what is being removed into leave_shared_group_reset_archive —
-- owning scheme name, group name, both limits and the member leave-type names — and RAISEs the same list as
-- a NOTICE so it lands in the deploy log too. The plan promises the reporter that list; this is where the
-- promise is kept, because the rows only exist on the deployed database.
--
-- Idempotent (IF NOT EXISTS / DO blocks), like every migration in this repo.

-- ── 1. The archive, written before anything is dropped ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "leave_shared_group_reset_archive" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"benefit_scheme_name" text,
	"group_name" text NOT NULL,
	"total_limit_days" text,
	"max_days_per_application" text,
	"member_leave_types" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "leave_shared_group_reset_archive" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "leave_shared_group_reset_archive" TO ai_hr_app;--> statement-breakpoint
DROP POLICY IF EXISTS leave_shared_group_reset_archive_rls ON "leave_shared_group_reset_archive";--> statement-breakpoint
CREATE POLICY leave_shared_group_reset_archive_rls ON "leave_shared_group_reset_archive" FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());--> statement-breakpoint

DO $$
DECLARE
  captured int := 0;
  r record;
BEGIN
  -- Guarded on to_regclass so a database that never had 0220 (or a fresh test template) skips cleanly.
  IF to_regclass('public.scheme_leave_combined_limit') IS NOT NULL THEN
    INSERT INTO "leave_shared_group_reset_archive"
      (tenant_id, benefit_scheme_name, group_name, total_limit_days, max_days_per_application, member_leave_types)
    SELECT
      cl.tenant_id,
      bs.name,
      cl.name,
      cl.total_limit_days::text,
      cl.max_days_per_application::text,
      coalesce(
        (SELECT string_agg(lt.name, ', ' ORDER BY lt.name)
           FROM "scheme_leave_combined_limit_member" m
           JOIN "leave_type" lt ON lt.id = m.leave_type_id
          WHERE m.combined_limit_id = cl.id),
        '(no member leave types)'
      )
    FROM "scheme_leave_combined_limit" cl
    LEFT JOIN "benefit_scheme" bs ON bs.id = cl.benefit_scheme_id;
    GET DIAGNOSTICS captured = ROW_COUNT;

    FOR r IN SELECT group_name, benefit_scheme_name, total_limit_days, max_days_per_application, member_leave_types
               FROM "leave_shared_group_reset_archive" ORDER BY benefit_scheme_name, group_name LOOP
      RAISE NOTICE '[0339] RESET shared leave group: "%" (scheme: %) — total % day(s)/year, max %/application, members: %',
        r.group_name, coalesce(r.benefit_scheme_name, '(none)'), r.total_limit_days,
        coalesce(r.max_days_per_application, 'no cap'), r.member_leave_types;
    END LOOP;
  END IF;
  RAISE NOTICE '[0339] Shared leave groups archived before reset: %', captured;
END $$;--> statement-breakpoint

-- ── 2. The new, honestly-named tables ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "leave_shared_group" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"total_limit_days" numeric(6, 2) NOT NULL,
	"max_days_per_application" numeric(6, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "leave_shared_group_name_uq" ON "leave_shared_group" ("tenant_id", "name");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "leave_shared_group_member" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"leave_type_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "leave_shared_group_member" ADD CONSTRAINT "leave_shared_group_member_group_fk" FOREIGN KEY ("group_id") REFERENCES "public"."leave_shared_group"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "leave_shared_group_member" ADD CONSTRAINT "leave_shared_group_member_type_fk" FOREIGN KEY ("leave_type_id") REFERENCES "public"."leave_type"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
-- A LEAVE TYPE BELONGS TO AT MOST ONE GROUP, tenant-wide. No scheme dimension in the key — that IS the
-- change. The deduction path has no defined behaviour for a type in two pools, so this is enforced here and
-- the clash is surfaced by name in the config layer rather than being left to the UI.
CREATE UNIQUE INDEX IF NOT EXISTS "leave_shared_group_member_uq" ON "leave_shared_group_member" ("tenant_id", "leave_type_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "leave_shared_group_member_group_idx" ON "leave_shared_group_member" ("group_id");--> statement-breakpoint
ALTER TABLE "leave_shared_group" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "leave_shared_group_member" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "leave_shared_group" TO ai_hr_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "leave_shared_group_member" TO ai_hr_app;--> statement-breakpoint
DROP POLICY IF EXISTS leave_shared_group_rls ON "leave_shared_group";--> statement-breakpoint
CREATE POLICY leave_shared_group_rls ON "leave_shared_group" FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());--> statement-breakpoint
DROP POLICY IF EXISTS leave_shared_group_member_rls ON "leave_shared_group_member";--> statement-breakpoint
CREATE POLICY leave_shared_group_member_rls ON "leave_shared_group_member" FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());--> statement-breakpoint

-- ── 3. The reset: the scheme-level tables go ──────────────────────────────────────────────────────────
-- Member first, then the pool (the member's FK cascades either way; the order is stated so a reader does
-- not have to work it out). Everything they held is in leave_shared_group_reset_archive above.
DROP TABLE IF EXISTS "scheme_leave_combined_limit_member";--> statement-breakpoint
DROP TABLE IF EXISTS "scheme_leave_combined_limit";
