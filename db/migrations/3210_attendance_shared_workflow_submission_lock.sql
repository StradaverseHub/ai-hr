-- Staging-baseline successor to the UNAPPLIED 2301 reservation, not a replay of it.
-- Preserve immutable 3101 shared-company semantics and 3110 RLS-on helpers.
-- Root allocation: idx2528, when1793330002828; journal integration is separately owned.
DO $shared_submission_union$
DECLARE
 previous pg_catalog.pg_proc%ROWTYPE;
 dependency pg_catalog.pg_proc%ROWTYPE;
 expected record;
 source_body constant text := $expected_body$
BEGIN
 IF TG_TABLE_NAME IN ('attendance_workflow_template','attendance_workflow_setting','attendance_workflow_request') THEN
  IF NOT EXISTS(SELECT 1 FROM public.company c WHERE c.id=NEW.company_id AND c.tenant_id=NEW.tenant_id)
   THEN RAISE EXCEPTION 'Invalid workflow company'; END IF;
 END IF;
 IF TG_TABLE_NAME='attendance_workflow_request' THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text||':attendance-workflow:'||NEW.company_id::text||':'||NEW.application_type,0));
  IF NOT EXISTS(SELECT 1 FROM public.employment e JOIN public.attendance_correction c ON c.employment_id=e.id AND c.tenant_id=e.tenant_id
   JOIN public.attendance_workflow_template t ON t.id=NEW.template_id AND t.tenant_id=e.tenant_id
   WHERE e.id=NEW.employment_id AND e.tenant_id=NEW.tenant_id AND e.company_id=NEW.company_id AND c.id=NEW.correction_id
    AND app.attendance_workflow_applies(t.id,NEW.company_id) AND t.application_type=NEW.application_type AND t.version=NEW.template_version AND t.routing_version=NEW.routing_version)
   THEN RAISE EXCEPTION 'Invalid workflow application links'; END IF;
  IF NEW.routing_version=2 AND NEW.stages IS DISTINCT FROM app.attendance_workflow_resolve_v2(NEW.employment_id,(SELECT t.stages FROM public.attendance_workflow_template t WHERE t.id=NEW.template_id AND t.tenant_id=NEW.tenant_id))
   THEN RAISE EXCEPTION 'The submitted hierarchy must match the configured version and live root-authorized resolution'; END IF;
  IF NEW.routing_version=3 AND NEW.stages IS DISTINCT FROM (app.attendance_workflow_resolve_v3(NEW.employment_id,(SELECT t.stages FROM public.attendance_workflow_template t WHERE t.id=NEW.template_id AND t.tenant_id=NEW.tenant_id))->'stages')
   THEN RAISE EXCEPTION 'The v3 route must match the canonical root-authorized resolution'; END IF;
  IF NEW.routing_version=4 AND (NEW.stages,NEW.cc) IS DISTINCT FROM ((app.attendance_workflow_resolve_v4(NEW.employment_id,(SELECT t.stages FROM public.attendance_workflow_template t WHERE t.id=NEW.template_id AND t.tenant_id=NEW.tenant_id),(SELECT t.cc FROM public.attendance_workflow_template t WHERE t.id=NEW.template_id AND t.tenant_id=NEW.tenant_id))->'stages'),(app.attendance_workflow_resolve_v4(NEW.employment_id,(SELECT t.stages FROM public.attendance_workflow_template t WHERE t.id=NEW.template_id AND t.tenant_id=NEW.tenant_id),(SELECT t.cc FROM public.attendance_workflow_template t WHERE t.id=NEW.template_id AND t.tenant_id=NEW.tenant_id))->'cc')) THEN RAISE EXCEPTION 'The v4 route and CC must match canonical resolution'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.attendance_workflow_template t WHERE t.id=NEW.template_id AND t.tenant_id=NEW.tenant_id AND t.superseded_at IS NULL AND t.retired_at IS NULL AND t.active) THEN RAISE EXCEPTION 'The workflow is no longer available for a new application'; END IF;
 ELSIF TG_TABLE_NAME='attendance_workflow_decision' THEN
  IF NOT EXISTS(SELECT 1 FROM public.attendance_workflow_request w WHERE w.id=NEW.request_id AND w.tenant_id=NEW.tenant_id AND w.employment_id=NEW.employment_id)
   OR (NEW.assigned_employment_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.id=NEW.assigned_employment_id AND e.tenant_id=NEW.tenant_id))
   OR (NEW.actual_employment_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.id=NEW.actual_employment_id AND e.tenant_id=NEW.tenant_id AND e.person_id=NEW.actual_person_id))
   OR (NEW.actual_person_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.person p WHERE p.id=NEW.actual_person_id AND p.tenant_id=NEW.tenant_id))
   THEN RAISE EXCEPTION 'Invalid workflow decision links'; END IF;
 END IF;
 RETURN NEW;
END $expected_body$;
 expected_body text;
 metadata jsonb;
 definition text;
 app_role oid;
BEGIN
 SELECT oid INTO app_role FROM pg_catalog.pg_roles WHERE rolname='ai_hr_app';
 SELECT * INTO previous FROM pg_catalog.pg_proc
 WHERE oid=pg_catalog.to_regprocedure('app.attendance_workflow_links()');
 IF NOT FOUND OR app_role IS NULL OR previous.proowner IS DISTINCT FROM current_user::regrole::oid
  OR previous.proowner IS DISTINCT FROM (SELECT relowner FROM pg_catalog.pg_class WHERE oid='public.attendance_workflow_request'::regclass)
  OR previous.pronamespace IS DISTINCT FROM 'app'::regnamespace::oid
  OR previous.proname<>'attendance_workflow_links' OR previous.prosrc IS DISTINCT FROM source_body
  OR previous.prolang IS DISTINCT FROM (SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
  OR previous.proargtypes<>''::oidvector OR previous.pronargs<>0 OR previous.proargnames IS NOT NULL
  OR previous.proallargtypes IS NOT NULL OR previous.proargmodes IS NOT NULL
  OR previous.pronargdefaults<>0 OR previous.proargdefaults IS NOT NULL
  OR previous.prorettype IS DISTINCT FROM 'trigger'::regtype::oid OR previous.proretset
  OR previous.prokind<>'f' OR previous.provariadic<>0 OR previous.prosqlbody IS NOT NULL
  OR previous.probin IS NOT NULL OR previous.protrftypes IS NOT NULL
  OR NOT previous.prosecdef OR previous.proisstrict OR previous.proleakproof
  OR previous.provolatile<>'v' OR previous.proparallel<>'u'
  OR previous.procost<>100 OR previous.prorows<>0 OR previous.prosupport<>0::oid
  OR previous.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']::text[]
 THEN RAISE EXCEPTION 'Exact shared-company Attendance trigger predecessor required' USING ERRCODE='55000'; END IF;
 -- Trigger functions retain their original default owner/PUBLIC execute ACL.
 -- No caller authority is added here; PostgreSQL still permits only trigger invocation.
 IF (SELECT count(*) FROM pg_catalog.aclexplode(coalesce(previous.proacl,pg_catalog.acldefault('f',previous.proowner))))<>2
  OR EXISTS(SELECT 1 FROM pg_catalog.aclexplode(coalesce(previous.proacl,pg_catalog.acldefault('f',previous.proowner))) a
   WHERE a.grantor<>previous.proowner OR a.grantee NOT IN(0,previous.proowner) OR a.privilege_type<>'EXECUTE' OR a.is_grantable)
  OR NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(coalesce(previous.proacl,pg_catalog.acldefault('f',previous.proowner))) a WHERE a.grantee=0)
  OR NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(coalesce(previous.proacl,pg_catalog.acldefault('f',previous.proowner))) a WHERE a.grantee=previous.proowner)
 THEN RAISE EXCEPTION 'Exact shared-company Attendance trigger ACL required' USING ERRCODE='55000'; END IF;
 IF (SELECT count(*) FROM pg_catalog.pg_trigger WHERE tgfoid=previous.oid)<>4
  OR EXISTS(SELECT 1 FROM (VALUES
    ('attendance_workflow_template_links','public.attendance_workflow_template'::regclass,7),
    ('attendance_workflow_setting_links','public.attendance_workflow_setting'::regclass,23),
    ('attendance_workflow_request_links','public.attendance_workflow_request'::regclass,7),
    ('attendance_workflow_decision_links','public.attendance_workflow_decision'::regclass,7)
   ) binding(name,relation,kind) WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t
    WHERE t.tgfoid=previous.oid AND t.tgname=binding.name AND t.tgrelid=binding.relation AND t.tgtype=binding.kind
     AND t.tgenabled='O' AND NOT t.tgisinternal AND NOT t.tgdeferrable AND NOT t.tginitdeferred
     AND t.tgconstraint=0 AND t.tgnargs=0 AND octet_length(t.tgargs)=0 AND t.tgqual IS NULL))
 THEN RAISE EXCEPTION 'Exact shared-company Attendance trigger bindings required' USING ERRCODE='55000'; END IF;
 -- Five actual 3101 APIs must retain the 3110 RLS-on configuration and exact
 -- native source/ABI/owner/ACL. Never accept the pre-3110 row_security=off form.
 FOR expected IN SELECT * FROM (VALUES
  ('app.attendance_workflow_companies(uuid)','385f72e4516a50f22cc6f77787a38ac3','uuid[]',false,1,ARRAY['wanted']::text[]),
  ('app.attendance_workflow_applies(uuid,uuid)','4277d83b20c7eb1a1f4930c920413d34','boolean',false,2,ARRAY['wanted','wanted_company']::text[]),
  ('app.attendance_workflow_all_companies_admin(uuid)','a4d3dc025f46e179f26f3f7d5951c43a','boolean',false,1,ARRAY['wanted']::text[]),
  ('app.attendance_selected_approver_eligible(uuid,uuid)','4e969ffff2285458476b1e46237942fb','boolean',false,2,ARRAY['wanted_company','wanted_employment']::text[]),
  ('app.attendance_workflow_v3_approver_options(uuid[])','db08941be2cb88ad411f77e2e89b0cd6','TABLE(id uuid, name text, employee_code text)',true,1,ARRAY['wanted_companies','id','name','employee_code']::text[])
 ) source(signature,body_md5,result,returns_set,inputs,names) LOOP
  SELECT * INTO dependency FROM pg_catalog.pg_proc WHERE oid=pg_catalog.to_regprocedure(expected.signature);
  IF NOT FOUND OR dependency.proowner IS DISTINCT FROM previous.proowner
   OR dependency.prolang IS DISTINCT FROM (SELECT oid FROM pg_catalog.pg_language WHERE lanname='sql')
   OR pg_catalog.md5(dependency.prosrc) IS DISTINCT FROM expected.body_md5
   OR pg_catalog.pg_get_function_result(dependency.oid) IS DISTINCT FROM expected.result
   OR dependency.proretset IS DISTINCT FROM expected.returns_set
   OR dependency.pronargs<>expected.inputs OR dependency.proargnames IS DISTINCT FROM expected.names
   OR (expected.returns_set AND (dependency.proallargtypes IS DISTINCT FROM ARRAY[2951,2950,25,25]::oid[]
     OR dependency.proargmodes IS DISTINCT FROM ARRAY['i','t','t','t']::"char"[]))
   OR (NOT expected.returns_set AND (dependency.proallargtypes IS NOT NULL OR dependency.proargmodes IS NOT NULL))
   OR dependency.pronargdefaults<>0 OR dependency.proargdefaults IS NOT NULL
   OR dependency.prokind<>'f' OR dependency.provariadic<>0 OR dependency.prosqlbody IS NOT NULL
   OR dependency.probin IS NOT NULL OR dependency.protrftypes IS NOT NULL
   OR NOT dependency.prosecdef OR dependency.proisstrict OR dependency.proleakproof
   OR dependency.provolatile<>'s' OR dependency.proparallel<>'u'
   OR dependency.procost<>100 OR dependency.prorows<>(CASE WHEN expected.returns_set THEN 1000 ELSE 0 END)
   OR dependency.prosupport<>0::oid
   OR dependency.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, app','row_security=on']::text[]
   OR (SELECT count(*) FROM pg_catalog.aclexplode(coalesce(dependency.proacl,pg_catalog.acldefault('f',dependency.proowner))))<>2
   OR EXISTS(SELECT 1 FROM pg_catalog.aclexplode(coalesce(dependency.proacl,pg_catalog.acldefault('f',dependency.proowner))) a
    WHERE a.grantor<>dependency.proowner OR a.grantee NOT IN(dependency.proowner,app_role) OR a.privilege_type<>'EXECUTE' OR a.is_grantable)
   OR NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(coalesce(dependency.proacl,pg_catalog.acldefault('f',dependency.proowner))) a WHERE a.grantee=dependency.proowner)
   OR NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(coalesce(dependency.proacl,pg_catalog.acldefault('f',dependency.proowner))) a WHERE a.grantee=app_role)
  THEN RAISE EXCEPTION 'Exact RLS-on shared-company Attendance helper required: %',expected.signature USING ERRCODE='55000'; END IF;
 END LOOP;
 metadata:=to_jsonb(previous)-'prosrc';
 expected_body:=pg_catalog.replace(source_body,'PERFORM pg_advisory_xact_lock(','PERFORM pg_advisory_xact_lock_shared(');
 IF (length(source_body)-length(pg_catalog.replace(source_body,'PERFORM pg_advisory_xact_lock(','')))/length('PERFORM pg_advisory_xact_lock(')<>1
  OR pg_catalog.md5(expected_body)<>'46e046f4a175a420c44748f3419094a3'
 THEN RAISE EXCEPTION 'Exact one-call shared submission union required' USING ERRCODE='55000'; END IF;
 definition:=pg_catalog.pg_get_functiondef(previous.oid);
 EXECUTE pg_catalog.replace(definition,'PERFORM pg_advisory_xact_lock(','PERFORM pg_advisory_xact_lock_shared(');
 SELECT * INTO dependency FROM pg_catalog.pg_proc WHERE oid=previous.oid;
 IF dependency.prosrc IS DISTINCT FROM expected_body OR to_jsonb(dependency)-'prosrc' IS DISTINCT FROM metadata
 THEN RAISE EXCEPTION 'Attendance shared submission union changed native identity' USING ERRCODE='55000'; END IF;
END;
$shared_submission_union$;
