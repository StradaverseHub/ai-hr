-- UNALLOCATED DRAFT on branch claude/import-staged-job-20261110 (staged import: constant-time activation and staged
-- audit events): not a reservation, not an installation allocation. The journal position (idx 9004, when
-- 1793330090004) exists only so this branch's schema is executable; the integration owner assigns the final
-- tag/idx/when after the freshly verified ledger, per docs/MIGRATION-ALLOCATION.md.
--
-- Activation used to clear the staged marker with one UPDATE per table: every employment and person trigger fired
-- for every row and the deferred constraint triggers ran at COMMIT, all while the import held the tenant's Access
-- and audit-chain locks (about 1.5 s for 500 rows; proportional to the file). Visibility is now decided by the
-- attempt: a staged row is visible once its attempt is RELEASED. Release is one row insert under the initiating
-- user's fresh authority (constant time), so every reader sees the whole import at the same instant. Afterwards the
-- worker clears the markers in short bounded batches ("settle"), which fires the ordinary triggers (Entra queue,
-- replacement holidays, epochs) exactly as the single UPDATE did, without changing what anyone can see.
CREATE TABLE app.import_attempt_release (
 attempt_id uuid PRIMARY KEY REFERENCES public.import_attempt(id),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 outcome text NOT NULL CHECK(outcome IN ('activated','discarded')),
 released_at timestamptz NOT NULL DEFAULT now(),
 settled_at timestamptz
);
--> statement-breakpoint
CREATE INDEX import_attempt_release_tenant ON app.import_attempt_release(tenant_id);
--> statement-breakpoint
REVOKE ALL ON app.import_attempt_release FROM PUBLIC;
--> statement-breakpoint
-- Definer-side visibility predicate. SQL, invoker, no SET clause: the planner inlines it into each definer reader.
CREATE FUNCTION app.import_marker_visible(p_attempt uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT p_attempt IS NULL OR EXISTS(SELECT 1 FROM app.import_attempt_release r WHERE r.attempt_id=p_attempt);
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.import_marker_visible(uuid) FROM PUBLIC;
--> statement-breakpoint
-- Policy-side: the current tenant's released attempts, evaluated once per statement (InitPlan) and only for rows
-- that still carry a marker. Reveals attempt ids only.
CREATE FUNCTION app.import_released_attempt_ids() RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(array_agg(r.attempt_id),'{}'::uuid[]) FROM app.import_attempt_release r WHERE r.tenant_id=app.current_tenant_id();
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.import_released_attempt_ids() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.import_released_attempt_ids() TO PUBLIC;
--> statement-breakpoint
ALTER POLICY employment_import_pending ON employment
 USING (import_pending_attempt_id IS NULL OR import_pending_attempt_id::text = current_setting('app.import_attempt',true)
  OR import_pending_attempt_id = ANY((SELECT app.import_released_attempt_ids())::uuid[]));
--> statement-breakpoint
ALTER POLICY person_import_pending ON person
 USING (import_pending_attempt_id IS NULL OR import_pending_attempt_id::text = current_setting('app.import_attempt',true)
  OR import_pending_attempt_id = ANY((SELECT app.import_released_attempt_ids())::uuid[]));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.import_pending_employment_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(array_agg(e.id),'{}'::uuid[]) FROM public.employment e WHERE e.tenant_id=app.current_tenant_id() AND e.import_pending_attempt_id IS NOT NULL
  AND e.import_pending_attempt_id::text IS DISTINCT FROM current_setting('app.import_attempt',true)
  AND NOT EXISTS(SELECT 1 FROM app.import_attempt_release r WHERE r.attempt_id=e.import_pending_attempt_id);
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.import_pending_person_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(array_agg(p.id),'{}'::uuid[]) FROM public.person p WHERE p.tenant_id=app.current_tenant_id() AND p.import_pending_attempt_id IS NOT NULL
  AND p.import_pending_attempt_id::text IS DISTINCT FROM current_setting('app.import_attempt',true)
  AND NOT EXISTS(SELECT 1 FROM app.import_attempt_release r WHERE r.attempt_id=p.import_pending_attempt_id);
$$;
--> statement-breakpoint
-- The 9001 audit's definer readers filtered "marker IS NULL". Each is re-created with the release-aware predicate,
-- from its installed definition, after checking the exact number of predicates the 9001 audit installed. The two
-- trigger functions (import_pending_stamp, enqueue_replacement_holidays) keep "IS NULL": they react to row writes,
-- and settle's marker clear re-fires them for every staged row.
DO $$
DECLARE r record; def text; found integer;
BEGIN
 FOR r IN SELECT * FROM (VALUES
  ('app._access_workforce_list_rows(uuid[])',2),('app._home_peer_cohort(uuid,text)',2),('app.access_workforce_employment(uuid,text)',1),
  ('app.access_workforce_list_facts()',1),('app.access_workforce_picker_facts(uuid[])',1),('app.access_workforce_picker_rows(text,date,date)',1),
  ('app.agent_readiness_presence(uuid[])',2),('app.assessment_unit_exclusion_facts(uuid,uuid,uuid)',2),('app.assessment_unit_exclusion_pin(uuid)',1),
  ('app.attendance_workflow_approver_availability(uuid)',3),('app.automatic_followup_facts(text,date,uuid[],integer)',3),('app.bank_import_subjects(jsonb)',1),
  ('app.contract_admission_choices(uuid)',1),('app.eligible_delegates(uuid)',3),('app.entra_active(uuid,uuid,date)',2),('app.entra_claim(date)',1),
  ('app.entra_configure(text,uuid,text,boolean,boolean,uuid,uuid)',2),('app.import_activation_conflicts(uuid)',1),('app.onboarding_supervisors()',2),
  ('app.onehr_assignment_facts()',1),('app.onehr_employment_facts()',1),('app.onehr_unit_exclusion_choices(uuid,uuid)',1),('app.own_home_dashboard_role(uuid)',3),
  ('app.personnel_duplicate_candidate_rows(uuid[],date)',1),('app.personnel_filter_rows(date,uuid[])',2),('app.personnel_overview_filter_fields(date,uuid[])',1),
  ('app.personnel_overview_narrow_rows(date,uuid[])',1),('app.personnel_overview_page_rows(date,uuid[],uuid[])',2),('app.personnel_search_rows(uuid[])',1),
  ('app.prepare_company_organisation_run(jsonb)',2),('app.probation_intake_workspace(uuid)',4),('app.probation_required_workflow_status(uuid)',1),
  ('app.reward_confidentiality_floors(uuid,uuid[],date)',2),('app.reward_create_planned_unit_bound(uuid,uuid,uuid)',5),('app.reward_uploaded_snapshot_roster(uuid,date)',6)
 ) v(sig,expected) LOOP
  def:=pg_catalog.pg_get_functiondef(r.sig::regprocedure);
  SELECT count(*) INTO found FROM regexp_matches(def,'(\m[a-z_]+\.)?import_pending_attempt_id IS NULL','g');
  IF found<>r.expected THEN RAISE EXCEPTION 'import release predicate: % has % staged-marker filters, expected %',r.sig,found,r.expected; END IF;
  EXECUTE regexp_replace(def,'(\m[a-z_]+\.)?import_pending_attempt_id IS NULL','app.import_marker_visible(\1import_pending_attempt_id)','g');
 END LOOP;
END $$;
--> statement-breakpoint
-- Release (the visibility flip): one row, under the initiating user's freshly checked authority. The caller holds the
-- workforce write lock and has re-checked duplicate emails in the same transaction. Tenant caches keyed on the
-- Access revision and the company-organisation source epoch are invalidated here, once, as the row triggers would.
CREATE FUNCTION app.import_release(p_attempt uuid) RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id(); u uuid:=app.current_user_id(); kind_ text; companies uuid[]; staged bigint;
BEGIN
 IF t IS NULL OR u IS NULL OR p_attempt IS NULL THEN RAISE EXCEPTION 'import_release_invalid' USING ERRCODE='22023'; END IF;
 SELECT a.kind,a.company_ids INTO kind_,companies FROM public.import_attempt a WHERE a.id=p_attempt AND a.tenant_id=t AND a.created_by=u;
 IF kind_ IS DISTINCT FROM 'employee_full' OR NOT app.principal_snapshot_current() THEN RAISE EXCEPTION 'import_release_unavailable' USING ERRCODE='42501'; END IF;
 IF EXISTS(SELECT 1 FROM unnest(companies) c WHERE NOT app.import_company_access('employee_full',c,'maintain')) THEN
  RAISE EXCEPTION 'import_release_forbidden' USING ERRCODE='42501';
 END IF;
 IF EXISTS(SELECT 1 FROM app.import_attempt_release r WHERE r.attempt_id=p_attempt) THEN RAISE EXCEPTION 'import_release_repeated' USING ERRCODE='55000'; END IF;
 SELECT count(*) INTO staged FROM public.employment e WHERE e.tenant_id=t AND e.import_pending_attempt_id=p_attempt AND e.voided_at IS NULL;
 INSERT INTO app.import_attempt_release(attempt_id,tenant_id,outcome) VALUES(p_attempt,t,'activated');
 UPDATE public.access_configuration SET revision=gen_random_uuid(),updated_at=now() WHERE tenant_id=t AND initialized;
 INSERT INTO public.company_organisation_source_epoch(tenant_id,revision) VALUES(t,1)
  ON CONFLICT(tenant_id) DO UPDATE SET revision=company_organisation_source_epoch.revision+1;
 RETURN staged;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.import_release(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.import_release(uuid) TO ai_hr_app;
--> statement-breakpoint
-- Settle: clear up to p_limit markers of a released attempt per call (persons first, as activation did). Runs on the
-- worker's queue-owner connection, like discard: visibility was already decided by release, so a later loss of
-- the initiator's access can never leave markers behind. Returns how many marked rows remain.
CREATE FUNCTION app.import_settle(p_tenant uuid,p_attempt uuid,p_limit integer) RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE remaining bigint;
BEGIN
 IF p_tenant IS NULL OR p_attempt IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 5000 THEN RAISE EXCEPTION 'import_settle_invalid' USING ERRCODE='22023'; END IF;
 IF NOT app.access_workforce_storage_owner() THEN RAISE EXCEPTION 'import_settle_forbidden' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM app.import_attempt_release r WHERE r.attempt_id=p_attempt AND r.tenant_id=p_tenant) THEN
  RAISE EXCEPTION 'import_settle_unreleased' USING ERRCODE='55000';
 END IF;
 UPDATE public.person SET import_pending_attempt_id=NULL WHERE id IN (
  SELECT p.id FROM public.person p WHERE p.tenant_id=p_tenant AND p.import_pending_attempt_id=p_attempt ORDER BY p.id LIMIT p_limit);
 UPDATE public.employment SET import_pending_attempt_id=NULL WHERE id IN (
  SELECT e.id FROM public.employment e WHERE e.tenant_id=p_tenant AND e.import_pending_attempt_id=p_attempt ORDER BY e.id LIMIT p_limit);
 SELECT (SELECT count(*) FROM public.person p WHERE p.tenant_id=p_tenant AND p.import_pending_attempt_id=p_attempt)
  +(SELECT count(*) FROM public.employment e WHERE e.tenant_id=p_tenant AND e.import_pending_attempt_id=p_attempt) INTO remaining;
 IF remaining=0 THEN UPDATE app.import_attempt_release SET settled_at=coalesce(settled_at,now()) WHERE attempt_id=p_attempt; END IF;
 RETURN remaining;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.import_settle(uuid,uuid,integer) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Discard in bounded batches (ADR-0157; decided rule): each staged hire is voided and leaves employment.hired
-- followed by a void event. The void events carry the attempt's marker, so the hires, their events and the voids
-- become visible together when the last batch releases the attempt as 'discarded'. Owner connection only.
CREATE FUNCTION app.import_discard_batch(p_tenant uuid,p_attempt uuid,p_actor uuid,p_reason text,p_limit integer) RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE ids uuid[]; persons_ uuid[]; remaining bigint;
BEGIN
 IF p_tenant IS NULL OR p_attempt IS NULL OR p_actor IS NULL OR p_reason IS NULL OR length(p_reason) NOT BETWEEN 3 AND 1000
  OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 5000 THEN
  RAISE EXCEPTION 'import_discard_invalid' USING ERRCODE='22023';
 END IF;
 IF NOT app.access_workforce_storage_owner() THEN RAISE EXCEPTION 'import_discard_forbidden' USING ERRCODE='42501'; END IF;
 IF EXISTS(SELECT 1 FROM app.import_attempt_release r WHERE r.attempt_id=p_attempt AND r.outcome='activated') THEN
  RAISE EXCEPTION 'import_discard_released' USING ERRCODE='55000';
 END IF;
 PERFORM set_config('app.import_attempt',p_attempt::text,true);
 SELECT array_agg(x.id ORDER BY x.id),array_agg(DISTINCT x.person_id) INTO ids,persons_ FROM (
  SELECT e_.id,e_.person_id FROM public.employment e_ WHERE e_.tenant_id=p_tenant AND e_.import_pending_attempt_id=p_attempt AND e_.voided_at IS NULL
  ORDER BY e_.id LIMIT p_limit FOR UPDATE) x;
 IF ids IS NOT NULL THEN
  UPDATE public.person pp SET voided_at=now(),voided_ic_number=(SELECT s.ic_number FROM public.employee_statutory_my s WHERE s.person_id=pp.id AND s.tenant_id=pp.tenant_id)
   WHERE pp.id=ANY(persons_) AND pp.tenant_id=p_tenant AND pp.voided_at IS NULL;
  UPDATE public.employee_statutory_my s SET ic_number=NULL WHERE s.person_id=ANY(persons_) AND s.tenant_id=p_tenant AND s.ic_number IS NOT NULL;
  WITH voided AS (
   UPDATE public.employment emp SET voided_at=now(),voided_by=p_actor,void_reason=p_reason,voided_import_attempt_id=p_attempt,
    voided_employee_code=emp.employee_code,employee_code=NULL WHERE emp.id=ANY(ids) AND emp.tenant_id=p_tenant RETURNING emp.id,emp.voided_employee_code)
  INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload)
   SELECT p_tenant,'employment',v.id,'employment.voided','user',p_actor,v.id,
    jsonb_build_object('importAttemptId',p_attempt,'reason',p_reason,'employeeCode',v.voided_employee_code,'discarded',true) FROM voided v;
 END IF;
 SELECT count(*) INTO remaining FROM public.employment e WHERE e.tenant_id=p_tenant AND e.import_pending_attempt_id=p_attempt AND e.voided_at IS NULL;
 IF remaining=0 THEN
  -- A person and its employment are written by one chunk transaction, so an orphan staged person is impossible;
  -- void any anyway before the attempt becomes visible.
  UPDATE public.person SET voided_at=coalesce(voided_at,now()) WHERE tenant_id=p_tenant AND import_pending_attempt_id=p_attempt AND voided_at IS NULL;
  INSERT INTO app.import_attempt_release(attempt_id,tenant_id,outcome) VALUES(p_attempt,p_tenant,'discarded') ON CONFLICT(attempt_id) DO NOTHING;
 END IF;
 RETURN remaining;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.import_discard_batch(uuid,uuid,uuid,text,integer) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- The single-statement activate and discard are replaced by release + settle and the bounded discard above.
DROP FUNCTION app.import_activate(uuid);
--> statement-breakpoint
DROP FUNCTION app.import_discard(uuid,uuid,uuid,text);
--> statement-breakpoint
-- Staged audit events. Every event appended inside an import chunk carries the attempt (stamped by the database,
-- like the employment and person rows), whether or not it names an employment: person, statutory, family and
-- profile events about a staged person stay invisible until the attempt is released (activated or discarded).
ALTER TABLE domain_event ADD COLUMN import_pending_attempt_id uuid;
--> statement-breakpoint
CREATE TRIGGER domain_event_import_pending_stamp BEFORE INSERT ON domain_event FOR EACH ROW EXECUTE FUNCTION app.import_pending_stamp();
--> statement-breakpoint
-- Chain verification (core/audit-chain.ts, group administrators only) must read every chained row to prove the
-- chain; it sets app.audit_chain_verification for its own read-only statements and returns no event content.
ALTER POLICY domain_event_import_pending ON public.domain_event
 USING (import_pending_attempt_id IS NULL OR import_pending_attempt_id::text = current_setting('app.import_attempt',true)
  OR import_pending_attempt_id = ANY((SELECT app.import_released_attempt_ids())::uuid[])
  OR (current_setting('app.audit_chain_verification',true)='on' AND (SELECT app.is_group_admin())));
