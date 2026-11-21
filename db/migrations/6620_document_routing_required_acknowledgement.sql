-- Required/optional steps and explicit employee acknowledgement. Existing absent required flags remain true.
-- No saved template, generated document or signing history is rewritten.
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
  IF w->>'kind'='routing' AND coalesce(w->>'routingId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN false;END IF;
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
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.probation_letter_routing_signatures_ok(p_data jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_typeof(p_data->'blocks')='array'
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_data->'routing') s WHERE s->>'action' IN('sign','acknowledge')
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_data->'blocks') b WHERE b->>'type'='signature' AND b->>'role'='step:'||(s->>'id')))
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_data->'blocks') b WHERE b->>'type'='signature'
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_data->'routing') s WHERE s->>'action' IN('sign','acknowledge') AND b->>'role'='step:'||(s->>'id')))
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.probation_letter_freeze_route(p_part uuid,p_route jsonb,p_unresolved jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();p probation_part;c probation_case;h jsonb;s jsonb;r jsonb;expected_role text;cleaned jsonb:='[]'::jsonb;
BEGIN
 PERFORM app.probation_write_lock();
 SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=t FOR UPDATE;
 SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;
 IF p.id IS NULL OR p.data->>'documentKind' IS DISTINCT FROM 'letter' OR jsonb_typeof(p.data->'letterRouting') IS DISTINCT FROM 'array' OR p.data->'letterRoutingPending' IS DISTINCT FROM 'true'::jsonb
  OR EXISTS(SELECT 1 FROM document_signing_document d WHERE d.tenant_id=t AND d.subject_type='probation' AND d.subject_id=p.id)
  OR NOT((app.probation_role(c.employment_id,'pbp') OR app.probation_case_permitted(c.employment_id,'cases.letters')) OR app.probation_role(c.employment_id,'gbs')) THEN RAISE EXCEPTION 'A just-prepared routed letter and its scoped preparer are required';END IF;
 PERFORM app.probation_assert_case_runtime(c.id);
 IF jsonb_typeof(p_route) IS DISTINCT FROM 'object' OR p_route->'version' IS DISTINCT FROM '1'::jsonb OR jsonb_typeof(p_route->'steps') IS DISTINCT FROM 'array'
  OR jsonb_array_length(p_route->'steps')<>jsonb_array_length(p.data->'letterRouting') OR jsonb_typeof(p_unresolved) IS DISTINCT FROM 'array' OR jsonb_array_length(p_unresolved)>30 THEN RAISE EXCEPTION 'The routed letter route does not match its routing';END IF;
 h:=app.probation_holders(c.employment_id);
 FOR s IN SELECT value FROM jsonb_array_elements(p_route->'steps') LOOP
  SELECT value INTO r FROM jsonb_array_elements(p.data->'letterRouting') WHERE value->>'id'=s->>'id';
  IF r IS NULL THEN RAISE EXCEPTION 'The routed letter route does not match its routing';END IF;
  expected_role:=CASE r->'who'->>'kind' WHEN 'employee' THEN 'employee' WHEN 'directSuperior' THEN 'lm' WHEN 'routing' THEN 'routing:'||(r->'who'->>'routingId') WHEN 'group' THEN 'group:'||(r->'who'->>'groupId') ELSE 'people' END;
  IF s->>'role' IS DISTINCT FROM expected_role OR s->>'kind' IS DISTINCT FROM r->>'action' OR s->'stage' IS DISTINCT FROM r->'order' OR s->'required' IS DISTINCT FROM coalesce(r->'required','true'::jsonb)
   OR coalesce(s->'owner','false'::jsonb) IS DISTINCT FROM r->'owner' OR s ? 'coveredStepIds' OR s ? 'coveredByStepId' OR s ? 'representedId'
   OR s ? 'meantFor' AND (jsonb_typeof(s->'meantFor') IS DISTINCT FROM 'string' OR length(s->>'meantFor')>300) THEN RAISE EXCEPTION 'The routed letter route does not match its routing';END IF;
  IF s->>'holderId' IS NOT NULL THEN
   IF NOT EXISTS(SELECT 1 FROM app_user u WHERE u.id::text=s->>'holderId' AND u.tenant_id=t AND u.person_id IS NOT NULL AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) THEN RAISE EXCEPTION 'A routed letter step holder is unavailable';END IF;
   -- 5759: the case's own employee holds only "The employee" step.
   IF r->'who'->>'kind' IS DISTINCT FROM 'employee' THEN
    IF EXISTS(SELECT 1 FROM app_user u JOIN employment e ON e.person_id=u.person_id AND e.tenant_id=u.tenant_id WHERE u.id::text=s->>'holderId' AND u.tenant_id=t AND e.id=c.employment_id) THEN RAISE EXCEPTION 'The employee cannot review or approve their own probation';END IF;
   END IF;
   IF NOT s ? 'meantFor' AND (r->'who'->>'kind'='employee' AND s->>'holderId' IS DISTINCT FROM h->>'employee' OR r->'who'->>'kind'='directSuperior' AND s->>'holderId' IS DISTINCT FROM h->>'lm'
    OR r->'who'->>'kind'='people' AND NOT (r->'who'->'userIds') ? (s->>'holderId')) THEN RAISE EXCEPTION 'A routed letter step names someone its routing does not';END IF;
  END IF;
  cleaned:=cleaned||jsonb_build_array(s-'holderPersonId');
 END LOOP;
 UPDATE probation_part SET data=(data-'letterRoutingPending')||jsonb_build_object('route',jsonb_build_object('version',1,'steps',cleaned),'letterRoutingUnresolved',p_unresolved),revision=revision+1,updated_at=now() WHERE id=p.id;
 IF jsonb_array_length(p_unresolved)>0 THEN
  INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload)
  VALUES(t,'probation',c.id,'probation.letter_routing_fallback',CASE WHEN app.current_user_id() IS NULL THEN 'system'::actor_type ELSE 'user'::actor_type END,app.current_user_id(),c.employment_id,
   jsonb_build_object('caseId',c.id,'partId',p.id,'unresolved',(SELECT jsonb_agg(jsonb_build_object('stepId',x->>'stepId','meantFor',left(coalesce(x->>'meantFor',''),300),'reason',left(coalesce(x->>'reason',''),300),'fallbackGroupId',x->>'fallbackGroupId','holderId',x->>'holderId')) FROM jsonb_array_elements(p_unresolved) x)));
 END IF;
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.document_signing_pending_steps(p_data jsonb) RETURNS SETOF jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 WITH steps AS (
  SELECT s FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_data->'route'->'steps')='array' THEN p_data->'route'->'steps' ELSE '[]'::jsonb END) s
  WHERE NOT app.document_signing_step_fulfilled(p_data,s)
 ), boundary AS (SELECT min((s->>'stage')::integer) AS stage FROM steps WHERE s->>'required'='true')
 SELECT s FROM steps CROSS JOIN boundary
 WHERE NOT app.document_signing_returned(p_data) AND s->>'coveredByStepId' IS NULL AND boundary.stage IS NOT NULL
  AND CASE WHEN s->>'required'='true' THEN (s->>'stage')::integer=boundary.stage
   ELSE jsonb_typeof(p_data->'routing')='object' AND (s->>'stage')::integer<=boundary.stage END
$$;
