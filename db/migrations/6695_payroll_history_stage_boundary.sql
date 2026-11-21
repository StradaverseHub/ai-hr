-- Source reservation 6695 / idx10095 / 1794998006695; installation requires ordered-ledger admission.
-- Stage identifiers and selectors are not authority. Only the kernel's private lease capability admits work.
CREATE FUNCTION app.payroll_history_stage_authorized(p_stage uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 RETURN EXISTS(SELECT 1 FROM app.payroll_history_stage s JOIN public.bulk_job j ON j.id=s.job_id
  JOIN public.payroll_history_import_attempt a ON a.id=s.attempt_id AND a.tenant_id=s.tenant_id
  WHERE s.stage_id=p_stage AND s.stage_id=j.id AND s.state='staged' AND j.kind='payroll_history'
   AND s.tenant_id=app.current_tenant_id() AND s.created_by=app.current_user_id()
   AND j.tenant_id=s.tenant_id AND j.created_by=s.created_by AND j.state IN ('running','finalizing')
   AND j.input->>'attemptId'=s.attempt_id::text AND j.input->>'operation'=s.operation
   AND j.plan->>'stageId'=s.stage_id::text AND j.plan->>'attemptId'=s.attempt_id::text
   AND j.plan->>'operation'=s.operation AND app.bulk_job_capability_held(j.id)
   AND app.principal_snapshot_current() AND app.bulk_job_access(j.id)
   AND app.payroll_history_attempt_access(a.id)
   AND NOT EXISTS(SELECT 1 FROM unnest(a.company_ids) c(company_id)
    WHERE NOT app.payroll_history_maintenance_permission(c.company_id,
     CASE WHEN s.operation='revert' OR a.plan->'maintenance'->>'mode' IN ('remove_items','remove_batch')
      THEN 'payroll.history.revert' ELSE 'payroll.history.import' END)));
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_history_stage_authorized(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Existing RLS/purpose readers receive only the boolean bridge, never a nonce or access to private seal tables.
DO $grants$
DECLARE x record;
BEGIN
 FOR x IN SELECT DISTINCT a.grantee FROM pg_catalog.pg_proc p CROSS JOIN LATERAL
  pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
  WHERE p.oid IN ('app.payroll_history_hidden_rows(text)'::regprocedure,'app.payroll_history_row_visible(text,uuid)'::regprocedure)
   AND a.privilege_type='EXECUTE' AND a.grantee<>0
 LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION app.payroll_history_stage_authorized(uuid) TO %I',pg_catalog.pg_get_userbyid(x.grantee)); END LOOP;
END $grants$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.payroll_history_hidden_rows(p_relation text) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(array_agg(r.row_id),'{}'::uuid[]) FROM app.payroll_history_stage s
 JOIN app.payroll_history_staged_row r ON r.stage_id=s.stage_id AND r.relation=p_relation
 WHERE s.tenant_id=app.current_tenant_id() AND s.state='staged'
 AND (s.stage_id::text IS DISTINCT FROM current_setting('app.payroll_history_stage',true)
  OR NOT app.payroll_history_stage_authorized(s.stage_id))
$$;
--> statement-breakpoint
-- Remains inlineable: purpose roles retain their existing registry SELECT rights only.
CREATE OR REPLACE FUNCTION app.payroll_history_row_visible(p_relation text,p_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT NOT EXISTS(SELECT 1 FROM app.payroll_history_staged_row r JOIN app.payroll_history_stage s ON s.stage_id=r.stage_id
 WHERE r.relation=p_relation AND r.row_id=p_id AND s.state='staged'
 AND (s.stage_id::text IS DISTINCT FROM current_setting('app.payroll_history_stage',true)
  OR NOT app.payroll_history_stage_authorized(s.stage_id)))
$$;
--> statement-breakpoint
-- 5129 expanded the point visibility predicate into its private set owner. Keep that expansion
-- capability-aware too. This is still OWNER-only, SQL/STABLE/INVOKER without SET: no new API,
-- custody-table grants, security mode, input limit, or per-ID SECURITY DEFINER source call.
CREATE OR REPLACE FUNCTION app.payroll_history_effective_ids(p_ids uuid[]) RETURNS SETOF uuid
LANGUAGE sql STABLE AS $$
 WITH provided AS MATERIALIZED(SELECT DISTINCT supplied.id FROM unnest(p_ids) supplied(id) WHERE supplied.id IS NOT NULL),
 hidden_revisions AS MATERIALIZED(
  SELECT sr.row_id FROM app.payroll_history_staged_row sr JOIN app.payroll_history_stage stage ON stage.stage_id=sr.stage_id
  WHERE stage.tenant_id=app.current_tenant_id() AND stage.state='staged' AND sr.relation='payroll_history_import_revision'
 ), native_candidates AS MATERIALIZED(
  -- Canonical 6693 native_replaced proof, set-wise: a regenerated member of the same original run
  -- remains replaced; another native batch for that employment/month never matches this origin.
  SELECT p.id,c.record_id FROM provided supplied JOIN public.payslip p ON p.id=supplied.id
  JOIN public.payroll_batch original_batch ON original_batch.id=p.batch_id AND original_batch.tenant_id=p.tenant_id
  JOIN app.payroll_history_native_capture c ON c.source_batch_id=p.batch_id AND c.tenant_id=p.tenant_id
  JOIN public.payroll_history_import_record identity ON identity.id=c.record_id AND identity.tenant_id=c.tenant_id AND identity.employment_id=p.employment_id
  JOIN public.payroll_history_import_revision adopted ON adopted.record_id=c.record_id AND adopted.ordinal=1
   AND adopted.snapshot_id=c.snapshot_id AND adopted.kind='adopted' AND adopted.native_source=app.payroll_history_native_proof(c)
  WHERE p.tenant_id=app.current_tenant_id() AND original_batch.company_id=identity.company_id AND original_batch.pay_period=identity.period
   AND(original_batch.payroll_cycle_id IS NULL OR original_batch.payroll_cycle_id=identity.cycle_id)
   AND NOT EXISTS(SELECT 1 FROM hidden_revisions hidden WHERE hidden.row_id=adopted.id)
 ), native_records AS MATERIALIZED(SELECT DISTINCT record_id FROM native_candidates),
 native_latest AS MATERIALIZED(
  SELECT DISTINCT ON(r.record_id) r.record_id,r.snapshot_id FROM public.payroll_history_import_revision r
  JOIN native_records records ON records.record_id=r.record_id
  WHERE NOT EXISTS(SELECT 1 FROM hidden_revisions hidden WHERE hidden.row_id=r.id)
  ORDER BY r.record_id,r.ordinal DESC
 ), native_replaced AS MATERIALIZED(
  SELECT DISTINCT candidate.id FROM native_candidates candidate JOIN native_latest latest ON latest.record_id=candidate.record_id
  WHERE latest.snapshot_id IS NOT NULL
 )
 -- Only the internal probe is deduplicated. Preserve legacy unnest multiplicity, NULL members,
 -- NULL-array emptiness and unknown/other-tenant IDs; NOT IN would incorrectly drop NULL members.
 SELECT candidate.id FROM unnest(p_ids) candidate(id)
 WHERE NOT EXISTS(SELECT 1 FROM public.payroll_history_import_snapshot snapshot
  WHERE snapshot.id=candidate.id AND snapshot.tenant_id=app.current_tenant_id()
  AND CASE WHEN NOT EXISTS(SELECT 1 FROM app.payroll_history_staged_row sr JOIN app.payroll_history_stage stage ON stage.stage_id=sr.stage_id
    WHERE sr.relation='payroll_history_import_snapshot' AND sr.row_id=snapshot.id AND stage.state='staged'
     AND(stage.stage_id::text IS DISTINCT FROM current_setting('app.payroll_history_stage',true) OR NOT app.payroll_history_stage_authorized(stage.stage_id)))
   THEN(SELECT revision.snapshot_id FROM public.payroll_history_import_revision revision WHERE revision.record_id=snapshot.record_id
    AND NOT EXISTS(SELECT 1 FROM app.payroll_history_staged_row sr JOIN app.payroll_history_stage stage ON stage.stage_id=sr.stage_id
     WHERE sr.relation='payroll_history_import_revision' AND sr.row_id=revision.id AND stage.state='staged'
      AND(stage.stage_id::text IS DISTINCT FROM current_setting('app.payroll_history_stage',true) OR NOT app.payroll_history_stage_authorized(stage.stage_id)))
    ORDER BY revision.ordinal DESC LIMIT 1) IS DISTINCT FROM candidate.id
   ELSE EXISTS(SELECT 1 FROM app.payroll_history_staged_row sr JOIN app.payroll_history_stage stage ON stage.stage_id=sr.stage_id
    WHERE sr.relation='payslip' AND sr.row_id=candidate.id AND stage.state='staged'
     AND(stage.stage_id::text IS DISTINCT FROM current_setting('app.payroll_history_stage',true) OR NOT app.payroll_history_stage_authorized(stage.stage_id))) END)
 AND NOT EXISTS(SELECT 1 FROM native_replaced replaced WHERE replaced.id=candidate.id)
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.payroll_history_stage_open(p_stage uuid,p_attempt uuid,p_operation text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE j public.bulk_job; a public.payroll_history_import_attempt;
BEGIN
 j:=app.bulk_job_held(p_stage);
 SELECT * INTO a FROM public.payroll_history_import_attempt WHERE id=p_attempt AND tenant_id=j.tenant_id;
 IF p_operation IS NULL OR p_operation NOT IN ('confirm','revert') OR j.kind<>'payroll_history' OR j.state<>'preparing'
  OR j.tenant_id IS DISTINCT FROM app.current_tenant_id() OR j.created_by IS DISTINCT FROM app.current_user_id()
  OR j.input->>'attemptId' IS DISTINCT FROM p_attempt::text OR j.input->>'operation' IS DISTINCT FROM p_operation
  OR a.id IS NULL OR NOT app.principal_snapshot_current() OR NOT app.bulk_job_access(j.id)
  OR NOT app.payroll_history_attempt_access(p_attempt) OR app.bulk_job_seal_verify(j.id,'full') IS NOT NULL
  OR EXISTS(SELECT 1 FROM unnest(a.company_ids) c(company_id) WHERE NOT app.payroll_history_maintenance_permission(c.company_id,
   CASE WHEN p_operation='revert' OR a.plan->'maintenance'->>'mode' IN ('remove_items','remove_batch')
    THEN 'payroll.history.revert' ELSE 'payroll.history.import' END))
 THEN RAISE EXCEPTION 'payroll_history_stage_forbidden' USING ERRCODE='42501'; END IF;
 IF EXISTS(SELECT 1 FROM app.payroll_history_stage s WHERE s.stage_id=p_stage) THEN
  RETURN EXISTS(SELECT 1 FROM app.payroll_history_stage s WHERE s.stage_id=p_stage AND s.state='staged'
   AND s.job_id=j.id AND s.tenant_id=j.tenant_id AND s.attempt_id=p_attempt AND s.operation=p_operation AND s.created_by=j.created_by);
 END IF;
 IF EXISTS(SELECT 1 FROM app.payroll_history_stage s WHERE s.tenant_id=j.tenant_id AND s.state='staged') THEN RETURN false; END IF;
 INSERT INTO app.payroll_history_stage(stage_id,tenant_id,job_id,attempt_id,operation,created_by)
 VALUES(j.id,j.tenant_id,j.id,p_attempt,p_operation,j.created_by) ON CONFLICT DO NOTHING;
 RETURN EXISTS(SELECT 1 FROM app.payroll_history_stage s WHERE s.stage_id=j.id AND s.state='staged');
END $$;
--> statement-breakpoint
CREATE FUNCTION app.payroll_history_stage_join(p_stage uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE j public.bulk_job;
BEGIN
 j:=app.bulk_job_held(p_stage);
 IF NOT app.payroll_history_stage_authorized(p_stage) OR app.bulk_job_seal_verify(j.id,'header') IS NOT NULL THEN
  RAISE EXCEPTION 'payroll_history_stage_forbidden' USING ERRCODE='42501'; END IF;
 PERFORM set_config('app.payroll_history_stage',p_stage::text,true);
 PERFORM set_config('app.bulk_job_seq','',true);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_history_stage_join(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payroll_history_stage_join(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.payroll_history_stage_step(p_stage uuid,p_seq integer) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE j public.bulk_job;
BEGIN
 PERFORM app.payroll_history_stage_join(p_stage);
 SELECT * INTO j FROM public.bulk_job WHERE id=p_stage;
 IF j.state<>'running' OR p_seq IS NULL OR NOT EXISTS(SELECT 1 FROM public.bulk_job_step st JOIN app.bulk_job_step_seal z
  ON z.job_id=st.job_id AND z.seq=st.seq WHERE st.job_id=j.id AND st.seq=p_seq AND st.state='pending'
  AND st.seq=(SELECT min(q.seq) FROM public.bulk_job_step q WHERE q.job_id=j.id AND q.state='pending')
  AND z.digest=app.bulk_job_step_digest(st.kind,st.row_num,st.payload,st.state,st.result,st.error)) THEN
  RAISE EXCEPTION 'payroll_history_stage_step_invalid' USING ERRCODE='42501'; END IF;
 PERFORM set_config('app.bulk_job_seq',p_seq::text,true);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_history_stage_step(uuid,integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payroll_history_stage_step(uuid,integer) TO ai_hr_app;
--> statement-breakpoint
-- Private proof reader. Every insertion rechecks the exact current pending sealed step, not just a writable selector.
CREATE FUNCTION app.payroll_history_stage_payload(p_stage uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE j public.bulk_job; st public.bulk_job_step; seq_ text:=current_setting('app.bulk_job_seq',true);
BEGIN
 j:=app.bulk_job_held(p_stage);
 IF NOT app.payroll_history_stage_authorized(p_stage) OR j.state<>'running' OR seq_ IS NULL OR seq_!~'^[0-9]{1,9}$'
  OR app.bulk_job_seal_verify(j.id,'header') IS NOT NULL THEN RAISE EXCEPTION 'payroll_history_stage_step_required' USING ERRCODE='42501'; END IF;
 SELECT q.* INTO st FROM public.bulk_job_step q JOIN app.bulk_job_step_seal z ON z.job_id=q.job_id AND z.seq=q.seq
 WHERE q.job_id=j.id AND q.seq=seq_::integer AND q.state='pending'
 AND q.seq=(SELECT min(n.seq) FROM public.bulk_job_step n WHERE n.job_id=j.id AND n.state='pending')
 AND z.digest=app.bulk_job_step_digest(q.kind,q.row_num,q.payload,q.state,q.result,q.error);
 IF st.job_id IS NULL THEN RAISE EXCEPTION 'payroll_history_stage_step_required' USING ERRCODE='42501'; END IF;
 RETURN jsonb_build_object('kind',st.kind,'payload',st.payload,'plan',j.plan,'attemptId',j.input->>'attemptId');
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_history_stage_payload(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.payroll_history_stage_stamp() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE stage_ uuid; proof jsonb; target_ jsonb; group_ jsonb; rec public.payroll_history_import_record; batch_ public.payroll_batch; native_ jsonb; ok boolean:=false;
BEGIN
 SELECT s.stage_id INTO stage_ FROM app.payroll_history_stage s WHERE s.tenant_id=NEW.tenant_id AND s.state='staged';
 IF stage_ IS NULL THEN
  IF nullif(current_setting('app.payroll_history_stage',true),'') IS NOT NULL THEN RAISE EXCEPTION 'payroll_history_stage_unavailable' USING ERRCODE='55000'; END IF;
  RETURN NULL;
 END IF;
 -- An ordinary native batch/slip unrelated to history remains writable during a staged import.
 IF nullif(current_setting('app.payroll_history_stage',true),'') IS NULL AND TG_TABLE_NAME='payroll_batch' AND to_jsonb(NEW)->>'history_import_attempt_id' IS NULL THEN RETURN NULL; END IF;
 IF nullif(current_setting('app.payroll_history_stage',true),'') IS NULL AND TG_TABLE_NAME='payslip' THEN
  SELECT * INTO batch_ FROM public.payroll_batch WHERE id=NEW.batch_id;
  IF batch_.history_import_attempt_id IS NULL AND NOT EXISTS(SELECT 1 FROM app.payroll_history_staged_row r WHERE r.relation='payroll_batch' AND r.row_id=batch_.id) THEN RETURN NULL; END IF;
 END IF;
 IF current_setting('app.payroll_history_stage',true) IS DISTINCT FROM stage_::text THEN RAISE EXCEPTION 'payroll_history_stage_required' USING ERRCODE='42501'; END IF;
 proof:=app.payroll_history_stage_payload(stage_);
 target_:=CASE WHEN proof->>'kind'='revert' THEN proof->'payload'->'target' ELSE proof->'payload'->'row' END;
 native_:=target_->'detachedNativeBaseline';
 IF TG_TABLE_NAME='payroll_batch' THEN
  group_:=proof->'plan'->'groups'->((proof->'payload'->>'group')::integer);
  ok:=(proof->>'kind'='batch' AND NEW.history_import_attempt_id::text=proof->>'attemptId'
   AND NEW.company_id::text=group_->>'companyId' AND NEW.pay_period=group_->>'period' AND NEW.payroll_cycle_id::text=group_->>'cycleId')
   OR (proof->>'kind'='row' AND NEW.id::text=native_->>'batchId' AND NEW.history_import_attempt_id::text=proof->>'attemptId'
    AND NEW.company_id::text=target_->>'companyId' AND NEW.pay_period=target_->>'period'
    AND NEW.id=app.payroll_history_native_id((proof->>'attemptId')::uuid,(native_->>'sourceBatchId')::uuid,'batch')
    AND EXISTS(SELECT 1 FROM public.payroll_batch original JOIN public.payslip source ON source.batch_id=original.id
     JOIN public.pay_period period_owner ON period_owner.id=original.pay_period_id AND period_owner.tenant_id=original.tenant_id
     WHERE original.id::text=native_->>'sourceBatchId' AND source.id::text=native_->>'sourcePayslipId'
      AND original.tenant_id=NEW.tenant_id AND source.tenant_id=NEW.tenant_id AND original.history_import_attempt_id IS NULL
      AND original.company_id=NEW.company_id AND original.pay_period=NEW.pay_period
      AND original.payroll_cycle_id IS NOT DISTINCT FROM NEW.payroll_cycle_id
      AND (NEW.payroll_cycle_id IS NULL OR NEW.payroll_cycle_id::text=target_->>'cycleId')
      AND source.employment_id::text=target_->>'employmentId' AND source.version::text=native_->>'sourceVersion'
      AND original.status IN ('draft','processing','processed')
      AND app.payroll_history_native_source_hash(source,original,period_owner.status::text)=native_->>'sourceHash'
      AND app.payroll_history_native_values(source)=native_->'values'));
 ELSIF TG_TABLE_NAME='payroll_history_import_record' THEN
  ok:=proof->>'kind'='row' AND target_->>'recordId' IS NULL AND NEW.company_id::text=target_->>'companyId'
   AND NEW.employment_id::text=target_->>'employmentId' AND NEW.period=target_->>'period' AND NEW.cycle_id::text=target_->>'cycleId';
 ELSIF TG_TABLE_NAME='payslip' THEN
  SELECT * INTO batch_ FROM public.payroll_batch WHERE id=NEW.batch_id;
  ok:=proof->>'kind'='row' AND NEW.employment_id::text=target_->>'employmentId'
   AND batch_.company_id::text=target_->>'companyId' AND batch_.pay_period=target_->>'period'
   AND ((batch_.payroll_cycle_id::text=target_->>'cycleId' AND batch_.history_import_attempt_id::text=proof->>'attemptId' AND EXISTS(SELECT 1 FROM public.bulk_job_step st
     WHERE st.job_id=stage_ AND st.kind='batch' AND st.state='applied' AND st.payload->'group'=proof->'payload'->'group' AND st.result->>'batchId'=NEW.batch_id::text))
    OR (NEW.id::text=native_->>'snapshotId' AND NEW.batch_id::text=native_->>'batchId'
     AND batch_.history_import_attempt_id::text=proof->>'attemptId'
     AND EXISTS(SELECT 1 FROM app.payroll_history_native_capture captured
      WHERE captured.snapshot_id=NEW.id AND captured.baseline_batch_id=NEW.batch_id AND captured.tenant_id=NEW.tenant_id
       AND captured.attempt_id::text=proof->>'attemptId' AND captured.source_batch_id::text=native_->>'sourceBatchId'
       AND captured.source_payslip_id::text=native_->>'sourcePayslipId' AND captured.source_version::text=native_->>'sourceVersion'
       AND captured.source_hash=native_->>'sourceHash'
       AND NEW.id=app.payroll_history_native_id(captured.attempt_id,captured.source_payslip_id,'snapshot')
       AND app.payroll_history_native_values(NEW)=native_->'values')));
 ELSE
  SELECT * INTO rec FROM public.payroll_history_import_record WHERE id=NEW.record_id;
  ok:=proof->>'kind' IN ('row','revert') AND rec.tenant_id=NEW.tenant_id
   AND (CASE WHEN proof->>'kind'='revert' THEN rec.id::text=target_->>'recordId'
    ELSE rec.company_id::text=target_->>'companyId' AND rec.employment_id::text=target_->>'employmentId'
     AND rec.period=target_->>'period' AND rec.cycle_id::text=target_->>'cycleId'
     AND (target_->>'recordId' IS NULL OR rec.id::text=target_->>'recordId') END);
  IF TG_TABLE_NAME='payroll_history_import_revision' THEN ok:=ok AND NEW.attempt_id::text=proof->>'attemptId'; END IF;
 END IF;
 IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'payroll_history_stage_row_mismatch' USING ERRCODE='42501'; END IF;
 INSERT INTO app.payroll_history_staged_row(stage_id,relation,row_id) VALUES(stage_,TG_TABLE_NAME,NEW.id);
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.payroll_history_stage_mutation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE stage_ uuid; j public.bulk_job;
BEGIN
 SELECT s.stage_id INTO stage_ FROM app.payroll_history_staged_row r JOIN app.payroll_history_stage s ON s.stage_id=r.stage_id
 WHERE r.relation=TG_TABLE_NAME AND r.row_id=OLD.id AND s.state='staged';
 IF stage_ IS NULL THEN
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
 END IF;
 j:=app.bulk_job_held(stage_);
 -- Discard has the same private lease proof even after the initiating principal loses scope. No role-name bypass.
 IF TG_OP='DELETE' AND j.kind='payroll_history' AND j.state='discarding' AND j.id=stage_ THEN RETURN OLD; END IF;
 IF TG_OP='DELETE' OR j.state<>'finalizing' OR TG_TABLE_NAME<>'payroll_batch'
  OR current_setting('app.payroll_history_stage',true) IS DISTINCT FROM stage_::text
  OR NOT app.payroll_history_stage_authorized(stage_) OR app.bulk_job_seal_verify(j.id,'header') IS NOT NULL
 THEN RAISE EXCEPTION 'payroll_history_stage_mutation_forbidden' USING ERRCODE='42501'; END IF;
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.company_id IS DISTINCT FROM OLD.company_id
  OR NEW.history_import_attempt_id IS DISTINCT FROM OLD.history_import_attempt_id OR NEW.pay_period IS DISTINCT FROM OLD.pay_period
  OR NEW.payroll_cycle_id IS DISTINCT FROM OLD.payroll_cycle_id THEN RAISE EXCEPTION 'payroll_history_stage_identity_changed' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_history_stage_mutation() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['payroll_batch','payslip','payroll_history_import_record','payroll_history_import_snapshot','payroll_history_import_revision'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.payroll_history_stage_mutation()', 'aaa_'||t||'_history_stage_mutation',t);
 END LOOP;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.payroll_history_stage_release(p_stage uuid) RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE j public.bulk_job; staged bigint;
BEGIN
 j:=app.bulk_job_held(p_stage);
 IF j.state<>'finalizing' OR NOT app.payroll_history_stage_authorized(p_stage)
  OR app.bulk_job_seal_verify(j.id,'full') IS NOT NULL THEN RAISE EXCEPTION 'payroll_history_stage_release_unavailable' USING ERRCODE='42501'; END IF;
 IF EXISTS(SELECT 1 FROM public.bulk_job_step st WHERE st.job_id=j.id AND st.state<>'applied') THEN
  RAISE EXCEPTION 'payroll_history_stage_incomplete' USING ERRCODE='55000'; END IF;
 -- Every registered row must be accounted for by a sealed applied result, including only its exact adopted baseline.
 IF EXISTS(WITH changes AS MATERIALIZED (SELECT st.result->'change' c,st.payload FROM public.bulk_job_step st
   WHERE st.job_id=j.id AND st.kind IN ('row','revert')),
  allowed_revisions AS MATERIALIZED (
   SELECT r.id,r.record_id,r.snapshot_id FROM changes c JOIN public.payroll_history_import_revision r ON r.id::text=c.c->>'revisionId'
    WHERE r.record_id::text=c.c->>'recordId' AND r.attempt_id::text=j.input->>'attemptId' AND r.snapshot_id::text IS NOT DISTINCT FROM c.c->>'snapshotId'
   UNION
   SELECT r.id,r.record_id,r.snapshot_id FROM changes c JOIN public.payroll_history_import_revision r ON r.id::text=c.c->>'previousRevisionId'
    WHERE r.ordinal=1 AND r.kind='adopted' AND r.attempt_id::text=j.input->>'attemptId' AND r.record_id::text=c.c->>'recordId'),
  allowed AS (
   SELECT 'payroll_history_import_revision' relation,id FROM allowed_revisions
   UNION SELECT 'payroll_history_import_record',record_id FROM allowed_revisions
   UNION SELECT 'payroll_history_import_snapshot',snapshot_id FROM allowed_revisions WHERE snapshot_id IS NOT NULL
   UNION SELECT 'payslip',snapshot_id FROM allowed_revisions WHERE snapshot_id IS NOT NULL
   UNION SELECT 'payroll_batch',p.batch_id FROM allowed_revisions r JOIN public.payslip p ON p.id=r.snapshot_id
   UNION SELECT 'payroll_batch',(st.result->>'batchId')::uuid FROM public.bulk_job_step st WHERE st.job_id=j.id AND st.kind='batch')
  SELECT 1 FROM app.payroll_history_staged_row sr WHERE sr.stage_id=p_stage
   AND NOT EXISTS(SELECT 1 FROM allowed a WHERE a.relation=sr.relation AND a.id=sr.row_id))
 OR EXISTS(SELECT 1 FROM public.bulk_job_step st WHERE st.job_id=j.id AND st.kind IN ('row','revert')
  AND NOT EXISTS(SELECT 1 FROM app.payroll_history_staged_row sr JOIN public.payroll_history_import_revision r ON r.id=sr.row_id
   WHERE sr.stage_id=p_stage AND sr.relation='payroll_history_import_revision' AND r.id::text=st.result->'change'->>'revisionId'
    AND r.record_id::text=st.result->'change'->>'recordId' AND r.attempt_id::text=j.input->>'attemptId'))
 THEN RAISE EXCEPTION 'payroll_history_stage_unaccounted_rows' USING ERRCODE='55000'; END IF;
 IF EXISTS(SELECT 1 FROM app.payroll_history_staged_row r JOIN public.payroll_batch b ON b.id=r.row_id
  WHERE r.stage_id=p_stage AND r.relation='payroll_batch' AND (b.pay_period_id IS NULL OR b.status::text<>'closed')) THEN
  RAISE EXCEPTION 'payroll_history_stage_incomplete' USING ERRCODE='55000'; END IF;
 -- Snapshot and financial columns must still agree at publication, independently of their original insertion.
 IF EXISTS(SELECT 1 FROM app.payroll_history_staged_row sr JOIN public.payroll_history_import_snapshot s ON s.id=sr.row_id
  JOIN public.payslip p ON p.id=s.id WHERE sr.stage_id=p_stage AND sr.relation='payroll_history_import_snapshot'
  AND s."values" IS DISTINCT FROM jsonb_build_object('basicSalary',p.basic_salary::text,'allowance',p.allowance::text,
   'overtimePay',p.overtime_pay::text,'bonus',p.bonus::text,'grossPay',p.gross_pay::text,'statutory',p.statutory,
   'otherDeductions',p.other_deductions::text,'totalDeductions',p.total_deductions::text,'netPay',p.net_pay::text,'employerCost',p.employer_cost::text)) THEN
  RAISE EXCEPTION 'payroll_history_stage_snapshot_changed' USING ERRCODE='55000'; END IF;
 SELECT count(*) INTO staged FROM app.payroll_history_staged_row r WHERE r.stage_id=p_stage;
 UPDATE app.payroll_history_stage SET state='released',released_at=now() WHERE stage_id=p_stage;
 RETURN staged;
END $$;
