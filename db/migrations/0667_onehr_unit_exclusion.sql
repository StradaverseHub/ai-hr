-- D-P1-22 (APR-022): units and departments not taking part in a cycle (the cycle exclusion rule). ADR-0150.
--
-- One owner of the fact "this unit is out of this cycle": performance_assessment_unit_exclusion, keyed by
-- (cycle, company, optional department). No business-group key (D1); an exact department, never its
-- sub-departments (D2). Everything else is DERIVED from the active rules on every read (D3): participation,
-- leader rights, the one-level-up competency and Career Plan reviewer, calibration grants. The written-once
-- effects (360 rows archived, untouched KPI lines moved one level up) are done by the service at save through
-- the existing single writers; nothing here writes them.
--
-- Placement: the employment's assignment in force today (Malaysia), its company falling back to the
-- employment's company (core/employment-company.ts). A closed cycle reads the set pinned at close instead
-- (D8), written by app.assessment_unit_exclusion_pin inside the cycle close transaction.
--
-- Precedence for the subject (app.assessment_review_participates): terminated, then the unit rule, then the
-- per-person override, then the opening snapshot. A review with a frozen result is exempt (D7).
-- Leader-off reads the unit rule only (never the per-person override), per acting employment (D9); a login's
-- explicit calibration grant is off only when every live employment of it in the cycle's scope is out.
-- Administrators are never stopped. The one-level-up walk is one function for preview and runtime (D6):
-- at most six managers up the live administrative line, stopping at a terminated manager or the subject.
--
-- Writes: tenant-wide HR administrators only (D4), in an open or calibration cycle (D11). Rules are ended,
-- never deleted (D12): no DELETE policy, DELETE and TRUNCATE revoked. Company-scoped administrators and
-- performance partners read the rules of their companies.
--
-- Definer reads under FORCE row security: a non-superuser owner is subject to these policies with the
-- caller's context, so each read policy keeps a definer arm (current_user<>'ai_hr_app', the 0547/0559
-- convention); the application role itself only reads what its own arm admits.

-- ── 1. The rule and the close-time pin ─────────────────────────────────────────────────────────────────
CREATE TABLE performance_assessment_unit_exclusion (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenant(id),
 cycle_id uuid NOT NULL REFERENCES review_cycle(id),
 company_id uuid NOT NULL REFERENCES company(id),
 department_id uuid REFERENCES department(id),
 created_by uuid NOT NULL REFERENCES app_user(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 ended_by uuid REFERENCES app_user(id),
 ended_at timestamptz,
 end_reason text CHECK (end_reason IN ('brought_back','subsumed')),
 CONSTRAINT performance_assessment_unit_exclusion_end CHECK ((ended_at IS NULL) = (ended_by IS NULL) AND (ended_at IS NULL) = (end_reason IS NULL))
);
--> statement-breakpoint
-- One active rule per cycle, company and department. Also the fast path: a cycle with no active rule costs one
-- probe of this partial index.
CREATE UNIQUE INDEX performance_assessment_unit_exclusion_active_uq ON performance_assessment_unit_exclusion
 (tenant_id, cycle_id, company_id, (coalesce(department_id, '00000000-0000-0000-0000-000000000000'::uuid))) WHERE ended_at IS NULL;
--> statement-breakpoint
CREATE INDEX performance_assessment_unit_exclusion_company_idx ON performance_assessment_unit_exclusion (company_id);
--> statement-breakpoint
CREATE INDEX performance_assessment_unit_exclusion_department_idx ON performance_assessment_unit_exclusion (department_id) WHERE department_id IS NOT NULL;
--> statement-breakpoint
-- D8: the employments a closed cycle's rules covered on its close day. Written only by the definer below.
CREATE TABLE performance_assessment_unit_exclusion_pin (
 tenant_id uuid NOT NULL REFERENCES tenant(id),
 cycle_id uuid NOT NULL REFERENCES review_cycle(id),
 employment_id uuid NOT NULL REFERENCES employment(id),
 rule_id uuid NOT NULL REFERENCES performance_assessment_unit_exclusion(id),
 pinned_on date NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (cycle_id, employment_id)
);
--> statement-breakpoint
CREATE INDEX performance_assessment_unit_exclusion_pin_rule_idx ON performance_assessment_unit_exclusion_pin (rule_id);
--> statement-breakpoint

-- ── 2. Authority helpers ───────────────────────────────────────────────────────────────────────────────
-- D4: a tenant-wide HR administrator (hr_admin / super_admin with no company scope) writes rules.
CREATE FUNCTION app.assessment_unit_exclusion_writer() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT app.onehr_leader_admin(NULL)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.assessment_unit_exclusion_writer() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.assessment_unit_exclusion_writer() TO ai_hr_app;
--> statement-breakpoint

-- ── 3. Privileges and row security. Rules are ended, never deleted ─────────────────────────────────────
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['performance_assessment_unit_exclusion','performance_assessment_unit_exclusion_pin'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',t);
 EXECUTE format('REVOKE ALL ON %I FROM ai_hr_app',t);
END LOOP; END $$;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON performance_assessment_unit_exclusion TO ai_hr_app;
--> statement-breakpoint
-- The pin is written by app.assessment_unit_exclusion_pin only; the application role reads it.
GRANT SELECT ON performance_assessment_unit_exclusion_pin TO ai_hr_app;
--> statement-breakpoint
CREATE POLICY performance_assessment_unit_exclusion_read ON performance_assessment_unit_exclusion FOR SELECT USING (
 tenant_id=app.current_tenant_id() AND (current_user<>'ai_hr_app' OR app.onehr_admin(company_id)));
--> statement-breakpoint
CREATE POLICY performance_assessment_unit_exclusion_insert ON performance_assessment_unit_exclusion FOR INSERT WITH CHECK (
 tenant_id=app.current_tenant_id() AND app.assessment_unit_exclusion_writer());
--> statement-breakpoint
CREATE POLICY performance_assessment_unit_exclusion_update ON performance_assessment_unit_exclusion FOR UPDATE
 USING (tenant_id=app.current_tenant_id() AND app.assessment_unit_exclusion_writer())
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.assessment_unit_exclusion_writer());
--> statement-breakpoint
CREATE POLICY performance_assessment_unit_exclusion_pin_read ON performance_assessment_unit_exclusion_pin FOR SELECT USING (
 tenant_id=app.current_tenant_id() AND (current_user<>'ai_hr_app' OR app.onehr_cycle_admin(cycle_id)));
--> statement-breakpoint
-- No application privilege reaches this: only the definer pin path, run for a cycle administrator.
CREATE POLICY performance_assessment_unit_exclusion_pin_insert ON performance_assessment_unit_exclusion_pin FOR INSERT WITH CHECK (
 tenant_id=app.current_tenant_id() AND current_user<>'ai_hr_app' AND app.onehr_cycle_admin(cycle_id));
--> statement-breakpoint

-- ── 4. Validation: scope, cycle state, end-only updates ────────────────────────────────────────────────
CREATE FUNCTION app.assessment_unit_exclusion_validate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c review_cycle;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF OLD.ended_at IS NOT NULL THEN RAISE EXCEPTION 'An ended unit exclusion rule is immutable'; END IF;
  IF (to_jsonb(NEW)-ARRAY['ended_by','ended_at','end_reason']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['ended_by','ended_at','end_reason']) THEN
   RAISE EXCEPTION 'A unit exclusion rule can only be ended'; END IF;
  IF NEW.ended_at IS NULL OR NEW.ended_by IS DISTINCT FROM app.current_user_id() OR NEW.end_reason IS NULL THEN
   RAISE EXCEPTION 'A unit exclusion rule is ended once, by its actor, with a reason'; END IF;
  SELECT * INTO c FROM review_cycle WHERE id=OLD.cycle_id AND tenant_id=OLD.tenant_id;
  IF c.id IS NULL OR c.status NOT IN ('open','calibration') THEN RAISE EXCEPTION 'Unit exclusion rules change only while the cycle is open or in calibration'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.created_by IS DISTINCT FROM app.current_user_id()
  OR NEW.ended_at IS NOT NULL OR NEW.ended_by IS NOT NULL OR NEW.end_reason IS NOT NULL THEN
  RAISE EXCEPTION 'Invalid unit exclusion rule'; END IF;
 SELECT * INTO c FROM review_cycle WHERE id=NEW.cycle_id AND tenant_id=NEW.tenant_id;
 IF c.id IS NULL OR NOT EXISTS(SELECT 1 FROM performance_onehr_cycle cfg WHERE cfg.cycle_id=c.id AND cfg.tenant_id=c.tenant_id) THEN
  RAISE EXCEPTION 'A unit exclusion rule belongs to a performance and talent review cycle'; END IF;
 IF c.status NOT IN ('open','calibration') THEN RAISE EXCEPTION 'Unit exclusion rules change only while the cycle is open or in calibration'; END IF;
 IF NOT EXISTS(SELECT 1 FROM company co WHERE co.id=NEW.company_id AND co.tenant_id=NEW.tenant_id) THEN RAISE EXCEPTION 'Invalid unit exclusion company'; END IF;
 IF c.company_id IS NOT NULL AND c.company_id<>NEW.company_id THEN RAISE EXCEPTION 'The company is outside this cycle'; END IF;
 IF NEW.department_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM department d WHERE d.id=NEW.department_id AND d.tenant_id=NEW.tenant_id AND d.company_id=NEW.company_id) THEN
  RAISE EXCEPTION 'The department belongs to another company'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER performance_assessment_unit_exclusion_validate BEFORE INSERT OR UPDATE ON performance_assessment_unit_exclusion FOR EACH ROW EXECUTE FUNCTION app.assessment_unit_exclusion_validate();
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.assessment_unit_exclusion_validate() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Provider-source custody (0652): these rows decide participation and leader rights, which decide AI source reads.
DO $$
DECLARE relation_name text;
BEGIN
 FOREACH relation_name IN ARRAY ARRAY['performance_assessment_unit_exclusion','performance_assessment_unit_exclusion_pin'] LOOP
  EXECUTE format('CREATE TRIGGER performance_provider_source_row_v1 BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.performance_provider_source_write_guard_v1()',relation_name);
  EXECUTE format('CREATE TRIGGER performance_provider_source_truncate_v1 BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION app.performance_provider_source_write_guard_v1()',relation_name);
 END LOOP;
END $$;
--> statement-breakpoint

-- ── 5. The derived predicates (internal unless stated) ─────────────────────────────────────────────────
-- The employment's placement today: the assignment in force (Malaysia) and its company, else the employment's.
CREATE FUNCTION app.assessment_unit_placement(wanted_employment uuid) RETURNS TABLE(company_id uuid, department_id uuid)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce(cur.company_id,e.company_id),cur.department_id
 FROM employment e LEFT JOIN LATERAL (
  SELECT a.company_id,a.department_id FROM assignment a
  WHERE a.employment_id=e.id AND a.tenant_id=e.tenant_id AND a.superseded_at IS NULL
   AND a.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
   AND (a.valid_to IS NULL OR a.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
  ORDER BY a.valid_from DESC,a.id LIMIT 1) cur ON true
 WHERE e.id=wanted_employment AND e.tenant_id=app.current_tenant_id()
$$;
--> statement-breakpoint
-- The employment falls in (company, department-or-whole-company) today. Exact department (D2).
CREATE FUNCTION app.assessment_unit_scope_matches(wanted_employment uuid, wanted_company uuid, wanted_department uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT wanted_company IS NOT NULL AND EXISTS(SELECT 1 FROM app.assessment_unit_placement(wanted_employment) pl
  WHERE pl.company_id=wanted_company AND (wanted_department IS NULL OR pl.department_id=wanted_department))
$$;
--> statement-breakpoint
-- Excluded from the cycle by an active rule, or (preview only) by the proposed extra scope. A closed cycle
-- reads its pin (D8). The second branch is the fast path: no active rule and no proposal, one index probe.
CREATE FUNCTION app.assessment_unit_excluded_as(wanted_cycle uuid, wanted_employment uuid, extra_company uuid, extra_department uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce((
  SELECT CASE
   WHEN c.status='closed' THEN EXISTS(SELECT 1 FROM performance_assessment_unit_exclusion_pin p
    WHERE p.tenant_id=c.tenant_id AND p.cycle_id=c.id AND p.employment_id=wanted_employment)
   WHEN extra_company IS NULL AND NOT EXISTS(SELECT 1 FROM performance_assessment_unit_exclusion x
    WHERE x.tenant_id=c.tenant_id AND x.cycle_id=c.id AND x.ended_at IS NULL) THEN false
   ELSE EXISTS(SELECT 1 FROM app.assessment_unit_placement(wanted_employment) pl
    WHERE EXISTS(SELECT 1 FROM performance_assessment_unit_exclusion x
      WHERE x.tenant_id=c.tenant_id AND x.cycle_id=c.id AND x.ended_at IS NULL
       AND x.company_id=pl.company_id AND (x.department_id IS NULL OR x.department_id=pl.department_id))
     OR extra_company IS NOT NULL AND extra_company=pl.company_id AND (extra_department IS NULL OR extra_department=pl.department_id))
  END
  FROM review_cycle c WHERE c.id=wanted_cycle AND c.tenant_id=app.current_tenant_id()),false)
$$;
--> statement-breakpoint
CREATE FUNCTION app.assessment_unit_excluded(wanted_cycle uuid, wanted_employment uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT app.assessment_unit_excluded_as(wanted_cycle,wanted_employment,NULL,NULL)
$$;
--> statement-breakpoint
-- D9 for a login's explicit calibration grant: off only when the login has a live employment in the cycle's
-- scope and every such employment is out. A login with no employment in scope is never off by the rule.
CREATE FUNCTION app.onehr_user_unit_excluded_as(wanted_cycle uuid, wanted_user uuid, extra_company uuid, extra_department uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH live AS (
  SELECT e.id,c.id AS cycle_id FROM app_user u JOIN employment e ON e.person_id=u.person_id AND e.tenant_id=u.tenant_id
  JOIN review_cycle c ON c.id=wanted_cycle AND c.tenant_id=u.tenant_id
  WHERE u.id=wanted_user AND u.tenant_id=app.current_tenant_id()
   AND (e.terminated_on IS NULL OR e.terminated_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
   AND (c.company_id IS NULL OR e.company_id=c.company_id))
 SELECT EXISTS(SELECT 1 FROM live) AND NOT EXISTS(SELECT 1 FROM live WHERE NOT app.assessment_unit_excluded_as(live.cycle_id,live.id,extra_company,extra_department))
$$;
--> statement-breakpoint
CREATE FUNCTION app.onehr_user_unit_excluded(wanted_cycle uuid, wanted_user uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT app.onehr_user_unit_excluded_as(wanted_cycle,wanted_user,NULL,NULL)
$$;
--> statement-breakpoint
-- THE walk (D6), shared by the runtime reviewer, the preview and the KPI line move: the nearest manager above
-- wanted_from on the live administrative line who takes part, at most six managers up. It stops (NULL) at a
-- missing line, a terminated manager or stop_person (the subject). "An administrator intermediate" has no
-- employment-level meaning in AI-HR (grants are not employment attributes) and is not a stop (O3).
CREATE FUNCTION app.onehr_unit_step_up(wanted_cycle uuid, wanted_from uuid, stop_person uuid, extra_company uuid, extra_department uuid) RETURNS uuid
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE today date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date; cur uuid:=wanted_from; nxt employment;
BEGIN
 FOR depth IN 1..6 LOOP
  nxt:=NULL;
  SELECT m.* INTO nxt FROM reporting_line l JOIN employment m ON m.id=l.manager_employment_id AND m.tenant_id=l.tenant_id
   WHERE l.tenant_id=app.current_tenant_id() AND l.subordinate_employment_id=cur AND l.line_type='administrative' AND l.superseded_at IS NULL
    AND l.valid_from<=today AND (l.valid_to IS NULL OR l.valid_to>today)
   ORDER BY l.valid_from DESC,l.id LIMIT 1;
  IF nxt.id IS NULL OR nxt.terminated_on IS NOT NULL AND nxt.terminated_on<=today OR nxt.person_id IS NOT DISTINCT FROM stop_person THEN RETURN NULL; END IF;
  IF NOT app.assessment_unit_excluded_as(wanted_cycle,nxt.id,extra_company,extra_department) THEN RETURN nxt.id; END IF;
  cur:=nxt.id;
 END LOOP;
 RETURN NULL;
END $$;
--> statement-breakpoint
-- The employment that reviews competencies and the Career Plan today: the stored reviewer while it takes
-- part, else the walk above it (never past the subject). NULL when nobody qualifies.
CREATE FUNCTION app.onehr_effective_reviewer_of_as(wanted_review uuid, extra_company uuid, extra_department uuid) RETURNS uuid
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT CASE WHEN m.id IS NULL OR m.terminated_on IS NOT NULL AND m.terminated_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date THEN NULL
  WHEN NOT app.assessment_unit_excluded_as(r.cycle_id,m.id,extra_company,extra_department) THEN m.id
  ELSE app.onehr_unit_step_up(r.cycle_id,m.id,s.person_id,extra_company,extra_department) END
 FROM performance_review r JOIN employment s ON s.id=r.employment_id AND s.tenant_id=r.tenant_id
 LEFT JOIN employment m ON m.id=r.reviewer_employment_id AND m.tenant_id=r.tenant_id
 WHERE r.id=wanted_review AND r.tenant_id=app.current_tenant_id()
$$;
--> statement-breakpoint
CREATE FUNCTION app.onehr_effective_reviewer_of(wanted_review uuid) RETURNS uuid
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT app.onehr_effective_reviewer_of_as(wanted_review,NULL,NULL)
$$;
--> statement-breakpoint
-- Public: the caller holds the effective reviewer employment. With no active rule in the cycle it is exactly
-- app.onehr_manager (same login, person, archive, block and termination conditions on the stored reviewer).
CREATE FUNCTION app.onehr_effective_reviewer(wanted_review uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM performance_review r
  JOIN employment s ON s.id=r.employment_id AND s.tenant_id=r.tenant_id
  JOIN employment m ON m.id=app.onehr_effective_reviewer_of(r.id) AND m.tenant_id=r.tenant_id
  JOIN app_user u ON u.person_id=m.person_id AND u.tenant_id=m.tenant_id
  WHERE r.id=wanted_review AND r.tenant_id=app.current_tenant_id() AND u.id=app.current_user_id()
   AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND m.person_id<>s.person_id
   AND (m.terminated_on IS NULL OR m.terminated_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date))
$$;
--> statement-breakpoint
-- Public, narrow: the effective reviewer's employment for the reminder dispatcher and cycle administrators.
CREATE FUNCTION app.onehr_effective_reviewer_employment(wanted_review uuid) RETURNS uuid
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT app.onehr_effective_reviewer_of(r.id) FROM performance_review r
 WHERE r.id=wanted_review AND r.tenant_id=app.current_tenant_id() AND (app.assessment_dispatcher_scope() OR app.onehr_cycle_admin(r.cycle_id))
$$;
--> statement-breakpoint
-- Public, narrow: is the employment out of the cycle by the unit rule? For cycle administrators and the
-- dispatcher (participants list, panel builder, exports); false for anyone else.
CREATE FUNCTION app.assessment_unit_out(wanted_cycle uuid, wanted_employment uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT (app.assessment_dispatcher_scope() OR app.onehr_cycle_admin(wanted_cycle)) AND app.assessment_unit_excluded(wanted_cycle,wanted_employment)
$$;
--> statement-breakpoint
-- Public, narrow: is the review's stored reviewer out by the unit rule? For anyone who can open the review (the
-- completing lock stores the band only then, O1) and for the stored reviewer's own login (its task projection).
CREATE FUNCTION app.onehr_reviewer_unit_out(wanted_review uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM performance_review r WHERE r.id=wanted_review AND r.tenant_id=app.current_tenant_id() AND r.reviewer_employment_id IS NOT NULL
  AND (app.onehr_review_header(r.id) IS NOT NULL OR app.onehr_own_employment(r.reviewer_employment_id))
  AND app.assessment_unit_excluded(r.cycle_id,r.reviewer_employment_id))
$$;
--> statement-breakpoint
-- Public, narrow: the kernel review queue's rows for the reviews the caller now reviews one level up (competency
-- and Career Plan work, D5) because the stored reviewer's unit is out, for a subject who takes part. Only open OneHR
-- cycles with an active rule are read. The kernel queue drops the stored reviewer's own row through
-- app.onehr_reviewer_unit_out; neither reads the rule table itself (ADR-0080).
CREATE FUNCTION app.onehr_effective_review_queue()
 RETURNS TABLE(review_id uuid, employee text, employee_code text, cycle_name text, status text, company_id uuid, created_at timestamptz)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT r.id,p.full_name,e.employee_code,c.name,r.status::text,e.company_id,r.created_at
 FROM review_cycle c JOIN performance_onehr_cycle cfg ON cfg.cycle_id=c.id AND cfg.tenant_id=c.tenant_id
 JOIN performance_review r ON r.cycle_id=c.id AND r.tenant_id=c.tenant_id
 JOIN employment e ON e.id=r.employment_id AND e.tenant_id=r.tenant_id
 JOIN person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
 WHERE c.tenant_id=app.current_tenant_id() AND c.status='open' AND r.status::text IN ('manager_review','self_review')
  AND EXISTS(SELECT 1 FROM performance_assessment_unit_exclusion x WHERE x.tenant_id=c.tenant_id AND x.cycle_id=c.id AND x.ended_at IS NULL)
  AND r.reviewer_employment_id IS NOT NULL AND app.assessment_unit_excluded(c.id,r.reviewer_employment_id)
  AND app.onehr_effective_reviewer(r.id) AND app.assessment_review_participates(r.id)
 ORDER BY c.name,p.full_name,r.id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.assessment_unit_placement(uuid),app.assessment_unit_scope_matches(uuid,uuid,uuid),app.assessment_unit_excluded_as(uuid,uuid,uuid,uuid),
 app.assessment_unit_excluded(uuid,uuid),app.onehr_user_unit_excluded_as(uuid,uuid,uuid,uuid),app.onehr_user_unit_excluded(uuid,uuid),
 app.onehr_unit_step_up(uuid,uuid,uuid,uuid,uuid),app.onehr_effective_reviewer_of_as(uuid,uuid,uuid),app.onehr_effective_reviewer_of(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.onehr_effective_reviewer(uuid),app.onehr_effective_reviewer_employment(uuid),app.assessment_unit_out(uuid,uuid),app.onehr_reviewer_unit_out(uuid),app.onehr_effective_review_queue() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.onehr_effective_reviewer(uuid),app.onehr_effective_reviewer_employment(uuid),app.assessment_unit_out(uuid,uuid),app.onehr_reviewer_unit_out(uuid),app.onehr_effective_review_queue() TO ai_hr_app;
--> statement-breakpoint

-- ── 6. Pin at close (D8), called by the pack's closure hook inside the close transaction ────────────────
CREATE FUNCTION app.assessment_unit_exclusion_pin(wanted_cycle uuid) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c review_cycle; pinned integer;
BEGIN
 SELECT * INTO c FROM review_cycle WHERE id=wanted_cycle AND tenant_id=app.current_tenant_id();
 IF c.id IS NULL OR NOT app.onehr_cycle_admin(c.id) THEN RAISE EXCEPTION 'Performance administrator access is required' USING ERRCODE='42501'; END IF;
 IF c.status NOT IN ('open','calibration') THEN RETURN 0; END IF;
 INSERT INTO performance_assessment_unit_exclusion_pin(tenant_id,cycle_id,employment_id,rule_id,pinned_on)
  SELECT DISTINCT ON (e.id) c.tenant_id,c.id,e.id,x.id,(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
  FROM performance_assessment_unit_exclusion x
  JOIN employment e ON e.tenant_id=x.tenant_id AND (e.company_id=x.company_id OR EXISTS(SELECT 1 FROM assignment a WHERE a.employment_id=e.id AND a.tenant_id=e.tenant_id AND a.company_id=x.company_id))
  CROSS JOIN LATERAL app.assessment_unit_placement(e.id) pl
  WHERE x.tenant_id=c.tenant_id AND x.cycle_id=c.id AND x.ended_at IS NULL
   AND x.company_id=pl.company_id AND (x.department_id IS NULL OR x.department_id=pl.department_id)
  ORDER BY e.id,x.department_id NULLS FIRST,x.id
 ON CONFLICT (cycle_id,employment_id) DO NOTHING;
 GET DIAGNOSTICS pinned=ROW_COUNT;
 RETURN pinned;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.assessment_unit_exclusion_pin(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.assessment_unit_exclusion_pin(uuid) TO ai_hr_app;
--> statement-breakpoint

-- ── 7. The plan facts: ONE projection behind both the preview and the save ─────────────────────────────
-- Everything the save will do, computed with the proposed scope added to the active rules (the extras of the
-- *_as helpers), before any write. Identifiers and booleans only; names are the caller's own projection.
-- For a cycle administrator who also administers the proposed company; NULL for anyone else.
CREATE FUNCTION app.assessment_unit_exclusion_facts(wanted_cycle uuid, wanted_company uuid, wanted_department uuid) RETURNS jsonb
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH today AS (SELECT (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS d),
 cyc AS MATERIALIZED (
  SELECT c.id,c.tenant_id,c.status,c.company_id,cfg.revision
  FROM review_cycle c JOIN performance_onehr_cycle cfg ON cfg.cycle_id=c.id AND cfg.tenant_id=c.tenant_id
  WHERE c.id=wanted_cycle AND c.tenant_id=app.current_tenant_id() AND wanted_company IS NOT NULL
   AND app.onehr_cycle_admin(c.id) AND app.onehr_admin(wanted_company)
 ), reviews AS MATERIALIZED (
  SELECT r.review_id,r.tenant_id,r.employment_id,r.kpis,r.grade,s.person_id,pr.reviewer_employment_id,
   (pr.closed_at IS NOT NULL OR EXISTS(SELECT 1 FROM performance_onehr_result f WHERE f.review_id=r.review_id AND f.tenant_id=r.tenant_id)) AS frozen,
   app.assessment_unit_scope_matches(r.employment_id,wanted_company,wanted_department) AS in_scope,
   app.assessment_unit_excluded_as(c.id,r.employment_id,NULL,NULL) AS excluded_before,
   app.assessment_unit_excluded_as(c.id,r.employment_id,wanted_company,wanted_department) AS excluded_after
  FROM cyc c JOIN performance_onehr_review r ON r.cycle_id=c.id AND r.tenant_id=c.tenant_id
  JOIN performance_review pr ON pr.id=r.review_id AND pr.tenant_id=r.tenant_id
  JOIN employment s ON s.id=r.employment_id AND s.tenant_id=r.tenant_id
 ), panels AS MATERIALIZED (
  SELECT a.request_id,a.review_id,a.subject_employment_id,a.peer_employment_id,a.submitted_at IS NOT NULL AS submitted,rv.frozen,rv.in_scope AS subject_in_scope,
   app.assessment_unit_scope_matches(a.peer_employment_id,wanted_company,wanted_department) AS rater_in_scope
  FROM reviews rv JOIN performance_onehr_panel a ON a.review_id=rv.review_id AND a.tenant_id=rv.tenant_id
  WHERE a.archived_at IS NULL
 ), lines AS MATERIALIZED (
  SELECT rv.review_id,rv.employment_id,rv.person_id,rv.excluded_after AS subject_excluded,k->>'id' AS kpi_id,
   coalesce((k->>'hrOwned')::boolean,false) AS hr_owned,coalesce((k->>'locked')::boolean,false) AS locked,
   EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(k->'approvalChain','[]'::jsonb)) st WHERE st->>'at' IS NOT NULL) AS acted,
   CASE WHEN jsonb_array_length(coalesce(k->'approvalChain','[]'::jsonb))>0
    THEN ARRAY(SELECT (st->>'employmentId')::uuid FROM jsonb_array_elements(k->'approvalChain') WITH ORDINALITY q(st,i) ORDER BY i)
    WHEN k->>'moderatorEmploymentId' IS NOT NULL THEN ARRAY[(k->>'moderatorEmploymentId')::uuid] ELSE '{}'::uuid[] END AS approvers
  FROM reviews rv CROSS JOIN LATERAL jsonb_array_elements(rv.kpis) kk(k)
  WHERE NOT rv.frozen
 ), touched AS MATERIALIZED (
  SELECT l.* FROM lines l WHERE EXISTS(SELECT 1 FROM unnest(l.approvers) ap(id) WHERE app.assessment_unit_scope_matches(ap.id,wanted_company,wanted_department))
 )
 SELECT jsonb_build_object(
  'cycle',jsonb_build_object('id',c.id,'status',c.status,'companyId',c.company_id,'revision',c.revision),
  'scope',jsonb_build_object('companyId',wanted_company,'departmentId',wanted_department,
   'companyExists',EXISTS(SELECT 1 FROM company co WHERE co.id=wanted_company AND co.tenant_id=c.tenant_id),
   'companyInCycle',c.company_id IS NULL OR c.company_id=wanted_company,
   'departmentInCompany',wanted_department IS NULL OR EXISTS(SELECT 1 FROM department d WHERE d.id=wanted_department AND d.tenant_id=c.tenant_id AND d.company_id=wanted_company),
   'headcount',(SELECT count(*) FROM employment e CROSS JOIN today WHERE e.tenant_id=c.tenant_id AND (e.terminated_on IS NULL OR e.terminated_on>today.d)
    AND app.assessment_unit_scope_matches(e.id,wanted_company,wanted_department))),
  'activeRules',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',x.id,'companyId',x.company_id,'departmentId',x.department_id) ORDER BY x.id),'[]'::jsonb)
   FROM performance_assessment_unit_exclusion x WHERE x.tenant_id=c.tenant_id AND x.cycle_id=c.id AND x.ended_at IS NULL),
  'people',(SELECT coalesce(jsonb_agg(jsonb_build_object('reviewId',rv.review_id,'employmentId',rv.employment_id,'frozen',rv.frozen,'excludedBefore',rv.excluded_before) ORDER BY rv.employment_id,rv.review_id),'[]'::jsonb)
   FROM reviews rv WHERE rv.in_scope),
  'panels',(SELECT coalesce(jsonb_agg(jsonb_build_object('requestId',p.request_id,'reviewId',p.review_id,'subjectEmploymentId',p.subject_employment_id,'raterEmploymentId',p.peer_employment_id,
    'submitted',p.submitted,'frozen',p.frozen,'subjectInScope',p.subject_in_scope,'raterInScope',p.rater_in_scope) ORDER BY p.review_id,p.request_id),'[]'::jsonb)
   FROM panels p WHERE p.subject_in_scope OR p.rater_in_scope),
  'panelSubjects',(SELECT coalesce(jsonb_agg(jsonb_build_object('reviewId',rv.review_id,'grade',rv.grade,'live',(SELECT count(*) FROM panels p2 WHERE p2.review_id=rv.review_id)) ORDER BY rv.review_id),'[]'::jsonb)
   FROM reviews rv WHERE NOT rv.in_scope AND NOT rv.frozen AND EXISTS(SELECT 1 FROM panels p WHERE p.review_id=rv.review_id AND p.rater_in_scope)),
  'kpiLines',(SELECT coalesce(jsonb_agg(jsonb_build_object('reviewId',t.review_id,'kpiId',t.kpi_id,'subjectEmploymentId',t.employment_id,'subjectExcluded',t.subject_excluded,
    'hrOwned',t.hr_owned,'locked',t.locked,'acted',t.acted,
    'approvers',(SELECT coalesce(jsonb_agg(jsonb_build_object('employmentId',ap.id,'inScope',app.assessment_unit_scope_matches(ap.id,wanted_company,wanted_department),
      'excluded',app.assessment_unit_excluded_as(c.id,ap.id,wanted_company,wanted_department),
      'stepUp',CASE WHEN app.assessment_unit_excluded_as(c.id,ap.id,wanted_company,wanted_department) THEN app.onehr_unit_step_up(c.id,ap.id,t.person_id,wanted_company,wanted_department) END) ORDER BY ap.ord),'[]'::jsonb)
     FROM unnest(t.approvers) WITH ORDINALITY ap(id,ord))) ORDER BY t.review_id,t.kpi_id),'[]'::jsonb)
   FROM touched t),
  'oneLevelUp',(SELECT coalesce(jsonb_agg(jsonb_build_object('reviewId',rv.review_id,'employmentId',rv.employment_id,'storedReviewerId',rv.reviewer_employment_id,
    'storedInScope',app.assessment_unit_scope_matches(rv.reviewer_employment_id,wanted_company,wanted_department),'frozen',rv.frozen,'subjectExcluded',rv.excluded_after,
    'before',app.onehr_effective_reviewer_of_as(rv.review_id,NULL,NULL),'after',app.onehr_effective_reviewer_of_as(rv.review_id,wanted_company,wanted_department)) ORDER BY rv.review_id),'[]'::jsonb)
   FROM reviews rv WHERE rv.reviewer_employment_id IS NOT NULL AND app.assessment_unit_excluded_as(c.id,rv.reviewer_employment_id,wanted_company,wanted_department)),
  'hodOut',(SELECT coalesce(jsonb_agg(jsonb_build_object('subjectEmploymentId',h.subject_employment_id,'hodEmploymentId',h.hod_employment_id) ORDER BY h.subject_employment_id,h.id),'[]'::jsonb)
   FROM reviews rv CROSS JOIN today JOIN performance_hod_assignment h ON h.tenant_id=rv.tenant_id AND h.subject_employment_id=rv.employment_id
    AND h.valid_from<=today.d AND (h.valid_to IS NULL OR h.valid_to>today.d)
   WHERE NOT rv.excluded_after AND app.assessment_unit_scope_matches(h.hod_employment_id,wanted_company,wanted_department)),
  'hodSessionsOut',(SELECT coalesce(jsonb_agg(jsonb_build_object('sessionId',s.id,'anchorEmploymentId',s.anchor_employment_id) ORDER BY s.id),'[]'::jsonb)
   FROM performance_onehr_calibration s WHERE s.cycle_id=c.id AND s.tenant_id=c.tenant_id AND s.anchor_kind='hod'
    AND app.assessment_unit_scope_matches(s.anchor_employment_id,wanted_company,wanted_department)),
  'seatsOut',(SELECT coalesce(jsonb_agg(jsonb_build_object('seatId',st.id,'seatType',st.seat_type,'holderEmploymentId',st.holder_employment_id) ORDER BY st.id),'[]'::jsonb)
   FROM performance_leader_seat st CROSS JOIN today WHERE st.tenant_id=c.tenant_id AND st.valid_from<=today.d AND (st.valid_to IS NULL OR st.valid_to>today.d)
    AND app.assessment_unit_scope_matches(st.holder_employment_id,wanted_company,wanted_department)),
  'sessionReviewersOut',(SELECT coalesce(jsonb_agg(jsonb_build_object('sessionId',s.id,'userId',ru.uid) ORDER BY s.id,ru.uid),'[]'::jsonb)
   FROM performance_onehr_calibration s CROSS JOIN LATERAL unnest(s.reviewer_user_ids) ru(uid)
   WHERE s.cycle_id=c.id AND s.tenant_id=c.tenant_id AND s.tier<>'final'
    AND app.onehr_user_unit_excluded_as(c.id,ru.uid,wanted_company,wanted_department) AND NOT app.onehr_user_unit_excluded_as(c.id,ru.uid,NULL,NULL))
 ) FROM cyc c
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.assessment_unit_exclusion_facts(uuid,uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.assessment_unit_exclusion_facts(uuid,uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
-- Retained-history boolean for company deletion (core/company-refs.ts): a rule on the company or its department.
CREATE FUNCTION app.assessment_unit_exclusion_company_in_use(wanted_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.is_admin_for(wanted_company) AND EXISTS(SELECT 1 FROM public.performance_assessment_unit_exclusion x
  WHERE x.tenant_id=app.current_tenant_id() AND (x.company_id=wanted_company
   OR EXISTS(SELECT 1 FROM public.department d WHERE d.id=x.department_id AND d.tenant_id=x.tenant_id AND d.company_id=wanted_company)));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.assessment_unit_exclusion_company_in_use(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.assessment_unit_exclusion_company_in_use(uuid) TO ai_hr_app;
--> statement-breakpoint

-- ── 8. X1: the subject arm (restatements) ──────────────────────────────────────────────────────────────
-- Restates app.assessment_review_participates (latest: 0540:40-50): the unit-rule arm after the terminated arm (frozen results exempt, D7); the access arm admits the effective reviewer.
-- Fast path (plan R2): a cycle with no active rule and no close-time pin (two index probes, inline) excludes nobody, and
-- there the effective reviewer is exactly app.onehr_manager, so neither nested call is made. PostgreSQL re-plans a nested
-- SQL function on every call of its caller; these calls run per calibration row and made the BG board read ~1.5x slower.
CREATE OR REPLACE FUNCTION app.assessment_review_participates(wanted_review uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM performance_review r JOIN review_cycle c ON c.id=r.cycle_id AND c.tenant_id=r.tenant_id
  JOIN employment e ON e.id=r.employment_id AND e.tenant_id=r.tenant_id
  JOIN performance_assessment_participation p ON p.cycle_id=r.cycle_id AND p.employment_id=r.employment_id AND p.tenant_id=r.tenant_id
  WHERE r.id=wanted_review AND r.tenant_id=app.current_tenant_id()
   AND (c.status='closed' OR e.terminated_on IS NULL OR e.terminated_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
   AND (NOT (EXISTS(SELECT 1 FROM performance_assessment_unit_exclusion x WHERE x.tenant_id=r.tenant_id AND x.cycle_id=r.cycle_id AND x.ended_at IS NULL) OR EXISTS(SELECT 1 FROM performance_assessment_unit_exclusion_pin xp WHERE xp.tenant_id=r.tenant_id AND xp.cycle_id=r.cycle_id))
    OR NOT app.assessment_unit_excluded(r.cycle_id,r.employment_id) OR EXISTS(SELECT 1 FROM performance_onehr_result f WHERE f.review_id=r.id AND f.tenant_id=r.tenant_id))
   AND CASE WHEN p.override='add' THEN true WHEN p.override='remove' THEN false ELSE p.eligible_at_open END
   AND (app.assessment_dispatcher_scope() OR app.can_see_employment(e.id) OR app.onehr_cycle_admin(r.cycle_id) OR app.onehr_manager(r.id)
    OR (EXISTS(SELECT 1 FROM performance_assessment_unit_exclusion x WHERE x.tenant_id=r.tenant_id AND x.cycle_id=r.cycle_id AND x.ended_at IS NULL) OR EXISTS(SELECT 1 FROM performance_assessment_unit_exclusion_pin xp WHERE xp.tenant_id=r.tenant_id AND xp.cycle_id=r.cycle_id)) AND app.onehr_effective_reviewer(r.id)
    OR app.onehr_moderator(r.id)
    OR EXISTS(SELECT 1 FROM performance_onehr_panel panel JOIN employment peer ON peer.id=panel.peer_employment_id AND peer.tenant_id=panel.tenant_id JOIN app_user actor ON actor.person_id=peer.person_id AND actor.tenant_id=peer.tenant_id WHERE panel.review_id=r.id AND panel.tenant_id=r.tenant_id AND panel.archived_at IS NULL AND actor.id=app.current_user_id() AND actor.archived_at IS NULL AND NOT app.login_blocked(actor.id) AND (peer.terminated_on IS NULL OR peer.terminated_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date))
    OR EXISTS(SELECT 1 FROM performance_onehr_calibration_entry ce WHERE ce.review_id=r.id AND ce.tenant_id=r.tenant_id AND app.onehr_calibration_access(ce.session_id))))
$$;
--> statement-breakpoint
-- Restates app.assessment_review_eligible (latest: 0664:24-31): the same unit-rule arm as app.assessment_review_participates (excluded people leave the HOD department view).
CREATE OR REPLACE FUNCTION app.assessment_review_eligible(wanted_review uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM performance_review r JOIN review_cycle c ON c.id=r.cycle_id AND c.tenant_id=r.tenant_id
  JOIN employment e ON e.id=r.employment_id AND e.tenant_id=r.tenant_id
  JOIN performance_assessment_participation p ON p.cycle_id=r.cycle_id AND p.employment_id=r.employment_id AND p.tenant_id=r.tenant_id
  WHERE r.id=wanted_review AND r.tenant_id=app.current_tenant_id()
   AND (c.status='closed' OR e.terminated_on IS NULL OR e.terminated_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
   AND (NOT app.assessment_unit_excluded(r.cycle_id,r.employment_id) OR EXISTS(SELECT 1 FROM performance_onehr_result f WHERE f.review_id=r.id AND f.tenant_id=r.tenant_id))
   AND CASE WHEN p.override='add' THEN true WHEN p.override='remove' THEN false ELSE p.eligible_at_open END)
$$;
--> statement-breakpoint

-- ── 9. X2: leader-off and one level up (restatements) ──────────────────────────────────────────────────
-- Restates app.onehr_manager (latest: 0529:22-24): leader-off: the stored reviewer is not out by the unit rule. Nothing else (amended D5).
CREATE OR REPLACE FUNCTION app.onehr_manager(wanted_review uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM performance_review r JOIN employment e ON e.id=r.reviewer_employment_id AND e.tenant_id=r.tenant_id JOIN employment s ON s.id=r.employment_id AND s.tenant_id=r.tenant_id JOIN app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id WHERE r.id=wanted_review AND r.tenant_id=app.current_tenant_id() AND u.id=app.current_user_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND e.person_id<>s.person_id AND (e.terminated_on IS NULL OR e.terminated_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) AND NOT app.assessment_unit_excluded(r.cycle_id,e.id))
$$;
--> statement-breakpoint
-- Restates app.onehr_moderator (latest: 0540:345-348): leader-off per acting step employment (D9).
CREATE OR REPLACE FUNCTION app.onehr_moderator(wanted_review uuid,wanted_kpi uuid DEFAULT NULL) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM performance_onehr_review r JOIN performance_review pr ON pr.id=r.review_id JOIN employment sub ON sub.id=r.employment_id JOIN app_user u ON u.id=app.current_user_id() AND u.tenant_id=r.tenant_id CROSS JOIN LATERAL jsonb_array_elements(r.kpis) k CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_array_length(coalesce(k->'approvalChain','[]'::jsonb))>0 THEN k->'approvalChain' ELSE jsonb_build_array(jsonb_build_object('employmentId',k->>'moderatorEmploymentId','at',NULL)) END) WITH ORDINALITY step(v,idx) JOIN employment m ON m.id=(step.v->>'employmentId')::uuid AND m.tenant_id=r.tenant_id AND m.person_id=u.person_id
 WHERE r.review_id=wanted_review AND r.tenant_id=app.current_tenant_id() AND (wanted_kpi IS NULL OR k->>'id'=wanted_kpi::text AND coalesce((k->>'locked')::boolean,false)=false AND step.v->>'at' IS NULL AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(k->'approvalChain','[]'::jsonb)) WITH ORDINALITY earlier(v,idx) WHERE earlier.idx<step.idx AND earlier.v->>'at' IS NULL)) AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND sub.person_id<>m.person_id AND NOT app.assessment_unit_excluded(r.cycle_id,m.id) AND (m.terminated_on IS NULL OR m.terminated_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) AND (k->>'moderatorSource'='matrix' OR m.id=pr.reviewer_employment_id OR EXISTS(SELECT 1 FROM reporting_line l WHERE l.subordinate_employment_id=sub.id AND l.manager_employment_id=m.id AND l.line_type IN ('functional','project','dotted') AND l.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (l.valid_to IS NULL OR l.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) AND l.superseded_at IS NULL)))
$$;
--> statement-breakpoint
-- Restates app.onehr_review_header (latest: 0529:33-36): the effective (one-level-up) reviewer opens the review; reviewerEmploymentId stays the stored reviewer.
CREATE OR REPLACE FUNCTION app.onehr_review_header(wanted_review uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('reviewerEmploymentId',r.reviewer_employment_id,'closedAt',r.closed_at,'name',p.full_name,'ownEmploymentIds',(SELECT coalesce(jsonb_agg(e.id),'[]'::jsonb) FROM employment e WHERE e.person_id=u.person_id AND e.tenant_id=u.tenant_id))
 FROM performance_review r JOIN employment e ON e.id=r.employment_id AND e.tenant_id=r.tenant_id JOIN person p ON p.id=e.person_id JOIN app_user u ON u.id=app.current_user_id() AND u.tenant_id=r.tenant_id WHERE r.id=wanted_review AND r.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND (app.is_self_person(e.person_id) OR app.onehr_manager(r.id) OR app.onehr_effective_reviewer(r.id) OR app.onehr_cycle_admin(r.cycle_id) OR app.onehr_moderator(r.id))
$$;
--> statement-breakpoint
-- Restates app.assessment_plan_reviewer (latest: 0540:355-357): Career Plan review moves one level up: the effective reviewer replaces onehr_manager.
CREATE OR REPLACE FUNCTION app.assessment_plan_reviewer(wanted_plan uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM performance_onehr_plan p JOIN performance_onehr_review r ON r.employment_id=p.employment_id AND r.tenant_id=p.tenant_id JOIN review_cycle c ON c.id=r.cycle_id JOIN performance_onehr_cycle cfg ON cfg.cycle_id=c.id WHERE p.id=wanted_plan AND p.tenant_id=app.current_tenant_id() AND p.plan_year=extract(year from c.period_end)::integer+CASE WHEN cfg.policy->>'kind'='year_end' THEN 1 ELSE 0 END AND (app.onehr_effective_reviewer(r.review_id) OR app.onehr_moderator(r.review_id)))
$$;
--> statement-breakpoint
-- Restates app.assessment_plan_remark_writer (latest: 0540:642-649): while the stored reviewer is out, any moderator or the effective reviewer writes the overall plan remark; unchanged with no rule.
CREATE OR REPLACE FUNCTION app.assessment_plan_remark_writer(wanted_review uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM performance_onehr_review r JOIN performance_review pr ON pr.id=r.review_id AND pr.tenant_id=r.tenant_id
 LEFT JOIN employment m ON m.id=pr.reviewer_employment_id AND m.tenant_id=r.tenant_id
 WHERE r.review_id=wanted_review AND r.tenant_id=app.current_tenant_id() AND (app.onehr_moderator(r.review_id) OR app.onehr_effective_reviewer(r.review_id) AND (NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.kpis) k WHERE NOT coalesce((k->>'hrOwned')::boolean,false)) OR app.assessment_unit_excluded(r.cycle_id,m.id)))
 AND (app.onehr_manager(r.review_id) OR app.assessment_unit_excluded(r.cycle_id,m.id) OR m.id IS NULL OR m.terminated_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date OR NOT EXISTS(SELECT 1 FROM app_user u WHERE u.person_id=m.person_id AND u.tenant_id=r.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) OR NOT EXISTS(
  SELECT 1 FROM jsonb_array_elements(r.kpis) k WHERE NOT coalesce((k->>'hrOwned')::boolean,false) AND (k->>'moderatorEmploymentId'=m.id::text OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(k->'approvalChain','[]'::jsonb)) step WHERE step->>'employmentId'=m.id::text))
 )))
$$;
--> statement-breakpoint
-- Restates app.assessment_career_access (latest: 0540:523-526): the effective reviewer replaces onehr_manager (career profile is part of the Career Plan review).
CREATE OR REPLACE FUNCTION app.assessment_career_access(wanted_employment uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM employment e WHERE e.id=wanted_employment AND e.tenant_id=app.current_tenant_id() AND
 (app.is_self_person(e.person_id) OR app.onehr_admin(e.company_id) OR EXISTS(SELECT 1 FROM performance_onehr_review r JOIN review_cycle c ON c.id=r.cycle_id WHERE r.employment_id=e.id AND r.tenant_id=e.tenant_id AND c.status IN ('open','calibration') AND (app.onehr_effective_reviewer(r.review_id) OR app.onehr_moderator(r.review_id)))))
$$;
--> statement-breakpoint
-- Restates app.assessment_career_validate (latest: 0540:527-549): the placeholder and comment arms admit the effective reviewer instead of onehr_manager.
CREATE OR REPLACE FUNCTION app.assessment_career_validate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r performance_onehr_review; c review_cycle; yr integer; own boolean; administrator boolean; manager_placeholder boolean;
BEGIN
 SELECT * INTO r FROM performance_onehr_review WHERE review_id=NEW.review_id AND tenant_id=NEW.tenant_id AND employment_id=NEW.employment_id;
 IF r.review_id IS NULL THEN RAISE EXCEPTION 'Invalid career profile reference'; END IF;
 IF TG_OP='UPDATE' AND (NEW.employment_id<>OLD.employment_id OR NEW.tenant_id<>OLD.tenant_id) THEN RAISE EXCEPTION 'Career profile identity is immutable'; END IF;
 SELECT * INTO c FROM review_cycle WHERE id=r.cycle_id;
 own:=EXISTS(SELECT 1 FROM employment e WHERE e.id=NEW.employment_id AND app.is_self_person(e.person_id));
 administrator:=NOT own AND app.onehr_cycle_admin(r.cycle_id) AND EXISTS(SELECT 1 FROM employment e WHERE e.id=NEW.employment_id AND e.tenant_id=NEW.tenant_id AND app.onehr_admin(e.company_id));
 manager_placeholder:=TG_OP='INSERT' AND NOT own AND (app.onehr_effective_reviewer(r.review_id) OR app.onehr_moderator(r.review_id)) AND NEW.career=jsonb_build_object('aspiration','','mobility',NULL,'mobilityNote','','targetProfileId',NULL,'selfProfileId',NULL);
 IF c.status NOT IN ('open','calibration') AND NOT administrator THEN RAISE EXCEPTION 'This career period is read-only'; END IF;
 IF (TG_OP='INSERT' OR NEW.career IS DISTINCT FROM OLD.career) AND NOT manager_placeholder AND NOT administrator THEN
  IF NOT own THEN RAISE EXCEPTION 'Only the employee may change their career aspirations'; END IF;
  SELECT extract(year from c.period_end)::integer+CASE WHEN policy->>'kind'='year_end' THEN 1 ELSE 0 END INTO yr FROM performance_onehr_cycle WHERE cycle_id=c.id;
  IF TG_OP='UPDATE' AND nullif(btrim(OLD.career->>'mobility'),'') IS NOT NULL AND
   (nullif(btrim(OLD.career->>'aspiration'),'') IS NOT NULL OR nullif(btrim(OLD.career->>'aspirationNow'),'') IS NOT NULL OR nullif(btrim(OLD.career->>'aspirationLong'),'') IS NOT NULL)
   AND EXISTS(SELECT 1 FROM performance_onehr_plan p WHERE p.employment_id=NEW.employment_id AND p.plan_year=yr AND p.status<>'draft') THEN RAISE EXCEPTION 'The shared career plan is locked'; END IF;
 END IF;
 IF TG_OP='UPDATE' AND (NEW.manager_comment IS DISTINCT FROM OLD.manager_comment OR NEW.manager_user_id IS DISTINCT FROM OLD.manager_user_id OR NEW.manager_comment_at IS DISTINCT FROM OLD.manager_comment_at) OR TG_OP='INSERT' AND (NEW.manager_comment<>'' OR NEW.manager_user_id IS NOT NULL OR NEW.manager_comment_at IS NOT NULL) THEN
  IF own OR NOT (app.onehr_effective_reviewer(r.review_id) OR app.onehr_moderator(r.review_id)) OR NEW.manager_user_id IS DISTINCT FROM app.current_user_id() THEN RAISE EXCEPTION 'Only the assigned manager may comment on a career profile'; END IF;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
-- Restates app.assessment_competency_sections_validate (latest: 0540:1800-1816): competency review moves one level up: the review sections are submitted by the effective reviewer.
CREATE OR REPLACE FUNCTION app.assessment_competency_sections_validate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE sections jsonb; self_changed boolean; manager_changed boolean;
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.competency_self_sections<>'{}'::jsonb OR NEW.competency_manager_sections<>'{}'::jsonb THEN RAISE EXCEPTION 'New competency sections must start empty'; END IF;RETURN NEW;
 END IF;
 self_changed:=NEW.competency_self_sections IS DISTINCT FROM OLD.competency_self_sections;
 manager_changed:=NEW.competency_manager_sections IS DISTINCT FROM OLD.competency_manager_sections;
 IF NOT self_changed AND NOT manager_changed THEN RETURN NEW; END IF;
 IF NOT EXISTS(SELECT 1 FROM review_cycle c JOIN performance_onehr_cycle cfg ON cfg.cycle_id=c.id AND cfg.tenant_id=c.tenant_id WHERE c.id=NEW.cycle_id AND c.tenant_id=NEW.tenant_id AND c.status IN ('open','calibration') AND coalesce((cfg.policy->'modules'->>'tm')::boolean,false)) OR EXISTS(SELECT 1 FROM performance_onehr_result f WHERE f.review_id=NEW.review_id AND f.tenant_id=NEW.tenant_id) OR NOT app.assessment_review_participates(NEW.review_id) THEN RAISE EXCEPTION 'Competency section remarks are closed'; END IF;
 IF self_changed AND (OLD.competency_status<>'pending' OR NEW.competency_status<>'submitted' OR NOT EXISTS(SELECT 1 FROM employment e WHERE e.id=NEW.employment_id AND e.tenant_id=NEW.tenant_id AND app.is_self_person(e.person_id))) THEN RAISE EXCEPTION 'Only the employee may submit their section remarks'; END IF;
 IF manager_changed AND (OLD.competency_status<>'submitted' OR NEW.competency_status<>'reviewed' OR NOT app.onehr_effective_reviewer(NEW.review_id)) THEN RAISE EXCEPTION 'Only the line manager may submit review section remarks'; END IF;
 FOREACH sections IN ARRAY ARRAY[NEW.competency_self_sections,NEW.competency_manager_sections] LOOP
  IF EXISTS(SELECT 1 FROM jsonb_each(sections) section WHERE jsonb_typeof(section.value)<>'string' OR length(section.value#>>'{}')>4000 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.competencies) c WHERE c->>'principle'=section.key)) THEN RAISE EXCEPTION 'Use only assigned competency section remarks'; END IF;
 END LOOP;
 RETURN NEW;
END $$;
--> statement-breakpoint
-- Restates app.assessment_competency_source (latest: 0540:1626-1634): the competency AI insight follows the effective reviewer.
CREATE OR REPLACE FUNCTION app.assessment_competency_source(wanted_review uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('name',p.full_name,'status',r.competency_status,
  'remark',CASE WHEN r.competency_status IN ('submitted','reviewed') THEN r.competency_self_remark ELSE '' END,
  'competencies',CASE WHEN r.competency_status IN ('submitted','reviewed') THEN coalesce((SELECT jsonb_agg(jsonb_build_object('text',s->>'text','skillTitle',coalesce(s->>'skillTitle',s->>'text'),'principle',s->>'principle','future',(s->>'future')::boolean,'self',s->'self','selfRemark',coalesce(s->>'selfRemark','')) ORDER BY ord) FROM jsonb_array_elements(r.competencies) WITH ORDINALITY q(s,ord)),'[]'::jsonb) ELSE '[]'::jsonb END)
 FROM performance_onehr_review r JOIN performance_onehr_cycle c ON c.cycle_id=r.cycle_id AND c.tenant_id=r.tenant_id
 JOIN employment e ON e.id=r.employment_id AND e.tenant_id=r.tenant_id JOIN person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
 WHERE r.review_id=wanted_review AND r.tenant_id=app.current_tenant_id() AND NOT app.is_self_person(e.person_id)
  AND app.onehr_effective_reviewer(r.review_id) AND app.assessment_review_participates(r.review_id) AND coalesce((c.policy->'modules'->>'tm')::boolean,false)
$$;
--> statement-breakpoint
-- Restates app.assessment_idp_source (latest: 0540:1638-1664): the plan-fit AI follows the effective reviewer; the PM KPI filter keyed on the stored reviewer is unchanged.
CREATE OR REPLACE FUNCTION app.assessment_idp_source(wanted_review uuid,wanted_session uuid DEFAULT NULL) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH scope AS (
 SELECT r.*,c.policy,pr.reviewer_employment_id,p.full_name,
  (wanted_session IS NULL AND app.assessment_plan_remark_writer(r.review_id)) AS mine,app.onehr_effective_reviewer(r.review_id) AS manager,
  extract(year from rc.period_end)::integer+CASE WHEN c.policy->>'kind'='year_end' THEN 1 ELSE 0 END AS plan_year
 FROM performance_onehr_review r JOIN performance_onehr_cycle c ON c.cycle_id=r.cycle_id AND c.tenant_id=r.tenant_id
 JOIN review_cycle rc ON rc.id=r.cycle_id AND rc.tenant_id=r.tenant_id JOIN performance_review pr ON pr.id=r.review_id AND pr.tenant_id=r.tenant_id
 JOIN employment e ON e.id=r.employment_id AND e.tenant_id=r.tenant_id JOIN person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
 WHERE r.review_id=wanted_review AND r.tenant_id=app.current_tenant_id() AND NOT app.is_self_person(e.person_id)
 AND CASE WHEN wanted_session IS NULL THEN app.onehr_effective_reviewer(r.review_id) OR app.onehr_moderator(r.review_id) ELSE coalesce((c.policy->'modules'->>'calibration')::boolean,true) AND EXISTS(SELECT 1 FROM performance_onehr_calibration s JOIN performance_onehr_calibration_entry ce ON ce.session_id=s.id AND ce.tenant_id=s.tenant_id WHERE s.id=wanted_session AND s.cycle_id=r.cycle_id AND s.tenant_id=r.tenant_id AND s.tier='bg' AND ce.review_id=r.review_id AND app.onehr_calibration_access(s.id)) END AND app.assessment_review_participates(r.review_id) AND coalesce((c.policy->'modules'->>'idp')::boolean,false))
 SELECT jsonb_build_object('name',r.full_name,'status',coalesce(plan.status,'none'),'mine',r.mine,'companyId',r.company_id,
  'goals',coalesce((SELECT jsonb_agg(g-ARRAY['managerComment','editedByName','editedAt'] ORDER BY ord) FROM jsonb_array_elements(plan.goals) WITH ORDINALITY a(g,ord)),'[]'::jsonb),
  'career',CASE WHEN plan.id IS NOT NULL THEN coalesce(profile.career,plan.career) ELSE NULL END,
  'bands',jsonb_build_object('aBands',r.policy->'aBands','bBands',r.policy->'bBands','lowMaxPct',r.policy->'lowMaxPct','midMaxPct',r.policy->'midMaxPct'),
  'hasFramework',jsonb_array_length(r.statements)>0,'hasKpis',coalesce((r.policy->'modules'->>'pm')::boolean,false) AND jsonb_array_length(r.kpis)>0,
  'kpis',CASE WHEN plan.id IS NOT NULL AND r.results_submitted_at IS NOT NULL AND coalesce((r.policy->'modules'->>'pm')::boolean,false) THEN coalesce((SELECT jsonb_agg(k ORDER BY ord) FROM jsonb_array_elements(r.kpis) WITH ORDINALITY a(k,ord)
   WHERE coalesce((k->>'hrOwned')::boolean,false) OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_array_length(coalesce(k->'approvalChain','[]'::jsonb))>0 THEN k->'approvalChain' ELSE jsonb_build_array(jsonb_build_object('employmentId',k->>'moderatorEmploymentId')) END) step
    WHERE CASE WHEN r.mine THEN (step->>'employmentId')::uuid IN (SELECT own.id FROM employment own WHERE own.tenant_id=app.current_tenant_id() AND app.is_self_person(own.person_id) AND own.hired_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (own.terminated_on IS NULL OR own.terminated_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)) ELSE step->>'employmentId'=r.reviewer_employment_id::text END)),'[]'::jsonb) ELSE '[]'::jsonb END,
  'editableKpiIds',CASE WHEN r.mine AND plan.id IS NOT NULL THEN coalesce((SELECT jsonb_agg(k->>'id') FROM jsonb_array_elements(r.kpis) k WHERE NOT coalesce((k->>'locked')::boolean,false) AND NOT coalesce((k->>'hrOwned')::boolean,false) AND
    CASE WHEN jsonb_array_length(coalesce(k->'approvalChain','[]'::jsonb))>0 THEN (SELECT (step->>'employmentId')::uuid FROM jsonb_array_elements(k->'approvalChain') WITH ORDINALITY a(step,ord) WHERE step->>'at' IS NULL ORDER BY ord LIMIT 1) ELSE (k->>'moderatorEmploymentId')::uuid END IN (SELECT own.id FROM employment own WHERE own.tenant_id=app.current_tenant_id() AND app.is_self_person(own.person_id) AND own.hired_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (own.terminated_on IS NULL OR own.terminated_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date))),'[]'::jsonb) ELSE '[]'::jsonb END,
  'competencyStatus',r.competency_status,
  'competencies',CASE WHEN plan.id IS NOT NULL AND coalesce((r.policy->'modules'->>'tm')::boolean,false) AND (r.competency_status='reviewed' OR r.mine AND r.manager AND r.competency_status='submitted') THEN r.competencies ELSE '[]'::jsonb END,
  'competencyRemark',CASE WHEN plan.id IS NOT NULL AND coalesce((r.policy->'modules'->>'tm')::boolean,false) AND (r.competency_status='reviewed' OR r.mine AND r.manager AND r.competency_status='submitted') THEN r.competency_self_remark ELSE '' END,
  'drafts',CASE WHEN plan.id IS NOT NULL AND r.mine THEN coalesce((SELECT jsonb_agg(d.payload ORDER BY d.kind) FROM performance_assessment_draft d WHERE d.review_id=r.review_id AND d.context_id=r.review_id AND d.tenant_id=r.tenant_id AND d.actor_user_id=app.current_user_id() AND (d.kind='moderation' OR d.kind='competency_manager' AND r.manager AND r.competency_status='submitted') AND app.assessment_private_access(r.review_id,d.kind,d.context_id)),'[]'::jsonb) ELSE '[]'::jsonb END)
 FROM scope r LEFT JOIN performance_onehr_plan plan ON plan.tenant_id=r.tenant_id AND plan.employment_id=r.employment_id AND plan.plan_year=r.plan_year AND plan.status IN ('shared','closed')
 LEFT JOIN performance_assessment_career_profile profile ON profile.employment_id=r.employment_id AND profile.tenant_id=r.tenant_id
$$;
--> statement-breakpoint
-- Restates app._ai_spend_task_source_allowed (latest: 0651:299-314): the review assistant admits the effective reviewer for competency and career operations only.
CREATE OR REPLACE FUNCTION app._ai_spend_task_source_allowed(feature text,kind text,native_id uuid,operation text)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT app.current_tenant_id() IS NOT NULL AND app.current_user_id() IS NOT NULL AND app.principal_snapshot_current()
 AND EXISTS(SELECT 1 FROM app_user u JOIN tenant t ON t.id=u.tenant_id WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND t.status IN('active','trial'))
 AND CASE
 WHEN feature='hr_assistant' AND kind='assistant_question' AND operation='question' THEN EXISTS(SELECT 1 FROM assistant_grant g WHERE g.tenant_id=app.current_tenant_id() AND g.app_user_id=app.current_user_id() AND g.revoked_at IS NULL)
 WHEN feature='claims_triage' AND kind='claim_request' AND operation='triage' THEN EXISTS(SELECT 1 FROM claim_request q WHERE q.id=native_id AND q.tenant_id=app.current_tenant_id() AND q.status='pending' AND q.employment_id=ANY(app.visible_employment_ids()))
 WHEN feature='payroll_hypotheses' AND kind='payroll_batch' AND operation='hypotheses' THEN EXISTS(SELECT 1 FROM payroll_batch b WHERE b.id=native_id AND b.tenant_id=app.current_tenant_id() AND app.can_admin_payroll_for(b.company_id)
  AND NOT EXISTS(SELECT 1 FROM payslip s WHERE s.batch_id=b.id AND s.tenant_id=b.tenant_id AND app.can_admin_payroll_employment(s.employment_id) IS NOT TRUE))
 WHEN feature='performance_assistant' AND kind='performance_review_message' AND operation~'^([a-f0-9-]{36}:)?(setting|results|moderation|competency|career|evidence):[a-f0-9-]{36}$' THEN EXISTS(SELECT 1 FROM performance_onehr_review r WHERE r.review_id=native_id AND r.tenant_id=app.current_tenant_id()
  AND(app.onehr_manager(r.review_id) OR app.onehr_moderator(r.review_id) OR app.onehr_effective_reviewer(r.review_id) AND operation~'(^|:)(competency|career):' OR EXISTS(SELECT 1 FROM employment e WHERE e.id=r.employment_id AND e.tenant_id=r.tenant_id AND app.is_self_person(e.person_id))))
 WHEN feature='performance_assistant' AND kind='performance_feedback_message' AND operation~'^([a-f0-9-]{36}:)?feedback:[a-f0-9-]{36}$' THEN app.onehr_feedback_card(native_id) IS NOT NULL
 WHEN feature='performance_review' AND kind='performance_guide_request' AND operation='guide' THEN EXISTS(SELECT 1 FROM performance_assessment_guide_use g WHERE g.id=native_id AND g.tenant_id=app.current_tenant_id() AND g.actor_user_id=app.current_user_id() AND g.status='reserved')
 WHEN feature='readiness_reminders' AND kind='readiness_template' AND native_id=app.current_tenant_id() AND operation~'^(no_compensation|no_bank_account|no_identity|no_tax_number|no_epf_number|no_socso_number):(employee|hr)$' THEN app.is_admin()
 ELSE false END
$$;
--> statement-breakpoint
-- Restates app.assessment_skill_history (latest: 0540:378-385): the career graph on the review follows the effective reviewer (a plan-review read).
CREATE OR REPLACE FUNCTION app.assessment_skill_history(wanted_review uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce((SELECT jsonb_agg(jsonb_build_object('reviewId',h.review_id,'status',h.competency_status,'competencies',h.competencies) ORDER BY h.cycle_id,h.review_id)
  FROM performance_onehr_review h WHERE h.tenant_id=r.tenant_id AND h.employment_id=r.employment_id
   AND (h.competency_status='reviewed' OR app.is_self_person(e.person_id))),'[]'::jsonb)
 FROM performance_onehr_review r JOIN employment e ON e.id=r.employment_id AND e.tenant_id=r.tenant_id
 WHERE r.review_id=wanted_review AND r.tenant_id=app.current_tenant_id()
  AND (app.is_self_person(e.person_id) OR app.onehr_effective_reviewer(r.review_id) OR app.onehr_cycle_admin(r.cycle_id))
$$;
--> statement-breakpoint
-- Restates app.onehr_assessment_inputs (latest: 0540:370-374): O2: the 360 inside the competency review moves one level up; an effective-only reviewer sees the same 360 aggregates as the stored reviewer, without the PM band, score or submitted KPIs. pm is computed once per review: OFFSET 0 keeps the planner from copying the access check into each of its four uses.
CREATE OR REPLACE FUNCTION app.onehr_assessment_inputs(wanted_review uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('reviewId',r.review_id,'employmentId',r.employment_id,'companyId',r.company_id,'department',coalesce((SELECT d.name FROM assignment a JOIN department d ON d.id=a.department_id AND d.tenant_id=a.tenant_id WHERE a.employment_id=e.id AND a.tenant_id=e.tenant_id AND a.superseded_at IS NULL AND a.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (a.valid_to IS NULL OR a.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) ORDER BY a.valid_from DESC,a.id LIMIT 1),''),'businessGroupId',coalesce((SELECT c.parent_company_id::text FROM company c WHERE c.id=r.company_id AND c.tenant_id=r.tenant_id),''),'businessGroup',coalesce((SELECT g.legal_name FROM company c JOIN company g ON g.id=c.parent_company_id AND g.tenant_id=c.tenant_id WHERE c.id=r.company_id AND c.tenant_id=r.tenant_id),''),'grade',r.grade,'name',p.full_name,'performance',CASE WHEN pm.ok THEN r.manager_performance END,'managerScore',CASE WHEN pm.ok THEN r.manager_score END,'finalized',EXISTS(SELECT 1 FROM performance_onehr_result f WHERE f.review_id=r.review_id),'competencyStatus',r.competency_status,'competencyAssigned',jsonb_array_length(r.competencies)>0,'selfCompetencies',CASE WHEN r.competency_status IN ('submitted','reviewed') THEN r.competencies ELSE '[]'::jsonb END,'submittedKpis',CASE WHEN r.results_submitted_at IS NOT NULL AND pm.ok THEN r.kpis ELSE '[]'::jsonb END,'competencies',CASE WHEN r.competency_status='reviewed' THEN r.competencies ELSE '[]'::jsonb END,'principles',coalesce((SELECT jsonb_agg(jsonb_build_object('principle',q.principle,'pct',q.pct)) FROM (SELECT st->>'principle' principle,100*sum(CASE WHEN a.answers->>(st->>'id')='yes' THEN CASE WHEN (st->>'future')::boolean THEN 1.5 ELSE 1 END ELSE 0 END)/nullif(sum(CASE WHEN (st->>'future')::boolean THEN 1.5 ELSE 1 END),0) pct FROM performance_onehr_panel a CROSS JOIN LATERAL jsonb_array_elements(r.statements) st WHERE a.review_id=r.review_id AND a.submitted_at IS NOT NULL AND a.archived_at IS NULL GROUP BY st->>'principle') q),'[]'::jsonb),'leadership',coalesce((SELECT jsonb_agg(jsonb_build_object('score',app.onehr_adjusted_score(a.request_id,(SELECT sum(CASE WHEN a.answers->>(st->>'id')='yes' THEN CASE WHEN (st->>'future')::boolean THEN 1.5 ELSE 1 END ELSE 0 END) FROM jsonb_array_elements(r.statements) st),(SELECT sum(CASE WHEN (st->>'future')::boolean THEN 1.5 ELSE 1 END) FROM jsonb_array_elements(r.statements) st)),'max',(SELECT sum(CASE WHEN (st->>'future')::boolean THEN 1.5 ELSE 1 END) FROM jsonb_array_elements(r.statements) st))) FROM performance_onehr_panel a WHERE a.review_id=r.review_id AND a.submitted_at IS NOT NULL AND a.archived_at IS NULL),'[]'::jsonb))
 FROM performance_onehr_review r JOIN employment e ON e.id=r.employment_id AND e.tenant_id=r.tenant_id JOIN person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
 CROSS JOIN LATERAL (SELECT (app.onehr_cycle_admin(r.cycle_id) OR app.onehr_manager(r.review_id) OR EXISTS(SELECT 1 FROM performance_onehr_calibration_entry ce JOIN performance_onehr_calibration cs ON cs.id=ce.session_id WHERE ce.review_id=r.review_id AND app.onehr_calibration_access(cs.id) AND NOT app.is_self_person(p.id))) AS ok OFFSET 0) pm
 WHERE r.review_id=wanted_review AND r.tenant_id=app.current_tenant_id() AND NOT app.is_self_person(p.id) AND (pm.ok OR app.onehr_effective_reviewer(r.review_id))
$$;
--> statement-breakpoint
-- Restates app.onehr_calibration_seat_users (latest: 0663:439-454): leader-off per holder employment (HOD anchor and BU CEO, BG CEO, group chief seats).
CREATE OR REPLACE FUNCTION app.onehr_calibration_seat_users(wanted_session uuid) RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
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
  AND NOT app.assessment_unit_excluded(s.cycle_id,e.id)
$$;
--> statement-breakpoint
-- Restates app.onehr_calibration_reviewer (latest: 0663:461-467): D9: an explicit grant is off when every live in-scope employment of the login is out; the seat arm is filtered in seat_users.
-- Fast path (plan R2), as in app.assessment_review_participates: with no active rule and no pin in the cycle no login is out,
-- so the named arm skips app.onehr_user_unit_excluded (this check runs inside every calibration access check).
CREATE OR REPLACE FUNCTION app.onehr_calibration_reviewer(wanted_session uuid, wanted_user uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM performance_onehr_calibration s JOIN app_user u ON u.id=wanted_user AND u.tenant_id=s.tenant_id
  WHERE s.id=wanted_session AND s.tenant_id=app.current_tenant_id() AND s.tier<>'final'
   AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
   AND (u.id=app.current_user_id() OR app.assessment_dispatcher_scope() OR app.onehr_admin(s.company_id))
   AND (u.id=ANY(s.reviewer_user_ids) AND (NOT (EXISTS(SELECT 1 FROM performance_assessment_unit_exclusion x WHERE x.tenant_id=s.tenant_id AND x.cycle_id=s.cycle_id AND x.ended_at IS NULL) OR EXISTS(SELECT 1 FROM performance_assessment_unit_exclusion_pin xp WHERE xp.tenant_id=s.tenant_id AND xp.cycle_id=s.cycle_id))
     OR NOT app.onehr_user_unit_excluded(s.cycle_id,u.id)) OR u.id=ANY(app.onehr_calibration_seat_users(s.id))))
$$;
--> statement-breakpoint
-- Restates app.assessment_pending_work (latest: 0663:513-560): reminders name the effective reviewer and drop moderators who are out; session reviewers already follow onehr_calibration_reviewer.
CREATE OR REPLACE FUNCTION app.assessment_pending_work(wanted_cycle uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH cycle AS MATERIALIZED (
  SELECT c.*,cfg.policy FROM review_cycle c JOIN performance_onehr_cycle cfg ON cfg.cycle_id=c.id AND cfg.tenant_id=c.tenant_id
  WHERE c.id=wanted_cycle AND c.tenant_id=app.current_tenant_id() AND c.status IN ('open','calibration')
   AND (app.assessment_dispatcher_scope() OR app.onehr_cycle_admin(c.id))
 ), reviews AS MATERIALIZED (
  SELECT r.*,p.reviewer_employment_id,p.closed_at,e.person_id,person.full_name,
   (SELECT coalesce(jsonb_agg(mc ORDER BY mc->>'id'),'[]'::jsonb) FROM jsonb_array_elements(app.onehr_moderator_choices(r.review_id)) mc WHERE NOT app.assessment_unit_excluded(r.cycle_id,(mc->>'id')::uuid)) AS moderators,
   CASE WHEN app.assessment_unit_excluded(r.cycle_id,p.reviewer_employment_id) THEN app.onehr_effective_reviewer_of(r.review_id) ELSE p.reviewer_employment_id END AS effective_reviewer_employment_id,
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
  SELECT employment_id AS id FROM reviews UNION SELECT effective_reviewer_employment_id FROM reviews
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
  'reviews',coalesce((SELECT jsonb_agg(jsonb_build_object('id',r.review_id,'companyId',r.company_id,'employmentId',r.employment_id,'personId',r.person_id,'name',r.full_name,'reviewerEmploymentId',r.effective_reviewer_employment_id,'moderatorIds',(SELECT coalesce(jsonb_agg(m->'id' ORDER BY m->>'id'),'[]'::jsonb) FROM jsonb_array_elements(r.moderators) m),'frozen',r.frozen OR r.closed_at IS NOT NULL,
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
-- Restates app.onehr_department_view (latest: 0664:36-93): leader-off: an HOD who is out sees nobody (E7); excluded people leave through app.assessment_review_eligible.
CREATE OR REPLACE FUNCTION app.onehr_department_view(wanted_cycle uuid)
 RETURNS TABLE(employment_id uuid, parent_employment_id uuid, full_name text, department_name text, job_title text,
               direct boolean, finalized boolean, overall_band text, overall_score numeric, mechanism text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH today AS (SELECT (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS d),
 me AS MATERIALIZED (
  SELECT e.id FROM employment e JOIN app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id CROSS JOIN today
  WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
   AND (e.terminated_on IS NULL OR e.terminated_on>today.d)
 ),
 pop AS MATERIALIZED (
  SELECT r.tenant_id,r.employment_id,e.person_id,h.hod_employment_id,r.manager_performance,r.manager_score,r.kpis
  FROM review_cycle c CROSS JOIN today
  JOIN performance_onehr_cycle cfg ON cfg.cycle_id=c.id AND cfg.tenant_id=c.tenant_id
  JOIN performance_onehr_review r ON r.cycle_id=c.id AND r.tenant_id=c.tenant_id
  JOIN employment e ON e.id=r.employment_id AND e.tenant_id=r.tenant_id
  JOIN performance_hod_assignment h ON h.tenant_id=r.tenant_id AND h.subject_employment_id=r.employment_id
   AND h.valid_from<=today.d AND (h.valid_to IS NULL OR h.valid_to>today.d)
  JOIN employment he ON he.id=h.hod_employment_id AND he.tenant_id=h.tenant_id
  WHERE c.id=wanted_cycle AND c.tenant_id=app.current_tenant_id() AND c.status IN ('open','calibration')
   AND h.hod_employment_id IN (SELECT id FROM me)
   AND app.onehr_business_group_node(e.company_id)=app.onehr_business_group_node(he.company_id)
   AND coalesce((cfg.policy->'modules'->>'pm')::boolean,false) AND coalesce(cfg.policy->>'kind','')<>'quarterly'
   AND jsonb_array_length(r.kpis)>0
   AND NOT app.is_self_person(e.person_id)
   AND app.assessment_review_eligible(r.review_id)
   AND NOT app.assessment_unit_excluded(c.id,h.hod_employment_id)
 ),
 facts AS (
  SELECT p.*,
   NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.kpis) k WHERE coalesce((k->>'locked')::boolean,false)=false) AND p.manager_performance IS NOT NULL AS done,
   (SELECT l.manager_employment_id FROM reporting_line l CROSS JOIN today
    WHERE l.tenant_id=p.tenant_id AND l.subordinate_employment_id=p.employment_id AND l.line_type='administrative' AND l.superseded_at IS NULL
     AND l.valid_from<=today.d AND (l.valid_to IS NULL OR l.valid_to>today.d)
    ORDER BY l.valid_from DESC,l.id LIMIT 1) AS line_manager
  FROM pop p
 )
 SELECT f.employment_id,
  CASE WHEN f.line_manager IN (SELECT pop.employment_id FROM pop) THEN f.line_manager END,
  person.full_name,
  a.department_name,
  a.job_title,
  coalesce(f.line_manager=f.hod_employment_id,false),
  f.done,
  CASE WHEN f.done THEN f.manager_performance END,
  CASE WHEN f.done THEN f.manager_score END,
  CASE WHEN f.done THEN f.kpis->0->'scoring'->>'mechanism' END
 FROM facts f
 JOIN person ON person.id=f.person_id AND person.tenant_id=f.tenant_id
 LEFT JOIN LATERAL (
  SELECT d.name AS department_name,pos.title AS job_title FROM assignment x CROSS JOIN today
  LEFT JOIN department d ON d.id=x.department_id AND d.tenant_id=x.tenant_id
  LEFT JOIN position pos ON pos.id=x.position_id AND pos.tenant_id=x.tenant_id
  WHERE x.employment_id=f.employment_id AND x.tenant_id=f.tenant_id AND x.superseded_at IS NULL
   AND x.valid_from<=today.d AND (x.valid_to IS NULL OR x.valid_to>today.d)
  ORDER BY x.valid_from DESC,x.id LIMIT 1
 ) a ON true
 ORDER BY person.full_name,f.employment_id
$$;
--> statement-breakpoint

-- ── 10. X4: an excluded subject's cached PM insight (restatement, U11) ─────────────────────────────────
-- Restates app.assessment_insight_source (latest: 0540:1213-1242): U11: an excluded subject's PM insight is not a source for anyone (the participation arm).
CREATE OR REPLACE FUNCTION app.assessment_insight_source(wanted_review uuid,wanted_context uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH authorized AS (
  SELECT r.*,p.full_name,c.policy,s.tier,s.id AS calibration_id,
   CASE WHEN wanted_context<>wanted_review THEN 'calibrator' ELSE 'manager' END AS reviewer_kind
  FROM performance_onehr_review r JOIN employment e ON e.id=r.employment_id AND e.tenant_id=r.tenant_id JOIN person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
   JOIN performance_onehr_cycle c ON c.cycle_id=r.cycle_id AND c.tenant_id=r.tenant_id
   LEFT JOIN performance_onehr_calibration s ON s.id=wanted_context AND s.cycle_id=r.cycle_id AND s.tenant_id=r.tenant_id AND wanted_context<>wanted_review
  WHERE r.review_id=wanted_review AND r.tenant_id=app.current_tenant_id() AND NOT app.is_self_person(e.person_id)
   AND coalesce((c.policy->'modules'->>'pm')::boolean,false) AND c.policy->>'kind'<>'quarterly' AND app.assessment_review_participates(r.review_id)
   AND CASE WHEN wanted_context=wanted_review THEN app.onehr_manager(r.review_id) OR app.onehr_moderator(r.review_id)
    ELSE s.id IS NOT NULL AND coalesce((c.policy->'modules'->>'calibration')::boolean,true) AND app.onehr_calibration_access(s.id)
     AND EXISTS(SELECT 1 FROM performance_onehr_calibration_entry ce WHERE ce.session_id=s.id AND ce.review_id=r.review_id AND ce.tenant_id=r.tenant_id) END
 ), scoped AS (
  SELECT a.*,CASE WHEN a.results_submitted_at IS NULL THEN '[]'::jsonb ELSE coalesce((SELECT jsonb_agg(k ORDER BY ord) FROM jsonb_array_elements(a.kpis) WITH ORDINALITY q(k,ord)
   WHERE a.reviewer_kind='calibrator' OR coalesce((k->>'hrOwned')::boolean,false) OR EXISTS(
    SELECT 1 FROM employment m JOIN app_user u ON u.person_id=m.person_id AND u.tenant_id=m.tenant_id
     WHERE u.id=app.current_user_id() AND m.tenant_id=a.tenant_id AND (k->>'moderatorEmploymentId'=m.id::text OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(k->'approvalChain','[]'::jsonb)) ap WHERE ap->>'employmentId'=m.id::text))
   )),'[]'::jsonb) END AS visible_kpis FROM authorized a
 )
 SELECT jsonb_build_object('reviewId',a.review_id,'cycleId',a.cycle_id,'companyId',a.company_id,'name',a.full_name,'revision',a.revision,'reviewerKind',a.reviewer_kind,
  'kpis',a.visible_kpis,'submitted',a.results_submitted_at IS NOT NULL,'selfRemark',CASE WHEN a.results_submitted_at IS NOT NULL AND (a.reviewer_kind='calibrator' OR app.onehr_manager(a.review_id)) THEN a.self_remark ELSE '' END,
  'reviewerRemarks',CASE WHEN a.reviewer_kind='calibrator' THEN app.assessment_locked_reviewer_remarks(a.review_id) ELSE '[]'::jsonb END,
  'bands',jsonb_build_object('aBands',a.policy->'aBands','bBands',a.policy->'bBands'),'evidenceEnabled',coalesce((a.policy->'modules'->>'evidence')::boolean,false),
  'names',coalesce((SELECT jsonb_object_agg(m.id::text,p.full_name) FROM employment m JOIN person p ON p.id=m.person_id AND p.tenant_id=m.tenant_id WHERE m.tenant_id=a.tenant_id AND EXISTS(SELECT 1 FROM jsonb_array_elements(a.visible_kpis) k WHERE k->>'moderatorEmploymentId'=m.id::text OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(k->'approvalChain','[]'::jsonb)) ap WHERE ap->>'employmentId'=m.id::text))),'{}'::jsonb),
  'fileLinks',CASE WHEN a.results_submitted_at IS NOT NULL THEN coalesce((SELECT jsonb_agg(link ORDER BY link->>'attachmentId',link->>'kpiId') FROM jsonb_array_elements(app.assessment_kpi_file_links(a.review_id)) link WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(a.visible_kpis) k WHERE k->>'id'=link->>'kpiId' AND NOT coalesce((k->>'hrOwned')::boolean,false))),'[]'::jsonb) ELSE '[]'::jsonb END,
  'trail',CASE WHEN a.reviewer_kind='calibrator' THEN coalesce((SELECT jsonb_agg(jsonb_build_object('tier',s.tier,'label',CASE s.tier WHEN 'hod' THEN 'HOD' WHEN 'bu' THEN 'BU CEO' WHEN 'bg' THEN 'BG CEO' ELSE 'Group' END,'by',coalesce((SELECT p.full_name FROM domain_event d JOIN app_user u ON u.id=d.actor_id AND u.tenant_id=d.tenant_id JOIN person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id WHERE d.tenant_id=a.tenant_id AND d.aggregate_id=s.id AND d.event_type='onehr.calibration-recorded' AND d.payload->>'reviewId'=a.review_id::text ORDER BY d.occurred_at DESC,d.id DESC LIMIT 1),''),'from',ce.seen_performance,'band',ce.performance,'note',ce.performance_note) ORDER BY array_position(ARRAY['hod','bu','bg','group','final'],s.tier))
   FROM performance_onehr_calibration_entry ce JOIN performance_onehr_calibration s ON s.id=ce.session_id AND s.tenant_id=ce.tenant_id
   WHERE ce.review_id=a.review_id AND ce.tenant_id=a.tenant_id AND (app.assessment_calibration_axis_confirmed(s.tier,ce.performance_locked_at,s.performance_locked_at)) AND array_position(ARRAY['hod','bu','bg','group','final'],s.tier)<array_position(ARRAY['hod','bu','bg','group','final'],a.tier)),'[]'::jsonb) ELSE '[]'::jsonb END
 ) FROM scoped a
$$;
--> statement-breakpoint

-- ── 11. W3: leader-off on the two-step release's leader reads (restatements of 0665) ───────────────────
-- 0665 runs before this migration, so its leader helpers are restated here, after the predicates above, each as
-- its 0665 body plus the leader-off arm (E7): a seat, HOD assignment or stored-reviewer right is off while its
-- acting employment is out of the review's cycle by the unit rule (D9). Administrators are never stopped: the
-- administrator arms (app.onehr_cycle_admin, app.onehr_release_admin) are unchanged. The line-manager arms of
-- app.onehr_leader_role and app.onehr_led_tabs read app.onehr_manager, which carries leader-off since section 9;
-- app.onehr_release_leaders reads the stored reviewer directly and gains the arm. Readers of these helpers follow on the
-- leader side: app.onehr_frozen_visible, app.onehr_leader_result and app.onehr_led_people (app.onehr_leader_role),
-- app.onehr_led_people and app.onehr_led_cycles (app.onehr_led_tabs), and the release notices and release board
-- (app.onehr_release_leaders). 0666 (after this one) carries the same arm in app.onehr_leader_status.
-- The subject arm (E1, frozen results exempt by D7) reaches the leader reads too: a person whose unit is out has no
-- review of their own, so they leave What you led (app.onehr_led_tabs) and have no working result to read
-- (app.onehr_leader_result), both through app.assessment_review_eligible as restated in section 8. The release
-- writer and board already follow participation through app.onehr_result_card (app.assessment_review_participates).
-- Restates app.onehr_leader_role (latest: 0665:108-135): leader-off on the BG CEO, group chief and BU CEO seat arms and the HOD arm.
CREATE OR REPLACE FUNCTION app.onehr_leader_role(wanted_review uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH today AS (SELECT (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS d),
 me AS (SELECT u.id,u.person_id,u.tenant_id FROM app_user u
  WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)),
 mine AS (SELECT e.id FROM employment e JOIN me ON e.person_id=me.person_id AND e.tenant_id=me.tenant_id CROSS JOIN today
  WHERE e.terminated_on IS NULL OR e.terminated_on>today.d),
 r AS (SELECT o.review_id,o.employment_id,o.company_id,o.tenant_id,o.cycle_id FROM performance_onehr_review o
  JOIN employment s ON s.id=o.employment_id AND s.tenant_id=o.tenant_id JOIN me ON me.tenant_id=o.tenant_id
  WHERE o.review_id=wanted_review AND s.person_id<>me.person_id)
 SELECT CASE
  WHEN EXISTS(SELECT 1 FROM r CROSS JOIN today JOIN performance_leader_seat st ON st.tenant_id=r.tenant_id AND st.seat_type='bg_ceo'
   AND st.company_id=app.onehr_business_group_node(r.company_id) AND st.valid_from<=today.d AND (st.valid_to IS NULL OR st.valid_to>today.d)
   WHERE st.holder_employment_id IN (SELECT id FROM mine) AND NOT app.assessment_unit_excluded(r.cycle_id,st.holder_employment_id)) THEN 'bg'
  WHEN EXISTS(SELECT 1 FROM r CROSS JOIN today JOIN performance_calibration_group_member m ON m.tenant_id=r.tenant_id AND m.employment_id=r.employment_id
   AND m.valid_from<=today.d AND (m.valid_to IS NULL OR m.valid_to>today.d)
   JOIN performance_calibration_group g ON g.id=m.group_id AND g.tenant_id=m.tenant_id AND g.retired_at IS NULL
   JOIN performance_leader_seat st ON st.tenant_id=r.tenant_id AND st.seat_type='group_chief' AND st.calibration_group_id=g.id
   AND st.valid_from<=today.d AND (st.valid_to IS NULL OR st.valid_to>today.d)
   WHERE st.holder_employment_id IN (SELECT id FROM mine) AND NOT app.assessment_unit_excluded(r.cycle_id,st.holder_employment_id)) THEN 'group'
  WHEN EXISTS(SELECT 1 FROM r CROSS JOIN today JOIN performance_leader_seat st ON st.tenant_id=r.tenant_id AND st.seat_type='bu_ceo'
   AND st.company_id=r.company_id AND st.valid_from<=today.d AND (st.valid_to IS NULL OR st.valid_to>today.d)
   WHERE st.holder_employment_id IN (SELECT id FROM mine) AND NOT app.assessment_unit_excluded(r.cycle_id,st.holder_employment_id)) THEN 'bu'
  WHEN EXISTS(SELECT 1 FROM r CROSS JOIN today JOIN performance_hod_assignment h ON h.tenant_id=r.tenant_id AND h.subject_employment_id=r.employment_id
   AND h.valid_from<=today.d AND (h.valid_to IS NULL OR h.valid_to>today.d)
   WHERE h.hod_employment_id IN (SELECT id FROM mine) AND NOT app.assessment_unit_excluded(r.cycle_id,h.hod_employment_id)) THEN 'hod'
  WHEN EXISTS(SELECT 1 FROM r) AND app.onehr_manager(wanted_review) THEN 'lm'
 END
$$;
--> statement-breakpoint
-- Restates app.onehr_release_leaders (latest: 0665:146-165): leader-off per recipient employment (the stored reviewer, the HOD, the BU CEO seat holder): an excluded leader is not told at release 1.
CREATE OR REPLACE FUNCTION app.onehr_release_leaders(wanted_reviews uuid[]) RETURNS TABLE(review_id uuid, leader_role text, employment_id uuid, full_name text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH today AS (SELECT (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS d),
 r AS (SELECT o.review_id,o.employment_id,o.company_id,o.tenant_id,o.cycle_id,s.person_id AS subject_person,p.reviewer_employment_id
  FROM performance_onehr_review o JOIN employment s ON s.id=o.employment_id AND s.tenant_id=o.tenant_id
  JOIN performance_review p ON p.id=o.review_id AND p.tenant_id=o.tenant_id
  WHERE o.review_id=ANY(wanted_reviews) AND o.tenant_id=app.current_tenant_id() AND app.onehr_release_admin(o.review_id)),
 reach AS (
  SELECT r.review_id,'lm'::text AS leader_role,r.reviewer_employment_id AS employment_id,r.subject_person,r.tenant_id,r.cycle_id FROM r WHERE r.reviewer_employment_id IS NOT NULL
  UNION ALL
  SELECT r.review_id,'hod',h.hod_employment_id,r.subject_person,r.tenant_id,r.cycle_id FROM r CROSS JOIN today JOIN performance_hod_assignment h ON h.tenant_id=r.tenant_id
   AND h.subject_employment_id=r.employment_id AND h.valid_from<=today.d AND (h.valid_to IS NULL OR h.valid_to>today.d)
  UNION ALL
  SELECT r.review_id,'bu',st.holder_employment_id,r.subject_person,r.tenant_id,r.cycle_id FROM r CROSS JOIN today JOIN performance_leader_seat st ON st.tenant_id=r.tenant_id
   AND st.seat_type='bu_ceo' AND st.company_id=r.company_id AND st.valid_from<=today.d AND (st.valid_to IS NULL OR st.valid_to>today.d))
 SELECT x.review_id,x.leader_role,x.employment_id,p.full_name FROM reach x CROSS JOIN today JOIN employment e ON e.id=x.employment_id AND e.tenant_id=x.tenant_id
 JOIN person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
 WHERE e.person_id<>x.subject_person AND (e.terminated_on IS NULL OR e.terminated_on>today.d)
  AND NOT app.assessment_unit_excluded(x.cycle_id,x.employment_id)
  AND EXISTS(SELECT 1 FROM app_user u WHERE u.person_id=e.person_id AND u.tenant_id=e.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))
 ORDER BY x.review_id,array_position(ARRAY['lm','hod','bu'],x.leader_role),x.employment_id
$$;
--> statement-breakpoint
-- Restates app.onehr_led_tabs (latest: 0665:313-341): leader-off on the department, business unit, calibration group and business group tabs; the subject arm (E1): a led person counts only with a frozen result or while app.assessment_review_eligible (participation with the unit rule), so an excluded person leaves What you led and its counts.
CREATE OR REPLACE FUNCTION app.onehr_led_tabs(wanted_cycle uuid) RETURNS TABLE(review_id uuid, tabs text[]) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH today AS (SELECT (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS d),
 me AS (SELECT u.id,u.person_id,u.tenant_id FROM app_user u
  WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)),
 mine AS (SELECT e.id FROM employment e JOIN me ON e.person_id=me.person_id AND e.tenant_id=me.tenant_id CROSS JOIN today
  WHERE e.terminated_on IS NULL OR e.terminated_on>today.d),
 r AS (SELECT o.review_id,o.employment_id,o.company_id,o.tenant_id FROM performance_onehr_review o
  JOIN employment s ON s.id=o.employment_id AND s.tenant_id=o.tenant_id JOIN me ON me.tenant_id=o.tenant_id CROSS JOIN today
  WHERE o.cycle_id=wanted_cycle AND s.person_id<>me.person_id AND (s.terminated_on IS NULL OR s.terminated_on>today.d)),
 tabbed AS (
  SELECT r.review_id,'direct'::text AS tab FROM r WHERE app.onehr_manager(r.review_id)
  UNION ALL
  SELECT r.review_id,'dept' FROM r CROSS JOIN today JOIN performance_hod_assignment h ON h.tenant_id=r.tenant_id AND h.subject_employment_id=r.employment_id
   AND h.valid_from<=today.d AND (h.valid_to IS NULL OR h.valid_to>today.d) WHERE h.hod_employment_id IN (SELECT id FROM mine) AND NOT app.assessment_unit_excluded(wanted_cycle,h.hod_employment_id)
  UNION ALL
  SELECT r.review_id,'bu' FROM r CROSS JOIN today JOIN performance_leader_seat st ON st.tenant_id=r.tenant_id AND st.seat_type='bu_ceo' AND st.company_id=r.company_id
   AND st.valid_from<=today.d AND (st.valid_to IS NULL OR st.valid_to>today.d) WHERE st.holder_employment_id IN (SELECT id FROM mine) AND NOT app.assessment_unit_excluded(wanted_cycle,st.holder_employment_id)
  UNION ALL
  SELECT r.review_id,'group' FROM r CROSS JOIN today JOIN performance_calibration_group_member m ON m.tenant_id=r.tenant_id AND m.employment_id=r.employment_id
   AND m.valid_from<=today.d AND (m.valid_to IS NULL OR m.valid_to>today.d)
   JOIN performance_calibration_group g ON g.id=m.group_id AND g.tenant_id=m.tenant_id AND g.retired_at IS NULL
   JOIN performance_leader_seat st ON st.tenant_id=r.tenant_id AND st.seat_type='group_chief' AND st.calibration_group_id=g.id
   AND st.valid_from<=today.d AND (st.valid_to IS NULL OR st.valid_to>today.d) WHERE st.holder_employment_id IN (SELECT id FROM mine) AND NOT app.assessment_unit_excluded(wanted_cycle,st.holder_employment_id)
  UNION ALL
  SELECT r.review_id,'bg' FROM r CROSS JOIN today JOIN performance_leader_seat st ON st.tenant_id=r.tenant_id AND st.seat_type='bg_ceo'
   AND st.company_id=app.onehr_business_group_node(r.company_id) AND st.valid_from<=today.d AND (st.valid_to IS NULL OR st.valid_to>today.d)
   WHERE st.holder_employment_id IN (SELECT id FROM mine) AND NOT app.assessment_unit_excluded(wanted_cycle,st.holder_employment_id))
 SELECT t.review_id,array_agg(DISTINCT t.tab ORDER BY t.tab) FROM tabbed t GROUP BY t.review_id
 HAVING EXISTS(SELECT 1 FROM performance_onehr_result f WHERE f.review_id=t.review_id AND f.tenant_id=app.current_tenant_id()) OR app.assessment_review_eligible(t.review_id)
$$;
--> statement-breakpoint
-- Restates app.onehr_leader_result (latest: 0665:229-301): the subject arm (E1): counted through app.assessment_review_eligible (participation with the unit rule) instead of the snapshot alone.
CREATE OR REPLACE FUNCTION app.onehr_leader_result(wanted_review uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE leader text; r performance_onehr_review; mid boolean; rel performance_assessment_release; f performance_onehr_result; snap jsonb; outcome jsonb;
 counted boolean; axis text; axes jsonb:='[]'::jsonb; upto text; fully boolean; hidden boolean; before text; steps jsonb; s record; st text; final_band text;
 released boolean; self_pot text; pct numeric; w numeric; talent_open boolean; all_full boolean:=true;
BEGIN
 leader:=app.onehr_leader_role(wanted_review);
 IF leader IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO r FROM performance_onehr_review WHERE review_id=wanted_review AND tenant_id=app.current_tenant_id();
 SELECT coalesce(c.policy->>'kind','year_end')='mid_year' INTO mid FROM performance_onehr_cycle c WHERE c.cycle_id=r.cycle_id AND c.tenant_id=r.tenant_id;
 SELECT * INTO rel FROM performance_assessment_release WHERE review_id=r.review_id AND tenant_id=r.tenant_id;
 SELECT * INTO f FROM performance_onehr_result WHERE review_id=r.review_id AND tenant_id=r.tenant_id;
 -- Participation without the caller-visibility arm (app.assessment_review_participates also asks whether the
 -- caller can see the person, which a seat holder need not): app.assessment_review_eligible, the same snapshot,
 -- terminated and override arms plus the unit rule (E1). A person taken out of the cycle, alone or with their unit,
 -- has no working result to read; a frozen result is read as before (D7).
 counted:=app.assessment_review_eligible(r.review_id);
 IF f.id IS NULL AND NOT counted THEN
  RETURN jsonb_build_object('role',leader,'midYear',mid,'frozen',false,'axes','[]'::jsonb,'talent',NULL);
 END IF;
 SELECT snapshot INTO snap FROM performance_assessment_rating_record WHERE review_id=r.review_id AND tenant_id=r.tenant_id;
 outcome:=CASE WHEN f.id IS NOT NULL THEN f.result ELSE app.assessment_working_result(r.review_id) END;
 -- Self potential, from the recorded 360 percentage and the person's own competency answers (model.potential).
 w:=coalesce((snap->'configuration'->>'weight360')::numeric,10000);
 IF coalesce((snap->>'valid')::boolean,false) AND snap->>'potential360Pct' IS NOT NULL AND snap->>'competencySelf' IS NOT NULL AND coalesce((snap->>'competencyMax')::numeric,0)>0 THEN
  pct:=CASE WHEN w<10000 THEN ((snap->>'potential360Pct')::numeric*w+100*(snap->>'competencySelf')::numeric/(snap->>'competencyMax')::numeric*(10000-w))/10000 ELSE (snap->>'potential360Pct')::numeric END;
  self_pot:=CASE WHEN pct<=(snap->'configuration'->>'lowMaxPct')::numeric THEN 'Low' WHEN pct<=(snap->'configuration'->>'midMaxPct')::numeric THEN 'Mid' ELSE 'High' END;
 END IF;
 upto:=CASE leader WHEN 'lm' THEN 'lm' WHEN 'hod' THEN 'hod' WHEN 'bu' THEN CASE WHEN mid THEN 'hod' ELSE 'bu' END END;
 FOREACH axis IN ARRAY ARRAY['performance','potential'] LOOP
  final_band:=outcome->>axis;
  released:=CASE axis WHEN 'performance' THEN rel.performance_leader_released_at IS NOT NULL ELSE rel.potential_leader_released_at IS NOT NULL END;
  fully:=leader IN ('bg','group') OR coalesce(released,false) OR final_band IS NULL;
  IF final_band IS NOT NULL AND NOT fully THEN all_full:=false; END IF;
  hidden:=false; before:=NULL; steps:='[]'::jsonb;
  FOR s IN
   SELECT q.tier,q.ord,q.band,q.why FROM (
    SELECT 'self'::text AS tier,1 AS ord,CASE axis WHEN 'performance' THEN snap->>'selfBand' ELSE self_pot END AS band,''::text AS why
    UNION ALL
    SELECT 'lm',2,CASE axis WHEN 'performance' THEN r.manager_performance
     ELSE CASE WHEN coalesce((snap->>'valid')::boolean,false) AND coalesce(snap->>'competencyStatus','reviewed')='reviewed' THEN snap->>'computedPotential' END END,''
    UNION ALL
    SELECT t.tier,t.ord,(SELECT CASE axis WHEN 'performance' THEN ce.performance ELSE ce.potential END
      FROM performance_onehr_calibration_entry ce JOIN performance_onehr_calibration cs ON cs.id=ce.session_id AND cs.tenant_id=ce.tenant_id
      WHERE ce.review_id=r.review_id AND ce.tenant_id=r.tenant_id AND cs.tier=t.tier AND NOT (cs.tier='group' AND cs.mode='blend')
       AND (cs.tier='final' OR CASE axis WHEN 'performance' THEN app.assessment_calibration_axis_confirmed(cs.tier,ce.performance_locked_at,cs.performance_locked_at)
        ELSE app.assessment_calibration_axis_confirmed(cs.tier,ce.potential_locked_at,cs.potential_locked_at) END)
      ORDER BY ce.id LIMIT 1),
     coalesce((SELECT CASE axis WHEN 'performance' THEN ce.performance_note ELSE ce.potential_note END
      FROM performance_onehr_calibration_entry ce JOIN performance_onehr_calibration cs ON cs.id=ce.session_id AND cs.tenant_id=ce.tenant_id
      WHERE ce.review_id=r.review_id AND ce.tenant_id=r.tenant_id AND cs.tier=t.tier AND NOT (cs.tier='group' AND cs.mode='blend')
      ORDER BY ce.id LIMIT 1),'')
    FROM (VALUES ('hod',3),('bu',4),('bg',5),('group',6),('final',7)) t(tier,ord)
   ) q ORDER BY q.ord
  LOOP
   IF mid AND s.tier IN ('bu','bg','group') THEN CONTINUE; END IF;
   IF s.tier IN ('group','final') AND (s.band IS NULL OR hidden) THEN CONTINUE; END IF;
   IF hidden THEN
    steps:=steps||jsonb_build_object('tier',s.tier,'band',NULL,'state','hidden','why','');
    CONTINUE;
   END IF;
   st:=CASE WHEN s.band IS NULL THEN 'none' WHEN before IS NULL THEN 'set' WHEN s.band=before THEN 'kept' ELSE 'moved' END;
   steps:=steps||jsonb_build_object('tier',s.tier,'band',s.band,'state',st,'why',CASE WHEN s.tier IN ('self','lm') OR s.band IS NULL THEN '' ELSE btrim(coalesce(s.why,'')) END);
   before:=coalesce(s.band,before);
   IF NOT fully AND upto=s.tier THEN hidden:=true; END IF;
  END LOOP;
  axes:=axes||jsonb_build_array(jsonb_build_object('axis',axis,'steps',steps,'final',CASE WHEN fully THEN final_band END,'full',fully,'hasResult',final_band IS NOT NULL));
 END LOOP;
 talent_open:=leader IN ('bg','group') OR rel.talent_leader_released_at IS NOT NULL OR all_full;
 RETURN jsonb_build_object('role',leader,'midYear',mid,'frozen',f.id IS NOT NULL,'axes',axes,'talent',CASE WHEN talent_open THEN outcome->>'talent' END);
END $$;
--> statement-breakpoint
-- ── X5. The screen's department choices (D-P1-22 X5, APR-024) ──────────────────────────────────────────
-- Departments of a company in the cycle's scope that hold people today, with the count: the departments the
-- "Units not taking part" card offers. Same placement and the same "active today" rule as the facts headcount
-- (app.assessment_unit_placement, terminated_on after today), so a department offered here is never refused as
-- empty and no department with people is missing. Rows only for a caller who may read that company's rules
-- (the rule table's read predicate, app.onehr_admin) in their own tenant; nobody else gets a row.
CREATE FUNCTION app.onehr_unit_exclusion_choices(wanted_cycle uuid, wanted_company uuid) RETURNS TABLE(department_id uuid, department_name text, people integer)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH today AS (SELECT (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS d),
 cyc AS (
  SELECT c.tenant_id FROM review_cycle c JOIN performance_onehr_cycle cfg ON cfg.cycle_id=c.id AND cfg.tenant_id=c.tenant_id
  WHERE c.id=wanted_cycle AND c.tenant_id=app.current_tenant_id() AND wanted_company IS NOT NULL
   AND (c.company_id IS NULL OR c.company_id=wanted_company) AND app.onehr_admin(wanted_company)
 )
 SELECT d.id,d.name,count(DISTINCT e.id)::integer
 FROM cyc CROSS JOIN today
 JOIN employment e ON e.tenant_id=cyc.tenant_id AND (e.terminated_on IS NULL OR e.terminated_on>today.d)
  AND (e.company_id=wanted_company OR EXISTS(SELECT 1 FROM assignment a WHERE a.employment_id=e.id AND a.tenant_id=e.tenant_id AND a.company_id=wanted_company))
 CROSS JOIN LATERAL app.assessment_unit_placement(e.id) pl
 JOIN department d ON d.id=pl.department_id AND d.tenant_id=e.tenant_id AND d.company_id=wanted_company
 WHERE pl.company_id=wanted_company
 GROUP BY d.id,d.name
 ORDER BY d.name,d.id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.onehr_unit_exclusion_choices(uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.onehr_unit_exclusion_choices(uuid,uuid) TO ai_hr_app;
