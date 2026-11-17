-- UNAPPROVED / UNAPPLIED / UNREGISTERED source proposal.6000 Shared capture is an explicit prerequisite.
-- Install reviewed6000→6001→6002→6003→6004→6005→6006→6007→6008 in order. No forward helper references.
-- INACTIVE EXECUTABLE PROPOSAL ONLY: UNAPPROVED / UNAPPLIED. NOT REGISTERED IN JOURNAL/PINS.
-- Foundation only: remaining concrete6002–6008 source components are required before use.
-- Accepted owners pinned to d50b1b7f849f870da15a2c07bb5f184ca3d1abf4 (5777/5778).
-- This proposes a NEW human-principal Contract-only kernel boundary, not authority in current code.
-- Public approval request leaves posting PENDING. Only one fixed genuine held kernel unit may invoke
-- existing approveContractSharedPostingTx, then canonical Movement, then private job_finish atomically.
-- No SET ROLE, fake HR role, substitute human, generic owner callback, public Payroll row grant, raw
-- monetary projection, new worker identity, timer decision, Payroll processing or closing is authorized.
-- The separately reviewed fixed handler uses a genuine transaction/savepoints and actual creator context.
-- Retrospective Contract invalidation deliberately uses native [intent.effective_on,NULL): root-approved
-- conservative stale marking only. Ordinary public Movement precise windows remain unchanged.

DO $$ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='app.preserve_payroll_metadata(uuid,boolean)'::regprocedure)<>'ac4f41da06954217c7552fb235995614'
 OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='app.workforce_payroll_inputs_changed_windows(uuid,jsonb,text)'::regprocedure)<>'d5ac5834052baced4d0092ac75258c66'
 THEN RAISE EXCEPTION 'Accepted payroll owner source drift: review before factoring';END IF;
END $$;
-- One reconstruction implementation, shared by the unchanged-authority public wrapper and fixed source owner.
CREATE FUNCTION app.preserve_payroll_metadata_owner(p_employment uuid,p_closed_only boolean,p_contract boolean)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $owner$
DECLARE e public.employment%ROWTYPE; a public.assignment%ROWTYPE; n integer; assignment_count integer;
BEGIN
 SELECT * INTO e FROM public.employment WHERE id=p_employment AND tenant_id=app.current_tenant_id() FOR UPDATE;

 -- An ended employment legitimately has no open assignment. Two open records is a data fault, not payroll history.
 SELECT count(*) INTO assignment_count FROM public.assignment WHERE employment_id=e.id AND tenant_id=e.tenant_id AND valid_to IS NULL AND superseded_at IS NULL;
 IF assignment_count>1 OR (assignment_count=0 AND e.terminated_on IS NULL) THEN
  RAISE EXCEPTION 'Historical assignment evidence requires reconciliation';
 END IF;
 SELECT * INTO a FROM public.assignment WHERE employment_id=e.id AND tenant_id=e.tenant_id AND valid_to IS NULL AND superseded_at IS NULL;
 IF EXISTS(SELECT 1 FROM public.payslip p JOIN public.payroll_batch b ON b.id=p.batch_id
 WHERE app.payroll_history_row_visible('payslip',p.id) AND p.employment_id=e.id AND (NOT p_closed_only OR b.status='closed') AND (p.tenant_id<>e.tenant_id OR b.tenant_id<>e.tenant_id OR NOT (CASE WHEN p_contract THEN true ELSE app.is_admin_for(b.company_id) END))) THEN
  RAISE EXCEPTION 'Historical payroll company permission is required' USING ERRCODE='42501';
 END IF;
 INSERT INTO public.information_payslip_snapshot(payslip_id,tenant_id,employment_id,company_id,grade,employment_type,hired_on,join_date,document_metadata,recorded_by)
 SELECT s.id,e.tenant_id,e.id,s.company_id,
  CASE WHEN gr.found THEN hg.name ELSE g.name END,
  coalesce(ha.employment_type::text,a.employment_type::text),
  CASE WHEN ho.found THEN ho.value::date ELSE e.hired_on END,
  CASE WHEN jo.found THEN jo.value::date ELSE e.join_date END,
  app.information_document_metadata(s.id)
   ||CASE WHEN ha.id IS NOT NULL THEN jsonb_build_object('businessUnit',hbu.name,'department',hd.name,'position',hpos.title,'employmentType',ha.employment_type) ELSE '{}'::jsonb END
   ||CASE WHEN gr.found THEN jsonb_build_object('jobGrade',hg.name) ELSE '{}'::jsonb END
   ||jsonb_build_object('preservationActor',CASE WHEN app.current_user_id() IS NULL THEN 'system' ELSE 'user' END)
   ||jsonb_build_object('snapshotBasis',jsonb_build_object(
     'at',s.t,
     'reconstructed',to_jsonb(array_remove(ARRAY[CASE WHEN ho.found THEN 'hiredOn' END,CASE WHEN jo.found THEN 'joinDate' END,CASE WHEN gr.found THEN 'jobGrade' END,
       CASE WHEN ha.id IS NOT NULL THEN 'employmentType' END,CASE WHEN ha.id IS NOT NULL THEN 'businessUnit' END,CASE WHEN ha.id IS NOT NULL THEN 'department' END,CASE WHEN ha.id IS NOT NULL THEN 'position' END],NULL)),
     'unchangedSince',to_jsonb(array_remove(ARRAY[CASE WHEN NOT ho.found THEN 'hiredOn' END,CASE WHEN NOT jo.found THEN 'joinDate' END,CASE WHEN NOT gr.found THEN 'jobGrade' END],NULL)),
     'asDisplayed',to_jsonb(CASE WHEN ha.id IS NULL THEN ARRAY['employmentType','businessUnit','department','position'] ELSE ARRAY[]::text[] END))),
  app.current_user_id()
 FROM (SELECT p.id,b.company_id,coalesce(b.closed_at,b.created_at) AS t FROM public.payslip p JOIN public.payroll_batch b ON b.id=p.batch_id
   WHERE app.payroll_history_row_visible('payslip',p.id) AND p.employment_id=e.id
   AND (NOT p_closed_only OR b.status='closed')
   AND NOT EXISTS(SELECT 1 FROM public.information_payslip_snapshot f WHERE f.payslip_id=p.id)) s
 LEFT JOIN public.job_grade g ON g.id=e.grade_id AND g.tenant_id=e.tenant_id
 -- Job Grade before the first recorded grade change after T.
 LEFT JOIN LATERAL (SELECT true AS found,CASE WHEN ev.event_type='employment.grade.changed' THEN ev.payload->>'before' ELSE ev.payload->'before'->>'gradeId' END AS value
   FROM public.domain_event ev WHERE ev.tenant_id=e.tenant_id AND ev.subject_employment_id=e.id AND ev.occurred_at>s.t
   AND (ev.event_type='employment.grade.changed' OR (ev.event_type='employment.information.corrected' AND ev.payload->'fields' ? 'gradeId'))
   ORDER BY ev.sequence LIMIT 1) gr0 ON true
 LEFT JOIN LATERAL (SELECT coalesce(gr0.found,false) AS found,gr0.value) gr ON true
 LEFT JOIN public.job_grade hg ON gr.found AND hg.id=gr.value::uuid AND hg.tenant_id=e.tenant_id
 -- Group Join Date before the first recorded change of it after T.
 LEFT JOIN LATERAL (SELECT true AS found,ev.payload->'before'->>'hiredOn' AS value
   FROM public.domain_event ev WHERE ev.tenant_id=e.tenant_id AND ev.subject_employment_id=e.id AND ev.occurred_at>s.t
   AND ev.event_type IN ('employment.info.updated','employment.information.corrected') AND ev.payload->'fields' ? 'hiredOn'
   AND ev.payload->'before'->>'hiredOn' IS NOT NULL
   ORDER BY ev.sequence LIMIT 1) ho0 ON true
 LEFT JOIN LATERAL (SELECT coalesce(ho0.found,false) AS found,ho0.value) ho ON true
 -- Join Date before the first recorded change of it after T (a null Join Date is a recorded value).
 LEFT JOIN LATERAL (SELECT true AS found,ev.payload->'before'->>'joinDate' AS value
   FROM public.domain_event ev WHERE ev.tenant_id=e.tenant_id AND ev.subject_employment_id=e.id AND ev.occurred_at>s.t
   AND ev.event_type IN ('employment.info.updated','employment.information.corrected') AND ev.payload->'fields' ? 'joinDate'
   AND ev.payload->'before' ? 'joinDate'
   ORDER BY ev.sequence LIMIT 1) jo0 ON true
 LEFT JOIN LATERAL (SELECT coalesce(jo0.found,false) AS found,jo0.value) jo ON true
 -- The assignment that was the open record at T (what the document read then): existed by T, not yet superseded,
 -- started by T's date and not ended by it. None (the employment had ended, or a later backdated change closed it
 -- before T's date) keeps the record as displayed today: a value the document never showed is never invented.
 LEFT JOIN LATERAL (SELECT x.id,x.employment_type,x.business_unit_id,x.department_id,x.position_id FROM public.assignment x
   WHERE x.employment_id=e.id AND x.tenant_id=e.tenant_id AND x.created_at<=s.t AND (x.superseded_at IS NULL OR x.superseded_at>s.t)
   AND x.valid_from<=(s.t AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (x.valid_to IS NULL OR x.valid_to>(s.t AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
   ORDER BY x.valid_from DESC,x.created_at DESC LIMIT 1) ha ON true
 LEFT JOIN public.business_unit hbu ON hbu.id=ha.business_unit_id
 LEFT JOIN public.department hd ON hd.id=ha.department_id
 LEFT JOIN public.position hpos ON hpos.id=ha.position_id
 ON CONFLICT(payslip_id) DO NOTHING;
 SELECT count(*) INTO n FROM public.payslip p JOIN public.payroll_batch b ON b.id=p.batch_id
 WHERE app.payroll_history_row_visible('payslip',p.id) AND p.employment_id=e.id AND (NOT p_closed_only OR b.status='closed');
 IF n<>(SELECT count(*) FROM public.information_payslip_snapshot f JOIN public.payroll_batch b ON b.id=(SELECT p.batch_id FROM public.payslip p WHERE p.id=f.payslip_id) WHERE f.employment_id=e.id AND (NOT p_closed_only OR b.status='closed')) THEN
  RAISE EXCEPTION 'Historical metadata coverage is incomplete';
 END IF;
 RETURN n;
END $owner$;
REVOKE ALL ON FUNCTION app.preserve_payroll_metadata_owner(uuid,boolean,boolean) FROM PUBLIC,ai_hr_app;
-- Same OID, exact accepted public authorization. No Contract OR is added to the public maintain API.
CREATE OR REPLACE FUNCTION app.preserve_payroll_metadata(p_employment uuid,p_closed_only boolean) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE e public.employment;
BEGIN
 SELECT * INTO e FROM public.employment WHERE id=p_employment AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND OR NOT (app.principal_snapshot_current() AND app.current_user_id() IS NOT NULL AND app.is_admin_for(e.company_id)
 OR p_closed_only AND app.access_workforce_owner_company(e.company_id))
 OR NOT app.access_workforce_employment(e.id,'workforce.maintain') THEN
  RAISE EXCEPTION 'Information correction unavailable' USING ERRCODE='42501';
 END IF;
 RETURN app.preserve_payroll_metadata_owner(p_employment,p_closed_only,false);
END $$;
REVOKE ALL ON FUNCTION app.preserve_payroll_metadata(uuid,boolean) FROM PUBLIC,ai_hr_app;

-- One accepted stale-marking implementation. All native key/window/category checks stay in this owner.
CREATE FUNCTION app.workforce_payroll_inputs_changed_windows_owner(wanted uuid,p_windows jsonb,category text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $owner$
DECLARE t uuid:=app.current_tenant_id(); n integer;
BEGIN
 IF category IS NULL OR category NOT IN ('employment_information','transfer','compensation','hire_date','termination','statutory')
  OR p_windows IS NULL OR jsonb_typeof(p_windows)<>'array' OR jsonb_array_length(p_windows) NOT BETWEEN 1 AND 64
  OR EXISTS(SELECT 1 FROM jsonb_to_recordset(p_windows) AS r("from" date,until date) WHERE r."from" IS NULL OR r.until<=r."from")
  OR coalesce(app.access_lock_mode_held(t),'') NOT IN ('S','X') THEN
  RAISE EXCEPTION 'Payroll input invalidation unavailable' USING ERRCODE='42501';
 END IF;
 -- The native writer must own ALL current/former payroll-input keys before it changes rows.
 -- A public EXECUTE grant supplies neither the Access barrier nor payroll-input serialization.
 IF EXISTS(SELECT 1 FROM app.payroll_input_lock_keys(ARRAY[wanted],NULL) AS keys(key) WHERE NOT EXISTS(
  SELECT 1 FROM pg_catalog.pg_locks l WHERE l.pid=pg_backend_pid() AND l.locktype='advisory'
   AND l.granted AND l.objsubid=1 AND l.mode IN ('ShareLock','ExclusiveLock')
   AND ((l.classid::bigint<<32)|l.objid::bigint)=hashtextextended(keys.key,0))) THEN
  RAISE EXCEPTION 'Payroll inputs must be serialized before invalidation' USING ERRCODE='42501';
 END IF;
 WITH locked AS MATERIALIZED (
  SELECT b.id FROM public.payroll_batch b WHERE b.tenant_id=t AND b.status IN ('processed','processing')
   AND EXISTS(SELECT 1 FROM jsonb_to_recordset(p_windows) AS r("from" date,until date)
    WHERE b.pay_period>=to_char(r."from",'YYYY-MM') AND (r.until IS NULL OR b.pay_period<=to_char(r.until-1,'YYYY-MM')))
   AND EXISTS(SELECT 1 FROM public.payslip p WHERE p.tenant_id=t AND p.batch_id=b.id AND p.employment_id=wanted
    AND app.payroll_history_row_visible('payslip',p.id))
  ORDER BY b.id FOR UPDATE
 ), changed AS (
  UPDATE public.payroll_batch b SET needs_recalc_at=coalesce(b.needs_recalc_at,now()),
   recalc_employment_ids=(SELECT jsonb_agg(DISTINCT item.value ORDER BY item.value) FROM jsonb_array_elements_text(coalesce(b.recalc_employment_ids,'[]'::jsonb)||to_jsonb(ARRAY[wanted])) AS item(value))
  FROM locked l WHERE b.id=l.id AND b.status IN ('processed','processing') RETURNING b.id,b.recalc_employment_ids
 ) INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
  SELECT t,'payroll-batch',c.id,'payroll-batch.recalc-required',
   (CASE WHEN app.current_user_id() IS NULL THEN 'system' ELSE 'user' END)::public.actor_type,app.current_user_id(),
   jsonb_build_object('employmentIds',c.recalc_employment_ids,'addedEmploymentIds',ARRAY[wanted],
    'changeCategory',category,'windows',p_windows)
  FROM changed c;
 GET DIAGNOSTICS n=ROW_COUNT;
 RETURN n;
END $owner$;
REVOKE ALL ON FUNCTION app.workforce_payroll_inputs_changed_windows_owner(uuid,jsonb,text) FROM PUBLIC,ai_hr_app;
CREATE OR REPLACE FUNCTION app.workforce_payroll_inputs_changed_windows(wanted uuid,p_windows jsonb,category text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT app.access_workforce_employment(wanted,'workforce.maintain') THEN RAISE EXCEPTION 'Payroll input invalidation unavailable' USING ERRCODE='42501';END IF;
 RETURN app.workforce_payroll_inputs_changed_windows_owner(wanted,p_windows,category);
END $$;
-- Existing EXECUTE grants on this same public OID remain; the private owner has none.

INSERT INTO public.bulk_job_kind(kind,scope_kind,exclusive,input_shape,input_max_bytes,finalize_owner)
VALUES('contract_posting_apply',NULL,'none','{"postingId":"string"}'::jsonb,4096,true);
CREATE TABLE app.contract_posting_job_source(
 tenant_id uuid NOT NULL,job_id uuid PRIMARY KEY REFERENCES public.bulk_job(id),operation_key uuid NOT NULL,
 posting_id uuid NOT NULL,posting_revision integer NOT NULL,requested_values jsonb NOT NULL,values_hash bytea NOT NULL,
 requester_user_id uuid NOT NULL,requester_person_id uuid NOT NULL,company_id uuid NOT NULL,employment_id uuid NOT NULL,
 subject_person_id uuid NOT NULL,case_id uuid NOT NULL,decision_revision integer NOT NULL,letter_id uuid NOT NULL,
 source_revision text NOT NULL,requested_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,posting_id) REFERENCES public.contract_shared_posting(tenant_id,posting_id)
);
CREATE INDEX contract_posting_job_source_posting ON app.contract_posting_job_source(tenant_id,posting_id,requested_at,job_id);
CREATE TABLE app.contract_posting_job_tx(
 tenant_id uuid NOT NULL,job_id uuid NOT NULL,posting_id uuid NOT NULL,employment_id uuid NOT NULL,
 actor_user_id uuid NOT NULL,actor_person_id uuid NOT NULL,xact_id bigint NOT NULL,backend_pid integer NOT NULL,login_name text NOT NULL,
 original_employment jsonb NOT NULL,original_assignment jsonb NOT NULL,source_hash bytea NOT NULL,
 ledger_max_sequence bigint NOT NULL,ledger_hash bytea NOT NULL,
 protected boolean NOT NULL DEFAULT false,intent_hash bytea,preserved_count integer,
 PRIMARY KEY(tenant_id,xact_id,backend_pid,employment_id),FOREIGN KEY(job_id) REFERENCES app.contract_posting_job_source(job_id)
);
CREATE TABLE app.contract_posting_job_result(
 tenant_id uuid NOT NULL,job_id uuid PRIMARY KEY REFERENCES app.contract_posting_job_source(job_id),posting_id uuid NOT NULL,
 movement_group_id uuid NOT NULL,scheduled boolean NOT NULL,applied boolean NOT NULL,completed_at timestamptz NOT NULL DEFAULT now(),
 finished_xid bigint NOT NULL,backend_pid integer NOT NULL,login_name text NOT NULL,source_hash bytea NOT NULL,intent_hash bytea NOT NULL,
 posting_hash bytea NOT NULL,receipt_hash bytea NOT NULL,employment_hash bytea NOT NULL,assignment_hash bytea NOT NULL,
 ledger_max_sequence bigint NOT NULL,ledger_hash bytea NOT NULL,admitted_input_digest bytea NOT NULL,admitted_plan_digest bytea NOT NULL
);
ALTER TABLE app.contract_posting_job_source ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.contract_posting_job_source FORCE ROW LEVEL SECURITY;
ALTER TABLE app.contract_posting_job_tx ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.contract_posting_job_tx FORCE ROW LEVEL SECURITY;
ALTER TABLE app.contract_posting_job_result ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.contract_posting_job_result FORCE ROW LEVEL SECURITY;
CREATE POLICY contract_posting_job_source_owner ON app.contract_posting_job_source FOR ALL TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
CREATE POLICY contract_posting_job_tx_owner ON app.contract_posting_job_tx FOR ALL TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
CREATE POLICY contract_posting_job_result_owner ON app.contract_posting_job_result FOR ALL TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
REVOKE ALL ON app.contract_posting_job_source,app.contract_posting_job_tx,app.contract_posting_job_result FROM PUBLIC,ai_hr_app;
GRANT SELECT,INSERT ON app.contract_posting_job_source,app.contract_posting_job_result TO ai_hr_owner;
GRANT SELECT,INSERT,UPDATE ON app.contract_posting_job_tx TO ai_hr_owner;

-- Enqueue inserts the physical job before its private source row in the same transaction. A deferred
-- owner constraint makes a generic app.bulk_job_enqueue('contract_posting_apply',...) fail at COMMIT
-- without that genuine private admission. No unbound job can become visible to a physical worker.
CREATE FUNCTION app.contract_posting_job_admission() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.kind<>'contract_posting_apply' THEN RETURN NULL;END IF;
 IF NOT EXISTS(SELECT 1 FROM app.contract_posting_job_source source
  JOIN public.app_user actor ON actor.tenant_id=source.tenant_id AND actor.id=source.requester_user_id AND actor.person_id=source.requester_person_id
  JOIN app.bulk_job_seal seal ON seal.tenant_id=source.tenant_id AND seal.job_id=source.job_id
  WHERE source.tenant_id=NEW.tenant_id AND source.job_id=NEW.id AND source.operation_key=NEW.operation_key
  AND NEW.created_by=source.requester_user_id AND NEW.context->>'tenantId'=source.tenant_id::text
  AND NEW.context->>'userId'=source.requester_user_id::text AND NEW.input=jsonb_build_object('postingId',source.posting_id)
  AND seal.input_digest=app.bulk_job_value_digest(NEW.input) AND source.values_hash=app.bulk_job_value_digest(source.requested_values))
 THEN RAISE EXCEPTION 'Private Contract posting admission required' USING ERRCODE='42501';END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.contract_posting_job_admission() FROM PUBLIC,ai_hr_app;
CREATE CONSTRAINT TRIGGER contract_posting_job_admission AFTER INSERT ON public.bulk_job
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.contract_posting_job_admission();

-- Read-only admission facts: no decision, approval, Personnel or Payroll mutation occurs here.
CREATE FUNCTION app.contract_posting_request_values(p_id uuid,p_revision integer,p_values jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.personnel_posting;r public.contract_shared_posting;c public.contract_case;f public.contract_shared_case;e public.employment;letter public.contract_shared_letter;chosen jsonb;
BEGIN
 SELECT * INTO p FROM public.personnel_posting WHERE tenant_id=app.current_tenant_id() AND id=p_id;
 SELECT * INTO r FROM public.contract_shared_posting WHERE tenant_id=p.tenant_id AND posting_id=p.id;
 SELECT * INTO c FROM public.contract_case WHERE tenant_id=r.tenant_id AND id=r.case_id;
 SELECT * INTO f FROM public.contract_shared_case WHERE tenant_id=c.tenant_id AND case_id=c.id;
 SELECT * INTO e FROM public.employment WHERE tenant_id=p.tenant_id AND id=p.employment_id;
 SELECT * INTO letter FROM public.contract_shared_letter WHERE tenant_id=r.tenant_id AND id=r.letter_id;
 IF p.id IS NULL OR r.posting_id IS NULL OR p.source<>'contract_staff' OR p.status<>'pending' OR p.revision IS DISTINCT FROM p_revision
 OR app.principal_snapshot_current() IS NOT TRUE OR app.current_user_id() IS NULL OR app.contract_verified_human(app.current_user_id()) IS NOT TRUE
 OR app.contract_actor_person(app.current_user_id()) IS NULL OR app.contract_shared_posting_approver(p.company_id) IS NOT TRUE
 OR e.id IS NULL OR e.person_id IS DISTINCT FROM r.subject_person_id OR e.company_id IS DISTINCT FROM p.company_id
 OR e.voided_at IS NOT NULL OR e.blacklisted_at IS NOT NULL OR e.terminated_on IS NOT NULL
 OR c.employment_id IS DISTINCT FROM e.id OR c.company_id IS DISTINCT FROM p.company_id OR c.id IS DISTINCT FROM p.source_ref
 OR c.source_conflict IS NOT NULL OR r.source_revision IS DISTINCT FROM app.contract_shared_period_revision(e.id)
 OR app.contract_shared_native_intake_hold(e.id) IS NOT NULL
 OR app.contract_shared_posting_workflow_ready(p.id) IS NOT TRUE
 OR (f.data->'decision'->>'revision')::integer IS DISTINCT FROM r.decision_revision
 OR app.contract_shared_decision_current(f.case_id,r.decision_revision) IS NOT TRUE OR f.data->'declined' IS DISTINCT FROM 'null'::jsonb
 OR letter.id IS NULL OR letter.case_id IS DISTINCT FROM c.id OR letter.decision_revision IS DISTINCT FROM r.decision_revision
 OR letter.purpose IS DISTINCT FROM 'outcome' OR letter.data->>'state' IS DISTINCT FROM 'released' OR letter.data->'valuesFixed' IS DISTINCT FROM 'true'::jsonb
 THEN RAISE EXCEPTION 'The current pending Contract posting needs review' USING ERRCODE='40001';END IF;
 chosen:=coalesce(p_values,p.edited,p.proposed);
 IF app.personnel_posting_values_ok(p.event_type,chosen) IS NOT TRUE OR (chosen-'remarks') IS DISTINCT FROM (p.proposed-'remarks')
 THEN RAISE EXCEPTION 'Use the exact released agreement values' USING ERRCODE='22023';END IF;
 RETURN chosen;
END $$;
REVOKE ALL ON FUNCTION app.contract_posting_request_values(uuid,integer,jsonb) FROM PUBLIC,ai_hr_app;

-- NEW, explicitly reviewed metadata-only app port. This is NOT the existing synchronous approve function.
CREATE FUNCTION app.contract_posting_job_held(p_job uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(EXISTS(SELECT 1 FROM pg_roles runner WHERE runner.rolname=session_user AND (runner.rolname='ai_hr_owner' OR runner.rolsuper))
 AND app.bulk_job_capability_held(p_job) AND app.principal_snapshot_current()
 AND EXISTS(SELECT 1 FROM app.contract_posting_job_source source
 JOIN public.bulk_job job ON job.tenant_id=source.tenant_id AND job.id=source.job_id
 JOIN public.bulk_job_kind kind ON kind.kind=job.kind AND kind.finalize_owner
 JOIN app.bulk_job_seal seal ON seal.tenant_id=job.tenant_id AND seal.job_id=job.id
 JOIN public.personnel_posting p ON p.tenant_id=source.tenant_id AND p.id=source.posting_id
 JOIN public.contract_shared_posting r ON r.tenant_id=p.tenant_id AND r.posting_id=p.id
 JOIN public.employment e ON e.tenant_id=p.tenant_id AND e.id=p.employment_id
 WHERE source.tenant_id=app.current_tenant_id() AND source.job_id=p_job AND p_job::text=current_setting('app.bulk_job',true)
 AND job.kind='contract_posting_apply' AND job.created_by=source.requester_user_id AND app.current_user_id()=source.requester_user_id
 AND job.context->>'tenantId'=source.tenant_id::text AND job.context->>'userId'=source.requester_user_id::text
 AND app.contract_verified_human(source.requester_user_id) AND app.contract_actor_person(source.requester_user_id)=source.requester_person_id
 AND app.contract_binding_person(source.requester_user_id)=source.requester_person_id AND app.contract_shared_posting_approver(source.company_id)
 AND job.operation_key=source.operation_key AND job.input=jsonb_build_object('postingId',source.posting_id)
 AND seal.input_digest=app.bulk_job_value_digest(job.input) AND seal.plan_digest=app.bulk_job_value_digest(job.plan)
 AND job.state='finalizing' AND job.cancel_requested_at IS NULL AND job.lease_expires_at>clock_timestamp()
 AND p.company_id=source.company_id AND p.employment_id=source.employment_id AND p.source='contract_staff' AND p.source_ref=source.case_id
 AND r.case_id=source.case_id AND r.decision_revision=source.decision_revision AND r.letter_id=source.letter_id AND r.source_revision=source.source_revision
 AND r.subject_person_id=source.subject_person_id AND e.person_id=source.subject_person_id AND e.company_id=source.company_id),false)
$$;
REVOKE ALL ON FUNCTION app.contract_posting_job_held(uuid) FROM PUBLIC,ai_hr_app;

CREATE FUNCTION app.contract_posting_job_tx_held(p_job uuid,p_employment uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.contract_posting_job_held(p_job) AND EXISTS(SELECT 1 FROM app.contract_posting_job_tx x WHERE x.tenant_id=app.current_tenant_id()
 AND x.job_id=p_job AND x.employment_id=p_employment AND x.xact_id=txid_current() AND x.backend_pid=pg_backend_pid() AND x.login_name=session_user
 AND x.actor_user_id=app.current_user_id() AND x.actor_person_id=app.contract_actor_person(app.current_user_id()))
$$;
REVOKE ALL ON FUNCTION app.contract_posting_job_tx_held(uuid,uuid) FROM PUBLIC,ai_hr_app;

-- Native legal-company boundary, independent of paying-company metadata. Prefer explicit actual dated
-- Assignment evidence. A legacy NULL company may fall back to current company ONLY where no recorded
-- company change contradicts that invariant. Ambiguous/missing evidence refuses; no past company is guessed.
CREATE FUNCTION app.contract_posting_asof_legal_company(p_employment uuid,p_day date) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE current_company uuid;dated_company uuid;n integer;
BEGIN
 SELECT company_id INTO current_company FROM public.employment WHERE tenant_id=app.current_tenant_id() AND id=p_employment;
 IF current_company IS NULL OR p_day IS NULL THEN RETURN NULL;END IF;
 SELECT count(*),min(a.company_id::text)::uuid INTO n,dated_company FROM public.assignment a
 WHERE a.tenant_id=app.current_tenant_id() AND a.employment_id=p_employment AND a.superseded_at IS NULL
 AND a.valid_from<=p_day AND (a.valid_to IS NULL OR a.valid_to>p_day);
 IF n<>1 THEN RETURN NULL;END IF;
 IF dated_company IS NOT NULL THEN RETURN dated_company;END IF;
 IF EXISTS(SELECT 1 FROM public.assignment a WHERE a.tenant_id=app.current_tenant_id() AND a.employment_id=p_employment
  AND a.company_id IS NOT NULL AND a.company_id<>current_company)
 OR EXISTS(SELECT 1 FROM public.domain_event event WHERE event.tenant_id=app.current_tenant_id() AND event.subject_employment_id=p_employment
  AND (event.event_type IN('employment.company.transferred','employment.company.transfer.reverted')
   OR (event.event_type IN('employment.information.corrected','employment.history.recorded','employment.history.reverted')
    AND (event.payload->'fields' ? 'companyId' OR event.payload->'before'->>'companyId' IS DISTINCT FROM event.payload->'after'->>'companyId'))))
 THEN RETURN NULL;END IF;
 RETURN current_company;
END $$;
REVOKE ALL ON FUNCTION app.contract_posting_asof_legal_company(uuid,date) FROM PUBLIC,ai_hr_app;

-- Internal audit-prefix seal, not a second chronology planner. Original committed events remain immutable;
-- the fixed canonical TS owner derives replay ONLY from these actual records and never from request JSON.
CREATE FUNCTION app.contract_posting_ledger_hash(p_employment uuid,p_until bigint) RETURNS bytea
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT sha256(convert_to(coalesce(string_agg(encode(sha256(convert_to(jsonb_build_array(d.id,d.sequence,d.aggregate_type,d.aggregate_id,
 d.event_type,d.actor_type,d.actor_id,d.subject_employment_id,d.payload,d.occurred_at)::text,'UTF8')),'hex'),'|' ORDER BY d.sequence),''),'UTF8'))
 FROM public.domain_event d WHERE d.tenant_id=app.current_tenant_id() AND d.subject_employment_id=p_employment AND d.sequence<=p_until
$$;
REVOKE ALL ON FUNCTION app.contract_posting_ledger_hash(uuid,bigint) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.contract_posting_original_source_intact(p_job uuid,p_employment uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.contract_posting_job_tx_held(p_job,p_employment) AND EXISTS(
 SELECT 1 FROM app.contract_posting_job_tx x JOIN app.contract_posting_job_source source ON source.tenant_id=x.tenant_id AND source.job_id=x.job_id
 WHERE x.tenant_id=app.current_tenant_id() AND x.job_id=p_job AND x.employment_id=p_employment
 AND x.xact_id=txid_current() AND x.backend_pid=pg_backend_pid() AND x.login_name=session_user
 AND x.source_hash=app.bulk_job_value_digest(jsonb_build_array(x.original_employment,x.original_assignment,source.posting_id,
 source.posting_revision,source.values_hash,source.company_id,source.subject_person_id,x.ledger_max_sequence,x.ledger_hash))
 AND x.ledger_hash=app.contract_posting_ledger_hash(p_employment,x.ledger_max_sequence)
 AND NOT EXISTS(SELECT 1 FROM public.domain_event added WHERE added.tenant_id=x.tenant_id AND added.subject_employment_id=p_employment
 AND added.sequence>x.ledger_max_sequence AND (added.actor_type<>'user' OR added.actor_id IS DISTINCT FROM x.actor_user_id
  OR added.payload->'bulkJob'->>'id' IS DISTINCT FROM p_job::text OR added.payload->'bulkJob'->>'kind' IS DISTINCT FROM 'contract_posting_apply')))
$$;
REVOKE ALL ON FUNCTION app.contract_posting_original_source_intact(uuid,uuid) FROM PUBLIC,ai_hr_app;

-- Fixed kernel begin: lock Access, sorted payroll-input keys, statutory/source rows, then revalidate pending request.
-- It does NOT approve. The fixed TS handler subsequently invokes existing approveContractSharedPostingTx
-- in this SAME real owner transaction, so approved_at=now() satisfies existing native freshness unchanged.
CREATE FUNCTION app.contract_posting_job_begin(p_job uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source app.contract_posting_job_source;prior app.contract_posting_job_result;key text;chosen jsonb;
 original_e public.employment;original_a public.assignment;assignment_count integer;ledger_max bigint;ledger_digest bytea;source_digest bytea;
BEGIN
 IF app.contract_posting_job_held(p_job) IS NOT TRUE THEN RAISE EXCEPTION 'Actual Contract application job required' USING ERRCODE='42501';END IF;
 SELECT * INTO source FROM app.contract_posting_job_source WHERE tenant_id=app.current_tenant_id() AND job_id=p_job;
 SELECT * INTO prior FROM app.contract_posting_job_result WHERE tenant_id=source.tenant_id AND job_id=p_job;
 IF prior.job_id IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM public.personnel_posting p JOIN public.contract_shared_posting r ON r.tenant_id=p.tenant_id AND r.posting_id=p.id
   WHERE p.tenant_id=source.tenant_id AND p.id=source.posting_id AND p.status='approved' AND p.movement_id IS NOT NULL
   AND r.movement_group_id=prior.movement_group_id AND (prior.scheduled OR r.applied_at IS NOT NULL))
  THEN RAISE EXCEPTION 'The recorded Contract application changed' USING ERRCODE='40001';END IF;
  RETURN jsonb_build_object('completed',true,'postingId',source.posting_id,'employmentId',source.employment_id,'groupId',prior.movement_group_id,'scheduled',prior.scheduled,'applied',prior.applied);
 END IF;
 PERFORM app.access_workforce_write_lock();
 FOR key IN SELECT keys.key FROM app.payroll_input_lock_keys(ARRAY[source.employment_id]::uuid[],NULL) AS keys(key) ORDER BY keys.key LOOP
  IF NOT pg_try_advisory_xact_lock_shared(hashtextextended(key,0)) THEN RAISE EXCEPTION 'Payroll inputs are busy; retry this posting' USING ERRCODE='55P03';END IF;
 END LOOP;
 -- This unchanged canonical prelock owns statutory and Employment rows in the accepted lock family.
 PERFORM app.contract_shared_posting_prelock(source.posting_id);
 PERFORM 1 FROM public.personnel_posting WHERE tenant_id=source.tenant_id AND id=source.posting_id FOR UPDATE;
 chosen:=app.contract_posting_request_values(source.posting_id,source.posting_revision,source.requested_values);
 IF app.bulk_job_value_digest(chosen) IS DISTINCT FROM source.values_hash THEN RAISE EXCEPTION 'The requested agreement changed' USING ERRCODE='40001';END IF;
 IF app.contract_posting_asof_legal_company(source.employment_id,(chosen->>'effectiveDate')::date) IS DISTINCT FROM source.company_id
 THEN RAISE EXCEPTION 'The Contract legal company at its effective date needs reconciliation' USING ERRCODE='40001';END IF;
 SELECT * INTO original_e FROM public.employment WHERE tenant_id=source.tenant_id AND id=source.employment_id FOR UPDATE;
 SELECT count(*) INTO assignment_count FROM public.assignment WHERE tenant_id=source.tenant_id AND employment_id=source.employment_id AND superseded_at IS NULL AND valid_to IS NULL;
 IF assignment_count<>1 THEN RAISE EXCEPTION 'Current assignment evidence requires reconciliation' USING ERRCODE='40001';END IF;
 SELECT * INTO original_a FROM public.assignment WHERE tenant_id=source.tenant_id AND employment_id=source.employment_id AND superseded_at IS NULL AND valid_to IS NULL FOR UPDATE;
 SELECT coalesce(max(sequence),0) INTO ledger_max FROM public.domain_event WHERE tenant_id=source.tenant_id AND subject_employment_id=source.employment_id;
 ledger_digest:=app.contract_posting_ledger_hash(source.employment_id,ledger_max);
 source_digest:=app.bulk_job_value_digest(jsonb_build_array(to_jsonb(original_e),to_jsonb(original_a),source.posting_id,source.posting_revision,
  source.values_hash,source.company_id,source.subject_person_id,ledger_max,ledger_digest));
 INSERT INTO app.contract_posting_job_tx(tenant_id,job_id,posting_id,employment_id,actor_user_id,actor_person_id,xact_id,backend_pid,login_name,
 original_employment,original_assignment,source_hash,ledger_max_sequence,ledger_hash)
 VALUES(source.tenant_id,p_job,source.posting_id,source.employment_id,source.requester_user_id,source.requester_person_id,txid_current(),pg_backend_pid(),session_user,
 to_jsonb(original_e),to_jsonb(original_a),source_digest,ledger_max,ledger_digest);
 RETURN jsonb_build_object('completed',false,'postingId',source.posting_id,'employmentId',source.employment_id,
 'revision',source.posting_revision,'values',chosen,'caseId',source.case_id,'companyId',source.company_id,'subjectPersonId',source.subject_person_id,
 'decisionRevision',source.decision_revision,'sourceRevision',source.source_revision);
END $$;
REVOKE ALL ON FUNCTION app.contract_posting_job_begin(uuid) FROM PUBLIC,ai_hr_app;

-- BEFORE ANY inverse: protect the actual original current source, not the later as-of intent image.
-- This may run before or after canonical approval in the SAME real job transaction, but always before
-- chronology changes. No Contract posting intent is required yet; its later-assignment date guard remains
-- unchanged and will be evaluated only after the canonical inverse has placed the actual target state.
CREATE FUNCTION app.contract_posting_job_protect(p_job uuid,p_employment uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE x app.contract_posting_job_tx;e public.employment;a public.assignment;source app.contract_posting_job_source;n integer;
BEGIN
 IF app.contract_posting_original_source_intact(p_job,p_employment) IS NOT TRUE THEN RAISE EXCEPTION 'Exact immutable Contract payroll source required' USING ERRCODE='42501';END IF;
 IF coalesce(app.access_lock_mode_held(app.current_tenant_id()),'') NOT IN('S','X') OR EXISTS(
  SELECT 1 FROM app.payroll_input_lock_keys(ARRAY[p_employment]::uuid[],NULL) AS keys(key) WHERE NOT EXISTS(
   SELECT 1 FROM pg_catalog.pg_locks locks WHERE locks.pid=pg_backend_pid() AND locks.locktype='advisory'
   AND locks.granted AND locks.objsubid=1 AND locks.mode IN('ShareLock','ExclusiveLock')
   AND ((locks.classid::bigint<<32)|locks.objid::bigint)=hashtextextended(keys.key,0)))
 THEN RAISE EXCEPTION 'Serialize all native payroll input keys before preservation' USING ERRCODE='42501';END IF;
 SELECT * INTO x FROM app.contract_posting_job_tx WHERE tenant_id=app.current_tenant_id() AND job_id=p_job AND employment_id=p_employment
 AND xact_id=txid_current() AND backend_pid=pg_backend_pid() AND login_name=session_user FOR UPDATE;
 SELECT * INTO source FROM app.contract_posting_job_source WHERE tenant_id=x.tenant_id AND job_id=p_job;
 IF x.protected THEN RETURN x.preserved_count;END IF;
 SELECT * INTO e FROM public.employment WHERE tenant_id=x.tenant_id AND id=p_employment FOR UPDATE;
 SELECT * INTO a FROM public.assignment WHERE tenant_id=x.tenant_id AND employment_id=p_employment AND superseded_at IS NULL AND valid_to IS NULL;
 IF to_jsonb(e) IS DISTINCT FROM x.original_employment OR to_jsonb(a) IS DISTINCT FROM x.original_assignment
 THEN RAISE EXCEPTION 'Preserve issued Payroll before any inverse or Personnel change' USING ERRCODE='42501';END IF;
 IF app.contract_posting_asof_legal_company(p_employment,(source.requested_values->>'effectiveDate')::date) IS DISTINCT FROM source.company_id
 THEN RAISE EXCEPTION 'Do not apply current-company Contract fields to another dated legal employer' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT 1 FROM public.payslip p JOIN public.payroll_batch b ON b.id=p.batch_id
 WHERE p.employment_id=p_employment AND (p.tenant_id<>x.tenant_id OR b.tenant_id<>x.tenant_id OR NOT app.payroll_history_row_visible('payslip',p.id)))
 THEN RAISE EXCEPTION 'Issued payroll metadata is unavailable for reconstruction' USING ERRCODE='42501';END IF;
 n:=app.preserve_payroll_metadata_owner(p_employment,false,true);
 IF EXISTS(SELECT 1 FROM public.payslip p JOIN public.payroll_batch b ON b.id=p.batch_id
 WHERE p.employment_id=p_employment AND (p.tenant_id<>x.tenant_id OR b.tenant_id<>x.tenant_id OR NOT EXISTS(
  SELECT 1 FROM public.information_payslip_snapshot snapshot WHERE snapshot.payslip_id=p.id AND snapshot.tenant_id=x.tenant_id
  AND snapshot.employment_id=p_employment AND snapshot.company_id=b.company_id)))
 THEN RAISE EXCEPTION 'Historical metadata coverage is incomplete' USING ERRCODE='42501';END IF;
 UPDATE app.contract_posting_job_tx SET protected=true,preserved_count=n WHERE tenant_id=x.tenant_id AND xact_id=x.xact_id AND backend_pid=x.backend_pid AND employment_id=p_employment;
 RETURN n;
END $$;
REVOKE ALL ON FUNCTION app.contract_posting_job_protect(uuid,uuid) FROM PUBLIC,ai_hr_app;

-- AFTER canonical inverse/at target: bind only the actual existing native Contract intent. This does not
-- mint a replacement intent or bypass5815's exact old-as-of -> approved desired row-image guards.
