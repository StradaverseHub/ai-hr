-- Board daa76ed4 (item A of 2). Draft reservation 5140 @ idx 4540 / when 1793330004840 (unapplied).
-- Approvers for routing versions 3 and 4 may come from any company of the tenant (the Organization Code), and an
-- approver whose person has no account yet (pending activation) is frozen with a null login. Version 1/2 routes,
-- request visibility (attendance_workflow_v3_read stays request-bound) and app.can_see_employment are unchanged.
-- No table changes; requests already submitted keep their frozen identities.

-- The one usable-login rule for an approver: an app_user of the person in the current tenant that is not archived,
-- not blocked and holds any tenant role. accounts=0 is "pending activation" (an invitation or manual enrollment
-- creates no app_user); an archived, blocked or role-less account is a real login problem.
CREATE FUNCTION app.attendance_workflow_approver_login(wanted_person uuid) RETURNS TABLE(usable integer,user_id uuid,accounts integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT count(*) FILTER (WHERE x.ok)::integer,min(x.id::text) FILTER (WHERE x.ok)::uuid,count(*)::integer
 FROM (SELECT u.id,(u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND EXISTS(SELECT 1 FROM public.role_assignment r
   WHERE r.app_user_id=u.id AND r.tenant_id=u.tenant_id AND r.role::text IN ('employee','manager','hr_admin','super_admin'))) AS ok
  FROM public.app_user u WHERE u.person_id=wanted_person AND u.tenant_id=app.current_tenant_id()) x
$$;
REVOKE ALL ON FUNCTION app.attendance_workflow_approver_login(uuid) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
-- Tenant-wide Direct Superior traversal for v3/v4 resolution. Same walk as 0548 attendance_workflow_hierarchy
-- (which v2 keeps) without the subject-company fence; a pending-activation superior resolves with a null login.
CREATE FUNCTION app.attendance_workflow_hierarchy_v5(subject_id uuid, wanted_depth integer)
RETURNS TABLE(level_number integer, employment_id uuid, person_id uuid, user_id uuid, full_name text, problem text, pending_activation boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE subject public.employment; manager public.employment; cursor_id uuid; next_id uuid; manager_name text; login_id uuid; pending boolean;
        seen_employments uuid[]; seen_people uuid[]; seen_users uuid[] := '{}'; edge_count integer; failure text; n integer; lg record;
        today date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
BEGIN
 IF wanted_depth NOT BETWEEN 1 AND 10 THEN RAISE EXCEPTION 'Configure one to ten hierarchy levels'; END IF;
 SELECT e.* INTO subject FROM public.employment e WHERE e.id=subject_id AND e.tenant_id=app.current_tenant_id();
 IF NOT FOUND OR NOT app.can_see_employment(subject_id)
  OR NOT EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=subject.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))
  THEN RAISE EXCEPTION 'Authorized attendance subject required'; END IF;
 cursor_id:=subject.id; seen_employments:=ARRAY[subject.id]; seen_people:=ARRAY[subject.person_id];
 IF EXISTS(WITH RECURSIVE chain(id,path,cycle) AS (
  SELECT subject.id,ARRAY[subject.id],false UNION ALL
  SELECT l.manager_employment_id,c.path||l.manager_employment_id,l.manager_employment_id=ANY(c.path)
   FROM chain c JOIN public.reporting_line l ON l.subordinate_employment_id=c.id AND l.tenant_id=subject.tenant_id
   WHERE NOT c.cycle AND l.line_type='administrative' AND l.superseded_at IS NULL
    AND l.valid_from<=today AND (l.valid_to IS NULL OR l.valid_to>today)
 ) SELECT 1 FROM chain WHERE cycle) THEN failure:='cycle'; END IF;
 FOR n IN 1..wanted_depth LOOP
  pending:=false; login_id:=NULL;
  IF failure IS NULL THEN
   SELECT count(*)::integer,min(l.manager_employment_id::text)::uuid INTO edge_count,next_id FROM public.reporting_line l
    WHERE l.subordinate_employment_id=cursor_id AND l.tenant_id=subject.tenant_id AND l.line_type='administrative'
     AND l.superseded_at IS NULL AND l.valid_from<=today AND (l.valid_to IS NULL OR l.valid_to>today);
   IF edge_count=0 THEN failure:='missing_superior'; ELSIF edge_count<>1 THEN failure:='ambiguous_superior';
   ELSIF next_id=ANY(seen_employments) THEN failure:='cycle'; END IF;
  END IF;
  IF failure IS NULL THEN
   SELECT e.* INTO manager FROM public.employment e WHERE e.id=next_id AND e.tenant_id=subject.tenant_id;
   IF NOT FOUND THEN failure:='missing_superior';
   ELSIF manager.person_id=ANY(seen_people) THEN failure:='duplicate_person';
   ELSIF manager.hired_on>today OR manager.blacklisted_at IS NOT NULL OR (manager.terminated_on IS NOT NULL AND manager.terminated_on<=today) THEN failure:='inactive_superior'; END IF;
  END IF;
  IF failure IS NULL THEN
   SELECT * INTO lg FROM app.attendance_workflow_approver_login(manager.person_id);
   IF lg.usable=1 THEN login_id:=lg.user_id;
   ELSIF lg.usable=0 AND lg.accounts=0 THEN pending:=true;
   ELSE failure:='missing_or_ambiguous_login'; END IF;
   IF failure IS NULL AND login_id IS NOT NULL AND login_id=ANY(seen_users) THEN failure:='duplicate_login'; END IF;
  END IF;
  IF failure IS NULL THEN
   SELECT p.full_name INTO manager_name FROM public.person p WHERE p.id=manager.person_id AND p.tenant_id=subject.tenant_id;
   IF NOT FOUND THEN failure:='missing_person'; END IF;
  END IF;
  IF failure IS NOT NULL THEN RETURN QUERY SELECT n,NULL::uuid,NULL::uuid,NULL::uuid,NULL::text,failure,false;
  ELSE
   RETURN QUERY SELECT n,manager.id,manager.person_id,login_id,manager_name,NULL::text,pending;
   seen_employments:=seen_employments||manager.id; seen_people:=seen_people||manager.person_id;
   IF login_id IS NOT NULL THEN seen_users:=seen_users||login_id; END IF; cursor_id:=manager.id;
  END IF;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION app.attendance_workflow_hierarchy_v5(uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.attendance_workflow_hierarchy_v5(uuid,integer) TO ai_hr_app;

--> statement-breakpoint
-- Replaces 3101: a named approver is eligible in any company of the tenant, with one usable login or none yet.
CREATE OR REPLACE FUNCTION app.attendance_selected_approver_eligible(wanted_company uuid,wanted_employment uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app SET row_security=off AS $$
 SELECT EXISTS(SELECT 1 FROM public.employment e JOIN public.company c ON c.id=wanted_company AND c.tenant_id=e.tenant_id
 CROSS JOIN LATERAL app.attendance_workflow_approver_login(e.person_id) l
 WHERE e.id=wanted_employment AND e.tenant_id=app.current_tenant_id() AND e.blacklisted_at IS NULL
  AND e.hired_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
  AND (LEAST(e.terminated_on,e.resignation_date,e.last_working_date) IS NULL OR LEAST(e.terminated_on,e.resignation_date,e.last_working_date)>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
  AND (l.usable=1 OR (l.usable=0 AND l.accounts=0)))
$$;

--> statement-breakpoint
-- Replaces 3101. Direct Superiors and named approvers come from any company of the tenant; a pending-activation
-- approver is frozen with "userId": null and "pendingActivation": true. Unchanged otherwise.
CREATE OR REPLACE FUNCTION app.attendance_workflow_resolve_v3(subject_id uuid,configured jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE subject public.employment; employee public.employment; caller public.app_user; actor jsonb; stage jsonb; source jsonb;
 resolved jsonb:='[]'; actors jsonb; selected jsonb; h record; l record; i integer; j integer; depth integer; total integer:=0;
 login_id uuid; actor_name text; employee_id uuid; hr_ok boolean; alternative boolean;
 seen_employments uuid[]; seen_people uuid[]; seen_users uuid[];
BEGIN
 SELECT e.* INTO subject FROM public.employment e WHERE e.id=subject_id AND e.tenant_id=app.current_tenant_id();
 SELECT u.* INTO caller FROM public.app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id);
 IF subject.id IS NULL OR caller.id IS NULL OR NOT app.can_see_employment(subject_id) THEN RETURN app.attendance_workflow_v3_problem('employee_unavailable',NULL); END IF;
 IF jsonb_typeof(configured) IS DISTINCT FROM 'array' THEN RETURN app.attendance_workflow_v3_problem('invalid_route',NULL); END IF;
 IF jsonb_array_length(configured) NOT BETWEEN 1 AND 10 THEN RETURN app.attendance_workflow_v3_problem('level_count',NULL); END IF;
 seen_employments:=ARRAY[subject.id]; seen_people:=ARRAY[subject.person_id];
 SELECT coalesce(array_agg(u.id),'{}') INTO seen_users FROM public.app_user u WHERE u.tenant_id=subject.tenant_id AND u.person_id=subject.person_id;
 hr_ok:=app.attendance_workflow_has_hr(subject_id);
 FOR i IN 0..jsonb_array_length(configured)-1 LOOP
  stage:=configured->i; source:=stage->'source'; actors:='[]'; alternative:=false;
  IF jsonb_typeof(stage) IS DISTINCT FROM 'object' THEN RETURN app.attendance_workflow_v3_problem('invalid_level',i); END IF;
  IF NOT stage ?& ARRAY['name','mode','source','hrAlternative']
   OR EXISTS(SELECT 1 FROM jsonb_object_keys(stage) k WHERE k NOT IN ('name','mode','source','hrAlternative'))
   OR jsonb_typeof(stage->'name') IS DISTINCT FROM 'string' OR length(stage->>'name')>100 OR jsonb_typeof(stage->'hrAlternative') IS DISTINCT FROM 'boolean'
   THEN RETURN app.attendance_workflow_v3_problem('invalid_level',i); END IF;
  IF coalesce(stage->>'mode','') NOT IN ('sequential','any_one') THEN RETURN app.attendance_workflow_v3_problem('invalid_mode',i); END IF;
  IF jsonb_typeof(source) IS DISTINCT FROM 'object' THEN RETURN app.attendance_workflow_v3_problem('invalid_source',i); END IF;
  IF source->>'kind'='direct_manager' THEN
   IF NOT source ?& ARRAY['kind','depth'] OR EXISTS(SELECT 1 FROM jsonb_object_keys(source) k WHERE k NOT IN ('kind','depth')) THEN RETURN app.attendance_workflow_v3_problem('invalid_source',i); END IF;
   IF jsonb_typeof(source->'depth') IS DISTINCT FROM 'number' OR coalesce(source->>'depth','') !~ '^[1-5]$' THEN RETURN app.attendance_workflow_v3_problem('invalid_depth',i); END IF;
   depth:=(source->>'depth')::integer; total:=total+1;
   SELECT * INTO h FROM app.attendance_workflow_hierarchy_v5(subject_id,depth) x WHERE x.level_number=depth;
   IF NOT FOUND OR h.problem IS NOT NULL OR h.employment_id IS NULL THEN
    IF stage->>'hrAlternative'='true' AND hr_ok THEN alternative:=true;
    ELSE RETURN app.attendance_workflow_v3_problem(coalesce(h.problem,'missing_superior'),i,0); END IF;
   ELSE
    actors:=jsonb_build_array(jsonb_build_object('kind','direct_manager','slot',i::text||':0','employmentId',h.employment_id,'personId',h.person_id,'userId',h.user_id,'hierarchyDepth',depth,'name',h.full_name)
     ||CASE WHEN h.pending_activation THEN jsonb_build_object('pendingActivation',true) ELSE '{}'::jsonb END);
   END IF;
   alternative:=(stage->>'hrAlternative'='true' AND hr_ok);
  ELSIF source->>'kind'='specific_employee' THEN
   IF NOT source ?& ARRAY['kind','employmentIds'] OR EXISTS(SELECT 1 FROM jsonb_object_keys(source) k WHERE k NOT IN ('kind','employmentIds')) OR stage->>'hrAlternative'<>'false'
    THEN RETURN app.attendance_workflow_v3_problem('invalid_source',i); END IF;
   selected:=source->'employmentIds';
   IF jsonb_typeof(selected) IS DISTINCT FROM 'array' THEN RETURN app.attendance_workflow_v3_problem('selection_required',i); END IF;
   IF jsonb_array_length(selected)=0 THEN RETURN app.attendance_workflow_v3_problem('selection_required',i); END IF;
   IF jsonb_array_length(selected)>20 THEN RETURN app.attendance_workflow_v3_problem('too_many_participants',i); END IF;
   total:=total+jsonb_array_length(selected);
   FOR j IN 0..jsonb_array_length(selected)-1 LOOP
    IF jsonb_typeof(selected->j) IS DISTINCT FROM 'string' OR coalesce(selected->>j,'') !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' THEN RETURN app.attendance_workflow_v3_problem('invalid_employee',i,j); END IF;
    employee_id:=(selected->>j)::uuid;
    SELECT e.* INTO employee FROM public.employment e WHERE e.id=employee_id AND e.tenant_id=subject.tenant_id;
    IF NOT FOUND OR employee.blacklisted_at IS NOT NULL OR employee.hired_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
     OR (employee.terminated_on IS NOT NULL AND employee.terminated_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) THEN RETURN app.attendance_workflow_v3_problem('employee_unavailable',i,j); END IF;
    SELECT * INTO l FROM app.attendance_workflow_approver_login(employee.person_id);
    IF NOT (l.usable=1 OR (l.usable=0 AND l.accounts=0)) THEN RETURN app.attendance_workflow_v3_problem('missing_or_ambiguous_login',i,j); END IF;
    login_id:=CASE WHEN l.usable=1 THEN l.user_id END;
    IF NOT app.attendance_selected_approver_eligible(subject.company_id,employee.id) THEN RETURN app.attendance_workflow_v3_problem('employee_unavailable',i,j); END IF;
    SELECT p.full_name INTO actor_name FROM public.person p WHERE p.id=employee.person_id AND p.tenant_id=subject.tenant_id;
    IF NOT FOUND THEN RETURN app.attendance_workflow_v3_problem('missing_person',i,j); END IF;
    actors:=actors||jsonb_build_array(jsonb_build_object('kind','specific_employee','slot',i::text||':'||j::text,'employmentId',employee.id,'personId',employee.person_id,'userId',login_id,'name',actor_name)
     ||CASE WHEN login_id IS NULL THEN jsonb_build_object('pendingActivation',true) ELSE '{}'::jsonb END);
   END LOOP;
  ELSE RETURN app.attendance_workflow_v3_problem('invalid_source',i); END IF;
  IF total>100 THEN RETURN app.attendance_workflow_v3_problem('too_many_participants',i); END IF;
  FOR actor IN SELECT value FROM jsonb_array_elements(actors) LOOP
   IF (actor->>'employmentId')::uuid=subject.id OR (actor->>'personId')::uuid=subject.person_id THEN RETURN app.attendance_workflow_v3_problem('self_approval',i,(split_part(actor->>'slot',':',2))::integer); END IF;
   IF (actor->>'employmentId')::uuid=ANY(seen_employments) THEN RETURN app.attendance_workflow_v3_problem('duplicate_employment',i,(split_part(actor->>'slot',':',2))::integer); END IF;
   IF (actor->>'personId')::uuid=ANY(seen_people) THEN RETURN app.attendance_workflow_v3_problem('duplicate_person',i,(split_part(actor->>'slot',':',2))::integer); END IF;
   IF actor->>'userId' IS NOT NULL AND (actor->>'userId')::uuid=ANY(seen_users) THEN RETURN app.attendance_workflow_v3_problem('duplicate_login',i,(split_part(actor->>'slot',':',2))::integer); END IF;
   seen_employments:=seen_employments||(actor->>'employmentId')::uuid; seen_people:=seen_people||(actor->>'personId')::uuid;
   IF actor->>'userId' IS NOT NULL THEN seen_users:=seen_users||(actor->>'userId')::uuid; END IF;
  END LOOP;
  resolved:=resolved||jsonb_build_array(jsonb_build_object('name','Level '||(i+1)::text,'mode',stage->>'mode','source',source,'approvers',actors,'hrAlternative',alternative));
 END LOOP;
 RETURN jsonb_build_object('ok',true,'stages',resolved);
END $$;

--> statement-breakpoint
-- Replaces 5124. The chain-length walk and CC superiors use the tenant-wide traversal; a CC employee may be in any
-- company of the tenant, and a CC employee or superior without an account yet is left out (CC is notification only).
-- Duplicate-login checks skip a pending approver's null login. Unchanged otherwise.
CREATE OR REPLACE FUNCTION app.attendance_workflow_resolve_v4(subject_id uuid,configured jsonb,configured_cc jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE subject public.employment; stage jsonb; source jsonb; actor jsonb; result jsonb; actors jsonb; resolved jsonb:='[]';
 seen_employments uuid[]:='{}';seen_people uuid[]:='{}';seen_users uuid[]:='{}';total integer:=0;i integer;j integer;alternative boolean;
 recipients jsonb:='[]';addresses text[]:='{}';address text;recipient jsonb;cc_ids uuid[];cc_id uuid;h record;identity record;l record;
 max_depth integer:=0;chain_length integer:=NULL;kept jsonb;dropped jsonb;skipped jsonb:='[]';kept_index integer:=0;
BEGIN
 IF NOT app.principal_snapshot_current() THEN RETURN app.attendance_workflow_v3_problem('employee_unavailable',NULL); END IF;
 SELECT e.* INTO subject FROM public.employment e WHERE e.id=subject_id AND e.tenant_id=app.current_tenant_id();
 IF NOT FOUND OR NOT app.can_see_employment(subject_id) THEN RETURN app.attendance_workflow_v3_problem('employee_unavailable',NULL); END IF;
 IF jsonb_typeof(configured) IS DISTINCT FROM 'array' THEN RETURN app.attendance_workflow_v3_problem('invalid_route',NULL); END IF;
 IF jsonb_array_length(configured) NOT BETWEEN 1 AND 10 THEN RETURN app.attendance_workflow_v3_problem('level_count',NULL); END IF;
 SELECT coalesce(max(CASE WHEN x.s->>'depth' ~ '^[1-5]$' THEN (x.s->>'depth')::integer END),0) INTO max_depth FROM (
  SELECT src.s FROM jsonb_array_elements(configured) AS st(v), jsonb_array_elements(CASE WHEN jsonb_typeof(st.v->'sources')='array' THEN st.v->'sources' ELSE '[]'::jsonb END) AS src(s)
  UNION ALL SELECT c.s FROM jsonb_array_elements(CASE WHEN jsonb_typeof(configured_cc)='array' THEN configured_cc ELSE '[]'::jsonb END) AS c(s)
 ) x WHERE jsonb_typeof(x.s)='object' AND x.s->>'kind'='direct_manager' AND jsonb_typeof(x.s->'depth')='number';
 IF max_depth>0 AND EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=subject.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) THEN
  SELECT x.level_number,x.problem INTO h FROM app.attendance_workflow_hierarchy_v5(subject_id,max_depth) x WHERE x.problem IS NOT NULL ORDER BY x.level_number LIMIT 1;
  IF FOUND AND h.problem='missing_superior' AND h.level_number>1 THEN chain_length:=h.level_number-1; END IF;
 END IF;
 FOR i IN 0..jsonb_array_length(configured)-1 LOOP
  stage:=configured->i;actors:='[]';alternative:=false;
  IF jsonb_typeof(stage) IS DISTINCT FROM 'object' OR NOT stage ?& ARRAY['name','mode','sources','hrAlternative'] OR EXISTS(SELECT 1 FROM jsonb_object_keys(stage) k WHERE k NOT IN('name','mode','sources','hrAlternative'))
   OR jsonb_typeof(stage->'name') IS DISTINCT FROM 'string' OR length(stage->>'name')>100 OR jsonb_typeof(stage->'hrAlternative') IS DISTINCT FROM 'boolean' THEN RETURN app.attendance_workflow_v3_problem('invalid_level',i); END IF;
  IF coalesce(stage->>'mode','') NOT IN('any_one','all_required','sequential') THEN RETURN app.attendance_workflow_v3_problem('invalid_mode',i); END IF;
  IF jsonb_typeof(stage->'sources') IS DISTINCT FROM 'array' THEN RETURN app.attendance_workflow_v3_problem('invalid_source',i); END IF;
  IF jsonb_array_length(stage->'sources') NOT BETWEEN 1 AND 20 OR (stage->>'hrAlternative'='true' AND (jsonb_array_length(stage->'sources')<>1 OR stage->'sources'->0->>'kind'<>'direct_manager')) THEN RETURN app.attendance_workflow_v3_problem('invalid_source',i); END IF;
  kept:=stage->'sources';dropped:='[]';
  IF chain_length IS NOT NULL AND stage->>'hrAlternative'='false' THEN
   SELECT coalesce(jsonb_agg(x.s ORDER BY x.n) FILTER (WHERE NOT x.d),'[]'::jsonb),coalesce(jsonb_agg(x.s ORDER BY x.n) FILTER (WHERE x.d),'[]'::jsonb) INTO kept,dropped
    FROM (SELECT a.s,a.n,CASE WHEN jsonb_typeof(a.s)='object' AND a.s->>'kind'='direct_manager' AND jsonb_typeof(a.s->'depth')='number' AND a.s->>'depth' ~ '^[1-5]$'
      THEN (a.s->>'depth')::integer>chain_length ELSE false END AS d
     FROM jsonb_array_elements(stage->'sources') WITH ORDINALITY AS a(s,n)) x;
  END IF;
  IF jsonb_array_length(dropped)>0 THEN
   skipped:=skipped||jsonb_build_array(jsonb_build_object('configuredLevel',i+1,'sources',dropped,'reason','no_further_superior','levelSkipped',jsonb_array_length(kept)=0));
  END IF;
  CONTINUE WHEN jsonb_array_length(kept)=0;
  FOR j IN 0..jsonb_array_length(kept)-1 LOOP
   source:=kept->j;
   result:=app.attendance_workflow_resolve_v3(subject_id,jsonb_build_array(jsonb_build_object('name','Level 1','mode','sequential','source',source,'hrAlternative',stage->'hrAlternative')));
   IF result->>'ok' IS DISTINCT FROM 'true' THEN RETURN jsonb_set(result,'{problem,levelIndex}',to_jsonb(i)); END IF;
   alternative:=alternative OR (result->'stages'->0->>'hrAlternative')::boolean;
   FOR actor IN SELECT value FROM jsonb_array_elements(result->'stages'->0->'approvers') LOOP
    IF (actor->>'employmentId')::uuid=ANY(seen_employments) THEN RETURN app.attendance_workflow_v3_problem('duplicate_employment',i); END IF;
    IF (actor->>'personId')::uuid=ANY(seen_people) THEN RETURN app.attendance_workflow_v3_problem('duplicate_person',i); END IF;
    IF actor->>'userId' IS NOT NULL AND (actor->>'userId')::uuid=ANY(seen_users) THEN RETURN app.attendance_workflow_v3_problem('duplicate_login',i); END IF;
    seen_employments:=seen_employments||(actor->>'employmentId')::uuid;seen_people:=seen_people||(actor->>'personId')::uuid;
    IF actor->>'userId' IS NOT NULL THEN seen_users:=seen_users||(actor->>'userId')::uuid; END IF;
    actor:=actor||jsonb_build_object('slot',kept_index::text||':'||jsonb_array_length(actors)::text,'sourceIndex',j);actors:=actors||jsonb_build_array(actor);total:=total+1;
   END LOOP;
   IF jsonb_array_length(actors)>20 OR total>100 THEN RETURN app.attendance_workflow_v3_problem('too_many_participants',i); END IF;
  END LOOP;
  resolved:=resolved||jsonb_build_array(jsonb_build_object('name','Level '||(i+1)::text,'mode',stage->>'mode','sources',kept,'hrAlternative',alternative,'approvers',actors));
  kept_index:=kept_index+1;
 END LOOP;
 IF jsonb_array_length(resolved)=0 THEN RETURN app.attendance_workflow_v3_problem('missing_superior',0); END IF;
 IF jsonb_typeof(configured_cc) IS DISTINCT FROM 'array' THEN RETURN app.attendance_workflow_v3_problem('invalid_route',NULL); END IF;
 IF jsonb_array_length(configured_cc)>20 THEN RETURN app.attendance_workflow_v3_problem('invalid_route',NULL); END IF;
 FOR source IN SELECT value FROM jsonb_array_elements(configured_cc) LOOP
  cc_ids:='{}';
  IF source->>'kind'='custom_email' THEN
   IF jsonb_typeof(source) IS DISTINCT FROM 'object' OR NOT source ?& ARRAY['kind','addresses'] OR EXISTS(SELECT 1 FROM jsonb_object_keys(source) k WHERE k NOT IN('kind','addresses')) OR jsonb_typeof(source->'addresses') IS DISTINCT FROM 'array' THEN RETURN app.attendance_workflow_v3_problem('invalid_route',NULL); END IF;
   IF jsonb_array_length(source->'addresses') NOT BETWEEN 1 AND 50 THEN RETURN app.attendance_workflow_v3_problem('invalid_route',NULL); END IF;
   FOR actor IN SELECT value FROM jsonb_array_elements(source->'addresses') LOOP
    IF jsonb_typeof(actor) IS DISTINCT FROM 'string' THEN RETURN app.attendance_workflow_v3_problem('invalid_route',NULL); END IF;
    address:=lower(actor#>>'{}');
    IF length(address)>320 OR address !~ '^[!-~]+$' OR address !~ '^[^@<>(),:;"\\ ]+@[^@<>(),:;"\\ ]+\.[^@<>(),:;"\\ ]+$' THEN RETURN app.attendance_workflow_v3_problem('invalid_route',NULL); END IF;
    IF NOT address=ANY(addresses) THEN addresses:=addresses||address;recipients:=recipients||jsonb_build_array(jsonb_build_object('kind','custom_email','address',address)); END IF;
   END LOOP;
  ELSIF source->>'kind'='direct_manager' THEN
   IF NOT source ?& ARRAY['kind','depth'] OR EXISTS(SELECT 1 FROM jsonb_object_keys(source) k WHERE k NOT IN('kind','depth')) OR jsonb_typeof(source->'depth') IS DISTINCT FROM 'number' OR coalesce(source->>'depth','') !~ '^[1-5]$' THEN RETURN app.attendance_workflow_v3_problem('invalid_route',NULL); END IF;
   CONTINUE WHEN chain_length IS NOT NULL AND (source->>'depth')::integer>chain_length;
   SELECT * INTO h FROM app.attendance_workflow_hierarchy_v5(subject_id,(source->>'depth')::integer) x WHERE x.level_number=(source->>'depth')::integer;
   IF NOT FOUND OR h.problem IS NOT NULL OR h.employment_id IS NULL THEN RETURN app.attendance_workflow_v3_problem('invalid_route',NULL); END IF;
   CONTINUE WHEN h.pending_activation;
   cc_ids:=ARRAY[h.employment_id];
  ELSIF source->>'kind'='specific_employee' THEN
   IF NOT source ?& ARRAY['kind','employmentIds'] OR EXISTS(SELECT 1 FROM jsonb_object_keys(source) k WHERE k NOT IN('kind','employmentIds')) OR jsonb_typeof(source->'employmentIds') IS DISTINCT FROM 'array' THEN RETURN app.attendance_workflow_v3_problem('invalid_route',NULL); END IF;
   IF jsonb_array_length(source->'employmentIds') NOT BETWEEN 1 AND 20 THEN RETURN app.attendance_workflow_v3_problem('invalid_route',NULL); END IF;
   FOR actor IN SELECT value FROM jsonb_array_elements(source->'employmentIds') LOOP
    IF jsonb_typeof(actor) IS DISTINCT FROM 'string' OR coalesce(actor#>>'{}','') !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' THEN RETURN app.attendance_workflow_v3_problem('invalid_route',NULL); END IF;
    cc_ids:=cc_ids||(actor#>>'{}')::uuid;
   END LOOP;
  ELSE RETURN app.attendance_workflow_v3_problem('invalid_route',NULL); END IF;
  FOREACH cc_id IN ARRAY cc_ids LOOP
   SELECT e.id,e.person_id,p.primary_email INTO identity FROM public.employment e JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
    WHERE e.id=cc_id AND e.tenant_id=subject.tenant_id AND e.blacklisted_at IS NULL AND e.hired_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (e.terminated_on IS NULL OR e.terminated_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date);
   IF NOT FOUND OR identity.primary_email IS NULL THEN RETURN app.attendance_workflow_v3_problem('invalid_route',NULL); END IF;
   SELECT * INTO l FROM app.attendance_workflow_approver_login(identity.person_id);
   CONTINUE WHEN l.usable=0 AND l.accounts=0;
   IF l.usable<>1 THEN RETURN app.attendance_workflow_v3_problem('invalid_route',NULL); END IF;
   address:=lower(identity.primary_email);
   IF length(address)>320 OR address !~ '^[!-~]+$' OR address !~ '^[^@<>(),:;"\\ ]+@[^@<>(),:;"\\ ]+\.[^@<>(),:;"\\ ]+$' THEN RETURN app.attendance_workflow_v3_problem('invalid_route',NULL); END IF;
   recipient:=jsonb_build_object('kind','employee','address',address,'employmentId',cc_id,'personId',identity.person_id,'userId',l.user_id);
   IF address=ANY(addresses) THEN SELECT coalesce(jsonb_agg(CASE WHEN r->>'address'=address THEN recipient ELSE r END),'[]') INTO recipients FROM jsonb_array_elements(recipients) r;
   ELSE addresses:=addresses||address;recipients:=recipients||jsonb_build_array(recipient); END IF;
  END LOOP;
  IF jsonb_array_length(recipients)>50 THEN RETURN app.attendance_workflow_v3_problem('invalid_route',NULL); END IF;
 END LOOP;
 RETURN jsonb_build_object('ok',true,'stages',resolved,'cc',recipients,'skipped',skipped);
END $$;

--> statement-breakpoint
-- Replaces 3101. Frozen participants keep their exact saved identity. A frozen login must still be live and hold any
-- tenant role (no subject-company fence). A participant frozen with a null login (pending activation) is acted for
-- by that person's single usable login once their account exists; nobody else gains that slot.
CREATE OR REPLACE FUNCTION app.attendance_workflow_v3_assigned_allowed(wanted_request uuid,wanted_stage integer,wanted_slot text,acting text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE w public.attendance_workflow_request; caller public.app_user; actor jsonb; subject_person uuid; frozen_user uuid; l record;
BEGIN
 SELECT r.* INTO w FROM public.attendance_workflow_request r WHERE r.id=wanted_request AND r.tenant_id=app.current_tenant_id() AND r.routing_version IN (3,4);
 IF NOT FOUND OR NOT app.principal_snapshot_current() THEN RETURN false; END IF;
 SELECT u.* INTO caller FROM public.app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=w.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id);
 IF NOT FOUND OR caller.person_id IS NULL THEN RETURN false; END IF;
 SELECT e.person_id INTO subject_person FROM public.employment e WHERE e.id=w.employment_id AND e.tenant_id=w.tenant_id;
 IF caller.person_id=subject_person THEN RETURN false; END IF;
 actor:=app.attendance_workflow_v3_actor(w.id,wanted_stage,wanted_slot);
 IF actor IS NULL THEN RETURN false; END IF;
 IF actor->>'kind'='hr_admin' THEN
  RETURN acting='assigned' AND app.is_admin_for(w.company_id) AND EXISTS(SELECT 1 FROM public.role_assignment r
   WHERE r.app_user_id=caller.id AND r.tenant_id=w.tenant_id AND r.role::text IN ('hr_admin','super_admin')
    AND (r.company_id IS NULL OR r.company_id=w.company_id OR app.is_company_descendant(w.company_id,r.company_id)));
 END IF;
 IF actor->>'kind' NOT IN ('direct_manager','specific_employee') OR acting NOT IN ('assigned','delegate') THEN RETURN false; END IF;
 IF coalesce(actor->>'userId','') ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' THEN frozen_user:=(actor->>'userId')::uuid; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.employment e
  WHERE e.id=(actor->>'employmentId')::uuid AND e.person_id=(actor->>'personId')::uuid AND e.tenant_id=w.tenant_id
   AND e.person_id<>subject_person AND e.blacklisted_at IS NULL AND e.hired_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
   AND (e.terminated_on IS NULL OR e.terminated_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)) THEN RETURN false; END IF;
 IF frozen_user IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=frozen_user AND u.person_id=(actor->>'personId')::uuid AND u.tenant_id=w.tenant_id
   AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
   AND EXISTS(SELECT 1 FROM public.role_assignment r WHERE r.app_user_id=u.id AND r.tenant_id=w.tenant_id AND r.role::text IN ('employee','manager','hr_admin','super_admin'))) THEN RETURN false; END IF;
  IF acting='assigned' THEN RETURN caller.id=frozen_user AND caller.person_id=(actor->>'personId')::uuid; END IF;
 ELSIF actor->>'pendingActivation'='true' THEN
  IF acting='assigned' THEN
   SELECT * INTO l FROM app.attendance_workflow_approver_login((actor->>'personId')::uuid);
   RETURN l.usable=1 AND l.user_id=caller.id AND caller.person_id=(actor->>'personId')::uuid;
  END IF;
 ELSE RETURN false; END IF;
 RETURN app.can_decide_via_delegation_from((actor->>'employmentId')::uuid,w.employment_id,'attendance','attendance.correction');
END $$;

--> statement-breakpoint
-- Replaces 3101 for the HR panel's eligibility column. Version 3/4 participants follow the assigned-authority rule
-- above (tenant-wide, pending activation acted for by the activated login); version 1/2 keep the 3101 predicate.
CREATE OR REPLACE FUNCTION app.attendance_workflow_review_participants(p_correction uuid)
RETURNS TABLE(participant_slot text,employment_id uuid,employee_code text,kind text,eligible boolean,acting_mode text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
 w public.attendance_workflow_request; request_status text; subject_person uuid;
 actors jsonb; actor jsonb; candidate_emp uuid; candidate_person uuid; candidate_user uuid;
 candidate_slot text; candidate_kind text; candidate_code text; candidate_ok boolean; l record;
 hr_ok boolean; any_eligible boolean:=false; has_actor boolean:=false; ordinal integer:=0;
BEGIN
 SELECT r.* INTO w FROM public.attendance_workflow_request r
 WHERE r.correction_id=p_correction AND r.tenant_id=app.current_tenant_id();
 IF NOT FOUND THEN RETURN; END IF;
 SELECT c.status::text INTO request_status FROM public.attendance_correction c WHERE c.id=w.correction_id AND c.tenant_id=w.tenant_id;
 IF request_status IS DISTINCT FROM 'pending' OR w.current_stage>=jsonb_array_length(w.stages) THEN RETURN; END IF;
 IF NOT app.is_admin_for(w.company_id) OR NOT EXISTS(
  SELECT 1 FROM public.app_user u JOIN public.role_assignment r ON r.app_user_id=u.id AND r.tenant_id=u.tenant_id
  WHERE u.id=app.current_user_id() AND u.tenant_id=w.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
   AND r.role::text IN ('hr_admin','super_admin') AND (r.company_id IS NULL OR r.company_id=w.company_id OR app.is_company_descendant(w.company_id,r.company_id)))
 THEN RETURN; END IF;
 SELECT e.person_id INTO subject_person FROM public.employment e WHERE e.id=w.employment_id AND e.tenant_id=w.tenant_id;
 SELECT EXISTS(SELECT 1 FROM public.app_user u JOIN public.role_assignment r ON r.app_user_id=u.id AND r.tenant_id=u.tenant_id
  WHERE u.tenant_id=w.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
   AND u.person_id IS DISTINCT FROM subject_person AND (w.routing_version NOT IN (3,4) OR u.person_id IS NOT NULL)
   AND r.role::text IN ('hr_admin','super_admin') AND (r.company_id IS NULL OR r.company_id=w.company_id OR app.is_company_descendant(w.company_id,r.company_id))
   AND (w.routing_version=1 OR NOT EXISTS(SELECT 1 FROM public.attendance_workflow_decision d WHERE d.request_id=w.id AND d.tenant_id=w.tenant_id AND (d.actual_user_id=u.id::text OR d.actual_person_id=u.person_id)))
   AND (w.routing_version NOT IN (3,4) OR NOT EXISTS(SELECT 1 FROM public.attendance_workflow_participant_decision d WHERE d.request_id=w.id AND d.tenant_id=w.tenant_id AND (d.actual_user_id=u.id OR d.actual_person_id=u.person_id)))) INTO hr_ok;
 IF w.routing_version IN (3,4) THEN
  actors:=app.attendance_workflow_v3_effective(w.id,w.current_stage);
  actor:=app.attendance_workflow_v3_actor(w.id,w.current_stage,w.current_stage::text||':hr');
  IF actor IS NOT NULL THEN actors:=actors||jsonb_build_array(actor); END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM public.attendance_workflow_decision d WHERE d.request_id=w.id AND d.stage_index=w.current_stage) THEN RETURN; END IF;
  actors:=app.attendance_workflow_effective_approvers(w.id,w.current_stage);
 END IF;
 IF jsonb_typeof(actors) IS DISTINCT FROM 'array' THEN RETURN; END IF;
 FOR actor IN SELECT value FROM jsonb_array_elements(actors) LOOP
  candidate_kind:=actor->>'kind'; candidate_code:=NULL; candidate_emp:=NULL; candidate_person:=NULL; candidate_user:=NULL;
  candidate_slot:=coalesce(actor->>'slot',w.current_stage::text||':'||ordinal::text); ordinal:=ordinal+1;
  IF candidate_kind IS NULL OR candidate_kind NOT IN ('direct_manager','specific_employee','hr_admin') THEN CONTINUE; END IF;
  has_actor:=true;
  IF w.routing_version IN (3,4) AND NOT app.attendance_workflow_v3_outstanding(w.id,w.current_stage,candidate_slot) THEN CONTINUE; END IF;
  IF candidate_kind='hr_admin' THEN
   candidate_ok:=hr_ok;
  ELSE
   IF coalesce(actor->>'employmentId','') ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' THEN candidate_emp:=(actor->>'employmentId')::uuid; END IF;
   IF coalesce(actor->>'personId','') ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' THEN candidate_person:=(actor->>'personId')::uuid; END IF;
   IF coalesce(actor->>'userId','') ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' THEN candidate_user:=(actor->>'userId')::uuid; END IF;
   SELECT e.employee_code INTO candidate_code FROM public.employment e WHERE e.id=candidate_emp AND e.tenant_id=w.tenant_id;
   IF w.routing_version IN (3,4) THEN
    IF candidate_user IS NULL AND actor->>'pendingActivation'='true' AND candidate_person IS NOT NULL THEN
     SELECT * INTO l FROM app.attendance_workflow_approver_login(candidate_person);
     IF l.usable=1 THEN candidate_user:=l.user_id; END IF;
    END IF;
    SELECT EXISTS(SELECT 1 FROM public.employment e JOIN public.app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id
     WHERE e.id=candidate_emp AND e.tenant_id=w.tenant_id AND e.person_id<>subject_person AND e.person_id=candidate_person AND u.id=candidate_user
      AND e.blacklisted_at IS NULL AND e.hired_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
      AND (e.terminated_on IS NULL OR e.terminated_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
      AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
      AND EXISTS(SELECT 1 FROM public.role_assignment r WHERE r.app_user_id=u.id AND r.tenant_id=w.tenant_id AND r.role::text IN ('employee','manager','hr_admin','super_admin'))
      AND NOT EXISTS(SELECT 1 FROM public.attendance_workflow_decision d WHERE d.request_id=w.id AND d.tenant_id=w.tenant_id AND (d.actual_user_id=u.id::text OR d.actual_person_id=u.person_id))
      AND NOT EXISTS(SELECT 1 FROM public.attendance_workflow_participant_decision d WHERE d.request_id=w.id AND d.tenant_id=w.tenant_id AND (d.actual_user_id=u.id OR d.actual_person_id=u.person_id))) INTO candidate_ok;
   ELSE
    SELECT EXISTS(SELECT 1 FROM public.employment e JOIN public.app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id
     WHERE e.id=candidate_emp AND e.tenant_id=w.tenant_id AND e.person_id<>subject_person
      AND (w.routing_version=1 OR (e.person_id=candidate_person AND u.id=candidate_user))
      AND e.blacklisted_at IS NULL AND e.hired_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
      AND (e.terminated_on IS NULL OR e.terminated_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
      AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND ((candidate_kind='specific_employee') OR (candidate_kind='direct_manager' AND app.is_company_descendant(w.company_id,e.company_id)))
      AND EXISTS(SELECT 1 FROM public.role_assignment r WHERE r.app_user_id=u.id AND r.tenant_id=w.tenant_id AND r.role::text IN ('employee','manager','hr_admin','super_admin')
       AND (r.company_id IS NULL OR r.company_id=w.company_id OR app.is_company_descendant(w.company_id,r.company_id)))
      AND (w.routing_version=1 OR NOT EXISTS(SELECT 1 FROM public.attendance_workflow_decision d WHERE d.request_id=w.id AND d.tenant_id=w.tenant_id AND (d.actual_user_id=u.id::text OR d.actual_person_id=u.person_id)))
      AND (w.routing_version<>1 OR EXISTS(SELECT 1 FROM app.attendance_workflow_manager(w.employment_id) m WHERE m.employment_id=e.id))) INTO candidate_ok;
   END IF;
  END IF;
  any_eligible:=any_eligible OR coalesce(candidate_ok,false);
  RETURN QUERY SELECT candidate_slot,candidate_emp,candidate_code,candidate_kind,coalesce(candidate_ok,false),'assigned'::text;
 END LOOP;
 IF w.routing_version IN (1,2) AND has_actor AND NOT any_eligible AND hr_ok THEN
  RETURN QUERY SELECT NULL::text,NULL::uuid,NULL::text,'hr_admin'::text,true,'administrator'::text;
 END IF;
END $$;

--> statement-breakpoint
-- Replaces 5124. Preview wording only: no subject-company fence, a login holding any tenant role covers, and a superior
-- without an account yet is not a problem (the walk continues past them). login_wrong_company is no longer produced.
CREATE OR REPLACE FUNCTION app.attendance_workflow_superior_diagnostic(subject_id uuid,wanted_depth integer)
RETURNS TABLE(level_number integer,employment_id uuid,employee_code text,full_name text,problem text,login_count integer,any_company_login_count integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE subject public.employment; manager public.employment; cursor_id uuid; next_id uuid; edge_count integer; usable integer; accounts integer; login_id uuid;
 seen_employments uuid[]; seen_people uuid[]; seen_users uuid[]:='{}'; n integer; failure text; manager_name text; today date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
BEGIN
 IF wanted_depth NOT BETWEEN 1 AND 10 OR NOT app.principal_snapshot_current() THEN RETURN; END IF;
 SELECT e.* INTO subject FROM public.employment e WHERE e.id=subject_id AND e.tenant_id=app.current_tenant_id();
 IF NOT FOUND OR NOT app.is_admin_for(subject.company_id) THEN RETURN; END IF;
 cursor_id:=subject.id; seen_employments:=ARRAY[subject.id]; seen_people:=ARRAY[subject.person_id];
 FOR n IN 1..wanted_depth LOOP
  SELECT count(*)::integer,min(r.manager_employment_id::text)::uuid INTO edge_count,next_id FROM public.reporting_line r
   WHERE r.subordinate_employment_id=cursor_id AND r.tenant_id=subject.tenant_id AND r.line_type='administrative'
    AND r.superseded_at IS NULL AND r.valid_from<=today AND (r.valid_to IS NULL OR r.valid_to>today);
  IF edge_count=0 THEN RETURN QUERY SELECT n,NULL::uuid,NULL::text,NULL::text,'no_superior'::text,0,0; RETURN; END IF;
  IF edge_count>1 THEN RETURN QUERY SELECT n,NULL::uuid,NULL::text,NULL::text,'ambiguous_superior'::text,0,0; RETURN; END IF;
  SELECT e.* INTO manager FROM public.employment e WHERE e.id=next_id AND e.tenant_id=subject.tenant_id;
  IF NOT FOUND THEN RETURN QUERY SELECT n,NULL::uuid,NULL::text,NULL::text,'no_superior'::text,0,0; RETURN; END IF;
  SELECT p.full_name INTO manager_name FROM public.person p WHERE p.id=manager.person_id AND p.tenant_id=subject.tenant_id;
  failure:=NULL; usable:=0; accounts:=0; login_id:=NULL;
  IF next_id=ANY(seen_employments) THEN failure:='cycle';
  ELSIF manager.person_id=ANY(seen_people) THEN failure:='duplicate_person';
  ELSIF manager.hired_on>today OR manager.blacklisted_at IS NOT NULL OR (manager.terminated_on IS NOT NULL AND manager.terminated_on<=today) THEN failure:='superior_inactive';
  ELSE
   SELECT x.usable,x.user_id,x.accounts INTO usable,login_id,accounts FROM app.attendance_workflow_approver_login(manager.person_id) x;
   IF usable>1 THEN failure:='multiple_logins';
   ELSIF usable=0 AND accounts>0 THEN failure:='no_login';
   ELSIF login_id IS NOT NULL AND login_id=ANY(seen_users) THEN failure:='duplicate_login';
   ELSIF manager_name IS NULL THEN failure:='missing_person'; END IF;
  END IF;
  RETURN QUERY SELECT n,manager.id,manager.employee_code,manager_name,failure,usable,usable;
  IF failure IS NOT NULL THEN RETURN; END IF;
  seen_employments:=seen_employments||manager.id; seen_people:=seen_people||manager.person_id;
  IF login_id IS NOT NULL THEN seen_users:=seen_users||login_id; END IF; cursor_id:=manager.id;
 END LOOP;
END $$;
