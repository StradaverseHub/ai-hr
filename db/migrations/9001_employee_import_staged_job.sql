-- UNALLOCATED DRAFT on branch claude/import-staged-job-20261110 (phase 1 of the Access-lock / staged-import design):
-- not a reservation, not an installation allocation. The journal position (idx 9001, when 1793330090001) exists
-- only so this branch's schema is executable and reviewable; the integration owner assigns the final
-- tag/idx/when after the freshly verified ledger, per docs/MIGRATION-ALLOCATION.md. Discard this file's
-- position, not its bytes, at integration.
--
-- Staged employee import. Imported rows are written in many short transactions but stay invisible to every
-- normal session (restrictive policy below) until one short activation clears the marker.
-- app.import_attempt is a transaction-local GUC set only by the import worker's chunk transaction.
ALTER TABLE employment ADD COLUMN import_pending_attempt_id uuid;
--> statement-breakpoint
ALTER TABLE person ADD COLUMN import_pending_attempt_id uuid;
--> statement-breakpoint
CREATE INDEX employment_import_pending_idx ON employment(tenant_id,import_pending_attempt_id) WHERE import_pending_attempt_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX person_import_pending_idx ON person(tenant_id,import_pending_attempt_id) WHERE import_pending_attempt_id IS NOT NULL;
--> statement-breakpoint
-- RESTRICTIVE: ANDed with employment_rls/person_rls and the reader-role permissive policies, for every role
-- subject to RLS. The owner and BYPASSRLS roles are not subject to it; their readers are audited in app.*.
CREATE POLICY employment_import_pending ON employment AS RESTRICTIVE FOR ALL
 USING (import_pending_attempt_id IS NULL OR import_pending_attempt_id::text = current_setting('app.import_attempt',true));
--> statement-breakpoint
CREATE POLICY person_import_pending ON person AS RESTRICTIVE FOR ALL
 USING (import_pending_attempt_id IS NULL OR import_pending_attempt_id::text = current_setting('app.import_attempt',true));
--> statement-breakpoint
-- Every row inserted inside an import chunk is stamped by the database, never by each writer.
CREATE FUNCTION app.import_pending_stamp() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE attempt uuid:=nullif(current_setting('app.import_attempt',true),'')::uuid;
BEGIN
 IF attempt IS NOT NULL AND NEW.import_pending_attempt_id IS NULL THEN NEW.import_pending_attempt_id:=attempt; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.import_pending_stamp() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.import_pending_stamp() TO ai_hr_app;
--> statement-breakpoint
CREATE TRIGGER employment_import_pending_stamp BEFORE INSERT ON employment FOR EACH ROW EXECUTE FUNCTION app.import_pending_stamp();
--> statement-breakpoint
CREATE TRIGGER person_import_pending_stamp BEFORE INSERT ON person FOR EACH ROW EXECUTE FUNCTION app.import_pending_stamp();
--> statement-breakpoint
-- Only the owner-run activate/discard definers may clear or change the marker (current_user is the definer's owner there).
CREATE FUNCTION app.import_pending_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.import_pending_attempt_id IS NOT DISTINCT FROM OLD.import_pending_attempt_id THEN RETURN NEW; END IF;
 IF current_user=(SELECT pg_catalog.pg_get_userbyid(c.relowner) FROM pg_catalog.pg_class c WHERE c.oid=TG_RELID) THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'import_pending_column_forbidden' USING ERRCODE='42501';
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.import_pending_guard() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.import_pending_guard() TO ai_hr_app;
--> statement-breakpoint
CREATE TRIGGER employment_import_pending_guard BEFORE UPDATE OF import_pending_attempt_id ON employment FOR EACH ROW EXECUTE FUNCTION app.import_pending_guard();
--> statement-breakpoint
CREATE TRIGGER person_import_pending_guard BEFORE UPDATE OF import_pending_attempt_id ON person FOR EACH ROW EXECUTE FUNCTION app.import_pending_guard();
--> statement-breakpoint
-- Activation: one UPDATE per table, one short transaction, under the initiating user's fresh authority.
-- Definer because the activating session's RLS cannot be asked to read rows it just made visible, and to clear the marker past the guard.
CREATE FUNCTION app.import_activate(p_attempt uuid) RETURNS TABLE(persons bigint,employments bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id(); u uuid:=app.current_user_id(); kind_ text; companies uuid[]; p bigint; e bigint;
BEGIN
 IF t IS NULL OR u IS NULL OR p_attempt IS NULL THEN RAISE EXCEPTION 'import_activate_invalid' USING ERRCODE='22023'; END IF;
 SELECT a.kind,a.company_ids INTO kind_,companies FROM public.import_attempt a WHERE a.id=p_attempt AND a.tenant_id=t AND a.created_by=u;
 IF kind_ IS DISTINCT FROM 'employee_full' OR NOT app.principal_snapshot_current() THEN RAISE EXCEPTION 'import_activate_unavailable' USING ERRCODE='42501'; END IF;
 IF EXISTS(SELECT 1 FROM unnest(companies) c WHERE NOT app.import_company_access('employee_full',c,'maintain')) THEN
  RAISE EXCEPTION 'import_activate_forbidden' USING ERRCODE='42501';
 END IF;
 -- A plain update fires the real triggers (access writers, label, epoch, replacement holiday, Entra dirty, ...).
 UPDATE public.person SET import_pending_attempt_id=NULL WHERE tenant_id=t AND import_pending_attempt_id=p_attempt;
 GET DIAGNOSTICS p=ROW_COUNT;
 UPDATE public.employment SET import_pending_attempt_id=NULL WHERE tenant_id=t AND import_pending_attempt_id=p_attempt;
 GET DIAGNOSTICS e=ROW_COUNT;
 RETURN QUERY SELECT p,e;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.import_activate(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.import_activate(uuid) TO ai_hr_app;
--> statement-breakpoint
-- Activation-time duplicate-email conflicts against persons that became visible since validation (one active
-- job per tenant makes pending-vs-pending conflicts impossible). Reads as definer: must see every person.
CREATE FUNCTION app.import_activation_conflicts(p_attempt uuid) RETURNS TABLE(employment_id uuid,email text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT e.id,p.primary_email FROM public.employment e JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
 WHERE e.tenant_id=app.current_tenant_id() AND e.import_pending_attempt_id=p_attempt AND app.principal_snapshot_current()
  AND NOT coalesce((SELECT allow_duplicated_email FROM app.people_general_read()),false)
  AND EXISTS(SELECT 1 FROM public.person o WHERE o.tenant_id=p.tenant_id AND o.id<>p.id AND o.voided_at IS NULL
   AND o.import_pending_attempt_id IS NULL AND lower(btrim(o.primary_email))=lower(btrim(p.primary_email)));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.import_activation_conflicts(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.import_activation_conflicts(uuid) TO ai_hr_app;
--> statement-breakpoint
-- Discard: per ADR-0157 and the decided rule, the staged hires leave employment.hired followed by a void event.
-- Runs only from the worker's owner connection (session_user owner, so the void guards' repair authority applies
-- and a revoked initiator can never leave staged rows behind). The marker is cleared here: voided_at takes over.
CREATE FUNCTION app.import_discard(p_tenant uuid,p_attempt uuid,p_actor uuid,p_reason text) RETURNS TABLE(employments bigint,persons bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE e bigint; p bigint; ids uuid[]; persons_ uuid[];
BEGIN
 IF p_tenant IS NULL OR p_attempt IS NULL OR p_actor IS NULL OR p_reason IS NULL OR length(p_reason) NOT BETWEEN 3 AND 1000 THEN
  RAISE EXCEPTION 'import_discard_invalid' USING ERRCODE='22023';
 END IF;
 IF NOT app.access_workforce_storage_owner() THEN RAISE EXCEPTION 'import_discard_forbidden' USING ERRCODE='42501'; END IF;
 SELECT array_agg(x.id ORDER BY x.id),array_agg(DISTINCT x.person_id) INTO ids,persons_ FROM (
  SELECT e_.id,e_.person_id FROM public.employment e_ WHERE e_.tenant_id=p_tenant AND e_.import_pending_attempt_id=p_attempt AND e_.voided_at IS NULL ORDER BY e_.id FOR UPDATE) x;
 IF ids IS NOT NULL THEN
  UPDATE public.person pp SET voided_at=now(),voided_ic_number=(SELECT s.ic_number FROM public.employee_statutory_my s WHERE s.person_id=pp.id AND s.tenant_id=pp.tenant_id)
   WHERE pp.id=ANY(persons_) AND pp.tenant_id=p_tenant;
  UPDATE public.employee_statutory_my s SET ic_number=NULL WHERE s.person_id=ANY(persons_) AND s.tenant_id=p_tenant AND s.ic_number IS NOT NULL;
  WITH voided AS (
   UPDATE public.employment emp SET voided_at=now(),voided_by=p_actor,void_reason=p_reason,voided_import_attempt_id=p_attempt,
    voided_employee_code=emp.employee_code,employee_code=NULL WHERE emp.id=ANY(ids) AND emp.tenant_id=p_tenant RETURNING emp.id,emp.voided_employee_code)
  INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload)
   SELECT p_tenant,'employment',v.id,'employment.voided','user',p_actor,v.id,
    jsonb_build_object('importAttemptId',p_attempt,'reason',p_reason,'employeeCode',v.voided_employee_code,'discarded',true) FROM voided v;
 END IF;
 -- Orphan persons stamped pending (a crash between the person and employment inserts is impossible: one chunk tx).
 UPDATE public.person SET voided_at=coalesce(voided_at,now()),import_pending_attempt_id=NULL WHERE tenant_id=p_tenant AND import_pending_attempt_id=p_attempt;
 GET DIAGNOSTICS p=ROW_COUNT;
 UPDATE public.employment SET import_pending_attempt_id=NULL WHERE tenant_id=p_tenant AND import_pending_attempt_id=p_attempt;
 GET DIAGNOSTICS e=ROW_COUNT;
 RETURN QUERY SELECT e,p;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.import_discard(uuid,uuid,uuid,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Workforce chokepoints (latest: 0676). Pending rows are visible only to the import session itself.
CREATE OR REPLACE FUNCTION app.access_workforce_employment(p_employment uuid,p_capability text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.employment e WHERE e.id=p_employment AND e.tenant_id=app.current_tenant_id()
  AND e.voided_at IS NULL AND (e.import_pending_attempt_id IS NULL OR e.import_pending_attempt_id::text=current_setting('app.import_attempt',true))
  AND app.access_workforce_company(e.company_id,p_capability));
$$;
--> statement-breakpoint
-- Durable job. Same admission, ownership and fresh-authority shape as bank_import_job (0685).
CREATE TABLE employee_import_job (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),created_by uuid NOT NULL REFERENCES app_user(id),
 context jsonb NOT NULL,operation_key uuid NOT NULL,company_id uuid NOT NULL REFERENCES company(id),company_ids uuid[] NOT NULL DEFAULT '{}',
 source_name text NOT NULL CHECK(length(source_name)<=255),source_hash text NOT NULL CHECK(source_hash~'^[0-9a-f]{64}$'),
 source_bytes integer NOT NULL CHECK(source_bytes BETWEEN 1 AND 10485760),source_content bytea,
 input jsonb,attempt_id uuid REFERENCES import_attempt(id),
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','validating','importing','activating','discarding','completed','failed')),
 phase text CHECK(phase IN ('employees','superiors','registers','activation')),
 total integer NOT NULL DEFAULT 0 CHECK(total>=0),valid integer NOT NULL DEFAULT 0,invalid integer NOT NULL DEFAULT 0,
 steps_total integer NOT NULL DEFAULT 0 CHECK(steps_total>=0),steps_done integer NOT NULL DEFAULT 0 CHECK(steps_done>=0),
 imported integer NOT NULL DEFAULT 0 CHECK(imported>=0),
 transient_retries integer NOT NULL DEFAULT 0,chunks integer NOT NULL DEFAULT 0,max_chunk_ms integer NOT NULL DEFAULT 0,activation_ms integer,
 plan jsonb,result jsonb,error text,errors jsonb NOT NULL DEFAULT '[]',
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,created_by,operation_key)
);
--> statement-breakpoint
-- One import applying per tenant at a time: all-or-nothing and duplicate checks stay exact, as the old exclusive lock made them.
CREATE UNIQUE INDEX employee_import_job_one_active ON employee_import_job(tenant_id) WHERE state IN ('queued','validating','importing','activating','discarding');
--> statement-breakpoint
CREATE INDEX employee_import_job_queue ON employee_import_job(updated_at,created_at) WHERE state IN ('queued','validating','importing','activating','discarding');
--> statement-breakpoint
CREATE TABLE employee_import_step (
 job_id uuid NOT NULL REFERENCES employee_import_job(id) ON DELETE CASCADE,tenant_id uuid NOT NULL REFERENCES tenant(id),
 seq integer NOT NULL CHECK(seq>=0),kind text NOT NULL CHECK(kind IN ('employee','superior','register')),row_num integer,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','applied')),
 payload jsonb NOT NULL,employment_id uuid,person_id uuid,error text,PRIMARY KEY(job_id,seq)
);
--> statement-breakpoint
CREATE INDEX employee_import_step_pending ON employee_import_step(job_id,seq) WHERE state='pending';
--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE,DELETE ON employee_import_job,employee_import_step TO ai_hr_app;
--> statement-breakpoint
ALTER TABLE employee_import_job ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE employee_import_step ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Same captured-grants and fresh-authority shape as bank_import_job (0685); these functions are kind-independent.
CREATE TRIGGER employee_import_job_context BEFORE INSERT ON employee_import_job FOR EACH ROW EXECUTE FUNCTION app.bank_import_job_context();
--> statement-breakpoint
CREATE FUNCTION app.employee_import_job_access(wanted uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.employee_import_job j WHERE j.id=wanted AND j.tenant_id=app.current_tenant_id()
 AND j.created_by=app.current_user_id() AND app.bank_import_context_current(j.context)
 AND NOT EXISTS(SELECT 1 FROM unnest(j.company_ids) c WHERE NOT app.import_company_access('employee_full',c,'view')));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.employee_import_job_access(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.employee_import_job_access(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE POLICY employee_import_job_read ON employee_import_job FOR SELECT USING(tenant_id=app.current_tenant_id() AND created_by=app.current_user_id() AND app.bank_import_context_current(context) AND NOT EXISTS(SELECT 1 FROM unnest(company_ids) c WHERE NOT app.import_company_access('employee_full',c,'view')));
--> statement-breakpoint
CREATE POLICY employee_import_job_insert ON employee_import_job FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND created_by=app.current_user_id() AND app.principal_snapshot_current());
--> statement-breakpoint
CREATE POLICY employee_import_job_update ON employee_import_job FOR UPDATE USING(app.employee_import_job_access(id)) WITH CHECK(app.employee_import_job_access(id));
--> statement-breakpoint
CREATE POLICY employee_import_step_read ON employee_import_step FOR SELECT USING(app.employee_import_job_access(job_id));
--> statement-breakpoint
CREATE POLICY employee_import_step_write ON employee_import_step FOR INSERT WITH CHECK(app.employee_import_job_access(job_id) AND tenant_id=app.current_tenant_id());
--> statement-breakpoint
CREATE POLICY employee_import_step_update ON employee_import_step FOR UPDATE USING(app.employee_import_job_access(job_id)) WITH CHECK(app.employee_import_job_access(job_id));
--> statement-breakpoint
CREATE POLICY employee_import_step_delete ON employee_import_step FOR DELETE USING(app.employee_import_job_access(job_id));

--> statement-breakpoint
-- Audit fixes (see phase-1 audit): enumerators and pickers that must never reach a pending row. Definer functions
-- bypass the restrictive policy, so each is filtered explicitly (same shape as the 0676 voided_at chokepoints).
-- Reservation/uniqueness readers (employee_code_claim, card_identifier_*, create_login_person, people_nric_*) intentionally stay unfiltered.
--> statement-breakpoint
-- app._access_workforce_list_rows(uuid[]) [V:2]
CREATE OR REPLACE FUNCTION app._access_workforce_list_rows(subject_ids uuid[])
 RETURNS SETOF jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
WITH permitted AS MATERIALIZED (
  SELECT c.id FROM public.company c WHERE c.tenant_id=app.current_tenant_id() AND app.access_workforce_projection_company(c.id)
 )
 SELECT jsonb_build_object(
  'employmentId',e.id,'name',p.full_name,'email',p.primary_email,'employeeCode',e.employee_code,
  'department',COALESCE(NULLIF(btrim(d.label),''),d.name),'departmentId',a.department_id,
  'position',COALESCE(NULLIF(btrim(pos.label),''),pos.title),'company',co.legal_name,'companyId',e.company_id,
  'hiredOn',e.hired_on,'terminatedOn',e.terminated_on,'confirmationDate',e.confirmation_date,
  'finalConfirmationDate',e.final_confirmation_date,'probationEndDate',e.probation_end_date,
  'provisionalEndOn',e.provisional_end_on,'resignationDate',e.resignation_date,'lastWorkingDate',e.last_working_date,
  'blacklistedAt',e.blacklisted_at,'jobGrade',g.name,'employmentType',a.employment_type,
  'businessUnit',COALESCE(NULLIF(btrim(bu.label),''),bu.code),'costCenter',cc.name,'workLocation',loc.name,
  'joinDate',e.join_date,'reportingTo',(
   SELECT mp.full_name FROM public.reporting_line rl
   JOIN public.employment me ON me.id=rl.manager_employment_id AND me.tenant_id=rl.tenant_id AND me.voided_at IS NULL AND me.import_pending_attempt_id IS NULL
   JOIN permitted manager_scope ON manager_scope.id=me.company_id
   JOIN public.person mp ON mp.id=me.person_id AND mp.tenant_id=me.tenant_id
   WHERE rl.tenant_id=e.tenant_id AND rl.subordinate_employment_id=e.id AND rl.line_type='administrative'
    AND rl.valid_to IS NULL AND rl.superseded_at IS NULL ORDER BY rl.valid_from DESC,rl.id LIMIT 1))
 FROM (
    SELECT * FROM public.employment WHERE subject_ids IS NULL
    UNION ALL
    SELECT * FROM public.employment WHERE subject_ids IS NOT NULL AND id=ANY(subject_ids)
   )e JOIN permitted allowed ON allowed.id=e.company_id
 JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
 JOIN public.company co ON co.id=e.company_id AND co.tenant_id=e.tenant_id
 LEFT JOIN public.assignment a ON a.employment_id=e.id AND a.tenant_id=e.tenant_id AND a.valid_to IS NULL AND a.superseded_at IS NULL
 LEFT JOIN public.department d ON d.id=a.department_id AND d.tenant_id=e.tenant_id
 LEFT JOIN public.position pos ON pos.id=a.position_id AND pos.tenant_id=e.tenant_id
 LEFT JOIN public.job_grade g ON g.id=e.grade_id AND g.tenant_id=e.tenant_id
 LEFT JOIN public.business_unit bu ON bu.id=a.business_unit_id AND bu.tenant_id=e.tenant_id
 LEFT JOIN public.cost_center cc ON cc.id=a.cost_center_id AND cc.tenant_id=e.tenant_id
 LEFT JOIN public.location loc ON loc.id=a.location_id AND loc.tenant_id=e.tenant_id
 WHERE e.tenant_id=app.current_tenant_id() AND e.voided_at IS NULL AND e.import_pending_attempt_id IS NULL AND (subject_ids IS NULL OR e.id=ANY(subject_ids));
$function$;

--> statement-breakpoint
-- app.access_workforce_list_facts() [V:1]
CREATE OR REPLACE FUNCTION app.access_workforce_list_facts()
 RETURNS TABLE(employment_id uuid, name text, email text, employee_code text, company text, company_id uuid, department_id uuid, employment_type text, terminated_on date, final_confirmation_date date, confirmation_date date, probation_end_date date, provisional_end_on date, resignation_date date, last_working_date date, blacklisted_at date)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
 WITH permitted AS MATERIALIZED (
  SELECT c.id FROM public.company c WHERE c.tenant_id=app.current_tenant_id() AND app.access_workforce_projection_company(c.id)
 )
 SELECT e.id,p.full_name,p.primary_email,e.employee_code,co.legal_name,e.company_id,a.department_id,a.employment_type::text,
  e.terminated_on,e.final_confirmation_date,e.confirmation_date,e.probation_end_date,e.provisional_end_on,
  e.resignation_date,e.last_working_date,e.blacklisted_at
 FROM public.employment e JOIN permitted allowed ON allowed.id=e.company_id
 JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
 JOIN public.company co ON co.id=e.company_id AND co.tenant_id=e.tenant_id
 LEFT JOIN public.assignment a ON a.employment_id=e.id AND a.tenant_id=e.tenant_id AND a.valid_to IS NULL AND a.superseded_at IS NULL
 WHERE e.tenant_id=app.current_tenant_id() AND e.voided_at IS NULL AND e.import_pending_attempt_id IS NULL;
$function$;

--> statement-breakpoint
-- app.access_workforce_picker_facts(uuid[]) [V:1]
CREATE OR REPLACE FUNCTION app.access_workforce_picker_facts(wanted_companies uuid[])
 RETURNS TABLE(employment_id uuid, name text, employee_code text, company_id uuid, company text, department text, terminated_on date)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
 WITH permitted AS MATERIALIZED (
  SELECT c.id FROM public.company c
  WHERE c.tenant_id=app.current_tenant_id()
   AND (wanted_companies IS NULL OR c.id=ANY(wanted_companies))
   AND app.access_workforce_projection_company(c.id)
 )
 SELECT e.id,p.full_name,e.employee_code,e.company_id,co.legal_name,
  COALESCE(NULLIF(btrim(d.label),''),d.name),e.terminated_on
 FROM public.employment e JOIN permitted allowed ON allowed.id=e.company_id
 JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
 JOIN public.company co ON co.id=e.company_id AND co.tenant_id=e.tenant_id
 LEFT JOIN public.assignment a ON a.employment_id=e.id AND a.tenant_id=e.tenant_id AND a.valid_to IS NULL AND a.superseded_at IS NULL
 LEFT JOIN public.department d ON d.id=a.department_id AND d.tenant_id=e.tenant_id
 WHERE e.tenant_id=app.current_tenant_id() AND e.voided_at IS NULL AND e.import_pending_attempt_id IS NULL;
$function$;

--> statement-breakpoint
-- app.personnel_search_rows(uuid[]) [V:1]
CREATE OR REPLACE FUNCTION app.personnel_search_rows(p_scope uuid[])
 RETURNS SETOF jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app'
AS $function$
 WITH permitted_companies AS MATERIALIZED (
   SELECT c.id
   FROM public.company c
   WHERE c.tenant_id=app.current_tenant_id()
     AND c.id=ANY(p_scope)
     AND app.access_workforce_projection_company(c.id)
 ),
 -- Fence the scoped candidates before the dated resolver, which can raise for hidden rows.
 candidates AS MATERIALIZED (
   SELECT e.id,e.person_id,e.tenant_id,e.company_id,e.employee_code,e.xmin::text employment_revision,
          p.full_name,p.primary_email,p.xmin::text person_revision
   FROM public.employment e
   JOIN permitted_companies allowed ON allowed.id=e.company_id
   JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
   WHERE e.tenant_id=app.current_tenant_id() AND e.voided_at IS NULL AND e.import_pending_attempt_id IS NULL
 ),
 tagged AS MATERIALIZED (
   SELECT c.*,COALESCE((app.employment_organisation_tags(c.id,(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)->>'companyId')::uuid,c.company_id) dated_company_id
   FROM candidates c
 ),
 admitted AS MATERIALIZED (
   SELECT t.* FROM tagged t JOIN permitted_companies allowed ON allowed.id=t.dated_company_id
 ),
 identity_companies AS MATERIALIZED (
   SELECT d.dated_company_id
   FROM (SELECT DISTINCT dated_company_id FROM admitted) d
   WHERE app.personnel_identity_search_permitted(d.dated_company_id)
 )
 SELECT jsonb_build_object('employmentId',a.id,'companyId',a.dated_company_id,
   'name',a.full_name,'email',a.primary_email,'employeeCode',a.employee_code,
   'personRevision',a.person_revision,'employmentRevision',a.employment_revision,
   'identityRevision',s.xmin::text,'icNumber',s.ic_number,'passportNumber',s.passport_number)
 FROM admitted a
 LEFT JOIN identity_companies allowed ON allowed.dated_company_id=a.dated_company_id
 LEFT JOIN public.employee_statutory_my s ON s.person_id=a.person_id AND s.tenant_id=a.tenant_id
   AND allowed.dated_company_id IS NOT NULL
$function$;

--> statement-breakpoint
-- app.personnel_overview_narrow_rows(date,uuid[]) [V:1]
CREATE OR REPLACE FUNCTION app.personnel_overview_narrow_rows(p_as_of date, p_scope uuid[])
 RETURNS SETOF jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app'
AS $function$
 WITH permitted_companies AS MATERIALIZED (
   SELECT c.id FROM public.company c
   WHERE c.tenant_id=app.current_tenant_id() AND app.access_workforce_projection_company(c.id)
 ),
 -- Caller-selected companies constrain the starting rows only. Permissions for the dated
 -- company, hierarchy and manager are checked against the entire tenant's allowed set.
 candidates AS MATERIALIZED (
   SELECT jsonb_build_object('employmentId',e.id,'name',p.full_name,'email',p.primary_email,
      'employeeCode',e.employee_code,'finalConfirmationDate',e.final_confirmation_date,
      'confirmationDate',e.confirmation_date,'probationEndDate',e.probation_end_date,
      'provisionalEndOn',e.provisional_end_on,'resignationDate',e.resignation_date,
      'lastWorkingDate',e.last_working_date,'terminatedOn',e.terminated_on,
      'blacklistedAt',e.blacklisted_at) AS value,
      e.id,e.tenant_id,e.company_id,e.hired_on,e.grade_id,e.confirmation_date,e.final_confirmation_date
   FROM public.employment e
   JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
   JOIN permitted_companies pc ON pc.id=e.company_id
   WHERE e.tenant_id=app.current_tenant_id() AND e.voided_at IS NULL AND e.import_pending_attempt_id IS NULL
     AND pc.id=ANY(p_scope)
 ),
 -- Fence the scoped candidates before the raising resolver, then retain its result once per row.
 future_correction_presence AS MATERIALIZED (
   SELECT EXISTS (
     SELECT 1 FROM public.domain_event ev
     WHERE ev.tenant_id=app.current_tenant_id() AND ev.event_type='employment.information.corrected'
       AND ev.payload->>'effectiveOn'>p_as_of::text
   ) AS present
 ),
 dated AS MATERIALIZED (
   SELECT b.*,a.business_unit_id AS legacy_business_unit_id,a.department_id,a.position_id,a.employment_type,
          coalesce(c.previous_company,a.company_id,b.company_id) AS dated_company
   FROM candidates b
   CROSS JOIN future_correction_presence presence
   LEFT JOIN LATERAL (
     SELECT nullif(ev.payload->'before'->>'companyId','')::uuid AS previous_company
     FROM public.domain_event ev
     WHERE presence.present AND ev.tenant_id=b.tenant_id AND ev.subject_employment_id=b.id
       AND ev.event_type='employment.information.corrected' AND ev.payload->>'effectiveOn'>p_as_of::text
     ORDER BY ev.sequence LIMIT 1
   ) c ON true
   LEFT JOIN public.assignment a ON a.tenant_id=b.tenant_id AND a.employment_id=b.id
     AND a.superseded_at IS NULL AND a.valid_from<=p_as_of AND (a.valid_to IS NULL OR a.valid_to>p_as_of)
 ),
 current_principal AS MATERIALIZED (
   SELECT app.principal_snapshot_current() AS allowed
 ),
 company_tags AS MATERIALIZED (
   SELECT pc.id,app.company_org_tags_unchecked(pc.id,p_as_of) AS tags
   FROM permitted_companies pc
   WHERE p_as_of IS NOT NULL AND isfinite(p_as_of)
     AND (SELECT allowed FROM current_principal)
     AND EXISTS (SELECT 1 FROM dated d WHERE d.dated_company=pc.id)
 ),
 tagged AS MATERIALIZED (
   SELECT d.value,d.id,d.tenant_id,d.company_id,d.hired_on,d.grade_id,
          d.confirmation_date,d.final_confirmation_date,
          d.legacy_business_unit_id,d.department_id,d.position_id,d.employment_type,
          CASE
            WHEN t.tags->>'companyId' IS DISTINCT FROM d.dated_company::text OR t.tags IS NULL
              THEN app.employment_organisation_tags(d.id,p_as_of)
            WHEN t.tags->>'status'='legacy' THEN t.tags||jsonb_build_object('businessUnitId',d.legacy_business_unit_id)
            ELSE coalesce(recorded.tags,t.tags)
          END AS tags
   FROM dated d
   LEFT JOIN company_tags t ON t.id=d.dated_company
   LEFT JOIN LATERAL (
     SELECT c.tags
     FROM public.employment_organisation_classification c
     JOIN public.company_organisation_run r ON r.id=c.mapping_version_id AND r.tenant_id=c.tenant_id
     WHERE t.tags IS NOT NULL AND t.tags->>'status' IS DISTINCT FROM 'legacy'
       AND c.tenant_id=d.tenant_id AND c.employment_id=d.id AND c.company_id=d.dated_company
       AND c.effective_on<=p_as_of AND r.state='published' AND NOT EXISTS (
         SELECT 1 FROM public.company_organisation_mapping m
         JOIN public.company_organisation_run newer ON newer.id=m.run_id AND newer.tenant_id=m.tenant_id
         WHERE m.tenant_id=d.tenant_id AND m.company_id=d.dated_company AND newer.state='published'
           AND newer.effective_on>c.effective_on AND newer.effective_on<=p_as_of
       )
     ORDER BY c.effective_on DESC,c.created_at DESC,c.id DESC LIMIT 1
   ) recorded ON true
 ),
 visible AS MATERIALIZED (
   SELECT b.value,b.id,b.tenant_id,b.hired_on,b.grade_id,b.confirmation_date,b.final_confirmation_date,
          b.department_id,b.position_id,b.employment_type,b.tags,
          dated.id AS dated_company_id,
          CASE WHEN b.tags->>'status' IN ('ready','pending') THEN (b.tags->>'businessUnitId')::uuid
            ELSE b.legacy_business_unit_id END AS dated_bu_id
   FROM tagged b
   JOIN permitted_companies dated ON dated.id=COALESCE((b.tags->>'companyId')::uuid,b.company_id)

 )
 SELECT v.value||jsonb_build_object(
   'companyId',v.dated_company_id,'company',co.legal_name,
   'departmentId',v.department_id,'employmentType',v.employment_type,
   'businessUnitId',v.dated_bu_id,'businessUnit',bu.name,
   'positionId',v.position_id,'position',COALESCE(NULLIF(btrim(pos.label),''),pos.title)
 )
 FROM visible v
 JOIN public.company co ON co.id=v.dated_company_id AND co.tenant_id=v.tenant_id
 LEFT JOIN public.business_unit bu ON bu.id=v.dated_bu_id AND bu.tenant_id=v.tenant_id
 LEFT JOIN public.position pos ON pos.id=v.position_id AND pos.tenant_id=v.tenant_id
$function$;

--> statement-breakpoint
-- app.personnel_overview_filter_fields(date,uuid[]) [V:1]
CREATE OR REPLACE FUNCTION app.personnel_overview_filter_fields(p_as_of date, p_scope uuid[])
 RETURNS TABLE("employmentId" uuid, name text, email text, "employeeCode" text, "finalConfirmationDate" date, "confirmationDate" date, "probationEndDate" date, "provisionalEndOn" date, "resignationDate" date, "lastWorkingDate" date, "terminatedOn" date, "blacklistedAt" date, "companyId" uuid, company text, "departmentId" uuid, "employmentType" text, "businessUnitId" uuid, "businessUnit" text, "positionId" uuid, "position" text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app'
AS $function$
 WITH permitted_companies AS MATERIALIZED (
   SELECT c.id FROM public.company c
   WHERE c.tenant_id=app.current_tenant_id() AND app.access_workforce_projection_company(c.id)
 ),
 -- Caller-selected companies constrain the starting rows only. Permissions for the dated
 -- company, hierarchy and manager are checked against the entire tenant's allowed set.
 candidates AS MATERIALIZED (
   SELECT p.full_name AS name,p.primary_email AS email,e.employee_code,
      e.probation_end_date,e.provisional_end_on,e.resignation_date,e.last_working_date,e.terminated_on,e.blacklisted_at,
      e.id,e.tenant_id,e.company_id,e.hired_on,e.grade_id,e.confirmation_date,e.final_confirmation_date
   FROM public.employment e
   JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
   JOIN permitted_companies pc ON pc.id=e.company_id
   WHERE e.tenant_id=app.current_tenant_id() AND e.voided_at IS NULL AND e.import_pending_attempt_id IS NULL
     AND pc.id=ANY(p_scope)
 ),
 -- Fence the scoped candidates before the raising resolver, then retain its result once per row.
 future_correction_presence AS MATERIALIZED (
   SELECT EXISTS (
     SELECT 1 FROM public.domain_event ev
     WHERE ev.tenant_id=app.current_tenant_id() AND ev.event_type='employment.information.corrected'
       AND ev.payload->>'effectiveOn'>p_as_of::text
   ) AS present
 ),
 dated AS MATERIALIZED (
   SELECT b.*,a.business_unit_id AS legacy_business_unit_id,a.department_id,a.position_id,a.employment_type,
          coalesce(c.previous_company,a.company_id,b.company_id) AS dated_company
   FROM candidates b
   CROSS JOIN future_correction_presence presence
   LEFT JOIN LATERAL (
     SELECT nullif(ev.payload->'before'->>'companyId','')::uuid AS previous_company
     FROM public.domain_event ev
     WHERE presence.present AND ev.tenant_id=b.tenant_id AND ev.subject_employment_id=b.id
       AND ev.event_type='employment.information.corrected' AND ev.payload->>'effectiveOn'>p_as_of::text
     ORDER BY ev.sequence LIMIT 1
   ) c ON true
   LEFT JOIN public.assignment a ON a.tenant_id=b.tenant_id AND a.employment_id=b.id
     AND a.superseded_at IS NULL AND a.valid_from<=p_as_of AND (a.valid_to IS NULL OR a.valid_to>p_as_of)
 ),
 current_principal AS MATERIALIZED (
   SELECT app.principal_snapshot_current() AS allowed
 ),
 company_tags AS MATERIALIZED (
   SELECT pc.id,app.company_org_tags_unchecked(pc.id,p_as_of) AS tags
   FROM permitted_companies pc
   WHERE p_as_of IS NOT NULL AND isfinite(p_as_of)
     AND (SELECT allowed FROM current_principal)
     AND EXISTS (SELECT 1 FROM dated d WHERE d.dated_company=pc.id)
 ),
 tagged AS MATERIALIZED (
   SELECT d.*,
          CASE
            WHEN t.tags->>'companyId' IS DISTINCT FROM d.dated_company::text OR t.tags IS NULL
              THEN app.employment_organisation_tags(d.id,p_as_of)
            -- The legacy BU is selected from legacy_business_unit_id below.
            -- No output uses a legacy tags.businessUnitId, so retain the shared tags object.
            WHEN t.tags->>'status'='legacy' THEN t.tags
            ELSE coalesce(recorded.tags,t.tags)
          END AS tags
   FROM dated d
   LEFT JOIN company_tags t ON t.id=d.dated_company
   LEFT JOIN LATERAL (
     SELECT c.tags
     FROM public.employment_organisation_classification c
     JOIN public.company_organisation_run r ON r.id=c.mapping_version_id AND r.tenant_id=c.tenant_id
     WHERE t.tags IS NOT NULL AND t.tags->>'status' IS DISTINCT FROM 'legacy'
       AND c.tenant_id=d.tenant_id AND c.employment_id=d.id AND c.company_id=d.dated_company
       AND c.effective_on<=p_as_of AND r.state='published' AND NOT EXISTS (
         SELECT 1 FROM public.company_organisation_mapping m
         JOIN public.company_organisation_run newer ON newer.id=m.run_id AND newer.tenant_id=m.tenant_id
         WHERE m.tenant_id=d.tenant_id AND m.company_id=d.dated_company AND newer.state='published'
           AND newer.effective_on>c.effective_on AND newer.effective_on<=p_as_of
       )
     ORDER BY c.effective_on DESC,c.created_at DESC,c.id DESC LIMIT 1
   ) recorded ON true
 ),
 visible AS MATERIALIZED (
   SELECT b.*,
          dated.id AS dated_company_id,
          CASE WHEN b.tags->>'status' IN ('ready','pending') THEN (b.tags->>'businessUnitId')::uuid
            ELSE b.legacy_business_unit_id END AS dated_bu_id
   FROM tagged b
   JOIN permitted_companies dated ON dated.id=COALESCE((b.tags->>'companyId')::uuid,b.company_id)

 )
 SELECT v.id,v.name,v.email,v.employee_code,
   v.final_confirmation_date,v.confirmation_date,v.probation_end_date,v.provisional_end_on,
   v.resignation_date,v.last_working_date,v.terminated_on,v.blacklisted_at,
   v.dated_company_id,co.legal_name,v.department_id,v.employment_type::text,
   v.dated_bu_id,bu.name,v.position_id,COALESCE(NULLIF(btrim(pos.label),''),pos.title)
 FROM visible v
 JOIN public.company co ON co.id=v.dated_company_id AND co.tenant_id=v.tenant_id
 LEFT JOIN public.business_unit bu ON bu.id=v.dated_bu_id AND bu.tenant_id=v.tenant_id
 LEFT JOIN public.position pos ON pos.id=v.position_id AND pos.tenant_id=v.tenant_id
$function$;

--> statement-breakpoint
-- app.bank_import_subjects(jsonb) [V:1]
CREATE OR REPLACE FUNCTION app.bank_import_subjects(p_codes jsonb)
 RETURNS TABLE(employment_id uuid, person_id uuid, company_id uuid, employee_code text, hired_on date, card_id text, attendance_photo_setting text, payment_method text, full_name text, primary_email text, phone text, country text, statutory jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
 IF jsonb_typeof(p_codes) IS DISTINCT FROM 'array' OR jsonb_array_length(p_codes)>1000 OR NOT app.principal_snapshot_current() THEN
  RAISE EXCEPTION 'Import subject lookup refused' USING ERRCODE='42501';
 END IF;
 RETURN QUERY SELECT e.id,e.person_id,e.company_id,e.employee_code,e.hired_on,e.card_id,e.attendance_photo_setting::text,e.payment_method::text,
 p.full_name,p.primary_email,p.phone,c.country,CASE WHEN s.id IS NULL THEN NULL ELSE to_jsonb(s)||jsonb_build_object(
 'epf_employee_rate',s.epf_employee_rate::text,'epf_employer_rate',s.epf_employer_rate::text,
 'epf_employee_amount',s.epf_employee_amount::text,'epf_employer_amount',s.epf_employer_amount::text,
 'tp3_net_remuneration',s.tp3_net_remuneration::text,'tp3_epf_claimed',s.tp3_epf_claimed::text,
 'tp3_pcb_paid',s.tp3_pcb_paid::text,'tp3_zakat_paid',s.tp3_zakat_paid::text,'tp3_lp',s.tp3_lp::text,
 'zakat_percent',s.zakat_percent::text,'zakat_fixed',s.zakat_fixed::text) END
 FROM public.employment e JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
 JOIN public.company c ON c.id=e.company_id AND c.tenant_id=e.tenant_id
 LEFT JOIN public.employee_statutory_my s ON s.person_id=p.id AND s.tenant_id=e.tenant_id
 WHERE e.tenant_id=app.current_tenant_id() AND e.voided_at IS NULL AND e.import_pending_attempt_id IS NULL
 AND e.employee_code=ANY(ARRAY(SELECT jsonb_array_elements_text(p_codes)))
 AND app.is_admin_for(c.id) AND app.access_workforce_employment(e.id,'workforce.view') AND app.access_workforce_person(p.id,'workforce.view');
END $function$;

--> statement-breakpoint
-- app.contract_admission_choices(uuid) [V:1]
CREATE OR REPLACE FUNCTION app.contract_admission_choices(wanted_company uuid)
 RETURNS TABLE(id uuid, name text, "employeeId" text, "startOn" text, "endOn" text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
 SELECT e.id,p.full_name,e.employee_code,e.contract_start_date::text,e.contract_end_date::text FROM public.employment e JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id WHERE e.tenant_id=app.current_tenant_id() AND e.company_id=wanted_company AND app.contract_company_entitled(e.company_id) AND (app.contract_has_role(e.company_id,app.contract_business_unit(e.id),'gbs') OR app.contract_pbp_for_employment(e.id)) AND EXISTS(SELECT 1 FROM public.assignment a WHERE a.employment_id=e.id AND a.tenant_id=e.tenant_id AND a.superseded_at IS NULL AND a.employment_type='contract' AND a.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (a.valid_to IS NULL OR a.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)) AND e.voided_at IS NULL AND e.import_pending_attempt_id IS NULL AND e.blacklisted_at IS NULL ORDER BY p.full_name,e.id LIMIT 2000; $function$;

--> statement-breakpoint
-- app.personnel_filter_rows(date,uuid[]) [V:2]
CREATE OR REPLACE FUNCTION app.personnel_filter_rows(p_as_of date, p_scope uuid[] DEFAULT NULL::uuid[])
 RETURNS SETOF jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app'
AS $function$
 WITH permitted_companies AS MATERIALIZED (
   SELECT c.id FROM public.company c
   WHERE c.tenant_id=app.current_tenant_id() AND app.access_workforce_projection_company(c.id)
 ),
 -- Caller-selected companies constrain the starting rows only. Permissions for the dated
 -- company, hierarchy and manager are checked against the entire tenant's allowed set.
 admitted AS MATERIALIZED (
   SELECT DISTINCT ON ((a.value->>'employmentId')::uuid) a.value
   FROM app.access_workforce_list_rows() AS a(value)
   JOIN permitted_companies pc ON pc.id=(a.value->>'companyId')::uuid
   WHERE p_scope IS NULL OR pc.id=ANY(p_scope)
   ORDER BY (a.value->>'employmentId')::uuid
 ),
 candidates AS MATERIALIZED (
   SELECT b.value,e.id,e.tenant_id,e.company_id,e.hired_on,e.grade_id,
          e.confirmation_date,e.final_confirmation_date
   FROM admitted b
   JOIN public.employment e ON e.id=(b.value->>'employmentId')::uuid AND e.tenant_id=app.current_tenant_id()
   JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
   JOIN permitted_companies permitted ON permitted.id=e.company_id
   WHERE e.voided_at IS NULL AND e.import_pending_attempt_id IS NULL
 ),
 -- Fence the scoped candidates before the raising resolver, then retain its result once per row.
 tagged AS MATERIALIZED (
   SELECT b.*,app.employment_organisation_tags(b.id,p_as_of) AS tags
   FROM candidates b
 ),
 visible AS MATERIALIZED (
   SELECT b.value,b.id,b.tenant_id,b.hired_on,b.grade_id,b.confirmation_date,b.final_confirmation_date,
          a.department_id,a.position_id,a.cost_center_id,a.location_id,a.employment_type,b.tags,
          dated.id AS dated_company_id,
          CASE WHEN b.tags->>'status' IN ('ready','pending') THEN (b.tags->>'businessUnitId')::uuid
            ELSE a.business_unit_id END AS dated_bu_id
   FROM tagged b
   JOIN permitted_companies dated ON dated.id=COALESCE((b.tags->>'companyId')::uuid,b.company_id)
   LEFT JOIN LATERAL (
     SELECT x.department_id,x.position_id,x.business_unit_id,x.cost_center_id,x.location_id,x.employment_type
     FROM public.assignment x
     WHERE x.employment_id=b.id AND x.tenant_id=b.tenant_id AND x.superseded_at IS NULL
       AND x.valid_from<=p_as_of AND (x.valid_to IS NULL OR x.valid_to>p_as_of)
     ORDER BY x.valid_from DESC,x.id DESC LIMIT 1
   ) a ON true
 )
 SELECT v.value||jsonb_build_object(
   'companyId',v.dated_company_id,'company',co.legal_name,
   'departmentId',v.department_id,'department',COALESCE(NULLIF(btrim(d.label),''),d.name),
   'positionId',v.position_id,'position',COALESCE(NULLIF(btrim(pos.label),''),pos.title),
   'employmentType',v.employment_type,
   'businessUnitId',v.dated_bu_id,'businessUnit',bu.name,'jobGradeId',v.grade_id,
   'parentCompanyId',CASE WHEN allowed_parent.id IS NOT NULL THEN v.tags->>'parentCompanyId' END,
   'businessGroupId',CASE WHEN allowed_group.id IS NOT NULL THEN v.tags->>'businessGroupId' END,
   'parentCompany',pc.legal_name,'businessGroup',bg.legal_name,
   'confirmationState',CASE WHEN COALESCE(v.final_confirmation_date,v.confirmation_date)<=p_as_of THEN 'confirmed' ELSE 'unconfirmed' END,
   'jobGradeCode',g.code,'costCenter',cc.name,'workLocation',loc.name,
   'reportingTo',(
     SELECT mp.full_name FROM public.reporting_line r
     JOIN public.employment me ON me.id=r.manager_employment_id AND me.tenant_id=r.tenant_id AND me.voided_at IS NULL AND me.import_pending_attempt_id IS NULL
     JOIN permitted_companies manager_scope ON manager_scope.id=me.company_id
     JOIN public.person mp ON mp.id=me.person_id AND mp.tenant_id=me.tenant_id
     WHERE r.tenant_id=v.tenant_id AND r.subordinate_employment_id=v.id AND r.line_type='administrative'
       AND r.superseded_at IS NULL AND r.valid_from<=p_as_of AND (r.valid_to IS NULL OR r.valid_to>p_as_of)
     ORDER BY r.valid_from DESC,r.id LIMIT 1
   ),
   'quality',app.employment_organisation_quality_flags(v.id,p_as_of,v.hired_on,v.grade_id,v.tags)
 )
 FROM visible v
 JOIN public.company co ON co.id=v.dated_company_id AND co.tenant_id=v.tenant_id
 LEFT JOIN public.cost_center cc ON cc.id=v.cost_center_id AND cc.tenant_id=v.tenant_id
 LEFT JOIN public.location loc ON loc.id=v.location_id AND loc.tenant_id=v.tenant_id
 LEFT JOIN public.job_grade g ON g.id=v.grade_id AND g.tenant_id=v.tenant_id
 LEFT JOIN public.business_unit bu ON bu.id=v.dated_bu_id AND bu.tenant_id=v.tenant_id
 LEFT JOIN public.department d ON d.id=v.department_id AND d.tenant_id=v.tenant_id
 LEFT JOIN public.position pos ON pos.id=v.position_id AND pos.tenant_id=v.tenant_id
 LEFT JOIN permitted_companies allowed_parent ON allowed_parent.id=(v.tags->>'parentCompanyId')::uuid
 LEFT JOIN permitted_companies allowed_group ON allowed_group.id=(v.tags->>'businessGroupId')::uuid
 LEFT JOIN public.company pc ON pc.id=allowed_parent.id AND pc.tenant_id=v.tenant_id
 LEFT JOIN public.company bg ON bg.id=allowed_group.id AND bg.tenant_id=v.tenant_id
$function$;

--> statement-breakpoint
-- app.personnel_overview_page_rows(date,uuid[],uuid[]) [V:2]
CREATE OR REPLACE FUNCTION app.personnel_overview_page_rows(p_as_of date, p_scope uuid[], p_subjects uuid[])
 RETURNS SETOF jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app'
AS $function$
 WITH permitted_companies AS MATERIALIZED (
   SELECT c.id FROM public.company c
   WHERE c.tenant_id=app.current_tenant_id() AND app.access_workforce_projection_company(c.id)
 ),
 -- Caller-selected companies constrain the starting rows only. Permissions for the dated
 -- company, hierarchy and manager are checked against the entire tenant's allowed set.
 admitted AS MATERIALIZED (
   SELECT DISTINCT ON ((a.value->>'employmentId')::uuid) a.value
   FROM app._access_workforce_list_rows(CASE WHEN cardinality(p_subjects) BETWEEN 1 AND 2000 THEN p_subjects ELSE ARRAY[]::uuid[] END) AS a(value)
   JOIN permitted_companies pc ON pc.id=(a.value->>'companyId')::uuid
   WHERE pc.id=ANY(p_scope) AND cardinality(p_subjects) BETWEEN 1 AND 2000
   ORDER BY (a.value->>'employmentId')::uuid
 ),
 candidates AS MATERIALIZED (
   SELECT b.value,e.id,e.tenant_id,e.company_id,e.hired_on,e.grade_id,
          e.confirmation_date,e.final_confirmation_date
   FROM admitted b
   JOIN public.employment e ON e.id=(b.value->>'employmentId')::uuid AND e.tenant_id=app.current_tenant_id()
   JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
   JOIN permitted_companies permitted ON permitted.id=e.company_id
   WHERE e.voided_at IS NULL AND e.import_pending_attempt_id IS NULL
 ),
 -- Fence the scoped candidates before the raising resolver, then retain its result once per row.
 tagged AS MATERIALIZED (
   SELECT b.*,app.employment_organisation_tags(b.id,p_as_of) AS tags
   FROM candidates b
 ),
 visible AS MATERIALIZED (
   SELECT b.value,b.id,b.tenant_id,b.hired_on,b.grade_id,b.confirmation_date,b.final_confirmation_date,
          a.department_id,a.position_id,a.cost_center_id,a.location_id,a.employment_type,b.tags,
          dated.id AS dated_company_id,
          CASE WHEN b.tags->>'status' IN ('ready','pending') THEN (b.tags->>'businessUnitId')::uuid
            ELSE a.business_unit_id END AS dated_bu_id
   FROM tagged b
   JOIN permitted_companies dated ON dated.id=COALESCE((b.tags->>'companyId')::uuid,b.company_id)
   LEFT JOIN LATERAL (
     SELECT x.department_id,x.position_id,x.business_unit_id,x.cost_center_id,x.location_id,x.employment_type
     FROM public.assignment x
     WHERE x.employment_id=b.id AND x.tenant_id=b.tenant_id AND x.superseded_at IS NULL
       AND x.valid_from<=p_as_of AND (x.valid_to IS NULL OR x.valid_to>p_as_of)
     ORDER BY x.valid_from DESC,x.id DESC LIMIT 1
   ) a ON true
 )
 SELECT v.value||jsonb_build_object(
   'companyId',v.dated_company_id,'company',co.legal_name,
   'departmentId',v.department_id,'department',COALESCE(NULLIF(btrim(d.label),''),d.name),
   'positionId',v.position_id,'position',COALESCE(NULLIF(btrim(pos.label),''),pos.title),
   'employmentType',v.employment_type,
   'businessUnitId',v.dated_bu_id,'businessUnit',bu.name,'jobGradeId',v.grade_id,
   'parentCompanyId',CASE WHEN allowed_parent.id IS NOT NULL THEN v.tags->>'parentCompanyId' END,
   'businessGroupId',CASE WHEN allowed_group.id IS NOT NULL THEN v.tags->>'businessGroupId' END,
   'parentCompany',pc.legal_name,'businessGroup',bg.legal_name,
   'confirmationState',CASE WHEN COALESCE(v.final_confirmation_date,v.confirmation_date)<=p_as_of THEN 'confirmed' ELSE 'unconfirmed' END,
   'jobGradeCode',g.code,'costCenter',cc.name,'workLocation',loc.name,
   'reportingTo',(
     SELECT mp.full_name FROM public.reporting_line r
     JOIN public.employment me ON me.id=r.manager_employment_id AND me.tenant_id=r.tenant_id AND me.voided_at IS NULL AND me.import_pending_attempt_id IS NULL
     JOIN permitted_companies manager_scope ON manager_scope.id=me.company_id
     JOIN public.person mp ON mp.id=me.person_id AND mp.tenant_id=me.tenant_id
     WHERE r.tenant_id=v.tenant_id AND r.subordinate_employment_id=v.id AND r.line_type='administrative'
       AND r.superseded_at IS NULL AND r.valid_from<=p_as_of AND (r.valid_to IS NULL OR r.valid_to>p_as_of)
     ORDER BY r.valid_from DESC,r.id LIMIT 1
   ),
   'quality',app.employment_organisation_quality_flags(v.id,p_as_of,v.hired_on,v.grade_id,v.tags)
 )
 FROM visible v
 JOIN public.company co ON co.id=v.dated_company_id AND co.tenant_id=v.tenant_id
 LEFT JOIN public.cost_center cc ON cc.id=v.cost_center_id AND cc.tenant_id=v.tenant_id
 LEFT JOIN public.location loc ON loc.id=v.location_id AND loc.tenant_id=v.tenant_id
 LEFT JOIN public.job_grade g ON g.id=v.grade_id AND g.tenant_id=v.tenant_id
 LEFT JOIN public.business_unit bu ON bu.id=v.dated_bu_id AND bu.tenant_id=v.tenant_id
 LEFT JOIN public.department d ON d.id=v.department_id AND d.tenant_id=v.tenant_id
 LEFT JOIN public.position pos ON pos.id=v.position_id AND pos.tenant_id=v.tenant_id
 LEFT JOIN permitted_companies allowed_parent ON allowed_parent.id=(v.tags->>'parentCompanyId')::uuid
 LEFT JOIN permitted_companies allowed_group ON allowed_group.id=(v.tags->>'businessGroupId')::uuid
 LEFT JOIN public.company pc ON pc.id=allowed_parent.id AND pc.tenant_id=v.tenant_id
 LEFT JOIN public.company bg ON bg.id=allowed_group.id AND bg.tenant_id=v.tenant_id
$function$;

--> statement-breakpoint
-- app.personnel_duplicate_candidate_rows(uuid[],date) [V:1]
CREATE OR REPLACE FUNCTION app.personnel_duplicate_candidate_rows(p_scope uuid[], p_as_of date)
 RETURNS TABLE("employmentId" uuid, "personId" uuid, "fullName" text, "hiredOn" text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app'
AS $function$
 SELECT e.id,e.person_id,value->>'name',value->>'hiredOn'
 FROM app.personnel_filter_rows(p_as_of,p_scope) AS visible(value)
 JOIN public.employment e ON e.id=(value->>'employmentId')::uuid AND e.tenant_id=app.current_tenant_id() AND e.voided_at IS NULL AND e.import_pending_attempt_id IS NULL
 WHERE app.is_admin_for((value->>'companyId')::uuid) AND app.personnel_identity_search_permitted((value->>'companyId')::uuid)
$function$;

--> statement-breakpoint
-- app.entra_active(uuid,uuid,date) [V:2]
CREATE OR REPLACE FUNCTION app.entra_active(p_tenant uuid, p_person uuid, p_day date)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
 SELECT EXISTS(SELECT 1 FROM public.person p JOIN public.employment e ON e.person_id=p.id AND e.tenant_id=p.tenant_id
 WHERE p.tenant_id=p_tenant AND p.id=p_person AND p.voided_at IS NULL AND p.import_pending_attempt_id IS NULL AND e.voided_at IS NULL AND e.import_pending_attempt_id IS NULL
 AND e.blacklisted_at IS NULL AND e.hired_on<=p_day AND (LEAST(e.resignation_date,e.last_working_date,e.terminated_on) IS NULL OR LEAST(e.resignation_date,e.last_working_date,e.terminated_on)>=p_day));
$function$;

--> statement-breakpoint
-- app.eligible_delegates(uuid) [S:3]
CREATE OR REPLACE FUNCTION app.eligible_delegates(p_delegator uuid)
 RETURNS TABLE(employment_id uuid, full_name text, company_id uuid, business_unit_id uuid, department_id uuid, approver_level text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant uuid := app.current_tenant_id();
  v_person uuid;
  v_level text;
BEGIN
  SELECT e.person_id INTO v_person FROM (SELECT * FROM public.employment WHERE import_pending_attempt_id IS NULL) e WHERE e.id = p_delegator AND e.tenant_id = v_tenant;
  IF v_person IS NULL THEN RETURN; END IF;
  IF NOT app.is_admin() AND NOT EXISTS (
    SELECT 1 FROM app_user u WHERE u.id = app.current_user_id() AND u.person_id = v_person
  ) THEN
    RETURN;
  END IF;
  v_level := app.approver_level(p_delegator, current_date);
  IF v_level = 'none' THEN RETURN; END IF;
  RETURN QUERY
    SELECT e.id, p.full_name, e.company_id,
           COALESCE(sa.business_unit_id, sd.business_unit_id),
           sa.department_id,
           v_level
    FROM (SELECT * FROM public.employment WHERE import_pending_attempt_id IS NULL) e
    JOIN (SELECT * FROM public.person WHERE import_pending_attempt_id IS NULL) p ON p.id = e.person_id
    LEFT JOIN assignment sa ON sa.employment_id = e.id AND sa.valid_to IS NULL AND sa.superseded_at IS NULL
    LEFT JOIN department sd ON sd.id = sa.department_id
    WHERE e.tenant_id = v_tenant
      AND e.terminated_on IS NULL
      AND e.person_id <> v_person
      AND app.approver_level(e.id, current_date) = v_level
    ORDER BY p.full_name;
END;
$function$;

--> statement-breakpoint
-- app.onboarding_supervisors() [S:2]
CREATE OR REPLACE FUNCTION app.onboarding_supervisors()
 RETURNS TABLE(id uuid, name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT e.id,coalesce(e.employee_code||' – ','')||p.full_name||' · '||co.legal_name
 FROM (SELECT * FROM public.employment WHERE import_pending_attempt_id IS NULL) e JOIN (SELECT * FROM public.person WHERE import_pending_attempt_id IS NULL) p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
 JOIN company co ON co.id=e.company_id AND co.tenant_id=e.tenant_id
 WHERE e.tenant_id=app.current_tenant_id() AND e.terminated_on IS NULL
 AND (app.onboarding_page_access() OR app.is_group_admin()) ORDER BY p.full_name,e.employee_code,e.id
$function$;

--> statement-breakpoint
-- app.attendance_workflow_approver_availability(uuid) [S:3]
CREATE OR REPLACE FUNCTION app.attendance_workflow_approver_availability(wanted_company uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
 IF NOT app.principal_snapshot_current() OR NOT EXISTS(SELECT 1 FROM public.company c WHERE c.id=wanted_company AND c.tenant_id=app.current_tenant_id() AND app.is_admin_for(c.id)) THEN RETURN NULL; END IF;
 IF EXISTS(SELECT 1 FROM app.attendance_workflow_v3_approver_options(ARRAY[wanted_company])) THEN RETURN 'available'; END IF;
 IF NOT EXISTS(SELECT 1 FROM (SELECT * FROM public.employment WHERE import_pending_attempt_id IS NULL) e WHERE e.tenant_id=app.current_tenant_id() AND app.is_company_descendant(wanted_company,e.company_id)) THEN RETURN 'noEmployees'; END IF;
 IF NOT EXISTS(SELECT 1 FROM (SELECT * FROM public.employment WHERE import_pending_attempt_id IS NULL) e WHERE e.tenant_id=app.current_tenant_id() AND app.is_company_descendant(wanted_company,e.company_id) AND e.blacklisted_at IS NULL AND e.hired_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND(e.terminated_on IS NULL OR e.terminated_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)) THEN RETURN 'noActiveEmployees'; END IF;
 IF NOT EXISTS(SELECT 1 FROM (SELECT * FROM public.employment WHERE import_pending_attempt_id IS NULL) e JOIN public.app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) WHERE e.tenant_id=app.current_tenant_id() AND app.is_company_descendant(wanted_company,e.company_id) AND e.blacklisted_at IS NULL AND e.hired_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND(e.terminated_on IS NULL OR e.terminated_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)) THEN RETURN 'noLinkedLogin'; END IF;
 RETURN 'noEligible';
END $function$;

--> statement-breakpoint
-- app.assessment_unit_exclusion_facts(uuid,uuid,uuid) [S:2]
CREATE OR REPLACE FUNCTION app.assessment_unit_exclusion_facts(wanted_cycle uuid, wanted_company uuid, wanted_department uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  JOIN (SELECT * FROM public.employment WHERE import_pending_attempt_id IS NULL) s ON s.id=r.employment_id AND s.tenant_id=r.tenant_id
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
   'headcount',(SELECT count(*) FROM (SELECT * FROM public.employment WHERE import_pending_attempt_id IS NULL) e CROSS JOIN today WHERE e.tenant_id=c.tenant_id AND (e.terminated_on IS NULL OR e.terminated_on>today.d)
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
$function$;

--> statement-breakpoint
-- app.assessment_unit_exclusion_pin(uuid) [S:1]
CREATE OR REPLACE FUNCTION app.assessment_unit_exclusion_pin(wanted_cycle uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE c review_cycle; pinned integer;
BEGIN
 SELECT * INTO c FROM review_cycle WHERE id=wanted_cycle AND tenant_id=app.current_tenant_id();
 IF c.id IS NULL OR NOT app.onehr_cycle_admin(c.id) THEN RAISE EXCEPTION 'Performance administrator access is required' USING ERRCODE='42501'; END IF;
 IF c.status NOT IN ('open','calibration') THEN RETURN 0; END IF;
 INSERT INTO performance_assessment_unit_exclusion_pin(tenant_id,cycle_id,employment_id,rule_id,pinned_on)
  SELECT DISTINCT ON (e.id) c.tenant_id,c.id,e.id,x.id,(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
  FROM performance_assessment_unit_exclusion x
  JOIN (SELECT * FROM public.employment WHERE import_pending_attempt_id IS NULL) e ON e.tenant_id=x.tenant_id AND (e.company_id=x.company_id OR EXISTS(SELECT 1 FROM assignment a WHERE a.employment_id=e.id AND a.tenant_id=e.tenant_id AND a.company_id=x.company_id))
  CROSS JOIN LATERAL app.assessment_unit_placement(e.id) pl
  WHERE x.tenant_id=c.tenant_id AND x.cycle_id=c.id AND x.ended_at IS NULL
   AND x.company_id=pl.company_id AND (x.department_id IS NULL OR x.department_id=pl.department_id)
  ORDER BY e.id,x.department_id NULLS FIRST,x.id
 ON CONFLICT (cycle_id,employment_id) DO NOTHING;
 GET DIAGNOSTICS pinned=ROW_COUNT;
 RETURN pinned;
END $function$;

--> statement-breakpoint
-- app.onehr_unit_exclusion_choices(uuid,uuid) [S:1]
CREATE OR REPLACE FUNCTION app.onehr_unit_exclusion_choices(wanted_cycle uuid, wanted_company uuid)
 RETURNS TABLE(department_id uuid, department_name text, people integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 WITH today AS (SELECT (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS d),
 cyc AS (
  SELECT c.tenant_id FROM review_cycle c JOIN performance_onehr_cycle cfg ON cfg.cycle_id=c.id AND cfg.tenant_id=c.tenant_id
  WHERE c.id=wanted_cycle AND c.tenant_id=app.current_tenant_id() AND wanted_company IS NOT NULL
   AND (c.company_id IS NULL OR c.company_id=wanted_company) AND app.onehr_admin(wanted_company)
 )
 SELECT d.id,d.name,count(DISTINCT e.id)::integer
 FROM cyc CROSS JOIN today
 JOIN (SELECT * FROM public.employment WHERE import_pending_attempt_id IS NULL) e ON e.tenant_id=cyc.tenant_id AND (e.terminated_on IS NULL OR e.terminated_on>today.d)
  AND (e.company_id=wanted_company OR EXISTS(SELECT 1 FROM assignment a WHERE a.employment_id=e.id AND a.tenant_id=e.tenant_id AND a.company_id=wanted_company))
 CROSS JOIN LATERAL app.assessment_unit_placement(e.id) pl
 JOIN department d ON d.id=pl.department_id AND d.tenant_id=e.tenant_id AND d.company_id=wanted_company
 WHERE pl.company_id=wanted_company
 GROUP BY d.id,d.name
 ORDER BY d.name,d.id
$function$;

--> statement-breakpoint
-- app.onehr_employment_facts() [S:1]
CREATE OR REPLACE FUNCTION app.onehr_employment_facts()
 RETURNS TABLE(id uuid, tenant_id uuid, person_id uuid, company_id uuid, employee_code text, grade_id uuid, hired_on date, confirmation_date date, terminated_on date)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT e.id, e.tenant_id, e.person_id, e.company_id, e.employee_code, e.grade_id, e.hired_on, e.confirmation_date, e.terminated_on
 FROM (SELECT * FROM public.employment WHERE import_pending_attempt_id IS NULL) e
 WHERE cardinality((SELECT app.onehr_partner_company_ids())) > 0
  AND e.tenant_id = app.current_tenant_id() AND e.company_id = ANY ((SELECT app.onehr_partner_company_ids())::uuid[])
$function$;

--> statement-breakpoint
-- app.onehr_assignment_facts() [S:1]
CREATE OR REPLACE FUNCTION app.onehr_assignment_facts()
 RETURNS TABLE(id uuid, tenant_id uuid, employment_id uuid, department_id uuid, position_id uuid, valid_from date, valid_to date, superseded_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT a.id, a.tenant_id, a.employment_id, a.department_id, a.position_id, a.valid_from, a.valid_to, a.superseded_at
 FROM assignment a JOIN (SELECT * FROM public.employment WHERE import_pending_attempt_id IS NULL) e ON e.id = a.employment_id AND e.tenant_id = a.tenant_id
 WHERE cardinality((SELECT app.onehr_partner_company_ids())) > 0
  AND a.tenant_id = app.current_tenant_id() AND e.company_id = ANY ((SELECT app.onehr_partner_company_ids())::uuid[])
$function$;

--> statement-breakpoint
-- app._home_peer_cohort(uuid,text) [S:2]
CREATE OR REPLACE FUNCTION app._home_peer_cohort(p_employment uuid, p_purpose text)
 RETURNS TABLE(employment_id uuid, person_id uuid, display_name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
 WITH today AS (SELECT (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS d),
 policy AS MATERIALIZED (SELECT * FROM app._home_peer_policy(p_employment,p_purpose)),
 lines AS MATERIALIZED (
  SELECT r.subordinate_employment_id,r.manager_employment_id FROM public.reporting_line r,today
  WHERE r.tenant_id=app.current_tenant_id() AND r.line_type='administrative' AND r.superseded_at IS NULL
   AND r.valid_from<=today.d AND (r.valid_to IS NULL OR r.valid_to>today.d)
 ), candidate_ids AS (
  SELECT line.manager_employment_id AS id FROM lines line,policy p
   WHERE p.sharing_scope='direct' AND line.subordinate_employment_id=p_employment
  UNION
  SELECT line.subordinate_employment_id FROM lines line,policy p
   WHERE p.sharing_scope='direct' AND line.manager_employment_id=p_employment
  UNION
  SELECT peer.subordinate_employment_id FROM lines mine JOIN lines peer ON peer.manager_employment_id=mine.manager_employment_id,policy p
   WHERE p.sharing_scope='direct' AND mine.subordinate_employment_id=p_employment
  UNION
  SELECT a.employment_id FROM public.assignment a,policy p,today
   WHERE p.sharing_scope='department' AND p.department_id IS NOT NULL AND a.department_id=p.department_id
    AND a.tenant_id=app.current_tenant_id() AND a.superseded_at IS NULL
    AND a.valid_from<=today.d AND (a.valid_to IS NULL OR a.valid_to>today.d)
 ), eligible AS MATERIALIZED (
 SELECT e.id AS employment_id,e.person_id,p.company_id AS viewer_company,today.d AS on_date,
  coalesce(nullif(btrim(person.preferred_name),''),nullif(btrim(person.first_name),''),nullif(btrim(person.full_name),'')) AS display_name
 FROM candidate_ids candidate JOIN (SELECT * FROM public.employment WHERE import_pending_attempt_id IS NULL) e ON e.id=candidate.id
 JOIN (SELECT * FROM public.person WHERE import_pending_attempt_id IS NULL) person ON person.id=e.person_id AND person.tenant_id=e.tenant_id CROSS JOIN policy p CROSS JOIN today
 WHERE e.tenant_id=app.current_tenant_id() AND e.person_id<>p.viewer_person_id
  AND e.blacklisted_at IS NULL AND e.hired_on<=today.d
  AND (LEAST(e.resignation_date,e.last_working_date,e.terminated_on) IS NULL OR LEAST(e.resignation_date,e.last_working_date,e.terminated_on)>=today.d)
 ), ranked_points AS (
 SELECT employment_id,on_date,(row_number() OVER(ORDER BY employment_id)-1)/1000 AS batch FROM eligible
 ), proof_groups AS (
 SELECT batch,jsonb_agg(jsonb_build_object('employmentId',employment_id,'date',on_date) ORDER BY employment_id) AS points FROM ranked_points GROUP BY batch
 ), proofs AS MATERIALIZED (
 SELECT DISTINCT proof.* FROM proof_groups g CROSS JOIN LATERAL app.proven_company_date_points(g.points) proof
 )
 SELECT e.employment_id,e.person_id,e.display_name FROM eligible e JOIN proofs proof
  ON proof.employment_id=e.employment_id AND proof.on_date=e.on_date
 WHERE proof.reason IS NULL AND proof.company_id=e.viewer_company ORDER BY e.display_name,e.employment_id;
$function$;

--> statement-breakpoint
-- app.automatic_followup_facts(text,date,uuid[],integer) [S:3]
CREATE OR REPLACE FUNCTION app.automatic_followup_facts(p_source text, p_today date, p_ids uuid[] DEFAULT NULL::uuid[], p_limit integer DEFAULT 2000)
 RETURNS SETOF jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE t uuid:=app.current_tenant_id();
BEGIN
 IF t IS NULL OR p_today IS NULL OR p_limit IS NULL OR p_limit<1 OR p_limit>2000
  OR p_source IS NULL OR p_source NOT IN ('missing_clock','passport_expiry','lifecycle_step') THEN RAISE EXCEPTION 'Follow-up source unavailable' USING ERRCODE='42501';END IF;
 IF p_source='missing_clock' THEN
  RETURN QUERY SELECT jsonb_build_object('itemId',e.id,'employmentId',e.id,'companyId',e.company_id,'stage',(p_today-1)::text,'waitingOn',(p_today-1)::text)
   FROM (SELECT * FROM public.employment WHERE import_pending_attempt_id IS NULL) e
   WHERE e.tenant_id=t AND e.hired_on<=p_today-1 AND (e.terminated_on IS NULL OR e.terminated_on>p_today)
    AND (app.current_agent_principal() IS NOT NULL OR (app.is_admin_for(e.company_id) AND (app.current_user_id() IS NULL OR app.principal_snapshot_current())))
    AND (p_ids IS NULL OR e.id=ANY(p_ids))
    AND NOT EXISTS(SELECT 1 FROM public.attendance a WHERE a.employment_id=e.id AND a.tenant_id=t AND a.attendance_date=p_today-1 AND a.check_in_at IS NOT NULL)
    AND NOT EXISTS(SELECT 1 FROM public.attendance_punch a WHERE a.employment_id=e.id AND a.tenant_id=t AND a.attendance_date=p_today-1 AND a.direction::text='in' AND a.voided_at IS NULL)
    AND NOT EXISTS(SELECT 1 FROM public.leave_request_date l WHERE l.subject_employment_id=e.id AND l.tenant_id=t AND l.leave_date=p_today-1 AND l.status::text IN ('pending','approved'))
    AND NOT EXISTS(SELECT 1 FROM public.attendance_correction a WHERE a.employment_id=e.id AND a.tenant_id=t AND a.attendance_date=p_today-1 AND a.status::text IN ('pending','approved'))
   ORDER BY e.id LIMIT p_limit;
 ELSIF p_source='passport_expiry' THEN
  RETURN QUERY SELECT jsonb_build_object('itemId',e.id,'employmentId',e.id,'companyId',e.company_id,'stage','passport:'||s.passport_expiry_date::text,'waitingOn',s.passport_expiry_date::text)
   FROM (SELECT * FROM public.employment WHERE import_pending_attempt_id IS NULL) e JOIN public.employee_statutory_my s ON s.person_id=e.person_id AND s.tenant_id=t
   JOIN public.company c ON c.id=e.company_id AND c.tenant_id=t AND c.country::text='MY'
   WHERE e.tenant_id=t AND e.hired_on<=p_today AND (e.terminated_on IS NULL OR e.terminated_on>p_today)
    AND (app.current_agent_principal() IS NOT NULL OR (app.is_admin_for(e.company_id) AND (app.current_user_id() IS NULL OR app.principal_snapshot_current())))
    AND s.passport_expiry_date BETWEEN p_today AND p_today+30 AND (p_ids IS NULL OR e.id=ANY(p_ids))
   ORDER BY s.passport_expiry_date,e.id LIMIT p_limit;
 ELSE
  RETURN QUERY SELECT jsonb_build_object('itemId',c.id,'employmentId',e.id,'companyId',c.company_id,'kind',c.kind,'status',c.status,
   'laptopRequired',c.laptop_required,'carparkRequired',c.carpark_required,'outcome',c.outcome,
   'transitionAt',greatest(c.created_at,(SELECT max(h.at) FROM public.lc_history h WHERE h.tenant_id=t AND h.ref_type='case' AND h.ref_id=c.id AND h.action='case.edited' AND h.detail->'fields' ?| ARRAY['laptopRequired','carparkRequired']),(SELECT max(v.occurred_at) FROM public.domain_event v WHERE v.tenant_id=t AND v.aggregate_type='lifecycle-case' AND v.aggregate_id=c.id
    AND v.event_type IN ('lifecycle-case.step-done','lifecycle-case.step-undone','lifecycle-case.reopened','lifecycle-case.outcome-set','lifecycle-case.outcome-changed','lifecycle-case.owner-changed')),(SELECT max(v.occurred_at) FROM public.domain_event v WHERE v.tenant_id=t AND v.aggregate_type='lifecycle-config' AND v.event_type IN ('lifecycle-config.steps-saved','lifecycle-config.steps-reset','lifecycle-config.defaults-loaded') AND (v.payload->>'kind'=c.kind OR v.event_type='lifecycle-config.defaults-loaded'))),
   'defs',coalesce((SELECT jsonb_agg(jsonb_build_object('key',d.step_key,'phase',d.phase,'rule',d.rule,'sort',d.sort,'active',d.active) ORDER BY d.phase,d.sort,d.step_key)
    FROM public.lc_step_def d WHERE d.tenant_id=t AND d.kind=c.kind),'[]'::jsonb),
   'records',coalesce((SELECT jsonb_agg(jsonb_build_object('key',r.step_key,'done',r.done)) FROM public.lc_case_step r WHERE r.tenant_id=t AND r.case_id=c.id),'[]'::jsonb))
   FROM public.lc_case c JOIN (SELECT * FROM public.employment WHERE import_pending_attempt_id IS NULL) e ON e.id=c.employment_id AND e.tenant_id=t
   WHERE c.tenant_id=t AND c.status='in_progress' AND c.kind IN ('onboarding','offboarding')
    AND (app.current_agent_principal() IS NOT NULL OR (app.is_admin_for(c.company_id) AND (app.current_user_id() IS NULL OR app.principal_snapshot_current()))) AND (p_ids IS NULL OR c.id=ANY(p_ids))
   ORDER BY c.created_at,c.id LIMIT p_limit;
 END IF;
END $function$;

--> statement-breakpoint
-- app.agent_readiness_presence(uuid[]) [S:2]
CREATE OR REPLACE FUNCTION app.agent_readiness_presence(p_employment_ids uuid[])
 RETURNS TABLE(employment_id uuid, person_id uuid, full_name text, employee_code text, company text, payment_method text, has_ic boolean, has_passport boolean, has_tax boolean, has_epf boolean, has_socso boolean, has_bank boolean, has_compensation boolean, has_statutory_profile boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
 IF app.current_agent_principal() IS NULL THEN RAISE EXCEPTION 'Agent source unavailable' USING ERRCODE='42501';END IF;
 RETURN QUERY SELECT e.id,e.person_id,p.full_name,e.employee_code,c.legal_name,e.payment_method::text,
  coalesce(s.ic_number ~ '\S',false),coalesce(s.passport_number ~ '\S',false),coalesce(s.tax_number ~ '\S',false),
  coalesce(s.epf_number ~ '\S',false),coalesce(s.socso_number ~ '\S',false),coalesce(s.bank_account_no ~ '\S',false),
  EXISTS(SELECT 1 FROM public.compensation x WHERE x.employment_id=e.id),s.person_id IS NOT NULL
 FROM (SELECT * FROM public.employment WHERE import_pending_attempt_id IS NULL) e
 JOIN (SELECT * FROM public.person WHERE import_pending_attempt_id IS NULL) p ON p.id=e.person_id
 JOIN public.company c ON c.id=e.company_id
 LEFT JOIN public.employee_statutory_my s ON s.person_id=e.person_id AND s.tenant_id=e.tenant_id
 WHERE e.tenant_id=app.current_tenant_id() AND e.terminated_on IS NULL
  AND (p_employment_ids IS NULL OR e.id=ANY(p_employment_ids));
END $function$;

--> statement-breakpoint
-- app.access_workforce_picker_rows(text,date,date) [S:1]
CREATE OR REPLACE FUNCTION app.access_workforce_picker_rows(wanted_branch text, hired_from date, hired_to date)
 RETURNS SETOF jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app'
AS $function$
 SELECT r.value FROM app.access_workforce_list_rows() r(value)
 JOIN (SELECT * FROM public.employment WHERE import_pending_attempt_id IS NULL) e ON e.id=(r.value->>'employmentId')::uuid AND e.tenant_id=app.current_tenant_id() AND e.company_id=(r.value->>'companyId')::uuid
 WHERE (wanted_branch IS NULL OR e.org_branch=wanted_branch) AND (hired_from IS NULL OR e.hired_on>=hired_from) AND (hired_to IS NULL OR e.hired_on<=hired_to)
$function$;

--> statement-breakpoint
-- app.probation_intake_workspace(uuid) [S:4]
CREATE OR REPLACE FUNCTION app.probation_intake_workspace(p_company uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE e employment;entry probation_intake_entry;source jsonb;settings jsonb;issues jsonb;classification text;items jsonb:='[]';count integer:=0;holders jsonb;can_review boolean;stage_options jsonb;extensions integer;option_count integer;proposal uuid;
BEGIN
 IF app.probation_storage_runner() IS NOT TRUE AND app.probation_config_admin(p_company) IS NOT TRUE AND NOT EXISTS(SELECT 1 FROM (SELECT * FROM public.employment WHERE import_pending_attempt_id IS NULL) employee WHERE employee.company_id=p_company AND employee.tenant_id=app.current_tenant_id() AND (app.probation_role(employee.id,'pbp') OR app.probation_role(employee.id,'gbs'))) THEN RAISE EXCEPTION 'Scoped intake preparation authority required';END IF;
 SELECT data INTO settings FROM probation_configuration WHERE tenant_id=app.current_tenant_id() AND company_id=p_company AND kind='settings' AND state='published' ORDER BY version DESC LIMIT 1;
 FOR e IN SELECT * FROM (SELECT * FROM public.employment WHERE import_pending_attempt_id IS NULL) employment WHERE tenant_id=app.current_tenant_id() AND company_id=p_company AND app.probation_intake_exclusion(id) IS NULL AND (app.probation_storage_runner() OR app.probation_config_admin(p_company) OR app.probation_role(id,'pbp') OR app.probation_role(id,'gbs')) ORDER BY employee_code,id LIMIT 501 LOOP
 count:=count+1;IF count>500 THEN EXIT;END IF;source:=app.probation_personnel_source(e.id);SELECT * INTO entry FROM probation_intake_entry WHERE employment_id=e.id AND tenant_id=e.tenant_id AND company_id=e.company_id;proposal:=app.probation_offline_proposal_for_entry(entry.id);issues:='[]';classification:='ready';can_review:=app.probation_role(e.id,'pbp') OR app.probation_role(e.id,'gbs');
 IF EXISTS(SELECT 1 FROM probation_case WHERE employment_id=e.id AND tenant_id=e.tenant_id) THEN classification:='already_admitted';
 ELSIF source->>'explicitNoProbation'='true' OR source->>'confirmationOn' IS NOT NULL OR source->>'resignationOn' IS NOT NULL OR source->>'terminatedOn' IS NOT NULL OR source->>'employmentType' IS NOT NULL AND source->>'employmentType'<>'full_time' OR entry.data->>'kind'='exclude' THEN classification:='excluded';
 ELSE
 IF coalesce(source->>'grade','')='' OR source->>'employmentType' IS NULL THEN issues:=issues||jsonb_build_array('Resolve the canonical start-grade or active employment type before intake.');END IF;
 IF settings IS NULL THEN issues:=issues||jsonb_build_array('Published probation settings are missing.');ELSIF coalesce(source->>'grade','')<>'' AND NOT(settings->'eligibleGrades'?(source->>'grade')) AND NOT(source->>'grade'='H' AND settings->>'gradeHEnabled'='true' AND EXISTS(SELECT 1 FROM probation_configuration form WHERE form.tenant_id=e.tenant_id AND form.company_id=e.company_id AND form.kind='form' AND form.state='published' AND app.probation_is_current_publication('form',form.id) AND form.data->'targetGrades'?'H')) THEN classification:='excluded';END IF;
 IF app.probation_intake_history_valid(source,coalesce(entry.data,'{}')) IS NOT TRUE THEN issues:=issues||jsonb_build_array('The actual PBP must validate the canonical extension or date-adjustment history before import.');END IF;
 IF (source->>'unknownPeriod'='true' OR source->>'eligibilityReviewRequired'='true') AND coalesce(entry.data->>'validatedUnknown','false')<>'true' THEN issues:=issues||jsonb_build_array('The actual PBP must validate missing probation data and any transfer/rehire eligibility history.');END IF;
 IF entry.id IS NULL THEN issues:=issues||jsonb_build_array('A reasoned existing-employee stage mapping has not been reviewed.');ELSIF entry.reviewed_by::text IS DISTINCT FROM source->'holders'->>'pbp' AND app.probation_gbs_user(e.id,entry.reviewed_by) IS NOT TRUE THEN issues:=issues||jsonb_build_array('The accepted intake reviewer no longer holds the required canonical scope.');ELSIF entry.source_digest IS DISTINCT FROM app.probation_intake_digest(e.id) THEN issues:=issues||jsonb_build_array('Personnel or the published intake versions changed after stage review.');END IF;
 IF proposal IS NULL AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(entry.data->'parts','[]')) part WHERE part->>'type'='3' AND (part->>'cycle')::integer=coalesce((entry.data->>'extensionCount')::integer,0) AND part->>'status'='completed_offline') THEN issues:=issues||jsonb_build_array('The completed offline final decision requires PBP adjudication; do not manufacture electronic signatures or an automatic outcome.');END IF;
 IF source->'holders'->>'employee' IS NULL OR source->'holders'->>'lm' IS NULL OR source->'holders'->>'hod' IS NULL OR source->'holders'->>'pbp' IS NULL THEN issues:=issues||jsonb_build_array('Resolve the current employee, LM, HOD and canonical PBP logins before cutover.');END IF;
 IF classification<>'excluded' AND jsonb_array_length(issues)>0 THEN classification:='held';END IF;END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('role',role.key,'name',person.full_name,'userId',u.id) ORDER BY role.key),'[]') INTO holders FROM jsonb_each_text(source->'holders') role JOIN app_user u ON u.id=role.value::uuid AND u.tenant_id=e.tenant_id JOIN (SELECT * FROM public.person WHERE import_pending_attempt_id IS NULL) person ON person.id=u.person_id AND person.tenant_id=u.tenant_id;
 extensions:=coalesce((entry.data->>'extensionCount')::integer,0);stage_options:='[]';SELECT least(2,count(*))::integer INTO option_count FROM jsonb_array_elements(source->'extensionHistory') event WHERE event->>'kind'<>'date_shift' AND event->>'months' IN('3','6') AND source->>'extendedEndOn' IS NOT NULL;
 SELECT jsonb_agg(jsonb_build_object('extensionCount',choice,'requiredParts',app.probation_intake_required_parts(source,settings,choice)) ORDER BY choice) INTO stage_options FROM generate_series(0,option_count) choice;
 items:=items||jsonb_build_array(jsonb_build_object('source',source,'classification',classification,'issues',issues,'canReview',can_review,'canValidate',app.probation_role(e.id,'pbp'),'requiredParts',app.probation_intake_required_parts(source,settings,extensions),'stageOptions',stage_options,'offlineDecisionReady',proposal IS NOT NULL,'offlineDecision',CASE WHEN can_review THEN app.probation_offline_decision_json(proposal) ELSE NULL END,'holders',holders,'sourceDigest',app.probation_intake_digest(e.id),'disposition',CASE WHEN entry.id IS NULL THEN NULL ELSE entry.data||jsonb_build_object('id',entry.id,'revision',entry.revision,'sourceDigest',entry.source_digest) END,'evidence',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',f.id,'name',f.name,'reason',f.reason,'createdAt',f.created_at) ORDER BY f.created_at,f.id),'[]') FROM probation_intake_evidence f WHERE f.tenant_id=e.tenant_id AND f.employment_id=e.id)));
 END LOOP;
 RETURN jsonb_build_object('candidates',items,'truncated',count>500,'excludedCount',(SELECT count(*) FROM (SELECT * FROM public.employment WHERE import_pending_attempt_id IS NULL) all_employment WHERE all_employment.tenant_id=app.current_tenant_id() AND all_employment.company_id=p_company AND app.probation_intake_exclusion(all_employment.id) IS NOT NULL AND (app.probation_storage_runner() OR app.probation_config_admin(p_company) OR app.probation_role(all_employment.id,'pbp') OR app.probation_role(all_employment.id,'gbs'))));
END $function$;

--> statement-breakpoint
-- app.probation_required_workflow_status(uuid) [S:1]
CREATE OR REPLACE FUNCTION app.probation_required_workflow_status(p_company uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE company_name text;can_configure boolean;missing jsonb;summary_ready boolean;
BEGIN
 IF app.probation_active_user() IS NOT TRUE OR app.probation_company_entitled(p_company) IS NOT TRUE THEN RETURN NULL;END IF;
 can_configure:=app.probation_config_admin(p_company);
 IF can_configure IS NOT TRUE AND NOT EXISTS(
  SELECT 1 FROM (SELECT * FROM public.employment WHERE import_pending_attempt_id IS NULL) employee WHERE employee.tenant_id=app.current_tenant_id() AND employee.company_id=p_company
   AND (app.probation_role(employee.id,'pbp') OR app.probation_role(employee.id,'gbs'))
 ) THEN RETURN NULL;END IF;
 SELECT company.legal_name INTO company_name FROM company WHERE id=p_company AND tenant_id=app.current_tenant_id() AND archived_at IS NULL;
 IF company_name IS NULL THEN RETURN NULL;END IF;
 WITH published AS(
  SELECT w.data FROM probation_builder_definition w WHERE w.tenant_id=app.current_tenant_id() AND w.company_id=p_company AND w.kind='workflow' AND w.state='published'
   AND app.probation_is_current_publication('workflow',w.id) AND coalesce(w.data->'conditions','{}')='{}'
 ), required(event,ordinal) AS(
  SELECT * FROM unnest(ARRAY['kpi_assigned','kpi_reminder','kpi_overdue','review_issued','review_reminder','review_due','approval_pending','letter_released','letter_signing_pending','letter_release_pending','letter_returned','overdue_summary']) WITH ORDINALITY
 )
 SELECT (SELECT coalesce(jsonb_agg(required.event ORDER BY required.ordinal),'[]') FROM required
  WHERE NOT EXISTS(SELECT 1 FROM published active WHERE active.data->'trigger'->>'event'=required.event)),
 (SELECT count(*)=1 AND coalesce(bool_and(
   EXISTS(SELECT 1 FROM jsonb_array_elements(active.data->'steps') step WHERE step->'to'?'pbp')
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(active.data->'steps') step
    WHERE (coalesce(step->>'subject','')||' '||coalesce(step->>'body',''))~'[{][{][[:space:]]*(employeeName|employeeCode|part|endOn)[[:space:]]*[}][}]')
  ),false) FROM published active WHERE active.data->'trigger'->>'event'='overdue_summary') INTO missing,summary_ready;
 RETURN jsonb_build_object('companyName',company_name,'canConfigure',can_configure,'missing',missing,'summaryReady',summary_ready);
END $function$;

--> statement-breakpoint
-- app.own_home_dashboard_role(uuid) [S:3]
CREATE OR REPLACE FUNCTION app.own_home_dashboard_role(p_employment uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
 SELECT CASE WHEN app.is_admin_for(proof.company_id) THEN 'hr_admin'
  WHEN app.has_role_for('manager',proof.company_id) OR CASE WHEN EXISTS(
   SELECT 1 FROM public.reporting_line pending_edge
   WHERE pending_edge.manager_employment_id=e.id AND pending_edge.tenant_id=e.tenant_id
    AND pending_edge.valid_to IS NULL AND pending_edge.superseded_at IS NULL
    AND pending_edge.line_type::text<>'delegate'
  ) THEN EXISTS(
   SELECT 1 FROM public.reporting_line r JOIN (SELECT * FROM public.employment WHERE import_pending_attempt_id IS NULL) report ON report.id=r.subordinate_employment_id
    JOIN (SELECT * FROM public.person WHERE import_pending_attempt_id IS NULL) subject ON subject.id=report.person_id
   WHERE r.manager_employment_id=e.id AND r.tenant_id=e.tenant_id AND report.tenant_id=e.tenant_id
    AND subject.tenant_id=e.tenant_id AND r.valid_to IS NULL AND r.superseded_at IS NULL
    AND r.line_type::text<>'delegate' AND app.can_see_employment(report.id) AND app.can_see_person(subject.id)
  ) ELSE false END THEN 'manager' ELSE 'employee' END
 FROM (SELECT * FROM public.employment WHERE import_pending_attempt_id IS NULL) e JOIN public.app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id
 CROSS JOIN LATERAL app.proven_company_date_points(jsonb_build_array(jsonb_build_object(
  'employmentId',e.id,'date',(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date))) proof
 WHERE e.id=p_employment AND e.tenant_id=app.current_tenant_id() AND u.id=app.current_user_id()
  AND app.principal_snapshot_current() AND app.is_self_person(e.person_id);
$function$;

--> statement-breakpoint
-- app.reward_confidentiality_floors(uuid,uuid[],date) [S:2]
CREATE OR REPLACE FUNCTION app.reward_confidentiality_floors(wanted_unit uuid, wanted_employments uuid[], as_of date)
 RETURNS TABLE(employment_id uuid, level text, manager_employment_id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
 SELECT DISTINCT ON (line.subordinate_employment_id) line.subordinate_employment_id,m.role,line.manager_employment_id
 FROM public.reward_unit r JOIN public.reward_member m ON m.unit_id=r.id AND m.tenant_id=r.tenant_id AND m.role IN('bg','ec')
 JOIN public.app_user u ON u.id=m.user_id AND u.tenant_id=m.tenant_id
 JOIN (SELECT * FROM public.employment WHERE import_pending_attempt_id IS NULL) manager ON manager.person_id=u.person_id AND manager.tenant_id=u.tenant_id AND manager.hired_on<=as_of AND (manager.terminated_on IS NULL OR as_of<manager.terminated_on)
 JOIN public.reporting_line line ON line.manager_employment_id=manager.id AND line.tenant_id=manager.tenant_id AND line.line_type='administrative' AND line.superseded_at IS NULL AND line.valid_from<=as_of AND (line.valid_to IS NULL OR as_of<line.valid_to)
 JOIN (SELECT * FROM public.employment WHERE import_pending_attempt_id IS NULL) subject ON subject.id=line.subordinate_employment_id AND subject.tenant_id=r.tenant_id AND subject.company_id=r.company_id
 WHERE r.id=wanted_unit AND r.tenant_id=app.current_tenant_id() AND r.deleted_at IS NULL AND line.subordinate_employment_id=ANY(wanted_employments) AND app.reward_access(r.id)
 ORDER BY line.subordinate_employment_id,CASE m.role WHEN 'ec' THEN 0 ELSE 1 END,line.manager_employment_id;
$function$;

--> statement-breakpoint
-- app.reward_uploaded_snapshot_roster(uuid,date) [S:6]
CREATE OR REPLACE FUNCTION app.reward_uploaded_snapshot_roster(wanted_unit uuid, wanted_snapshot date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app'
AS $function$
DECLARE u reward_unit%ROWTYPE;t uuid:=app.current_tenant_id();unit uuid:=wanted_unit;wanted_company uuid;wanted_year integer;row record;overlap boolean;pending_names text;company_tags jsonb;seen uuid[]:='{}';
BEGIN
 SELECT * INTO u FROM reward_unit WHERE id=wanted_unit AND tenant_id=t AND deleted_at IS NULL AND status='draft';
 IF u.id IS NULL OR NOT 'gr'=ANY(ARRAY(SELECT app.reward_roles(u.id))) OR NOT app.reward_setup_allowed(u.company_id,'manage') OR NOT app.reward_not_viewing_as() OR NOT EXISTS(SELECT 1 FROM reward_uploaded_review WHERE unit_id=u.id AND tenant_id=t) THEN RAISE EXCEPTION 'Group Rewards draft upload authority required';END IF;
 wanted_company:=u.company_id;wanted_year:=(u.policy->>'year')::integer;
 company_tags:=app.reward_company_structure(wanted_company,wanted_snapshot);IF company_tags->>'status' IS DISTINCT FROM 'ready' OR nullif(company_tags->>'businessUnitId','')::uuid IS DISTINCT FROM u.business_unit_id THEN RAISE EXCEPTION 'Confirm the company Business unit before refreshing the upload';END IF;
 SELECT string_agg(coalesce(e.employee_code,e.id::text)||' · '||pe.full_name,'; ' ORDER BY e.employee_code,e.id) INTO pending_names FROM (SELECT * FROM public.employment WHERE import_pending_attempt_id IS NULL) e JOIN (SELECT * FROM public.person WHERE import_pending_attempt_id IS NULL) pe ON pe.id=e.person_id AND pe.tenant_id=e.tenant_id WHERE e.tenant_id=t AND e.hired_on<=wanted_snapshot AND(e.terminated_on IS NULL OR e.terminated_on>wanted_snapshot) AND app.reward_source_org_tags(e.id,wanted_snapshot)->>'companyId'=wanted_company::text AND coalesce(app.reward_source_org_tags(e.id,wanted_snapshot)->>'status','pending') NOT IN('legacy','ready');
 IF pending_names IS NOT NULL THEN RAISE EXCEPTION 'Group structure tagging is pending: %',pending_names;END IF;
 SELECT EXISTS(SELECT 1 FROM (SELECT * FROM public.employment WHERE import_pending_attempt_id IS NULL) e JOIN assignment a ON a.employment_id=e.id AND a.tenant_id=e.tenant_id WHERE e.tenant_id=t AND app.reward_source_org_tags(e.id,wanted_snapshot)->>'companyId'=wanted_company::text AND e.hired_on<=wanted_snapshot AND(e.terminated_on IS NULL OR e.terminated_on>wanted_snapshot) AND a.valid_from<=wanted_snapshot AND(a.valid_to IS NULL OR a.valid_to>wanted_snapshot) AND a.superseded_at IS NULL GROUP BY e.id HAVING count(*)>1) INTO overlap;
 IF overlap THEN RAISE EXCEPTION 'An employee has overlapping assignments; correct Personnel before creating reviews';END IF;
 FOR row IN SELECT e.*,a.id AS assignment_id,a.position_id AS assignment_position_id,j.code AS grade_code,pe.full_name,comp.id AS compensation_id,comp.basic_salary,comp.currency AS comp_currency,comp.pay_mode,comp.valid_from AS pay_from,pr.id AS review_id,pr.overall_rating
 FROM (SELECT * FROM public.employment WHERE import_pending_attempt_id IS NULL) e JOIN (SELECT * FROM public.person WHERE import_pending_attempt_id IS NULL) pe ON pe.id=e.person_id AND pe.tenant_id=e.tenant_id JOIN assignment a ON a.employment_id=e.id AND a.tenant_id=e.tenant_id
 LEFT JOIN job_grade j ON j.id=e.grade_id AND j.tenant_id=e.tenant_id
 LEFT JOIN LATERAL(SELECT * FROM compensation c WHERE c.employment_id=e.id AND c.tenant_id=e.tenant_id AND c.valid_from<=wanted_snapshot AND(c.valid_to IS NULL OR c.valid_to>wanted_snapshot) AND c.superseded_at IS NULL ORDER BY c.valid_from DESC,c.id DESC LIMIT 1)comp ON true
 LEFT JOIN LATERAL(SELECT r.id,r.overall_rating FROM performance_review r JOIN review_cycle c ON c.id=r.cycle_id AND c.tenant_id=r.tenant_id WHERE r.employment_id=e.id AND r.tenant_id=e.tenant_id AND r.closed_at IS NOT NULL AND c.period_start<=make_date(wanted_year,12,31) AND c.period_end>=make_date(wanted_year,1,1) ORDER BY r.closed_at DESC,r.id DESC LIMIT 1)pr ON true
 WHERE e.tenant_id=t AND app.reward_source_org_tags(e.id,wanted_snapshot)->>'companyId'=wanted_company::text AND e.hired_on<=wanted_snapshot AND(e.terminated_on IS NULL OR e.terminated_on>wanted_snapshot) AND a.valid_from<=wanted_snapshot AND(a.valid_to IS NULL OR a.valid_to>wanted_snapshot) AND a.superseded_at IS NULL
 LOOP
 INSERT INTO reward_entry(tenant_id,unit_id,employment_id,source,facts,recommendation) VALUES(t,unit,row.id,jsonb_build_object('employmentId',row.id,'assignmentId',row.assignment_id,'positionId',row.assignment_position_id,'personId',row.person_id,'compensationId',row.compensation_id,'employeeCode',coalesce(row.employee_code,row.id::text),'name',row.full_name,'grade',regexp_replace(coalesce(row.grade_code,''),'^JG[[:space:]]*','','i'),'gradeId',row.grade_id,'basicCents',coalesce(round(row.basic_salary*100),0),'currency',coalesce(row.comp_currency,'MYR'),'payMode',coalesce(row.pay_mode,'monthly'),'hiredOn',row.hired_on,'confirmedOn',row.confirmation_date,'notice',(row.tender_resignation_date IS NOT NULL AND row.tender_resignation_date<=wanted_snapshot) OR(row.resignation_date IS NOT NULL AND row.resignation_date<=wanted_snapshot),'lastPayChange',CASE WHEN row.pay_from>row.hired_on THEN row.pay_from ELSE NULL END,'confirmationPayChange',coalesce(row.pay_from=row.confirmation_date AND row.pay_from>row.hired_on,false),'performanceReviewId',row.review_id,'performanceRating',row.overall_rating,'architecture',app.reward_architecture_for_source(unit,row.id,row.assignment_position_id,wanted_snapshot),'payChanges',coalesce((SELECT jsonb_agg(jsonb_build_object('on',x.valid_from,'basicCents',round(x.basic_salary*100),'kind',app.reward_snapshot_pay_change_kind(x.id)) ORDER BY x.valid_from,x.id) FROM(SELECT c.*,lag(c.basic_salary)over(ORDER BY c.valid_from,c.id) AS prior_basic FROM compensation c WHERE c.employment_id=row.id AND c.tenant_id=t AND c.superseded_at IS NULL)x WHERE x.prior_basic IS NOT NULL AND x.basic_salary<>x.prior_basic AND x.valid_from>row.hired_on AND x.valid_from BETWEEN make_date(wanted_year,1,1) AND make_date(wanted_year+1,12,31)),'[]'::jsonb)),
 '{"talent":null,"performance":null,"confidentiality":"standard","seniorPlan":false,"erCase":false,"pipCase":false,"erDecision":"pending","pipDecision":"pending","caseReason":"","segment":"","branch":"","reviewed":false}'::jsonb,
 '{"meritBp":null,"promotionGrade":null,"promotionBp":null,"specialBp":null,"multiplierBp":null,"bonusCents":null,"lumpCents":null,"reason":"","currentRoleSummary":"","proposedRoleSummary":""}'::jsonb) ON CONFLICT(unit_id,employment_id) DO UPDATE SET source=excluded.source||jsonb_strip_nulls(jsonb_build_object('confidentialityFloor',reward_entry.source->'confidentialityFloor','confidentialityReason',reward_entry.source->'confidentialityReason')),updated_at=now();
 seen:=array_append(seen,row.id);
 END LOOP;
 WITH floors AS (SELECT * FROM app.reward_confidentiality_floors(unit,seen,wanted_snapshot)), source_rows AS (
   SELECT e.id,f.level,f.manager_employment_id,
     CASE e.facts->>'confidentiality' WHEN 'ec' THEN 2 WHEN 'bg' THEN 1 ELSE 0 END current_rank,
     CASE e.source->>'confidentialityFloor' WHEN 'ec' THEN 2 WHEN 'bg' THEN 1 ELSE 0 END old_rank,
     CASE f.level WHEN 'ec' THEN 2 WHEN 'bg' THEN 1 ELSE 0 END new_rank
   FROM reward_entry e LEFT JOIN floors f ON f.employment_id=e.employment_id
   WHERE e.tenant_id=t AND e.unit_id=unit AND e.employment_id=ANY(seen)
 )
 UPDATE reward_entry e SET source=(e.source-ARRAY['confidentialityFloor','confidentialityReason'])||
     CASE WHEN f.level IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('confidentialityFloor',f.level,'confidentialityReason',jsonb_build_object('seat',f.level,'managerEmploymentId',f.manager_employment_id)) END,
   facts=e.facts||jsonb_build_object('reviewed',true,'confidentiality',CASE greatest(CASE WHEN f.current_rank>f.old_rank THEN f.current_rank ELSE 0 END,f.new_rank) WHEN 2 THEN 'ec' WHEN 1 THEN 'bg' ELSE 'standard' END),updated_at=now()
 FROM source_rows f WHERE e.id=f.id AND e.tenant_id=t AND e.unit_id=unit;
 UPDATE reward_entry e SET source=e.source||jsonb_build_object('leftOn',wanted_snapshot,'leftReason',CASE WHEN EXISTS(SELECT 1 FROM (SELECT * FROM public.employment WHERE import_pending_attempt_id IS NULL) x WHERE x.id=e.employment_id AND x.tenant_id=t AND x.terminated_on<=wanted_snapshot) THEN 'terminated' ELSE 'moved' END),updated_at=now() WHERE e.unit_id=unit AND e.tenant_id=t AND NOT e.employment_id=ANY(seen);
END $function$;

--> statement-breakpoint
-- app.reward_create_planned_unit_bound(uuid,uuid,uuid) [S:5]
CREATE OR REPLACE FUNCTION app.reward_create_planned_unit_bound(wanted_version uuid, wanted_company uuid, wanted_business_unit uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app'
AS $function$
DECLARE t uuid:=app.current_tenant_id();actor uuid:=app.current_user_id();p reward_plan_setup%ROWTYPE;b jsonb;s jsonb;v jsonb;pat reward_pat_version%ROWTYPE;policy jsonb;cycle uuid;existing_cycle_name text;unit uuid:=gen_random_uuid();source jsonb;row record;overlap boolean;pending_names text;company_tags jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(t::text||':plans',2203));
 PERFORM pg_advisory_xact_lock(hashtextextended(t::text||':company-year:'||wanted_company::text||':'||(SELECT year FROM reward_plan_setup WHERE tenant_id=t AND version_id=wanted_version)::text,2203));
 IF NOT app.reward_setup_allowed(wanted_company,'manage') THEN RAISE EXCEPTION 'Group Rewards plan creation authority required' USING ERRCODE='42501';END IF;
 SELECT * INTO p FROM reward_plan_setup WHERE tenant_id=t AND version_id=wanted_version AND state='approved';
 IF p.version_id IS NULL OR NOT app.reward_setup_company_eligible(wanted_company,p.year) OR p.snapshot_date>timezone('Asia/Kuala_Lumpur',now())::date THEN RAISE EXCEPTION 'Current approved plan and available legal employer required';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(t::text||':pat:'||wanted_company::text||':'||p.year::text,2203));
 company_tags:=app.reward_company_structure(wanted_company,p.snapshot_date);IF company_tags->>'status' IS DISTINCT FROM 'ready' OR nullif(company_tags->>'businessUnitId','')::uuid IS DISTINCT FROM wanted_business_unit THEN RAISE EXCEPTION 'Confirmed dated company Business unit required at the approved plan snapshot' USING ERRCODE='22023';END IF;
 SELECT value INTO b FROM jsonb_array_elements(p.bindings) WHERE value->>'companyId'=wanted_company::text AND value->>'businessUnitId'=wanted_business_unit::text;
 IF b IS NULL OR NOT EXISTS(SELECT 1 FROM reward_plan_company c WHERE c.tenant_id=t AND c.company_id=wanted_company AND c.year=p.year AND c.plan_version_id=wanted_version) THEN RAISE EXCEPTION 'Company is not assigned to this approved plan';END IF;
 IF EXISTS(SELECT 1 FROM reward_unit u JOIN reward_cycle c ON c.id=u.cycle_id AND c.tenant_id=u.tenant_id WHERE u.tenant_id=t AND u.company_id=wanted_company AND c.year=p.year AND u.kind='annual' AND u.deleted_at IS NULL) OR EXISTS(SELECT 1 FROM reward_company_year_review WHERE tenant_id=t AND company_id=wanted_company AND year=p.year) THEN RAISE EXCEPTION 'Company already has a review for this reward year';END IF;
 SELECT rv.data INTO s FROM reward_library_version rv JOIN reward_library l ON l.id=rv.library_id AND l.tenant_id=rv.tenant_id WHERE rv.id=(b->>'salaryVersionId')::uuid AND rv.tenant_id=t AND rv.state='confirmed' AND l.kind='salary' AND l.year=p.year;
 SELECT rv.data INTO v FROM reward_library_version rv JOIN reward_library l ON l.id=rv.library_id AND l.tenant_id=rv.tenant_id WHERE rv.id=(b->>'bonusVersionId')::uuid AND rv.tenant_id=t AND rv.state='confirmed' AND l.kind='bonus' AND l.year=p.year;
 SELECT * INTO pat FROM reward_pat_version WHERE tenant_id=t AND company_id=wanted_company AND year=p.year AND state='confirmed' ORDER BY revision DESC LIMIT 1;
 IF s IS NULL OR v IS NULL OR pat.id IS NULL OR(pat.inputs->>'targetCents')::bigint<=0 OR coalesce(pat.inputs->>'actualCents',pat.inputs->>'forecastCents') IS NULL THEN RAISE EXCEPTION 'Confirmed libraries and PAT are required';END IF;
 source:=app.reward_setup_policy_source(wanted_version);policy:=source->'policy';
 policy:=app.reward_planned_policy_snapshot(policy,s,v,pat.inputs);
 SELECT c.id,c.name INTO cycle,existing_cycle_name FROM reward_setup_cycle link JOIN reward_cycle c ON c.id=link.cycle_id AND c.tenant_id=link.tenant_id WHERE link.tenant_id=t AND link.group_id=p.group_id AND link.year=p.year;
 IF cycle IS NULL THEN INSERT INTO reward_cycle(tenant_id,name,year,created_by) VALUES(t,p.cycle_name,p.year,actor) RETURNING id INTO cycle;INSERT INTO reward_setup_cycle VALUES(t,p.group_id,p.year,wanted_version,cycle);ELSIF existing_cycle_name IS DISTINCT FROM p.cycle_name THEN RAISE EXCEPTION 'The cycle name is fixed after the first review is created';END IF;
 INSERT INTO reward_unit(id,tenant_id,created_by,cycle_id,company_id,business_unit_id,policy,policy_group_version_id,snapshot_date) VALUES(unit,t,actor,cycle,wanted_company,wanted_business_unit,policy,wanted_version,p.snapshot_date);
 INSERT INTO reward_company_year_review VALUES(t,wanted_company,p.year,unit,'planned');
 INSERT INTO reward_unit_setup(unit_id,tenant_id,plan_version_id,salary_version_id,bonus_version_id,pat_version_id) VALUES(unit,t,wanted_version,(b->>'salaryVersionId')::uuid,(b->>'bonusVersionId')::uuid,pat.id);
 INSERT INTO reward_member(tenant_id,unit_id,user_id,role,valid_from) VALUES(t,unit,actor,'gr',timezone('Asia/Kuala_Lumpur',now())::date);
 SELECT string_agg(coalesce(e.employee_code,e.id::text)||' · '||pe.full_name,'; ' ORDER BY e.employee_code,e.id) INTO pending_names FROM (SELECT * FROM public.employment WHERE import_pending_attempt_id IS NULL) e JOIN (SELECT * FROM public.person WHERE import_pending_attempt_id IS NULL) pe ON pe.id=e.person_id AND pe.tenant_id=e.tenant_id WHERE e.tenant_id=t AND e.hired_on<=p.snapshot_date AND(e.terminated_on IS NULL OR e.terminated_on>p.snapshot_date) AND app.reward_source_org_tags(e.id,p.snapshot_date)->>'companyId'=wanted_company::text AND coalesce(app.reward_source_org_tags(e.id,p.snapshot_date)->>'status','pending') NOT IN('legacy','ready');
 IF pending_names IS NOT NULL THEN RAISE EXCEPTION 'Group structure tagging is pending: %',pending_names;END IF;
 SELECT EXISTS(SELECT 1 FROM (SELECT * FROM public.employment WHERE import_pending_attempt_id IS NULL) e JOIN assignment a ON a.employment_id=e.id AND a.tenant_id=e.tenant_id WHERE e.tenant_id=t AND app.reward_source_org_tags(e.id,p.snapshot_date)->>'companyId'=wanted_company::text AND e.hired_on<=p.snapshot_date AND(e.terminated_on IS NULL OR e.terminated_on>p.snapshot_date) AND (CASE WHEN app.reward_source_org_tags(e.id,p.snapshot_date)->>'status'='legacy' THEN a.business_unit_id ELSE nullif(app.reward_source_org_tags(e.id,p.snapshot_date)->>'businessUnitId','')::uuid END)=wanted_business_unit AND a.valid_from<=p.snapshot_date AND(a.valid_to IS NULL OR a.valid_to>p.snapshot_date) AND a.superseded_at IS NULL GROUP BY e.id HAVING count(*)>1) INTO overlap;
 IF overlap THEN RAISE EXCEPTION 'An employee has overlapping assignments; correct Personnel before creating reviews';END IF;
 FOR row IN SELECT e.*,a.id AS assignment_id,a.position_id AS assignment_position_id,j.code AS grade_code,pe.full_name,comp.id AS compensation_id,comp.basic_salary,comp.currency AS comp_currency,comp.pay_mode,comp.valid_from AS pay_from,pr.id AS review_id,pr.overall_rating
 FROM (SELECT * FROM public.employment WHERE import_pending_attempt_id IS NULL) e JOIN (SELECT * FROM public.person WHERE import_pending_attempt_id IS NULL) pe ON pe.id=e.person_id AND pe.tenant_id=e.tenant_id JOIN assignment a ON a.employment_id=e.id AND a.tenant_id=e.tenant_id
 LEFT JOIN job_grade j ON j.id=e.grade_id AND j.tenant_id=e.tenant_id
 LEFT JOIN LATERAL(SELECT * FROM compensation c WHERE c.employment_id=e.id AND c.tenant_id=e.tenant_id AND c.valid_from<=p.snapshot_date AND(c.valid_to IS NULL OR c.valid_to>p.snapshot_date) AND c.superseded_at IS NULL ORDER BY c.valid_from DESC,c.id DESC LIMIT 1)comp ON true
 LEFT JOIN LATERAL(SELECT r.id,r.overall_rating FROM performance_review r JOIN review_cycle c ON c.id=r.cycle_id AND c.tenant_id=r.tenant_id WHERE r.employment_id=e.id AND r.tenant_id=e.tenant_id AND r.closed_at IS NOT NULL AND c.period_start<=make_date(p.year,12,31) AND c.period_end>=make_date(p.year,1,1) ORDER BY r.closed_at DESC,r.id DESC LIMIT 1)pr ON true
 WHERE e.tenant_id=t AND app.reward_source_org_tags(e.id,p.snapshot_date)->>'companyId'=wanted_company::text AND e.hired_on<=p.snapshot_date AND(e.terminated_on IS NULL OR e.terminated_on>p.snapshot_date) AND (CASE WHEN app.reward_source_org_tags(e.id,p.snapshot_date)->>'status'='legacy' THEN a.business_unit_id ELSE nullif(app.reward_source_org_tags(e.id,p.snapshot_date)->>'businessUnitId','')::uuid END)=wanted_business_unit AND a.valid_from<=p.snapshot_date AND(a.valid_to IS NULL OR a.valid_to>p.snapshot_date) AND a.superseded_at IS NULL
 LOOP
 INSERT INTO reward_entry(tenant_id,unit_id,employment_id,source,facts,recommendation) VALUES(t,unit,row.id,jsonb_build_object('employmentId',row.id,'assignmentId',row.assignment_id,'positionId',row.assignment_position_id,'personId',row.person_id,'compensationId',row.compensation_id,'employeeCode',coalesce(row.employee_code,row.id::text),'name',row.full_name,'grade',regexp_replace(coalesce(row.grade_code,''),'^JG[[:space:]]*','','i'),'gradeId',row.grade_id,'basicCents',coalesce(round(row.basic_salary*100),0),'currency',coalesce(row.comp_currency,'MYR'),'payMode',coalesce(row.pay_mode,'monthly'),'hiredOn',row.hired_on,'confirmedOn',row.confirmation_date,'notice',(row.tender_resignation_date IS NOT NULL AND row.tender_resignation_date<=p.snapshot_date) OR(row.resignation_date IS NOT NULL AND row.resignation_date<=p.snapshot_date),'lastPayChange',CASE WHEN row.pay_from>row.hired_on THEN row.pay_from ELSE NULL END,'confirmationPayChange',coalesce(row.pay_from=row.confirmation_date AND row.pay_from>row.hired_on,false),'performanceReviewId',row.review_id,'performanceRating',row.overall_rating,'architecture',app.reward_architecture_for_source(unit,row.id,row.assignment_position_id,p.snapshot_date),'payChanges',coalesce((SELECT jsonb_agg(jsonb_build_object('on',x.valid_from,'basicCents',round(x.basic_salary*100),'kind',app.reward_snapshot_pay_change_kind(x.id)) ORDER BY x.valid_from,x.id) FROM(SELECT c.*,lag(c.basic_salary)over(ORDER BY c.valid_from,c.id) AS prior_basic FROM compensation c WHERE c.employment_id=row.id AND c.tenant_id=t AND c.superseded_at IS NULL)x WHERE x.prior_basic IS NOT NULL AND x.basic_salary<>x.prior_basic AND x.valid_from>row.hired_on AND x.valid_from BETWEEN make_date(p.year,1,1) AND make_date(p.year+1,12,31)),'[]'::jsonb)),
 '{"talent":null,"performance":null,"confidentiality":"standard","seniorPlan":false,"erCase":false,"pipCase":false,"erDecision":"pending","pipDecision":"pending","caseReason":"","segment":"","branch":"","reviewed":false}'::jsonb,
 '{"meritBp":null,"promotionGrade":null,"promotionBp":null,"specialBp":null,"multiplierBp":null,"bonusCents":null,"lumpCents":null,"reason":"","currentRoleSummary":"","proposedRoleSummary":""}'::jsonb);
 END LOOP;
 INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload) VALUES(t,'reward-unit',unit,'reward-unit.approved-plan-admitted','user',actor,jsonb_build_object('planVersionId',wanted_version,'salaryVersionId',b->>'salaryVersionId','bonusVersionId',b->>'bonusVersionId','patVersionId',pat.id));
 RETURN unit;
END $function$;

--> statement-breakpoint
-- app.entra_configure(text,uuid,text,boolean,boolean,uuid,uuid) [S:2]
CREATE OR REPLACE FUNCTION app.entra_configure(p_org text, p_directory uuid, p_mode text, p_enabled boolean, p_provision boolean, p_revision uuid, p_expected uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE old public.entra_connector%ROWTYPE; t uuid:=app.current_tenant_id();
BEGIN
 IF NOT app.entra_admin() THEN RAISE EXCEPTION 'entra_forbidden' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('entra-config:'||t,0));
 SELECT * INTO old FROM public.entra_connector WHERE tenant_id=t FOR UPDATE;
 IF old.revision IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'entra_conflict'; END IF;
 -- Moving a directory requires a separate reviewed identity migration, never an in-place takeover.
 IF old.tenant_id IS NOT NULL AND (old.directory_tenant_id<>p_directory OR old.organization<>p_org OR old.mode<>p_mode) THEN RAISE EXCEPTION 'entra_conflict'; END IF;
 INSERT INTO public.entra_connector VALUES(t,p_org,p_directory,p_mode,p_enabled,p_provision,p_revision)
 ON CONFLICT(tenant_id) DO UPDATE SET enabled=p_enabled,provisioning_enabled=p_provision,revision=p_revision;
 INSERT INTO public.entra_workforce(tenant_id,person_id) SELECT t,p.id FROM (SELECT * FROM public.person WHERE import_pending_attempt_id IS NULL) p WHERE p.tenant_id=t AND EXISTS(SELECT 1 FROM (SELECT * FROM public.employment WHERE import_pending_attempt_id IS NULL) e WHERE e.person_id=p.id AND e.tenant_id=t)
 ON CONFLICT(tenant_id,person_id) DO UPDATE SET revision=entra_workforce.revision+1,next_at=now(),status=CASE WHEN entra_workforce.lease IS NOT NULL THEN 'processing' WHEN entra_workforce.status='uncertain' AND entra_workforce.last_location IS NULL THEN 'uncertain' ELSE 'pending' END;
 PERFORM app.append_auth_event(t,'entra-connector',t,'entra.configured','user',app.current_user_id(),jsonb_build_object('revision',p_revision,'enabled',p_enabled,'provisioning',p_provision));
END;
$function$;

--> statement-breakpoint
-- app.prepare_company_organisation_run(jsonb) [S:2]
CREATE OR REPLACE FUNCTION app.prepare_company_organisation_run(p_input jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE v_t uuid:=app.current_tenant_id();v_actor uuid:=app.current_user_id();v_r uuid:=gen_random_uuid();v_kind text:=p_input->>'kind';v_day date:=(p_input->>'effectiveOn')::date;v_scope uuid[];v_authority uuid[];v_mapping jsonb;v_old_mapping jsonb;v_change jsonb;v_co uuid;v_parent uuid;v_bu uuid;v_tags jsonb;v_before_tags jsonb;v_emp record;v_active boolean;v_outcome text;v_status text;v_reason text;v_epoch bigint;v_token text;v_first_mapping boolean;v_projection_day date;v_next_day date;
BEGIN
 PERFORM app.company_org_lock();
 IF v_actor IS NULL OR NOT app.principal_snapshot_current() OR v_kind NOT IN('mapping','restructure','retag') OR v_day IS NULL OR NOT isfinite(v_day) OR jsonb_typeof(p_input->'companyIds') IS DISTINCT FROM 'array' OR jsonb_array_length(p_input->'companyIds') NOT BETWEEN 1 AND 500 OR jsonb_typeof(coalesce(p_input->'changes','[]')) IS DISTINCT FROM 'array' OR jsonb_array_length(coalesce(p_input->'changes','[]'))>500 THEN RAISE EXCEPTION 'Choose a valid organisation run and scope';END IF;
 IF v_kind='retag' AND v_day IS DISTINCT FROM (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date THEN RAISE EXCEPTION 'Re-tag is effective on the confirmed run date';END IF;
 SELECT array_agg(DISTINCT x::uuid ORDER BY x::uuid) INTO v_scope FROM jsonb_array_elements_text(p_input->'companyIds') x;
 v_old_mapping:=app.company_org_mapping_at(v_day);v_mapping:=v_old_mapping;v_authority:=v_scope;
 v_first_mapping:=NOT EXISTS(SELECT 1 FROM company_organisation_run existing WHERE existing.tenant_id=v_t AND existing.state='published' AND existing.kind<>'retag');
 IF v_kind='retag' AND NOT EXISTS(SELECT 1 FROM company_organisation_run existing WHERE existing.tenant_id=v_t AND existing.state='published' AND existing.kind<>'retag' AND existing.effective_on<=v_day) THEN RAISE EXCEPTION 'Publish a reviewed mapping before preparing a re-tag';END IF;
 IF v_kind<>'retag' AND jsonb_array_length(coalesce(p_input->'changes','[]'))=0 THEN RAISE EXCEPTION 'Choose explicit company mappings';END IF;
 IF v_kind='retag' AND jsonb_array_length(coalesce(p_input->'changes','[]'))<>0 THEN RAISE EXCEPTION 'A re-tag cannot change the structure';END IF;
 IF (SELECT count(*) FROM jsonb_array_elements(coalesce(p_input->'changes','[]')) c)<>(SELECT count(DISTINCT c->>'companyId') FROM jsonb_array_elements(coalesce(p_input->'changes','[]')) c) THEN RAISE EXCEPTION 'Choose each mapping once';END IF;
 FOR v_change IN SELECT value FROM jsonb_array_elements(coalesce(p_input->'changes','[]')) LOOP
  v_co:=(v_change->>'companyId')::uuid;v_parent:=nullif(v_change->>'parentCompanyId','')::uuid;v_bu:=nullif(v_change->>'businessUnitId','')::uuid;
  IF v_co IS NULL OR NOT(v_co=ANY(v_scope)) OR NOT(v_mapping?v_co::text) OR v_co=v_parent OR NOT(v_change?'businessUnitId' AND v_change?'parentCompanyId') THEN RAISE EXCEPTION 'Choose explicit company, parent and Business Unit identities';END IF;
  IF v_parent IS NOT NULL AND NOT(v_mapping?v_parent::text) THEN RAISE EXCEPTION 'Parent company must belong to the same tenant';END IF;
  IF v_bu IS NOT NULL AND NOT app.company_org_bu_usable(v_bu,v_co) THEN RAISE EXCEPTION 'Business Unit is unavailable to this company through Criteria';END IF;
  IF v_parent IS NOT NULL AND NOT(v_parent=ANY(v_authority)) THEN v_authority:=array_append(v_authority,v_parent);END IF;
  v_mapping:=jsonb_set(v_mapping,ARRAY[v_co::text],jsonb_build_object('companyId',v_co,'businessUnitId',v_bu,'parentCompanyId',v_parent,'mappingVersionId',v_r));
 END LOOP;
 -- A changed ancestor changes descendant lineage too. Never accept a caller-supplied truncated cohort.
 IF v_first_mapping AND v_kind<>'retag' THEN SELECT array_agg(id ORDER BY id) INTO v_scope FROM company WHERE tenant_id=v_t;
 ELSIF v_kind<>'retag' THEN
  WITH RECURSIVE affected(id) AS(SELECT unnest(v_scope) UNION SELECT (value->>'companyId')::uuid FROM jsonb_each(v_mapping) entry JOIN affected a ON entry.value->>'parentCompanyId'=a.id::text)
  SELECT array_agg(DISTINCT id ORDER BY id) INTO v_scope FROM affected;
 END IF;
 SELECT array_agg(DISTINCT x ORDER BY x) INTO v_authority FROM unnest(v_scope||v_authority) x;
 IF NOT app.company_org_hr(v_actor,v_authority) OR NOT app.company_org_hr_proposed(v_actor,v_authority,v_mapping) OR EXISTS(SELECT 1 FROM unnest(v_authority) c WHERE NOT app.access_workforce_company(c,'workforce.maintain')) THEN RAISE EXCEPTION 'HR administration of the entire affected scope is required' USING ERRCODE='42501';END IF;
 FOR v_co IN SELECT id FROM company WHERE tenant_id=v_t ORDER BY id LOOP
  v_tags:=app.company_org_resolve(v_co,v_mapping,true);IF v_tags->>'reason' IN('Group structure contains a cycle','Parent company is unavailable') THEN RAISE EXCEPTION 'Resolve the complete company hierarchy before previewing';END IF;
 END LOOP;
 SELECT revision INTO v_epoch FROM company_organisation_source_epoch WHERE tenant_id=v_t;
 INSERT INTO company_organisation_run(id,tenant_id,kind,effective_on,company_ids,authority_company_ids,mapping,source_epoch,digest,requested_by) VALUES(v_r,v_t,v_kind,v_day,v_scope,v_authority,v_mapping,v_epoch,'preparing',v_actor);
 FOR v_emp IN SELECT e.*,p.full_name FROM (SELECT * FROM public.employment WHERE import_pending_attempt_id IS NULL) e JOIN (SELECT * FROM public.person WHERE import_pending_attempt_id IS NULL) p ON p.id=e.person_id AND p.tenant_id=e.tenant_id WHERE e.tenant_id=v_t AND (app.company_org_employment_company(e.id,v_day)=ANY(v_scope) OR e.company_id=ANY(v_scope) OR EXISTS(SELECT 1 FROM assignment future WHERE future.tenant_id=v_t AND future.employment_id=e.id AND future.superseded_at IS NULL AND future.valid_from>v_day AND future.company_id=ANY(v_scope))) ORDER BY e.id LOOP
  v_active:=app.company_org_active(v_emp.id,v_day);v_projection_day:=NULL;
  IF v_active THEN SELECT v_day INTO v_projection_day WHERE EXISTS(SELECT 1 FROM assignment a WHERE a.tenant_id=v_t AND a.employment_id=v_emp.id AND a.superseded_at IS NULL AND a.valid_from<=v_day AND (a.valid_to IS NULL OR a.valid_to>v_day));
  ELSIF v_emp.voided_at IS NULL AND v_emp.hired_on>v_day THEN
   -- Only an already-entered future interval is eligible. Never create an interval for an inactive record.
   SELECT a.valid_from INTO v_projection_day FROM assignment a WHERE a.tenant_id=v_t AND a.employment_id=v_emp.id AND a.superseded_at IS NULL AND a.valid_from>=greatest(v_day,v_emp.hired_on) AND (a.valid_to IS NULL OR a.valid_to>a.valid_from) AND coalesce(a.company_id,v_emp.company_id)=ANY(v_scope) AND app.company_org_active(v_emp.id,a.valid_from) ORDER BY a.valid_from,a.id LIMIT 1;
  END IF;
  IF v_kind<>'retag' AND NOT v_active AND v_projection_day IS NULL THEN CONTINUE;END IF;
  v_co:=app.company_org_employment_company(v_emp.id,coalesce(v_projection_day,v_day));
  IF v_projection_day>v_day THEN
   SELECT min(rn.effective_on) INTO v_next_day FROM company_organisation_mapping m JOIN company_organisation_run rn ON rn.id=m.run_id AND rn.tenant_id=m.tenant_id WHERE m.tenant_id=v_t AND m.company_id=v_co AND rn.state='published' AND rn.effective_on>v_day;
   IF v_next_day IS NOT NULL AND v_projection_day>=v_next_day THEN IF v_kind<>'retag' THEN CONTINUE;ELSE v_projection_day:=NULL;END IF;END IF;
  END IF;
  v_before_tags:=app.company_org_employment_unchecked(v_emp.id,coalesce(v_projection_day,v_day));
  IF v_kind='retag' THEN
   SELECT c.tags INTO v_before_tags FROM employment_organisation_classification c WHERE c.tenant_id=v_t AND c.employment_id=v_emp.id AND c.company_id=v_co AND c.effective_on<=v_day ORDER BY c.effective_on DESC,c.created_at DESC,c.id DESC LIMIT 1;
   IF v_before_tags IS NULL THEN
    v_before_tags:=app.company_org_employment_unchecked(v_emp.id,v_day)||jsonb_build_object('status','legacy','reason',NULL,'mappingVersionId',NULL,'businessUnitId',(SELECT a.business_unit_id FROM assignment a WHERE a.tenant_id=v_t AND a.employment_id=v_emp.id AND a.superseded_at IS NULL AND a.valid_from<=v_day ORDER BY a.valid_from DESC,a.id LIMIT 1));
   END IF;
  END IF;
  v_tags:=app.company_org_resolve(v_co,v_mapping,true);
  v_tags:=v_tags||jsonb_build_object('mappingVersionId',CASE WHEN v_kind='retag' THEN app.company_org_tags_unchecked(v_co,v_day)->'mappingVersionId' ELSE to_jsonb(v_r) END);
  v_status:=CASE WHEN v_emp.voided_at IS NOT NULL THEN 'voided' WHEN v_emp.hired_on>v_day THEN 'future' WHEN v_emp.blacklisted_at IS NOT NULL AND (v_emp.blacklisted_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date<=v_day THEN 'blacklisted' WHEN NOT v_active THEN 'inactive' ELSE 'active' END;
  v_reason:=CASE WHEN v_emp.voided_at IS NOT NULL THEN 'Voided import record retained without a new interval' ELSE v_tags->>'reason' END;
  IF v_active AND v_projection_day IS NULL THEN v_reason:='No existing assignment covers the effective date; repair the source before publication';END IF;
  v_outcome:=CASE WHEN v_active AND v_projection_day IS NULL THEN 'failed' WHEN v_emp.voided_at IS NOT NULL THEN 'skipped' WHEN (v_before_tags-'mappingVersionId') IS NOT DISTINCT FROM (v_tags-'mappingVersionId') THEN 'unchanged' ELSE 'changed' END;
  INSERT INTO company_organisation_run_row(run_id,tenant_id,employment_id,company_id,employee_name,employee_code,company_name,before_labels,after_labels,status,active_on,projection_on,before_tags,after_tags,outcome,reason,source_digest)
   VALUES(v_r,v_t,v_emp.id,v_co,v_emp.full_name,v_emp.employee_code,(SELECT legal_name FROM company WHERE id=v_co AND tenant_id=v_t),app.company_org_tag_labels(v_before_tags),app.company_org_tag_labels(v_tags),v_status,v_active,v_projection_day,v_before_tags,v_tags,v_outcome,v_reason,app.company_org_employment_fingerprint(v_emp.id));
 END LOOP;
 IF (SELECT count(*) FROM company_organisation_run_row WHERE run_id=v_r)>250000 THEN RAISE EXCEPTION 'Split the authorised population into reviewed runs of at most 250000 records';END IF;
 SELECT encode(sha256(convert_to(jsonb_build_object('tenantId',v_t,'kind',v_kind,'effectiveOn',v_day,'requestedBy',v_actor,'scope',v_scope,'authority',v_authority,'mapping',v_mapping,'epoch',v_epoch,'rows',coalesce(jsonb_agg(jsonb_build_array(frozen.employment_id,frozen.company_id,frozen.status,frozen.projection_on,frozen.before_tags,frozen.after_tags,frozen.outcome,frozen.source_digest) ORDER BY frozen.employment_id),'[]'))::text,'UTF8')),'hex') INTO v_token FROM company_organisation_run_row frozen WHERE frozen.run_id=v_r;
 UPDATE company_organisation_run SET digest=v_token,structure=(SELECT jsonb_agg(jsonb_build_object('companyId',c.id,'company',c.legal_name,'before',app.company_org_resolve(c.id,v_old_mapping,NOT v_first_mapping),'after',app.company_org_resolve(c.id,v_mapping,true),'beforeDisplay',app.company_org_tag_labels(app.company_org_resolve(c.id,v_old_mapping,NOT v_first_mapping)),'afterDisplay',app.company_org_tag_labels(app.company_org_resolve(c.id,v_mapping,true))) ORDER BY c.legal_name,c.id) FROM company c WHERE c.tenant_id=v_t AND c.id=ANY(v_scope)) WHERE id=v_r;
 PERFORM app.company_org_append_event(v_t,'organisation-tag-run',v_r,'organisation-tag-run.prepared','user',v_actor,jsonb_build_object('kind',v_kind,'effectiveOn',v_day,'digest',v_token,'companies',v_scope,'population',(SELECT count(*) FROM company_organisation_run_row WHERE run_id=v_r)));
 RETURN v_r;
END $function$;

--> statement-breakpoint
-- app.entra_claim(date) [S:1]
CREATE OR REPLACE FUNCTION app.entra_claim(p_day date)
 RETURNS TABLE(tenant_id uuid, person_id uuid, full_name text, active boolean, revision bigint, lease uuid, mode text, last_location text, last_status text, source_key text, submitted_revision bigint, last_active boolean, submission_started_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
 -- Scheduled transitions are discovered even without a write on the effective date. Never infer deletion from an empty/failed source read.
 UPDATE public.entra_workforce w SET revision=w.revision+1,status='pending',next_at=now(),last_day=p_day
 FROM public.entra_connector c WHERE c.tenant_id=w.tenant_id AND c.provisioning_enabled
 AND EXISTS(SELECT 1 FROM public.tenant t WHERE t.id=c.tenant_id AND t.status IN ('active','trial'))
 AND w.last_day IS DISTINCT FROM p_day AND w.lease_until IS NULL
 AND w.status IN ('ready','disabled','awaiting-sync','awaiting-link')
 AND w.last_active IS DISTINCT FROM app.entra_active(w.tenant_id,w.person_id,p_day);
 RETURN QUERY WITH chosen AS (
 SELECT w.tenant_id,w.person_id FROM public.entra_workforce w JOIN public.entra_connector c USING(tenant_id)
 WHERE c.provisioning_enabled AND EXISTS(SELECT 1 FROM public.tenant t WHERE t.id=c.tenant_id AND t.status IN ('active','trial')) AND w.next_at<=now() AND (w.lease_until IS NULL OR w.lease_until<now())
 AND w.status NOT IN ('ready','disabled','failed','rejected','awaiting-link')
 ORDER BY w.next_at,w.tenant_id,w.person_id FOR UPDATE OF w SKIP LOCKED LIMIT 1
 ), claimed AS (
 UPDATE public.entra_workforce w SET submission_started_at=CASE WHEN w.last_location IS NULL AND w.status='pending' THEN now() ELSE w.submission_started_at END,lease=gen_random_uuid(),lease_until=now()+interval '2 minutes',
 last_status=CASE WHEN w.status='processing' AND w.last_status='awaiting-sync' AND w.submitted_revision=w.revision THEN 'awaiting-sync' WHEN w.status='processing' AND w.last_status='awaiting-sync' THEN 'pending' WHEN w.status='processing' OR (w.status='uncertain' AND w.last_location IS NULL) THEN 'uncertain' WHEN w.last_location IS NOT NULL THEN 'submitted' ELSE w.status END,status='processing',attempts=w.attempts+1,last_day=p_day
 FROM chosen s WHERE w.tenant_id=s.tenant_id AND w.person_id=s.person_id RETURNING w.*)
 SELECT w.tenant_id,w.person_id,p.full_name,app.entra_active(w.tenant_id,w.person_id,p_day),w.revision,w.lease,c.mode,w.last_location,w.last_status,'aihr:'||w.tenant_id||':'||w.person_id,w.submitted_revision,w.last_active,w.submission_started_at
 FROM claimed w JOIN (SELECT * FROM public.person WHERE import_pending_attempt_id IS NULL) p ON p.id=w.person_id AND p.tenant_id=w.tenant_id JOIN public.entra_connector c ON c.tenant_id=w.tenant_id;
END;
$function$;

--> statement-breakpoint
-- app.entra_dirty() [M:1]
CREATE OR REPLACE FUNCTION app.entra_dirty()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE t uuid; p uuid;
BEGIN
 IF NEW.import_pending_attempt_id IS NOT NULL THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='person' THEN t:=NEW.tenant_id; p:=NEW.id; ELSE t:=NEW.tenant_id; p:=NEW.person_id; END IF;
 IF EXISTS(SELECT 1 FROM public.entra_connector WHERE tenant_id=t AND provisioning_enabled) THEN
 INSERT INTO public.entra_workforce(tenant_id,person_id) VALUES(t,p)
 ON CONFLICT(tenant_id,person_id) DO UPDATE SET revision=entra_workforce.revision+1,next_at=now(),status=CASE WHEN entra_workforce.lease IS NOT NULL THEN 'processing' WHEN entra_workforce.status='uncertain' AND entra_workforce.last_location IS NULL THEN 'uncertain' ELSE 'pending' END;
 END IF;
 RETURN NEW;
END;
$function$;

--> statement-breakpoint
-- app.enqueue_replacement_holidays() [M:1]
CREATE OR REPLACE FUNCTION app.enqueue_replacement_holidays()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE payload jsonb;tid uuid;eid uuid;
BEGIN
 payload:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 tid:=(payload->>'tenant_id')::uuid;
 IF TG_TABLE_NAME='employment' THEN eid:=(payload->>'id')::uuid;
 ELSIF payload ? 'employment_id' THEN eid:=(payload->>'employment_id')::uuid;
 END IF;
 INSERT INTO replacement_holiday_queue(tenant_id,employment_id)
 SELECT e.tenant_id,e.id FROM employment e WHERE e.tenant_id=tid AND e.import_pending_attempt_id IS NULL AND (eid IS NULL OR e.id=eid)
 ON CONFLICT(tenant_id,employment_id) DO UPDATE SET generation=replacement_holiday_queue.generation+1,requested_at=now(),claimed_at=NULL,claimed_generation=NULL;
 RETURN NULL;
END $function$;

--> statement-breakpoint
-- Direct child rows written by the hire (no join through employment/person): hidden by a per-statement InitPlan over
-- the tiny partial index, so ordinary reads pay one empty-index probe per statement. Same GUC exception as the parent policy.
CREATE FUNCTION app.import_pending_employment_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(array_agg(e.id),'{}'::uuid[]) FROM public.employment e WHERE e.tenant_id=app.current_tenant_id() AND e.import_pending_attempt_id IS NOT NULL
  AND e.import_pending_attempt_id::text IS DISTINCT FROM current_setting('app.import_attempt',true);
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.import_pending_employment_ids() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.import_pending_employment_ids() TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.import_pending_person_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(array_agg(p.id),'{}'::uuid[]) FROM public.person p WHERE p.tenant_id=app.current_tenant_id() AND p.import_pending_attempt_id IS NOT NULL
  AND p.import_pending_attempt_id::text IS DISTINCT FROM current_setting('app.import_attempt',true);
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.import_pending_person_ids() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.import_pending_person_ids() TO ai_hr_app;
--> statement-breakpoint
CREATE POLICY assignment_import_pending ON public.assignment AS RESTRICTIVE FOR ALL TO ai_hr_app USING (employment_id IS NULL OR NOT (employment_id = ANY ((SELECT app.import_pending_employment_ids())::uuid[])));
--> statement-breakpoint
CREATE POLICY compensation_import_pending ON public.compensation AS RESTRICTIVE FOR ALL TO ai_hr_app USING (employment_id IS NULL OR NOT (employment_id = ANY ((SELECT app.import_pending_employment_ids())::uuid[])));
--> statement-breakpoint
CREATE POLICY leave_ledger_import_pending ON public.leave_ledger AS RESTRICTIVE FOR ALL TO ai_hr_app USING (employment_id IS NULL OR NOT (employment_id = ANY ((SELECT app.import_pending_employment_ids())::uuid[])));
--> statement-breakpoint
CREATE POLICY reporting_line_import_pending ON public.reporting_line AS RESTRICTIVE FOR ALL TO ai_hr_app USING (subordinate_employment_id IS NULL OR NOT (subordinate_employment_id = ANY ((SELECT app.import_pending_employment_ids())::uuid[])));
--> statement-breakpoint
CREATE POLICY employment_tax_selection_my_import_pending ON public.employment_tax_selection_my AS RESTRICTIVE FOR ALL TO ai_hr_app USING (employment_id IS NULL OR NOT (employment_id = ANY ((SELECT app.import_pending_employment_ids())::uuid[])));
--> statement-breakpoint
CREATE POLICY employment_tax_scheme_my_import_pending ON public.employment_tax_scheme_my AS RESTRICTIVE FOR ALL TO ai_hr_app USING (employment_id IS NULL OR NOT (employment_id = ANY ((SELECT app.import_pending_employment_ids())::uuid[])));
--> statement-breakpoint
CREATE POLICY employee_qualification_import_pending ON public.employee_qualification AS RESTRICTIVE FOR ALL TO ai_hr_app USING (employment_id IS NULL OR NOT (employment_id = ANY ((SELECT app.import_pending_employment_ids())::uuid[])));
--> statement-breakpoint
CREATE POLICY employment_cost_allocation_head_import_pending ON public.employment_cost_allocation_head AS RESTRICTIVE FOR ALL TO ai_hr_app USING (employment_id IS NULL OR NOT (employment_id = ANY ((SELECT app.import_pending_employment_ids())::uuid[])));
--> statement-breakpoint
CREATE POLICY employee_statutory_my_import_pending ON public.employee_statutory_my AS RESTRICTIVE FOR ALL TO ai_hr_app USING (person_id IS NULL OR NOT (person_id = ANY ((SELECT app.import_pending_person_ids())::uuid[])));
--> statement-breakpoint
CREATE POLICY employee_dependent_import_pending ON public.employee_dependent AS RESTRICTIVE FOR ALL TO ai_hr_app USING (person_id IS NULL OR NOT (person_id = ANY ((SELECT app.import_pending_person_ids())::uuid[])));
--> statement-breakpoint
CREATE POLICY person_emergency_contact_import_pending ON public.person_emergency_contact AS RESTRICTIVE FOR ALL TO ai_hr_app USING (person_id IS NULL OR NOT (person_id = ANY ((SELECT app.import_pending_person_ids())::uuid[])));
