-- Contract workflow proposes Personnel changes; approval and native Movement own their application.
-- Reserved by Contract parent: idx5214 / when1794841005814. No Payroll writer is introduced.
ALTER TABLE public.personnel_posting DROP CONSTRAINT personnel_posting_source_check;
ALTER TABLE public.personnel_posting ADD CONSTRAINT personnel_posting_source_check CHECK(source IN('probation','offboarding','contract_staff'));
ALTER TABLE public.personnel_posting DROP CONSTRAINT personnel_posting_event_type_check;
ALTER TABLE public.personnel_posting ADD CONSTRAINT personnel_posting_event_type_check CHECK(event_type IN('confirmation','probationExtension','promotion','transfer','increment','salaryAdjustment','employmentTypeChange','termination','contractRenewal','contractConversion'));
ALTER TABLE public.personnel_posting ADD CONSTRAINT personnel_posting_contract_source_event CHECK(source<>'contract_staff' OR event_type IN('contractRenewal','contractConversion'));
--> statement-breakpoint
CREATE TABLE public.contract_shared_posting (
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),posting_id uuid NOT NULL,case_id uuid NOT NULL,decision_revision integer NOT NULL CHECK(decision_revision>0),
 letter_id uuid NOT NULL,subject_person_id uuid NOT NULL REFERENCES public.person(id),source_revision text NOT NULL,
 movement_group_id uuid,applied_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,posting_id),UNIQUE(tenant_id,case_id,decision_revision),
 FOREIGN KEY(tenant_id,posting_id) REFERENCES public.personnel_posting(tenant_id,id),
 FOREIGN KEY(tenant_id,case_id) REFERENCES public.contract_shared_case(tenant_id,case_id),
 FOREIGN KEY(tenant_id,letter_id) REFERENCES public.contract_shared_letter(tenant_id,id)
);
ALTER TABLE public.contract_shared_posting ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contract_shared_posting FORCE ROW LEVEL SECURITY;
CREATE POLICY contract_shared_posting_owner ON public.contract_shared_posting FOR ALL TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
REVOKE ALL ON public.contract_shared_posting FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_posting_approver(p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(app.contract_verified_human(app.current_user_id()) AND app.contract_company_entitled(p_company)
 AND (app.contract_hr_admin(p_company) OR app.access_capability_allowed('access.system_admin',NULL)
 OR EXISTS(SELECT 1 FROM public.lc_v9_config v
 CROSS JOIN LATERAL jsonb_array_elements(coalesce(v.data->'groups','[]'::jsonb)) g
 WHERE v.tenant_id=app.current_tenant_id() AND g->>'id'=coalesce((SELECT s.posting_group_id FROM public.contract_shared_settings s WHERE s.tenant_id=v.tenant_id AND s.company_id=p_company),v.data->>'peopleOpsGroup')
 AND g->'members' ? app.current_user_id()::text)),false)
$$;
REVOKE ALL ON FUNCTION app.contract_shared_posting_approver(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_posting_approver(uuid) TO ai_hr_app;
--> statement-breakpoint
-- Keep the Probation validator byte-for-byte behind its original fixed subject dispatch.
ALTER FUNCTION app.personnel_posting_values_ok(text,jsonb) RENAME TO personnel_posting_values_ok_before_contract;
CREATE FUNCTION app.personnel_posting_values_ok(p_event text,p_values jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE start_on date;end_on date;previous_end date;n numeric;
BEGIN
 IF p_event NOT IN('contractRenewal','contractConversion') THEN RETURN app.personnel_posting_values_ok_before_contract(p_event,p_values);END IF;
 IF jsonb_typeof(p_values) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_values) k WHERE k NOT IN('effectiveDate','endDate','previousEndDate','contractNumber','remarks')) THEN RETURN false;END IF;
 start_on:=app.personnel_posting_day(p_values->'effectiveDate');previous_end:=app.personnel_posting_day(p_values->'previousEndDate');
 IF start_on IS NULL OR previous_end IS NULL OR start_on<=previous_end THEN RETURN false;END IF;
 IF p_values ? 'remarks' AND p_values->'remarks'<>'null'::jsonb AND (jsonb_typeof(p_values->'remarks')<>'string' OR length(p_values->>'remarks')>200) THEN RETURN false;END IF;
 IF p_event='contractRenewal' THEN
  end_on:=app.personnel_posting_day(p_values->'endDate');
  IF end_on IS NULL OR end_on<start_on+interval '3 months'-interval '1 day' OR coalesce(p_values->>'contractNumber','')!~'^[1-9][0-9]{0,5}$' THEN RETURN false;END IF;
  n:=(p_values->>'contractNumber')::numeric;RETURN n BETWEEN 1 AND 100000;
 END IF;
 RETURN coalesce(p_values->'endDate','null'::jsonb)='null'::jsonb AND coalesce(p_values->'contractNumber','null'::jsonb)='null'::jsonb;
END $$;
REVOKE ALL ON FUNCTION app.personnel_posting_values_ok(text,jsonb),app.personnel_posting_values_ok_before_contract(text,jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_create_posting(p_case uuid,p_run uuid,p_step text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c public.contract_case;f public.contract_shared_case;e public.employment;l public.contract_shared_letter;p public.personnel_posting;decision jsonb;kind text;expected text;proposed jsonb;approvers text;numbered integer;next_data jsonb;
BEGIN
 PERFORM app.contract_shared_lock_source(p_case);
 IF app.contract_shared_effect_held(p_case,p_run,p_step,'createPosting') IS NOT TRUE THEN RAISE EXCEPTION 'Protected Contract posting step required' USING ERRCODE='42501';END IF;
 SELECT * INTO f FROM public.contract_shared_case WHERE tenant_id=app.current_tenant_id() AND case_id=p_case FOR UPDATE;
 SELECT * INTO c FROM public.contract_case WHERE tenant_id=f.tenant_id AND id=f.case_id;
 SELECT * INTO e FROM public.employment WHERE tenant_id=c.tenant_id AND id=c.employment_id;
 decision:=f.data->'decision';
 SELECT s->'params'->>'eventType' INTO kind FROM public.automation_run r JOIN public.automation_workflow_version v ON v.tenant_id=r.tenant_id AND v.workflow_id=r.workflow_id AND v.revision=r.workflow_revision
 CROSS JOIN LATERAL jsonb_array_elements(v.definition->'steps') s WHERE r.tenant_id=c.tenant_id AND r.id=p_run AND s->>'id'=p_step;
 IF decision->>'kind'='end' OR f.data->'declined'<>'null'::jsonb THEN RETURN jsonb_build_object('skipped',true,'reason','Ending is handed to Offboarding; People Ops records termination manually in Personnel Management.');END IF;
 expected:=CASE decision->>'kind' WHEN 'renew' THEN 'Renewal' WHEN 'convert' THEN 'Conversion to permanent' END;
 IF kind IS DISTINCT FROM expected THEN
  next_data:=f.data||jsonb_build_object('revision',f.revision+1,'lastActivityAt',now());
  IF NOT(next_data->'flags' ? 'posting_mismatch') THEN next_data:=jsonb_set(next_data,'{flags}',(next_data->'flags')||'"posting_mismatch"'::jsonb);END IF;
  UPDATE public.contract_shared_case SET data=next_data,revision=revision+1,updated_at=now() WHERE tenant_id=f.tenant_id AND case_id=f.case_id;
  RETURN jsonb_build_object('skipped',true,'reason','The posting kind does not match the accepted decision.');
 END IF;
 SELECT p1.* INTO p FROM public.contract_shared_posting r JOIN public.personnel_posting p1 ON p1.tenant_id=r.tenant_id AND p1.id=r.posting_id
 WHERE r.tenant_id=c.tenant_id AND r.case_id=c.id AND r.decision_revision=(decision->>'revision')::integer;
 IF p.id IS NOT NULL THEN RETURN jsonb_build_object('id',p.id,'number',p.number,'existing',true);END IF;
 SELECT * INTO l FROM public.contract_shared_letter WHERE tenant_id=c.tenant_id AND id=app.contract_shared_released_step_letter(p_case,p_run,p_step) AND case_id=c.id AND decision_revision=(decision->>'revision')::integer AND purpose='outcome' AND data->>'state'='released' AND data->'valuesFixed'='true'::jsonb;
 IF l.id IS NULL THEN RAISE EXCEPTION 'Release this workflow step’s agreed Contract letter before creating its posting' USING ERRCODE='40001';END IF;
 approvers:=coalesce((SELECT posting_group_id FROM public.contract_shared_settings WHERE tenant_id=c.tenant_id AND company_id=c.company_id),(SELECT data->>'peopleOpsGroup' FROM public.lc_v9_config WHERE tenant_id=c.tenant_id));
 IF NOT EXISTS(SELECT 1 FROM public.lc_v9_config v CROSS JOIN LATERAL jsonb_array_elements(coalesce(v.data->'groups','[]'::jsonb)) g WHERE v.tenant_id=c.tenant_id AND g->>'id'=approvers AND jsonb_array_length(coalesce(g->'members','[]'::jsonb))>0) THEN RAISE EXCEPTION 'Choose an available Personnel posting approver group' USING ERRCODE='22023';END IF;
 proposed:=jsonb_build_object('effectiveDate',decision->>'startOn','previousEndDate',f.data->'period'->>'endOn');
 IF decision->>'kind'='renew' THEN proposed:=proposed||jsonb_build_object('endDate',decision->>'endOn','contractNumber',(e.contract_number+1)::text);END IF;
 IF app.personnel_posting_values_ok(CASE decision->>'kind' WHEN 'renew' THEN 'contractRenewal' ELSE 'contractConversion' END,proposed) IS NOT TRUE THEN RAISE EXCEPTION 'Contract posting values are incomplete' USING ERRCODE='22023';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('personnel-posting:'||c.tenant_id::text,0));
 SELECT coalesce(max(pp.number),1000)+1 INTO numbered FROM public.personnel_posting pp WHERE pp.tenant_id=c.tenant_id;
 INSERT INTO public.personnel_posting(tenant_id,company_id,employment_id,number,source,source_ref,event_type,proposed,approver_group_id,idempotency_key)
 VALUES(c.tenant_id,c.company_id,c.employment_id,numbered,'contract_staff',c.id,CASE decision->>'kind' WHEN 'renew' THEN 'contractRenewal' ELSE 'contractConversion' END,proposed,approvers,'decision:'||(decision->>'revision')) RETURNING * INTO p;
 INSERT INTO public.contract_shared_posting(tenant_id,posting_id,case_id,decision_revision,letter_id,subject_person_id,source_revision)
 VALUES(c.tenant_id,p.id,c.id,(decision->>'revision')::integer,l.id,e.person_id,f.data->'period'->>'sourceRevision');
 next_data:=f.data||jsonb_build_object('revision',f.revision+1,'stage','posting','posting',jsonb_build_object('id',p.id,'approvedBy',NULL,'approvedAt',NULL),'lastActivityAt',now());
 UPDATE public.contract_shared_case SET data=next_data,revision=revision+1,updated_at=now() WHERE tenant_id=f.tenant_id AND case_id=f.case_id;
 PERFORM app.contract_audit(c.id,'shared.posting_created',jsonb_build_object('postingId',p.id,'decisionRevision',decision->'revision','eventType',p.event_type));
 RETURN jsonb_build_object('id',p.id,'number',p.number,'existing',false);
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_create_posting(uuid,uuid,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_confirm_pay(p_case uuid,p_revision integer,p_confirmed boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE f public.contract_shared_case;c public.contract_case;p public.personnel_posting;next_data jsonb;
BEGIN
 PERFORM app.access_workforce_write_lock();
 SELECT * INTO c FROM public.contract_case WHERE tenant_id=app.current_tenant_id() AND id=p_case;
 IF c.id IS NULL OR app.contract_shared_posting_approver(c.company_id) IS NOT TRUE THEN RAISE EXCEPTION 'Only Contract posting approvers can confirm the manual Payroll entry' USING ERRCODE='42501';END IF;
 SELECT * INTO f FROM public.contract_shared_case WHERE tenant_id=c.tenant_id AND case_id=c.id FOR UPDATE;
 IF f.data->'payConfirmation'<>'null'::jsonb THEN RETURN jsonb_build_object('caseId',f.case_id,'revision',f.revision,'stage',f.data->>'stage','confirmed',true);END IF;
 SELECT * INTO p FROM public.personnel_posting WHERE tenant_id=c.tenant_id AND id=(f.data->'posting'->>'id')::uuid;
 IF p.id IS NULL OR f.revision IS DISTINCT FROM p_revision OR p_confirmed IS DISTINCT FROM true OR f.data->>'stage' IS DISTINCT FROM 'pay' OR f.data->'decision'->'payChanges' IS DISTINCT FROM 'true'::jsonb OR p.source IS DISTINCT FROM 'contract_staff' OR p.source_ref IS DISTINCT FROM f.case_id OR p.status IS DISTINCT FROM 'approved' OR p.movement_id IS NULL
 OR NOT EXISTS(SELECT 1 FROM public.contract_shared_posting r JOIN public.employment e ON e.tenant_id=r.tenant_id AND e.id=p.employment_id WHERE r.tenant_id=p.tenant_id AND r.posting_id=p.id AND r.subject_person_id=e.person_id AND r.decision_revision=(f.data->'decision'->>'revision')::integer)
 THEN RAISE EXCEPTION 'Approve the posting, enter pay separately in Payroll and confirm that entry' USING ERRCODE='40001';END IF;
 next_data:=f.data||jsonb_build_object('revision',f.revision+1,'stage',CASE f.data->'decision'->>'kind' WHEN 'renew' THEN 'renewed' ELSE 'converted' END,'payConfirmation',jsonb_build_object('by',app.current_user_id(),'at',now()),'lastActivityAt',now(),'flags',(f.data->'flags')-'pay_pending');
 UPDATE public.contract_shared_case SET revision=revision+1,data=next_data,updated_at=now() WHERE tenant_id=f.tenant_id AND case_id=f.case_id;
 PERFORM app.contract_audit(c.id,'shared.pay_confirmed',jsonb_build_object('postingId',p.id,'decisionRevision',f.data->'decision'->'revision','attestation','Pay updated separately in Payroll'));
 RETURN jsonb_build_object('caseId',f.case_id,'revision',f.revision+1,'stage',next_data->>'stage','confirmed',true);
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_confirm_pay(uuid,integer,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_confirm_pay(uuid,integer,boolean) TO ai_hr_app;
