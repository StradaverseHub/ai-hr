-- Approved board c20f82c3. Source reservation only; activation and historical cutover authority are unchanged.
-- idx 10000 / when 1794998006600. A rehire has a new employment identity; the existing canonical
-- UNIQUE(tenant_id,employment_id) case owner remains stricter than one open case and is preserved.
CREATE TABLE public.probation_reconciliation_intent(
 tenant_id uuid NOT NULL REFERENCES tenant(id),employment_id uuid NOT NULL,
 revision bigint NOT NULL DEFAULT 1,requested_at timestamptz NOT NULL DEFAULT now(),checked_at timestamptz,
 retry_on timestamptz NOT NULL DEFAULT now(),failure boolean NOT NULL DEFAULT false,
 PRIMARY KEY(tenant_id,employment_id),FOREIGN KEY(tenant_id,employment_id) REFERENCES employment(tenant_id,id)
);
CREATE INDEX probation_reconciliation_due ON public.probation_reconciliation_intent(retry_on,tenant_id,employment_id);
CREATE TABLE public.probation_reconciliation_schedule(
 tenant_id uuid PRIMARY KEY REFERENCES tenant(id),cursor_id uuid,
 next_check_at timestamptz NOT NULL DEFAULT now(),started_at timestamptz,last_success_at timestamptz,
 pass_count bigint NOT NULL DEFAULT 0
);
ALTER TABLE public.probation_reconciliation_intent ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.probation_reconciliation_intent FORCE ROW LEVEL SECURITY;
ALTER TABLE public.probation_reconciliation_schedule ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.probation_reconciliation_schedule FORCE ROW LEVEL SECURITY;
CREATE POLICY probation_reconciliation_owner ON public.probation_reconciliation_intent FOR ALL TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
CREATE POLICY probation_reconciliation_owner ON public.probation_reconciliation_schedule FOR ALL TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
REVOKE ALL ON public.probation_reconciliation_intent,public.probation_reconciliation_schedule FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Only authenticated canonical row writes can reach these AFTER triggers. They record intent, never
-- run admission, change configuration or issue work in a Personnel transaction. Replays coalesce.
CREATE FUNCTION app.probation_queue_personnel_reconciliation() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid; e uuid;
BEGIN
 t:=NEW.tenant_id;e:=coalesce(to_jsonb(NEW)->>'employment_id',to_jsonb(NEW)->>'id')::uuid;
 INSERT INTO public.probation_reconciliation_schedule(tenant_id) VALUES(t) ON CONFLICT DO NOTHING;
 INSERT INTO public.probation_reconciliation_intent(tenant_id,employment_id) VALUES(t,e)
 ON CONFLICT(tenant_id,employment_id) DO UPDATE SET revision=probation_reconciliation_intent.revision+1,requested_at=now(),retry_on=now(),failure=false;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.probation_queue_personnel_reconciliation() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER probation_employment_reconcile AFTER INSERT OR UPDATE OF company_id,grade_id,hired_on,join_date,confirmation_date,final_confirmation_date,extended_confirmation_date,probation_end_date,provisional_end_on,probation_value,probation_unit,probation_months,resignation_date,terminated_on,voided_at,import_pending_attempt_id ON public.employment FOR EACH ROW EXECUTE FUNCTION app.probation_queue_personnel_reconciliation();
CREATE TRIGGER probation_assignment_reconcile AFTER INSERT OR UPDATE OF valid_from,valid_to,superseded_at,employment_type,department_id,business_unit_id ON public.assignment FOR EACH ROW EXECUTE FUNCTION app.probation_queue_personnel_reconciliation();
--> statement-breakpoint
-- Setup publications/activation request a bounded rescan. No fanout over employees in a web write.
CREATE FUNCTION app.probation_queue_setup_reconciliation() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 INSERT INTO public.probation_reconciliation_schedule(tenant_id) VALUES(NEW.tenant_id)
 ON CONFLICT(tenant_id) DO UPDATE SET next_check_at=least(probation_reconciliation_schedule.next_check_at,now());
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.probation_queue_setup_reconciliation() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER probation_configuration_reconcile AFTER INSERT OR UPDATE ON public.probation_configuration FOR EACH ROW EXECUTE FUNCTION app.probation_queue_setup_reconciliation();
CREATE TRIGGER probation_activation_reconcile AFTER INSERT OR UPDATE ON public.probation_activation FOR EACH ROW EXECUTE FUNCTION app.probation_queue_setup_reconciliation();
CREATE TRIGGER probation_intake_reconcile AFTER INSERT OR UPDATE ON public.probation_intake_entry FOR EACH ROW EXECUTE FUNCTION app.probation_queue_personnel_reconciliation();
--> statement-breakpoint
-- One set-based source for the discrepancy reader and worker admission preflight. The grade expression
-- is identical to the canonical Personnel source: original hire grade when recorded, otherwise current grade.
-- It deliberately does not call the single-person source/role functions once per employee.
CREATE FUNCTION app.probation_reconciliation_population(p_company uuid DEFAULT NULL,p_employment uuid DEFAULT NULL) RETURNS TABLE(
 employment_id uuid,person_id uuid,company_id uuid,employee_name text,employee_code text,company_name text,
 department_id uuid,business_unit_id uuid,grade text,reasons text[],
 holder_employee uuid,holder_lm uuid,holder_hod uuid,holder_pbp uuid
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET jit=off AS $$
 WITH day AS MATERIALIZED(SELECT (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date d),
 companies AS MATERIALIZED(SELECT c.id,c.legal_name,app.probation_company_entitled(c.id) entitled FROM public.company c WHERE c.tenant_id=app.current_tenant_id() AND c.archived_at IS NULL AND(p_company IS NULL OR c.id=p_company)),
 employments AS MATERIALIZED(
  SELECT e.*,coalesce(e.join_date,e.hired_on) start_on FROM public.employment e JOIN companies co ON co.id=e.company_id CROSS JOIN day
  WHERE e.tenant_id=app.current_tenant_id() AND(p_employment IS NULL OR e.id=p_employment) AND co.entitled AND e.voided_at IS NULL AND e.import_pending_attempt_id IS NULL
   AND(app.employment_status_on(e.blacklisted_at::timestamptz,e.resignation_date,e.last_working_date,e.terminated_on,e.final_confirmation_date,e.confirmation_date,e.probation_end_date,e.provisional_end_on,day.d)='probation' OR coalesce(e.join_date,e.hired_on)>day.d AND e.blacklisted_at IS NULL AND e.confirmation_date IS NULL AND e.resignation_date IS NULL AND e.terminated_on IS NULL AND coalesce(e.probation_value,e.probation_months,-1)<>0)
   AND NOT EXISTS(SELECT 1 FROM public.probation_case c WHERE c.tenant_id=e.tenant_id AND c.employment_id=e.id AND c.data->>'state' NOT IN('withdrawn','confirmed','not_confirmed'))),
 holders AS MATERIALIZED(SELECT * FROM app.probation_holders_set(ARRAY(SELECT id FROM employments))),
 assignments AS MATERIALIZED(
  SELECT DISTINCT ON(a.employment_id) a.employment_id,a.department_id,a.business_unit_id,a.employment_type
  FROM public.assignment a JOIN employments e ON e.id=a.employment_id CROSS JOIN day
  WHERE a.tenant_id=app.current_tenant_id() AND a.superseded_at IS NULL AND(a.valid_from<=day.d AND(a.valid_to IS NULL OR a.valid_to>day.d) OR e.start_on>day.d AND a.valid_from<=e.start_on AND(a.valid_to IS NULL OR a.valid_to>e.start_on))
  ORDER BY a.employment_id,CASE WHEN a.valid_from<=day.d AND(a.valid_to IS NULL OR a.valid_to>day.d) THEN 0 ELSE 1 END,a.valid_from DESC,a.id),
 hired AS MATERIALIZED(
  SELECT DISTINCT ON(ev.subject_employment_id) ev.subject_employment_id,(ev.payload->>'gradeId')::uuid grade_id FROM public.domain_event ev JOIN employments e ON e.id=ev.subject_employment_id
  WHERE ev.tenant_id=app.current_tenant_id() AND ev.event_type='employment.hired' AND ev.payload->>'gradeId' IS NOT NULL ORDER BY ev.subject_employment_id,ev.sequence),
 configurations AS MATERIALIZED(
  SELECT DISTINCT ON(c.company_id,c.kind) c.company_id,c.kind,c.id,c.data FROM public.probation_configuration c JOIN companies co ON co.id=c.company_id
  WHERE c.tenant_id=app.current_tenant_id() AND c.state='published' ORDER BY c.company_id,c.kind,c.version DESC),
 reviewed AS MATERIALIZED(
  SELECT DISTINCT imported->>'employmentId' employment_id FROM public.probation_cutover b JOIN public.probation_activation a ON a.tenant_id=b.tenant_id AND a.company_id=b.company_id AND a.enabled AND a.dry_run_digest=b.digest
  CROSS JOIN LATERAL jsonb_array_elements(coalesce(b.data->'imports','[]')) imported WHERE b.tenant_id=app.current_tenant_id() AND b.approved_by IS NOT NULL AND b.applied_at IS NOT NULL AND b.data->>'planComplete'='true'),
 grades AS MATERIALIZED(SELECT e.id,regexp_replace(upper(coalesce(g.code,'')),'^(JG|GRADE)[ -]*','','g') code FROM employments e LEFT JOIN hired h ON h.subject_employment_id=e.id LEFT JOIN public.job_grade g ON g.id=coalesce(h.grade_id,e.grade_id) AND g.tenant_id=e.tenant_id),
 forms AS MATERIALIZED(
  SELECT c.company_id,c.data FROM public.probation_configuration c JOIN companies co ON co.id=c.company_id
  WHERE c.tenant_id=app.current_tenant_id() AND c.kind='form' AND c.state='published' AND app.probation_current_publication(c.company_id,'form',c.id)),
 facts AS MATERIALIZED(
  SELECT e.*,p.full_name,co.legal_name,a.department_id,a.business_unit_id,a.employment_type,g.code,h.employee holder_employee,h.lm holder_lm,h.hod holder_hod,h.pbp holder_pbp,EXISTS(SELECT 1 FROM reviewed r WHERE r.employment_id=e.id::text) reviewed,
   EXISTS(SELECT 1 FROM public.probation_intake_entry i WHERE i.tenant_id=e.tenant_id AND i.employment_id=e.id AND i.data->>'validatedUnknown'='true' AND i.reviewed_by=h.pbp) validated,
   settings.data settings,route.id route_id,act.enabled,act.activation_on,
   EXISTS(SELECT 1 FROM forms f WHERE f.company_id=e.company_id AND coalesce(f.data->'targetGrades','["12","13","14","15","16","17","18","19","20","21","22","23"]')?g.code) form_ready,
   EXISTS(SELECT 1 FROM public.probation_case c WHERE c.tenant_id=e.tenant_id AND c.employment_id=e.id) prior_case,
   EXISTS(SELECT 1 FROM public.probation_intake_entry i WHERE i.tenant_id=e.tenant_id AND i.employment_id=e.id AND(i.data->>'kind'='exclude' OR EXISTS(SELECT 1 FROM jsonb_each(coalesce(i.data->'exclusionFlags','{}')) x WHERE x.value='true'::jsonb))) excluded
  FROM employments e JOIN companies co ON co.id=e.company_id JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
  LEFT JOIN assignments a ON a.employment_id=e.id LEFT JOIN grades g ON g.id=e.id LEFT JOIN holders h ON h.employment_id=e.id
  LEFT JOIN configurations settings ON settings.company_id=e.company_id AND settings.kind='settings'
  LEFT JOIN configurations route ON route.company_id=e.company_id AND route.kind='route'
  LEFT JOIN public.probation_activation act ON act.tenant_id=e.tenant_id AND act.company_id=e.company_id)
 SELECT f.id,f.person_id,f.company_id,f.full_name,f.employee_code::text,f.legal_name,f.department_id,f.business_unit_id,f.code,
  array_remove(ARRAY[
   CASE WHEN f.settings IS NULL THEN 'settings' END,
   CASE WHEN NOT f.form_ready THEN 'form' END,
   CASE WHEN f.route_id IS NULL THEN 'route' END,
   CASE WHEN f.enabled IS DISTINCT FROM true THEN 'activation' END,
   CASE WHEN coalesce(f.code,'')='' THEN 'grade_missing' END,
   CASE WHEN f.settings IS NOT NULL AND coalesce(f.code,'')<>'' AND NOT(f.settings->'eligibleGrades'?f.code) AND NOT(f.code='H' AND f.settings->>'gradeHEnabled'='true' AND f.form_ready) THEN 'grade_ineligible' END,
   CASE WHEN f.employment_type IS NULL THEN 'assignment' WHEN f.employment_type<>'full_time' THEN 'employment_type' END,
   CASE WHEN coalesce(f.probation_value,-1)=0 OR coalesce(f.probation_months,-1)=0 THEN 'no_probation' END,
   CASE WHEN NOT(f.reviewed OR f.validated) AND coalesce(f.final_confirmation_date,f.extended_confirmation_date,f.confirmation_date,f.probation_end_date,f.provisional_end_on) IS NULL AND f.probation_value IS NULL AND f.probation_months IS NULL THEN 'period_review' END,
   CASE WHEN NOT(f.reviewed OR f.validated) AND(f.join_date IS NOT NULL AND f.join_date IS DISTINCT FROM f.hired_on OR EXISTS(SELECT 1 FROM public.employment earlier WHERE earlier.tenant_id=f.tenant_id AND earlier.person_id=f.person_id AND earlier.id<>f.id AND least(earlier.terminated_on,earlier.resignation_date,earlier.last_working_date)<f.start_on)) THEN 'eligibility_review' END,
   CASE WHEN f.excluded THEN 'excluded' END,
   CASE WHEN NOT f.reviewed AND(f.start_on<f.activation_on OR f.extended_confirmation_date IS NOT NULL) THEN 'cutover' END,
   CASE WHEN f.prior_case THEN 'prior_case' END
  ],NULL)::text[],f.holder_employee,f.holder_lm,f.holder_hod,f.holder_pbp FROM facts f;
$$;
REVOKE ALL ON FUNCTION app.probation_reconciliation_population(uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Reader: one authorised population, one aggregate count and SQL page. Holder identities are resolved
-- once for the whole set, and legacy GBS mappings are intersected with their department/unit scope.
CREATE FUNCTION app.probation_reconciliation_view(p_company uuid,p_offset integer,p_limit integer) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET jit=off AS $$
DECLARE result jsonb;t uuid:=app.current_tenant_id();me uuid:=app.current_user_id();active boolean:=app.probation_active_user();
BEGIN
 IF NOT(active OR app.probation_storage_runner()) THEN RAISE EXCEPTION 'Probation view permission required' USING ERRCODE='42501';END IF;
 WITH population AS MATERIALIZED(SELECT * FROM app.probation_reconciliation_population(p_company)),
 allowed_companies AS MATERIALIZED(SELECT company_id FROM app.probation_permitted_companies(me,ARRAY['cases.view','cases.letters','cases.low_result','cases.route','settings.configure','settings.intake'])),
 config_companies AS MATERIALIZED(SELECT c.id FROM public.company c WHERE c.tenant_id=t AND(p_company IS NULL OR c.id=p_company) AND app.probation_config_admin(c.id)),
 ops_companies AS MATERIALIZED(SELECT c.id FROM public.company c WHERE c.tenant_id=t AND(p_company IS NULL OR c.id=p_company) AND app.lifecycle_canonical_people_ops_member(c.id,me)),
 ancestor AS MATERIALIZED(SELECT * FROM app.probation_company_ancestors(ARRAY(SELECT DISTINCT company_id FROM population))),
 gbs AS MATERIALIZED(SELECT a.* FROM public.probation_access a WHERE a.tenant_id=t AND a.user_id=me AND a.role='gbs' AND a.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND(a.valid_to IS NULL OR a.valid_to>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)),
 visible AS MATERIALIZED(
  SELECT p.* FROM population p WHERE app.probation_storage_runner()
   OR p.company_id IN(SELECT company_id FROM allowed_companies) OR p.company_id IN(SELECT id FROM config_companies)
   OR me=p.holder_employee OR me=p.holder_hod OR me=p.holder_pbp
   OR me=p.holder_lm AND(SELECT r.enabled AND r.can_view FROM app.probation_superior_rule() r)
   OR EXISTS(SELECT 1 FROM gbs g JOIN ancestor a ON a.company_id=p.company_id AND a.ancestor_id=g.company_id WHERE(g.department_id IS NULL OR g.department_id=p.department_id) AND(g.business_unit_id IS NULL OR g.business_unit_id=p.business_unit_id) AND p.company_id IN(SELECT id FROM ops_companies))),
 page AS MATERIALIZED(SELECT * FROM visible ORDER BY employee_name,employee_code NULLS LAST,employment_id OFFSET greatest(0,p_offset) LIMIT least(100,greatest(1,p_limit)))
 SELECT jsonb_build_object('total',(SELECT count(*)::integer FROM visible),'offset',greatest(0,p_offset),'limit',least(100,greatest(1,p_limit)),
  'rows',coalesce((SELECT jsonb_agg(jsonb_build_object('employmentId',p.employment_id,'employeeName',p.employee_name,'employeeCode',p.employee_code,'companyId',p.company_id,'companyName',p.company_name,'grade',p.grade,'reasons',CASE WHEN cardinality(p.reasons)>0 THEN p.reasons ELSE CASE WHEN coalesce(i.failure,false) THEN ARRAY['retry']::text[] ELSE '{}'::text[] END END,'missingBusinessUnit',p.business_unit_id IS NULL) ORDER BY p.employee_name,p.employee_code NULLS LAST,p.employment_id) FROM page p LEFT JOIN public.probation_reconciliation_intent i ON i.tenant_id=t AND i.employment_id=p.employment_id),'[]'::jsonb),
  'lastSuccessfulCheck',(SELECT last_success_at FROM public.probation_reconciliation_schedule WHERE tenant_id=t),
  'checkStale',coalesce((SELECT last_success_at IS NULL OR last_success_at<now()-interval '30 minutes' FROM public.probation_reconciliation_schedule WHERE tenant_id=t),true)) INTO result;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.probation_reconciliation_view(uuid,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.probation_reconciliation_view(uuid,integer,integer) TO ai_hr_app;
--> statement-breakpoint
-- Source catch-up is queued lazily by the worker with a durable keyset cursor: no bulk write/backfill
-- in the migration and no runtime activation. This also discovers tenants that existed before the triggers.
CREATE FUNCTION app.probation_reconciliation_schedule_tick() RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET jit=off AS $$
DECLARE scan_state public.probation_reconciliation_schedule;last_id uuid;n integer;
BEGIN
 IF app.current_user_id() IS NOT NULL OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=session_user AND(rolname='ai_hr_owner' OR rolsuper)) THEN RAISE EXCEPTION 'Physical no-login owner worker required' USING ERRCODE='42501';END IF;
 INSERT INTO public.probation_reconciliation_schedule(tenant_id) SELECT t.id FROM public.tenant t WHERE t.status IN('active','trial') AND NOT EXISTS(SELECT 1 FROM public.probation_reconciliation_schedule existing_schedule WHERE existing_schedule.tenant_id=t.id) ORDER BY t.id LIMIT 100 ON CONFLICT DO NOTHING;
 SELECT q.* INTO scan_state FROM public.probation_reconciliation_schedule q JOIN public.tenant t ON t.id=q.tenant_id AND t.status IN('active','trial') WHERE q.next_check_at<=now() AND(q.cursor_id IS NOT NULL OR q.started_at IS NULL) ORDER BY q.next_check_at,q.tenant_id LIMIT 1 FOR UPDATE OF q SKIP LOCKED;
 IF NOT FOUND THEN RETURN false;END IF;
 -- Preserve a partially scanned pass across restarts. Only bounded 100-row source slices are queued.
 WITH cohort AS MATERIALIZED(SELECT e.id FROM public.employment e WHERE e.tenant_id=scan_state.tenant_id AND(scan_state.cursor_id IS NULL OR e.id>scan_state.cursor_id) AND e.voided_at IS NULL AND e.import_pending_attempt_id IS NULL
 AND(e.confirmation_date IS NULL AND e.resignation_date IS NULL AND e.terminated_on IS NULL)
 AND(app.employment_status_on(e.blacklisted_at::timestamptz,e.resignation_date,e.last_working_date,e.terminated_on,e.final_confirmation_date,e.confirmation_date,e.probation_end_date,e.provisional_end_on,(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)='probation' OR coalesce(e.join_date,e.hired_on)>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND coalesce(e.probation_value,e.probation_months,-1)<>0)
 AND NOT EXISTS(SELECT 1 FROM public.probation_case c WHERE c.tenant_id=e.tenant_id AND c.employment_id=e.id AND c.data->>'state' NOT IN('withdrawn','confirmed','not_confirmed')) ORDER BY e.id LIMIT 100),
 queued AS(INSERT INTO public.probation_reconciliation_intent(tenant_id,employment_id) SELECT scan_state.tenant_id,c.id FROM cohort c
 ON CONFLICT(tenant_id,employment_id) DO UPDATE SET revision=probation_reconciliation_intent.revision+1,requested_at=now(),retry_on=now(),failure=false RETURNING employment_id)
 SELECT count(*)::integer,(array_agg(employment_id ORDER BY employment_id DESC))[1] INTO n,last_id FROM queued;
 UPDATE public.probation_reconciliation_schedule SET cursor_id=CASE WHEN n=100 THEN last_id ELSE NULL END,
  started_at=coalesce(started_at,now()),next_check_at=CASE WHEN n=100 THEN now() ELSE now()+interval '15 minutes' END,
  pass_count=pass_count+CASE WHEN n<100 THEN 1 ELSE 0 END WHERE tenant_id=scan_state.tenant_id;
 IF n<100 THEN
  UPDATE public.probation_reconciliation_schedule target SET last_success_at=now(),started_at=NULL WHERE target.tenant_id=scan_state.tenant_id AND NOT EXISTS(SELECT 1 FROM public.probation_reconciliation_intent i WHERE i.tenant_id=scan_state.tenant_id AND(i.checked_at IS NULL OR i.checked_at<i.requested_at OR i.failure));
 END IF;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION app.probation_reconciliation_schedule_tick() FROM PUBLIC,ai_hr_app;
