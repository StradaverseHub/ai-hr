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
CREATE FUNCTION app.profile_task_register_projection(p_owner text,p_row jsonb,p_fields jsonb)RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce((SELECT jsonb_object_agg(b.field_name,p_row->b.column_name) FROM app.access_profile_value_bindings()b
 WHERE b.owner=p_owner AND (EXISTS(SELECT 1 FROM jsonb_array_elements(p_fields)f WHERE f->>'fieldId'=b.field_id)
 OR p_owner='dependent' AND b.field_name IN ('fullName','relationship') OR p_owner='qualification' AND b.field_name IN ('qualification','fromYm','toYm','graduationDate','isHighest') OR p_owner='emergency' AND b.field_name IN ('fullName','relationship','priority'))),'{}'::jsonb)
 ||jsonb_build_object('id',p_row->'id','tenantId',p_row->'tenant_id','personId',p_row->'person_id','employmentId',p_row->'employment_id','archivedAt',p_row->'archived_at');
$$;
REVOKE ALL ON FUNCTION app.profile_task_register_projection(text,jsonb,jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.profile_task_projection(p_request uuid,p_prepare boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE q public.profile_change_request;subject record;p public.person;st public.employee_statutory_my;stat_revision text;
 fields jsonb;entry jsonb;b record;owners text[];master jsonb;stat jsonb;source jsonb;projected jsonb;before_value jsonb;expected text;
 register_entry jsonb;register_field jsonb;register_row jsonb;register_revision text;
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
  IF 'passport'=ANY(owners) THEN stat:=stat||jsonb_build_object('passportRemark',st.passport_remark);END IF;
  IF 'taxLegacy'=ANY(owners) THEN stat:=stat||jsonb_build_object('taxResidency',st.tax_residency,'isResident',st.is_resident,'taxApplicabilityEpoch',st.tax_applicability_epoch,'taxCircumstance',st.tax_circumstance,'childReliefMode',st.child_relief_mode,'childReliefTable',st.child_relief_table,'employerBearsTax',st.employer_bears_tax,'disabledIndividual',st.disabled_individual,'disabledSpouse',st.disabled_spouse);END IF;
 END IF;
 -- Only explicitly selected register records are task facts. Other family/qualification rows remain hidden.
 IF q.proposed->'v'='2'::jsonb THEN
  FOR entry IN SELECT value FROM jsonb_array_elements(coalesce(q.proposed->'registers','[]'::jsonb)) LOOP
   IF entry->>'id' IS NULL THEN CONTINUE;END IF;
   IF entry->>'kind'='dependent' THEN
    SELECT dependents||coalesce(jsonb_agg(jsonb_build_object('record',app.profile_task_register_projection('dependent',to_jsonb(d),entry->'fields'),'revision',d.xmin::text)),'[]'::jsonb) INTO dependents FROM public.employee_dependent d WHERE d.id=(entry->>'id')::uuid AND d.person_id=q.person_id AND d.tenant_id=q.tenant_id AND d.archived_at IS NULL;
   ELSIF entry->>'kind'='qualification' THEN
    SELECT qualifications||coalesce(jsonb_agg(app.profile_task_register_projection('qualification',to_jsonb(d),entry->'fields')),'[]'::jsonb) INTO qualifications FROM public.employee_qualification d WHERE d.id=(entry->>'id')::uuid AND d.employment_id=q.employment_id AND d.tenant_id=q.tenant_id AND d.archived_at IS NULL;
   ELSIF entry->>'kind'='emergency' THEN
    SELECT emergency||coalesce(jsonb_agg(app.profile_task_register_projection('emergency',to_jsonb(d),entry->'fields')),'[]'::jsonb) INTO emergency FROM public.person_emergency_contact d WHERE d.id=(entry->>'id')::uuid AND d.person_id=q.person_id AND d.tenant_id=q.tenant_id AND d.archived_at IS NULL;
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
  IF q.proposed->'v'='2'::jsonb THEN
   FOR register_entry IN SELECT value FROM jsonb_array_elements(coalesce(q.proposed->'registers','[]'::jsonb)) LOOP
    IF register_entry->>'id' IS NULL THEN CONTINUE;END IF;
    register_row:=NULL;register_revision:=NULL;
    IF register_entry->>'kind'='dependent' THEN SELECT to_jsonb(d),d.xmin::text INTO register_row,register_revision FROM public.employee_dependent d WHERE d.id=(register_entry->>'id')::uuid AND d.person_id=q.person_id AND d.tenant_id=q.tenant_id AND d.archived_at IS NULL FOR UPDATE;
    ELSIF register_entry->>'kind'='qualification' THEN SELECT to_jsonb(d) INTO register_row FROM public.employee_qualification d WHERE d.id=(register_entry->>'id')::uuid AND d.employment_id=q.employment_id AND d.tenant_id=q.tenant_id AND d.archived_at IS NULL FOR UPDATE;
    ELSIF register_entry->>'kind'='emergency' THEN SELECT to_jsonb(d) INTO register_row FROM public.person_emergency_contact d WHERE d.id=(register_entry->>'id')::uuid AND d.person_id=q.person_id AND d.tenant_id=q.tenant_id AND d.archived_at IS NULL FOR UPDATE;END IF;
    IF register_row IS NULL THEN RAISE EXCEPTION 'Profile register source changed' USING ERRCODE='40001';END IF;
    FOR register_field IN SELECT value FROM jsonb_array_elements(register_entry->'fields') LOOP
     SELECT * INTO b FROM app.access_profile_value_bindings() WHERE field_id=register_field->>'fieldId' AND owner=register_entry->>'kind';
     IF b.field_id IS NULL THEN RAISE EXCEPTION 'Profile register field unavailable' USING ERRCODE='42501';END IF;
     IF register_field->>'before' LIKE 'profile-row:v1:%' THEN
      IF register_entry->>'kind'<>'dependent' OR register_revision IS NULL THEN RAISE EXCEPTION 'Profile register source changed' USING ERRCODE='40001';END IF;
      expected:='profile-row:v1:'||encode(sha256(convert_to(array_to_json(ARRAY['profile-row:v1',q.tenant_id::text,q.person_id::text,q.employment_id::text,subject.country,register_entry->>'kind',register_entry->>'id',register_revision,b.field_id])::text,'UTF8')),'hex');
     ELSE expected:='sha256:'||encode(sha256(convert_to(coalesce(register_row->b.column_name,'null'::jsonb)::text,'UTF8')),'hex');END IF;
     IF register_field->>'before' IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Profile register source changed' USING ERRCODE='40001';END IF;
    END LOOP;
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
CREATE FUNCTION app.workflow_direct_manager(p_employment uuid)RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM public.reporting_line line JOIN public.employment manager ON manager.id=line.manager_employment_id AND manager.tenant_id=line.tenant_id JOIN public.app_user actor ON actor.person_id=manager.person_id AND actor.tenant_id=manager.tenant_id
 WHERE line.subordinate_employment_id=p_employment AND line.tenant_id=app.current_tenant_id() AND line.line_type='administrative' AND line.superseded_at IS NULL AND line.valid_from<=current_date AND(line.valid_to IS NULL OR line.valid_to>current_date)
 AND actor.id=app.current_user_id() AND actor.archived_at IS NULL AND NOT app.login_blocked(actor.id) AND manager.blacklisted_at IS NULL AND manager.hired_on<=current_date AND manager.terminated_on IS NULL);
$$;
REVOKE ALL ON FUNCTION app.workflow_direct_manager(uuid) FROM PUBLIC,ai_hr_app;
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
  SELECT q.employment_id INTO target FROM public.claim_request q WHERE q.id=p_request AND q.tenant_id=app.current_tenant_id() AND q.status::text<>'draft';
 ELSIF p_kind='attendance.workflow' THEN
  SELECT q.correction_id INTO parent FROM public.attendance_workflow_request q WHERE q.id=p_request AND q.tenant_id=app.current_tenant_id();
  RETURN parent IS NOT NULL AND app.workflow_task_reader('attendance.correction',parent);
 ELSIF p_kind='attendance.correction' THEN
  SELECT q.employment_id INTO target FROM public.attendance_correction q WHERE q.id=p_request AND q.tenant_id=app.current_tenant_id();
  IF target IS NULL THEN RETURN false;END IF;
  IF app.can_see_employment(target) OR app.workflow_direct_manager(target) OR app.attendance_workflow_delegate_request(p_request) OR app.unrouted_attendance_delegate(p_request) OR app.attendance_workflow_v3_read(p_request) THEN RETURN true;END IF;
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
 RETURN app.can_see_employment(target) OR app.workflow_direct_manager(target) OR app.can_decide_via_delegation(target,CASE WHEN p_kind='claims.claim' THEN 'claims' ELSE 'leave' END,p_kind);
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
 IF context->'subject'->>'country' IS DISTINCT FROM 'MY' THEN RAISE EXCEPTION 'Profile statutory jurisdiction unavailable' USING ERRCODE='42501';END IF;
 SELECT request.* INTO q FROM app.profile_task_before c JOIN public.profile_change_request request ON request.id=c.request_id AND request.tenant_id=c.tenant_id WHERE c.xact_id=pg_current_xact_id() AND c.tenant_id=app.current_tenant_id() AND c.user_id=app.current_user_id() AND request.person_id=p_person;
 IF EXISTS(SELECT 1 FROM public.employment e WHERE e.person_id=p_person AND e.tenant_id=q.tenant_id AND e.voided_at IS NULL
  AND (NOT app.access_workforce_company(e.company_id,'workforce.maintain') OR NOT app.access_workforce_not_denied(e.company_id,'workforce.maintain'))) THEN RAISE EXCEPTION 'Shared profile company scope unavailable' USING ERRCODE='42501';END IF;
 IF jsonb_typeof(p_values) IS DISTINCT FROM 'object' OR octet_length(p_values::text)>65536 THEN RAISE EXCEPTION 'Profile effect unavailable' USING ERRCODE='42501';END IF;
 SELECT to_jsonb(s),s.id INTO before_row,row_id FROM public.employee_statutory_my s WHERE s.person_id=p_person AND s.tenant_id=q.tenant_id FOR UPDATE;inserted:=row_id IS NULL;
 FOR entry IN SELECT key,value FROM jsonb_each(p_values) LOOP
  SELECT binding.column_name INTO column_name FROM app.access_profile_value_bindings() binding WHERE binding.field_name=entry.key AND binding.owner IN ('bank','identity','passport','registration','taxLegacy') LIMIT 1;
  IF column_name IS NULL THEN
   column_name:=CASE entry.key WHEN 'passportRemark' THEN 'passport_remark' WHEN 'taxCircumstance' THEN 'tax_circumstance' WHEN 'taxApplicabilityEpoch' THEN 'tax_applicability_epoch' WHEN 'taxResidency' THEN 'tax_residency' WHEN 'isResident' THEN 'is_resident' WHEN 'childReliefMode' THEN 'child_relief_mode' WHEN 'childReliefTable' THEN 'child_relief_table' WHEN 'employerBearsTax' THEN 'employer_bears_tax' WHEN 'disabledIndividual' THEN 'disabled_individual' WHEN 'disabledSpouse' THEN 'disabled_spouse' END;
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
 IF delta ? 'passport_remark' AND NOT(inserted AND delta->'passport_remark'='null'::jsonb) THEN RAISE EXCEPTION 'Profile passport preservation unavailable' USING ERRCODE='42501';END IF;
 IF delta ? 'tax_circumstance' AND delta->'tax_circumstance' IS DISTINCT FROM expected_key OR delta ? 'tax_applicability_epoch' AND delta->'tax_applicability_epoch' IS DISTINCT FROM before_row->'tax_applicability_epoch' THEN RAISE EXCEPTION 'Profile tax effect unavailable' USING ERRCODE='42501';END IF;
 FOR grouped IN SELECT binding.owner,jsonb_object_agg(d.key,d.value) AS values FROM jsonb_each(delta-ARRAY['passport_remark','tax_circumstance','tax_applicability_epoch'])d LEFT JOIN app.access_profile_value_bindings()binding ON binding.column_name=d.key AND binding.owner IN ('bank','identity','passport','registration','taxLegacy') GROUP BY binding.owner LOOP
  IF grouped.owner IS NULL OR NOT app.access_profile_value_delta_matches(grouped.owner,grouped.values,fields,inserted,false) THEN RAISE EXCEPTION 'Profile effect differs from approved values' USING ERRCODE='42501';END IF;
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
--> statement-breakpoint
-- Native-normalized register effects stay bound to the exact stored request. General register rows
-- are never exposed; the existing deferred approved-value guard owns all resulting row deltas.
CREATE FUNCTION app.profile_task_store_register(p_person uuid,p_kind text,p_row uuid,p_client text,p_values jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE context jsonb;q public.profile_change_request;entry jsonb;binding record;pair record;patch jsonb:='{}'::jsonb;physical text;subject_column text;subject uuid;sets text;columns text;values_sql text;row_id uuid;cleared uuid;
BEGIN
 context:=app.profile_task_effect_source(p_person);IF context IS NULL THEN RETURN NULL;END IF;
 SELECT request.* INTO q FROM app.profile_task_before c JOIN public.profile_change_request request ON request.id=c.request_id AND request.tenant_id=c.tenant_id WHERE c.xact_id=pg_current_xact_id() AND c.tenant_id=app.current_tenant_id() AND c.user_id=app.current_user_id() AND request.person_id=p_person;
 SELECT value INTO entry FROM jsonb_array_elements(q.proposed->'registers') WHERE value->>'kind'=p_kind AND (p_row IS NOT NULL AND value->>'id'=p_row::text OR p_row IS NULL AND value->>'id' IS NULL AND value->>'clientId'=p_client);
 IF entry IS NULL OR jsonb_typeof(p_values) IS DISTINCT FROM 'object' OR octet_length(p_values::text)>65536 THEN RAISE EXCEPTION 'Profile register effect unavailable' USING ERRCODE='42501';END IF;
 physical:=CASE p_kind WHEN 'dependent' THEN 'employee_dependent' WHEN 'qualification' THEN 'employee_qualification' WHEN 'emergency' THEN 'person_emergency_contact' END;
 IF physical IS NULL THEN RAISE EXCEPTION 'Profile register effect unavailable' USING ERRCODE='42501';END IF;
 subject_column:=CASE WHEN p_kind='qualification' THEN 'employment_id' ELSE 'person_id' END;subject:=CASE WHEN p_kind='qualification' THEN q.employment_id ELSE q.person_id END;
 FOR pair IN SELECT key,value FROM jsonb_each(p_values) LOOP
  SELECT * INTO binding FROM app.access_profile_value_bindings() b WHERE b.owner=p_kind AND b.field_name=pair.key;
  IF binding.column_name IS NULL AND p_kind='dependent' AND pair.value='null'::jsonb THEN binding.column_name:=CASE pair.key WHEN 'remarks' THEN 'remarks' WHEN 'deceasedOn' THEN 'deceased_on' WHEN 'occupation' THEN 'occupation' WHEN 'companyName' THEN 'company_name' WHEN 'employerAddress' THEN 'employer_address' END;END IF;
  IF binding.column_name IS NULL THEN RAISE EXCEPTION 'Profile register effect field unavailable' USING ERRCODE='42501';END IF;
  patch:=patch||jsonb_build_object(binding.column_name,pair.value);
 END LOOP;
 IF patch='{}'::jsonb THEN RAISE EXCEPTION 'Empty profile effect' USING ERRCODE='42501';END IF;
 -- A transfer is part of the canonical Highest/Primary owner, not an unrelated sibling edit.
 IF p_kind='qualification' AND patch->'is_highest'='true'::jsonb THEN
  UPDATE public.employee_qualification SET is_highest=false,updated_at=now() WHERE tenant_id=q.tenant_id AND employment_id=q.employment_id AND is_highest AND archived_at IS NULL AND (p_row IS NULL OR id<>p_row) RETURNING id INTO cleared;
 ELSIF p_kind='emergency' AND patch->>'priority'='primary' THEN
  UPDATE public.person_emergency_contact SET priority='secondary',updated_at=now() WHERE tenant_id=q.tenant_id AND person_id=q.person_id AND priority='primary' AND archived_at IS NULL AND (p_row IS NULL OR id<>p_row) RETURNING id INTO cleared;
 END IF;
 IF p_row IS NULL THEN
  SELECT string_agg(format('%I',key),','),string_agg(format('(jsonb_populate_record(NULL::public.%I,$1)).%I',physical,key),',') INTO columns,values_sql FROM jsonb_object_keys(patch)key;
  EXECUTE format('INSERT INTO public.%I(tenant_id,%I,%s) SELECT $2,$3,%s RETURNING id',physical,subject_column,columns,values_sql) INTO row_id USING patch,q.tenant_id,subject;
 ELSE
  SELECT string_agg(format('%I=(jsonb_populate_record(NULL::public.%I,$1)).%I',key,physical,key),',') INTO sets FROM jsonb_object_keys(patch)key;
  EXECUTE format('UPDATE public.%I SET %s,updated_at=now() WHERE id=$2 AND tenant_id=$3 AND %I=$4 AND archived_at IS NULL RETURNING id',physical,sets,subject_column) INTO row_id USING patch,p_row,q.tenant_id,subject;
  IF row_id IS NULL THEN RAISE EXCEPTION 'Profile register unavailable' USING ERRCODE='42501';END IF;
 END IF;
 RETURN jsonb_build_object('id',row_id,'clearedId',cleared);
END;
$$;
REVOKE ALL ON FUNCTION app.profile_task_store_register(uuid,text,uuid,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.profile_task_store_register(uuid,text,uuid,text,jsonb) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.profile_task_family_sync(p_person uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE context jsonb;request uuid;before_row jsonb;after_row jsonb;delta jsonb;result jsonb;
BEGIN
 context:=app.profile_task_effect_source(p_person);IF context IS NULL THEN RETURN NULL;END IF;
 SELECT q.id INTO request FROM app.profile_task_before c JOIN public.profile_change_request q ON q.id=c.request_id AND q.tenant_id=c.tenant_id
 WHERE c.xact_id=pg_current_xact_id() AND c.tenant_id=app.current_tenant_id() AND c.user_id=app.current_user_id() AND q.person_id=p_person
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(q.proposed->'registers')r WHERE r->>'kind'='dependent');
 IF request IS NULL THEN RETURN NULL;END IF;
 SELECT to_jsonb(s) INTO before_row FROM public.employee_statutory_my s WHERE s.person_id=p_person AND s.tenant_id=app.current_tenant_id() FOR UPDATE;
 result:=app.my_sync_family_child_relief(p_person);
 SELECT to_jsonb(s) INTO after_row FROM public.employee_statutory_my s WHERE s.person_id=p_person AND s.tenant_id=app.current_tenant_id();
 SELECT coalesce(jsonb_object_agg(d.key,d.value),'{}'::jsonb) INTO delta FROM jsonb_each(after_row)d WHERE d.key<>ALL(ARRAY['id','tenant_id','person_id','created_at','updated_at']) AND d.value IS DISTINCT FROM before_row->d.key;
 IF delta<>'{}'::jsonb THEN INSERT INTO app.profile_task_statutory_effect(xact_id,tenant_id,user_id,request_id,row_id,inserted,delta)VALUES(pg_current_xact_id(),app.current_tenant_id(),app.current_user_id(),request,(after_row->>'id')::uuid,false,delta);END IF;
 RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION app.profile_task_family_sync(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
DO $$ DECLARE definition text; BEGIN
 definition:=pg_get_functiondef('app.access_family_relief_sync(uuid)'::regprocedure);
 IF position('DECLARE direct boolean;' IN definition)=0 OR position('BEGIN' IN definition)=0 THEN RAISE EXCEPTION 'Family sync owner changed';END IF;
 definition:=substring(definition FROM 1 FOR position('BEGIN' IN definition)+4)||E'\n result:=app.profile_task_family_sync(p_person);IF result IS NOT NULL THEN RETURN result;END IF;'||substring(definition FROM position('BEGIN' IN definition)+5);
 EXECUTE definition;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.profile_task_photo_policy() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p_field text:='profile.personal_details.photo';p_primary boolean:=false;b record;raw jsonb;cap text;linked text;linked_ids text[];
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.tenant_setting WHERE tenant_id=app.current_tenant_id() AND key='ess.profile_photo_edit' AND value='true'::jsonb)THEN RETURN false;END IF;
 SELECT NULL::text AS primary_key,true AS immediate,p_field AS legacy_key,'Profile'::text AS tab_name,'Personal details'::text AS section_name INTO b;
 SELECT value INTO raw FROM public.tenant_setting WHERE tenant_id=app.current_tenant_id() AND key='ess.profile_change_fields';
 IF raw IS NULL OR raw='null'::jsonb OR raw='"all"'::jsonb OR jsonb_typeof(raw)='array' THEN
  IF jsonb_typeof(raw)='array' AND EXISTS(SELECT 1 FROM jsonb_array_elements(raw) v WHERE jsonb_typeof(v)<>'string') THEN RETURN false; END IF;
  IF p_primary THEN RETURN b.primary_key IS NOT NULL; END IF;
  RETURN true;
 END IF;
 IF jsonb_typeof(raw)<>'object' THEN RETURN false; END IF;
 IF raw->'version'='2'::jsonb THEN
  IF (SELECT count(*) FROM jsonb_object_keys(raw))<>2 OR jsonb_typeof(raw->'fields') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(raw->'fields')>512 OR EXISTS(SELECT 1 FROM jsonb_array_elements(raw->'fields') v WHERE jsonb_typeof(v)<>'string' OR length(v#>>'{}') NOT BETWEEN 1 AND 200)
   OR (SELECT count(DISTINCT v) FROM jsonb_array_elements(raw->'fields') v)<>jsonb_array_length(raw->'fields') THEN RETURN false; END IF;
  RETURN true;
 END IF;
 IF raw->'version' NOT IN ('3'::jsonb,'4'::jsonb,'5'::jsonb) OR raw->'version' IS NULL
  OR jsonb_typeof(raw->'fields') IS DISTINCT FROM 'object' OR jsonb_typeof(raw->'primaryOnly') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(raw))<>(CASE WHEN raw->'version'='3'::jsonb THEN 3 WHEN raw->'version'='5'::jsonb THEN 5 ELSE 4 END)
  OR (SELECT count(*) FROM jsonb_object_keys(raw->'fields'))>512 OR jsonb_array_length(raw->'primaryOnly')>512
  OR EXISTS(SELECT 1 FROM jsonb_each(raw->'fields') f WHERE length(f.key) NOT BETWEEN 1 AND 200 OR f.value NOT IN ('"editable"'::jsonb,'"viewOnly"'::jsonb,'"hide"'::jsonb))
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(raw->'primaryOnly') v WHERE jsonb_typeof(v)<>'string' OR length(v#>>'{}') NOT BETWEEN 1 AND 200)
  OR (SELECT count(DISTINCT v) FROM jsonb_array_elements(raw->'primaryOnly') v)<>jsonb_array_length(raw->'primaryOnly') THEN RETURN false; END IF;
 IF raw->'version' IN ('4'::jsonb,'5'::jsonb) THEN
  IF jsonb_typeof(raw->'groups') IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(raw->'groups'))>128
   OR EXISTS(SELECT 1 FROM jsonb_each(raw->'groups') g WHERE length(g.key) NOT BETWEEN 1 AND 200 OR g.value NOT IN ('"editable"'::jsonb,'"viewOnly"'::jsonb,'"hide"'::jsonb)) THEN RETURN false; END IF;
 END IF;
 IF raw->'version'='5'::jsonb THEN
  IF jsonb_typeof(raw->'approvals') IS DISTINCT FROM 'object' THEN RETURN false;END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(raw->'approvals'))>512 OR EXISTS(SELECT 1 FROM jsonb_each(raw->'approvals')a WHERE length(a.key) NOT BETWEEN 1 AND 200 OR jsonb_typeof(a.value) IS DISTINCT FROM 'object' OR jsonb_typeof(a.value->'required') IS DISTINCT FROM 'boolean' OR jsonb_typeof(a.value->'attachmentRequired') IS DISTINCT FROM 'boolean')THEN RETURN false;END IF;
  IF EXISTS(SELECT 1 FROM jsonb_each(raw->'approvals')a WHERE (SELECT count(*) FROM jsonb_object_keys(a.value))<>2)THEN RETURN false;END IF;
 END IF;
 cap:=raw->'fields'->>p_field;
 IF cap IS NULL OR cap='hide' THEN RETURN false; END IF;
 IF raw->'version' IN ('4'::jsonb,'5'::jsonb) AND (COALESCE(raw->'groups'->>('tab:'||b.tab_name),'editable')<>'editable'
  OR COALESCE(raw->'groups'->>('section:'||b.tab_name||'/'||b.section_name),'editable')<>'editable') THEN RETURN false; END IF;
 linked_ids:=CASE
  WHEN p_field IN ('profile.personal_details.fullname','profile.personal_details.firstname','profile.personal_details.lastname')
   THEN ARRAY['profile.personal_details.fullname','profile.personal_details.firstname','profile.personal_details.lastname']
  WHEN p_field='profile.personal_details.dateofbirth' THEN ARRAY['profile.personal_details.dateofbirth','profile.personal_details.age']
  WHEN p_field='family.family_and_dependents.dateofbirth' THEN ARRAY['family.family_and_dependents.dateofbirth','family.family_and_dependents.age']
  ELSE ARRAY[p_field] END;
 FOREACH linked IN ARRAY linked_ids LOOP
  IF COALESCE(raw->'fields'->>linked,'hide')='hide' THEN RETURN false; END IF;
 END LOOP;
 RETURN CASE WHEN p_primary THEN b.primary_key IS NOT NULL AND cap='viewOnly' AND raw->'primaryOnly' ? p_field ELSE cap IN ('editable','viewOnly') END;
END; $$;
REVOKE ALL ON FUNCTION app.profile_task_photo_policy() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.profile_photo_proposal_allowed() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT app.profile_task_photo_policy() $$;
--> statement-breakpoint
CREATE TABLE app.profile_task_photo_effect(xact_id xid8 NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,request_id uuid NOT NULL,person_id uuid NOT NULL,proposal_hash text NOT NULL,route_hash text NOT NULL,content_hash text NOT NULL,mime_type text NOT NULL,size_bytes integer NOT NULL,audited boolean NOT NULL DEFAULT false,PRIMARY KEY(xact_id,tenant_id,user_id,request_id));
ALTER TABLE app.profile_task_photo_effect ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.profile_task_photo_effect FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.profile_task_store_photo(p_request uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE q public.profile_change_request;photo public.profile_photo_proposal;oldphoto public.person_photo;baseline text;
BEGIN
 PERFORM app.access_profile_policy_write_lock();
 SELECT * INTO q FROM public.profile_change_request WHERE id=p_request AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF q.id IS NULL OR q.status<>'pending' OR q.proposed->'v' IS DISTINCT FROM '3'::jsonb OR q.proposed->>'kind' IS DISTINCT FROM 'photo' OR q.proposed->>'fieldId' IS DISTINCT FROM 'profile.personal_details.photo'
 OR NOT app.principal_snapshot_current() OR app.is_self_person(q.person_id) OR NOT app.profile_request_assignee(q.id) OR NOT app.profile_photo_proposal_allowed()
 OR (q.route_id IS NOT NULL AND q.route_context->>'fingerprint' IS DISTINCT FROM app.access_profile_route_fingerprint(q.employment_id))
 OR (EXISTS(SELECT 1 FROM public.tenant_setting setting WHERE setting.tenant_id=q.tenant_id AND setting.key='ess.profile_change_approver' AND setting.value='"group_admin"'::jsonb) AND NOT app.is_group_admin())
 OR NOT EXISTS(SELECT 1 FROM public.employment e JOIN public.app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id WHERE e.id=q.employment_id AND e.person_id=q.person_id AND e.tenant_id=q.tenant_id AND e.blacklisted_at IS NULL AND e.hired_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (least(e.resignation_date,e.last_working_date,e.terminated_on)IS NULL OR least(e.resignation_date,e.last_working_date,e.terminated_on)>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) THEN RAISE EXCEPTION 'Profile photo task unavailable' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('person-photo:'||q.tenant_id::text||':'||q.person_id::text,0));
 SELECT * INTO oldphoto FROM public.person_photo WHERE person_id=q.person_id AND tenant_id=q.tenant_id FOR UPDATE;
 baseline:=encode(sha256(convert_to(CASE WHEN oldphoto.person_id IS NULL THEN 'absent:' ELSE oldphoto.mime_type||':' END,'UTF8')||coalesce(oldphoto.content,''::bytea)),'hex');
 IF baseline IS DISTINCT FROM q.proposed->>'baselineHash' THEN RAISE EXCEPTION 'Profile photo changed' USING ERRCODE='40001';END IF;
 SELECT * INTO photo FROM public.profile_photo_proposal WHERE request_id=q.id AND tenant_id=q.tenant_id;
 IF photo.request_id IS NULL THEN RAISE EXCEPTION 'Profile photo bytes unavailable' USING ERRCODE='42501';END IF;
 INSERT INTO app.profile_task_photo_effect(xact_id,tenant_id,user_id,request_id,person_id,proposal_hash,route_hash,content_hash,mime_type,size_bytes)
 VALUES(pg_current_xact_id(),q.tenant_id,app.current_user_id(),q.id,q.person_id,encode(sha256(convert_to(q.proposed::text,'UTF8')),'hex'),encode(sha256(convert_to(jsonb_build_array(q.route_id,q.route_revision,q.route_approver_user_id,q.route_approver_employment_id,q.route_context)::text,'UTF8')),'hex'),encode(sha256(photo.content),'hex'),photo.mime_type,photo.size_bytes);
 INSERT INTO public.person_photo(tenant_id,person_id,content,file_name,mime_type,size_bytes,uploaded_by_user_id)
 VALUES(q.tenant_id,q.person_id,photo.content,'profile-photo'||CASE WHEN photo.mime_type='image/png'THEN '.png' ELSE '.jpg' END,photo.mime_type,photo.size_bytes,app.current_user_id())
 ON CONFLICT(person_id)DO UPDATE SET content=excluded.content,file_name=excluded.file_name,mime_type=excluded.mime_type,size_bytes=excluded.size_bytes,uploaded_by_user_id=excluded.uploaded_by_user_id,updated_at=now();
 RETURN jsonb_build_object('personId',q.person_id,'mimeType',photo.mime_type,'sizeBytes',photo.size_bytes);
END;
$$;
REVOKE ALL ON FUNCTION app.profile_task_store_photo(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.profile_task_store_photo(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.profile_task_photo_approved(p_person uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM app.profile_task_photo_effect effect JOIN public.profile_change_request q ON q.id=effect.request_id AND q.tenant_id=effect.tenant_id AND q.person_id=effect.person_id
 JOIN public.person_photo photo ON photo.person_id=q.person_id AND photo.tenant_id=q.tenant_id
 WHERE effect.xact_id=pg_current_xact_id() AND effect.tenant_id=app.current_tenant_id() AND effect.user_id=app.current_user_id() AND effect.person_id=p_person AND effect.audited AND q.status='approved'
 AND effect.proposal_hash=encode(sha256(convert_to(q.proposed::text,'UTF8')),'hex') AND effect.route_hash=encode(sha256(convert_to(jsonb_build_array(q.route_id,q.route_revision,q.route_approver_user_id,q.route_approver_employment_id,q.route_context)::text,'UTF8')),'hex') AND effect.content_hash=encode(sha256(photo.content),'hex') AND photo.mime_type=effect.mime_type AND photo.size_bytes=effect.size_bytes AND photo.uploaded_by_user_id=effect.user_id AND photo.file_name='profile-photo'||CASE WHEN effect.mime_type='image/png'THEN '.png' ELSE '.jpg' END);
$$;
REVOKE ALL ON FUNCTION app.profile_task_photo_approved(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.profile_task_photo_audit()RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.aggregate_type='profile-change' AND NEW.event_type='profile-change.approved' AND NEW.actor_type='user' AND NEW.actor_id=app.current_user_id() THEN
  UPDATE app.profile_task_photo_effect SET audited=true WHERE xact_id=pg_current_xact_id() AND tenant_id=NEW.tenant_id AND user_id=NEW.actor_id AND request_id=NEW.aggregate_id;
 END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.profile_task_photo_audit() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER profile_task_photo_audit AFTER INSERT ON domain_event FOR EACH ROW EXECUTE FUNCTION app.profile_task_photo_audit();
--> statement-breakpoint
CREATE FUNCTION app.profile_task_photo_complete()RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN IF NOT app.profile_task_photo_approved(NEW.person_id)THEN RAISE EXCEPTION 'Profile photo completion unavailable' USING ERRCODE='42501';END IF;RETURN NULL;END $$;
REVOKE ALL ON FUNCTION app.profile_task_photo_complete() FROM PUBLIC,ai_hr_app;
CREATE CONSTRAINT TRIGGER profile_task_photo_complete AFTER INSERT ON app.profile_task_photo_effect DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.profile_task_photo_complete();
--> statement-breakpoint
-- The compatibility label projection may retain an actual task subject, never manufacture a name
-- directory from a reporting relationship or delegation plus an arbitrary posted employment ID.
CREATE OR REPLACE FUNCTION app.delegated_approval_subject(subject_id uuid,wanted_module text,wanted_task text)
RETURNS TABLE(person_id uuid,employee text,employee_code text,company_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT e.person_id,p.full_name,e.employee_code,e.company_id FROM public.employment e JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
 WHERE e.id=subject_id AND e.tenant_id=app.current_tenant_id() AND app.principal_snapshot_current()
 AND (app.data_permission_record_read(e.id) AND app.can_see_employment(e.id)
 OR wanted_module='leave' AND wanted_task='leave.application' AND EXISTS(SELECT 1 FROM public.leave_request q WHERE q.employment_id=e.id AND q.tenant_id=e.tenant_id AND app.workflow_task_reader(wanted_task,q.id))
 OR wanted_module='leave' AND wanted_task='leave.cancellation' AND EXISTS(SELECT 1 FROM public.leave_cancellation_request q WHERE q.employment_id=e.id AND q.tenant_id=e.tenant_id AND app.workflow_task_reader(wanted_task,q.id))
 OR wanted_module='leave' AND wanted_task='leave.replacement' AND EXISTS(SELECT 1 FROM public.replacement_leave_request q WHERE q.employment_id=e.id AND q.tenant_id=e.tenant_id AND app.workflow_task_reader(wanted_task,q.id))
 OR wanted_module='claims' AND wanted_task='claims.claim' AND EXISTS(SELECT 1 FROM public.claim_request q WHERE q.employment_id=e.id AND q.tenant_id=e.tenant_id AND q.status::text<>'draft' AND app.workflow_task_reader(wanted_task,q.id))
 OR wanted_module='attendance' AND wanted_task='attendance.correction' AND EXISTS(SELECT 1 FROM public.attendance_correction q WHERE q.employment_id=e.id AND q.tenant_id=e.tenant_id AND app.workflow_task_reader(wanted_task,q.id)));
$$;
--> statement-breakpoint
CREATE FUNCTION app.profile_task_relationship_tolerated(p_person uuid,p_value text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.profile_task_effect_source(p_person) IS NOT NULL AND EXISTS(
 SELECT 1 FROM app.profile_task_before c JOIN public.profile_change_request q ON q.id=c.request_id AND q.tenant_id=c.tenant_id
 CROSS JOIN LATERAL jsonb_array_elements(q.proposed->'registers')r CROSS JOIN LATERAL jsonb_array_elements(r->'fields')f
 WHERE c.xact_id=pg_current_xact_id() AND c.tenant_id=app.current_tenant_id() AND c.user_id=app.current_user_id() AND q.person_id=p_person
 AND r->>'kind'='emergency' AND f->>'fieldId'='profile.emergency_contact.relationship' AND app.access_profile_value_normalized(f->'value')=to_jsonb(p_value)
 AND EXISTS(SELECT 1 FROM public.person_emergency_contact e WHERE e.person_id=q.person_id AND e.tenant_id=q.tenant_id AND e.archived_at IS NULL AND e.relationship=p_value));
$$;
REVOKE ALL ON FUNCTION app.profile_task_relationship_tolerated(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.profile_task_relationship_tolerated(uuid,text) TO ai_hr_app;
--> statement-breakpoint
ALTER POLICY data_permission_subject_read ON attendance_workflow_decision USING(app.data_permission_record_read(employment_id) OR app.workflow_task_reader('attendance.workflow',request_id));
ALTER POLICY data_permission_subject_read ON attendance_workflow_participant_decision USING(app.data_permission_record_read(employment_id) OR app.workflow_task_reader('attendance.workflow',request_id));
--> statement-breakpoint
-- Full before-images and effect values are transaction scaffolding, not an additional personnel
-- history store. Preparation must finish its actual decision/audit; the last queued audit cleanup
-- runs after the value/effect constraint checks and removes all private copies from that decision.
CREATE FUNCTION app.profile_task_before_complete()RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.profile_change_request q JOIN app.access_profile_value_approval proof ON proof.request_id=q.id AND proof.tenant_id=q.tenant_id
 WHERE q.id=NEW.request_id AND q.tenant_id=NEW.tenant_id AND q.status='approved' AND proof.xact_id=NEW.xact_id AND proof.user_id=NEW.user_id AND proof.approved AND proof.audited
 AND proof.proposal_hash=NEW.proposal_hash AND proof.route_hash=NEW.route_hash
 AND NEW.proposal_hash=encode(sha256(convert_to(q.proposed::text,'UTF8')),'hex') AND NEW.route_hash=encode(sha256(convert_to(jsonb_build_array(q.route_id,q.route_revision,q.route_approver_user_id,q.route_approver_employment_id,q.route_context)::text,'UTF8')),'hex')) THEN RAISE EXCEPTION 'Profile task completion unavailable' USING ERRCODE='42501';END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.profile_task_before_complete() FROM PUBLIC,ai_hr_app;
CREATE CONSTRAINT TRIGGER profile_task_before_complete AFTER INSERT ON app.profile_task_before DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.profile_task_before_complete();
--> statement-breakpoint
CREATE FUNCTION app.profile_task_cleanup()RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.aggregate_type='profile-change' AND NEW.event_type='profile-change.approved' AND NEW.actor_type='user' AND NEW.actor_id=app.current_user_id() AND NEW.tenant_id=app.current_tenant_id() THEN
  DELETE FROM app.profile_task_statutory_effect WHERE xact_id=pg_current_xact_id() AND tenant_id=NEW.tenant_id AND user_id=NEW.actor_id AND request_id=NEW.aggregate_id;
  DELETE FROM app.profile_task_photo_effect WHERE xact_id=pg_current_xact_id() AND tenant_id=NEW.tenant_id AND user_id=NEW.actor_id AND request_id=NEW.aggregate_id;
  DELETE FROM app.profile_task_before WHERE xact_id=pg_current_xact_id() AND tenant_id=NEW.tenant_id AND user_id=NEW.actor_id AND request_id=NEW.aggregate_id;
 END IF;RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.profile_task_cleanup() FROM PUBLIC,ai_hr_app;
CREATE CONSTRAINT TRIGGER profile_task_cleanup AFTER INSERT ON domain_event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.aggregate_type='profile-change' AND NEW.event_type='profile-change.approved') EXECUTE FUNCTION app.profile_task_cleanup();

--> statement-breakpoint
CREATE POLICY bounded_approval_task_read ON leave_request FOR SELECT TO ai_hr_app USING(app.workflow_task_reader('leave.application',id));
CREATE POLICY bounded_approval_task_read ON leave_request_attachment FOR SELECT TO ai_hr_app USING(app.workflow_task_reader('leave.application',leave_request_id));
CREATE POLICY bounded_approval_task_read ON leave_cancellation_request FOR SELECT TO ai_hr_app USING(app.workflow_task_reader('leave.cancellation',id));
CREATE POLICY bounded_approval_task_read ON replacement_leave_request FOR SELECT TO ai_hr_app USING(app.workflow_task_reader('leave.replacement',id));
CREATE POLICY bounded_approval_task_read ON claim_request FOR SELECT TO ai_hr_app USING(app.workflow_task_reader('claims.claim',id));
CREATE POLICY bounded_approval_task_read ON claim_attachment FOR SELECT TO ai_hr_app USING(app.workflow_task_reader('claims.claim',claim_request_id));
CREATE POLICY bounded_approval_task_read ON attendance_correction FOR SELECT TO ai_hr_app USING(app.workflow_task_reader('attendance.correction',id));
CREATE POLICY bounded_approval_task_read ON attendance_correction_attachment FOR SELECT TO ai_hr_app USING(app.workflow_task_reader('attendance.correction',attendance_correction_id));
CREATE POLICY bounded_approval_task_read ON attendance_workflow_request FOR SELECT TO ai_hr_app USING(app.workflow_task_reader('attendance.correction',correction_id));
CREATE POLICY bounded_approval_task_read ON attendance_policy_request_contract FOR SELECT TO ai_hr_app USING(app.workflow_task_reader('attendance.correction',correction_id));
CREATE POLICY bounded_approval_task_read ON attendance_workflow_decision FOR SELECT TO ai_hr_app USING(app.workflow_task_reader('attendance.workflow',request_id));
CREATE POLICY bounded_approval_task_read ON attendance_workflow_participant_decision FOR SELECT TO ai_hr_app USING(app.workflow_task_reader('attendance.workflow',request_id));
