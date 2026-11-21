-- UNALLOCATED final combined-source compatibility repair. STAGING owns journal/tag allocation.
-- Apply AFTER every original Resignation and Contract body, before release admission.
-- Add only the existing Resignation branches/check. Preserve Contract/Probation guards,
-- digest provenance, account/Person checks, immutable delivery proof, OIDs, owners and ACLs.
-- No new grant, policy, role, data write, caller impersonation or HR effect.

--> statement-breakpoint
DO $repair$
DECLARE signature regprocedure:=to_regprocedure('app.automation_run_subject_access(text,uuid)'); definition text; old_body text;
 new_body text:=$combined_body$
 SELECT coalesce(app.current_tenant_id() IS NOT NULL AND CASE p_module
 WHEN 'probation' THEN app.probation_active_user() AND app.probation_case_access(p_subject)
 WHEN 'contract_staff' THEN app.contract_shared_case_permitted(p_subject,'view') WHEN 'off' THEN app.resignation_journey_access(p_subject) ELSE false END,false)
$combined_body$;
BEGIN
 IF signature IS NULL THEN RAISE EXCEPTION 'Missing combined compatibility predecessor: app.automation_run_subject_access(text,uuid)'; END IF;
 SELECT prosrc,pg_get_functiondef(oid) INTO old_body,definition FROM pg_proc WHERE oid=signature;
 IF encode(sha256(convert_to(old_body,'UTF8')),'hex') IS DISTINCT FROM '20a9f1782de5c5a507589664332659b2e914a0f91a581a65336df335aae8e0ad' THEN
  RAISE EXCEPTION 'Unreviewed combined compatibility predecessor: app.automation_run_subject_access(text,uuid)';
 END IF;
 IF strpos(definition,old_body)=0 THEN RAISE EXCEPTION 'Combined compatibility body unavailable: app.automation_run_subject_access(text,uuid)';END IF;
 EXECUTE replace(definition,old_body,new_body);
END $repair$;

--> statement-breakpoint
DO $repair$
DECLARE signature regprocedure:=to_regprocedure('app.automation_can_run(text,uuid)'); definition text; old_body text;
 new_body text:=$combined_body$
 SELECT coalesce(app.current_tenant_id() IS NOT NULL AND p_subject IS NOT NULL AND CASE p_module
 WHEN 'probation' THEN app.probation_storage_runner() OR app.automation_run_subject_access(p_module,p_subject)
 WHEN 'contract_staff' THEN (app.contract_shared_digest_held(p_subject) OR EXISTS(SELECT 1 FROM public.contract_shared_event e WHERE e.tenant_id=app.current_tenant_id() AND e.case_id=p_subject AND e.id::text=current_setting('app.contract_event',true)
 AND app.contract_shared_worker_event_held(e.case_id,e.decision_revision))) WHEN 'off' THEN app.resignation_runtime_intent(p_subject) ELSE false END,false)
$combined_body$;
BEGIN
 IF signature IS NULL THEN RAISE EXCEPTION 'Missing combined compatibility predecessor: app.automation_can_run(text,uuid)'; END IF;
 SELECT prosrc,pg_get_functiondef(oid) INTO old_body,definition FROM pg_proc WHERE oid=signature;
 IF encode(sha256(convert_to(old_body,'UTF8')),'hex') IS DISTINCT FROM 'f7f1cb95bb99a60d5961051c8a67bf0b0974c7eb1299ade13d631d46282c642a' THEN
  RAISE EXCEPTION 'Unreviewed combined compatibility predecessor: app.automation_can_run(text,uuid)';
 END IF;
 IF strpos(definition,old_body)=0 THEN RAISE EXCEPTION 'Combined compatibility body unavailable: app.automation_can_run(text,uuid)';END IF;
 EXECUTE replace(definition,old_body,new_body);
END $repair$;

--> statement-breakpoint
DO $repair$
DECLARE signature regprocedure:=to_regprocedure('app.automation_email_target_before_template_tests(uuid,uuid,text)'); definition text; old_body text;
 new_body text:=$combined_body$
DECLARE job public.automation_email_delivery%ROWTYPE; recipients jsonb; bindings jsonb; total integer;
BEGIN
  IF p_origin IS NULL OR p_origin !~ '^https://[^/@?#[:space:]]+(:[0-9]+)?$' THEN RETURN NULL; END IF;
  SELECT * INTO job FROM public.automation_email_delivery WHERE id = p_id AND lease_token = p_token
    AND status = 'leased' AND started_at IS NULL AND lease_until > clock_timestamp();
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF job.module = 'probation' AND NOT EXISTS(SELECT 1 FROM public.probation_case c WHERE c.id = job.subject_id AND c.tenant_id = job.tenant_id) THEN RETURN NULL; END IF;
  IF job.module = 'off' AND NOT EXISTS(SELECT 1 FROM public.resignation_journey j WHERE j.id=job.subject_id AND j.tenant_id=job.tenant_id) THEN RETURN NULL; END IF;
  IF job.module='contract_staff' AND app.contract_shared_delivery_eligible(job.id,job.tenant_id,job.subject_id,job.payload->'context') IS NOT TRUE THEN RETURN NULL;END IF;
  recipients := coalesce(job.payload->'mail'->'to', '[]'::jsonb) || coalesce(job.payload->'mail'->'cc', '[]'::jsonb);
  SELECT count(*) INTO total FROM jsonb_array_elements_text(recipients);
  SELECT jsonb_agg(jsonb_build_object('userId', r.uid, 'subject', identity.subject, 'issuer', identity.issuer) ORDER BY r.ordinality)
    INTO bindings
    FROM jsonb_array_elements_text(recipients) WITH ORDINALITY r(uid, ordinality)
    JOIN public.app_user u ON u.id::text = r.uid AND u.tenant_id = job.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
    JOIN public.app_external_identity identity ON identity.app_user_id = u.id AND identity.issuer = p_origin || '/auth/' || job.tenant_id::text AND identity.revoked_at IS NULL AND (job.module<>'contract_staff' OR u.person_id::text=job.payload->'context'->'recipientPeople'->>u.id::text);
  bindings := coalesce(bindings, '[]'::jsonb);
  IF total < 1 OR jsonb_array_length(bindings) <> total OR (SELECT count(DISTINCT b->>'userId') FROM jsonb_array_elements(bindings) b) <> total THEN RETURN NULL; END IF;
  IF job.module='contract_staff' AND nullif(job.payload->'context'->>'approvalId','') IS NOT NULL AND EXISTS(
    SELECT 1 FROM jsonb_array_elements_text(recipients) recipient WHERE NOT EXISTS(
      SELECT 1 FROM public.contract_shared_approval approval JOIN public.document_signing_document signing ON signing.tenant_id=approval.tenant_id AND signing.id=approval.signing_document_id
      CROSS JOIN LATERAL app.document_signing_pending_steps(signing.data) pending
      WHERE approval.tenant_id=job.tenant_id AND approval.case_id=job.subject_id AND approval.id::text=job.payload->'context'->>'approvalId'
      AND app.contract_shared_approval_eligible_user(approval.tenant_id,approval.id,pending->>'id',recipient::uuid))) THEN RETURN NULL;END IF;
  IF job.module='contract_staff' THEN
    job.payload:=jsonb_set(job.payload,'{linkPath}',to_jsonb(app.contract_shared_delivery_link(job.tenant_id,job.subject_id,(job.payload->'mail'->'to'->>0)::uuid,job.payload->'context')));
  END IF;
  RETURN jsonb_build_object('id', job.id, 'tenantId', job.tenant_id, 'module', job.module, 'subjectId', job.subject_id, 'payload', job.payload, 'bindings', bindings);
END $combined_body$;
BEGIN
 IF signature IS NULL THEN RAISE EXCEPTION 'Missing combined compatibility predecessor: app.automation_email_target_before_template_tests(uuid,uuid,text)'; END IF;
 SELECT prosrc,pg_get_functiondef(oid) INTO old_body,definition FROM pg_proc WHERE oid=signature;
 IF encode(sha256(convert_to(old_body,'UTF8')),'hex') IS DISTINCT FROM '56613c08f8f3bcf4eb5bcc5c03743381c9e0614f0221efe7f143c44e10718a5e' THEN
  RAISE EXCEPTION 'Unreviewed combined compatibility predecessor: app.automation_email_target_before_template_tests(uuid,uuid,text)';
 END IF;
 IF strpos(definition,old_body)=0 THEN RAISE EXCEPTION 'Combined compatibility body unavailable: app.automation_email_target_before_template_tests(uuid,uuid,text)';END IF;
 EXECUTE replace(definition,old_body,new_body);
END $repair$;

--> statement-breakpoint
-- 6015 already composes the exact Offboarding configuration conjunction. Refuse drift;
-- do not replace it or reintroduce the older Resignation-only definition.
DO $verify$
BEGIN
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='app.automation_can_configure(text)'::regprocedure)
  IS DISTINCT FROM 'b0bb6d4e2743d83d6ab14ee757555fbfd6707db0bb82ff0b8505a44484a434fc' THEN
  RAISE EXCEPTION 'Expected combined Contract, Probation and Offboarding configuration guard';
 END IF;
END $verify$;
