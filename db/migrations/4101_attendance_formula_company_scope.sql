-- Existing identities and immutable revisions keep their original company and evidence.
-- New revisions may carry an explicitly reviewed company snapshot; evidence records the actual company.
ALTER TABLE public.attendance_formula ADD CONSTRAINT attendance_formula_identity_tenant_uq UNIQUE(id,tenant_id);
ALTER TABLE public.attendance_formula_revision ADD CONSTRAINT attendance_formula_revision_identity_uq UNIQUE(id,formula_id,tenant_id);
ALTER TABLE public.attendance_formula_test ADD CONSTRAINT attendance_formula_test_identity_uq UNIQUE(id,formula_id,revision_id,tenant_id);
DO $$
DECLARE fk record;
BEGIN
 FOR fk IN SELECT conrelid::regclass AS rel,conname FROM pg_constraint
 WHERE contype='f' AND (
   (confrelid='public.attendance_formula_revision'::regclass AND conrelid IN ('public.attendance_formula_test'::regclass,'public.attendance_formula_result'::regclass))
   OR (confrelid='public.attendance_formula_test'::regclass AND conrelid='public.attendance_formula_event'::regclass)
   OR (confrelid='public.attendance_formula'::regclass AND conrelid='public.payroll_attendance_allowance_source'::regclass AND cardinality(conkey)=3))
 LOOP
  EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',fk.rel,fk.conname);
 END LOOP;
END $$;
ALTER TABLE public.attendance_formula_test ADD CONSTRAINT attendance_formula_test_revision_fk
 FOREIGN KEY(revision_id,formula_id,tenant_id) REFERENCES public.attendance_formula_revision(id,formula_id,tenant_id);
ALTER TABLE public.attendance_formula_result ADD CONSTRAINT attendance_formula_result_revision_fk
 FOREIGN KEY(revision_id,formula_id,tenant_id) REFERENCES public.attendance_formula_revision(id,formula_id,tenant_id);
ALTER TABLE public.attendance_formula_event ADD CONSTRAINT attendance_formula_event_test_fk
 FOREIGN KEY(test_id,formula_id,revision_id,tenant_id) REFERENCES public.attendance_formula_test(id,formula_id,revision_id,tenant_id);
ALTER TABLE public.payroll_attendance_allowance_source ADD CONSTRAINT attendance_contribution_formula_owner_fk
 FOREIGN KEY(formula_id,tenant_id) REFERENCES public.attendance_formula(id,tenant_id);
--> statement-breakpoint
CREATE FUNCTION app.attendance_formula_companies(p_anchor uuid,p_definition jsonb) RETURNS uuid[]
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN p_definition ? 'companyScope' THEN
  ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(p_definition->'companyScope'->'companyIds') ORDER BY value::uuid)
  ELSE ARRAY[p_anchor] END
$$;
REVOKE ALL ON FUNCTION app.attendance_formula_companies(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.attendance_formula_companies(uuid,jsonb) TO ai_hr_app;

CREATE FUNCTION app.attendance_formula_manage_scope(p_anchor uuid,p_definition jsonb) RETURNS boolean
LANGUAGE sql STABLE STRICT SET search_path=pg_catalog,public,app,pg_temp AS $$
 SELECT app.attendance_policy_principal_current() AND app.is_admin_for(p_anchor)
 AND (p_definition->'companyScope'->>'mode' IS DISTINCT FROM 'all' OR app.is_group_admin())
 AND NOT EXISTS(SELECT 1 FROM unnest(app.attendance_formula_companies(p_anchor,p_definition)) AS selected(id)
  WHERE app.is_admin_for(selected.id) IS DISTINCT FROM true)
$$;
REVOKE ALL ON FUNCTION app.attendance_formula_manage_scope(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.attendance_formula_manage_scope(uuid,jsonb) TO ai_hr_app;

-- These tables force RLS even for the migration owner. Only the owning role used by the
-- narrowly scoped definers below may read the tenant's configuration across company anchors.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['attendance_formula','attendance_formula_revision','attendance_formula_event'] LOOP
  EXECUTE format('CREATE POLICY attendance_formula_owner_read ON public.%I FOR SELECT USING(
   current_user=pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid=%L::regclass))
   AND tenant_id=app.current_tenant_id() AND app.attendance_policy_principal_current() AND app.is_admin())',t,'public.'||t);
 END LOOP;
END $$;

-- Select the actual latest revision before checking authority. A scoped author must never edit a
-- previously visible revision after another author expands the current formula to more companies.
CREATE FUNCTION app.attendance_formula_author_current(p_formula uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=on AS $$
 SELECT EXISTS(SELECT 1 FROM public.attendance_formula f
  JOIN LATERAL(SELECT definition FROM public.attendance_formula_revision v WHERE v.formula_id=f.id ORDER BY ordinal DESC LIMIT 1) latest ON true
  LEFT JOIN LATERAL(SELECT e.kind,e.revision_id FROM public.attendance_formula_event e WHERE e.formula_id=f.id
   AND e.kind IN('activated','deactivated','archived') ORDER BY e.sequence DESC LIMIT 1) state ON state.kind='activated'
  LEFT JOIN public.attendance_formula_revision active ON active.id=state.revision_id AND active.formula_id=f.id
  WHERE f.id=p_formula AND f.tenant_id=app.current_tenant_id()
   AND app.attendance_formula_manage_scope(f.company_id,latest.definition)
   AND (active.id IS NULL OR app.attendance_formula_manage_scope(f.company_id,active.definition)))
$$;
REVOKE ALL ON FUNCTION app.attendance_formula_author_current(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.attendance_formula_author_current(uuid) TO ai_hr_app;

ALTER POLICY attendance_formula_read ON public.attendance_formula_revision
 USING(tenant_id=app.current_tenant_id() AND app.attendance_formula_manage_scope(company_id,definition));
ALTER POLICY attendance_formula_insert ON public.attendance_formula_revision
 WITH CHECK(tenant_id=app.current_tenant_id() AND created_by=app.current_user_id() AND app.attendance_formula_manage_scope(company_id,definition));

ALTER POLICY attendance_formula_read ON public.attendance_formula_test
 USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM public.attendance_formula_revision r
  WHERE r.id=attendance_formula_test.revision_id AND r.formula_id=attendance_formula_test.formula_id AND r.tenant_id=attendance_formula_test.tenant_id
  AND attendance_formula_test.company_id=ANY(app.attendance_formula_companies(r.company_id,r.definition))
  AND app.attendance_formula_trace_access(attendance_formula_test.company_id,attendance_formula_test.employment_id,r.read_requirements)));
ALTER POLICY attendance_formula_insert ON public.attendance_formula_test
 WITH CHECK(tenant_id=app.current_tenant_id() AND created_by=app.current_user_id() AND EXISTS(SELECT 1 FROM public.attendance_formula_revision r
  WHERE r.id=attendance_formula_test.revision_id AND r.formula_id=attendance_formula_test.formula_id AND r.tenant_id=attendance_formula_test.tenant_id
  AND attendance_formula_test.company_id=ANY(app.attendance_formula_companies(r.company_id,r.definition))
  AND app.attendance_formula_trace_access(attendance_formula_test.company_id,attendance_formula_test.employment_id,r.read_requirements)));
--> statement-breakpoint
CREATE FUNCTION app.attendance_formula_check_scope(p_anchor uuid,p_definition jsonb,p_item uuid) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE ids uuid[];all_ids uuid[];actor_tenant uuid:=app.current_tenant_id();p_scope jsonb:=p_definition->'companyScope';
BEGIN
 IF p_scope IS NOT NULL AND (
    jsonb_typeof(p_scope) IS DISTINCT FROM 'object' OR p_scope->>'mode' IS NULL OR p_scope->>'mode' NOT IN('selected','all')
    OR jsonb_typeof(p_scope->'companyIds') IS DISTINCT FROM 'array'
    OR p_scope-ARRAY['mode','companyIds']<>'{}'::jsonb) THEN
  RAISE EXCEPTION 'Choose a valid Attendance formula company scope';
 END IF;
 ids:=app.attendance_formula_companies(p_anchor,p_definition);
 IF cardinality(ids) NOT BETWEEN 1 AND 500 OR cardinality(ids)<>(SELECT count(DISTINCT id) FROM unnest(ids) x(id))
    OR NOT coalesce(app.attendance_formula_manage_scope(p_anchor,p_definition),false)
    OR EXISTS(SELECT 1 FROM unnest(ids) x(id) WHERE NOT EXISTS(SELECT 1 FROM public.company c
      WHERE c.id=x.id AND c.tenant_id=actor_tenant AND c.archived_at IS NULL AND (p_scope IS NULL OR c.currency='MYR'))) THEN
  RAISE EXCEPTION 'Choose active MYR companies you can administer';
 END IF;
 IF p_scope->>'mode'='all' THEN
  SELECT array_agg(id ORDER BY id) INTO all_ids FROM public.company WHERE tenant_id=actor_tenant AND archived_at IS NULL;
  IF all_ids IS DISTINCT FROM ids THEN RAISE EXCEPTION 'Company coverage changed. Save and test an updated version.' USING ERRCODE='AF002'; END IF;
 END IF;
 IF p_scope IS NOT NULL AND p_definition->'eligibility'->>'mode'='selected' AND
  EXISTS(SELECT 1 FROM app.proven_company_date_points((SELECT jsonb_agg(jsonb_build_object('employmentId',value,'date',p_definition->>'effectiveFrom'))
    FROM jsonb_array_elements_text(p_definition->'eligibility'->'employmentIds'))) p
   WHERE p.reason IS NOT NULL OR p.company_id IS NULL OR NOT(p.company_id=ANY(ids)) OR NOT app.can_admin_employment(p.employment_id)) THEN
  RAISE EXCEPTION 'Every selected employee must belong to a formula company on the effective date';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.pay_component p WHERE p.id=p_item AND p.tenant_id=actor_tenant
    AND p.archived_at IS NULL AND p.pending_input_kind IS NULL AND NOT p.is_non_payable AND p.kind IN('allowance','deduction')
    AND (p.kind='deduction')=(p_definition->>'purpose'='deduction') AND (p.applied_company_ids IS NULL OR p.applied_company_ids @> ids)) THEN
  RAISE EXCEPTION 'Choose a Pay Item available in every selected company';
 END IF;
END $$;
REVOKE ALL ON FUNCTION app.attendance_formula_check_scope(uuid,jsonb,uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION app.attendance_formula_binding_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=on AS $$
DECLARE f public.attendance_formula; r public.attendance_formula_revision; proof public.attendance_formula_test;
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.created_by IS DISTINCT FROM app.current_user_id()
    OR NOT coalesce(app.attendance_policy_principal_current() AND app.is_admin_for(NEW.company_id),false) THEN
  RAISE EXCEPTION 'Attendance formula or scope is unavailable' USING ERRCODE='42501';
 END IF;
 SELECT * INTO f FROM public.attendance_formula WHERE id=NEW.formula_id AND tenant_id=NEW.tenant_id AND company_id=NEW.company_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Attendance formula or scope is unavailable'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text||':attendance-formula:'||NEW.formula_id::text,0));
 IF EXISTS(SELECT 1 FROM public.attendance_formula_event WHERE formula_id=f.id AND kind='archived') THEN
  RAISE EXCEPTION 'An archived formula retains its history and cannot change';
 END IF;
 SELECT * INTO r FROM public.attendance_formula_revision WHERE formula_id=f.id ORDER BY ordinal DESC LIMIT 1;
 IF r.id IS NOT NULL AND NOT coalesce(app.attendance_formula_manage_scope(f.company_id,r.definition),false) THEN
  RAISE EXCEPTION 'The saved company scope requires administration access' USING ERRCODE='42501';
 END IF;
 IF EXISTS(SELECT 1 FROM (
  SELECT e.kind,e.revision_id FROM public.attendance_formula_event e
  WHERE e.formula_id=f.id AND e.kind IN('activated','deactivated','archived') ORDER BY e.sequence DESC LIMIT 1
 ) state JOIN public.attendance_formula_revision active ON active.id=state.revision_id
 WHERE state.kind='activated' AND NOT coalesce(app.attendance_formula_manage_scope(f.company_id,active.definition),false)) THEN
  RAISE EXCEPTION 'The active company scope requires administration access' USING ERRCODE='42501';
 END IF;
 IF TG_TABLE_NAME='attendance_formula_revision' THEN
  IF NEW.definition->>'code' IS DISTINCT FROM f.code OR NEW.ordinal<>coalesce(r.ordinal,0)+1 THEN
   RAISE EXCEPTION 'Save the next exact formula version';
  END IF;
  PERFORM app.attendance_formula_check_scope(f.company_id,NEW.definition,NEW.pay_component_id);
 ELSIF TG_TABLE_NAME='attendance_formula_event' AND NEW.kind IN('tested','activated') THEN
  IF r.id IS DISTINCT FROM NEW.revision_id THEN RAISE EXCEPTION 'Use the current saved version'; END IF;
  SELECT * INTO proof FROM public.attendance_formula_test WHERE id=NEW.test_id AND formula_id=f.id AND revision_id=r.id AND tenant_id=f.tenant_id AND passed;
  IF NOT FOUND OR NOT coalesce(proof.company_id=ANY(app.attendance_formula_companies(f.company_id,r.definition))
   AND app.attendance_formula_trace_access(proof.company_id,proof.employment_id,r.read_requirements),false) THEN
   RAISE EXCEPTION 'A matching successful actual-attendance test is required';
  END IF;
  IF NEW.kind='activated' THEN
   PERFORM pg_advisory_xact_lock(hashtextextended(f.tenant_id::text||':attendance-formula-activation',0));
   PERFORM app.attendance_formula_check_scope(f.company_id,r.definition,r.pay_component_id);
   -- Effective scopes are open-ended. Treat criteria as possibly overlapping. Two explicit employee
   -- lists with no common ID can coexist; otherwise only the existing compatible Sum/Priority rules apply.
   IF EXISTS(SELECT 1 FROM public.attendance_formula other
     JOIN LATERAL(SELECT kind,revision_id FROM public.attendance_formula_event e WHERE e.formula_id=other.id
      AND e.kind IN('activated','deactivated','archived') ORDER BY sequence DESC LIMIT 1) current_state ON current_state.kind='activated'
     JOIN public.attendance_formula_revision v ON v.id=current_state.revision_id
     WHERE other.tenant_id=f.tenant_id AND other.id<>f.id
     AND app.attendance_formula_companies(other.company_id,v.definition) && app.attendance_formula_companies(f.company_id,r.definition)
     AND (lower(other.code)=lower(f.code) OR (v.pay_component_id=r.pay_component_id
      AND (v.definition->'eligibility'->>'mode' IS DISTINCT FROM 'selected' OR r.definition->'eligibility'->>'mode' IS DISTINCT FROM 'selected'
       OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(v.definition->'eligibility'->'employmentIds') e(id)
         WHERE r.definition->'eligibility'->'employmentIds' ? e.id))
      AND NOT coalesce(v.definition->'period'=r.definition->'period' AND (
       (v.definition->'posting'->>'kind'='sum' AND r.definition->'posting'->>'kind'='sum') OR
       (v.definition->'posting'->>'kind'='priority' AND r.definition->'posting'->>'kind'='priority'
        AND v.definition->'posting'->>'priority'<>r.definition->'posting'->>'priority')),false)))) THEN
    RAISE EXCEPTION 'An active formula overlaps this company scope, Formula ID or Pay Item. Review its posting rule or deactivate it first.' USING ERRCODE='AF001';
   END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
-- Operations can load one scoped subject's active formula or their own retained result's version.
-- The shared definition projection strips other companies and employee IDs and preserves its content hash.
CREATE FUNCTION app.attendance_formula_subject_versions(
 p_company uuid,p_employment uuid,p_date date,p_formula uuid DEFAULT NULL,p_result uuid DEFAULT NULL,
 p_item uuid DEFAULT NULL,p_include_overtime boolean DEFAULT false
) RETURNS SETOF public.attendance_formula_revision
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp SET row_security=on AS $$
 SELECT (jsonb_populate_record(v,jsonb_build_object('company_id',p_company,'created_by',NULL,'definition',
  (v.definition-'companyScope')||jsonb_build_object('companyId',p_company::text,'eligibility',
    CASE WHEN v.definition->'eligibility'->>'mode'='selected'
     THEN jsonb_build_object('mode','selected','employmentIds',jsonb_build_array(p_employment::text))
     ELSE v.definition->'eligibility' END)))).*
 FROM public.attendance_formula f
 LEFT JOIN LATERAL(SELECT kind,revision_id FROM public.attendance_formula_event e WHERE e.formula_id=f.id
  AND e.kind IN('activated','deactivated','archived') ORDER BY sequence DESC LIMIT 1) current_state ON p_result IS NULL
 LEFT JOIN public.attendance_formula_result result ON result.id=p_result AND result.formula_id=f.id AND result.tenant_id=f.tenant_id
  AND result.company_id=p_company AND result.employment_id=p_employment AND result.period_to=p_date
 JOIN public.attendance_formula_revision v ON v.id=coalesce(result.revision_id,current_state.revision_id) AND v.tenant_id=f.tenant_id
 WHERE f.tenant_id=app.current_tenant_id() AND (p_formula IS NULL OR f.id=p_formula)
 AND p_company=ANY(app.attendance_formula_companies(f.company_id,v.definition))
 AND (p_item IS NULL OR v.pay_component_id=p_item OR (p_include_overtime AND v.definition->>'purpose'='overtime'))
 AND app.attendance_formula_trace_access(p_company,p_employment,coalesce(result.read_requirements,v.read_requirements))
 AND ((p_result IS NOT NULL AND result.id IS NOT NULL) OR (p_result IS NULL AND current_state.kind='activated'
   AND EXISTS(SELECT 1 FROM public.company c WHERE c.id=p_company AND c.tenant_id=f.tenant_id AND c.archived_at IS NULL)
   AND v.definition->>'effectiveFrom'<=p_date::text
   AND (v.definition->'eligibility'->>'mode'<>'selected' OR v.definition->'eligibility'->'employmentIds' ? p_employment::text)
   AND EXISTS(SELECT 1 FROM app.proven_company_date_points(jsonb_build_array(jsonb_build_object('employmentId',p_employment,'date',p_date))) p
      WHERE p.company_id=p_company AND p.reason IS NULL)))
 ORDER BY f.code,f.id LIMIT 501
$$;
REVOKE ALL ON FUNCTION app.attendance_formula_subject_versions(uuid,uuid,date,uuid,uuid,uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.attendance_formula_subject_versions(uuid,uuid,date,uuid,uuid,uuid,boolean) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.attendance_formula_test_company_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
BEGIN
 IF NEW.period_to<NEW.period_from OR NEW.period_to-NEW.period_from>61 THEN
  RAISE EXCEPTION 'Use a bounded Attendance test period';
 END IF;
 IF EXISTS(SELECT 1 FROM app.proven_company_date_points((SELECT jsonb_agg(jsonb_build_object('employmentId',NEW.employment_id,'date',d::date))
    FROM generate_series(NEW.period_from,NEW.period_to,interval '1 day') d)) p
   WHERE p.company_id IS DISTINCT FROM NEW.company_id OR p.reason IS NOT NULL)
 OR NOT EXISTS(SELECT 1 FROM public.attendance_formula_revision r
   WHERE r.id=NEW.revision_id AND r.tenant_id=NEW.tenant_id AND r.formula_id=NEW.formula_id
    AND (r.definition->'eligibility'->>'mode'<>'selected' OR r.definition->'eligibility'->'employmentIds' ? NEW.employment_id::text))
 THEN RAISE EXCEPTION 'Only an eligible employee in the dated formula company may be tested'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.attendance_formula_test_company_guard() FROM PUBLIC;
CREATE TRIGGER attendance_formula_test_company_guard BEFORE INSERT ON public.attendance_formula_test
 FOR EACH ROW EXECUTE FUNCTION app.attendance_formula_test_company_guard();

CREATE OR REPLACE FUNCTION app.attendance_formula_result_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE r public.attendance_formula_result;previous text;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text||':'||NEW.employment_id::text,0));
 IF TG_TABLE_NAME='attendance_formula_result' THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text||':attendance-formula:'||NEW.formula_id::text,0));
  IF NEW.period_to<NEW.period_from OR NEW.period_to-NEW.period_from>61 THEN
   RAISE EXCEPTION 'Use a bounded Attendance result period';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM app.attendance_formula_subject_versions(NEW.company_id,NEW.employment_id,NEW.period_to,NEW.formula_id) v
    WHERE v.id=NEW.revision_id AND v.tenant_id=NEW.tenant_id AND v.pay_component_id=NEW.pay_component_id
     AND v.definition->>'outputUnit'=NEW.unit AND v.definition->>'effectiveFrom'<=NEW.period_from::text)
   OR EXISTS(SELECT 1 FROM app.proven_company_date_points((SELECT jsonb_agg(jsonb_build_object('employmentId',NEW.employment_id,'date',d::date))
      FROM generate_series(NEW.period_from,NEW.period_to,interval '1 day') d)) p
      WHERE p.company_id IS DISTINCT FROM NEW.company_id OR p.reason IS NOT NULL) THEN
   RAISE EXCEPTION 'Only an effective active formula for the employee company may calculate results';
  END IF;
 ELSE
  SELECT * INTO r FROM public.attendance_formula_result WHERE id=NEW.result_id AND tenant_id=NEW.tenant_id AND company_id=NEW.company_id AND employment_id=NEW.employment_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Result is unavailable'; END IF;
  SELECT kind INTO previous FROM public.attendance_formula_result_event WHERE result_id=r.id AND tenant_id=r.tenant_id ORDER BY sequence DESC LIMIT 1;
  IF NOT ((NEW.kind='calculated' AND previous IS NULL) OR(NEW.kind='reviewed' AND previous='calculated') OR(NEW.kind='approved' AND previous='reviewed') OR(NEW.kind='superseded' AND previous IN('calculated','reviewed','approved')) OR(NEW.kind='posted' AND previous='approved') OR(NEW.kind='reversed' AND previous='posted')) THEN RAISE EXCEPTION 'Invalid Attendance result transition'; END IF;
  IF NEW.kind IN('posted','reversed') AND NOT EXISTS(SELECT 1 FROM public.payroll_batch b WHERE b.id=NEW.batch_id AND b.tenant_id=NEW.tenant_id AND b.company_id=NEW.company_id AND b.status='draft' AND app.can_admin_payroll_for(b.company_id)) THEN RAISE EXCEPTION 'Use an authorized draft Payroll run'; END IF;
 END IF;
 RETURN NEW;
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.attendance_formula_ot_settlement_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
DECLARE b public.attendance_formula_ot_binding;d public.attendance_formula_ot_binding_day;source public.attendance_overtime_source;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.formula_binding_id IS DISTINCT FROM OLD.formula_binding_id THEN RAISE EXCEPTION 'An overtime formula binding is immutable'; END IF;RETURN NEW;
 END IF;
 IF NEW.formula_binding_id IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO b FROM public.attendance_formula_ot_binding WHERE id=NEW.formula_binding_id AND tenant_id=NEW.tenant_id AND company_id=NEW.company_id;
 SELECT * INTO d FROM public.attendance_formula_ot_binding_day WHERE binding_id=b.id AND source_id=NEW.source_id AND tenant_id=NEW.tenant_id;
 SELECT * INTO source FROM public.attendance_overtime_source WHERE id=NEW.source_id AND tenant_id=NEW.tenant_id;
 IF b.id IS NULL OR d.source_id IS NULL OR source.id IS NULL OR source.employment_id<>b.employment_id OR NEW.mode<>'cash' OR b.batch_id IS DISTINCT FROM NEW.payroll_batch_id
  OR NOT app.can_admin_payroll_for(b.company_id) OR NOT EXISTS(SELECT 1 FROM public.payroll_batch run WHERE run.id=b.batch_id AND run.tenant_id=b.tenant_id AND run.company_id=b.company_id AND run.status='draft' AND run.run_type='regular')
  OR NOT EXISTS(SELECT 1 FROM public.attendance_formula_ot_binding_result x WHERE x.binding_id=b.id AND x.tenant_id=b.tenant_id)
  OR EXISTS(SELECT 1 FROM public.attendance_formula_ot_binding_result x JOIN public.attendance_formula_result r ON r.id=x.result_id LEFT JOIN LATERAL app.attendance_formula_subject_versions(r.company_id,r.employment_id,r.period_to,r.formula_id,r.id) v ON v.id=r.revision_id WHERE x.binding_id=b.id AND (v.id IS NULL OR v.definition->>'purpose'<>'overtime' OR r.period_from<>b.period_from OR r.period_to<>b.period_to OR (SELECT kind FROM public.attendance_formula_result_event e WHERE e.result_id=r.id ORDER BY sequence DESC LIMIT 1) IS DISTINCT FROM 'approved'))
  THEN RAISE EXCEPTION 'Only a complete approved native overtime result set may reserve the parent'; END IF;
 IF NOT(d.coverage <@ int8multirange(int8range((extract(epoch FROM(source.attendance_date::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur'))*1000)::bigint,(extract(epoch FROM(source.attendance_date::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur'))*1000)::bigint+259200000,'[)'))) THEN RAISE EXCEPTION 'Overtime coverage exceeds the parent source envelope'; END IF;
 NEW.coverage_employment_id:=source.employment_id;NEW.coverage_kind:='formulaPhysical';NEW.coverage_calculation_id:=NEW.calculation_id;NEW.reservation_coverage:=d.coverage;
 RETURN NEW;
END $$;
