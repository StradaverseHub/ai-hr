-- Board 4452ba3c. Reservation 4501 @ idx 3901 / when 1793330004201 (unapplied).
-- Additive only. Requests already submitted keep their frozen stages and decide exactly as before:
-- existing rows receive skipped_levels='[]', and no hierarchy, decision, advance or effect function changes.
ALTER TABLE public.attendance_workflow_request ADD COLUMN skipped_levels jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.attendance_workflow_request ADD CONSTRAINT attendance_workflow_request_skipped_levels_ck CHECK(jsonb_typeof(skipped_levels)='array' AND jsonb_array_length(skipped_levels)<=10);

--> statement-breakpoint
-- Replaces 0592_attendance_workflow_v4.sql. Skip is decided once, at submission, from that day's
-- reporting lines. A Direct Superior source above the end of a genuinely ended chain (the first
-- unresolved depth is exactly missing_superior and the employee has at least one valid superior) is
-- dropped. A level left without sources is recorded in "skipped" and omitted; kept stages stay
-- contiguous so the unchanged decision owners read only w.stages. HR-alternative levels and every
-- other problem (inactive, login, scope, cycle, no superior at all) keep today's behaviour.
CREATE OR REPLACE FUNCTION app.attendance_workflow_resolve_v4(subject_id uuid,configured jsonb,configured_cc jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE subject public.employment; stage jsonb; source jsonb; actor jsonb; result jsonb; actors jsonb; resolved jsonb:='[]';
 seen_employments uuid[]:='{}';seen_people uuid[]:='{}';seen_users uuid[]:='{}';total integer:=0;i integer;j integer;alternative boolean;
 recipients jsonb:='[]';addresses text[]:='{}';address text;recipient jsonb;cc_ids uuid[];cc_id uuid;h record;identity record;login_count integer;login_id uuid;
 max_depth integer:=0;chain_length integer:=NULL;kept jsonb;dropped jsonb;skipped jsonb:='[]';kept_index integer:=0;
BEGIN
 IF NOT app.principal_snapshot_current() THEN RETURN app.attendance_workflow_v3_problem('employee_unavailable',NULL); END IF;
 SELECT e.* INTO subject FROM public.employment e WHERE e.id=subject_id AND e.tenant_id=app.current_tenant_id();
 IF NOT FOUND OR NOT app.can_see_employment(subject_id) THEN RETURN app.attendance_workflow_v3_problem('employee_unavailable',NULL); END IF;
 IF jsonb_typeof(configured) IS DISTINCT FROM 'array' THEN RETURN app.attendance_workflow_v3_problem('invalid_route',NULL); END IF;
 IF jsonb_array_length(configured) NOT BETWEEN 1 AND 10 THEN RETURN app.attendance_workflow_v3_problem('level_count',NULL); END IF;
 -- Chain length: only computed for a well-formed Direct Superior depth and an authorized live caller
 -- (the hierarchy owner raises otherwise; resolve_v3 then returns the existing problem).
 SELECT coalesce(max(CASE WHEN x.s->>'depth' ~ '^[1-5]$' THEN (x.s->>'depth')::integer END),0) INTO max_depth FROM (
  SELECT src.s FROM jsonb_array_elements(configured) AS st(v), jsonb_array_elements(CASE WHEN jsonb_typeof(st.v->'sources')='array' THEN st.v->'sources' ELSE '[]'::jsonb END) AS src(s)
  UNION ALL SELECT c.s FROM jsonb_array_elements(CASE WHEN jsonb_typeof(configured_cc)='array' THEN configured_cc ELSE '[]'::jsonb END) AS c(s)
 ) x WHERE jsonb_typeof(x.s)='object' AND x.s->>'kind'='direct_manager' AND jsonb_typeof(x.s->'depth')='number';
 IF max_depth>0 AND EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=subject.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) THEN
  SELECT x.level_number,x.problem INTO h FROM app.attendance_workflow_hierarchy(subject_id,max_depth) x WHERE x.problem IS NOT NULL ORDER BY x.level_number LIMIT 1;
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
    IF (actor->>'userId')::uuid=ANY(seen_users) THEN RETURN app.attendance_workflow_v3_problem('duplicate_login',i); END IF;
    seen_employments:=seen_employments||(actor->>'employmentId')::uuid;seen_people:=seen_people||(actor->>'personId')::uuid;seen_users:=seen_users||(actor->>'userId')::uuid;
    actor:=actor||jsonb_build_object('slot',kept_index::text||':'||jsonb_array_length(actors)::text,'sourceIndex',j);actors:=actors||jsonb_build_array(actor);total:=total+1;
   END LOOP;
   IF jsonb_array_length(actors)>20 OR total>100 THEN RETURN app.attendance_workflow_v3_problem('too_many_participants',i); END IF;
  END LOOP;
  -- The configured level name is kept; the slot ordinal is the kept stage index.
  resolved:=resolved||jsonb_build_array(jsonb_build_object('name','Level '||(i+1)::text,'mode',stage->>'mode','sources',kept,'hrAlternative',alternative,'approvers',actors));
  kept_index:=kept_index+1;
 END LOOP;
 -- Never zero approvers: a route whose every level would be skipped is refused as today.
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
   -- A CC to a superior above the end of a genuinely ended chain does not exist and is left out.
   CONTINUE WHEN chain_length IS NOT NULL AND (source->>'depth')::integer>chain_length;
   SELECT * INTO h FROM app.attendance_workflow_hierarchy(subject_id,(source->>'depth')::integer) x WHERE x.level_number=(source->>'depth')::integer;
   IF NOT FOUND OR h.problem IS NOT NULL OR h.employment_id IS NULL THEN RETURN app.attendance_workflow_v3_problem('invalid_route',NULL); END IF;
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
    WHERE e.id=cc_id AND e.tenant_id=subject.tenant_id AND e.blacklisted_at IS NULL AND e.hired_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (e.terminated_on IS NULL OR e.terminated_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) AND app.is_company_descendant(subject.company_id,e.company_id);
   IF NOT FOUND OR identity.primary_email IS NULL THEN RETURN app.attendance_workflow_v3_problem('invalid_route',NULL); END IF;
   SELECT count(*)::integer,min(u.id::text)::uuid INTO login_count,login_id FROM public.app_user u WHERE u.person_id=identity.person_id AND u.tenant_id=subject.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND EXISTS(SELECT 1 FROM public.role_assignment r WHERE r.app_user_id=u.id AND r.tenant_id=subject.tenant_id AND r.role::text IN('employee','manager','hr_admin','super_admin') AND (r.company_id IS NULL OR r.company_id=subject.company_id OR app.is_company_descendant(subject.company_id,r.company_id)));
   IF login_count<>1 THEN RETURN app.attendance_workflow_v3_problem('invalid_route',NULL); END IF;
   address:=lower(identity.primary_email);
   IF length(address)>320 OR address !~ '^[!-~]+$' OR address !~ '^[^@<>(),:;"\\ ]+@[^@<>(),:;"\\ ]+\.[^@<>(),:;"\\ ]+$' THEN RETURN app.attendance_workflow_v3_problem('invalid_route',NULL); END IF;
   recipient:=jsonb_build_object('kind','employee','address',address,'employmentId',cc_id,'personId',identity.person_id,'userId',login_id);
   -- Internal provenance wins over an earlier custom copy of the same address.
   IF address=ANY(addresses) THEN SELECT coalesce(jsonb_agg(CASE WHEN r->>'address'=address THEN recipient ELSE r END),'[]') INTO recipients FROM jsonb_array_elements(recipients) r;
   ELSE addresses:=addresses||address;recipients:=recipients||jsonb_build_array(recipient); END IF;
  END LOOP;
  IF jsonb_array_length(recipients)>50 THEN RETURN app.attendance_workflow_v3_problem('invalid_route',NULL); END IF;
 END LOOP;
 RETURN jsonb_build_object('ok',true,'stages',resolved,'cc',recipients,'skipped',skipped);
END $$;
REVOKE ALL ON FUNCTION app.attendance_workflow_resolve_v4(uuid,jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.attendance_workflow_resolve_v4(uuid,jsonb,jsonb) TO ai_hr_app;

--> statement-breakpoint
-- Replaces 3101_attendance_shared_workflow.sql. Unchanged except that the v4 skipped levels are also
-- compared with canonical resolution, and older routing versions cannot carry skipped levels.
CREATE OR REPLACE FUNCTION app.attendance_workflow_links() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE canonical jsonb;
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
  IF NEW.routing_version<>4 AND NEW.skipped_levels IS DISTINCT FROM '[]'::jsonb THEN RAISE EXCEPTION 'Only a v4 route can record skipped levels'; END IF;
  IF NEW.routing_version=2 AND NEW.stages IS DISTINCT FROM app.attendance_workflow_resolve_v2(NEW.employment_id,(SELECT t.stages FROM public.attendance_workflow_template t WHERE t.id=NEW.template_id AND t.tenant_id=NEW.tenant_id))
   THEN RAISE EXCEPTION 'The submitted hierarchy must match the configured version and live root-authorized resolution'; END IF;
  IF NEW.routing_version=3 AND NEW.stages IS DISTINCT FROM (app.attendance_workflow_resolve_v3(NEW.employment_id,(SELECT t.stages FROM public.attendance_workflow_template t WHERE t.id=NEW.template_id AND t.tenant_id=NEW.tenant_id))->'stages')
   THEN RAISE EXCEPTION 'The v3 route must match the canonical root-authorized resolution'; END IF;
  IF NEW.routing_version=4 THEN
   SELECT app.attendance_workflow_resolve_v4(NEW.employment_id,t.stages,t.cc) INTO canonical FROM public.attendance_workflow_template t WHERE t.id=NEW.template_id AND t.tenant_id=NEW.tenant_id;
   IF NEW.stages IS DISTINCT FROM canonical->'stages' OR NEW.cc IS DISTINCT FROM canonical->'cc' OR NEW.skipped_levels IS DISTINCT FROM canonical->'skipped'
    THEN RAISE EXCEPTION 'The v4 route and CC must match canonical resolution'; END IF;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.attendance_workflow_template t WHERE t.id=NEW.template_id AND t.tenant_id=NEW.tenant_id AND t.superseded_at IS NULL AND t.retired_at IS NULL AND t.active) THEN RAISE EXCEPTION 'The workflow is no longer available for a new application'; END IF;
 ELSIF TG_TABLE_NAME='attendance_workflow_decision' THEN
  IF NOT EXISTS(SELECT 1 FROM public.attendance_workflow_request w WHERE w.id=NEW.request_id AND w.tenant_id=NEW.tenant_id AND w.employment_id=NEW.employment_id)
   OR (NEW.assigned_employment_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.id=NEW.assigned_employment_id AND e.tenant_id=NEW.tenant_id))
   OR (NEW.actual_employment_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.id=NEW.actual_employment_id AND e.tenant_id=NEW.tenant_id AND e.person_id=NEW.actual_person_id))
   OR (NEW.actual_person_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.person p WHERE p.id=NEW.actual_person_id AND p.tenant_id=NEW.tenant_id))
   THEN RAISE EXCEPTION 'Invalid workflow decision links'; END IF;
 END IF;
 RETURN NEW;
END $$;

--> statement-breakpoint
-- Stored Preview Assignment snapshots. Append-only, readable and writable only by an administrator of
-- every company of the previewed workflow version. Names and IDs are a point-in-time snapshot.
CREATE TABLE public.attendance_workflow_preview (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 lineage_id uuid NOT NULL,
 template_id uuid NOT NULL,
 template_version integer NOT NULL CHECK(template_version>0),
 generated_at timestamptz NOT NULL DEFAULT now(),
 generated_by_user_id uuid NOT NULL,
 company_ids uuid[] NOT NULL CHECK(cardinality(company_ids) BETWEEN 1 AND 1000),
 total_matching integer NOT NULL CHECK(total_matching>=0),
 warning_count integer NOT NULL CHECK(warning_count>=0),
 truncated boolean NOT NULL DEFAULT false,
 employees jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(employees)='array' AND jsonb_array_length(employees)<=5000),
 warnings jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(warnings)='array' AND jsonb_array_length(warnings)<=5000),
 CONSTRAINT attendance_workflow_preview_template_fk FOREIGN KEY(tenant_id,template_id) REFERENCES public.attendance_workflow_template(tenant_id,id) ON DELETE RESTRICT,
 CONSTRAINT attendance_workflow_preview_actor_fk FOREIGN KEY(generated_by_user_id,tenant_id) REFERENCES public.app_user(id,tenant_id) ON DELETE RESTRICT
);
CREATE INDEX attendance_workflow_preview_lineage_idx ON public.attendance_workflow_preview(tenant_id,lineage_id,generated_at DESC);
CREATE FUNCTION app.attendance_workflow_preview_bind() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.attendance_workflow_template t WHERE t.id=NEW.template_id AND t.tenant_id=NEW.tenant_id AND t.lineage_id=NEW.lineage_id AND t.version=NEW.template_version)
  THEN RAISE EXCEPTION 'A preview must belong to its saved workflow version'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.attendance_workflow_preview_bind() FROM PUBLIC;
CREATE TRIGGER attendance_workflow_preview_binding BEFORE INSERT ON public.attendance_workflow_preview FOR EACH ROW EXECUTE FUNCTION app.attendance_workflow_preview_bind();
CREATE TRIGGER attendance_workflow_preview_immutable BEFORE UPDATE OR DELETE ON public.attendance_workflow_preview FOR EACH ROW EXECUTE FUNCTION app.payroll_history_immutable();
ALTER TABLE public.attendance_workflow_preview ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_workflow_preview FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.attendance_workflow_preview FROM PUBLIC,ai_hr_app;
GRANT SELECT,INSERT ON public.attendance_workflow_preview TO ai_hr_app;
CREATE POLICY attendance_workflow_preview_read ON public.attendance_workflow_preview FOR SELECT
 USING(tenant_id=app.current_tenant_id() AND app.attendance_workflow_all_companies_admin(template_id));
CREATE POLICY attendance_workflow_preview_insert ON public.attendance_workflow_preview FOR INSERT
 WITH CHECK(tenant_id=app.current_tenant_id() AND app.attendance_workflow_all_companies_admin(template_id) AND generated_by_user_id=app.current_user_id());

--> statement-breakpoint
-- Read-only Direct Superior diagnosis for preview wording only. Frozen resolution is unchanged.
-- Only an administrator of the subject's company receives rows. One row per walked depth; the walk
-- stops at the first problem and names the superior at that depth when one exists.
CREATE FUNCTION app.attendance_workflow_superior_diagnostic(subject_id uuid,wanted_depth integer)
RETURNS TABLE(level_number integer,employment_id uuid,employee_code text,full_name text,problem text,login_count integer,any_company_login_count integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE subject public.employment; manager public.employment; cursor_id uuid; next_id uuid; edge_count integer; covering integer; anywhere integer; covering_id uuid;
 seen_employments uuid[]; seen_people uuid[]; seen_users uuid[]:='{}'; n integer; failure text; manager_name text; today date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
BEGIN
 IF wanted_depth NOT BETWEEN 1 AND 10 OR NOT app.principal_snapshot_current() THEN RETURN; END IF;
 SELECT e.* INTO subject FROM public.employment e WHERE e.id=subject_id AND e.tenant_id=app.current_tenant_id();
 IF NOT FOUND OR NOT app.is_admin_for(subject.company_id) THEN RETURN; END IF;
 cursor_id:=subject.id; seen_employments:=ARRAY[subject.id]; seen_people:=ARRAY[subject.person_id];
 FOR n IN 1..wanted_depth LOOP
  SELECT count(*)::integer,min(l.manager_employment_id::text)::uuid INTO edge_count,next_id FROM public.reporting_line l
   WHERE l.subordinate_employment_id=cursor_id AND l.tenant_id=subject.tenant_id AND l.line_type='administrative'
    AND l.superseded_at IS NULL AND l.valid_from<=today AND (l.valid_to IS NULL OR l.valid_to>today);
  IF edge_count=0 THEN RETURN QUERY SELECT n,NULL::uuid,NULL::text,NULL::text,'no_superior'::text,0,0; RETURN; END IF;
  IF edge_count>1 THEN RETURN QUERY SELECT n,NULL::uuid,NULL::text,NULL::text,'ambiguous_superior'::text,0,0; RETURN; END IF;
  SELECT e.* INTO manager FROM public.employment e WHERE e.id=next_id AND e.tenant_id=subject.tenant_id;
  IF NOT FOUND THEN RETURN QUERY SELECT n,NULL::uuid,NULL::text,NULL::text,'no_superior'::text,0,0; RETURN; END IF;
  SELECT p.full_name INTO manager_name FROM public.person p WHERE p.id=manager.person_id AND p.tenant_id=subject.tenant_id;
  failure:=NULL; covering:=0; anywhere:=0;
  IF next_id=ANY(seen_employments) THEN failure:='cycle';
  ELSIF manager.person_id=ANY(seen_people) THEN failure:='duplicate_person';
  ELSIF manager.hired_on>today OR manager.blacklisted_at IS NOT NULL OR (manager.terminated_on IS NOT NULL AND manager.terminated_on<=today) THEN failure:='superior_inactive';
  ELSIF NOT app.is_company_descendant(subject.company_id,manager.company_id) THEN failure:='outside_company_scope';
  ELSE
   SELECT count(*) FILTER (WHERE x.covers)::integer,count(*)::integer,min(x.id::text) FILTER (WHERE x.covers)::uuid INTO covering,anywhere,covering_id FROM (
    SELECT u.id,EXISTS(SELECT 1 FROM public.role_assignment r WHERE r.app_user_id=u.id AND r.tenant_id=u.tenant_id AND r.role::text IN ('employee','manager','hr_admin','super_admin')
      AND (r.company_id IS NULL OR r.company_id=subject.company_id OR app.is_company_descendant(subject.company_id,r.company_id))) covers
    FROM public.app_user u WHERE u.person_id=manager.person_id AND u.tenant_id=subject.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
     AND EXISTS(SELECT 1 FROM public.role_assignment r WHERE r.app_user_id=u.id AND r.tenant_id=u.tenant_id AND r.role::text IN ('employee','manager','hr_admin','super_admin'))) x;
   IF covering>1 THEN failure:='multiple_logins';
   ELSIF covering=0 AND anywhere>0 THEN failure:='login_wrong_company';
   ELSIF covering=0 THEN failure:='no_login';
   ELSIF covering_id=ANY(seen_users) THEN failure:='duplicate_login';
   ELSIF manager_name IS NULL THEN failure:='missing_person'; END IF;
  END IF;
  RETURN QUERY SELECT n,manager.id,manager.employee_code,manager_name,failure,covering,anywhere;
  IF failure IS NOT NULL THEN RETURN; END IF;
  seen_employments:=seen_employments||manager.id; seen_people:=seen_people||manager.person_id; seen_users:=seen_users||covering_id; cursor_id:=manager.id;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION app.attendance_workflow_superior_diagnostic(uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.attendance_workflow_superior_diagnostic(uuid,integer) TO ai_hr_app;
