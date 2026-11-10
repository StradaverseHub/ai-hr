-- Combined release allocation, 11 November 2026 (docs/MIGRATION-ALLOCATION.md): 5064_employee_import_revert_release_hash, idx 4464, when 1793330004764.
-- Draft name on its branch: 9934_employee_import_revert_release_hash. Any draft note below describes that unallocated branch position.
-- UNALLOCATED DRAFT on branch claude/bulkjob-register-20261110 (employee import Revert release, security review fixes):
-- not a reservation, not an installation allocation. The journal position (idx 9934, when 1793330099340) exists only so
-- this branch's schema is executable and reviewable; the integration owner assigns the final tag/idx/when.
--
-- 5062's release compared the attempt's items with the plan stored on the job row and left the preview hash to the
-- lock-free review. It now trusts nothing stored on the job for what it reverts: the applied items are read as the
-- creator's session reads them (Import History view of each item's company; every applied item must be visible), and
-- the preview hash the creator confirmed is recomputed inside the release, under its locks, exactly as the review
-- computes it, so any change to the items, the confirmation, the creator or eligibility refuses the revert.
CREATE OR REPLACE FUNCTION app.employee_import_revert_release(p_job uuid,p_chain boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE j public.bulk_job%ROWTYPE; t uuid; u uuid; attempt_ uuid; reason_ text; a public.import_attempt%ROWTYPE; ids uuid[]; persons uuid[];
 confirmed_ uuid; n integer; applied_ integer; visible_ integer; hash_ text;
BEGIN
 IF NOT app.access_workforce_storage_owner() THEN RAISE EXCEPTION 'employee_import_revert_forbidden' USING ERRCODE='42501'; END IF;
 PERFORM set_config('application_name','aihr-bulk:employee_import_revert:release',true);
 SELECT * INTO j FROM public.bulk_job b WHERE b.id=p_job FOR UPDATE;
 IF NOT FOUND OR j.kind<>'employee_import_revert' OR j.state<>'finalizing' OR j.lease_expires_at IS NULL OR j.lease_expires_at<now()
  OR coalesce((j.plan->>'released')::boolean,false) THEN
  RAISE EXCEPTION 'employee_import_revert_unavailable' USING ERRCODE='55000';
 END IF;
 t:=j.tenant_id;u:=j.created_by;attempt_:=(j.input->>'attemptId')::uuid;reason_:=j.input->>'reason';
 IF (j.context->>'tenantId') IS DISTINCT FROM t::text OR (j.context->>'userId') IS DISTINCT FROM u::text OR attempt_ IS NULL
  OR reason_ IS NULL OR length(reason_) NOT BETWEEN 3 AND 1000 THEN
  RAISE EXCEPTION 'employee_import_revert_unavailable' USING ERRCODE='55000';
 END IF;
 PERFORM set_config('app.tenant_id',t::text,true),set_config('app.user_id',u::text,true),
  set_config('app.roles',coalesce((SELECT string_agg(r,',') FROM jsonb_array_elements_text(j.context->'roles') r),''),true),
  set_config('app.grants',coalesce(j.context->'grants','[]'::jsonb)::text,true),set_config('app.agent_principal_id','',true),
  set_config('app.payroll_tax_basis_reader','1',true);
 IF p_chain THEN PERFORM set_config('app.audit_hash_chain','on',true); END IF;
 -- The synchronous revert's locks, in its order: the Workforce writer barrier, the leave-dependency configuration
 -- (no wait: busy is retried by the worker), then the attempt row. Under the reader/writer Access lock the
 -- synchronous revert keeps the exclusive barrier, so this release takes it too: a short queued wait for the
 -- exclusive lock (busy is retried by the worker, like the leave-dependency refusal), then the editor barrier.
 IF NOT app.access_configuration_exclusive_wait(t,250) THEN
  RAISE EXCEPTION 'access_configuration_busy' USING ERRCODE='55P03';
 END IF;
 PERFORM app.access_configuration_write_lock();
 IF NOT pg_try_advisory_xact_lock(hashtextextended('leave-dependency-configuration:'||lower(t::text),0)) THEN
  RAISE EXCEPTION 'leave_dependency_busy' USING ERRCODE='55P03';
 END IF;
 IF NOT app.bank_import_context_current(j.context) THEN RETURN jsonb_build_object('refused','access'); END IF;
 SELECT * INTO a FROM public.import_attempt x WHERE x.id=attempt_ AND x.tenant_id=t FOR UPDATE;
 IF NOT FOUND OR a.kind<>'employee_full' THEN RETURN jsonb_build_object('refused','unavailable'); END IF;
 IF NOT app.import_attempt_access(attempt_,'maintain',true) THEN RETURN jsonb_build_object('refused','maintain'); END IF;
 IF EXISTS(SELECT 1 FROM public.import_attempt_event ev WHERE ev.attempt_id=attempt_ AND ev.kind='reverted') THEN RETURN jsonb_build_object('refused','reverted'); END IF;
 SELECT ev.id INTO confirmed_ FROM public.import_attempt_event ev WHERE ev.attempt_id=attempt_ AND ev.kind='confirmed' ORDER BY ev.created_at,ev.id LIMIT 1;
 IF confirmed_ IS NULL THEN RETURN jsonb_build_object('refused','unsaved'); END IF;
 -- The attempt's applied items as the creator's session reads them (row security: Import History view of each item's
 -- company), every one of them; never the job's stored plan.
 SELECT count(*) INTO applied_ FROM public.import_attempt_item i WHERE i.attempt_id=attempt_ AND i.tenant_id=t AND i.status='applied';
 CREATE TEMP TABLE revert_release_item ON COMMIT DROP AS
  SELECT i.id,i.employment_id,i.ordinal,i.item_key FROM public.import_attempt_item i
  WHERE i.attempt_id=attempt_ AND i.tenant_id=t AND i.status='applied' AND app.import_item_access(attempt_,i.company_id,'view')
   AND app.information_import_history_access(attempt_)
   AND (i.employment_id IS NULL OR NOT (i.employment_id IN (SELECT unnest(app.import_pending_employment_ids()))));
 SELECT count(*) INTO visible_ FROM pg_temp.revert_release_item;
 IF visible_=0 THEN RETURN jsonb_build_object('refused','empty'); END IF;
 IF visible_<>applied_ THEN RETURN jsonb_build_object('refused','maintain'); END IF;
 SELECT array_agg(DISTINCT x.employment_id ORDER BY x.employment_id) INTO ids FROM pg_temp.revert_release_item x WHERE x.employment_id IS NOT NULL;
 IF ids IS NULL OR EXISTS(SELECT 1 FROM pg_temp.revert_release_item x WHERE x.employment_id IS NULL) THEN RETURN jsonb_build_object('refused','blocked'); END IF;
 -- Every employee still available: live, not voided, visible, and in a company the creator maintains, decided once per
 -- company (app.access_workforce_employment is exactly these conditions per employment).
 PERFORM 1 FROM public.employment e WHERE e.id=ANY(ids) ORDER BY e.id FOR UPDATE;
 IF EXISTS(
  WITH companies AS (SELECT c.company_id,app.access_workforce_company(c.company_id,'workforce.maintain') AS ok
   FROM (SELECT DISTINCT e.company_id FROM public.employment e WHERE e.id=ANY(ids) AND e.tenant_id=t) c)
  SELECT 1 FROM unnest(ids) x LEFT JOIN public.employment e ON e.id=x AND e.tenant_id=t LEFT JOIN companies c ON c.company_id=e.company_id
  WHERE e.id IS NULL OR e.voided_at IS NOT NULL OR NOT app.import_marker_visible(e.import_pending_attempt_id) OR NOT coalesce(c.ok,false))
  -- The person void guard's maintain (app.access_workforce_person): no employment of these persons in a denied company.
  OR EXISTS(SELECT 1 FROM (SELECT DISTINCT o.company_id FROM public.employment e JOIN public.employment o ON o.person_id=e.person_id AND o.tenant_id=e.tenant_id
   WHERE e.id=ANY(ids)) c WHERE NOT app.access_workforce_not_denied(c.company_id,'workforce.maintain'))
  OR EXISTS(SELECT 1 FROM app.employment_void_reference_blockers(ids)) THEN
  RETURN jsonb_build_object('refused','blocked');
 END IF;
 -- The reviewed preview still holds: the hash the creator confirmed, recomputed here exactly as the review computes it
 -- (core/import-history.ts revertPlanTx with every item available and no blocker: canonical JSON, sorted keys).
 SELECT encode(sha256(convert_to('{"actorId":"'||u::text||'","attemptId":"'||attempt_::text||'","blockers":[],"confirmedEventId":"'||confirmed_::text
   ||'","fingerprint":{'||(SELECT string_agg('"'||x.id::text||'":[]',',' ORDER BY x.id::text COLLATE "C") FROM pg_temp.revert_release_item x)
   ||'},"items":['||(SELECT string_agg('"'||x.id::text||'"',',' ORDER BY x.ordinal,x.item_key) FROM pg_temp.revert_release_item x)
   ||'],"kind":"employee_full"}','UTF8')),'hex') INTO hash_;
 IF hash_ IS DISTINCT FROM j.input->>'previewHash' THEN RETURN jsonb_build_object('refused','changed'); END IF;
 -- Every check above ran as the creator. The writes below run in the staged import discard's environment (owner
 -- connection, no request tenant or user: app.import_discard_batch), so the per-row guards take their owner path instead
 -- of re-deciding, per row, what was just decided for the set. No trigger on these tables records the session's user
 -- (the audit events below name the creator and tenant explicitly) and a void changes no system label. The
 -- last-administrator constraint, which each voided row would otherwise re-assert at COMMIT, is asserted once for the
 -- tenant below: none of these persons has a login (an app_user is a void blocker).
 PERFORM set_config('app.tenant_id','',true),set_config('app.user_id','',true),set_config('app.roles','',true),set_config('app.grants','[]',true);
 -- app.employment_void, as one statement per table.
 SELECT array_agg(DISTINCT e.person_id) INTO persons FROM public.employment e WHERE e.id=ANY(ids);
 UPDATE public.person p SET voided_at=now(),voided_ic_number=(SELECT s.ic_number FROM public.employee_statutory_my s WHERE s.person_id=p.id)
  WHERE p.id=ANY(persons) AND p.tenant_id=t;
 UPDATE public.employee_statutory_my s SET ic_number=NULL WHERE s.person_id=ANY(persons) AND s.tenant_id=t AND s.ic_number IS NOT NULL;
 WITH voided AS (
  UPDATE public.employment e SET voided_at=now(),voided_by=u,void_reason=reason_,voided_import_attempt_id=attempt_,
   voided_employee_code=e.employee_code,employee_code=NULL WHERE e.id=ANY(ids) AND e.tenant_id=t RETURNING e.id,e.voided_employee_code)
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload)
 SELECT t,'employment',v.id,'employment.voided','user',u,v.id,jsonb_build_object('importAttemptId',attempt_,'reason',reason_,'employeeCode',v.voided_employee_code)
 -- File order (the attempt's item ordinal): the synchronous void emitted its events in its UPDATE's scan order, which
 -- for an attempt's own rows is the order the import wrote them.
 FROM voided v ORDER BY (SELECT min(x.ordinal) FROM pg_temp.revert_release_item x WHERE x.employment_id=v.id),v.id;
 GET DIAGNOSTICS n=ROW_COUNT;
 IF n<>cardinality(ids) THEN RAISE EXCEPTION 'employee_import_revert_unavailable' USING ERRCODE='55000'; END IF;
 -- Import History: the attempt's once-only reverted event and its audit event (recordImportEventTx).
 INSERT INTO public.import_attempt_event(tenant_id,attempt_id,kind,actor_id,reason,detail)
 VALUES(t,attempt_,'reverted',u,reason_,jsonb_build_object('restored',n,'voided',n));
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
 VALUES(t,'import-attempt',attempt_,'import-attempt.reverted','user',u,jsonb_build_object('kind','employee_full','reason',reason_,'restored',n,'voided',n));
 PERFORM set_config('app.tenant_id',t::text,true);
 PERFORM app.access_assert_administrator();
 PERFORM set_config('app.tenant_id','',true);
 -- The job store is written only through the kernel's sealed worker update (5013): the worker records the release on
 -- the job's plan (released, restored) in this same owner transaction (unit.set in core/employee-import-revert-job.ts).
 RETURN jsonb_build_object('released',true,'restored',n);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.employee_import_revert_release(uuid,boolean) FROM PUBLIC,ai_hr_app;
