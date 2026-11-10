-- Combined release allocation, 11 November 2026 (docs/MIGRATION-ALLOCATION.md): 5001_access_reader_writer_serialisers, idx 4401, when 1793330004701.
-- Draft name on its branch: 4701_access_reader_writer_serialisers. Any draft note below describes that unallocated branch position.
-- Reader/writer Access lock: narrow serialisers (wave 2, 10 November 2026).
--
-- Exclusivity on the tenant Access key was the only thing serialising these check-then-write
-- paths. Each now has its own narrow lock, so the paths can run under the shared Access lock.
--
-- Reporting line cycle and top-level checks: a tenant-scoped org-reporting lock. A per-employment
-- lock cannot serialise a cycle made from two edges that touch no common employment, and locking
-- the walked chain would deadlock. The lock is scoped to reporting-line writers only.
-- Employee code claim: a per-code lock across employment and draft reservations.
-- Profile value writers: a shared mode of the profile-edit-policy lock; only policy editors stay
-- exclusive. Leftover-row cleanup skips rows other transactions are already cleaning.

-- Value writers share the policy lock. Policy editors keep access_profile_policy_write_lock.
CREATE FUNCTION app.access_profile_policy_value_lock() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM app.access_workforce_write_lock();
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('profile-edit-policy:'||app.current_tenant_id()::text,0));
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_profile_policy_value_lock() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.access_profile_policy_value_lock() TO ai_hr_app;
--> statement-breakpoint
-- Take the reporting-line lock at statement entry, before PostgreSQL locks any matching row, so
-- a BEFORE ROW wait can never invert against a concurrent multi-row writer.
CREATE FUNCTION app.org_structure_statement_lock() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();
BEGIN
 IF t IS NOT NULL THEN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('access-configuration:'||t::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended('org-reporting:'||t::text,0));
 END IF;
 RETURN NULL;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.org_structure_statement_lock() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE TRIGGER reporting_line_org_structure_lock BEFORE INSERT OR UPDATE ON public.reporting_line
FOR EACH STATEMENT EXECUTE FUNCTION app.org_structure_statement_lock();
--> statement-breakpoint
CREATE TRIGGER org_chart_root_org_structure_lock BEFORE INSERT OR UPDATE ON public.org_chart_root
FOR EACH STATEMENT EXECUTE FUNCTION app.org_structure_statement_lock();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.check_org_chart_root()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE check_cycle boolean:=true;
BEGIN
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('access-configuration:'||NEW.tenant_id::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('org-reporting:'||NEW.tenant_id::text,0));
 IF TG_TABLE_NAME='org_chart_root' THEN
  IF NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.id=NEW.employment_id AND e.tenant_id=NEW.tenant_id) THEN RAISE EXCEPTION 'Top-level employee must belong to the same tenant'; END IF;
  IF EXISTS(SELECT 1 FROM reporting_line r WHERE r.tenant_id=NEW.tenant_id AND r.subordinate_employment_id=NEW.employment_id AND r.line_type='administrative' AND r.superseded_at IS NULL AND daterange(r.valid_from,r.valid_to,'[)') && daterange(NEW.valid_from,NEW.valid_to,'[)')) THEN
   RAISE EXCEPTION 'A top-level employee cannot also have a Direct Superior in the same date range';
  END IF;
  IF EXISTS(SELECT 1 FROM org_chart_root r WHERE r.tenant_id=NEW.tenant_id AND r.employment_id=NEW.employment_id AND r.id<>NEW.id AND daterange(r.valid_from,r.valid_to,'[)') && daterange(NEW.valid_from,NEW.valid_to,'[)')) THEN RAISE EXCEPTION 'Top-level date ranges overlap'; END IF;
 ELSE
  IF TG_OP='UPDATE' THEN
   check_cycle:=NEW.manager_employment_id IS DISTINCT FROM OLD.manager_employment_id OR NEW.subordinate_employment_id IS DISTINCT FROM OLD.subordinate_employment_id OR NEW.line_type IS DISTINCT FROM OLD.line_type OR NEW.valid_from<OLD.valid_from OR (OLD.valid_to IS NOT NULL AND (NEW.valid_to IS NULL OR NEW.valid_to>OLD.valid_to)) OR (OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS NULL);
  END IF;
  IF check_cycle AND NEW.line_type='administrative' AND NEW.superseded_at IS NULL THEN
   IF NEW.manager_employment_id=NEW.subordinate_employment_id THEN RAISE EXCEPTION 'Direct Superior cannot refer to self'; END IF;
   IF EXISTS(WITH RECURSIVE chain(manager,effective) AS (
    SELECT r.manager_employment_id,daterange(r.valid_from,r.valid_to,'[)')*daterange(NEW.valid_from,NEW.valid_to,'[)') FROM public.reporting_line r
     WHERE r.tenant_id=NEW.tenant_id AND r.subordinate_employment_id=NEW.manager_employment_id AND r.id<>NEW.id AND r.line_type='administrative' AND r.superseded_at IS NULL AND daterange(r.valid_from,r.valid_to,'[)')&&daterange(NEW.valid_from,NEW.valid_to,'[)')
    UNION SELECT r.manager_employment_id,c.effective*daterange(r.valid_from,r.valid_to,'[)') FROM public.reporting_line r JOIN chain c ON r.subordinate_employment_id=c.manager
     WHERE r.tenant_id=NEW.tenant_id AND r.id<>NEW.id AND r.line_type='administrative' AND r.superseded_at IS NULL AND c.effective&&daterange(r.valid_from,r.valid_to,'[)')
   ) SELECT 1 FROM chain WHERE manager=NEW.subordinate_employment_id) THEN RAISE EXCEPTION 'Direct Superior would create a reporting loop'; END IF;
  END IF;
  IF NEW.line_type='administrative' AND NEW.superseded_at IS NULL AND EXISTS(SELECT 1 FROM org_chart_root r WHERE r.tenant_id=NEW.tenant_id AND r.employment_id=NEW.subordinate_employment_id AND daterange(r.valid_from,r.valid_to,'[)') && daterange(NEW.valid_from,NEW.valid_to,'[)')) THEN
   RAISE EXCEPTION 'End the top-level designation before assigning a Direct Superior';
  END IF;
 END IF;
 RETURN NEW;
END $function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.employee_code_claim(p_tenant uuid, p_code text, p_exclude_employment uuid DEFAULT NULL::uuid, p_exclude_draft uuid DEFAULT NULL::uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
 IF NOT app.access_workforce_storage_owner() THEN
  PERFORM app.access_workforce_write_lock();
  IF p_tenant IS DISTINCT FROM app.current_tenant_id() OR NOT EXISTS(
   SELECT 1 FROM public.company c WHERE c.tenant_id=p_tenant AND app.access_workforce_command_company(c.id)) THEN
   RAISE EXCEPTION 'Workforce maintenance unavailable' USING ERRCODE='42501';
  END IF;
 END IF;
 -- The per-code lock, held to commit, replaces tenant-wide exclusivity across employment and draft claims.
 PERFORM pg_advisory_xact_lock(hashtextextended('employee-code:'||p_tenant::text||':'||p_code,0));
 IF EXISTS(SELECT 1 FROM public.employment e WHERE e.tenant_id=p_tenant AND e.employee_code=p_code
  AND e.id IS DISTINCT FROM p_exclude_employment) THEN RETURN 'employment'; END IF;
 IF EXISTS(SELECT 1 FROM public.employee_draft d WHERE d.tenant_id=p_tenant AND d.reserved_employee_code=p_code
  AND d.id IS DISTINCT FROM p_exclude_draft) THEN RETURN 'draft'; END IF;
 RETURN NULL;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.access_workforce_set_employee_code(p_employment uuid, p_code text, p_expected jsonb DEFAULT NULL::jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE t uuid:=app.current_tenant_id(); subject public.employment%ROWTYPE; claimant text;
BEGIN
 PERFORM app.access_workforce_write_lock();
 SELECT * INTO subject FROM public.employment e WHERE e.id=p_employment AND e.tenant_id=t FOR UPDATE;
 IF NOT FOUND OR NOT app.access_workforce_command_company(subject.company_id) THEN
  RAISE EXCEPTION 'Workforce maintenance unavailable' USING ERRCODE='42501';
 END IF;
 -- The public SQL command accepts canonical identifiers only; the shared TS format owner normalizes
 -- ordinary forms. No arbitrary column, person id, company or actor is accepted by this seam.
 IF p_code IS NULL OR p_code !~ '^[A-Z0-9-]{1,30}$' THEN RAISE EXCEPTION 'Employee ID invalid' USING ERRCODE='23514'; END IF;
 IF p_expected IS NOT NULL AND (jsonb_typeof(p_expected) NOT IN ('string','null')
  OR p_expected IS DISTINCT FROM coalesce(to_jsonb(subject.employee_code),'null'::jsonb)) THEN
  RAISE EXCEPTION 'Employee record changed' USING ERRCODE='40001';
 END IF;
 IF subject.employee_code=p_code THEN RETURN false; END IF;
 claimant:=app.employee_code_claim(t,p_code,p_employment,NULL);
 IF claimant IS NOT NULL THEN
  RAISE EXCEPTION '%','employee_code_claim_'||claimant USING ERRCODE='23505',CONSTRAINT='employee_code_claim_'||claimant;
 END IF;
 UPDATE public.employment SET employee_code=p_code WHERE id=p_employment AND tenant_id=t;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload)
 VALUES(t,'employment',p_employment,'employment.employee-code.set',
  CASE WHEN app.current_user_id() IS NULL THEN 'system'::public.actor_type ELSE 'user'::public.actor_type END,app.current_user_id(),p_employment,
  jsonb_build_object('before',jsonb_build_object('employeeCode',subject.employee_code),'after',jsonb_build_object('employeeCode',p_code)));
 RETURN true;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.access_profile_value_statement_lock()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();previous_user uuid;
BEGIN
 IF app.access_workforce_storage_owner() THEN RETURN NULL; END IF;
 PERFORM app.access_profile_policy_value_lock();
 IF u IS NULL OR NOT app.principal_snapshot_current() THEN
  RAISE EXCEPTION 'Profile write principal unavailable' USING ERRCODE='42501';
 END IF;
 -- Retained only until a later transaction in this tenant; xid8 is never a reusable 32-bit xid.
 -- No values, raw proposal hashes exposed to the application, or lasting permission are stored here.
 -- Writers now overlap, so concurrent cleanups of the same committed leftovers skip each other's rows.
 DELETE FROM app.access_profile_register_application a WHERE a.ctid IN (
  SELECT r.ctid FROM app.access_profile_register_application r JOIN app.access_profile_value_approval p
   ON r.xact_id=p.xact_id AND r.request_id=p.request_id
  WHERE p.tenant_id=t AND p.xact_id<>pg_current_xact_id() FOR UPDATE OF r SKIP LOCKED);
 DELETE FROM app.access_workforce_value_intent x WHERE x.ctid IN (
  SELECT r.ctid FROM app.access_workforce_value_intent r WHERE r.tenant_id=t AND r.xact_id<>pg_current_xact_id() FOR UPDATE SKIP LOCKED);
 DELETE FROM app.access_profile_value_approval x WHERE x.ctid IN (
  SELECT r.ctid FROM app.access_profile_value_approval r WHERE r.tenant_id=t AND r.xact_id<>pg_current_xact_id() FOR UPDATE SKIP LOCKED);
 DELETE FROM app.access_profile_value_actor x WHERE x.ctid IN (
  SELECT r.ctid FROM app.access_profile_value_actor r WHERE r.tenant_id=t AND r.xact_id<>pg_current_xact_id() FOR UPDATE SKIP LOCKED);
 INSERT INTO app.access_profile_value_actor VALUES(pg_current_xact_id(),t,u) ON CONFLICT DO NOTHING;
 SELECT user_id INTO previous_user FROM app.access_profile_value_actor WHERE xact_id=pg_current_xact_id() AND tenant_id=t;
 IF previous_user IS DISTINCT FROM u THEN RAISE EXCEPTION 'Profile write principal changed' USING ERRCODE='42501'; END IF;
 RETURN NULL;
END; $function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.profile_direct_begin(p_subject uuid, p_proposal jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE e public.employment;f jsonb;bound record;
BEGIN
 PERFORM app.access_profile_policy_value_lock();
 SELECT * INTO e FROM public.employment WHERE id=p_subject AND tenant_id=app.current_tenant_id() AND app.access_profile_request_own(person_id) FOR UPDATE;
 IF NOT FOUND OR NOT app.principal_snapshot_current() OR e.blacklisted_at IS NOT NULL OR e.hired_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
  OR LEAST(e.resignation_date,e.last_working_date,e.terminated_on)<(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
  OR jsonb_typeof(p_proposal) IS DISTINCT FROM 'object' OR p_proposal->'v' IS DISTINCT FROM '2'::jsonb
  OR jsonb_typeof(p_proposal->'fields') IS DISTINCT FROM 'array' OR jsonb_typeof(p_proposal->'registers') IS DISTINCT FROM 'array'
  OR pg_column_size(p_proposal)>128000 OR jsonb_array_length(p_proposal->'fields')>128 OR jsonb_array_length(p_proposal->'registers')>64 THEN
  RAISE EXCEPTION 'Direct profile change unavailable' USING ERRCODE='42501';END IF;
 FOR f IN SELECT value FROM jsonb_array_elements(p_proposal->'fields') UNION ALL
  SELECT c FROM jsonb_array_elements(p_proposal->'registers') r CROSS JOIN LATERAL jsonb_array_elements(r->'fields') c
 LOOP
  SELECT * INTO bound FROM app.access_profile_value_bindings() WHERE field_id=f->>'fieldId';
  IF NOT FOUND OR NOT app.access_profile_value_editable(bound.field_id) OR app.profile_field_requires_approval(bound.field_id) OR NOT f ? 'value' THEN
   RAISE EXCEPTION 'Direct profile field unavailable' USING ERRCODE='42501';END IF;
 END LOOP;
 DELETE FROM app.profile_direct_intent x WHERE x.ctid IN (
  SELECT r.ctid FROM app.profile_direct_intent r WHERE r.tenant_id=e.tenant_id AND r.xact_id<>pg_current_xact_id() FOR UPDATE SKIP LOCKED);
 DELETE FROM app.profile_direct_register x WHERE x.ctid IN (
  SELECT r.ctid FROM app.profile_direct_register r WHERE r.tenant_id=e.tenant_id AND r.xact_id<>pg_current_xact_id() FOR UPDATE SKIP LOCKED);
 INSERT INTO app.profile_direct_intent(xact_id,tenant_id,user_id,employment_id,person_id,proposal)
 VALUES(pg_current_xact_id(),e.tenant_id,app.current_user_id(),e.id,e.person_id,p_proposal);
END;$function$;
