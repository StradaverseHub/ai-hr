-- Extend the existing source-event owner; real signer attribution and outbox processing remain unchanged.
CREATE FUNCTION app.v9_document_route_hr_complete(d jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_typeof(d->'signing')='object' AND NOT app.document_signing_returned(d->'signing')
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(d->'signing'->'route'->'steps') s WHERE s->>'required'='true' AND s->>'role'<>'employee')
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d->'signing'->'route'->'steps') s WHERE s->>'required'='true' AND s->>'role'<>'employee' AND NOT app.document_signing_step_fulfilled(d->'signing',s))
$$;
REVOKE ALL ON FUNCTION app.v9_document_route_hr_complete(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.v9_document_route_hr_complete(jsonb) TO ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.lc_v9_capture_source_runs(p_tenant uuid,p_module text,p_before jsonb,p_after jsonb,p_facts jsonb,p_revision integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE events jsonb:='[]'::jsonb; item_value jsonb; prior jsonb; event jsonb; workflow jsonb; condition jsonb;
 runs jsonb:=coalesce(p_after->'runs','[]'::jsonb); cfg jsonb; matched boolean; actual text; elapsed integer;
 who uuid:=app.current_user_id(); actor_name text; run_id text; today date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
BEGIN
 FOR item_value IN SELECT * FROM jsonb_array_elements(coalesce(p_after->'documents','[]'::jsonb)) LOOP
  SELECT x INTO prior FROM jsonb_array_elements(coalesce(p_before->'documents','[]'::jsonb)) x WHERE x->>'id'=item_value->>'id';
  IF jsonb_typeof(item_value->'signing')='object' THEN
   IF app.v9_document_route_complete(item_value) AND app.v9_document_route_complete(prior) IS NOT TRUE THEN
    events:=events||jsonb_build_array(jsonb_build_object('kind','docSigned','sourceId',item_value->>'id','routed',true,'contentRevision',item_value->'signing'->'contentRevision'));
   END IF;
   IF app.v9_document_route_hr_complete(item_value) AND app.v9_document_route_hr_complete(prior) IS NOT TRUE THEN
    events:=events||jsonb_build_array(jsonb_build_object('kind','hrSigned','sourceId',item_value->>'id','routed',true,'contentRevision',item_value->'signing'->'contentRevision'));
   END IF;
   CONTINUE;
  END IF;
  IF item_value->'employeeSignature' IS NOT NULL AND item_value->'employeeSignature'<>'null'::jsonb AND item_value->'employeeSignature' IS DISTINCT FROM prior->'employeeSignature' THEN
   events:=events||jsonb_build_array(jsonb_build_object('kind','docSigned','sourceId',item_value->>'id'));
  END IF;
  IF item_value->'hrSignature' IS NOT NULL AND item_value->'hrSignature'<>'null'::jsonb AND item_value->'hrSignature' IS DISTINCT FROM prior->'hrSignature' THEN
   events:=events||jsonb_build_array(jsonb_build_object('kind','hrSigned','sourceId',item_value->>'id'));
   IF item_value->>'status' IN ('signed','acknowledged') THEN events:=events||jsonb_build_array(jsonb_build_object('kind','docSigned','sourceId',item_value->>'id')); END IF;
  END IF;
 END LOOP;
 FOR item_value IN SELECT * FROM jsonb_array_elements(coalesce(p_after->'tasks','[]'::jsonb)) LOOP
  IF item_value->>'status'='done' AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p_before->'tasks','[]'::jsonb)) x WHERE x->>'id'=item_value->>'id' AND x->>'status'<>'done') THEN
   events:=events||jsonb_build_array(jsonb_build_object('kind','taskDone','sourceId',item_value->>'id'));
  END IF;
 END LOOP;
 FOR item_value IN SELECT * FROM jsonb_array_elements(coalesce(p_after->'files','[]'::jsonb)) LOOP
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(p_before->'files','[]'::jsonb)) x WHERE x->>'id'=item_value->>'id')
   AND EXISTS(SELECT 1 FROM lc_v9_file f WHERE f.id::text=item_value->>'id' AND f.tenant_id=p_tenant AND (f.case_id::text=p_after->>'id' OR f.onboarding_case_id::text=p_after->>'id')) THEN
   events:=events||jsonb_build_array(jsonb_build_object('kind','fileUploaded','sourceId',item_value->>'id'));
  END IF;
 END LOOP;
 IF jsonb_array_length(events)=0 THEN RETURN p_after; END IF;
 SELECT data INTO cfg FROM lc_v9_config WHERE tenant_id=p_tenant;
 IF cfg IS NULL THEN RETURN p_after; END IF;
 SELECT coalesce(p.full_name,'User') INTO actor_name FROM app_user u LEFT JOIN person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id WHERE u.id=who AND u.tenant_id=p_tenant;
 FOR event IN SELECT * FROM jsonb_array_elements(events) LOOP
  FOR workflow IN SELECT * FROM jsonb_array_elements(cfg->'workflows') w WHERE w->>'module'=p_module AND w->>'status'='published' AND w->'trigger'->>'event'=event->>'kind' LOOP
   run_id:=(workflow->>'id')||CASE WHEN event->>'routed'='true' THEN ':routed:'||(event->>'kind')||':'||(event->>'sourceId')||':'||(event->>'contentRevision') ELSE ':once' END;
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(runs) r WHERE r->>'id'=run_id) THEN CONTINUE; END IF;
   matched:=true;
   FOR condition IN SELECT * FROM jsonb_array_elements(coalesce(workflow->'conditions','[]'::jsonb)) LOOP
    actual:=p_facts->>(condition->>'field');
    IF condition->>'field'='joinWithin' THEN
     IF coalesce(p_facts->>'joinDate','') !~ '^\d{4}-\d{2}-\d{2}$' THEN matched:=false; EXIT; END IF;
     elapsed:=(p_facts->>'joinDate')::date-today;
     matched:=CASE condition->>'op' WHEN 'lt' THEN elapsed<(condition->>'value')::numeric WHEN 'gte' THEN elapsed>=(condition->>'value')::numeric ELSE false END;
    ELSIF condition->>'field'='employmentType' THEN
     actual:=app.lc_v9_employment_class(p_facts);
     matched:=actual IS NOT NULL AND lower(condition->>'value') IN ('permanent','contract','probation') AND CASE condition->>'op' WHEN 'is' THEN actual=lower(condition->>'value') WHEN 'isNot' THEN actual<>lower(condition->>'value') ELSE false END;
    ELSE
     matched:=CASE condition->>'op' WHEN 'is' THEN coalesce(actual,'')=condition->>'value' WHEN 'isNot' THEN coalesce(actual,'')<>condition->>'value' ELSE false END;
    END IF;
    IF NOT matched THEN EXIT; END IF;
   END LOOP;
   IF NOT matched THEN CONTINUE; END IF;
   runs:=runs||jsonb_build_array(jsonb_build_object('id',run_id,'workflowId',workflow->>'id','revision',(cfg->>'revision')::integer,'date',today,'status','waiting','cursor',0,'reason','Source action recorded. Waiting for workflow processing.','at',now(),'definition',workflow,'actor',jsonb_build_object('id',coalesce(who::text,'system'),'name',coalesce(actor_name,'System')),'sourceEvent',event||jsonb_build_object('at',now(),'revision',p_revision)));
  END LOOP;
 END LOOP;
 RETURN jsonb_set(p_after,'{runs}',runs,true);
END;
$$;
