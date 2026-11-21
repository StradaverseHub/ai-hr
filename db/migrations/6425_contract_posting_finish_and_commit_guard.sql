-- UNAPPROVED / UNAPPLIED / UNREGISTERED source proposal.6000 Shared capture is an explicit prerequisite.
-- Install reviewed6000→6001→6002→6003→6004→6005→6006→6007→6008 in order. No forward helper references.
CREATE FUNCTION app.contract_posting_job_finish(p_job uuid,p_group uuid,p_scheduled boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE x app.contract_posting_job_tx;source app.contract_posting_job_source;i public.contract_shared_posting_tx;
 p public.personnel_posting;r public.contract_shared_posting;e public.employment;movement public.domain_event;job public.bulk_job;
 windows jsonb;digest bytea;n integer;ledger_max bigint;
BEGIN
 SELECT * INTO source FROM app.contract_posting_job_source WHERE tenant_id=app.current_tenant_id() AND job_id=p_job;
 IF app.contract_posting_original_source_intact(p_job,source.employment_id) IS NOT TRUE OR app.contract_posting_replay_complete(p_job) IS NOT TRUE OR p_group IS NULL OR p_scheduled IS NULL
 THEN RAISE EXCEPTION 'Exact Contract application finish required' USING ERRCODE='42501';END IF;
 SELECT * INTO x FROM app.contract_posting_job_tx WHERE tenant_id=source.tenant_id AND job_id=p_job AND employment_id=source.employment_id
 AND xact_id=txid_current() AND backend_pid=pg_backend_pid() AND login_name=session_user;
 SELECT * INTO i FROM public.contract_shared_posting_tx WHERE tenant_id=x.tenant_id AND posting_id=x.posting_id AND employment_id=x.employment_id
 AND transaction_id=txid_current() AND backend_pid=pg_backend_pid() AND login_name=session_user AND actor_user_id=x.actor_user_id AND consumed;
 SELECT * INTO p FROM public.personnel_posting WHERE tenant_id=x.tenant_id AND id=x.posting_id;
 SELECT * INTO r FROM public.contract_shared_posting WHERE tenant_id=x.tenant_id AND posting_id=x.posting_id;
 SELECT * INTO e FROM public.employment WHERE tenant_id=x.tenant_id AND id=x.employment_id;
 SELECT * INTO movement FROM public.domain_event WHERE tenant_id=x.tenant_id AND id::text=p.movement_id;
 digest:=app.bulk_job_value_digest(jsonb_build_array(i.posting_id,i.employment_id,i.old_employment,i.old_assignment,i.desired,i.effective_on,i.kind));
 IF i.employment_id IS NULL OR p.status<>'approved' OR p.approved_by IS DISTINCT FROM source.requester_user_id OR p.approved_at IS DISTINCT FROM now()
 OR p.revision IS DISTINCT FROM source.posting_revision+1 OR app.bulk_job_value_digest(p.applied) IS DISTINCT FROM source.values_hash
 OR r.movement_group_id IS DISTINCT FROM p_group OR movement.id IS NULL OR movement.subject_employment_id IS DISTINCT FROM x.employment_id
 OR movement.payload->'movement'->>'groupId' IS DISTINCT FROM p_group::text
 OR movement.payload->'movement'->>'type' IS DISTINCT FROM (CASE i.kind WHEN 'contractConversion' THEN 'employmentTypeChange' ELSE 'contractRenewal' END)
 OR movement.occurred_at IS DISTINCT FROM now()
 THEN RAISE EXCEPTION 'Canonical Contract movement receipt missing' USING ERRCODE='42501';END IF;
 IF p_scheduled THEN
  IF i.effective_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date OR movement.event_type<>'employment.movement.scheduled'
  OR x.intent_hash IS DISTINCT FROM digest OR to_jsonb(e) IS DISTINCT FROM x.original_employment OR r.applied_at IS NOT NULL
  THEN RAISE EXCEPTION 'The scheduled Contract receipt changed Personnel' USING ERRCODE='42501';END IF;
 ELSE
  IF x.protected IS NOT TRUE OR x.intent_hash IS DISTINCT FROM digest OR r.applied_at IS NULL
  OR i.effective_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date OR to_jsonb(e) IS DISTINCT FROM x.original_employment||i.desired
  THEN RAISE EXCEPTION 'Protected exact Contract application required' USING ERRCODE='42501';END IF;
  -- Canonical owner already checked all source images, assignment images and its actual Movement group.
  -- No amounts are selected. The fixed subject window marks actual open inputs stale across ALL recorded payers; no processing or closing authority is acquired.
  windows:=jsonb_build_array(jsonb_build_object('from',i.effective_on,'until',NULL));
  IF EXISTS(SELECT 1 FROM public.payroll_batch b JOIN public.payslip slip ON slip.batch_id=b.id AND slip.tenant_id=b.tenant_id
   WHERE b.tenant_id=x.tenant_id AND slip.employment_id=x.employment_id AND b.status IN('processed','processing')
   AND b.pay_period>=to_char(i.effective_on,'YYYY-MM') AND NOT app.payroll_history_row_visible('payslip',slip.id))
  THEN RAISE EXCEPTION 'Open payroll input evidence is unavailable' USING ERRCODE='42501';END IF;
  n:=app.workforce_payroll_inputs_changed_windows_owner(x.employment_id,windows,'employment_information');
 END IF;
 IF NOT p_scheduled THEN
  PERFORM app.contract_shared_posting_capture_applied_period(x.posting_id);
  SELECT * INTO r FROM public.contract_shared_posting WHERE tenant_id=x.tenant_id AND posting_id=x.posting_id;
  IF r.after_period_revision IS DISTINCT FROM app.contract_shared_period_revision(x.employment_id)
  THEN RAISE EXCEPTION 'Capture the actual completed canonical Contract period before sealing the result' USING ERRCODE='42501';END IF;
 END IF;
 -- Mint this immutable finish proof ONLY while the genuine live finalizing job frame still holds.
 -- Deferred COMMIT validation must not depend on that state remaining finalizing after unit.set(completed).
 SELECT * INTO job FROM public.bulk_job WHERE tenant_id=x.tenant_id AND id=p_job;
 SELECT coalesce(max(sequence),0) INTO ledger_max FROM public.domain_event WHERE tenant_id=x.tenant_id AND subject_employment_id=x.employment_id;
 INSERT INTO app.contract_posting_job_result(tenant_id,job_id,posting_id,movement_group_id,scheduled,applied,
 finished_xid,backend_pid,login_name,source_hash,intent_hash,posting_hash,receipt_hash,employment_hash,assignment_hash,
 ledger_max_sequence,ledger_hash,admitted_input_digest,admitted_plan_digest)
 VALUES(x.tenant_id,p_job,x.posting_id,p_group,p_scheduled,NOT p_scheduled,txid_current(),pg_backend_pid(),session_user,
 x.source_hash,x.intent_hash,app.bulk_job_value_digest(to_jsonb(p)),app.bulk_job_value_digest(to_jsonb(r)),app.bulk_job_value_digest(to_jsonb(e)),app.contract_posting_assignment_hash(x.employment_id),
 ledger_max,app.contract_posting_ledger_hash(x.employment_id,ledger_max),app.bulk_job_value_digest(job.input),app.bulk_job_value_digest(job.plan));
 RETURN jsonb_build_object('postingId',x.posting_id,'groupId',p_group,'scheduled',p_scheduled,'applied',NOT p_scheduled);
END $$;
REVOKE ALL ON FUNCTION app.contract_posting_job_finish(uuid,uuid,boolean) FROM PUBLIC,ai_hr_app;

-- NEW explicitly reviewed status port. No native plan, preservation count, Payroll rows, error payload,
-- amounts, confidential metadata, captured grants or raw projection leave the fixed owner.
-- Close the former synchronous Contract approval door while retaining its SAME OID. A COPY of the full
-- existing native owner preserves its legal/source/freshness checks; only the exact private job frame may
-- dispatch into it. No old aliases or cached native callers can bypass the independent row guard below.
DO $$ BEGIN
 EXECUTE replace(pg_get_functiondef('app.contract_shared_posting_approve(uuid,integer,jsonb)'::regprocedure),
  'app.contract_shared_posting_approve(', 'app.contract_shared_posting_approve_before_job_guard(');
END $$;
REVOKE ALL ON FUNCTION app.contract_shared_posting_approve_before_job_guard(uuid,integer,jsonb) FROM PUBLIC,ai_hr_app;
CREATE OR REPLACE FUNCTION app.contract_shared_posting_approve(p_id uuid,p_revision integer,p_values jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source app.contract_posting_job_source;
BEGIN
 SELECT source_row.* INTO source FROM app.contract_posting_job_source source_row
 WHERE source_row.tenant_id=app.current_tenant_id() AND source_row.posting_id=p_id
 AND source_row.job_id::text=current_setting('app.bulk_job',true);
 IF source.job_id IS NULL OR app.contract_posting_job_tx_held(source.job_id,source.employment_id) IS NOT TRUE
 THEN RAISE EXCEPTION 'Request Contract approval through its actual held application job' USING ERRCODE='42501';END IF;
 RETURN app.contract_shared_posting_approve_before_job_guard(p_id,p_revision,p_values);
END $$;
-- Defense in depth: only existing fixed worker owner may call the guarded source approve; request/status
-- are the reviewed app ports. The native row guard also catches generic SECURITY DEFINER and old aliases.
REVOKE ALL ON FUNCTION app.contract_shared_posting_approve(uuid,integer,jsonb) FROM PUBLIC,ai_hr_app;

CREATE FUNCTION app.contract_posting_approval_row_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source app.contract_posting_job_source;movement public.domain_event;
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.source<>'contract_staff' THEN RETURN NEW;END IF;
  IF NEW.status='pending' AND NEW.applied IS NULL AND NEW.approved_by IS NULL AND NEW.approved_at IS NULL AND NEW.movement_id IS NULL THEN RETURN NEW;END IF;
  RAISE EXCEPTION 'Create a Contract posting pending; its real application job approves it' USING ERRCODE='42501';
 END IF;
 -- Ordinary Probation/Offboarding rows take this constant-time branch without new policy queries.
 IF OLD.source<>'contract_staff' AND NEW.source<>'contract_staff' THEN RETURN NEW;END IF;
 IF NEW.source IS DISTINCT FROM OLD.source THEN RAISE EXCEPTION 'Contract posting source cannot be relabelled' USING ERRCODE='42501';END IF;
 IF to_jsonb(NEW)=to_jsonb(OLD) THEN RETURN NEW;END IF;
 -- Preserve genuine pending correction/create behavior, without accepting a concealed approval stamp.
 IF OLD.status='pending' AND NEW.status='pending' AND NEW.applied IS NULL AND NEW.approved_by IS NULL
 AND NEW.approved_at IS NULL AND NEW.movement_id IS NULL THEN RETURN NEW;END IF;
 SELECT source_row.* INTO source FROM app.contract_posting_job_source source_row
 WHERE source_row.tenant_id=NEW.tenant_id AND source_row.posting_id=NEW.id
 AND source_row.job_id::text=current_setting('app.bulk_job',true);
 IF source.job_id IS NULL OR app.contract_posting_job_tx_held(source.job_id,source.employment_id) IS NOT TRUE
 OR NEW.tenant_id IS DISTINCT FROM source.tenant_id OR NEW.employment_id IS DISTINCT FROM source.employment_id
 OR NEW.company_id IS DISTINCT FROM source.company_id OR NEW.source_ref IS DISTINCT FROM source.case_id
 THEN RAISE EXCEPTION 'Exact actual Contract job frame required for approval or movement binding' USING ERRCODE='42501';END IF;
 IF OLD.status='pending' AND NEW.status='approved' THEN
  IF OLD.revision IS DISTINCT FROM source.posting_revision OR NEW.revision IS DISTINCT FROM OLD.revision+1
  OR NEW.applied IS DISTINCT FROM source.requested_values OR app.bulk_job_value_digest(NEW.applied) IS DISTINCT FROM source.values_hash
  OR NEW.approved_by IS DISTINCT FROM source.requester_user_id OR NEW.approved_at IS DISTINCT FROM now()
  OR OLD.movement_id IS NOT NULL OR NEW.movement_id IS NOT NULL
  OR (to_jsonb(NEW)-ARRAY['status','revision','applied','approved_by','approved_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','revision','applied','approved_by','approved_at'])
  THEN RAISE EXCEPTION 'Approval must consume the exact frozen pending human request' USING ERRCODE='42501';END IF;
  RETURN NEW;
 END IF;
 IF OLD.status='approved' AND NEW.status='approved' AND OLD.movement_id IS NULL AND NEW.movement_id IS NOT NULL THEN
  SELECT * INTO movement FROM public.domain_event WHERE tenant_id=source.tenant_id AND id::text=NEW.movement_id;
  IF NEW.revision IS DISTINCT FROM source.posting_revision+1 OR NEW.applied IS DISTINCT FROM source.requested_values
  OR NEW.approved_by IS DISTINCT FROM source.requester_user_id OR NEW.approved_at IS DISTINCT FROM now()
  OR (to_jsonb(NEW)-'movement_id') IS DISTINCT FROM (to_jsonb(OLD)-'movement_id')
  OR movement.id IS NULL OR movement.subject_employment_id IS DISTINCT FROM source.employment_id
  OR movement.actor_type<>'user' OR movement.actor_id IS DISTINCT FROM source.requester_user_id OR movement.occurred_at IS DISTINCT FROM now()
  OR coalesce(movement.payload->'movement'->>'contractPostingId',movement.payload->'input'->>'contractPostingId') IS DISTINCT FROM source.posting_id::text
  THEN RAISE EXCEPTION 'Bind only the actual canonical Contract movement receipt' USING ERRCODE='42501';END IF;
  RETURN NEW;
 END IF;
 RAISE EXCEPTION 'An agreed Contract approval or movement binding is immutable' USING ERRCODE='42501';
END $$;
REVOKE ALL ON FUNCTION app.contract_posting_approval_row_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER contract_posting_approval_row_guard BEFORE INSERT OR UPDATE ON public.personnel_posting
FOR EACH ROW EXECUTE FUNCTION app.contract_posting_approval_row_guard();

-- A valid private frame is necessary but not sufficient: the real worker transaction cannot commit an
-- approved-but-unapplied cache row by accidentally returning before canonical receipt/final invalidation.
CREATE FUNCTION app.contract_posting_approval_commit_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source app.contract_posting_job_source;x app.contract_posting_job_tx;job public.bulk_job;
 p public.personnel_posting;r public.contract_shared_posting;e public.employment;result app.contract_posting_job_result;
BEGIN
 IF OLD.source<>'contract_staff' AND NEW.source<>'contract_staff' THEN RETURN NULL;END IF;
 IF NEW.status<>'approved' OR (OLD.status='approved' AND OLD.movement_id IS NOT DISTINCT FROM NEW.movement_id) THEN RETURN NULL;END IF;
 SELECT source_row.* INTO source FROM app.contract_posting_job_source source_row WHERE source_row.tenant_id=NEW.tenant_id AND source_row.posting_id=NEW.id
 AND source_row.job_id::text=current_setting('app.bulk_job',true);
 SELECT * INTO x FROM app.contract_posting_job_tx WHERE tenant_id=source.tenant_id AND job_id=source.job_id AND posting_id=source.posting_id
 AND employment_id=source.employment_id AND xact_id=txid_current() AND backend_pid=pg_backend_pid() AND login_name=session_user;
 SELECT * INTO result FROM app.contract_posting_job_result WHERE tenant_id=source.tenant_id AND job_id=source.job_id;
 SELECT * INTO job FROM public.bulk_job WHERE tenant_id=source.tenant_id AND id=source.job_id;
 -- This is NOT admission from a completed job. It validates the private receipt minted earlier in THIS
 -- actual backend/XID by job_finish while the live finalizing capability, seal and source proof held.
 IF source.job_id IS NULL OR x.job_id IS NULL OR result.job_id IS NULL
 OR app.principal_snapshot_current() IS NOT TRUE OR app.contract_verified_human(app.current_user_id()) IS NOT TRUE
 OR app.contract_binding_person(app.current_user_id()) IS DISTINCT FROM source.requester_person_id
 OR app.contract_shared_posting_approver(source.company_id) IS NOT TRUE
 OR result.finished_xid IS DISTINCT FROM txid_current() OR result.backend_pid IS DISTINCT FROM pg_backend_pid() OR result.login_name IS DISTINCT FROM session_user
 OR result.source_hash IS DISTINCT FROM x.source_hash OR result.intent_hash IS DISTINCT FROM x.intent_hash
 OR x.actor_user_id IS DISTINCT FROM source.requester_user_id OR x.actor_person_id IS DISTINCT FROM source.requester_person_id
 OR app.current_user_id() IS DISTINCT FROM source.requester_user_id OR app.contract_actor_person(app.current_user_id()) IS DISTINCT FROM source.requester_person_id
 OR job.id IS NULL OR job.kind<>'contract_posting_apply' OR job.created_by IS DISTINCT FROM source.requester_user_id
 OR job.operation_key IS DISTINCT FROM source.operation_key OR job.state NOT IN('finalizing','completed') OR job.cancel_requested_at IS NOT NULL
 OR (job.state='completed' AND job.finished_at IS DISTINCT FROM result.completed_at)
 OR result.admitted_input_digest IS DISTINCT FROM app.bulk_job_value_digest(jsonb_build_object('postingId',source.posting_id))
 THEN RAISE EXCEPTION 'A real Contract application must finish in the same transaction before approval commits' USING ERRCODE='42501';END IF;
 SELECT * INTO p FROM public.personnel_posting WHERE tenant_id=source.tenant_id AND id=source.posting_id;
 SELECT * INTO r FROM public.contract_shared_posting WHERE tenant_id=source.tenant_id AND posting_id=source.posting_id;
 SELECT * INTO e FROM public.employment WHERE tenant_id=source.tenant_id AND id=source.employment_id;
 IF p.status<>'approved' OR p.movement_id IS NULL OR p.approved_by IS DISTINCT FROM source.requester_user_id
 OR p.revision IS DISTINCT FROM source.posting_revision+1 OR p.applied IS DISTINCT FROM source.requested_values
 OR r.movement_group_id IS DISTINCT FROM result.movement_group_id OR (NOT result.scheduled AND r.applied_at IS NULL)
 OR e.company_id IS DISTINCT FROM source.company_id OR e.person_id IS DISTINCT FROM source.subject_person_id
 OR result.posting_hash IS DISTINCT FROM app.bulk_job_value_digest(to_jsonb(p))
 OR result.receipt_hash IS DISTINCT FROM app.bulk_job_value_digest(to_jsonb(r))
 OR result.employment_hash IS DISTINCT FROM app.bulk_job_value_digest(to_jsonb(e))
 OR x.ledger_hash IS DISTINCT FROM app.contract_posting_ledger_hash(source.employment_id,x.ledger_max_sequence)
 OR result.assignment_hash IS DISTINCT FROM app.contract_posting_assignment_hash(source.employment_id)
 OR result.ledger_hash IS DISTINCT FROM app.contract_posting_ledger_hash(source.employment_id,result.ledger_max_sequence)
 OR EXISTS(SELECT 1 FROM public.domain_event extra WHERE extra.tenant_id=source.tenant_id AND extra.subject_employment_id=source.employment_id AND extra.sequence>result.ledger_max_sequence)
 THEN RAISE EXCEPTION 'Do not commit an approved Contract posting without its exact finished native images' USING ERRCODE='42501';END IF;
 -- Do NOT call job_held/job_tx_held, read current capability/input/plan seals, or require finalizing here:
 -- the native same-transaction terminal transition and5013 cleanup may already have cleared those fields.
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.contract_posting_approval_commit_guard() FROM PUBLIC,ai_hr_app;
CREATE CONSTRAINT TRIGGER contract_posting_approval_commit_guard AFTER UPDATE ON public.personnel_posting
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.contract_posting_approval_commit_guard();

-- Writer review required before activation:5814 creates pending Contract rows;5815/5817/5913 approval
-- aliases and generic Personnel wrappers;5911 canonical Assignment receipt; existing edit/record functions;
-- direct INSERT/UPDATE, old OID cached callers, source relabel, replay/savepoint rollback and genuine worker
-- commit without finish. Probation/Offboarding pending/approve/edit/bind rows must remain byte-for-byte legal.
-- All recorded actual paying companies are internal preservation/stale-marking scope ONLY. Current case
-- company AND actual target as-of legal employer remain equal before chronology/business mutations.

-- Retrospective execution order: begin captures original CURRENT images+immutable ledger seal; protect
-- runs BEFORE inverse; the PRIVATE canonical owner derives a frozen later replay plan from that native
-- ledger; existing canonical approval runs BEFORE inverse; inverse places the target; intent mints the exact native target; bind_intent
-- binds its hash; native target applies/consumes its own image proof; canonical later replay restores later
-- decisions; finish compares ORIGINAL current employment||target desired and invalidates native window.
-- SQL checks original ledger immutability and actual same-job/actor suffix, but is not a replacement for
-- the accepted TS chronology planner. There is no universal replayOf receipt for fresh replay groups in
-- accepted4374–4405. Companion6002 seals native original groups, exact step order, directions and company
-- endpoints;6003 provides the private canonical target frame. The fixed PRIVATE immutable-plan path remains
-- a required authority boundary for activation; no arbitrary plan, later field payload or amount is accepted
-- by the app ports or by these native helpers. Parent-owned truthful request_status changes are preserved.

-- Deferred-proof distinction: all BEFORE transition/binding/protection/intent/job_finish checks require
-- the actual live finalizing frame. Only the deferred constraint accepts finalizing OR native completed
-- after private same-XID finish, including cleared inputs/seal fields. A completed job alone cannot mint
-- an approval; old aliases still encounter the BEFORE source guard and cannot manufacture finish rows.
-- Future ordinary due-application remains outside this new pending-approval frame and does not UPDATE
-- personnel_posting approval/binding fields; its native consumed-intent/shared receipt path is unchanged.
