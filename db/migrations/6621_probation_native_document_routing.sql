-- A read-only, company-authorized adapter for the actual On/Off Boarding routing registry.
-- Legacy Shared routes and published definitions remain untouched and keep their original resolver.
CREATE FUNCTION app.probation_native_document_routing_references(p_company uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE cfg jsonb;
BEGIN
 IF NOT app.probation_config_admin(p_company) THEN RAISE EXCEPTION 'Probation template administration is required' USING ERRCODE='42501';END IF;
 SELECT data INTO cfg FROM lc_onboarding_config WHERE tenant_id=app.current_tenant_id();
 RETURN jsonb_build_object('routings',coalesce(cfg->'routings','[]'::jsonb),'groups',coalesce(cfg->'groups','[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION app.probation_native_document_routing_references(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.probation_native_document_routing_references(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.probation_letter_native_routing_context(p_part uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE tenant uuid:=app.current_tenant_id();part probation_part;subject_case probation_case;definition probation_builder_definition;holders jsonb;cfg jsonb;source jsonb;placement assignment;employee employment;
BEGIN
 SELECT * INTO part FROM probation_part WHERE id=p_part AND tenant_id=tenant;
 SELECT * INTO subject_case FROM probation_case WHERE id=part.case_id AND tenant_id=tenant;
 SELECT * INTO definition FROM probation_builder_definition WHERE id=(part.data->>'letterTemplateId')::uuid AND tenant_id=tenant AND company_id=subject_case.company_id AND kind='template';
 IF part.id IS NULL OR part.data->>'documentKind' IS DISTINCT FROM 'letter' OR definition.data->>'routingRegistry' IS DISTINCT FROM 'on-off-boarding'
  OR NOT(app.probation_role(subject_case.employment_id,'pbp') OR app.probation_role(subject_case.employment_id,'gbs') OR app.probation_case_permitted(subject_case.employment_id,'cases.letters')) THEN RAISE EXCEPTION 'Scoped native letter preparer required' USING ERRCODE='42501';END IF;
 SELECT data INTO cfg FROM lc_onboarding_config WHERE tenant_id=tenant;
 source:=app.probation_personnel_source_unchecked(subject_case.employment_id);holders:=app.probation_holders(subject_case.employment_id);
 SELECT * INTO placement FROM assignment WHERE employment_id=subject_case.employment_id AND tenant_id=tenant AND superseded_at IS NULL
  AND valid_from<=greatest((now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date,(source->>'startOn')::date)
  AND (valid_to IS NULL OR valid_to>greatest((now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date,(source->>'startOn')::date)) ORDER BY valid_from DESC,id LIMIT 1;
 SELECT * INTO employee FROM employment WHERE id=subject_case.employment_id AND tenant_id=tenant;
 RETURN jsonb_build_object('employeeUserId',holders->>'employee','directSuperiorUserId',holders->>'lm','caseOwnerId',holders->>'pbp',
  'fallbackGroupId',coalesce(nullif(subject_case.data->'config'->>'fallbackGroupId',''),(SELECT data->>'peopleOpsGroup' FROM lc_v9_config WHERE tenant_id=tenant)),
  'facts',jsonb_build_object('businessGroup',placement.business_unit_id,'company',subject_case.company_id,'department',placement.department_id,'jobTitle',placement.position_id),
  'nativeFacts',jsonb_build_object('businessGroup',coalesce(placement.business_unit_id::text,''),'company',subject_case.company_id,'department',coalesce(placement.department_id::text,''),'title',coalesce(placement.position_id::text,''),'grade',coalesce(employee.grade_id::text,''),'employmentType',coalesce(placement.employment_type::text,''),'joinDate',source->>'startOn','finalConfirmationDate',employee.final_confirmation_date,'confirmationDate',employee.confirmation_date,'probationEndDate',employee.probation_end_date,'provisionalEndOn',employee.provisional_end_on),
  'nativeRoutings',coalesce(cfg->'routings','[]'::jsonb),'routings','[]'::jsonb,'groups',coalesce(cfg->'groups','[]'::jsonb),'recent','{}'::jsonb);
END $$;
REVOKE ALL ON FUNCTION app.probation_letter_native_routing_context(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.probation_letter_native_routing_context(uuid) TO ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.probation_native_assignment_facts(p_case uuid, p_groups text[], p_people uuid[]) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid := app.current_tenant_id(); day date := (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date; v_groups jsonb; candidates uuid[]; users jsonb;
BEGIN
  IF app.automation_can_run('probation', p_case) IS NOT TRUE THEN RAISE EXCEPTION 'This workflow runner is not permitted here' USING ERRCODE = '42501'; END IF;
  IF coalesce(cardinality(p_groups), 0) > 100 OR coalesce(cardinality(p_people), 0) > 200 THEN RAISE EXCEPTION 'Invalid assignment request' USING ERRCODE = '22023'; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', g->>'id', 'name', coalesce(nullif(g->>'name', ''), g->>'id'),
      'limit', CASE WHEN jsonb_typeof(g->'limit') = 'number' THEN greatest(floor((g->>'limit')::numeric), 0)::integer ELSE 0 END,
      'members', coalesce((
        SELECT jsonb_agg(u.id ORDER BY m.n) FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(g->'members') = 'array' THEN g->'members' ELSE '[]'::jsonb END) WITH ORDINALITY m(id, n)
        JOIN public.app_user u ON u.id::text = m.id AND u.tenant_id = t AND u.person_id IS NOT NULL AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
        WHERE m.n <= 500), '[]'::jsonb))), '[]'::jsonb)
    INTO v_groups
    FROM public.lc_onboarding_config v CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(v.data->'groups') = 'array' THEN v.data->'groups' ELSE '[]'::jsonb END) g
    WHERE v.tenant_id = t AND g->>'id' = ANY(coalesce(p_groups, '{}'::text[]));
  SELECT coalesce(array_agg(DISTINCT x.id), '{}'::uuid[]) INTO candidates FROM (
    SELECT (m.id)::uuid AS id FROM jsonb_array_elements(v_groups) g CROSS JOIN LATERAL jsonb_array_elements_text(g->'members') m(id)
    UNION ALL
    SELECT u.id FROM public.app_user u WHERE u.id = ANY(coalesce(p_people, '{}'::uuid[])) AND u.tenant_id = t AND u.person_id IS NOT NULL AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) x
    -- 5759: the case's own employee is never eligible for a routed step.
    WHERE NOT EXISTS(SELECT 1 FROM public.probation_case pc JOIN public.employment pe ON pe.id = pc.employment_id AND pe.tenant_id = pc.tenant_id
      JOIN public.app_user pu ON pu.person_id = pe.person_id AND pu.tenant_id = pe.tenant_id WHERE pc.id = p_case AND pc.tenant_id = t AND pu.id = x.id);
  WITH recent AS MATERIALIZED (
    SELECT d.data, d.created_at, p.data->>'state' AS part_state FROM public.document_signing_document d
    JOIN public.probation_part p ON p.id = d.subject_id AND p.tenant_id = d.tenant_id
    WHERE d.tenant_id = t AND d.subject_type = 'probation' ORDER BY d.created_at DESC, d.id DESC LIMIT 2000
  ), held AS MATERIALIZED (
    SELECT st->>'holderId' AS holder, r.created_at,
      r.part_state IN ('pending_ack','pending_approval','returned') AND NOT app.document_signing_step_fulfilled(r.data, st) AS open,
      (st->>'role' LIKE 'routing:%' OR st->>'role' LIKE 'group:%' OR st->>'role' = 'people') AS routed
    FROM recent r CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(r.data->'route'->'steps') = 'array' THEN r.data->'route'->'steps' ELSE '[]'::jsonb END) st
    WHERE st->>'holderId' = ANY(candidates::text[])
  ), away AS MATERIALIZED (
    SELECT DISTINCT u.id FROM public.app_user u
    JOIN public.employment e ON e.person_id = u.person_id AND e.tenant_id = u.tenant_id
    JOIN public.leave_request lr ON lr.employment_id = e.id AND lr.tenant_id = e.tenant_id
    WHERE u.id = ANY(candidates) AND u.tenant_id = t AND (
      EXISTS(SELECT 1 FROM public.leave_request_date ld WHERE ld.leave_request_id = lr.id AND ld.leave_date = day AND ld.status = 'approved')
      OR (lr.status = 'approved' AND day BETWEEN lr.start_date AND lr.end_date AND NOT EXISTS(SELECT 1 FROM public.leave_request_date ld WHERE ld.leave_request_id = lr.id)))
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', c.id,
      'load', (SELECT count(*) FROM held h WHERE h.holder = c.id::text AND h.open),
      'lastAssigned', (SELECT max(h.created_at) FROM held h WHERE h.holder = c.id::text AND h.routed),
      'onLeave', EXISTS(SELECT 1 FROM away a WHERE a.id = c.id)) ORDER BY c.id), '[]'::jsonb)
    INTO users FROM unnest(candidates) c(id);
  RETURN jsonb_build_object('today', day, 'groups', v_groups, 'users', users);
END $$;

REVOKE ALL ON FUNCTION app.probation_native_assignment_facts(uuid,text[],uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.probation_native_assignment_facts(uuid,text[],uuid[]) TO ai_hr_app;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.probation_letter_routing_valid(p_routing jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE s jsonb;w jsonb;ids text[]:='{}';owners integer:=0;signs integer:=0;
BEGIN
 IF p_routing IS NULL OR jsonb_typeof(p_routing) IS DISTINCT FROM 'array' THEN RETURN false;END IF;
 IF jsonb_array_length(p_routing)=0 THEN RETURN true;END IF;
 IF jsonb_array_length(p_routing)>30 THEN RETURN false;END IF;
 FOR s IN SELECT value FROM jsonb_array_elements(p_routing) LOOP
  IF jsonb_typeof(s) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
  IF jsonb_typeof(s->'id') IS DISTINCT FROM 'string' OR length(s->>'id') NOT BETWEEN 1 AND 120 OR (s->>'id')=ANY(ids) THEN RETURN false;END IF;
  ids:=array_append(ids,s->>'id');
  IF jsonb_typeof(s->'order') IS DISTINCT FROM 'number' THEN RETURN false;END IF;
  IF (s->>'order') !~ '^[0-9]+$' THEN RETURN false;END IF;
  IF (s->>'order')::integer NOT BETWEEN 1 AND 30 THEN RETURN false;END IF;
  IF coalesce(s->>'action','') NOT IN('review','approve','sign','acknowledge') OR jsonb_typeof(s->'owner') IS DISTINCT FROM 'boolean' THEN RETURN false;END IF;
  IF s ? 'required' AND jsonb_typeof(s->'required') IS DISTINCT FROM 'boolean' THEN RETURN false;END IF;
  IF s ? 'pick' AND coalesce(s->>'pick','') NOT IN('any','roundRobin') THEN RETURN false;END IF;
  w:=s->'who';
  IF jsonb_typeof(w) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
  IF coalesce(w->>'kind','') NOT IN('routing','group','people','employee','directSuperior') THEN RETURN false;END IF;
  IF w->>'kind'='routing' AND (length(coalesce(w->>'routingId','')) NOT BETWEEN 1 AND 120 OR w->>'routingId' ~ '[[:cntrl:]]') THEN RETURN false;END IF;
  IF w->>'kind'='group' AND length(coalesce(w->>'groupId','')) NOT BETWEEN 1 AND 200 THEN RETURN false;END IF;
  IF w->>'kind'='people' THEN
   IF jsonb_typeof(w->'userIds') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
   IF jsonb_array_length(w->'userIds') NOT BETWEEN 1 AND 50 THEN RETURN false;END IF;
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(w->'userIds') u WHERE jsonb_typeof(u) IS DISTINCT FROM 'string' OR u#>>'{}' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN RETURN false;END IF;
  END IF;
  IF s->'owner'='true'::jsonb THEN owners:=owners+1;END IF;
  IF s->>'action' IN('sign','acknowledge') AND coalesce((s->>'required')::boolean,true) THEN signs:=signs+1;END IF;
 END LOOP;
 RETURN owners<=1 AND signs>=1;
END $$;
