-- UNALLOCATED V9 companion draft. Capture real source transitions into existing private workflow runs.
-- No employee receives configuration/table access; the existing privileged worker resumes these runs.
CREATE FUNCTION app.lc_v9_capture_source_runs(p_tenant uuid,p_module text,p_before jsonb,p_after jsonb,p_facts jsonb,p_revision integer)
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
REVOKE ALL ON FUNCTION app.lc_v9_capture_source_runs(uuid,text,jsonb,jsonb,jsonb,integer) FROM PUBLIC,ai_hr_app;

CREATE FUNCTION app.lc_v9_case_source_events() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF OLD.data->>'state'='submitted' AND NEW.data->>'state'='submitted' THEN
  NEW.data:=app.lc_v9_capture_source_runs(NEW.tenant_id,NEW.module,OLD.data,NEW.data,NEW.data->'facts',NEW.revision);
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.lc_v9_case_source_events() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER lc_v9_case_source_events BEFORE UPDATE OF data ON lc_v9_case FOR EACH ROW EXECUTE FUNCTION app.lc_v9_case_source_events();

CREATE FUNCTION app.lc_v9_native_private_source_events() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c lc_onboarding_case%ROWTYPE; before_state jsonb:=coalesce(OLD.data->'lifecycleV9','{}'::jsonb); state jsonb:=NEW.data->'lifecycleV9'; retained jsonb; facts jsonb;
BEGIN
 IF state IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO c FROM lc_onboarding_case WHERE id=NEW.case_id AND tenant_id=NEW.tenant_id;
 IF c.data->>'state'<>'submitted' THEN RETURN NEW; END IF;
 -- The native task writer can capture a run before the paired private document write.
 -- Preserve only missing captured runs; normal engine updates of an existing run win.
 FOR retained IN SELECT * FROM jsonb_array_elements(coalesce(before_state->'runs','[]'::jsonb)) r WHERE r ? 'sourceEvent' LOOP
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(state->'runs','[]'::jsonb)) r WHERE r->>'id'=retained->>'id') THEN state:=jsonb_set(state,'{runs}',coalesce(state->'runs','[]'::jsonb)||jsonb_build_array(retained),true); END IF;
 END LOOP;
 facts:=coalesce(c.data->'local','{}'::jsonb)||coalesce(c.data->'source','{}'::jsonb)||jsonb_build_object('caseType','');
 state:=app.lc_v9_capture_source_runs(NEW.tenant_id,'onb',before_state,state||jsonb_build_object('id',c.id),facts,c.revision)-'id';
 NEW.data:=jsonb_set(NEW.data,'{lifecycleV9}',state,true);
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.lc_v9_native_private_source_events() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER lc_v9_native_private_source_events BEFORE UPDATE OF data ON lc_onboarding_private FOR EACH ROW EXECUTE FUNCTION app.lc_v9_native_private_source_events();

CREATE FUNCTION app.lc_v9_native_task_source_events() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE state jsonb; before_private jsonb; facts jsonb;
BEGIN
 IF OLD.data->>'state'<>'submitted' OR NEW.data->>'state'<>'submitted' OR NOT (NEW.data ? 'v9DefinitionRevision' OR EXISTS(SELECT 1 FROM lc_onboarding_private p WHERE p.case_id=NEW.id AND p.tenant_id=NEW.tenant_id AND p.data ? 'lifecycleV9')) OR OLD.data->'tasks' IS NOT DISTINCT FROM NEW.data->'tasks' THEN RETURN NEW; END IF;
 SELECT data INTO before_private FROM lc_onboarding_private WHERE case_id=NEW.id AND tenant_id=NEW.tenant_id FOR UPDATE;
 IF before_private IS NULL THEN RETURN NEW; END IF;
 state:=coalesce(before_private->'lifecycleV9','{}'::jsonb);
 facts:=coalesce(NEW.data->'local','{}'::jsonb)||coalesce(NEW.data->'source','{}'::jsonb)||jsonb_build_object('caseType','');
 state:=app.lc_v9_capture_source_runs(NEW.tenant_id,'onb',state||jsonb_build_object('tasks',OLD.data->'tasks'),state||jsonb_build_object('tasks',NEW.data->'tasks'),facts,NEW.revision)-'tasks';
 IF before_private->'lifecycleV9' IS DISTINCT FROM state THEN
  INSERT INTO lc_onboarding_private_revision(tenant_id,case_id,company_id,revision,data) VALUES(NEW.tenant_id,NEW.id,NEW.company_id,OLD.revision,before_private) ON CONFLICT DO NOTHING;
  UPDATE lc_onboarding_private SET data=jsonb_set(data,'{lifecycleV9}',state,true) WHERE case_id=NEW.id AND tenant_id=NEW.tenant_id;
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.lc_v9_native_task_source_events() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER lc_v9_native_task_source_events AFTER UPDATE OF data ON lc_onboarding_case FOR EACH ROW EXECUTE FUNCTION app.lc_v9_native_task_source_events();
