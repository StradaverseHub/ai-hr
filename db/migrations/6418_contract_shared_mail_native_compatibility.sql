-- Contract-only composition: preserve accepted native V9 On/Off transport and existing private function OID.
-- Supersedes only the pending mixed5834 activation; original source bytes remain retained and inactive.
CREATE OR REPLACE FUNCTION app.automation_email_target_before_template_tests(p_id uuid, p_token uuid, p_origin text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE job public.automation_email_delivery%ROWTYPE; recipients jsonb; bindings jsonb; total integer;
BEGIN
  IF p_origin IS NULL OR p_origin !~ '^https://[^/@?#[:space:]]+(:[0-9]+)?$' THEN RETURN NULL; END IF;
  SELECT * INTO job FROM public.automation_email_delivery WHERE id = p_id AND lease_token = p_token
    AND status = 'leased' AND started_at IS NULL AND lease_until > clock_timestamp();
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF job.module = 'probation' AND NOT EXISTS(SELECT 1 FROM public.probation_case c WHERE c.id = job.subject_id AND c.tenant_id = job.tenant_id) THEN RETURN NULL; END IF;
  IF job.module='contract_staff' AND app.contract_shared_delivery_eligible(job.tenant_id,job.subject_id,job.payload->'context') IS NOT TRUE THEN RETURN NULL;END IF;
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
END $$;

REVOKE ALL ON FUNCTION app.automation_email_target_before_template_tests(uuid,uuid,text) FROM PUBLIC,ai_hr_app;
