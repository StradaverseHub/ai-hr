-- WP-B2 (APR-022): leader seats for OneHR calibration.
--
-- Business unit CEO, business group CEO and group chief seats; the per-person head-of-department (HOD)
-- assignment; calibration groups with dated membership; anchors on calibration sessions; retired
-- department-review entries; and the single latest definition of app.onehr_calibration_access.
--
-- Platform rules kept: tenant isolation; effective dates as [valid_from, valid_to) in Malaysia time;
-- per-employment holders (a login qualifies through any of its live employments); rows are ended and never
-- deleted (no DELETE privilege, no DELETE policy, TRUNCATE revoked).
--
-- Anchors (D-B2-2/3): a business unit is a company; a business group is the parent company node of its
-- units, the pack's existing convention (app.onehr_business_group_node). No business-group key exists.
-- The HOD is a per-person assignment held here; department.head_employment_id is neither read nor written.
--
-- Write authority (D-B2-6): tenant-wide HR administrators (hr_admin / super_admin with no company scope);
-- business unit and business group CEO seats also by the HR administrator of the business group node.
-- Performance partners read seats and assignments but never write them.
--
-- Access (single latest definition): a non-final session is entered by the OneHR administrator of its
-- company, by a login named in reviewer_user_ids, or by a login holding the session anchor's live seat
-- today (app.onehr_calibration_reviewer). Existing sessions carry no anchor and keep explicit grants only.

-- ── 1. Authority helpers ───────────────────────────────────────────────────────────────────────────────
-- Leader seat write authority: hr_admin / super_admin, company + descendants; NULL means tenant-wide only.
CREATE FUNCTION app.onehr_leader_admin(wanted_company uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app_user u JOIN role_assignment r ON r.app_user_id=u.id AND r.tenant_id=u.tenant_id
 WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
 AND r.role::text IN ('hr_admin','super_admin') AND (r.company_id IS NULL OR wanted_company IS NOT NULL AND (r.company_id=wanted_company OR app.is_company_descendant(wanted_company,r.company_id))))
$$;
--> statement-breakpoint
-- Any OneHR administration grant (app.assessment_admin_for owns the role list), whatever its company.
CREATE FUNCTION app.onehr_admin_anywhere() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT app.assessment_admin_for(app.current_user_id(),NULL) OR EXISTS(SELECT 1 FROM role_assignment r
  WHERE r.app_user_id=app.current_user_id() AND r.tenant_id=app.current_tenant_id() AND r.company_id IS NOT NULL
   AND app.assessment_admin_for(app.current_user_id(),r.company_id))
$$;
--> statement-breakpoint
-- The employment belongs to the current live login's person.
CREATE FUNCTION app.onehr_own_employment(wanted_employment uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM employment e JOIN app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id
 WHERE e.id=wanted_employment AND e.tenant_id=app.current_tenant_id() AND u.id=app.current_user_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))
$$;
--> statement-breakpoint
-- The business group node of a company: its parent company, or itself when it has none.
CREATE FUNCTION app.onehr_business_group_node(wanted_company uuid) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce(c.parent_company_id,c.id) FROM company c WHERE c.id=wanted_company AND c.tenant_id=app.current_tenant_id()
$$;
--> statement-breakpoint
-- Who may appoint or end a seat. A unit-only administrator never seats a CEO; the group chief is tenant-wide.
CREATE FUNCTION app.onehr_leader_seat_writer(wanted_type text, wanted_company uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT CASE wanted_type
  WHEN 'group_chief' THEN app.onehr_leader_admin(NULL)
  WHEN 'bg_ceo' THEN wanted_company IS NOT NULL AND app.onehr_leader_admin(wanted_company)
  WHEN 'bu_ceo' THEN wanted_company IS NOT NULL AND (app.onehr_leader_admin(NULL) OR EXISTS(SELECT 1 FROM company c
   WHERE c.id=wanted_company AND c.tenant_id=app.current_tenant_id() AND c.parent_company_id IS NOT NULL AND app.onehr_leader_admin(c.parent_company_id)))
  ELSE false END
$$;
--> statement-breakpoint
-- HOD assignments and calibration groups are written by tenant-wide administrators only.
CREATE FUNCTION app.onehr_hod_writer() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT app.onehr_leader_admin(NULL)
$$;
--> statement-breakpoint
-- HOD rows: the subject and the HOD read their own; OneHR administrators of either company read them.
CREATE FUNCTION app.onehr_hod_assignment_readable(wanted_subject uuid, wanted_hod uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT app.onehr_own_employment(wanted_subject) OR app.onehr_own_employment(wanted_hod)
  OR EXISTS(SELECT 1 FROM employment e WHERE e.id IN (wanted_subject,wanted_hod) AND e.tenant_id=app.current_tenant_id() AND app.onehr_admin(e.company_id))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.onehr_leader_admin(uuid),app.onehr_admin_anywhere(),app.onehr_own_employment(uuid),app.onehr_business_group_node(uuid),
 app.onehr_leader_seat_writer(text,uuid),app.onehr_hod_writer(),app.onehr_hod_assignment_readable(uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.onehr_leader_admin(uuid),app.onehr_admin_anywhere(),app.onehr_own_employment(uuid),app.onehr_business_group_node(uuid),
 app.onehr_leader_seat_writer(text,uuid),app.onehr_hod_writer(),app.onehr_hod_assignment_readable(uuid,uuid) TO ai_hr_app;
--> statement-breakpoint

-- ── 2. Calibration groups (D-B2-1): the group chief's anchor, with dated membership ────────────────────
CREATE TABLE performance_calibration_group (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenant(id),
 name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
 created_by uuid NOT NULL REFERENCES app_user(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 retired_by uuid REFERENCES app_user(id),
 retired_at timestamptz,
 CONSTRAINT performance_calibration_group_retired CHECK ((retired_at IS NULL) = (retired_by IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX performance_calibration_group_name_uq ON performance_calibration_group (tenant_id, lower(btrim(name))) WHERE retired_at IS NULL;
--> statement-breakpoint
-- One live group per employment at a time, as the source allows one group per person.
CREATE TABLE performance_calibration_group_member (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenant(id),
 group_id uuid NOT NULL REFERENCES performance_calibration_group(id),
 employment_id uuid NOT NULL REFERENCES employment(id),
 segment text CHECK (segment IS NULL OR length(segment) <= 120),
 source text NOT NULL CHECK (source IN ('department','person','import')),
 valid_from date NOT NULL,
 valid_to date,
 created_by uuid NOT NULL REFERENCES app_user(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 ended_by uuid REFERENCES app_user(id),
 ended_at timestamptz,
 CONSTRAINT performance_calibration_group_member_dates CHECK (valid_to IS NULL OR valid_to >= valid_from),
 CONSTRAINT performance_calibration_group_member_end CHECK ((ended_at IS NULL) = (ended_by IS NULL))
);
--> statement-breakpoint
ALTER TABLE performance_calibration_group_member ADD CONSTRAINT performance_calibration_group_member_one_group
 EXCLUDE USING gist (employment_id WITH =, daterange(valid_from, valid_to, '[)') WITH &&);
--> statement-breakpoint
CREATE INDEX performance_calibration_group_member_group_idx ON performance_calibration_group_member (group_id);
--> statement-breakpoint

-- ── 3. Leader seats: business unit CEO, business group CEO, group chief ────────────────────────────────
CREATE TABLE performance_leader_seat (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenant(id),
 seat_type text NOT NULL CHECK (seat_type IN ('bu_ceo','bg_ceo','group_chief')),
 company_id uuid REFERENCES company(id),
 calibration_group_id uuid REFERENCES performance_calibration_group(id),
 holder_employment_id uuid NOT NULL REFERENCES employment(id),
 valid_from date NOT NULL,
 valid_to date,
 source text NOT NULL CHECK (source IN ('admin','import')),
 source_ref text CHECK (source_ref IS NULL OR length(source_ref) <= 200),
 created_by uuid NOT NULL REFERENCES app_user(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 ended_by uuid REFERENCES app_user(id),
 ended_at timestamptz,
 end_reason text CHECK (end_reason IS NULL OR length(end_reason) <= 500),
 CONSTRAINT performance_leader_seat_anchor CHECK (
  (seat_type IN ('bu_ceo','bg_ceo') AND company_id IS NOT NULL AND calibration_group_id IS NULL)
  OR (seat_type = 'group_chief' AND calibration_group_id IS NOT NULL AND company_id IS NULL)),
 CONSTRAINT performance_leader_seat_dates CHECK (valid_to IS NULL OR valid_to >= valid_from),
 CONSTRAINT performance_leader_seat_end CHECK ((ended_at IS NULL) = (ended_by IS NULL))
);
--> statement-breakpoint
-- One holder per anchor on any day.
ALTER TABLE performance_leader_seat ADD CONSTRAINT performance_leader_seat_one_holder
 EXCLUDE USING gist (tenant_id WITH =, seat_type WITH =, (coalesce(company_id, calibration_group_id)) WITH =, daterange(valid_from, valid_to, '[)') WITH &&);
--> statement-breakpoint
-- A business group CEO leads one business group at a time.
ALTER TABLE performance_leader_seat ADD CONSTRAINT performance_leader_seat_one_group_per_holder
 EXCLUDE USING gist (holder_employment_id WITH =, daterange(valid_from, valid_to, '[)') WITH &&) WHERE (seat_type = 'bg_ceo');
--> statement-breakpoint
CREATE INDEX performance_leader_seat_holder_idx ON performance_leader_seat (holder_employment_id);
--> statement-breakpoint
CREATE INDEX performance_leader_seat_company_idx ON performance_leader_seat (company_id) WHERE company_id IS NOT NULL;
--> statement-breakpoint

-- ── 4. Head of department: one HOD per person per day ──────────────────────────────────────────────────
CREATE TABLE performance_hod_assignment (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenant(id),
 subject_employment_id uuid NOT NULL REFERENCES employment(id),
 hod_employment_id uuid NOT NULL REFERENCES employment(id),
 valid_from date NOT NULL,
 valid_to date,
 source text NOT NULL CHECK (source IN ('admin','import')),
 source_ref text CHECK (source_ref IS NULL OR length(source_ref) <= 200),
 override_reason text CHECK (override_reason IS NULL OR length(btrim(override_reason)) BETWEEN 1 AND 500),
 created_by uuid NOT NULL REFERENCES app_user(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 ended_by uuid REFERENCES app_user(id),
 ended_at timestamptz,
 CONSTRAINT performance_hod_assignment_not_self CHECK (subject_employment_id <> hod_employment_id),
 CONSTRAINT performance_hod_assignment_dates CHECK (valid_to IS NULL OR valid_to >= valid_from),
 CONSTRAINT performance_hod_assignment_end CHECK ((ended_at IS NULL) = (ended_by IS NULL))
);
--> statement-breakpoint
ALTER TABLE performance_hod_assignment ADD CONSTRAINT performance_hod_assignment_one_hod
 EXCLUDE USING gist (subject_employment_id WITH =, daterange(valid_from, valid_to, '[)') WITH &&);
--> statement-breakpoint
CREATE INDEX performance_hod_assignment_hod_idx ON performance_hod_assignment (hod_employment_id);
--> statement-breakpoint

-- ── 5. Session anchors. Existing rows keep every new column NULL: unanchored, explicit grants only ─────
-- Every writer of performance_onehr_calibration was reviewed: createOnehrCalibration, the final-tier insert
-- and the lock/save/reopen UPDATEs write none of these columns, and every existing row meets the first arm.
ALTER TABLE performance_onehr_calibration
 ADD COLUMN anchor_kind text CHECK (anchor_kind IN ('hod','bu_ceo','bg_ceo','group_chief')),
 ADD COLUMN anchor_employment_id uuid REFERENCES employment(id),
 ADD COLUMN calibration_group_id uuid REFERENCES performance_calibration_group(id),
 ADD CONSTRAINT performance_onehr_calibration_anchor CHECK (
  (anchor_kind IS NULL AND anchor_employment_id IS NULL AND calibration_group_id IS NULL)
  OR (anchor_kind='hod' AND tier='hod' AND anchor_employment_id IS NOT NULL AND calibration_group_id IS NULL)
  OR (anchor_kind='bu_ceo' AND tier='bu' AND company_id IS NOT NULL AND anchor_employment_id IS NULL AND calibration_group_id IS NULL)
  OR (anchor_kind='bg_ceo' AND tier='bg' AND company_id IS NOT NULL AND anchor_employment_id IS NULL AND calibration_group_id IS NULL)
  OR (anchor_kind='group_chief' AND tier='group' AND calibration_group_id IS NOT NULL AND anchor_employment_id IS NULL));
--> statement-breakpoint
-- One generated scope per anchor per cycle.
CREATE UNIQUE INDEX performance_onehr_calibration_anchor_uq ON performance_onehr_calibration
 (tenant_id, cycle_id, anchor_kind, (coalesce(anchor_employment_id, calibration_group_id, company_id))) WHERE anchor_kind IS NOT NULL;
--> statement-breakpoint

-- ── 6. Retired department-review entries (D-B2-4): kept with their decisions, never deleted ────────────
CREATE TABLE performance_onehr_calibration_entry_retired (
 LIKE performance_onehr_calibration_entry INCLUDING DEFAULTS,
 retired_at timestamptz NOT NULL DEFAULT now(),
 retired_by uuid NOT NULL REFERENCES app_user(id),
 retired_reason text NOT NULL CHECK (retired_reason IN ('hod_changed')),
 PRIMARY KEY (id)
);
--> statement-breakpoint
CREATE INDEX performance_onehr_calibration_entry_retired_session_idx ON performance_onehr_calibration_entry_retired (session_id);
--> statement-breakpoint

-- ── 7. Privileges and row security. Rows are ended, never deleted ──────────────────────────────────────
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['performance_calibration_group','performance_calibration_group_member','performance_leader_seat','performance_hod_assignment','performance_onehr_calibration_entry_retired'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',t);
 EXECUTE format('REVOKE DELETE, TRUNCATE ON %I FROM ai_hr_app',t);
END LOOP; END $$;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON performance_calibration_group, performance_calibration_group_member, performance_leader_seat, performance_hod_assignment TO ai_hr_app;
--> statement-breakpoint
-- The retired-entry history is read by administrators and written only by app.onehr_retire_calibration_entry.
REVOKE INSERT, UPDATE ON performance_onehr_calibration_entry_retired FROM ai_hr_app;
--> statement-breakpoint
GRANT SELECT ON performance_onehr_calibration_entry_retired TO ai_hr_app;
--> statement-breakpoint
-- Read arms also serve the definer helpers below, which run under these policies (FORCE) with the caller's
-- context: a holder reads their own seats, the reminder dispatcher reads routing facts, administrators read
-- their companies.
CREATE POLICY performance_calibration_group_read ON performance_calibration_group FOR SELECT USING (
 tenant_id=app.current_tenant_id() AND (app.assessment_dispatcher_scope() OR app.onehr_admin_anywhere()));
--> statement-breakpoint
CREATE POLICY performance_calibration_group_insert ON performance_calibration_group FOR INSERT WITH CHECK (tenant_id=app.current_tenant_id() AND app.onehr_hod_writer());
--> statement-breakpoint
CREATE POLICY performance_calibration_group_update ON performance_calibration_group FOR UPDATE USING (tenant_id=app.current_tenant_id() AND app.onehr_hod_writer()) WITH CHECK (tenant_id=app.current_tenant_id() AND app.onehr_hod_writer());
--> statement-breakpoint
CREATE POLICY performance_calibration_group_member_read ON performance_calibration_group_member FOR SELECT USING (
 tenant_id=app.current_tenant_id() AND (app.assessment_dispatcher_scope() OR app.onehr_admin_anywhere() OR app.onehr_own_employment(employment_id)));
--> statement-breakpoint
CREATE POLICY performance_calibration_group_member_insert ON performance_calibration_group_member FOR INSERT WITH CHECK (tenant_id=app.current_tenant_id() AND app.onehr_hod_writer());
--> statement-breakpoint
CREATE POLICY performance_calibration_group_member_update ON performance_calibration_group_member FOR UPDATE USING (tenant_id=app.current_tenant_id() AND app.onehr_hod_writer()) WITH CHECK (tenant_id=app.current_tenant_id() AND app.onehr_hod_writer());
--> statement-breakpoint
CREATE POLICY performance_leader_seat_read ON performance_leader_seat FOR SELECT USING (
 tenant_id=app.current_tenant_id() AND (app.assessment_dispatcher_scope()
  OR CASE WHEN seat_type='group_chief' THEN app.onehr_admin_anywhere() ELSE app.onehr_admin(company_id) END
  OR app.onehr_own_employment(holder_employment_id)));
--> statement-breakpoint
CREATE POLICY performance_leader_seat_insert ON performance_leader_seat FOR INSERT WITH CHECK (tenant_id=app.current_tenant_id() AND app.onehr_leader_seat_writer(seat_type,company_id));
--> statement-breakpoint
CREATE POLICY performance_leader_seat_update ON performance_leader_seat FOR UPDATE USING (tenant_id=app.current_tenant_id() AND app.onehr_leader_seat_writer(seat_type,company_id))
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.onehr_leader_seat_writer(seat_type,company_id));
--> statement-breakpoint
CREATE POLICY performance_hod_assignment_read ON performance_hod_assignment FOR SELECT USING (
 tenant_id=app.current_tenant_id() AND (app.assessment_dispatcher_scope() OR app.onehr_hod_assignment_readable(subject_employment_id,hod_employment_id)));
--> statement-breakpoint
CREATE POLICY performance_hod_assignment_insert ON performance_hod_assignment FOR INSERT WITH CHECK (tenant_id=app.current_tenant_id() AND app.onehr_hod_writer());
--> statement-breakpoint
CREATE POLICY performance_hod_assignment_update ON performance_hod_assignment FOR UPDATE USING (tenant_id=app.current_tenant_id() AND app.onehr_hod_writer()) WITH CHECK (tenant_id=app.current_tenant_id() AND app.onehr_hod_writer());
--> statement-breakpoint
CREATE POLICY performance_onehr_calibration_entry_retired_read ON performance_onehr_calibration_entry_retired FOR SELECT USING (
 tenant_id=app.current_tenant_id() AND app.onehr_cycle_admin((SELECT s.cycle_id FROM performance_onehr_calibration s WHERE s.id=session_id)));
--> statement-breakpoint
-- No app privilege reaches this: it admits only the definer retirement path run by an HOD writer.
CREATE POLICY performance_onehr_calibration_entry_retired_insert ON performance_onehr_calibration_entry_retired FOR INSERT WITH CHECK (tenant_id=app.current_tenant_id() AND app.onehr_hod_writer());
--> statement-breakpoint

-- ── 8. Validation triggers ─────────────────────────────────────────────────────────────────────────────
-- A group chief change is refused once the group's calls are locked in an open cycle: a lock on any of its
-- anchored sessions, or on any person in them, on either axis.
CREATE FUNCTION app.onehr_calibration_group_locked(wanted_group uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM performance_onehr_calibration s JOIN review_cycle c ON c.id=s.cycle_id AND c.tenant_id=s.tenant_id
  WHERE s.tenant_id=app.current_tenant_id() AND s.anchor_kind='group_chief' AND s.calibration_group_id=wanted_group AND c.status IN ('open','calibration')
   AND (s.locked_at IS NOT NULL OR s.performance_locked_at IS NOT NULL OR s.potential_locked_at IS NOT NULL
    OR EXISTS(SELECT 1 FROM performance_onehr_calibration_entry e WHERE e.session_id=s.id AND e.tenant_id=s.tenant_id
     AND (e.locked_at IS NOT NULL OR e.performance_locked_at IS NOT NULL OR e.potential_locked_at IS NOT NULL))))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.onehr_calibration_group_locked(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.onehr_calibration_group_locked(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.onehr_calibration_group_validate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.created_by IS DISTINCT FROM app.current_user_id() OR NEW.retired_at IS NOT NULL OR NEW.retired_by IS NOT NULL THEN
   RAISE EXCEPTION 'Invalid calibration group'; END IF;
  RETURN NEW;
 END IF;
 IF OLD.retired_at IS NOT NULL THEN RAISE EXCEPTION 'A retired calibration group is immutable'; END IF;
 IF NEW.id<>OLD.id OR NEW.tenant_id<>OLD.tenant_id OR NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at THEN RAISE EXCEPTION 'Calibration group identity is immutable'; END IF;
 IF NEW.retired_at IS NOT NULL AND (NEW.retired_by IS DISTINCT FROM app.current_user_id() OR NEW.name<>OLD.name) THEN RAISE EXCEPTION 'Invalid calibration group retirement'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER performance_calibration_group_validate BEFORE INSERT OR UPDATE ON performance_calibration_group FOR EACH ROW EXECUTE FUNCTION app.onehr_calibration_group_validate();
--> statement-breakpoint
-- Shared end-only rule: the only change to a dated row is ending it once, today or later, by the actor.
CREATE FUNCTION app.onehr_dated_row_end_only(n jsonb, o jsonb, extra text[]) RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE today date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
BEGIN
 IF o->>'ended_at' IS NOT NULL THEN RAISE EXCEPTION 'An ended record is immutable'; END IF;
 IF (n-(ARRAY['valid_to','ended_by','ended_at']||extra)) IS DISTINCT FROM (o-(ARRAY['valid_to','ended_by','ended_at']||extra)) THEN RAISE EXCEPTION 'A dated record can only be ended'; END IF;
 IF n->>'ended_at' IS NULL OR (n->>'ended_by')::uuid IS DISTINCT FROM app.current_user_id() OR n->>'valid_to' IS NULL
  OR (n->>'valid_to')::date<today OR (n->>'valid_to')::date<(n->>'valid_from')::date
  OR o->>'valid_to' IS NOT NULL AND (n->>'valid_to')::date>(o->>'valid_to')::date THEN
  RAISE EXCEPTION 'A record ends today or later, and never later than it was due to end'; END IF;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.onehr_dated_row_end_only(jsonb,jsonb,text[]) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.onehr_calibration_group_member_validate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE today date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date; m employment;
BEGIN
 IF TG_OP='UPDATE' THEN PERFORM app.onehr_dated_row_end_only(to_jsonb(NEW),to_jsonb(OLD),'{}'::text[]); RETURN NEW; END IF;
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.created_by IS DISTINCT FROM app.current_user_id() OR NEW.ended_at IS NOT NULL OR NEW.ended_by IS NOT NULL THEN
  RAISE EXCEPTION 'Invalid calibration group membership'; END IF;
 IF NEW.source<>'import' AND NEW.valid_from<today OR NEW.valid_to IS NOT NULL AND NEW.valid_to<today THEN RAISE EXCEPTION 'A calibration group membership cannot start before today'; END IF;
 IF NOT EXISTS(SELECT 1 FROM performance_calibration_group g WHERE g.id=NEW.group_id AND g.tenant_id=NEW.tenant_id AND g.retired_at IS NULL) THEN RAISE EXCEPTION 'Calibration group not found or retired'; END IF;
 SELECT * INTO m FROM employment WHERE id=NEW.employment_id AND tenant_id=NEW.tenant_id;
 IF m.id IS NULL OR m.terminated_on IS NOT NULL AND m.terminated_on<=NEW.valid_from THEN RAISE EXCEPTION 'A calibration group member must be an active employee'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER performance_calibration_group_member_validate BEFORE INSERT OR UPDATE ON performance_calibration_group_member FOR EACH ROW EXECUTE FUNCTION app.onehr_calibration_group_member_validate();
--> statement-breakpoint
CREATE FUNCTION app.onehr_leader_seat_validate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE today date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date; h employment;
BEGIN
 IF TG_OP='UPDATE' THEN
  PERFORM app.onehr_dated_row_end_only(to_jsonb(NEW),to_jsonb(OLD),ARRAY['end_reason']);
  IF NEW.seat_type='group_chief' AND app.onehr_calibration_group_locked(NEW.calibration_group_id) THEN RAISE EXCEPTION 'The group''s calibration calls are locked in an open cycle: the chief cannot change'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.created_by IS DISTINCT FROM app.current_user_id() OR NEW.ended_at IS NOT NULL OR NEW.ended_by IS NOT NULL OR NEW.end_reason IS NOT NULL THEN
  RAISE EXCEPTION 'Invalid leader seat'; END IF;
 IF NEW.source='admin' AND NEW.valid_from<today OR NEW.valid_to IS NOT NULL AND NEW.valid_to<today THEN RAISE EXCEPTION 'A leader seat cannot start before today'; END IF;
 SELECT * INTO h FROM employment WHERE id=NEW.holder_employment_id AND tenant_id=NEW.tenant_id;
 IF h.id IS NULL OR h.terminated_on IS NOT NULL AND h.terminated_on<=NEW.valid_from THEN RAISE EXCEPTION 'The seat holder must be an active employee'; END IF;
 IF NOT app.onehr_leader_admin(h.company_id) THEN RAISE EXCEPTION 'The seat holder is outside your companies'; END IF;
 IF NEW.company_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM company c WHERE c.id=NEW.company_id AND c.tenant_id=NEW.tenant_id) THEN RAISE EXCEPTION 'Invalid leader seat company'; END IF;
 IF NEW.seat_type='bg_ceo' AND NOT EXISTS(SELECT 1 FROM company c WHERE c.parent_company_id=NEW.company_id AND c.tenant_id=NEW.tenant_id) THEN
  RAISE EXCEPTION 'A business group CEO seat belongs to a company with business units under it'; END IF;
 IF NEW.seat_type='group_chief' THEN
  IF NOT EXISTS(SELECT 1 FROM performance_calibration_group g WHERE g.id=NEW.calibration_group_id AND g.tenant_id=NEW.tenant_id AND g.retired_at IS NULL) THEN RAISE EXCEPTION 'Calibration group not found or retired'; END IF;
  IF EXISTS(SELECT 1 FROM performance_calibration_group_member m JOIN employment e ON e.id=m.employment_id AND e.tenant_id=m.tenant_id
   WHERE m.group_id=NEW.calibration_group_id AND m.tenant_id=NEW.tenant_id AND e.person_id=h.person_id
    AND daterange(m.valid_from,m.valid_to,'[)') && daterange(NEW.valid_from,NEW.valid_to,'[)')) THEN RAISE EXCEPTION 'A member of the group cannot be its chief'; END IF;
  IF app.onehr_calibration_group_locked(NEW.calibration_group_id) THEN RAISE EXCEPTION 'The group''s calibration calls are locked in an open cycle: the chief cannot change'; END IF;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER performance_leader_seat_validate BEFORE INSERT OR UPDATE ON performance_leader_seat FOR EACH ROW EXECUTE FUNCTION app.onehr_leader_seat_validate();
--> statement-breakpoint
CREATE FUNCTION app.onehr_hod_assignment_validate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE today date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date; s employment; h employment;
BEGIN
 IF TG_OP='UPDATE' THEN PERFORM app.onehr_dated_row_end_only(to_jsonb(NEW),to_jsonb(OLD),'{}'::text[]); RETURN NEW; END IF;
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.created_by IS DISTINCT FROM app.current_user_id() OR NEW.ended_at IS NOT NULL OR NEW.ended_by IS NOT NULL THEN
  RAISE EXCEPTION 'Invalid head of department assignment'; END IF;
 IF NEW.source='admin' AND NEW.valid_from<today OR NEW.valid_to IS NOT NULL AND NEW.valid_to<today THEN RAISE EXCEPTION 'A head of department assignment cannot start before today'; END IF;
 SELECT * INTO s FROM employment WHERE id=NEW.subject_employment_id AND tenant_id=NEW.tenant_id;
 SELECT * INTO h FROM employment WHERE id=NEW.hod_employment_id AND tenant_id=NEW.tenant_id;
 IF s.id IS NULL OR h.id IS NULL THEN RAISE EXCEPTION 'Invalid head of department assignment'; END IF;
 IF s.person_id=h.person_id THEN RAISE EXCEPTION 'Nobody is their own head of department'; END IF;
 IF h.terminated_on IS NOT NULL AND h.terminated_on<=NEW.valid_from THEN RAISE EXCEPTION 'The head of department must be an active employee'; END IF;
 IF app.onehr_business_group_node(s.company_id) IS DISTINCT FROM app.onehr_business_group_node(h.company_id) THEN
  RAISE EXCEPTION 'A head of department can span business units but not business groups'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER performance_hod_assignment_validate BEFORE INSERT OR UPDATE ON performance_hod_assignment FOR EACH ROW EXECUTE FUNCTION app.onehr_hod_assignment_validate();
--> statement-breakpoint
-- Anchors are immutable and consistent with their tier's company. Retro-anchoring an existing session is refused.
CREATE FUNCTION app.onehr_calibration_anchor_validate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE h employment;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.anchor_kind IS DISTINCT FROM OLD.anchor_kind OR NEW.anchor_employment_id IS DISTINCT FROM OLD.anchor_employment_id OR NEW.calibration_group_id IS DISTINCT FROM OLD.calibration_group_id THEN
   RAISE EXCEPTION 'Calibration scope anchor is immutable'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.anchor_kind='hod' THEN
  SELECT * INTO h FROM employment WHERE id=NEW.anchor_employment_id AND tenant_id=NEW.tenant_id;
  IF h.id IS NULL OR NEW.company_id IS NOT NULL AND NEW.company_id IS DISTINCT FROM app.onehr_business_group_node(h.company_id) THEN RAISE EXCEPTION 'Invalid department review anchor'; END IF;
 ELSIF NEW.anchor_kind='group_chief' THEN
  IF NEW.company_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM performance_calibration_group g WHERE g.id=NEW.calibration_group_id AND g.tenant_id=NEW.tenant_id AND g.retired_at IS NULL) THEN
   RAISE EXCEPTION 'Invalid group calibration anchor'; END IF;
 ELSIF NEW.anchor_kind='bg_ceo' AND NOT EXISTS(SELECT 1 FROM company c WHERE c.parent_company_id=NEW.company_id AND c.tenant_id=NEW.tenant_id) THEN
  RAISE EXCEPTION 'Invalid business group calibration anchor';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER onehr_calibration_anchor BEFORE INSERT OR UPDATE ON performance_onehr_calibration FOR EACH ROW EXECUTE FUNCTION app.onehr_calibration_anchor_validate();
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.onehr_calibration_group_validate(),app.onehr_calibration_group_member_validate(),app.onehr_leader_seat_validate(),
 app.onehr_hod_assignment_validate(),app.onehr_calibration_anchor_validate() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Provider-source custody (0652): these rows now decide calibration access, which decides AI source reads.
DO $$
DECLARE relation_name text;
BEGIN
 FOREACH relation_name IN ARRAY ARRAY['performance_calibration_group','performance_calibration_group_member','performance_leader_seat','performance_hod_assignment','performance_onehr_calibration_entry_retired'] LOOP
  EXECUTE format('CREATE TRIGGER performance_provider_source_row_v1 BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.performance_provider_source_write_guard_v1()',relation_name);
  EXECUTE format('CREATE TRIGGER performance_provider_source_truncate_v1 BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION app.performance_provider_source_write_guard_v1()',relation_name);
 END LOOP;
END $$;
--> statement-breakpoint

-- ── 9. Department-review entry retirement (D-B2-4) ─────────────────────────────────────────────────────
-- Moves one entry of an HOD-anchored session in an open cycle into the retired history, decision intact,
-- once the subject's live HOD is no longer the session's anchor. Called by the HOD writer path only.
CREATE FUNCTION app.onehr_retire_calibration_entry(wanted_entry uuid, wanted_reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE today date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date; e performance_onehr_calibration_entry; s performance_onehr_calibration;
BEGIN
 IF wanted_reason IS DISTINCT FROM 'hod_changed' OR NOT app.onehr_hod_writer() THEN RAISE EXCEPTION 'Head of department administrator access is required' USING ERRCODE='42501'; END IF;
 SELECT * INTO e FROM performance_onehr_calibration_entry WHERE id=wanted_entry AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF e.id IS NULL THEN RAISE EXCEPTION 'Calibration entry not found'; END IF;
 SELECT * INTO s FROM performance_onehr_calibration WHERE id=e.session_id AND tenant_id=e.tenant_id;
 IF s.anchor_kind IS DISTINCT FROM 'hod'
  OR NOT EXISTS(SELECT 1 FROM review_cycle c WHERE c.id=s.cycle_id AND c.tenant_id=s.tenant_id AND c.status IN ('open','calibration'))
  OR EXISTS(SELECT 1 FROM performance_onehr_result f WHERE f.review_id=e.review_id AND f.tenant_id=e.tenant_id)
  OR EXISTS(SELECT 1 FROM performance_hod_assignment h WHERE h.tenant_id=e.tenant_id AND h.subject_employment_id=e.employment_id AND h.hod_employment_id=s.anchor_employment_id
   AND h.valid_from<=today AND (h.valid_to IS NULL OR h.valid_to>today)) THEN
  RAISE EXCEPTION 'This department review entry cannot be retired'; END IF;
 INSERT INTO performance_onehr_calibration_entry_retired
  SELECT * FROM jsonb_populate_record(NULL::performance_onehr_calibration_entry_retired,
   to_jsonb(e)||jsonb_build_object('retired_at',now(),'retired_by',app.current_user_id(),'retired_reason',wanted_reason));
 DELETE FROM performance_onehr_calibration_entry WHERE id=e.id AND tenant_id=e.tenant_id;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.onehr_retire_calibration_entry(uuid,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.onehr_retire_calibration_entry(uuid,text) TO ai_hr_app;
--> statement-breakpoint

-- ── 10. Calibration access (single latest definition; previous: 0540:1321-1325) ────────────────────────
-- Logins whose live employment holds the session anchor's seat today. HOD sessions: the anchor employment
-- itself. Internal: reached only through the definer helpers below.
CREATE FUNCTION app.onehr_calibration_seat_users(wanted_session uuid) RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH today AS (SELECT (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS d),
 s AS (SELECT c.* FROM performance_onehr_calibration c WHERE c.id=wanted_session AND c.tenant_id=app.current_tenant_id() AND c.anchor_kind IS NOT NULL AND c.tier<>'final'),
 holder AS (
  SELECT s.anchor_employment_id AS employment_id FROM s WHERE s.anchor_kind='hod'
  UNION
  SELECT st.holder_employment_id FROM s CROSS JOIN today JOIN performance_leader_seat st ON st.tenant_id=s.tenant_id AND st.seat_type=s.anchor_kind
   AND st.valid_from<=today.d AND (st.valid_to IS NULL OR st.valid_to>today.d)
   AND (s.anchor_kind='group_chief' AND st.calibration_group_id=s.calibration_group_id OR s.anchor_kind IN ('bu_ceo','bg_ceo') AND st.company_id=s.company_id)
 )
 SELECT coalesce(array_agg(DISTINCT u.id ORDER BY u.id),'{}'::uuid[])
 FROM holder h CROSS JOIN today CROSS JOIN s
 JOIN employment e ON e.id=h.employment_id AND e.tenant_id=s.tenant_id
 JOIN app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id
 WHERE u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND (e.terminated_on IS NULL OR e.terminated_on>today.d)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.onehr_calibration_seat_users(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- The non-administrator arm, the one place "named reviewer" is decided: an explicit grant on the session or
-- a live seat for its anchor. Never the final tier. A caller asks about itself; the reminder dispatcher and
-- the session's administrators may ask about any login.
CREATE FUNCTION app.onehr_calibration_reviewer(wanted_session uuid, wanted_user uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM performance_onehr_calibration s JOIN app_user u ON u.id=wanted_user AND u.tenant_id=s.tenant_id
  WHERE s.id=wanted_session AND s.tenant_id=app.current_tenant_id() AND s.tier<>'final'
   AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
   AND (u.id=app.current_user_id() OR app.assessment_dispatcher_scope() OR app.onehr_admin(s.company_id))
   AND (u.id=ANY(s.reviewer_user_ids) OR u.id=ANY(app.onehr_calibration_seat_users(s.id))))
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.onehr_calibration_access(wanted_session uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM performance_onehr_calibration s JOIN app_user u ON u.id=app.current_user_id() AND u.tenant_id=s.tenant_id
 WHERE s.id=wanted_session AND s.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
 AND CASE WHEN s.tier='final' THEN app.onehr_cycle_admin(s.cycle_id) ELSE app.onehr_admin(s.company_id) OR app.onehr_calibration_reviewer(s.id,u.id) END)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.onehr_calibration_reviewer(uuid,uuid),app.onehr_calibration_access(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.onehr_calibration_reviewer(uuid,uuid),app.onehr_calibration_access(uuid) TO ai_hr_app;
--> statement-breakpoint
-- Retained-history boolean for company deletion (core/company-refs.ts): a seat anchored on the company.
CREATE FUNCTION app.onehr_leader_seat_company_in_use(wanted_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.is_admin_for(wanted_company) AND EXISTS(SELECT 1 FROM public.performance_leader_seat s
 WHERE s.tenant_id=app.current_tenant_id() AND s.company_id=wanted_company);
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.onehr_leader_seat_company_in_use(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.onehr_leader_seat_company_in_use(uuid) TO ai_hr_app;
--> statement-breakpoint

-- Where a cycle's reviews already sit at one tier, for the writers that place people (scope generation and
-- the HOD writer). The one-scope-per-tier rule counts every scope, including entries the caller's own
-- visibility hides (their own), so placement is read here. Lock and decision facts are booleans only.
CREATE FUNCTION app.onehr_calibration_placed(wanted_cycle uuid, wanted_tier text)
 RETURNS TABLE(review_id uuid, employment_id uuid, session_id uuid, entry_id uuid, anchor_kind text, anchor_employment_id uuid, entry_locked boolean, session_locked boolean, decided boolean)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT e.review_id,e.employment_id,e.session_id,e.id,s.anchor_kind,s.anchor_employment_id,
  (e.locked_at IS NOT NULL OR e.performance_locked_at IS NOT NULL OR e.potential_locked_at IS NOT NULL),
  (s.locked_at IS NOT NULL OR s.performance_locked_at IS NOT NULL OR s.potential_locked_at IS NOT NULL),
  (e.performance IS NOT NULL OR e.potential IS NOT NULL)
 FROM performance_onehr_calibration_entry e JOIN performance_onehr_calibration s ON s.id=e.session_id AND s.tenant_id=e.tenant_id
 WHERE s.cycle_id=wanted_cycle AND s.tier=wanted_tier AND s.tenant_id=app.current_tenant_id() AND app.onehr_cycle_admin(wanted_cycle)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.onehr_calibration_placed(uuid,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.onehr_calibration_placed(uuid,text) TO ai_hr_app;
--> statement-breakpoint

-- ── 11. Reminder routing (restates 0540:1444-1492) ─────────────────────────────────────────────────────
-- Seat holders join the candidates, and each session's reviewerUserIds are the logins
-- app.onehr_calibration_reviewer admits among the explicit names and the live seat holders.
CREATE OR REPLACE FUNCTION app.assessment_pending_work(wanted_cycle uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH cycle AS MATERIALIZED (
  SELECT c.*,cfg.policy FROM review_cycle c JOIN performance_onehr_cycle cfg ON cfg.cycle_id=c.id AND cfg.tenant_id=c.tenant_id
  WHERE c.id=wanted_cycle AND c.tenant_id=app.current_tenant_id() AND c.status IN ('open','calibration')
   AND (app.assessment_dispatcher_scope() OR app.onehr_cycle_admin(c.id))
 ), reviews AS MATERIALIZED (
  SELECT r.*,p.reviewer_employment_id,p.closed_at,e.person_id,person.full_name,
   app.onehr_moderator_choices(r.review_id) AS moderators,
   EXISTS(SELECT 1 FROM performance_onehr_result f WHERE f.review_id=r.review_id AND f.tenant_id=r.tenant_id) AS frozen
  FROM cycle c JOIN performance_onehr_review r ON r.cycle_id=c.id AND r.tenant_id=c.tenant_id
  JOIN performance_review p ON p.id=r.review_id AND p.tenant_id=r.tenant_id
  JOIN employment e ON e.id=r.employment_id AND e.tenant_id=r.tenant_id JOIN person ON person.id=e.person_id AND person.tenant_id=e.tenant_id
  WHERE app.assessment_review_participates(r.review_id) AND (app.assessment_dispatcher_scope() OR app.onehr_admin(r.company_id))
 ), panels AS MATERIALIZED (
  SELECT p.request_id,p.peer_employment_id,p.review_id FROM performance_onehr_panel p JOIN reviews r ON r.review_id=p.review_id AND r.tenant_id=p.tenant_id
  WHERE p.archived_at IS NULL AND p.submitted_at IS NULL AND NOT r.frozen AND r.closed_at IS NULL
 ), sessions AS MATERIALIZED (
  SELECT s.* FROM cycle c JOIN performance_onehr_calibration s ON s.cycle_id=c.id AND s.tenant_id=c.tenant_id
  WHERE app.assessment_dispatcher_scope() OR app.onehr_admin(s.company_id)
 ), candidates AS (
  SELECT employment_id AS id FROM reviews UNION SELECT reviewer_employment_id FROM reviews
  UNION SELECT (m->>'id')::uuid FROM reviews r CROSS JOIN LATERAL jsonb_array_elements(r.moderators) m
  UNION SELECT peer_employment_id FROM panels
  UNION SELECT e.id FROM sessions s CROSS JOIN LATERAL unnest(s.reviewer_user_ids||app.onehr_calibration_seat_users(s.id)) uid
   JOIN app_user u ON u.id=uid AND u.tenant_id=s.tenant_id JOIN employment e ON e.person_id=u.person_id AND e.tenant_id=u.tenant_id
 ), actors AS MATERIALIZED (
  SELECT u.id,u.person_id,p.full_name,array_agg(e.id ORDER BY e.id) AS employment_ids,
   app.assessment_admin_for(u.id,(SELECT company_id FROM cycle)) AS cycle_admin
  FROM app_user u JOIN person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id JOIN employment e ON e.person_id=p.id AND e.tenant_id=p.tenant_id
  WHERE u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
   AND e.blacklisted_at IS NULL AND (LEAST(e.resignation_date,e.last_working_date,e.terminated_on) IS NULL OR (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date<=LEAST(e.resignation_date,e.last_working_date,e.terminated_on))
   AND EXISTS(SELECT 1 FROM candidates candidate WHERE candidate.id=e.id)
  GROUP BY u.id,u.person_id,p.full_name
 )
 SELECT jsonb_build_object(
  'cycle',jsonb_build_object('id',c.id,'companyId',c.company_id,'name',c.name,'periodEnd',c.period_end,'policy',jsonb_build_object('kind',c.policy->'kind','modules',c.policy->'modules','windows',c.policy->'windows')),
  'actors',coalesce((SELECT jsonb_agg(jsonb_build_object('userId',a.id,'personId',a.person_id,'name',a.full_name,'employmentIds',a.employment_ids,'cycleAdmin',a.cycle_admin) ORDER BY a.id) FROM actors a),'[]'::jsonb),
  'reviews',coalesce((SELECT jsonb_agg(jsonb_build_object('id',r.review_id,'companyId',r.company_id,'employmentId',r.employment_id,'personId',r.person_id,'name',r.full_name,'reviewerEmploymentId',r.reviewer_employment_id,'moderatorIds',(SELECT coalesce(jsonb_agg(m->'id' ORDER BY m->>'id'),'[]'::jsonb) FROM jsonb_array_elements(r.moderators) m),'frozen',r.frozen OR r.closed_at IS NOT NULL,
   'facts',jsonb_build_object('competenciesAssigned',jsonb_array_length(r.competencies)>0,'competencyStatus',r.competency_status,'resultsSubmitted',r.results_submitted_at IS NOT NULL,'managerPerformance',r.manager_performance,
    'planStatus',(SELECT p.status FROM performance_onehr_plan p WHERE p.tenant_id=r.tenant_id AND p.employment_id=r.employment_id AND p.plan_year=extract(year from c.period_end)::integer+CASE WHEN c.policy->>'kind'='year_end' THEN 1 ELSE 0 END),
    'kpis',(SELECT coalesce(jsonb_agg(jsonb_build_object('hrOwned',coalesce((k->>'hrOwned')::boolean,false),'setting',k->'setting','locked',k->'locked','moderatorEmploymentId',k->'moderatorEmploymentId','checkIn',k->'checkIn' IS NOT NULL AND k->'checkIn'<>'null'::jsonb,
     'approvalChain',(SELECT coalesce(jsonb_agg(jsonb_build_object('employmentId',step->'employmentId','at',step->'at') ORDER BY i),'[]'::jsonb) FROM jsonb_array_elements(coalesce(k->'approvalChain','[]'::jsonb)) WITH ORDINALITY q(step,i)),
     'settingApprovals',(SELECT coalesce(jsonb_agg(jsonb_build_object('action',step->'action') ORDER BY i),'[]'::jsonb) FROM jsonb_array_elements(coalesce(k->'settingApprovals','[]'::jsonb)) WITH ORDINALITY q(step,i))) ORDER BY i),'[]'::jsonb) FROM jsonb_array_elements(r.kpis) WITH ORDINALITY q(k,i)))) ORDER BY r.review_id) FROM reviews r),'[]'::jsonb),
  'panels',coalesce((SELECT jsonb_agg(jsonb_build_object('id',p.request_id,'employmentId',p.peer_employment_id,'reviewId',p.review_id) ORDER BY p.request_id) FROM panels p),'[]'::jsonb),
  'sessions',coalesce((SELECT jsonb_agg(jsonb_build_object('id',s.id,'companyId',s.company_id,'tier',s.tier,'reviewerUserIds',(SELECT coalesce(jsonb_agg(ru.uid ORDER BY ru.uid),'[]'::jsonb) FROM (SELECT DISTINCT uid FROM unnest(s.reviewer_user_ids||app.onehr_calibration_seat_users(s.id)) uid) ru WHERE app.onehr_calibration_reviewer(s.id,ru.uid)),'adminUserIds',(SELECT coalesce(jsonb_agg(a.id ORDER BY a.id),'[]'::jsonb) FROM actors a WHERE app.assessment_admin_for(a.id,s.company_id)),
   'lockedAt',s.locked_at,'performanceLockedAt',s.performance_locked_at,'potentialLockedAt',s.potential_locked_at,
   'entries',app.assessment_calibration_work(s.id)) ORDER BY s.id) FROM sessions s),'[]'::jsonb)) FROM cycle c
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.assessment_pending_work(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.assessment_pending_work(uuid) TO ai_hr_app;
