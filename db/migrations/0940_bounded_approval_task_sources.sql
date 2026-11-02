-- Exact task sources for independent approval responsibility; no general Personnel SELECT grant.
-- Coordinated source reservation0940 /idx762 /when1793330000340; depends on0938 responsibility owner.
CREATE FUNCTION app.profile_task_identity(p_request uuid)
RETURNS TABLE(employment_id uuid,person_id uuid,company_id uuid,country text,employee text,employee_code text,company_name text,employment_version text,person_version text,company_version text,current_photo_present boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT e.id,p.id,e.company_id,c.country,p.full_name,e.employee_code,c.legal_name,e.xmin::text,p.xmin::text,c.xmin::text,CASE WHEN q.proposed->'v'='3'::jsonb THEN EXISTS(SELECT 1 FROM public.person_photo photo WHERE photo.person_id=p.id AND photo.tenant_id=p.tenant_id) ELSE false END
 FROM public.profile_change_request q JOIN public.employment e ON e.id=q.employment_id AND e.tenant_id=q.tenant_id AND e.person_id=q.person_id
 JOIN public.person p ON p.id=q.person_id AND p.tenant_id=q.tenant_id JOIN public.company c ON c.id=e.company_id AND c.tenant_id=e.tenant_id
 WHERE q.id=p_request AND q.tenant_id=app.current_tenant_id() AND app.principal_snapshot_current()
 AND (app.access_profile_request_own(q.person_id) OR app.profile_request_reader(q.id));
$$;
REVOKE ALL ON FUNCTION app.profile_task_identity(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.profile_task_identity(uuid) TO ai_hr_app;
--> statement-breakpoint
-- Full locked before-images are private to the deterministic effect owner. The public projection
-- contains only exact requested fields and explicit validation dependencies, never this cache.
CREATE TABLE app.profile_task_before (
 xact_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,request_id uuid NOT NULL,
 proposal_hash text NOT NULL,route_hash text NOT NULL,source jsonb NOT NULL,
 PRIMARY KEY(xact_id,tenant_id,user_id,request_id)
);
ALTER TABLE app.profile_task_before ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.profile_task_before FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.profile_task_camel_row(p_owner text,p_row jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce((SELECT jsonb_object_agg(b.field_name,p_row->b.column_name) FROM app.access_profile_value_bindings() b
 WHERE (b.owner=p_owner OR p_owner='person' AND b.owner='compliance' OR p_owner='statutory' AND b.owner IN ('bank','identity','passport','registration','taxLegacy')) AND p_row ? b.column_name),'{}'::jsonb)
 || jsonb_build_object('id',p_row->'id','tenantId',p_row->'tenant_id','personId',p_row->'person_id','employmentId',p_row->'employment_id','archivedAt',p_row->'archived_at','createdAt',p_row->'created_at','updatedAt',p_row->'updated_at');
$$;
REVOKE ALL ON FUNCTION app.profile_task_camel_row(text,jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.profile_task_projection(p_request uuid,p_prepare boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE q public.profile_change_request;subject record;p public.person;st public.employee_statutory_my;stat_revision text;
 fields jsonb;entry jsonb;b record;owners text[];master jsonb;stat jsonb;source jsonb;projected jsonb;before_value jsonb;expected text;
 dependents jsonb:='[]'::jsonb;qualifications jsonb:='[]'::jsonb;emergency jsonb:='[]'::jsonb;
BEGIN
 PERFORM app.access_profile_policy_write_lock();
 SELECT * INTO q FROM public.profile_change_request WHERE id=p_request AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF q.id IS NULL OR NOT app.principal_snapshot_current() OR NOT(app.profile_request_reader(q.id) OR app.access_profile_request_own(q.person_id)) THEN RAISE EXCEPTION 'Profile task unavailable' USING ERRCODE='42501';END IF;
 IF p_prepare THEN
  IF q.status<>'pending' OR app.is_self_person(q.person_id) OR NOT app.profile_request_assignee(q.id) THEN RAISE EXCEPTION 'Profile task unavailable' USING ERRCODE='42501';END IF;
  PERFORM app.access_profile_value_begin(q.id);
 END IF;
 SELECT * INTO subject FROM app.profile_task_identity(q.id);IF subject.person_id IS NULL THEN RAISE EXCEPTION 'Profile task unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO p FROM public.person WHERE id=q.person_id AND tenant_id=q.tenant_id FOR UPDATE;
 SELECT * INTO st FROM public.employee_statutory_my WHERE person_id=q.person_id AND tenant_id=q.tenant_id FOR UPDATE;
 SELECT xmin::text INTO stat_revision FROM public.employee_statutory_my WHERE id=st.id AND tenant_id=q.tenant_id;
 IF q.proposed->'v'='2'::jsonb THEN fields:=q.proposed->'fields';
 ELSIF jsonb_typeof(q.proposed)='object' AND NOT q.proposed ? 'v' THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('fieldId',binding.field_id,'value',v.value)),'[]'::jsonb) INTO fields FROM jsonb_each(q.proposed)v JOIN app.access_profile_value_bindings()binding ON binding.legacy_key=v.key;
 ELSE fields:='[]'::jsonb;END IF;
 IF jsonb_typeof(fields) IS DISTINCT FROM 'array' OR jsonb_array_length(fields)>128 THEN RAISE EXCEPTION 'Profile task unavailable' USING ERRCODE='42501';END IF;
 SELECT array_agg(DISTINCT binding.owner) INTO owners FROM jsonb_array_elements(fields)f JOIN app.access_profile_value_bindings()binding ON binding.field_id=f->>'fieldId';
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(fields)f WHERE f->>'fieldId'='profile.personal_details.nationality') THEN owners:=array_append(owners,'passport');END IF;
 SELECT coalesce(jsonb_object_agg(binding.field_name,to_jsonb(p)->binding.column_name),'{}'::jsonb) INTO master FROM jsonb_array_elements(fields)f JOIN app.access_profile_value_bindings()binding ON binding.field_id=f->>'fieldId' WHERE binding.owner IN ('person','compliance');
 master:=master||jsonb_build_object('id',p.id,'tenantId',p.tenant_id);
 IF 'passport'=ANY(owners) OR 'identity'=ANY(owners) THEN master:=master||jsonb_build_object('nationality',p.nationality,'dateOfBirth',p.date_of_birth);END IF;
 IF st.id IS NOT NULL AND owners&&ARRAY['bank','identity','passport','registration','taxLegacy'] THEN
  SELECT coalesce(jsonb_object_agg(binding.field_name,to_jsonb(st)->binding.column_name),'{}'::jsonb) INTO stat FROM app.access_profile_value_bindings()binding WHERE binding.owner=ANY(owners) AND binding.owner IN ('bank','identity','passport','registration','taxLegacy');
  stat:=stat||jsonb_build_object('id',st.id,'tenantId',st.tenant_id,'personId',st.person_id,'updatedAt',st.updated_at);
  IF 'taxLegacy'=ANY(owners) THEN stat:=stat||jsonb_build_object('taxResidency',st.tax_residency,'isResident',st.is_resident,'taxApplicabilityEpoch',st.tax_applicability_epoch,'taxCircumstance',st.tax_circumstance,'childReliefMode',st.child_relief_mode,'childReliefTable',st.child_relief_table,'employerBearsTax',st.employer_bears_tax,'disabledIndividual',st.disabled_individual,'disabledSpouse',st.disabled_spouse);END IF;
 END IF;
 -- Only explicitly selected register records are task facts. Other family/qualification rows remain hidden.
 IF q.proposed->'v'='2'::jsonb THEN
  FOR entry IN SELECT value FROM jsonb_array_elements(coalesce(q.proposed->'registers','[]'::jsonb)) LOOP
   IF entry->>'id' IS NULL THEN CONTINUE;END IF;
   IF entry->>'kind'='dependent' THEN
    SELECT dependents||coalesce(jsonb_agg(jsonb_build_object('record',app.profile_task_camel_row('dependent',to_jsonb(d)),'revision',d.xmin::text)),'[]'::jsonb) INTO dependents FROM public.employee_dependent d WHERE d.id=(entry->>'id')::uuid AND d.person_id=q.person_id AND d.tenant_id=q.tenant_id AND d.archived_at IS NULL;
   ELSIF entry->>'kind'='qualification' THEN
    SELECT qualifications||coalesce(jsonb_agg(app.profile_task_camel_row('qualification',to_jsonb(d))),'[]'::jsonb) INTO qualifications FROM public.employee_qualification d WHERE d.id=(entry->>'id')::uuid AND d.employment_id=q.employment_id AND d.tenant_id=q.tenant_id AND d.archived_at IS NULL;
   ELSIF entry->>'kind'='emergency' THEN
    SELECT emergency||coalesce(jsonb_agg(app.profile_task_camel_row('emergency',to_jsonb(d))),'[]'::jsonb) INTO emergency FROM public.person_emergency_contact d WHERE d.id=(entry->>'id')::uuid AND d.person_id=q.person_id AND d.tenant_id=q.tenant_id AND d.archived_at IS NULL;
   END IF;
  END LOOP;
 END IF;
 projected:=jsonb_build_object('subject',jsonb_build_object('id',subject.employment_id,'personId',subject.person_id,'companyId',subject.company_id,'country',subject.country),
  'owners',to_jsonb(coalesce(owners,'{}'::text[])),'master',master,'stat',stat,'snapshot',CASE WHEN st.id IS NULL THEN NULL ELSE jsonb_build_object('rowId',st.id,'revision',stat_revision,'profile',stat) END,
  'dependents',dependents,'qualifications',qualifications,'emergency',emergency);
 IF p_prepare THEN
  -- Repeat public CAS checks at the storage boundary. A direct SQL call cannot bypass stale evidence.
  IF q.proposed->'v'='2'::jsonb THEN
   FOR entry IN SELECT value FROM jsonb_array_elements(fields) LOOP
    SELECT * INTO b FROM app.access_profile_value_bindings() WHERE field_id=entry->>'fieldId';
    IF b.field_id IS NULL THEN RAISE EXCEPTION 'Profile field unavailable' USING ERRCODE='42501';END IF;
    before_value:=CASE WHEN b.owner IN ('person','compliance') THEN to_jsonb(p)->b.column_name ELSE to_jsonb(st)->b.column_name END;
    IF b.field_id=ANY(ARRAY['profile.identity_and_passport.icnumber','profile.identity_and_passport.oldicnumber','profile.identity_and_passport.passportnumber','bank_statutory.bank_information.bankaccountno','bank_statutory.bank_information.customholderid']) THEN
     expected:='profile-row:v1:'||encode(sha256(convert_to(array_to_json(ARRAY['profile-row:v1',q.tenant_id::text,q.person_id::text,q.employment_id::text,subject.country,'statutory',st.id::text,stat_revision,b.field_id])::text,'UTF8')),'hex');
    ELSE expected:='sha256:'||encode(sha256(convert_to(coalesce(before_value,'null'::jsonb)::text,'UTF8')),'hex');END IF;
    IF entry->>'before' IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Profile task source changed' USING ERRCODE='40001';END IF;
   END LOOP;
  END IF;
  source:=jsonb_build_object('projection',projected,'person',to_jsonb(p),'statutory',to_jsonb(st));
  DELETE FROM app.profile_task_before WHERE tenant_id=q.tenant_id AND xact_id<>pg_current_xact_id();
  INSERT INTO app.profile_task_before VALUES(pg_current_xact_id(),q.tenant_id,app.current_user_id(),q.id,encode(sha256(convert_to(q.proposed::text,'UTF8')),'hex'),encode(sha256(convert_to(jsonb_build_array(q.route_id,q.route_revision,q.route_approver_user_id,q.route_approver_employment_id,q.route_context)::text,'UTF8')),'hex'),source)
   ON CONFLICT(xact_id,tenant_id,user_id,request_id) DO NOTHING;
 END IF;
 RETURN projected;
END;
$$;
REVOKE ALL ON FUNCTION app.profile_task_projection(uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.profile_task_projection(uuid,boolean) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.profile_task_effect_source(p_person uuid,p_employment uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;counted integer;
BEGIN
 SELECT count(*),jsonb_agg(c.source->'projection')->0 INTO counted,result FROM app.profile_task_before c JOIN public.profile_change_request q ON q.id=c.request_id AND q.tenant_id=c.tenant_id
 JOIN app.access_profile_value_approval proof ON proof.xact_id=c.xact_id AND proof.request_id=c.request_id AND proof.tenant_id=c.tenant_id AND proof.user_id=c.user_id
 WHERE c.xact_id=pg_current_xact_id() AND c.tenant_id=app.current_tenant_id() AND c.user_id=app.current_user_id() AND (p_person IS NULL OR q.person_id=p_person)
 AND (p_employment IS NULL OR q.employment_id=p_employment) AND q.status='pending' AND app.profile_request_assignee(q.id)
 AND c.proposal_hash=encode(sha256(convert_to(q.proposed::text,'UTF8')),'hex') AND c.proposal_hash=proof.proposal_hash
 AND c.route_hash=proof.route_hash AND c.route_hash=encode(sha256(convert_to(jsonb_build_array(q.route_id,q.route_revision,q.route_approver_user_id,q.route_approver_employment_id,q.route_context)::text,'UTF8')),'hex');
 RETURN CASE WHEN counted=1 THEN result ELSE NULL END;
END;
$$;
REVOKE ALL ON FUNCTION app.profile_task_effect_source(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.profile_task_effect_source(uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
-- Storage-only effect for native Person writers. Values must match this exact stored proposal;
-- native validators/audits and the original deferred approved-value guard remain mandatory.
CREATE FUNCTION app.profile_task_store_person(p_person uuid,p_values jsonb) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE context jsonb;q public.profile_change_request;before_row jsonb;patch jsonb:='{}'::jsonb;delta jsonb;fields jsonb;entry record;grouped record;sets text;
BEGIN
 context:=app.profile_task_effect_source(p_person);IF context IS NULL THEN RETURN false;END IF;
 SELECT request.* INTO q FROM app.profile_task_before c JOIN public.profile_change_request request ON request.id=c.request_id AND request.tenant_id=c.tenant_id WHERE c.xact_id=pg_current_xact_id() AND c.tenant_id=app.current_tenant_id() AND c.user_id=app.current_user_id() AND request.person_id=p_person;
 IF jsonb_typeof(p_values) IS DISTINCT FROM 'object' OR octet_length(p_values::text)>65536 THEN RAISE EXCEPTION 'Profile effect unavailable' USING ERRCODE='42501';END IF;
 SELECT to_jsonb(p) INTO before_row FROM public.person p WHERE p.id=p_person AND p.tenant_id=q.tenant_id FOR UPDATE;
 FOR entry IN SELECT key,value FROM jsonb_each(p_values) LOOP
  SELECT binding.column_name INTO sets FROM app.access_profile_value_bindings() binding WHERE binding.field_name=entry.key AND binding.owner IN ('person','compliance') LIMIT 1;
  IF sets IS NULL THEN IF entry.key='maritalStatusSourceRequestId' AND entry.value='null'::jsonb THEN sets:='marital_status_source_request_id';ELSE RAISE EXCEPTION 'Profile effect field unavailable' USING ERRCODE='42501';END IF;END IF;
  patch:=patch||jsonb_build_object(sets,entry.value);
 END LOOP;
 SELECT coalesce(jsonb_object_agg(d.key,d.value),'{}'::jsonb) INTO delta FROM jsonb_each(patch)d WHERE d.value IS DISTINCT FROM before_row->d.key;
 IF q.proposed->'v'='2'::jsonb THEN fields:=q.proposed->'fields';ELSE SELECT coalesce(jsonb_agg(jsonb_build_object('fieldId',b.field_id,'value',v.value)),'[]'::jsonb) INTO fields FROM jsonb_each(q.proposed)v JOIN app.access_profile_value_bindings()b ON b.legacy_key=v.key AND b.owner IN ('person','compliance');END IF;
 FOR grouped IN SELECT binding.owner,jsonb_object_agg(d.key,d.value) AS values FROM jsonb_each(delta-'marital_status_source_request_id')d LEFT JOIN app.access_profile_value_bindings()binding ON binding.column_name=d.key AND binding.owner IN ('person','compliance') GROUP BY binding.owner LOOP
  IF grouped.owner IS NULL OR NOT app.access_profile_value_delta_matches(grouped.owner,grouped.values,fields,false,false) THEN RAISE EXCEPTION 'Profile effect differs from approved values' USING ERRCODE='42501';END IF;
 END LOOP;
 IF delta ? 'marital_status_source_request_id' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(fields)f WHERE f->>'fieldId'='profile.personal_details.maritalstatus' AND app.access_profile_value_normalized(f->'value')=app.access_profile_value_normalized(coalesce(patch->'marital_status',before_row->'marital_status'))) THEN RAISE EXCEPTION 'Profile effect field unavailable' USING ERRCODE='42501';END IF;
 SELECT string_agg(format('%I=(jsonb_populate_record(NULL::public.person,$1)).%I',key,key),',') INTO sets FROM jsonb_object_keys(patch)key;
 IF sets IS NOT NULL THEN EXECUTE 'UPDATE public.person SET '||sets||' WHERE id=$2 AND tenant_id=$3' USING patch,p_person,q.tenant_id;END IF;
 RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION app.profile_task_store_person(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.profile_task_store_person(uuid,jsonb) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.workflow_task_reader(p_kind text,p_request uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE target uuid;parent uuid;w public.attendance_workflow_request;i integer;a jsonb;
BEGIN
 IF NOT app.principal_snapshot_current() THEN RETURN false;END IF;
 IF p_kind='leave.application' THEN
  SELECT q.employment_id INTO target FROM public.leave_request q WHERE q.id=p_request AND q.tenant_id=app.current_tenant_id();
 ELSIF p_kind='leave.cancellation' THEN
  SELECT q.employment_id INTO target FROM public.leave_cancellation_request q WHERE q.id=p_request AND q.tenant_id=app.current_tenant_id();
 ELSIF p_kind='leave.replacement' THEN
  SELECT q.employment_id INTO target FROM public.replacement_leave_request q WHERE q.id=p_request AND q.tenant_id=app.current_tenant_id();
 ELSIF p_kind='claims.claim' THEN
  SELECT q.employment_id INTO target FROM public.claim_request q WHERE q.id=p_request AND q.tenant_id=app.current_tenant_id() AND q.status<>'draft';
 ELSIF p_kind='attendance.workflow' THEN
  SELECT q.correction_id INTO parent FROM public.attendance_workflow_request q WHERE q.id=p_request AND q.tenant_id=app.current_tenant_id();
  RETURN parent IS NOT NULL AND app.workflow_task_reader('attendance.correction',parent);
 ELSIF p_kind='attendance.correction' THEN
  SELECT q.employment_id INTO target FROM public.attendance_correction q WHERE q.id=p_request AND q.tenant_id=app.current_tenant_id();
  IF target IS NULL THEN RETURN false;END IF;
  IF app.can_see_employment(target) OR app.attendance_workflow_delegate_request(p_request) OR app.unrouted_attendance_delegate(p_request) OR app.attendance_workflow_v3_read(p_request) THEN RETURN true;END IF;
  -- v2 administrative override is DATA-scoped; true stored assigned/delegated seats retain their task.
  SELECT * INTO w FROM public.attendance_workflow_request q WHERE q.correction_id=p_request AND q.tenant_id=app.current_tenant_id() AND q.routing_version=2;
  IF NOT FOUND THEN RETURN false;END IF;
  FOR i IN 0..jsonb_array_length(w.stages)-1 LOOP
   FOR a IN SELECT value FROM jsonb_array_elements(app.attendance_workflow_effective_approvers(w.id,i)) LOOP
    IF app.attendance_workflow_v2_assigned_allowed(p_request,i,a->>'kind',(a->>'employmentId')::uuid,'assigned') OR app.attendance_workflow_v2_assigned_allowed(p_request,i,a->>'kind',(a->>'employmentId')::uuid,'delegate') THEN RETURN true;END IF;
   END LOOP;
  END LOOP;RETURN false;
 ELSE RETURN false;END IF;
 IF target IS NULL THEN RETURN false;END IF;
 RETURN app.can_see_employment(target) OR app.can_decide_via_delegation(target,CASE WHEN p_kind='claims.claim' THEN 'claims' ELSE 'leave' END,p_kind);
END;
$$;
REVOKE ALL ON FUNCTION app.workflow_task_reader(text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.workflow_task_reader(text,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.attendance_application_subject(correction uuid)
RETURNS TABLE(person_id uuid,employee text,employee_code text,company_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT e.person_id,p.full_name,e.employee_code,e.company_id FROM public.attendance_correction c
 JOIN public.employment e ON e.id=c.employment_id AND e.tenant_id=c.tenant_id JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
 WHERE c.id=correction AND c.tenant_id=app.current_tenant_id() AND app.workflow_task_reader('attendance.correction',c.id);
$$;
--> statement-breakpoint
CREATE FUNCTION app.leave_task_balance(p_request uuid,p_type uuid) RETURNS numeric
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE q public.leave_request;source uuid;result numeric;
BEGIN
 SELECT * INTO q FROM public.leave_request WHERE id=p_request AND tenant_id=app.current_tenant_id();
 IF q.id IS NULL OR NOT app.workflow_task_reader('leave.application',q.id) THEN RAISE EXCEPTION 'Leave task unavailable' USING ERRCODE='42501';END IF;
 SELECT coalesce(t.balance_source_type_id,t.id) INTO source FROM public.leave_type t WHERE t.id=q.leave_type_id AND t.tenant_id=q.tenant_id;
 IF source IS NULL OR source IS DISTINCT FROM p_type THEN RAISE EXCEPTION 'Leave balance source unavailable' USING ERRCODE='42501';END IF;
 SELECT coalesce(sum(l.days),0) INTO result FROM public.leave_ledger l WHERE l.tenant_id=q.tenant_id AND l.employment_id=q.employment_id AND l.leave_type_id=source;
 RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION app.leave_task_balance(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.leave_task_balance(uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
ALTER POLICY data_permission_subject_read ON leave_request USING(app.data_permission_record_read(employment_id) OR app.workflow_task_reader('leave.application',id));
ALTER POLICY data_permission_subject_read ON leave_request_attachment USING(app.data_permission_record_read(employment_id) OR app.workflow_task_reader('leave.application',leave_request_id));
ALTER POLICY data_permission_subject_read ON leave_cancellation_request USING(app.data_permission_record_read(employment_id) OR app.workflow_task_reader('leave.cancellation',id));
ALTER POLICY data_permission_subject_read ON replacement_leave_request USING(app.data_permission_record_read(employment_id) OR app.workflow_task_reader('leave.replacement',id));
ALTER POLICY data_permission_subject_read ON claim_request USING(app.data_permission_record_read(employment_id) OR app.workflow_task_reader('claims.claim',id));
ALTER POLICY data_permission_subject_read ON claim_attachment USING(app.data_permission_record_read(employment_id) OR app.workflow_task_reader('claims.claim',claim_request_id));
ALTER POLICY data_permission_subject_read ON attendance_correction USING(app.data_permission_record_read(employment_id) OR app.workflow_task_reader('attendance.correction',id));
ALTER POLICY data_permission_subject_read ON attendance_correction_attachment USING(app.data_permission_record_read(employment_id) OR app.workflow_task_reader('attendance.correction',attendance_correction_id));
ALTER POLICY data_permission_subject_read ON attendance_workflow_request USING(app.data_permission_record_read(employment_id) OR app.workflow_task_reader('attendance.correction',correction_id));
ALTER POLICY data_permission_subject_read ON attendance_policy_request_contract USING(app.data_permission_record_read(employment_id) OR app.workflow_task_reader('attendance.correction',correction_id));

--> statement-breakpoint
CREATE FUNCTION app.profile_task_route_fingerprint(p_request uuid) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE q public.profile_change_request;
BEGIN
 SELECT * INTO q FROM public.profile_change_request WHERE id=p_request AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF q.id IS NULL OR NOT app.profile_request_reader(q.id) OR NOT app.principal_snapshot_current() THEN RAISE EXCEPTION 'Profile task unavailable' USING ERRCODE='42501';END IF;
 RETURN app.access_profile_route_fingerprint(q.employment_id);
END;
$$;
REVOKE ALL ON FUNCTION app.profile_task_route_fingerprint(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.profile_task_route_fingerprint(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE TABLE app.profile_task_statutory_effect(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),xact_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,request_id uuid NOT NULL,row_id uuid NOT NULL,
 inserted boolean NOT NULL,delta jsonb NOT NULL
);
ALTER TABLE app.profile_task_statutory_effect ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.profile_task_statutory_effect FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.profile_task_store_statutory(p_person uuid,p_values jsonb) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE context jsonb;q public.profile_change_request;before_row jsonb;after_row jsonb;patch jsonb:='{}'::jsonb;delta jsonb;fields jsonb;entry record;grouped record;column_name text;sets text;columns text;values_sql text;inserted boolean;row_id uuid;expected_key jsonb;
BEGIN
 context:=app.profile_task_effect_source(p_person);IF context IS NULL THEN RETURN NULL;END IF;
 SELECT request.* INTO q FROM app.profile_task_before c JOIN public.profile_change_request request ON request.id=c.request_id AND request.tenant_id=c.tenant_id WHERE c.xact_id=pg_current_xact_id() AND c.tenant_id=app.current_tenant_id() AND c.user_id=app.current_user_id() AND request.person_id=p_person;
 IF EXISTS(SELECT 1 FROM public.employment e WHERE e.person_id=p_person AND e.tenant_id=q.tenant_id AND e.voided_at IS NULL
  AND (NOT app.access_workforce_company(e.company_id,'workforce.maintain') OR NOT app.access_workforce_not_denied(e.company_id,'workforce.maintain'))) THEN RAISE EXCEPTION 'Shared profile company scope unavailable' USING ERRCODE='42501';END IF;
 IF jsonb_typeof(p_values) IS DISTINCT FROM 'object' OR octet_length(p_values::text)>65536 THEN RAISE EXCEPTION 'Profile effect unavailable' USING ERRCODE='42501';END IF;
 SELECT to_jsonb(s),s.id INTO before_row,row_id FROM public.employee_statutory_my s WHERE s.person_id=p_person AND s.tenant_id=q.tenant_id FOR UPDATE;inserted:=row_id IS NULL;
 FOR entry IN SELECT key,value FROM jsonb_each(p_values) LOOP
  SELECT binding.column_name INTO column_name FROM app.access_profile_value_bindings() binding WHERE binding.field_name=entry.key AND binding.owner IN ('bank','identity','passport','registration','taxLegacy') LIMIT 1;
  IF column_name IS NULL THEN
   column_name:=CASE entry.key WHEN 'taxCircumstance' THEN 'tax_circumstance' WHEN 'taxApplicabilityEpoch' THEN 'tax_applicability_epoch' WHEN 'taxResidency' THEN 'tax_residency' WHEN 'isResident' THEN 'is_resident' WHEN 'childReliefMode' THEN 'child_relief_mode' WHEN 'childReliefTable' THEN 'child_relief_table' WHEN 'employerBearsTax' THEN 'employer_bears_tax' WHEN 'disabledIndividual' THEN 'disabled_individual' WHEN 'disabledSpouse' THEN 'disabled_spouse' END;
   IF column_name IS NULL THEN RAISE EXCEPTION 'Profile effect field unavailable' USING ERRCODE='42501';END IF;
  END IF;
  patch:=patch||jsonb_build_object(column_name,entry.value);
 END LOOP;
 SELECT coalesce(jsonb_object_agg(d.key,d.value),'{}'::jsonb) INTO delta FROM jsonb_each(patch)d WHERE d.value IS DISTINCT FROM before_row->d.key;
 IF q.proposed->'v'='2'::jsonb THEN fields:=q.proposed->'fields';ELSE SELECT coalesce(jsonb_agg(jsonb_build_object('fieldId',b.field_id,'value',v.value)),'[]'::jsonb) INTO fields FROM jsonb_each(q.proposed)v JOIN app.access_profile_value_bindings()b ON b.legacy_key=v.key AND b.owner IN ('bank','identity','passport','registration','taxLegacy');END IF;
 -- Numeric legacy category changes retain their canonical circumstance mapping; no other tax setting
 -- becomes writable through a narrow number request.
 expected_key:=before_row->'tax_circumstance';
 IF patch ? 'tax_category' AND expected_key<>'"none"'::jsonb AND (
  expected_key='"single"'::jsonb AND patch->'tax_category'<>'1'::jsonb OR expected_key='"spouse_not_working"'::jsonb AND patch->'tax_category'<>'2'::jsonb
  OR expected_key IN ('"spouse_working"'::jsonb,'"widow_divorced"'::jsonb) AND patch->'tax_category'<>'3'::jsonb) THEN expected_key:='null'::jsonb;END IF;
 IF delta ? 'tax_circumstance' AND delta->'tax_circumstance' IS DISTINCT FROM expected_key OR delta ? 'tax_applicability_epoch' AND delta->'tax_applicability_epoch' IS DISTINCT FROM before_row->'tax_applicability_epoch' THEN RAISE EXCEPTION 'Profile tax effect unavailable' USING ERRCODE='42501';END IF;
 FOR grouped IN SELECT binding.owner,jsonb_object_agg(d.key,d.value) AS values FROM jsonb_each(delta-ARRAY['tax_circumstance','tax_applicability_epoch'])d LEFT JOIN app.access_profile_value_bindings()binding ON binding.column_name=d.key AND binding.owner IN ('bank','identity','passport','registration','taxLegacy') GROUP BY binding.owner LOOP
  IF grouped.owner IS NULL OR NOT app.access_profile_value_delta_matches(grouped.owner,grouped.values,fields,false,false) THEN RAISE EXCEPTION 'Profile effect differs from approved values' USING ERRCODE='42501';END IF;
 END LOOP;
 IF inserted THEN
  SELECT string_agg(format('%I',key),','),string_agg(format('(jsonb_populate_record(NULL::public.employee_statutory_my,$1)).%I',key),',') INTO columns,values_sql FROM jsonb_object_keys(patch)key;
  EXECUTE 'INSERT INTO public.employee_statutory_my(tenant_id,person_id,'||columns||') SELECT $2,$3,'||values_sql||' RETURNING to_jsonb(employee_statutory_my)' INTO after_row USING patch,q.tenant_id,p_person;row_id:=(after_row->>'id')::uuid;
 ELSE
  SELECT string_agg(format('%I=(jsonb_populate_record(NULL::public.employee_statutory_my,$1)).%I',key,key),',') INTO sets FROM jsonb_object_keys(patch)key;
  EXECUTE 'UPDATE public.employee_statutory_my SET '||sets||',updated_at=now() WHERE id=$2 AND tenant_id=$3 RETURNING to_jsonb(employee_statutory_my)' INTO after_row USING patch,row_id,q.tenant_id;
 END IF;
 SELECT coalesce(jsonb_object_agg(d.key,d.value),'{}'::jsonb) INTO delta FROM jsonb_each(after_row)d WHERE d.key<>ALL(ARRAY['id','tenant_id','person_id','created_at','updated_at']) AND d.value IS DISTINCT FROM before_row->d.key;
 DELETE FROM app.profile_task_statutory_effect WHERE tenant_id=q.tenant_id AND xact_id<>pg_current_xact_id();
 INSERT INTO app.profile_task_statutory_effect(xact_id,tenant_id,user_id,request_id,row_id,inserted,delta)VALUES(pg_current_xact_id(),q.tenant_id,app.current_user_id(),q.id,row_id,inserted,delta);
 RETURN row_id;
END;
$$;
REVOKE ALL ON FUNCTION app.profile_task_store_statutory(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.profile_task_store_statutory(uuid,jsonb) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.profile_task_statutory_delta_approved(p_person uuid,p_row uuid,p_delta jsonb,p_insert boolean DEFAULT false) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM app.profile_task_statutory_effect effect
 JOIN app.profile_task_before c ON c.xact_id=effect.xact_id AND c.tenant_id=effect.tenant_id AND c.user_id=effect.user_id AND c.request_id=effect.request_id
 JOIN public.profile_change_request q ON q.id=c.request_id AND q.tenant_id=c.tenant_id AND q.person_id=p_person
 JOIN app.access_profile_value_approval proof ON proof.xact_id=c.xact_id AND proof.tenant_id=c.tenant_id AND proof.user_id=c.user_id AND proof.request_id=c.request_id
 WHERE effect.xact_id=pg_current_xact_id() AND effect.tenant_id=app.current_tenant_id() AND effect.user_id=app.current_user_id()
 AND effect.row_id=p_row AND effect.inserted=p_insert AND effect.delta=p_delta AND q.status='approved' AND proof.approved AND proof.audited
 AND c.proposal_hash=proof.proposal_hash AND c.route_hash=proof.route_hash
 AND c.proposal_hash=encode(sha256(convert_to(q.proposed::text,'UTF8')),'hex')
 AND c.route_hash=encode(sha256(convert_to(jsonb_build_array(q.route_id,q.route_revision,q.route_approver_user_id,q.route_approver_employment_id,q.route_context)::text,'UTF8')),'hex'));
$$;
REVOKE ALL ON FUNCTION app.profile_task_statutory_delta_approved(uuid,uuid,jsonb,boolean) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.profile_task_statutory_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE delta jsonb;
BEGIN
 IF app.access_workforce_storage_owner() OR NOT EXISTS(SELECT 1 FROM app.profile_task_statutory_effect e WHERE e.xact_id=pg_current_xact_id() AND e.tenant_id=NEW.tenant_id AND e.user_id=app.current_user_id() AND e.row_id=NEW.id)THEN RETURN NULL;END IF;
 SELECT coalesce(jsonb_object_agg(d.key,d.value),'{}'::jsonb) INTO delta FROM jsonb_each(to_jsonb(NEW))d WHERE d.key<>ALL(ARRAY['id','tenant_id','person_id','created_at','updated_at']) AND d.value IS DISTINCT FROM CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD)->d.key END;
 IF NOT app.profile_task_statutory_delta_approved(NEW.person_id,NEW.id,delta,TG_OP='INSERT') THEN RAISE EXCEPTION 'Profile statutory completion unavailable' USING ERRCODE='42501';END IF;RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION app.profile_task_statutory_guard() FROM PUBLIC,ai_hr_app;
CREATE CONSTRAINT TRIGGER profile_task_statutory_guard AFTER INSERT OR UPDATE ON employee_statutory_my DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.profile_task_statutory_guard();
--> statement-breakpoint
-- The effect ledger itself owns completion too. SET CONSTRAINTS IMMEDIATE cannot skip a proof
-- merely because the native row trigger ran before its post-write effect receipt existed.
CREATE FUNCTION app.profile_task_statutory_effect_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE person uuid;
BEGIN
 SELECT q.person_id INTO person FROM public.profile_change_request q WHERE q.id=NEW.request_id AND q.tenant_id=NEW.tenant_id;
 IF person IS NULL OR NOT app.profile_task_statutory_delta_approved(person,NEW.row_id,NEW.delta,NEW.inserted) THEN RAISE EXCEPTION 'Profile statutory completion unavailable' USING ERRCODE='42501';END IF;RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION app.profile_task_statutory_effect_complete() FROM PUBLIC,ai_hr_app;
CREATE CONSTRAINT TRIGGER profile_task_statutory_effect_complete AFTER INSERT ON app.profile_task_statutory_effect DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.profile_task_statutory_effect_complete();
