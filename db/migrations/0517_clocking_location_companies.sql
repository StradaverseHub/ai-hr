-- r423 (board item 83c0d3c8) — a clocking location is opened to named COMPANIES, and the employee's one
-- switch ("Use Geofencing for Clocking") is the only thing that decides whether clocking is geofenced.
-- ADR-0070, amended r423.
--
-- ── WHAT CHANGES AND WHY ─────────────────────────────────────────────────────────────────────────────
-- Since 0459 a clocking location has had no company at all, so the employee's picker offered every site in
-- the group whatever company the employee belongs to. The approved plan keeps the location a single shared
-- record (one per physical place) and adds the list of companies allowed to use it. Separately, the Clock
-- screen ignored the employee's "Enforce geofencing" tick box (core/attendance-clock.ts forced the check),
-- so the switch is made the one control: ON = compared with an assigned location, OFF = position recorded
-- but not compared.
--
-- ── EACH STEP ────────────────────────────────────────────────────────────────────────────────────────
-- 1. CREATE TABLE clocking_location_company — which companies may use which clocking location. One row per
--    (location, company). ON DELETE CASCADE from clocking_location only: the rows are the location's own
--    parts, so a hard delete of an unreferenced site (core deleteClockingLocation) takes them with it. The
--    company key is ON DELETE no action; core/company-refs.ts declares it `config` (deleted with the
--    company). Index (tenant_id, company_id) serves "the locations open to this company".
-- 2. RLS. INSERT and DELETE: tenant AND app.is_group_admin() — creating and editing a shared location is a
--    group administrator's job (0459), and so is deciding who may use it. There is no UPDATE policy: a row is
--    added or removed, never edited. SELECT: tenant AND (group admin OR app.is_admin_for(company_id) OR the
--    company is one the caller is EMPLOYED by). The last arm is the existing self-person composition used by
--    0500's attendance_clock_capture_insert (EXISTS employment e … app.is_self_person(e.person_id)); there is
--    no dedicated "own employment company" helper and none is invented here. It is what lets the employee's
--    own Clock screen ask "is my assigned site open to my company?". A company administrator therefore reads
--    the rows for the companies they administer and never another company's name.
-- 3. GRANT to ai_hr_app (0345 / 0354: a created table must grant; the suite connects as owner and never
--    notices the omission).
-- 4. ALTER clocking_location ADD state text — nullable, display and filtering only (it does not drive
--    holidays). Validated in the service against the selected companies' countries
--    (core/state-vocabulary validateStateFor), never by a CHECK (CLAUDE.md §6).
-- 5. BACKFILL the companies of every existing clocking location, archived ones included, per the plan:
--    the distinct companies of the employments assigned to it ∪ the company of the work `location` it is
--    linked to (location_id); a location with neither is given EVERY company of its tenant, so it stays
--    selectable exactly as today. Counts are RAISE NOTICEd.
-- 6. employment.geofencing_enabled := true for every employment with at least one assigned clocking
--    location. The Clock screen already checks them against those sites today, so nothing changes for them
--    at clock-in. Before the update the four counts the plan promised the reporter (points 2-5) are
--    RAISE NOTICEd: assigned-but-off (flipped on), unassigned-and-off (stay off), on-but-unassigned (stay on,
--    still refused), radius override set (no longer read). employment.geofence_radius_m is KEPT, unwritten
--    and unread from now on — nothing is destroyed.
-- 7. attendance_clock_capture.clocking_location_id, distance_m and radius_m DROP NOT NULL. A clocking made
--    with the switch OFF records the phone's position with no site, distance or radius. The existing CHECKs
--    (distance_m >= 0; radius_m > 0 AND distance_m <= radius_m) pass on NULL and still hold for every
--    geofenced capture. The only writer of this table is core/attendance-clock.ts captureEmployeeClock
--    (INSERT; UPDATE is reserved to app.purge_attendance_clock_photo, which touches the photo columns only),
--    and it is where "site present iff geofenced" is decided.
--
-- Past clockings and their records are not touched. Everything runs in drizzle's single migration
-- transaction.
--
-- Journal entry: idx 517 (see meta/_journal.json). 0516 is held by an unmerged branch; this file's `when`
-- is above that branch's so either merge order applies both.

CREATE TABLE "clocking_location_company" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"clocking_location_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clocking_location_company" ADD CONSTRAINT "clocking_location_company_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clocking_location_company" ADD CONSTRAINT "clocking_location_company_clocking_location_id_clocking_location_id_fk" FOREIGN KEY ("clocking_location_id") REFERENCES "public"."clocking_location"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clocking_location_company" ADD CONSTRAINT "clocking_location_company_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "clocking_location_company_uq" ON "clocking_location_company" USING btree ("clocking_location_id","company_id");--> statement-breakpoint
CREATE INDEX "clocking_location_company_company_idx" ON "clocking_location_company" USING btree ("tenant_id","company_id");--> statement-breakpoint

ALTER TABLE "clocking_location_company" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "clocking_location_company_select" ON "clocking_location_company" FOR SELECT
  USING (
    tenant_id = app.current_tenant_id()
    AND (
      (SELECT app.is_group_admin())
      OR app.is_admin_for(company_id)
      OR EXISTS (
        SELECT 1 FROM employment e
        WHERE e.company_id = clocking_location_company.company_id
          AND e.tenant_id = clocking_location_company.tenant_id
          AND app.is_self_person(e.person_id)
      )
    )
  );--> statement-breakpoint
CREATE POLICY "clocking_location_company_insert" ON "clocking_location_company" FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_group_admin());--> statement-breakpoint
CREATE POLICY "clocking_location_company_delete" ON "clocking_location_company" FOR DELETE
  USING (tenant_id = app.current_tenant_id() AND app.is_group_admin());--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "clocking_location_company" TO ai_hr_app;--> statement-breakpoint

ALTER TABLE "clocking_location" ADD COLUMN "state" text;--> statement-breakpoint

DO $$
DECLARE
  total int; from_assigned int; from_link int; given_all int; rows_inserted int;
BEGIN
  SELECT count(*) INTO total FROM clocking_location;

  -- The companies whose employees are assigned to the site today.
  INSERT INTO clocking_location_company (tenant_id, clocking_location_id, company_id)
  SELECT DISTINCT cl.tenant_id, cl.id, e.company_id
    FROM clocking_location cl
    JOIN employee_clocking_location ecl ON ecl.clocking_location_id = cl.id
    JOIN employment e ON e.id = ecl.employment_id AND e.tenant_id = cl.tenant_id
  ON CONFLICT (clocking_location_id, company_id) DO NOTHING;
  SELECT count(DISTINCT clocking_location_id) INTO from_assigned FROM clocking_location_company;

  -- Plus the company of the work location it is attached to, if any.
  INSERT INTO clocking_location_company (tenant_id, clocking_location_id, company_id)
  SELECT cl.tenant_id, cl.id, l.company_id
    FROM clocking_location cl
    JOIN location l ON l.id = cl.location_id AND l.tenant_id = cl.tenant_id
  ON CONFLICT (clocking_location_id, company_id) DO NOTHING;
  SELECT count(*) INTO from_link FROM clocking_location cl WHERE cl.location_id IS NOT NULL;

  -- A site nobody is assigned to and attached to nothing: every company of its tenant, so it stays
  -- selectable exactly as today. Counted BEFORE the insert, from the sites still holding no row.
  SELECT count(*) INTO given_all FROM clocking_location cl
   WHERE NOT EXISTS (SELECT 1 FROM clocking_location_company x WHERE x.clocking_location_id = cl.id);
  INSERT INTO clocking_location_company (tenant_id, clocking_location_id, company_id)
  SELECT cl.tenant_id, cl.id, c.id
    FROM clocking_location cl
    JOIN company c ON c.tenant_id = cl.tenant_id
   WHERE NOT EXISTS (SELECT 1 FROM clocking_location_company x WHERE x.clocking_location_id = cl.id)
  ON CONFLICT (clocking_location_id, company_id) DO NOTHING;

  SELECT count(*) INTO rows_inserted FROM clocking_location_company;
  RAISE NOTICE '0517 clocking_location_company backfill: % clocking locations (archived included); % opened to the companies of their assigned employees, % linked to a work location (its company added), % with neither given every company of the tenant; % company rows written.',
    total, from_assigned, from_link, given_all, rows_inserted;
END $$;
--> statement-breakpoint

DO $$
DECLARE assigned_off int; unassigned_off int; on_unassigned int; with_override int; flipped int;
BEGIN
  SELECT count(*) INTO assigned_off FROM employment e
   WHERE NOT e.geofencing_enabled
     AND EXISTS (SELECT 1 FROM employee_clocking_location ecl WHERE ecl.employment_id = e.id);
  SELECT count(*) INTO unassigned_off FROM employment e
   WHERE NOT e.geofencing_enabled
     AND NOT EXISTS (SELECT 1 FROM employee_clocking_location ecl WHERE ecl.employment_id = e.id);
  SELECT count(*) INTO on_unassigned FROM employment e
   WHERE e.geofencing_enabled
     AND NOT EXISTS (SELECT 1 FROM employee_clocking_location ecl WHERE ecl.employment_id = e.id);
  SELECT count(*) INTO with_override FROM employment e WHERE e.geofence_radius_m IS NOT NULL;

  UPDATE employment e SET geofencing_enabled = true
   WHERE NOT e.geofencing_enabled
     AND EXISTS (SELECT 1 FROM employee_clocking_location ecl WHERE ecl.employment_id = e.id);
  GET DIAGNOSTICS flipped = ROW_COUNT;

  RAISE NOTICE '0517 geofencing switch: % employments with an assigned location had it off and are now ON (% flipped); % with no location stay OFF and can now clock in unchecked; % are ON with no location and stay refused at clock-in; % carry a radius override that is no longer read.',
    assigned_off, flipped, unassigned_off, on_unassigned, with_override;
END $$;
--> statement-breakpoint

ALTER TABLE "attendance_clock_capture" ALTER COLUMN "clocking_location_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "attendance_clock_capture" ALTER COLUMN "distance_m" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "attendance_clock_capture" ALTER COLUMN "radius_m" DROP NOT NULL;--> statement-breakpoint

COMMENT ON TABLE "clocking_location_company" IS
  'Which companies may use a shared clocking location (ADR-0070, amended r423, migration 0517). At least one per location, enforced by core/clocking-location.ts. Written by group administrators only; read by group admins, by the administrators of the company, and by employees of the company (their own Clock screen).';
