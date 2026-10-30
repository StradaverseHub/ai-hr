-- UNALLOCATED V9 companion draft. Owner-approved category matching; canonical employment types stay intact.
CREATE FUNCTION app.lc_v9_employment_class(p_facts jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE confirmation text; anchor text;
BEGIN
 IF p_facts->>'employmentType'='contract' THEN RETURN 'contract'; END IF;
 IF p_facts->>'employmentType' IS DISTINCT FROM 'full_time' THEN RETURN NULL; END IF;
 confirmation:=coalesce(nullif(p_facts->>'finalConfirmationDate',''),nullif(p_facts->>'confirmationDate',''),nullif(p_facts->>'probationEndDate',''),nullif(p_facts->>'provisionalEndOn',''));
 IF confirmation IS NULL THEN RETURN 'permanent'; END IF;
 anchor:=coalesce(nullif(p_facts->>'noticeDate',''),nullif(p_facts->>'joinDate',''));
 IF anchor IS NULL OR anchor !~ '^\d{4}-\d{2}-\d{2}$' OR confirmation !~ '^\d{4}-\d{2}-\d{2}$' OR to_char(anchor::date,'YYYY-MM-DD')<>anchor OR to_char(confirmation::date,'YYYY-MM-DD')<>confirmation THEN RETURN NULL; END IF;
 RETURN CASE WHEN anchor::date<confirmation::date THEN 'probation' ELSE 'permanent' END;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION app.lc_v9_employment_class(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lc_v9_employment_class(jsonb) TO ai_hr_app;

CREATE OR REPLACE FUNCTION app.lc_v9_capture_source_runs(p_tenant uuid,p_module text,p_before jsonb,p_after jsonb,p_facts jsonb,p_revision integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE events jsonb:='[]'::jsonb; item_value jsonb; prior jsonb; event jsonb; workflow jsonb; condition jsonb;
 runs jsonb:=coalesce(p_after->'runs','[]'::jsonb); cfg jsonb; matched boolean; actual text; elapsed integer;
 who uuid:=app.current_user_id(); actor_name text; run_id text; today date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
BEGIN
 FOR item_value IN SELECT * FROM jsonb_array_elements(coalesce(p_after->'documents','[]'::jsonb)) LOOP
  SELECT x INTO prior FROM jsonb_array_elements(coalesce(p_before->'documents','[]'::jsonb)) x WHERE x->>'id'=item_value->>'id';
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
   run_id:=(workflow->>'id')||':once';
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

-- Confirmation inputs remain HR source metadata, not assigned-task disclosure.
CREATE OR REPLACE FUNCTION app.lc_v9_work(p_id uuid DEFAULT NULL) RETURNS SETOF jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH authorized AS (
 SELECT c.*,app.current_user_id()::text AS uid,
 EXISTS(SELECT 1 FROM app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=c.tenant_id AND u.person_id=e.person_id AND u.archived_at IS NULL) AS own
 FROM lc_v9_case c JOIN employment e ON e.id=c.employment_id AND e.tenant_id=c.tenant_id
 WHERE c.tenant_id=app.current_tenant_id() AND app.current_user_id() IS NOT NULL AND NOT app.login_blocked(app.current_user_id()) AND (p_id IS NULL OR c.id=p_id)
 ), projections AS (
 SELECT a.*,coalesce((SELECT jsonb_agg(t) FROM jsonb_array_elements(a.data->'tasks') t
 WHERE (t->>'assignee'=a.uid OR a.own AND t->>'by'='employee')), '[]'::jsonb) AS tasks,
 coalesce((SELECT jsonb_agg(i) FROM jsonb_array_elements(a.data->'items') i WHERE i->>'assignee'=a.uid),'[]'::jsonb) AS items,
 CASE WHEN a.own THEN coalesce((SELECT jsonb_agg(d) FROM jsonb_array_elements(a.data->'documents') d
 WHERE d->>'status' IN ('sent','opened','completed','signed','acknowledged','countersign')),'[]'::jsonb) ELSE '[]'::jsonb END AS documents
 FROM authorized a
 )
 SELECT jsonb_build_object('id',id,'number',number,'module',module,'revision',revision,'state',data->>'state',
 'facts',(data->'facts')-ARRAY['finalConfirmationDate','confirmationDate','probationEndDate','provisionalEndOn'],'tasks',tasks,'items',items,'documents',documents,'own',own)
 FROM projections WHERE own OR jsonb_array_length(tasks)>0 OR jsonb_array_length(items)>0
$$;
