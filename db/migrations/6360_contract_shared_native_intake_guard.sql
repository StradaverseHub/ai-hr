-- First post-retirement approval/health custody remains with the existing native intake owner.
-- The authoritative command guard always reads the canonical source, not a caller-provided revision or role.
CREATE FUNCTION app.contract_shared_native_intake_hold(p_employment uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH source AS MATERIALIZED(SELECT app.contract_source(p_employment) AS data)
 SELECT CASE WHEN custody.verified_at IS NULL THEN 'health_pending' ELSE 'intake_required' END
 FROM source JOIN public.contract_retirement_custody custody ON custody.tenant_id=app.current_tenant_id()
 AND custody.employment_id=p_employment AND custody.company_id::text=source.data->>'companyId'
 AND custody.source_revision=source.data->>'sourceRevision' AND custody.withdrawn_at IS NULL
 ORDER BY custody.captured_at DESC,custody.id LIMIT 1
$$;
REVOKE ALL ON FUNCTION app.contract_shared_native_intake_hold(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- A set-based display projection of that native source hash, over custody candidates only. Commands never trust
-- this display hint: they independently recheck contract_shared_native_intake_hold on the actual subject.
CREATE FUNCTION app.contract_shared_native_intake_holds(p_employments uuid[] DEFAULT NULL) RETURNS TABLE(employment_id uuid,kind text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH clock AS MATERIALIZED(SELECT (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS today),
 candidates AS MATERIALIZED(SELECT e.* FROM public.employment e WHERE e.tenant_id=app.current_tenant_id() AND (p_employments IS NULL OR e.id=ANY(p_employments)) AND EXISTS(SELECT 1 FROM public.contract_retirement_custody custody WHERE custody.tenant_id=e.tenant_id AND custody.employment_id=e.id AND custody.company_id=e.company_id AND custody.withdrawn_at IS NULL)),
 placement AS MATERIALIZED(SELECT DISTINCT ON(a.employment_id) a.* FROM public.assignment a JOIN candidates e ON e.tenant_id=a.tenant_id AND e.id=a.employment_id CROSS JOIN clock WHERE a.superseded_at IS NULL AND a.valid_from<=today AND (a.valid_to IS NULL OR a.valid_to>today) ORDER BY a.employment_id,a.valid_from DESC,a.id),
 managers AS MATERIALIZED(SELECT r.subordinate_employment_id,jsonb_agg(jsonb_build_array(r.id,r.manager_employment_id) ORDER BY r.id) AS facts FROM public.reporting_line r JOIN candidates e ON e.tenant_id=r.tenant_id AND e.id=r.subordinate_employment_id CROSS JOIN clock WHERE r.line_type='administrative' AND r.manager_employment_id<>r.subordinate_employment_id AND r.superseded_at IS NULL AND r.valid_from<=today AND (r.valid_to IS NULL OR r.valid_to>today) GROUP BY r.subordinate_employment_id),
 pay AS MATERIALIZED(SELECT DISTINCT ON(c.employment_id) c.* FROM public.compensation c JOIN candidates e ON e.tenant_id=c.tenant_id AND e.id=c.employment_id CROSS JOIN clock WHERE c.superseded_at IS NULL AND c.valid_from<=greatest(today,e.contract_start_date) AND (c.valid_to IS NULL OR c.valid_to>greatest(today,e.contract_start_date)) ORDER BY c.employment_id,c.valid_from DESC,c.id),
 component AS MATERIALIZED(SELECT e.id AS employment_id,pc.id AS component_id FROM candidates e LEFT JOIN public.contract_configuration cfg ON cfg.tenant_id=e.tenant_id AND cfg.company_id=e.company_id LEFT JOIN public.pay_component pc ON pc.tenant_id=e.tenant_id AND pc.id=(cfg.data->>'allowanceComponentId')::uuid AND pc.kind='allowance' AND pc.archived_at IS NULL AND pc.pending_input_kind IS NULL AND (pc.rule IS NULL OR pc.rule->>'kind'='fixed')),
 allowance AS MATERIALIZED(SELECT DISTINCT ON(x.employment_id) x.* FROM public.employment_pay_component x JOIN candidates e ON e.tenant_id=x.tenant_id AND e.id=x.employment_id JOIN component pc ON pc.employment_id=e.id AND pc.component_id=x.component_id CROSS JOIN clock WHERE x.superseded_at IS NULL AND x.valid_from<=greatest(today,e.contract_start_date) AND (x.valid_to IS NULL OR x.valid_to>=greatest(today,e.contract_start_date)) ORDER BY x.employment_id,x.valid_from DESC,x.id),
 hashes AS MATERIALIZED(SELECT e.id,e.tenant_id,e.company_id,
  encode(sha256(convert_to(jsonb_build_array(e.id,e.company_id,e.contract_start_date,e.contract_end_date,e.terminated_on,e.resignation_date,e.last_working_date,e.blacklisted_at,e.grade_id,p.full_name,co.legal_name,managers.facts,a.id,a.business_unit_id,c.id,c.basic_salary,pc.component_id,fx.id,fx.amount,fx.currency,c.currency,c.pay_mode,c.payment_term,c.rate_amount)::text,'UTF8')),'hex') AS revision
  FROM candidates e JOIN public.person p ON p.tenant_id=e.tenant_id AND p.id=e.person_id JOIN public.company co ON co.tenant_id=e.tenant_id AND co.id=e.company_id LEFT JOIN placement a ON a.employment_id=e.id LEFT JOIN managers ON managers.subordinate_employment_id=e.id LEFT JOIN pay c ON c.employment_id=e.id LEFT JOIN component pc ON pc.employment_id=e.id LEFT JOIN allowance fx ON fx.employment_id=e.id)
 SELECT hashes.id,CASE WHEN custody.verified_at IS NULL THEN 'health_pending' ELSE 'intake_required' END FROM hashes JOIN public.contract_retirement_custody custody ON custody.tenant_id=hashes.tenant_id AND custody.employment_id=hashes.id AND custody.company_id=hashes.company_id AND custody.source_revision=hashes.revision AND custody.withdrawn_at IS NULL
$$;
REVOKE ALL ON FUNCTION app.contract_shared_native_intake_holds(uuid[]) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_decision_current(p_case uuid,p_revision integer) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.contract_shared_case f JOIN public.contract_case c ON c.tenant_id=f.tenant_id AND c.id=f.case_id
 JOIN public.contract_shared_event e ON e.tenant_id=f.tenant_id AND e.case_id=f.case_id AND e.trigger_event='decisionSubmitted' AND e.decision_revision=p_revision
 WHERE f.tenant_id=app.current_tenant_id() AND f.case_id=p_case AND (f.data->'decision'->>'revision')::integer=p_revision
 AND f.data->'period'->>'sourceRevision'=app.contract_shared_period_revision(c.employment_id)
 AND app.contract_case_company_current(c.id) AND c.source_conflict IS NULL
 AND e.actor_person_id=app.contract_binding_person(e.actor_user_id)
 AND app.contract_shared_native_intake_hold(c.employment_id) IS NULL)
$$;
REVOKE ALL ON FUNCTION app.contract_shared_decision_current(uuid,integer) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Admission guards run inside the original command transaction. A refusal rolls back a decision/history write
-- before its event/job is admitted; an exact accepted retry does not insert a new event and remains idempotent.
CREATE FUNCTION app.contract_shared_native_intake_case_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE subject uuid;
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() THEN RAISE EXCEPTION 'Contract tenant context required' USING ERRCODE='42501';END IF;
 SELECT employment_id INTO subject FROM public.contract_case WHERE tenant_id=NEW.tenant_id AND id=NEW.case_id;
 IF app.contract_shared_native_intake_hold(subject) IS NOT NULL THEN RAISE EXCEPTION 'Complete native first post-retirement intake before adopting a generic Contract flow' USING ERRCODE='40001';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_native_intake_case_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER contract_shared_native_intake_case_guard BEFORE INSERT ON public.contract_shared_case FOR EACH ROW EXECUTE FUNCTION app.contract_shared_native_intake_case_guard();
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_native_intake_event_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE subject uuid;
BEGIN
 IF NEW.trigger_event NOT IN('decisionSubmitted','caseOpened') THEN RETURN NEW;END IF;
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() THEN RAISE EXCEPTION 'Contract tenant context required' USING ERRCODE='42501';END IF;
 SELECT employment_id INTO subject FROM public.contract_case WHERE tenant_id=NEW.tenant_id AND id=NEW.case_id;
 IF app.contract_shared_native_intake_hold(subject) IS NOT NULL THEN RAISE EXCEPTION 'Complete native first post-retirement intake before submitting a generic Contract decision' USING ERRCODE='40001';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_native_intake_event_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER contract_shared_native_intake_event_guard BEFORE INSERT ON public.contract_shared_event FOR EACH ROW EXECUTE FUNCTION app.contract_shared_native_intake_event_guard();

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_period_open(p_employment uuid,p_source text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE case_number text;reference_number bigint;e public.employment;existing public.contract_case;new_case uuid:=gen_random_uuid();new_term uuid:=gen_random_uuid();term_version integer;flow jsonb;source jsonb;period text;queued jsonb;actor uuid:=app.current_user_id();
BEGIN
 PERFORM app.access_workforce_write_lock();
 IF app.contract_verified_human(actor) IS NOT TRUE THEN RAISE EXCEPTION 'Verified Contract principal required' USING ERRCODE='42501';END IF;
 SELECT * INTO e FROM public.employment WHERE tenant_id=app.current_tenant_id() AND id=p_employment FOR UPDATE;
 IF e.id IS NULL OR app.contract_shared_permitted('view',e.company_id,NULL,e.id) IS NOT TRUE OR app.contract_shared_permitted('decide',e.company_id,NULL,e.id) IS NOT TRUE THEN RAISE EXCEPTION 'Contract case opening unavailable' USING ERRCODE='42501';END IF;
 IF e.contract_number IS NULL OR e.contract_start_date IS NULL OR e.contract_end_date IS NULL OR e.contract_end_date<e.contract_start_date
 OR e.hired_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date OR e.voided_at IS NOT NULL OR e.blacklisted_at IS NOT NULL
 OR least(e.terminated_on,e.resignation_date,e.last_working_date)<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
 OR NOT EXISTS(SELECT 1 FROM public.company c WHERE c.tenant_id=e.tenant_id AND c.id=e.company_id AND c.archived_at IS NULL)
 OR (SELECT a.employment_type FROM public.assignment a WHERE a.tenant_id=e.tenant_id AND a.employment_id=e.id AND a.superseded_at IS NULL AND a.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (a.valid_to IS NULL OR a.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) ORDER BY a.valid_from DESC,a.id LIMIT 1) IS DISTINCT FROM 'contract'
 THEN RAISE EXCEPTION 'Verify the active fixed-term Personnel period before opening a case' USING ERRCODE='22023';END IF;
 IF app.contract_shared_native_intake_hold(e.id) IS NOT NULL THEN RAISE EXCEPTION 'Complete the native first post-retirement intake before starting a generic Contract period' USING ERRCODE='40001';END IF;
 period:=app.contract_shared_period_revision(e.id);
 IF p_source IS DISTINCT FROM period THEN RAISE EXCEPTION 'Personnel period changed; reload' USING ERRCODE='40001';END IF;
 SELECT * INTO existing FROM public.contract_case c WHERE c.tenant_id=e.tenant_id AND c.employment_id=e.id AND c.company_id=e.company_id
 AND c.data->'term'->>'startOn'=e.contract_start_date::text AND c.data->'term'->>'endOn'=e.contract_end_date::text ORDER BY c.created_at DESC,c.id LIMIT 1 FOR UPDATE;
 IF existing.id IS NOT NULL THEN
  IF existing.data->'sourceSnapshot'->>'personId' IS NOT NULL AND existing.data->'sourceSnapshot'->>'personId' IS DISTINCT FROM e.person_id::text
   OR EXISTS(SELECT 1 FROM public.contract_shared_case f WHERE f.tenant_id=e.tenant_id AND f.case_id=existing.id AND f.data->'period'->>'sourceRevision' IS DISTINCT FROM period)
  THEN RAISE EXCEPTION 'The existing period source changed; reconcile it before continuing' USING ERRCODE='40001';END IF;
  -- Opening never adopts, rewrites or restarts a legacy case. Its pinned WIP remains on the legacy route.
  RETURN jsonb_build_object('caseId',existing.id,'legacy',NOT EXISTS(SELECT 1 FROM public.contract_shared_case f WHERE f.tenant_id=e.tenant_id AND f.case_id=existing.id));
 END IF;
 -- Never bypass unfinished work for a prior period by manufacturing a second active case.
 IF EXISTS(SELECT 1 FROM public.contract_case c LEFT JOIN public.contract_shared_case f ON f.tenant_id=c.tenant_id AND f.case_id=c.id WHERE c.tenant_id=e.tenant_id AND c.employment_id=e.id AND c.company_id=e.company_id
  AND (f.case_id IS NULL AND c.data->>'state' NOT IN('renewed','handed_off','cancelled') OR f.case_id IS NOT NULL AND f.data->>'stage' NOT IN('renewed','converted','offboarding','superseded','pay')))
 THEN RAISE EXCEPTION 'Finish or reconcile the prior Contract case before opening the new Personnel period' USING ERRCODE='40001';END IF;
 source:=app.contract_source(e.id);
 SELECT coalesce(max(version),0)+1 INTO term_version FROM public.contract_term WHERE tenant_id=e.tenant_id AND employment_id=e.id;
 INSERT INTO public.contract_term(id,tenant_id,company_id,employment_id,version,kind,start_on,end_on,source_revision)
 VALUES(new_term,e.tenant_id,e.company_id,e.id,term_version,'fixed_term',e.contract_start_date,e.contract_end_date,period);
 INSERT INTO public.tenant_counter(tenant_id,kind,value) VALUES(e.tenant_id,'contract-'||to_char(now() AT TIME ZONE 'Asia/Kuala_Lumpur','YYYY'),1)
 ON CONFLICT(tenant_id,kind) DO UPDATE SET value=tenant_counter.value+1 RETURNING value INTO reference_number;
 case_number:='CT-'||to_char(now() AT TIME ZONE 'Asia/Kuala_Lumpur','YYYY')||'-'||lpad(reference_number::text,greatest(4,length(reference_number::text)),'0');
 INSERT INTO public.contract_case(id,tenant_id,company_id,employment_id,term_id,number,revision,data)
 VALUES(new_case,e.tenant_id,e.company_id,e.id,new_term,case_number,1,
  jsonb_build_object('id',new_case,'number',case_number,'revision',1,'state','upcoming','term',jsonb_build_object('id',new_term,'kind','fixed_term','startOn',e.contract_start_date,'endOn',e.contract_end_date,'sourceRevision',period),'sourceSnapshot',source,'decision',NULL,'decisionDraft',NULL));
 flow:=jsonb_build_object('version',2,'revision',1,'stage','open','period',jsonb_build_object('id',new_term,'startOn',e.contract_start_date,'endOn',e.contract_end_date,'number',e.contract_number::text,'sourceRevision',period),
  'decision',NULL,'decisionHistory','[]'::jsonb,'flags','[]'::jsonb,'lastActivityAt',now(),'posting',NULL,'payConfirmation',NULL,'offboardingId',NULL,'declined',NULL);
 INSERT INTO public.contract_shared_case(tenant_id,case_id,revision,data) VALUES(e.tenant_id,new_case,1,flow);
 PERFORM app.contract_audit(new_case,'shared.opened',jsonb_build_object('periodId',new_term,'contractNumber',e.contract_number));
 queued:=app.contract_shared_enqueue_event(new_case,'caseOpened','period:'||new_term::text,jsonb_build_object('period',flow->'period'));
 RETURN queued||jsonb_build_object('caseId',new_case,'legacy',false);
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_period_open(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_period_open(uuid,text) TO ai_hr_app;


--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_period_context(p_employment uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE e public.employment;source jsonb;rights text[];period text;existing uuid;old_period text;old_start text;old_end text;issue text;intake_hold text;
BEGIN
 SELECT * INTO e FROM public.employment WHERE tenant_id=app.current_tenant_id() AND id=p_employment;
 IF e.id IS NULL OR app.contract_shared_permitted('view',e.company_id,NULL,e.id) IS NOT TRUE
 OR e.voided_at IS NOT NULL OR e.blacklisted_at IS NOT NULL OR e.hired_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
 OR least(e.terminated_on,e.resignation_date,e.last_working_date)<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
 OR NOT EXISTS(SELECT 1 FROM public.company c WHERE c.tenant_id=e.tenant_id AND c.id=e.company_id AND c.archived_at IS NULL)
 THEN RETURN NULL;END IF;
 source:=app.contract_source(e.id);intake_hold:=app.contract_shared_native_intake_hold(e.id);
 source:=source||jsonb_build_object('nativeIntakeRequired',intake_hold IS NOT NULL);
 IF source->>'employmentType' IS DISTINCT FROM 'contract' THEN RETURN NULL;END IF;
 SELECT coalesce(array_agg(permission),'{}'::text[]) INTO rights FROM unnest(ARRAY['view','seePay','decide','decline','manual','workflows','templates','groups','access']::text[]) permission WHERE app.contract_shared_permitted(permission,e.company_id,NULL,e.id);
 period:=app.contract_shared_period_revision(e.id);
 source:=source||jsonb_build_object('contractNumber',e.contract_number,'periodRevision',period,'businessUnitId',source->>'businessGroupId','jobTitle',source->>'designation');
 source:=source||coalesce((SELECT jsonb_build_object('businessGroupId',bg.id,'businessGroup',bg.legal_name) FROM public.company c JOIN public.company bg ON bg.tenant_id=c.tenant_id AND bg.id=coalesce(c.parent_company_id,c.id) WHERE c.tenant_id=e.tenant_id AND c.id=e.company_id),'{}'::jsonb);
 source:=source||coalesce((SELECT jsonb_build_object('departmentId',a.department_id) FROM public.assignment a WHERE a.tenant_id=e.tenant_id AND a.employment_id=e.id AND a.superseded_at IS NULL AND a.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (a.valid_to IS NULL OR a.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) ORDER BY a.valid_from DESC,a.id LIMIT 1),'{}'::jsonb);
 IF NOT 'seePay'=ANY(rights) THEN source:=source-ARRAY['salaryCents','allowanceCents','allowanceComponentId','fixedAllowanceId','compensationId'];END IF;
 SELECT c.id,f.data->'period'->>'sourceRevision',c.data->'term'->>'startOn',c.data->'term'->>'endOn' INTO existing,old_period,old_start,old_end FROM public.contract_case c LEFT JOIN public.contract_shared_case f ON f.tenant_id=c.tenant_id AND f.case_id=c.id
 WHERE c.tenant_id=e.tenant_id AND c.employment_id=e.id AND c.company_id=e.company_id
 AND (c.data->'term'->>'startOn'=e.contract_start_date::text AND c.data->'term'->>'endOn'=e.contract_end_date::text
 OR f.case_id IS NOT NULL AND f.data->>'stage' NOT IN('renewed','converted','offboarding','superseded','pay')
 OR f.case_id IS NULL AND c.data->>'state' NOT IN('renewed','handed_off','cancelled'))
 ORDER BY (c.data->'term'->>'startOn'=e.contract_start_date::text AND c.data->'term'->>'endOn'=e.contract_end_date::text) DESC NULLS LAST,c.created_at DESC,c.id LIMIT 1;
 issue:=CASE WHEN intake_hold IS NOT NULL THEN 'native_intake_required' WHEN e.contract_number IS NULL OR e.contract_start_date IS NULL OR e.contract_end_date IS NULL OR e.contract_end_date<e.contract_start_date THEN 'verify_period'
  WHEN existing IS NOT NULL AND (old_start IS DISTINCT FROM e.contract_start_date::text OR old_end IS DISTINCT FROM e.contract_end_date::text OR old_period IS NOT NULL AND old_period IS DISTINCT FROM period) THEN 'period_changed' END;
 RETURN jsonb_build_object('employmentId',e.id,'companyId',e.company_id,'source',source,'permissions',to_jsonb(rights),'sourceRevision',period,'sourceIssue',issue,'existingCaseId',existing,'canOpen',existing IS NULL AND issue IS NULL AND 'decide'=ANY(rights));
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_period_context(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_period_context(uuid) TO ai_hr_app;


--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_context(p_case uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c public.contract_case;s public.contract_shared_case;source jsonb;rights text[];f jsonb;is_current boolean;
BEGIN
 SELECT * INTO c FROM public.contract_case WHERE tenant_id=app.current_tenant_id() AND id=p_case;
 IF c.id IS NULL OR app.contract_shared_case_permitted(c.id,'view') IS NOT TRUE THEN RETURN NULL;END IF;
 SELECT coalesce(array_agg(permission),'{}'::text[]) INTO rights FROM unnest(ARRAY['view','seePay','decide','decline','manual','workflows','templates','groups','access']::text[]) permission
 WHERE app.contract_shared_case_permitted(c.id,permission);
 SELECT * INTO s FROM public.contract_shared_case WHERE tenant_id=c.tenant_id AND case_id=c.id;
 f:=s.data;is_current:=app.contract_case_company_current(c.id);
 source:=CASE WHEN is_current THEN app.contract_source(c.employment_id) ELSE c.data->'sourceSnapshot' END;
 IF source IS NULL THEN RETURN NULL;END IF;
 IF is_current THEN source:=source||jsonb_build_object('nativeIntakeRequired',app.contract_shared_native_intake_hold(c.employment_id) IS NOT NULL);END IF;
 source:=source||jsonb_build_object('contractNumber',CASE WHEN is_current THEN (SELECT e.contract_number FROM public.employment e WHERE e.tenant_id=c.tenant_id AND e.id=c.employment_id) ELSE nullif(f->'period'->>'number','')::integer END,'periodRevision',CASE WHEN is_current THEN app.contract_shared_period_revision(c.employment_id) ELSE f->'period'->>'sourceRevision' END);
 source:=source||coalesce((SELECT jsonb_build_object('businessUnitId',source->>'businessGroupId','businessGroupId',bg.id,'businessGroup',bg.legal_name) FROM public.company co JOIN public.company bg ON bg.tenant_id=co.tenant_id AND bg.id=coalesce(co.parent_company_id,co.id) WHERE co.tenant_id=c.tenant_id AND co.id=c.company_id),'{}'::jsonb);
 IF is_current THEN source:=source||coalesce((SELECT jsonb_build_object('departmentId',a.department_id,'jobTitle',source->>'designation') FROM public.assignment a WHERE a.tenant_id=c.tenant_id AND a.employment_id=c.employment_id AND a.superseded_at IS NULL AND a.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (a.valid_to IS NULL OR a.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) ORDER BY a.valid_from DESC,a.id LIMIT 1),'{}'::jsonb);END IF;
 -- No current Payroll amount, component reference escapes a View-only projection. Agreed decision terms remain part of the case.
 IF NOT is_current OR NOT 'seePay'=ANY(rights) THEN source:=source-ARRAY['salaryCents','allowanceCents','allowanceComponentId','fixedAllowanceId','compensationId'];END IF;

 RETURN jsonb_build_object('id',c.id,'caseNumber',c.number,'companyId',c.company_id,'employmentId',c.employment_id,'permissions',to_jsonb(rights),
  'source',source,'sourceCurrent',is_current,'flow',f,'legacyState',c.data->>'state','sourceConflict',c.source_conflict,
  'cutoverAvailable',is_current AND s.case_id IS NULL AND c.data->>'state' IN('upcoming','decision_pending') AND c.data->'decision'='null'::jsonb AND coalesce(c.data->'decisionDraft','null'::jsonb)='null'::jsonb);
END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_tracker(p_search text DEFAULT '',p_company uuid DEFAULT NULL,p_status text DEFAULT 'all',p_limit integer DEFAULT 50,p_offset integer DEFAULT 0) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH clock AS MATERIALIZED(SELECT (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AS today),
 rights AS MATERIALIZED(SELECT * FROM app.contract_shared_tracker_subjects() WHERE can_view),
 intake_holds AS MATERIALIZED(SELECT * FROM app.contract_shared_native_intake_holds(ARRAY(SELECT employment_id FROM rights))),
 placement AS MATERIALIZED(SELECT DISTINCT ON(a.employment_id) a.* FROM public.assignment a CROSS JOIN clock WHERE a.tenant_id=app.current_tenant_id() AND a.superseded_at IS NULL AND a.valid_from<=today AND (a.valid_to IS NULL OR a.valid_to>today) ORDER BY a.employment_id,a.valid_from DESC,a.id),
 managers AS MATERIALIZED(SELECT DISTINCT ON(r.subordinate_employment_id) r.subordinate_employment_id,p.full_name FROM public.reporting_line r JOIN public.employment e ON e.tenant_id=r.tenant_id AND e.id=r.manager_employment_id JOIN public.person p ON p.tenant_id=e.tenant_id AND p.id=e.person_id CROSS JOIN clock WHERE r.tenant_id=app.current_tenant_id() AND r.line_type='administrative' AND r.superseded_at IS NULL AND r.valid_from<=today AND (r.valid_to IS NULL OR r.valid_to>today) ORDER BY r.subordinate_employment_id,r.valid_from DESC,r.id),
 eligible AS MATERIALIZED(SELECT e.id,coalesce(a.employment_type='contract' AND e.hired_on<=today AND e.voided_at IS NULL AND e.blacklisted_at IS NULL AND co.archived_at IS NULL AND (least(e.terminated_on,e.resignation_date,e.last_working_date) IS NULL OR least(e.terminated_on,e.resignation_date,e.last_working_date)>today),false) AS qualifies FROM public.employment e LEFT JOIN placement a ON a.employment_id=e.id JOIN public.company co ON co.tenant_id=e.tenant_id AND co.id=e.company_id CROSS JOIN clock WHERE e.tenant_id=app.current_tenant_id()),
 current_cases AS MATERIALIZED(SELECT DISTINCT ON(c.employment_id) c.* FROM public.contract_case c JOIN public.employment e ON e.tenant_id=c.tenant_id AND e.id=c.employment_id AND e.company_id=c.company_id JOIN eligible q ON q.id=e.id LEFT JOIN public.contract_shared_case f ON f.tenant_id=c.tenant_id AND f.case_id=c.id
  WHERE c.tenant_id=app.current_tenant_id() AND (c.data->'term'->>'startOn'=e.contract_start_date::text AND c.data->'term'->>'endOn'=e.contract_end_date::text OR NOT q.qualifies OR f.case_id IS NOT NULL AND f.data->>'stage' NOT IN('renewed','converted','offboarding','superseded','pay') OR f.case_id IS NULL AND c.data->>'state' NOT IN('renewed','handed_off','cancelled'))
  ORDER BY c.employment_id,(c.data->'term'->>'startOn'=e.contract_start_date::text AND c.data->'term'->>'endOn'=e.contract_end_date::text) DESC NULLS LAST,c.created_at DESC,c.id),
 pending_pay AS MATERIALIZED(SELECT DISTINCT ON(c.employment_id) c.employment_id,c.id AS case_id FROM public.contract_shared_case f JOIN public.contract_case c ON c.tenant_id=f.tenant_id AND c.id=f.case_id JOIN public.employment e ON e.tenant_id=c.tenant_id AND e.id=c.employment_id AND e.company_id=c.company_id WHERE f.tenant_id=app.current_tenant_id() AND f.data->>'stage'='pay' ORDER BY c.employment_id,f.updated_at DESC,c.id),
 workflow_latest AS MATERIALIZED(SELECT DISTINCT ON(workflow_id) workflow_id,status,definition FROM public.automation_workflow_version WHERE tenant_id=app.current_tenant_id() AND module='contract_staff' ORDER BY workflow_id,revision DESC),
 reminder_definitions AS MATERIALIZED(SELECT workflow_id,definition,
  CASE WHEN coalesce(definition->'trigger'->>'days','')~'^[0-9]{1,3}$' THEN (definition->'trigger'->>'days')::integer ELSE NULL END AS days,
  definition->'trigger'->'workdays'='true'::jsonb AS workdays FROM workflow_latest
  WHERE status='live' AND definition->'trigger'->>'event'='beforeContractEnd' AND jsonb_typeof(definition->'conditions')='array'),
 reminder_inputs AS MATERIALIZED(SELECT e.id,e.contract_end_date AS anchor,extract(isodow FROM e.contract_end_date)::integer AS weekday,w.days,coalesce(w.workdays,false) AS workdays
  FROM rights JOIN public.employment e ON e.id=rights.employment_id AND e.tenant_id=app.current_tenant_id() JOIN eligible q ON q.id=e.id AND q.qualifies JOIN public.company co ON co.tenant_id=e.tenant_id AND co.id=e.company_id CROSS JOIN clock CROSS JOIN reminder_definitions w
  WHERE e.contract_end_date IS NOT NULL AND w.days BETWEEN 0 AND 365 AND NOT EXISTS(
   SELECT 1 FROM jsonb_array_elements(w.definition->'conditions') condition
   CROSS JOIN LATERAL(SELECT CASE WHEN jsonb_typeof(condition->'values')='array' THEN condition->'values' ELSE '[]'::jsonb END AS values,
    CASE condition->>'field' WHEN 'businessGroup' THEN coalesce(co.parent_company_id,co.id)::text WHEN 'daysToEnd' THEN (e.contract_end_date-today)::text END AS actual) fact
   WHERE NOT coalesce(CASE WHEN condition->>'field' NOT IN('businessGroup','daysToEnd') OR jsonb_array_length(fact.values)=0 THEN false
    WHEN condition->>'op'='is' THEN fact.values ? fact.actual
    WHEN condition->>'op'='isNot' THEN NOT (fact.values ? fact.actual)
    WHEN condition->>'op' IN('lt','lte','gte') THEN CASE WHEN jsonb_array_length(fact.values)=1 AND length(fact.values->>0)<=1000 AND fact.values->>0~'^-?[0-9]+(\.[0-9]+)?$' AND fact.actual~'^-?[0-9]+(\.[0-9]+)?$' THEN
     CASE condition->>'op' WHEN 'lt' THEN fact.actual::numeric<(fact.values->>0)::numeric WHEN 'lte' THEN fact.actual::numeric<=(fact.values->>0)::numeric ELSE fact.actual::numeric>=(fact.values->>0)::numeric END ELSE false END
    ELSE false END,false))),
 reminder_dates AS MATERIALIZED(SELECT id,CASE WHEN NOT workdays OR days=0 THEN anchor-days ELSE
  anchor-CASE WHEN weekday>=6 THEN weekday-5 ELSE 0 END
  -((days-CASE WHEN weekday>=6 THEN 1 ELSE 0 END)/5*7)
  -((days-CASE WHEN weekday>=6 THEN 1 ELSE 0 END)%5)
  -CASE WHEN (days-CASE WHEN weekday>=6 THEN 1 ELSE 0 END)%5>=least(weekday,5) THEN 2 ELSE 0 END END AS due FROM reminder_inputs),
 reminders AS MATERIALIZED(SELECT id,min(due)::text AS first_due FROM reminder_dates GROUP BY id),
 visible AS MATERIALIZED(SELECT e.id,e.id AS "employmentId",c.id AS "caseId",c.number AS "caseNumber",e.company_id AS "companyId",p.full_name AS "employeeName",e.employee_code AS "employeeCode",co.legal_name AS company,bg.legal_name AS "businessGroup",coalesce(dep.name,'') AS department,coalesce(pos.title,'') AS position,coalesce(manager.full_name,'') AS manager,
  coalesce(e.contract_start_date::text,c.data->'term'->>'startOn') AS "startOn",coalesce(e.contract_end_date::text,c.data->'term'->>'endOn') AS "endOn",e.contract_number AS "contractNumber",
  encode(sha256(convert_to(jsonb_build_array(e.id,e.person_id,e.company_id,e.contract_start_date,e.contract_end_date,e.contract_number,a.employment_type,e.voided_at,e.blacklisted_at,e.resignation_date,e.last_working_date,e.terminated_on)::text,'UTF8')),'hex') AS "sourceRevision",
  CASE WHEN NOT q.qualifies AND coalesce(f.data->>'stage','') NOT IN('renewed','converted','offboarding','superseded','pay') THEN 'superseded' ELSE coalesce(f.data->>'stage',CASE c.data->>'state' WHEN 'upcoming' THEN 'open' WHEN 'decision_pending' THEN 'open' WHEN 'in_approval' THEN 'approval' WHEN 'e_acceptance' THEN 'document' WHEN 'records_pending' THEN 'workflow' WHEN 'ending' THEN 'workflow' WHEN 'renewed' THEN 'renewed' WHEN 'handed_off' THEN 'offboarding' WHEN 'cancelled' THEN 'superseded' END) END AS stage,c.data->>'state' AS "legacyState",f.revision AS "sharedRevision",coalesce(f.data->'flags','[]'::jsonb) AS flags,f.updated_at::text AS "lastActivityAt",
  coalesce((f.data->'decision'->>'payChanges')::boolean,false) AS "payChanges",f.data->'payConfirmation' IS NOT NULL AND f.data->'payConfirmation'<>'null'::jsonb AS "payConfirmed",
  pending.employment_id IS NOT NULL AND coalesce(f.data->>'stage','')<>'pay' AS "previousPayPending",pending.case_id AS "payPendingCaseId",reminders.first_due AS "firstReminderOn",
  coalesce(reminders.first_due<=today::text,false) OR coalesce(c.data->>'state'='decision_pending',false) OR coalesce(jsonb_array_length(f.data->'decisionHistory'),0)>0 AS "decisionNeeded",
  coalesce(e.contract_end_date<today,false) AS "endPassed",
  CASE WHEN f.data->>'stage' IN('approval','workflow','document','posting') AND coalesce(settings.stall_enabled,true) AND today-(f.updated_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date>=coalesce(settings.stall_days,5) THEN today-(f.updated_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date ELSE NULL END AS "stalledDays",
  rights.can_decide AND intake_hold.employment_id IS NULL AND q.qualifies AND c.id IS NULL AND e.contract_number IS NOT NULL AND e.contract_start_date IS NOT NULL AND e.contract_end_date IS NOT NULL AND e.contract_end_date>=e.contract_start_date AS "canOpen",
  CASE WHEN q.qualifies AND intake_hold.employment_id IS NOT NULL THEN 'native_intake_required' WHEN q.qualifies AND (e.contract_number IS NULL OR e.contract_start_date IS NULL OR e.contract_end_date IS NULL OR e.contract_end_date<e.contract_start_date) THEN 'verify_period'
   WHEN q.qualifies AND c.id IS NOT NULL AND (c.data->'term'->>'startOn' IS DISTINCT FROM e.contract_start_date::text OR c.data->'term'->>'endOn' IS DISTINCT FROM e.contract_end_date::text) THEN 'period_changed'
   WHEN q.qualifies AND f.case_id IS NOT NULL AND f.data->'period'->>'sourceRevision' IS DISTINCT FROM encode(sha256(convert_to(jsonb_build_array(e.id,e.person_id,e.company_id,e.contract_start_date,e.contract_end_date,e.contract_number,a.employment_type,e.voided_at,e.blacklisted_at,e.resignation_date,e.last_working_date,e.terminated_on)::text,'UTF8')),'hex') THEN 'period_changed'
   WHEN q.qualifies AND c.id IS NOT NULL AND f.case_id IS NULL AND (c.data->>'state' NOT IN('upcoming','decision_pending') OR c.data->'decision' IS DISTINCT FROM 'null'::jsonb OR coalesce(c.data->'decisionDraft','null'::jsonb)<>'null'::jsonb) THEN 'legacy_in_progress' END AS "sourceIssue"
  FROM rights JOIN public.employment e ON e.id=rights.employment_id AND e.tenant_id=app.current_tenant_id() JOIN eligible q ON q.id=e.id LEFT JOIN placement a ON a.employment_id=e.id JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id JOIN public.company co ON co.id=e.company_id AND co.tenant_id=e.tenant_id JOIN public.company bg ON bg.id=coalesce(co.parent_company_id,co.id) AND bg.tenant_id=co.tenant_id
  LEFT JOIN public.department dep ON dep.id=a.department_id AND dep.tenant_id=e.tenant_id LEFT JOIN public.position pos ON pos.id=a.position_id AND pos.tenant_id=e.tenant_id LEFT JOIN managers manager ON manager.subordinate_employment_id=e.id LEFT JOIN current_cases c ON c.employment_id=e.id LEFT JOIN public.contract_shared_case f ON f.tenant_id=c.tenant_id AND f.case_id=c.id LEFT JOIN pending_pay pending ON pending.employment_id=e.id LEFT JOIN reminders ON reminders.id=e.id LEFT JOIN intake_holds intake_hold ON intake_hold.employment_id=e.id LEFT JOIN public.contract_shared_settings settings ON settings.tenant_id=e.tenant_id AND settings.company_id=e.company_id CROSS JOIN clock
  WHERE (q.qualifies OR c.id IS NOT NULL)
  AND (p_company IS NULL OR e.company_id=p_company)
  AND (coalesce(p_search,'')='' OR concat_ws(' ',p.full_name,e.employee_code,c.number,co.legal_name,bg.legal_name,dep.name,pos.title) ILIKE '%'||left(p_search,100)||'%')
 ), filtered AS MATERIALIZED(SELECT * FROM visible WHERE coalesce(p_status,'all')='all'
  OR p_status='attention' AND (jsonb_array_length(flags)>0 OR "sourceIssue" IS NOT NULL OR "previousPayPending" OR "stalledDays" IS NOT NULL OR "endPassed" AND (stage IS NULL OR stage IN('open','document')))
  OR p_status='decision' AND (stage IS NULL OR stage='open') AND "decisionNeeded"
  OR p_status='upcoming' AND (stage IS NULL OR stage='open') AND NOT "decisionNeeded"
  OR p_status='progress' AND stage IN('approval','workflow','document','posting','pay')
  OR p_status='closed' AND stage IN('renewed','converted','offboarding','superseded')),
 page AS(SELECT * FROM filtered ORDER BY "endOn" NULLS LAST,"employeeName",id LIMIT least(greatest(coalesce(p_limit,50),1),100) OFFSET least(greatest(coalesce(p_offset,0),0),100000))
 SELECT jsonb_build_object('rows',coalesce((SELECT jsonb_agg(to_jsonb(page) ORDER BY "endOn" NULLS LAST,"employeeName",id) FROM page),'[]'::jsonb),'total',(SELECT count(*) FROM filtered))
$$;
REVOKE ALL ON FUNCTION app.contract_shared_tracker(text,uuid,text,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_tracker(text,uuid,text,integer,integer) TO ai_hr_app;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_worker_event_held(p_case uuid,p_revision integer) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_job_id uuid;v_event_id uuid;e public.contract_shared_event;f public.contract_shared_case;c public.contract_case;
BEGIN
 IF app.contract_shared_storage_runner() IS NOT TRUE THEN RETURN false;END IF;
 BEGIN v_job_id:=nullif(current_setting('app.bulk_job',true),'')::uuid;v_event_id:=nullif(current_setting('app.contract_event',true),'')::uuid;EXCEPTION WHEN invalid_text_representation THEN RETURN false;END;
 IF v_job_id IS NULL OR v_event_id IS NULL OR app.bulk_job_capability_held(v_job_id) IS NOT TRUE THEN RETURN false;END IF;
 SELECT e1.* INTO e FROM public.contract_shared_event e1 JOIN public.bulk_job j ON j.tenant_id=e1.tenant_id AND j.id=e1.job_id
 WHERE e1.tenant_id=app.current_tenant_id() AND e1.id=v_event_id AND e1.job_id=v_job_id AND j.kind='contract_automation'
 AND coalesce(e1.root_event_id,e1.id)::text=j.input->>'eventId' AND e1.case_id=p_case AND e1.decision_revision=p_revision AND e1.processed_at IS NULL;
 IF e.id IS NULL THEN RETURN false;END IF;
 IF app.contract_shared_decision_current(p_case,p_revision) THEN RETURN true;END IF;
 SELECT * INTO f FROM public.contract_shared_case WHERE tenant_id=e.tenant_id AND case_id=p_case;
 SELECT * INTO c FROM public.contract_case WHERE tenant_id=e.tenant_id AND id=p_case;
 IF app.contract_shared_native_intake_hold(c.employment_id) IS NOT NULL THEN RETURN false;END IF;
 IF f.data->'period'->>'sourceRevision' IS DISTINCT FROM app.contract_shared_period_revision(c.employment_id) OR NOT app.contract_case_company_current(c.id) OR c.source_conflict IS NOT NULL OR coalesce((app.contract_source(c.employment_id)->>'ended')::boolean,false) THEN RETURN false;END IF;
 IF p_revision=0 THEN RETURN f.data->'decision'='null'::jsonb AND e.actor_person_id=app.contract_binding_person(e.actor_user_id);END IF;
 RETURN e.trigger_event='approvalRejected' AND EXISTS(SELECT 1 FROM jsonb_array_elements(f.data->'decisionHistory') d WHERE d=e.data->'decision')
 AND EXISTS(SELECT 1 FROM public.contract_shared_event original WHERE original.tenant_id=e.tenant_id AND original.case_id=e.case_id AND original.trigger_event='decisionSubmitted' AND original.decision_revision=e.decision_revision AND original.actor_person_id=app.contract_binding_person(original.actor_user_id));
END $$;
--> statement-breakpoint
