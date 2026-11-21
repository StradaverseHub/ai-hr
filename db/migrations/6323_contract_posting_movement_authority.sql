-- Exact fixed-source authority for canonical Movement/Personnel writers. No role or Workforce grant is minted.
CREATE TABLE public.contract_shared_posting_tx (
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),posting_id uuid NOT NULL,employment_id uuid NOT NULL REFERENCES public.employment(id),
 transaction_id bigint NOT NULL,backend_pid integer NOT NULL,login_name text NOT NULL,actor_user_id uuid,
 old_employment jsonb NOT NULL,old_assignment jsonb NOT NULL,desired jsonb NOT NULL,effective_on date NOT NULL,kind text NOT NULL,
 consumed boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,transaction_id,backend_pid,employment_id),FOREIGN KEY(tenant_id,posting_id) REFERENCES public.contract_shared_posting(tenant_id,posting_id)
);
ALTER TABLE public.contract_shared_posting_tx ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contract_shared_posting_tx FORCE ROW LEVEL SECURITY;
CREATE POLICY contract_shared_posting_tx_owner ON public.contract_shared_posting_tx FOR ALL TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
REVOKE ALL ON public.contract_shared_posting_tx FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_posting_intent(p_posting uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.personnel_posting;r public.contract_shared_posting;e public.employment;a public.assignment;desired jsonb;allowed boolean;
BEGIN
 PERFORM app.access_workforce_write_lock();
 SELECT * INTO p FROM public.personnel_posting WHERE tenant_id=app.current_tenant_id() AND id=p_posting;
 IF p.id IS NULL OR p.source<>'contract_staff' OR p.status<>'approved' THEN RAISE EXCEPTION 'Approved Contract posting required' USING ERRCODE='42501';END IF;
 allowed:=(p.approved_by=app.current_user_id() AND p.approved_at=now() AND app.contract_shared_posting_approver(p.company_id))
 OR app.access_workforce_employment(p.employment_id,'workforce.maintain');
 IF allowed IS NOT TRUE THEN RAISE EXCEPTION 'Contract posting application unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO e FROM public.employment WHERE tenant_id=p.tenant_id AND id=p.employment_id FOR UPDATE;
 SELECT * INTO r FROM public.contract_shared_posting WHERE tenant_id=p.tenant_id AND posting_id=p.id FOR UPDATE;
 IF r.subject_person_id IS DISTINCT FROM e.person_id OR e.company_id IS DISTINCT FROM p.company_id OR e.voided_at IS NOT NULL OR e.terminated_on IS NOT NULL OR e.blacklisted_at IS NOT NULL THEN RAISE EXCEPTION 'Contract posting Personnel source changed' USING ERRCODE='40001';END IF;
 IF r.applied_at IS NOT NULL THEN RETURN jsonb_build_object('postingId',p.id,'employmentId',p.employment_id,'kind',p.event_type,'effectiveDate',p.applied->>'effectiveDate','endDate',p.applied->>'endDate','contractNumber',p.applied->>'contractNumber','completed',true,'groupId',r.movement_group_id);END IF;
 IF r.source_revision IS DISTINCT FROM app.contract_shared_period_revision(e.id) THEN RAISE EXCEPTION 'Reconcile the changed Personnel period before applying this posting' USING ERRCODE='40001';END IF;
 SELECT * INTO a FROM public.assignment WHERE tenant_id=e.tenant_id AND employment_id=e.id AND superseded_at IS NULL AND valid_to IS NULL ORDER BY valid_from DESC,id LIMIT 1 FOR UPDATE;
 IF a.id IS NULL OR a.employment_type<>'contract' OR (p.applied->>'effectiveDate')::date<a.valid_from THEN RAISE EXCEPTION 'The current Contract assignment is unavailable' USING ERRCODE='40001';END IF;
 desired:=CASE p.event_type WHEN 'contractRenewal' THEN jsonb_build_object('contract_start_date',p.applied->>'effectiveDate','contract_end_date',p.applied->>'endDate','contract_number',(p.applied->>'contractNumber')::integer)
 ELSE jsonb_build_object('contract_start_date',NULL,'contract_end_date',NULL,'contract_number',e.contract_number) END;
 INSERT INTO public.contract_shared_posting_tx(tenant_id,posting_id,employment_id,transaction_id,backend_pid,login_name,actor_user_id,old_employment,old_assignment,desired,effective_on,kind)
 VALUES(p.tenant_id,p.id,e.id,txid_current(),pg_backend_pid(),session_user,app.current_user_id(),to_jsonb(e),to_jsonb(a),desired,(p.applied->>'effectiveDate')::date,p.event_type)
 ON CONFLICT(tenant_id,transaction_id,backend_pid,employment_id) DO UPDATE SET posting_id=excluded.posting_id,actor_user_id=excluded.actor_user_id,old_employment=excluded.old_employment,old_assignment=excluded.old_assignment,desired=excluded.desired,effective_on=excluded.effective_on,kind=excluded.kind,login_name=excluded.login_name,consumed=false;
 RETURN jsonb_build_object('postingId',p.id,'employmentId',e.id,'kind',p.event_type,'effectiveDate',p.applied->>'effectiveDate','endDate',p.applied->>'endDate','contractNumber',p.applied->>'contractNumber','completed',false,'groupId',r.movement_group_id);
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_posting_intent(uuid) FROM PUBLIC,ai_hr_app;
GRANT EXECUTE ON FUNCTION app.contract_shared_posting_intent(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_posting_tx_subject(p_employment uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.contract_shared_posting_tx i WHERE i.tenant_id=app.current_tenant_id() AND i.transaction_id=txid_current() AND i.backend_pid=pg_backend_pid() AND i.login_name=session_user AND i.actor_user_id IS NOT DISTINCT FROM app.current_user_id() AND i.employment_id=p_employment AND NOT i.consumed)
$$;
REVOKE ALL ON FUNCTION app.contract_shared_posting_tx_subject(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_posting_tx_subject(uuid) TO ai_hr_app;
CREATE POLICY contract_posting_employment_read ON public.employment FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND app.contract_shared_posting_tx_subject(id));
CREATE POLICY contract_posting_assignment_read ON public.assignment FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND app.contract_shared_posting_tx_subject(employment_id));
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_posting_info_allowed(p_old jsonb,p_new jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.contract_shared_posting_tx i WHERE i.tenant_id=app.current_tenant_id() AND i.transaction_id=txid_current() AND i.backend_pid=pg_backend_pid() AND i.login_name=session_user AND i.actor_user_id IS NOT DISTINCT FROM app.current_user_id() AND NOT i.consumed
 AND p_old=i.old_employment AND p_new=i.old_employment||i.desired AND p_old->>'id'=i.employment_id::text AND i.effective_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
$$;
REVOKE ALL ON FUNCTION app.contract_shared_posting_info_allowed(jsonb,jsonb) FROM PUBLIC,ai_hr_app;
ALTER FUNCTION app.contract_service_info_intent_allowed(jsonb,jsonb) RENAME TO contract_service_info_intent_allowed_before_posting;
CREATE FUNCTION app.contract_service_info_intent_allowed(p_old jsonb,p_new jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.contract_service_info_intent_allowed_before_posting(p_old,p_new) OR app.contract_shared_posting_info_allowed(p_old,p_new)
$$;
REVOKE ALL ON FUNCTION app.contract_service_info_intent_allowed(jsonb,jsonb),app.contract_service_info_intent_allowed_before_posting(jsonb,jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_posting_assignment_allowed(p_old jsonb,p_new jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE i public.contract_shared_posting_tx;
BEGIN
 SELECT * INTO i FROM public.contract_shared_posting_tx x WHERE x.tenant_id=app.current_tenant_id() AND x.transaction_id=txid_current() AND x.backend_pid=pg_backend_pid() AND x.login_name=session_user AND x.actor_user_id IS NOT DISTINCT FROM app.current_user_id() AND NOT x.consumed AND x.employment_id=coalesce((p_old->>'employment_id')::uuid,(p_new->>'employment_id')::uuid);
 IF i.employment_id IS NULL OR i.kind<>'contractConversion' OR i.effective_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date THEN RETURN false;END IF;
 IF p_old IS NOT NULL THEN RETURN p_old=i.old_assignment AND p_new=p_old||jsonb_build_object('valid_to',i.effective_on);END IF;
 RETURN p_new->>'tenant_id'=i.tenant_id::text AND p_new->>'employment_id'=i.employment_id::text
 AND p_new->>'valid_from'=i.effective_on::text AND p_new->>'valid_to' IS NULL AND p_new->>'employment_type'='full_time'
 AND p_new->>'superseded_at' IS NULL AND p_new->>'company_id'=coalesce(i.old_assignment->>'company_id',i.old_employment->>'company_id')
 AND (p_new-ARRAY['id','created_at','valid_from','employment_type','company_id'])=(i.old_assignment-ARRAY['id','created_at','valid_from','employment_type','company_id']);
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_posting_assignment_allowed(jsonb,jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- No general Employment write policy or new shared-table trigger. RLS admits only the complete exact
-- OLD/NEW images minted from an approved immutable Contract posting for this actual backend/transaction/actor.
CREATE FUNCTION app.contract_shared_posting_employment_row(p_row jsonb,p_after boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.contract_shared_posting_tx i JOIN public.personnel_posting p ON p.tenant_id=i.tenant_id AND p.id=i.posting_id
 JOIN public.contract_shared_posting r ON r.tenant_id=p.tenant_id AND r.posting_id=p.id
 WHERE i.tenant_id=app.current_tenant_id() AND i.transaction_id=txid_current() AND i.backend_pid=pg_backend_pid() AND i.login_name=session_user
 AND i.actor_user_id IS NOT DISTINCT FROM app.current_user_id() AND NOT i.consumed AND p.source='contract_staff' AND p.status='approved'
 AND r.subject_person_id::text=p_row->>'person_id' AND p.employment_id=i.employment_id AND p_row->>'id'=i.employment_id::text
 AND p_row=CASE WHEN p_after THEN i.old_employment||i.desired ELSE i.old_employment END
 AND i.effective_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
$$;
CREATE FUNCTION app.contract_shared_posting_assignment_row(p_row jsonb,p_before boolean) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE old_row jsonb;
BEGIN
 SELECT i.old_assignment INTO old_row FROM public.contract_shared_posting_tx i WHERE i.tenant_id=app.current_tenant_id() AND i.transaction_id=txid_current() AND i.backend_pid=pg_backend_pid() AND i.login_name=session_user
 AND i.actor_user_id IS NOT DISTINCT FROM app.current_user_id() AND NOT i.consumed AND i.employment_id=(p_row->>'employment_id')::uuid AND i.kind='contractConversion';
 IF old_row IS NULL THEN RETURN false;END IF;
 IF p_before THEN RETURN p_row=old_row;END IF;
 RETURN app.contract_shared_posting_assignment_allowed(old_row,p_row) OR app.contract_shared_posting_assignment_allowed(NULL,p_row);
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_posting_employment_row(jsonb,boolean),app.contract_shared_posting_assignment_row(jsonb,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_posting_employment_row(jsonb,boolean),app.contract_shared_posting_assignment_row(jsonb,boolean) TO ai_hr_app;
CREATE POLICY contract_posting_employment_update ON public.employment FOR UPDATE TO ai_hr_app USING(app.contract_shared_posting_employment_row(to_jsonb(employment),false)) WITH CHECK(app.contract_shared_posting_employment_row(to_jsonb(employment),true));
CREATE POLICY contract_posting_assignment_insert ON public.assignment FOR INSERT TO ai_hr_app WITH CHECK(app.contract_shared_posting_assignment_row(to_jsonb(assignment),false));
CREATE POLICY contract_posting_assignment_update ON public.assignment FOR UPDATE TO ai_hr_app USING(app.contract_shared_posting_assignment_row(to_jsonb(assignment),true)) WITH CHECK(app.contract_shared_posting_assignment_row(to_jsonb(assignment),false));
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_posting_applied(p_posting uuid,p_group uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE i public.contract_shared_posting_tx;r public.contract_shared_posting;e public.employment;
BEGIN
 SELECT * INTO i FROM public.contract_shared_posting_tx WHERE tenant_id=app.current_tenant_id() AND posting_id=p_posting AND transaction_id=txid_current() AND backend_pid=pg_backend_pid() AND login_name=session_user AND actor_user_id IS NOT DISTINCT FROM app.current_user_id() AND NOT consumed FOR UPDATE;
 IF i.employment_id IS NULL THEN RAISE EXCEPTION 'Current Contract movement intent required' USING ERRCODE='42501';END IF;
 SELECT * INTO e FROM public.employment WHERE tenant_id=i.tenant_id AND id=i.employment_id;
 IF to_jsonb(e) IS DISTINCT FROM i.old_employment||i.desired OR i.effective_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
 OR (i.kind='contractConversion' AND NOT EXISTS(SELECT 1 FROM public.assignment a WHERE a.tenant_id=i.tenant_id AND a.employment_id=i.employment_id AND a.employment_type='full_time' AND a.valid_from=i.effective_on AND a.valid_to IS NULL AND a.superseded_at IS NULL))
 OR NOT EXISTS(SELECT 1 FROM public.domain_event d WHERE d.tenant_id=i.tenant_id AND d.subject_employment_id=i.employment_id AND d.occurred_at=now() AND d.payload->'movement'->>'groupId'=p_group::text AND d.payload->'movement'->>'type'=i.kind) THEN RAISE EXCEPTION 'The canonical Contract movement did not apply the agreed values' USING ERRCODE='23514';END IF;
 UPDATE public.contract_shared_posting SET applied_at=now(),movement_group_id=p_group WHERE tenant_id=i.tenant_id AND posting_id=i.posting_id;
 UPDATE public.contract_shared_posting_tx SET consumed=true WHERE tenant_id=i.tenant_id AND transaction_id=i.transaction_id AND backend_pid=i.backend_pid AND employment_id=i.employment_id;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_posting_applied(uuid,uuid) FROM PUBLIC,ai_hr_app;
GRANT EXECUTE ON FUNCTION app.contract_shared_posting_applied(uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_posting_approve(p_id uuid,p_revision integer,p_values jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.personnel_posting;r public.contract_shared_posting;f public.contract_shared_case;chosen jsonb;
BEGIN
 PERFORM app.access_workforce_write_lock();
 SELECT * INTO p FROM public.personnel_posting WHERE tenant_id=app.current_tenant_id() AND id=p_id;
 IF p.id IS NULL OR p.source<>'contract_staff' OR app.contract_shared_posting_approver(p.company_id) IS NOT TRUE THEN RAISE EXCEPTION 'Only Contract posting approvers can approve' USING ERRCODE='42501';END IF;
 PERFORM 1 FROM public.employment WHERE tenant_id=p.tenant_id AND id=p.employment_id FOR UPDATE;
 SELECT * INTO f FROM public.contract_shared_case WHERE tenant_id=p.tenant_id AND case_id=p.source_ref FOR UPDATE;
 SELECT * INTO p FROM public.personnel_posting WHERE tenant_id=p.tenant_id AND id=p.id FOR UPDATE;
 SELECT * INTO r FROM public.contract_shared_posting WHERE tenant_id=p.tenant_id AND posting_id=p.id;
 IF p.status='approved' AND p.movement_id IS NOT NULL THEN RETURN jsonb_build_object('duplicate',true,'id',p.id,'number',p.number,'employmentId',p.employment_id,'eventType',p.event_type,'values',p.applied);END IF;
 IF p.revision IS DISTINCT FROM p_revision OR p.status<>'pending' OR (f.data->'decision'->>'revision')::integer IS DISTINCT FROM r.decision_revision
 OR app.contract_shared_decision_current(f.case_id,r.decision_revision) IS NOT TRUE OR f.data->'declined'<>'null'::jsonb THEN RAISE EXCEPTION 'This Contract posting changed' USING ERRCODE='40001';END IF;
 chosen:=coalesce(p_values,p.edited,p.proposed);
 IF app.personnel_posting_values_ok(p.event_type,chosen) IS NOT TRUE THEN RAISE EXCEPTION 'Check the Personnel posting dates and contract number' USING ERRCODE='22023';END IF;
 IF (chosen-'remarks') IS DISTINCT FROM (p.proposed-'remarks') THEN RAISE EXCEPTION 'The posting differs from the released agreement. Correct it to the agreed values before approving' USING ERRCODE='22023';END IF;
 UPDATE public.personnel_posting SET status='approved',applied=chosen,approved_by=app.current_user_id(),approved_at=now(),revision=revision+1 WHERE tenant_id=p.tenant_id AND id=p.id;
 RETURN jsonb_build_object('duplicate',false,'id',p.id,'number',p.number,'employmentId',p.employment_id,'eventType',p.event_type,'values',chosen);
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_posting_approve(uuid,integer,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_posting_approve(uuid,integer,jsonb) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_posting_record_movement(p_id uuid,p_group uuid,p_scheduled boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.personnel_posting;i public.contract_shared_posting_tx;f public.contract_shared_case;d public.domain_event;next_data jsonb;
BEGIN
 SELECT * INTO i FROM public.contract_shared_posting_tx WHERE tenant_id=app.current_tenant_id() AND posting_id=p_id AND transaction_id=txid_current() AND backend_pid=pg_backend_pid() AND login_name=session_user AND actor_user_id IS NOT DISTINCT FROM app.current_user_id();
 SELECT * INTO p FROM public.personnel_posting WHERE tenant_id=i.tenant_id AND id=i.posting_id FOR UPDATE;
 IF p.id IS NULL OR p.approved_by IS DISTINCT FROM app.current_user_id() OR p.approved_at IS DISTINCT FROM now() OR p.movement_id IS NOT NULL THEN RAISE EXCEPTION 'Only the current approval can bind this movement' USING ERRCODE='42501';END IF;
 SELECT * INTO d FROM public.domain_event WHERE tenant_id=p.tenant_id AND subject_employment_id=p.employment_id AND occurred_at=now() AND payload->'movement'->>'groupId'=p_group::text AND payload->'movement'->>'type'=p.event_type ORDER BY sequence LIMIT 1;
 IF d.id IS NULL OR (p_scheduled AND (d.event_type<>'employment.movement.scheduled' OR d.payload->'input'->>'contractPostingId' IS DISTINCT FROM p.id::text OR d.payload->>'effectiveDate' IS DISTINCT FROM p.applied->>'effectiveDate' OR (d.payload->>'effectiveDate')::date<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)) THEN RAISE EXCEPTION 'Canonical Contract movement receipt required' USING ERRCODE='23514';END IF;
 IF NOT p_scheduled THEN PERFORM app.contract_shared_posting_applied(p.id,p_group);ELSE
  UPDATE public.contract_shared_posting SET movement_group_id=p_group WHERE tenant_id=p.tenant_id AND posting_id=p.id;
  UPDATE public.contract_shared_posting_tx SET consumed=true WHERE tenant_id=i.tenant_id AND transaction_id=i.transaction_id AND backend_pid=i.backend_pid AND employment_id=i.employment_id;
 END IF;
 UPDATE public.personnel_posting SET movement_id=d.id::text WHERE tenant_id=p.tenant_id AND id=p.id;
 SELECT * INTO f FROM public.contract_shared_case WHERE tenant_id=p.tenant_id AND case_id=p.source_ref FOR UPDATE;
 next_data:=f.data||jsonb_build_object('revision',f.revision+1,'stage',CASE WHEN f.data->'decision'->'payChanges'='true'::jsonb THEN 'pay' WHEN p.event_type='contractRenewal' THEN 'renewed' ELSE 'converted' END,
 'posting',jsonb_build_object('id',p.id,'approvedBy',app.current_user_id(),'approvedAt',now()),'lastActivityAt',now());
 IF f.data->'decision'->'payChanges'='true'::jsonb AND NOT(next_data->'flags' ? 'pay_pending') THEN next_data:=jsonb_set(next_data,'{flags}',(next_data->'flags')||'"pay_pending"'::jsonb);END IF;
 UPDATE public.contract_shared_case SET data=next_data,revision=revision+1,updated_at=now() WHERE tenant_id=f.tenant_id AND case_id=f.case_id;
 PERFORM app.contract_audit(f.case_id,'shared.posting_approved',jsonb_build_object('postingId',p.id,'movementId',d.id,'movementGroupId',p_group,'scheduled',p_scheduled,'effectiveDate',p.applied->>'effectiveDate'));
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_posting_record_movement(uuid,uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_posting_record_movement(uuid,uuid,boolean) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_posting_intent_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.contract_shared_posting_tx i WHERE i.tenant_id=NEW.tenant_id AND i.transaction_id=NEW.transaction_id AND i.backend_pid=NEW.backend_pid AND i.employment_id=NEW.employment_id AND NOT i.consumed) THEN RAISE EXCEPTION 'Contract posting must finish with its canonical movement receipt' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_posting_intent_complete() FROM PUBLIC,ai_hr_app;
CREATE CONSTRAINT TRIGGER contract_shared_posting_intent_complete AFTER INSERT OR UPDATE ON public.contract_shared_posting_tx DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.contract_shared_posting_intent_complete();
--> statement-breakpoint
ALTER FUNCTION app.personnel_posting_approve(uuid,integer,jsonb) RENAME TO personnel_posting_approve_before_contract;
CREATE FUNCTION app.personnel_posting_approve(p_id uuid,p_revision integer,p_values jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.personnel_posting p WHERE p.tenant_id=app.current_tenant_id() AND p.id=p_id AND p.source='contract_staff') THEN RETURN app.contract_shared_posting_approve(p_id,p_revision,p_values);END IF;
 RETURN app.personnel_posting_approve_before_contract(p_id,p_revision,p_values);
END $$;
REVOKE ALL ON FUNCTION app.personnel_posting_approve_before_contract(uuid,integer,jsonb) FROM PUBLIC,ai_hr_app;
REVOKE ALL ON FUNCTION app.personnel_posting_approve(uuid,integer,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.personnel_posting_approve(uuid,integer,jsonb) TO ai_hr_app;
ALTER FUNCTION app.personnel_posting_record_movement(uuid,text) RENAME TO personnel_posting_record_movement_before_contract;
CREATE FUNCTION app.personnel_posting_record_movement(p_id uuid,p_movement text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.personnel_posting p WHERE p.tenant_id=app.current_tenant_id() AND p.id=p_id AND p.source='contract_staff') THEN RAISE EXCEPTION 'Contract postings use their fixed Movement owner' USING ERRCODE='42501';END IF;
 PERFORM app.personnel_posting_record_movement_before_contract(p_id,p_movement);
END $$;
REVOKE ALL ON FUNCTION app.personnel_posting_record_movement_before_contract(uuid,text) FROM PUBLIC,ai_hr_app;
REVOKE ALL ON FUNCTION app.personnel_posting_record_movement(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.personnel_posting_record_movement(uuid,text) TO ai_hr_app;

--> statement-breakpoint
-- Preserve existing structural owners; add only the exact Contract assignment close-and-insert witness.
CREATE OR REPLACE FUNCTION app.access_workforce_structure_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE before_row jsonb;after_row jsonb;subject uuid;proof app.access_termination_intent%ROWTYPE;
BEGIN
 IF app.access_workforce_storage_owner() THEN
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
 END IF;
 IF NOT app.principal_snapshot_current() THEN RAISE EXCEPTION 'Structural principal unavailable' USING ERRCODE='42501'; END IF;
 before_row:=CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END;
 after_row:=CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END;
 IF before_row=after_row THEN RETURN NEW; END IF;
 IF (before_row IS NOT NULL AND before_row->>'tenant_id' IS DISTINCT FROM app.current_tenant_id()::text)
  OR (after_row IS NOT NULL AND after_row->>'tenant_id' IS DISTINCT FROM app.current_tenant_id()::text) THEN
  RAISE EXCEPTION 'Workforce structure unavailable' USING ERRCODE='42501'; END IF;
 IF TG_OP='UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
  OR before_row->'created_at' IS DISTINCT FROM after_row->'created_at'
  OR before_row->'employment_id' IS DISTINCT FROM after_row->'employment_id'
  OR before_row->'subordinate_employment_id' IS DISTINCT FROM after_row->'subordinate_employment_id') THEN
  RAISE EXCEPTION 'Structural identity cannot be reassigned' USING ERRCODE='42501'; END IF;
 IF TG_TABLE_NAME='reporting_line' AND (before_row IS NULL OR before_row->>'line_type'='delegate')
  AND (after_row IS NULL OR after_row->>'line_type'='delegate') THEN
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
 END IF;
 subject:=COALESCE((before_row->>'employment_id')::uuid,(before_row->>'subordinate_employment_id')::uuid,
  (after_row->>'employment_id')::uuid,(after_row->>'subordinate_employment_id')::uuid);
 IF TG_TABLE_NAME='assignment' AND TG_OP IN('INSERT','UPDATE') AND app.contract_shared_posting_assignment_allowed(before_row,after_row) THEN RETURN NEW;END IF;
 IF (before_row IS NULL OR app.access_workforce_employment(subject,'workforce.maintain'))
  AND (after_row IS NULL OR app.access_workforce_employment(COALESCE((after_row->>'employment_id')::uuid,(after_row->>'subordinate_employment_id')::uuid),'workforce.maintain'))
  AND (TG_TABLE_NAME<>'assignment' OR
   (before_row->>'company_id' IS NULL OR app.access_workforce_company((before_row->>'company_id')::uuid,'workforce.maintain'))
   AND (after_row->>'company_id' IS NULL OR app.access_workforce_company((after_row->>'company_id')::uuid,'workforce.maintain'))) THEN
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
 END IF;
 -- The exception can only close an unchanged open/current range involving the terminated subject.
 IF TG_OP='UPDATE' AND before_row->>'valid_to' IS NULL AND before_row->>'superseded_at' IS NULL
  AND (before_row-'valid_to')=(after_row-'valid_to') THEN
  SELECT * INTO proof FROM app.access_termination_intent p WHERE p.xact_id=pg_current_xact_id()
   AND p.tenant_id=app.current_tenant_id() AND p.user_id=app.current_user_id()
   AND p.termination_on::text=after_row->>'valid_to' AND (
    (TG_TABLE_NAME='assignment' AND p.employment_id=(before_row->>'employment_id')::uuid)
    OR (TG_TABLE_NAME='reporting_line' AND before_row->>'line_type'='administrative'
     AND p.employment_id IN ((before_row->>'subordinate_employment_id')::uuid,(before_row->>'manager_employment_id')::uuid)));
  IF FOUND THEN RETURN NEW; END IF;
 END IF;
 RAISE EXCEPTION 'Workforce structure maintenance unavailable' USING ERRCODE='42501';
END; $$;
