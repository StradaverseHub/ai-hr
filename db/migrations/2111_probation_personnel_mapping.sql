-- Source-only, dormant mapping. No tenant is switched and no retained fact, rule or signed file is updated.
CREATE TABLE public.probation_organisation_mapping(
 tenant_id uuid PRIMARY KEY REFERENCES tenant(id),mapping text NOT NULL CHECK(mapping='personnel-v2'),
 reviewed_inventory_digest text NOT NULL CHECK(reviewed_inventory_digest ~ '^[0-9a-f]{64}$'),
 approved_by uuid NOT NULL REFERENCES app_user(id),approved_at timestamptz NOT NULL,
 CHECK(approved_at IS NOT NULL)
);
ALTER TABLE public.probation_organisation_mapping ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.probation_organisation_mapping FORCE ROW LEVEL SECURITY;
CREATE POLICY probation_organisation_mapping_owner ON public.probation_organisation_mapping FOR ALL
 USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
REVOKE ALL ON public.probation_organisation_mapping FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.probation_organisation_mapping() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce((SELECT mapping FROM public.probation_organisation_mapping WHERE tenant_id=app.current_tenant_id()),'legacy-v1');
$$;
REVOKE ALL ON FUNCTION app.probation_organisation_mapping() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.probation_organisation_mapping() TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.probation_organisation_facts(p_facts jsonb,p_definition jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE current_mapping text:=coalesce(p_facts->>'organisationMapping','legacy-v1');target text:=coalesce(p_definition->>'organisationMapping','legacy-v1');old jsonb;
BEGIN
 IF target NOT IN('legacy-v1','personnel-v2') OR current_mapping NOT IN('legacy-v1','personnel-v2') THEN RAISE EXCEPTION 'Unknown Probation organisation mapping';END IF;
 IF target=current_mapping THEN RETURN p_facts;END IF;
 IF target='personnel-v2' THEN
  RETURN p_facts||jsonb_build_object('organisationMapping',target,'organisationLegacy',jsonb_build_object('businessGroupId',p_facts->'businessGroupId','businessGroup',p_facts->'businessGroup','businessUnitId',p_facts->'businessUnitId','businessUnit',p_facts->'businessUnit'),
   'businessGroupId',p_facts->'businessUnitId','businessGroup',p_facts->'businessUnit','businessUnitId',p_facts->'companyId','businessUnit',p_facts->'companyName');
 END IF;
 old:=p_facts->'organisationLegacy';
 RETURN p_facts||jsonb_build_object('organisationMapping',target,'businessGroupId',old->'businessGroupId','businessGroup',old->'businessGroup',
  'businessUnitId',coalesce(old->'businessUnitId',p_facts->'businessGroupId'),'businessUnit',coalesce(old->'businessUnit',p_facts->'businessGroup'));
END $$;
REVOKE ALL ON FUNCTION app.probation_organisation_facts(jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.probation_organisation_facts(jsonb,jsonb) TO ai_hr_app;
--> statement-breakpoint
ALTER FUNCTION app.probation_personnel_source_unchecked(uuid) RENAME TO probation_personnel_source_legacy_organisation;
REVOKE ALL ON FUNCTION app.probation_personnel_source_legacy_organisation(uuid) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.probation_personnel_source_unchecked(p_employment uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.probation_organisation_facts(app.probation_personnel_source_legacy_organisation(p_employment),jsonb_build_object('organisationMapping',app.probation_organisation_mapping()));
$$;
REVOKE ALL ON FUNCTION app.probation_personnel_source_unchecked(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Validate identity kinds in new definition versions; never cast a company UUID to a PM Business Unit.
CREATE FUNCTION app.probation_assert_organisation_scope(p_scope jsonb,p_mapping text,p_company uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE k text;v text;is_company boolean;
BEGIN
 FOR k,v IN SELECT key,value FROM jsonb_each_text(p_scope) WHERE key IN('businessGroupId','businessUnitId') LOOP
  IF v IS NULL THEN CONTINUE;END IF;
  is_company:=(p_mapping='personnel-v2' AND k='businessUnitId') OR (p_mapping='legacy-v1' AND k='businessGroupId');
  IF is_company THEN
   IF NOT EXISTS(SELECT 1 FROM company WHERE tenant_id=app.current_tenant_id() AND id::text=v AND (p_mapping='legacy-v1' OR id=p_company)) THEN RAISE EXCEPTION 'Invalid company identity in Probation scope';END IF;
  ELSE
   IF NOT EXISTS(SELECT 1 FROM business_unit WHERE tenant_id=app.current_tenant_id() AND id::text=v AND (p_mapping='legacy-v1' OR company_id=p_company)) THEN RAISE EXCEPTION 'Invalid Personnel Business Unit identity in Probation scope';END IF;
  END IF;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION app.probation_assert_organisation_scope(jsonb,text,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
ALTER FUNCTION app.probation_config_write(uuid,text,jsonb,boolean,integer) RENAME TO probation_config_write_legacy_organisation;
REVOKE ALL ON FUNCTION app.probation_config_write_legacy_organisation(uuid,text,jsonb,boolean,integer) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.probation_config_write(p_company uuid,p_kind text,p_data jsonb,p_publish boolean,p_expected integer) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE prior text;m text;rule jsonb;
BEGIN
 PERFORM app.probation_write_lock();
 IF p_kind IN('settings','route') THEN
  IF p_expected>0 THEN SELECT coalesce(data->>'organisationMapping','legacy-v1') INTO prior FROM probation_configuration WHERE tenant_id=app.current_tenant_id() AND company_id=p_company AND kind=p_kind AND version=p_expected;END IF;
  m:=coalesce(p_data->>'organisationMapping',prior,app.probation_organisation_mapping());
  IF m NOT IN('legacy-v1','personnel-v2') OR p_publish AND m='personnel-v2' AND app.probation_organisation_mapping()<>'personnel-v2' THEN RAISE EXCEPTION 'Review the organisation mapping inventory before publishing replacement scopes';END IF;
  FOR rule IN SELECT value FROM jsonb_array_elements(coalesce(p_data->CASE WHEN p_kind='settings' THEN 'overrides' ELSE 'rules' END,'[]')) LOOP PERFORM app.probation_assert_organisation_scope(rule,m,p_company);END LOOP;
  p_data:=p_data||jsonb_build_object('organisationMapping',m);
 END IF;
 RETURN app.probation_config_write_legacy_organisation(p_company,p_kind,p_data,p_publish,p_expected);
END $$;
REVOKE ALL ON FUNCTION app.probation_config_write(uuid,text,jsonb,boolean,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.probation_config_write(uuid,text,jsonb,boolean,integer) TO ai_hr_app;
--> statement-breakpoint
ALTER FUNCTION app.probation_definition_save(uuid,text,text,jsonb,boolean,integer) RENAME TO probation_definition_save_legacy_organisation;
REVOKE ALL ON FUNCTION app.probation_definition_save_legacy_organisation(uuid,text,text,jsonb,boolean,integer) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.probation_definition_save(p_company uuid,p_key text,p_kind text,p_data jsonb,p_publish boolean,p_expected integer) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE prior text;m text;k text;v jsonb;item jsonb;
BEGIN
 PERFORM app.probation_write_lock();
 IF p_expected>0 THEN SELECT coalesce(data->>'organisationMapping','legacy-v1') INTO prior FROM probation_builder_definition WHERE tenant_id=app.current_tenant_id() AND company_id=p_company AND kind=p_kind AND definition_key=p_key AND version=p_expected;END IF;
 m:=coalesce(p_data->>'organisationMapping',prior,app.probation_organisation_mapping());
 IF m NOT IN('legacy-v1','personnel-v2') OR p_publish AND m='personnel-v2' AND app.probation_organisation_mapping()<>'personnel-v2' THEN RAISE EXCEPTION 'Review the organisation mapping inventory before publishing replacement scopes';END IF;
 IF p_kind='workflow' THEN PERFORM app.probation_assert_organisation_scope(coalesce(p_data->'conditions','{}'),m,p_company);
 ELSIF p_kind='template' THEN
  FOR k,v IN SELECT key,value FROM jsonb_each(coalesce(p_data->'rules','{}')) WHERE key IN('businessGroup','businessUnit') LOOP
   FOR item IN SELECT value FROM jsonb_array_elements(v) LOOP PERFORM app.probation_assert_organisation_scope(jsonb_build_object(k||'Id',item),m,p_company);END LOOP;
  END LOOP;
 END IF;
 RETURN app.probation_definition_save_legacy_organisation(p_company,p_key,p_kind,p_data||jsonb_build_object('organisationMapping',m),p_publish,p_expected);
END $$;
REVOKE ALL ON FUNCTION app.probation_definition_save(uuid,text,text,jsonb,boolean,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.probation_definition_save(uuid,text,text,jsonb,boolean,integer) TO ai_hr_app;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.probation_effective_settings(p_settings jsonb,p_facts jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p_settings||coalesce((SELECT jsonb_build_object('kpiGate',r->>'kpiGate') FROM jsonb_array_elements(coalesce(p_settings->'overrides','[]')) WITH ORDINALITY rules(r,n) WHERE (r->>'businessGroupId' IS NULL OR r->>'businessGroupId'=(app.probation_organisation_facts(p_facts,p_settings))->>'businessGroupId') AND (r->>'businessUnitId' IS NULL OR r->>'businessUnitId'=(app.probation_organisation_facts(p_facts,p_settings))->>'businessUnitId') AND (r->>'grade' IS NULL OR r->>'grade'=p_facts->>'grade') AND (r->>'months' IS NULL OR (r->>'months')::integer=coalesce((p_facts->>'probationMonths')::integer,(SELECT n FROM generate_series(1,120) n WHERE ((p_facts->>'startOn')::date+(n::text||' months')::interval-interval '1 day')::date=coalesce((p_facts->>'originalEndOn')::date,(p_facts->>'endOn')::date) LIMIT 1),CASE WHEN p_facts->>'unknownPeriod'='true' THEN CASE WHEN p_facts->>'grade'='H' THEN 3 ELSE (p_settings->>'defaultMonths')::integer END ELSE NULL END)) ORDER BY num_nonnulls(r->>'businessGroupId',r->>'businessUnitId',r->>'grade',r->>'months') DESC,n DESC LIMIT 1),'{}'::jsonb);
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.probation_prepare_signing(p_part uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p probation_part;c probation_case;kpis jsonb;source jsonb;policy jsonb;scoped_route jsonb;manager jsonb;
BEGIN
 PERFORM app.probation_write_lock();
 SELECT * INTO p FROM probation_part WHERE id=p_part AND tenant_id=app.current_tenant_id() FOR UPDATE;IF NOT FOUND THEN RAISE EXCEPTION 'Part unavailable';END IF;SELECT * INTO c FROM probation_case WHERE id=p.case_id AND tenant_id=p.tenant_id;
 IF app.probation_part_role(p.id,'lm') IS NOT TRUE OR p.data->>'managerSubmittedAt' IS NOT NULL OR app.probation_submission_ready(p.id,'lm') IS NOT TRUE THEN RAISE EXCEPTION 'Only the ready current manager submission may freeze content';END IF;
 PERFORM app.probation_assert_case_runtime(c.id);
 IF p.data?'signingFacts' THEN RETURN;END IF;
 source:=app.probation_personnel_source(c.employment_id);IF source->>'startOn' IS DISTINCT FROM c.data->>'startOn' OR source->>'endOn' IS NOT NULL AND source->>'endOn' IS DISTINCT FROM c.data->>'endOn' THEN RAISE EXCEPTION 'Reconcile changed canonical Personnel dates before this submission';END IF;
 IF coalesce(p.data->>'routeOverride','false')<>'true' THEN
 SELECT data INTO policy FROM probation_configuration WHERE id=c.route_id AND tenant_id=c.tenant_id;SELECT data INTO manager FROM probation_rater_draft WHERE part_id=p.id AND rater='lm' AND tenant_id=p.tenant_id;
 SELECT r->'route' INTO scoped_route FROM jsonb_array_elements(coalesce(policy->'rules','[]')) WITH ORDINALITY rules(r,n) WHERE r->>'part'=p.data->>'type' AND (r->>'businessGroupId' IS NULL OR r->>'businessGroupId'=(app.probation_organisation_facts(source,policy))->>'businessGroupId') AND (r->>'businessUnitId' IS NULL OR r->>'businessUnitId'=(app.probation_organisation_facts(source,policy))->>'businessUnitId') AND (r->>'grade' IS NULL OR r->>'grade'=c.data->>'gradeAtStart') AND (r->>'outcome' IS NULL OR r->>'outcome'=manager->>'outcome') ORDER BY num_nonnulls(r->>'businessGroupId',r->>'businessUnitId',r->>'grade',r->>'outcome') DESC,n DESC LIMIT 1;
 UPDATE probation_part SET data=jsonb_set(data,'{route}',coalesce(scoped_route,policy->'parts'->(p.data->>'type'))) WHERE id=p.id;END IF;
 SELECT d.data->'kpis' INTO kpis FROM probation_part k JOIN probation_rater_draft d ON d.part_id=k.id AND d.tenant_id=k.tenant_id AND d.rater='lm' WHERE k.case_id=c.id AND k.tenant_id=c.tenant_id AND k.data->>'type'='1' AND k.data->>'state' IN('locked','completed_offline') ORDER BY k.created_at DESC LIMIT 1;
 UPDATE probation_part SET data=data||jsonb_build_object('signingFacts',source,'signingPeriod',jsonb_build_object('startOn',c.data->>'startOn','endOn',c.data->>'endOn','gradeAtStart',c.data->>'gradeAtStart'),'signingKpis',coalesce(kpis,'[]')) WHERE id=p.id;
 PERFORM app.probation_audit(c.id,p.id,'content_frozen');
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.probation_workflow_run(p_case uuid,p_part uuid,p_workflow uuid,p_expected integer,p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c probation_case;p probation_part;w probation_builder_definition;s jsonb;v_id uuid;first_id uuid;f jsonb;plan jsonb;message jsonb;
BEGIN
 PERFORM app.probation_write_lock();
 SELECT * INTO c FROM probation_case WHERE id=p_case AND tenant_id=app.current_tenant_id();
 IF NOT FOUND OR NOT(app.probation_storage_runner() OR app.probation_role(c.employment_id,'gbs') OR app.probation_role(c.employment_id,'pbp')) OR length(btrim(coalesce(p_reason,'')))<3 THEN RAISE EXCEPTION 'Scoped workflow run authority and reason required';END IF;
 PERFORM app.probation_assert_case_runtime(c.id);
 SELECT * INTO w FROM probation_builder_definition WHERE id=p_workflow AND tenant_id=c.tenant_id AND company_id=c.company_id AND kind='workflow' AND state='published' AND c.data->'workflowIds'?id::text;
 IF NOT FOUND THEN RAISE EXCEPTION 'Use this case pinned published workflow';END IF;
 IF p_part IS NOT NULL THEN SELECT * INTO p FROM probation_part WHERE id=p_part AND case_id=c.id AND tenant_id=c.tenant_id;IF NOT FOUND OR p.revision IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'Workflow source changed';END IF;
 ELSIF c.revision IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'Workflow source changed';END IF;
 f:=app.probation_organisation_facts(c.data->'facts',w.data);
 IF coalesce(w.data->'conditions'->>'businessGroupId',f->>'businessGroupId') IS DISTINCT FROM f->>'businessGroupId' OR coalesce(w.data->'conditions'->>'businessUnitId',f->>'businessUnitId') IS DISTINCT FROM f->>'businessUnitId' OR coalesce(w.data->'conditions'->>'departmentId',f->>'departmentId') IS DISTINCT FROM f->>'departmentId' OR coalesce(w.data->'conditions'->>'grade',c.data->>'gradeAtStart') IS DISTINCT FROM c.data->>'gradeAtStart' OR w.data->'conditions'?'part' AND w.data->'conditions'->>'part' IS DISTINCT FROM p.data->>'type' THEN RETURN NULL;END IF;
 plan:=app.probation_workflow_plan(c.id,p.id,w.data);IF plan->>'matches' IS DISTINCT FROM 'true' THEN RETURN NULL;END IF;IF plan->>'ready' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Workflow source is held: %',coalesce(plan->>'holdReason','The current source is not ready');END IF;
 FOR s IN SELECT value FROM jsonb_array_elements(w.data->'steps') LOOP
  IF s->>'type'<>'notify' THEN RAISE EXCEPTION 'Unsupported probation workflow operation';END IF;
  SELECT item INTO message FROM jsonb_array_elements(plan->'messages') items(item) WHERE item->>'id'=s->>'id';IF coalesce(jsonb_array_length(message->'recipients'),0)=0 THEN CONTINUE;END IF;
  v_id:=app.probation_enqueue(c.id,p.id,w.data->'trigger'->>'event',(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date,message->'roles','probation-workflow:'||w.id::text||':'||c.id::text||':'||coalesce(p.id::text,'case')||':'||(s->>'id')||':'||(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date::text,coalesce(p.revision,c.revision));
  IF v_id IS NOT NULL THEN UPDATE probation_occurrence SET workflow_id=w.id,workflow_step_id=s->>'id',recipient_user_ids=(SELECT jsonb_agg(DISTINCT recipient->'userId') FROM jsonb_array_elements(message->'recipients') recipient) WHERE id=v_id AND tenant_id=c.tenant_id AND workflow_id IS NULL;first_id:=coalesce(first_id,v_id);END IF;
 END LOOP;
 PERFORM app.probation_audit(c.id,p.id,'workflow_run',p_reason);RETURN first_id;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.probation_workflow_plan(p_case uuid,p_part uuid,p_definition jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c probation_case;p probation_part;source jsonb;condition jsonb;event text;ready boolean:=true;hold text;step jsonb;roles jsonb;recipients jsonb;messages jsonb:='[]';words jsonb;k text;value text;subject text;body text;day date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;users jsonb;
BEGIN
 SELECT * INTO c FROM probation_case WHERE id=p_case AND tenant_id=app.current_tenant_id();SELECT * INTO p FROM probation_part WHERE id=p_part AND case_id=c.id AND tenant_id=c.tenant_id;IF c.id IS NULL OR p.id IS NULL THEN RETURN jsonb_build_object('matches',false);END IF;
 IF app.probation_case_company_current(c.id) IS NOT TRUE THEN RETURN jsonb_build_object('matches',true,'ready',false,'holdReason','The employing company changed. This case is historical.','id',p.id,'partId',p.id,'type',p.data->'type','dueOn',p.data->>'dueOn','state',p.data->>'state','messages','[]'::jsonb);END IF;
 source:=app.probation_organisation_facts(app.probation_personnel_source_unchecked(c.employment_id),p_definition);condition:=coalesce(p_definition->'conditions','{}');event:=p_definition->'trigger'->>'event';
 IF condition->>'businessGroupId' IS NOT NULL AND condition->>'businessGroupId' IS DISTINCT FROM source->>'businessGroupId' OR condition->>'businessUnitId' IS NOT NULL AND condition->>'businessUnitId' IS DISTINCT FROM source->>'businessUnitId' OR condition->>'departmentId' IS NOT NULL AND condition->>'departmentId' IS DISTINCT FROM source->>'departmentId' OR condition->>'grade' IS NOT NULL AND condition->>'grade' IS DISTINCT FROM c.data->>'gradeAtStart' OR condition->>'part' IS NOT NULL AND condition->>'part' IS DISTINCT FROM p.data->>'type' OR (event LIKE 'letter\_%') IS DISTINCT FROM (p.data->>'documentKind'='letter') AND coalesce(p.data->>'documentKind','review')<>'review' OR event LIKE 'letter\_%' AND coalesce(p.data->>'documentKind','review')<>'letter' THEN RETURN jsonb_build_object('matches',false);END IF;
 IF source->>'resignationOn' IS NOT NULL OR source->>'terminatedOn' IS NOT NULL OR c.data->>'state' IN('withdrawn','confirmed','not_confirmed') THEN ready:=false;hold:='The source is no longer an active probation case.';
 ELSIF source->>'startOn' IS DISTINCT FROM c.data->>'startOn' OR source->>'endOn' IS NOT NULL AND source->>'endOn' IS DISTINCT FROM c.data->>'endOn' THEN ready:=false;hold:='Canonical Personnel dates require reconciliation.';
 ELSIF NOT EXISTS(SELECT 1 FROM probation_activation a WHERE a.tenant_id=c.tenant_id AND a.company_id=c.company_id AND a.enabled AND a.activation_on<=day) THEN ready:=false;hold:='Runtime is not activated for this company.';
 ELSIF event='kpi_assigned' THEN ready:=p.data->>'type'='1' AND p.data->>'issueOn'=day::text AND p.data->>'state'='issued';
 ELSIF event='kpi_reminder' THEN ready:=p.data->>'type'='1' AND c.data->'milestones'->>'kpiReminderOn'=day::text AND p.data->>'state' NOT IN('not_issued','locked','completed_offline','cancelled');
 ELSIF event='kpi_overdue' THEN ready:=p.data->>'type'='1' AND c.data->'milestones'->>'kpiOverdueOn'=day::text AND p.data->>'state' NOT IN('locked','completed_offline','cancelled');
 ELSIF event='review_issued' THEN ready:=p.data->>'type' IN('2','3') AND p.data->>'issueOn'=day::text AND p.data->>'state'='issued';
 ELSIF event='review_reminder' THEN ready:=p.data->>'type' IN('2','3') AND p.data->>'state' NOT IN('not_issued','locked','completed_offline','cancelled') AND day<=(p.data->>'dueOn')::date AND (day=(p.data->>'dueOn')::date-coalesce((c.data->'config'->>'firstReminderDays')::integer,14) OR day>=(p.data->>'dueOn')::date-coalesce((c.data->'config'->>'dailyReminderDays')::integer,7));
 ELSIF event='review_due' THEN ready:=p.data->>'type' IN('2','3') AND p.data->>'dueOn'=day::text AND p.data->>'state' NOT IN('not_issued','locked','completed_offline','cancelled');
 ELSIF event='approval_pending' THEN ready:=p.data->>'managerSubmittedAt' IS NOT NULL AND p.data->>'state' IN('pending_ack','pending_approval');
 ELSIF event='letter_signing_pending' THEN ready:=p.data->>'documentKind'='letter' AND p.data->>'state'='pending_approval' AND EXISTS(SELECT 1 FROM probation_outcome o WHERE o.letter_part_id=p.id AND o.tenant_id=p.tenant_id AND o.released_at IS NULL);
 ELSIF event='letter_returned' THEN ready:=p.data->>'documentKind'='letter' AND p.data->>'state'='returned';
 ELSIF event='letter_release_pending' THEN ready:=p.data->>'documentKind'='letter' AND app.probation_signatures_complete(p.id) AND EXISTS(SELECT 1 FROM probation_outcome o WHERE o.letter_part_id=p.id AND o.tenant_id=p.tenant_id AND o.released_at IS NULL);
 ELSIF event='letter_released' THEN ready:=p.data->>'documentKind'='letter' AND EXISTS(SELECT 1 FROM probation_outcome o WHERE o.letter_part_id=p.id AND o.tenant_id=p.tenant_id AND (o.released_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date=day);
 ELSE ready:=false;hold:='This event requires an explicitly reviewed batch source.';END IF;
 IF ready IS NOT TRUE AND hold IS NULL THEN hold:='The current date or pending source step does not match this trigger.';END IF;
 words:=jsonb_build_object('employeeName',source->>'employeeName','employeeCode',source->>'employeeCode','companyName',source->>'companyName','part',CASE WHEN p.data->>'documentKind'='letter' THEN 'outcome letter' ELSE p.data->>'type' END,'dueOn',coalesce(p.data->>'dueOn',c.data->>'endOn'),'endOn',c.data->>'endOn');
 FOR step IN SELECT item FROM jsonb_array_elements(coalesce(p_definition->'steps','[]')) items(item) LOOP
 SELECT coalesce(jsonb_agg(r),'[]') INTO roles FROM jsonb_array_elements_text(coalesce(step->'to','[]')) r WHERE r IN('employee','lm','hod','pbp','gbs') AND (event NOT IN('kpi_assigned','kpi_reminder','kpi_overdue','review_issued','review_reminder','review_due','approval_pending','letter_signing_pending') OR EXISTS(SELECT 1 FROM app.probation_pending_parties(p.id) party WHERE party.role=r));
 users:=app.probation_users_for_roles(c.employment_id,roles);
 SELECT coalesce(jsonb_agg(jsonb_build_object('role',r,'userId',u.id,'name',person.full_name) ORDER BY r,person.full_name,u.id),'[]') INTO recipients FROM jsonb_array_elements_text(roles) r JOIN app_user u ON u.tenant_id=c.tenant_id JOIN person person ON person.id=u.person_id AND person.tenant_id=u.tenant_id WHERE (CASE WHEN event IN('kpi_assigned','kpi_reminder','kpi_overdue','review_issued','review_reminder','review_due','approval_pending','letter_signing_pending') THEN EXISTS(SELECT 1 FROM app.probation_pending_parties(p.id) party WHERE party.role=r AND party.user_id=u.id) ELSE users?u.id::text AND (r='gbs' OR app.probation_holders(c.employment_id)->>r=u.id::text) END) AND u.archived_at IS NULL AND NOT app.login_blocked(u.id);
 subject:=step->>'subject';body:=step->>'body';FOR k,value IN SELECT key,coalesce(v,'') FROM jsonb_each_text(words) e(key,v) LOOP subject:=regexp_replace(subject,'[{][{][[:space:]]*'||k||'[[:space:]]*[}][}]','{{'||k||'}}','g');body:=regexp_replace(body,'[{][{][[:space:]]*'||k||'[[:space:]]*[}][}]','{{'||k||'}}','g');subject:=replace(subject,'{{'||k||'}}',value);body:=replace(body,'{{'||k||'}}',value);END LOOP;
 messages:=messages||jsonb_build_array(jsonb_build_object('id',step->>'id','subject',subject,'body',body,'roles',roles,'recipients',recipients,'caseHref','/lifecycle/probation/'||c.id::text||CASE WHEN p.data->>'documentKind'='letter' THEN '/letters/'||p.id::text ELSE '' END));
 END LOOP;
 RETURN jsonb_build_object('matches',true,'ready',coalesce(ready,false),'holdReason',hold,'id',p.id,'partId',p.id,'type',p.data->'type','dueOn',p.data->>'dueOn','state',p.data->>'state','messages',messages);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.probation_letter_template_score(p_outcome uuid,p_template uuid) RETURNS integer LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE o probation_outcome;c probation_case;t probation_builder_definition;source jsonb;key text;rule_values jsonb;actual text;score integer:=0;
BEGIN
 SELECT * INTO o FROM probation_outcome WHERE id=p_outcome AND tenant_id=app.current_tenant_id();SELECT * INTO c FROM probation_case WHERE id=o.case_id AND tenant_id=o.tenant_id;
 SELECT * INTO t FROM probation_builder_definition WHERE id=p_template AND tenant_id=o.tenant_id AND company_id=c.company_id AND kind='template' AND state='published' AND data->>'unfinished'='false' AND data->>'outcome'=o.outcome;
 IF t.id IS NULL OR EXISTS(SELECT 1 FROM probation_builder_definition later WHERE later.tenant_id=t.tenant_id AND later.company_id=t.company_id AND later.kind=t.kind AND later.definition_key=t.definition_key AND later.version>t.version AND later.state IN('published','retired')) THEN RETURN NULL;END IF;
 source:=app.probation_organisation_facts(app.probation_personnel_source(c.employment_id),t.data);
 FOR key,rule_values IN SELECT * FROM jsonb_each(coalesce(t.data->'rules','{}')) LOOP
 IF jsonb_typeof(rule_values)<>'array' OR key NOT IN('businessGroup','businessUnit','company','department','grade','outcome','extensionNumber') THEN RETURN NULL;END IF;IF jsonb_array_length(rule_values)=0 THEN CONTINUE;END IF;
 actual:=CASE key WHEN 'businessGroup' THEN source->>'businessGroupId' WHEN 'businessUnit' THEN source->>'businessUnitId' WHEN 'company' THEN c.company_id::text WHEN 'department' THEN source->>'departmentId' WHEN 'grade' THEN c.data->>'gradeAtStart' WHEN 'outcome' THEN o.outcome WHEN 'extensionNumber' THEN CASE WHEN o.outcome='extend' THEN ((c.data->>'extensionCount')::integer+1)::text ELSE (c.data->>'extensionCount') END END;
 IF (rule_values?actual OR key='grade' AND rule_values?coalesce(source->>'gradeId','')) IS NOT TRUE THEN RETURN NULL;END IF;score:=score+1;
 END LOOP;RETURN score;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.probation_letter_values(p_outcome uuid,p_template uuid,p_subject uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE o probation_outcome;c probation_case;t probation_builder_definition;e employment;a assignment;h jsonb;d document_signing_document;letter document_signing_document;holder uuid;signer_name text;signer_title text;manager_name text;head_name text;partner_name text;months integer;new_end text;result jsonb;subject probation_part;has_signed boolean:=false;
BEGIN
 SELECT * INTO o FROM probation_outcome WHERE id=p_outcome AND tenant_id=app.current_tenant_id();SELECT * INTO c FROM probation_case WHERE id=o.case_id AND tenant_id=o.tenant_id;SELECT * INTO t FROM probation_builder_definition WHERE id=p_template AND tenant_id=c.tenant_id;SELECT * INTO e FROM employment WHERE id=c.employment_id AND tenant_id=c.tenant_id;IF e.id IS NULL OR t.id IS NULL THEN RETURN NULL;END IF;
 SELECT * INTO a FROM assignment WHERE employment_id=e.id AND tenant_id=e.tenant_id AND superseded_at IS NULL AND valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (valid_to IS NULL OR valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) ORDER BY valid_from DESC,id LIMIT 1;h:=app.probation_holders(e.id);
 SELECT * INTO d FROM document_signing_document WHERE tenant_id=c.tenant_id AND subject_type='probation' AND subject_id=o.part_id;
 SELECT action->>'actorName' INTO manager_name FROM jsonb_array_elements(d.data->'actions') action WHERE action->>'role'='lm' AND action->>'action'='signed' AND action->>'contentRevision'=d.data->>'contentRevision' AND action->>'contentHash'=d.data->>'contentHash' LIMIT 1;
 SELECT action->>'actorName' INTO head_name FROM jsonb_array_elements(d.data->'actions') action WHERE action->>'role'='hod' AND action->>'action'='signed' AND action->>'contentRevision'=d.data->>'contentRevision' AND action->>'contentHash'=d.data->>'contentHash' LIMIT 1;
 SELECT action->>'actorName' INTO partner_name FROM jsonb_array_elements(d.data->'actions') action WHERE action->>'role'='pbp' AND action->>'action'='signed' AND action->>'contentRevision'=d.data->>'contentRevision' AND action->>'contentHash'=d.data->>'contentHash' LIMIT 1;
 SELECT (h->>(step->>'role'))::uuid INTO holder FROM jsonb_array_elements(t.data->'route'->'steps') step WHERE step->>'required'='true' AND step->>'role'<>'employee' ORDER BY (step->>'stage')::integer,step->>'id' LIMIT 1;
 IF p_subject IS NOT NULL THEN
  SELECT * INTO subject FROM probation_part WHERE id=p_subject AND tenant_id=c.tenant_id AND case_id=c.id;SELECT * INTO letter FROM document_signing_document WHERE subject_id=p_subject AND subject_type='probation' AND tenant_id=c.tenant_id;
  SELECT (action->>'actorId')::uuid,action->>'actorName' INTO holder,signer_name FROM jsonb_array_elements(letter.data->'actions') action JOIN jsonb_array_elements(letter.data->'route'->'steps') step ON step->>'id'=action->>'stepId' WHERE action->>'role'<>'employee' AND action->>'action'='signed' AND action->>'contentRevision'=letter.data->>'contentRevision' AND action->>'contentHash'=letter.data->>'contentHash' ORDER BY (step->>'stage')::integer,step->>'id' LIMIT 1;
  IF signer_name IS NOT NULL THEN has_signed:=true;signer_title:=subject.data->'letterMerge'->>'signatoryTitle';ELSE SELECT (h->>(step->>'role'))::uuid INTO holder FROM jsonb_array_elements(t.data->'route'->'steps') step WHERE step->>'required'='true' AND step->>'role'<>'employee' ORDER BY (step->>'stage')::integer,step->>'id' LIMIT 1;END IF;
 END IF;
 IF signer_name IS NULL THEN SELECT person.full_name INTO signer_name FROM app_user u JOIN person person ON person.id=u.person_id AND person.tenant_id=u.tenant_id WHERE u.id=holder AND u.tenant_id=c.tenant_id;END IF;
 IF NOT has_signed AND signer_title IS NULL THEN SELECT company->>'signatoryTitle' INTO signer_title FROM lc_v9_config configuration CROSS JOIN LATERAL jsonb_array_elements(coalesce(configuration.data->'companies','[]')) company WHERE configuration.tenant_id=c.tenant_id AND company->>'companyId'=c.company_id::text AND company->>'signatoryUserId'=holder::text LIMIT 1;END IF;
 IF NOT has_signed AND nullif(signer_title,'') IS NULL THEN SELECT position.title INTO signer_title FROM app_user u JOIN employment employment ON employment.person_id=u.person_id AND employment.tenant_id=u.tenant_id JOIN assignment assignment ON assignment.employment_id=employment.id AND assignment.tenant_id=employment.tenant_id AND assignment.superseded_at IS NULL AND assignment.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (assignment.valid_to IS NULL OR assignment.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) JOIN position position ON position.id=assignment.position_id AND position.tenant_id=assignment.tenant_id WHERE u.id=holder AND u.tenant_id=c.tenant_id AND (least(employment.terminated_on,employment.resignation_date,employment.last_working_date) IS NULL OR least(employment.terminated_on,employment.resignation_date,employment.last_working_date)>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) ORDER BY (employment.company_id=c.company_id) DESC,employment.hired_on DESC,employment.id LIMIT 1;END IF;
 SELECT (data->>'extensionMonths')::integer INTO months FROM probation_rater_draft WHERE part_id=o.part_id AND tenant_id=c.tenant_id AND rater='lm';IF o.outcome='extend' AND months IN(3,6) THEN new_end:=((c.data->>'endOn')::date+interval '1 day'+(months::text||' months')::interval-interval '1 day')::date::text;END IF;
 result:=jsonb_build_object('employeeJobTitle',coalesce((SELECT title FROM position WHERE id=a.position_id AND tenant_id=c.tenant_id),''),'employeeGrade',coalesce((SELECT regexp_replace(upper(code),'^(JG|GRADE)[ -]*','','g') FROM job_grade WHERE id=e.grade_id AND tenant_id=e.tenant_id),c.data->>'gradeAtStart'),'businessGroup',coalesce((SELECT bg.legal_name FROM company co JOIN company bg ON bg.id=coalesce(co.parent_company_id,co.id) AND bg.tenant_id=co.tenant_id WHERE co.id=c.company_id AND co.tenant_id=c.tenant_id),''),'businessUnit',coalesce((SELECT name FROM business_unit WHERE id=a.business_unit_id AND tenant_id=c.tenant_id),''),'division',coalesce(e.org_division,''),'department',coalesce((SELECT name FROM department WHERE id=a.department_id AND tenant_id=c.tenant_id),''),'lineManagerName',coalesce(manager_name,(SELECT person.full_name FROM app_user u JOIN person person ON person.id=u.person_id AND person.tenant_id=u.tenant_id WHERE u.id=(h->>'lm')::uuid AND u.tenant_id=c.tenant_id),''),'hodName',coalesce(head_name,(SELECT person.full_name FROM app_user u JOIN person person ON person.id=u.person_id AND person.tenant_id=u.tenant_id WHERE u.id=(h->>'hod')::uuid AND u.tenant_id=c.tenant_id),''),'pbpName',coalesce(partner_name,(SELECT person.full_name FROM app_user u JOIN person person ON person.id=u.person_id AND person.tenant_id=u.tenant_id WHERE u.id=(h->>'pbp')::uuid AND u.tenant_id=c.tenant_id),''),'originalEndOn',coalesce(c.data->>'originalEndOn',c.data->>'endOn'),'reviewPlanMonths',coalesce(c.data->>'planMonths',''),'confirmationEffectiveOn',CASE WHEN o.outcome='confirm' THEN c.data->>'endOn' ELSE '' END,'extensionNewEndOn',coalesce(new_end,''),'extensionCount',coalesce(c.data->>'extensionCount','0'),'maxExtensions',coalesce(c.data->'config'->>'maxExtensions','2'),'signatoryName',coalesce(signer_name,''),'signatoryTitle',coalesce(signer_title,''),'acknowledgedBy','','acknowledgedOn','');IF has_signed OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(letter.data->'actions','[]')) action WHERE action->>'action' IN('signed','acknowledged') AND action->>'contentRevision'=letter.data->>'contentRevision' AND action->>'contentHash'=letter.data->>'contentHash') THEN
 result:=result||jsonb_build_object('businessGroup',coalesce(subject.data->'letterMerge'->'businessGroup',result->'businessGroup'),'businessUnit',coalesce(subject.data->'letterMerge'->'businessUnit',result->'businessUnit'));
 ELSIF t.data->>'organisationMapping'='personnel-v2' THEN
 result:=result||jsonb_build_object('businessGroup',coalesce((SELECT name FROM business_unit WHERE id=a.business_unit_id AND tenant_id=c.tenant_id),''),'businessUnit',coalesce((SELECT legal_name FROM company WHERE id=e.company_id AND tenant_id=c.tenant_id),''));
 END IF;
 RETURN result;
END $$;
