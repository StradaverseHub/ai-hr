-- DRAFT: allocate after the V9 private-delivery prerequisites at the integration freeze.
-- A selected business mailbox is a frozen destination; it never resolves or grants an app identity.
CREATE FUNCTION app.lc_v9_literal_address(p_key text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT CASE WHEN p_key LIKE 'address:%' AND length(substring(p_key FROM 9)) BETWEEN 3 AND 254
  AND substring(p_key FROM 9) !~ '[[:space:]<>;,"\\]'
  AND substring(p_key FROM 9) ~ '^[^@]+@[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$'
 THEN substring(p_key FROM 9) ELSE NULL END
$$;
REVOKE ALL ON FUNCTION app.lc_v9_literal_address(text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION app.lc_v9_email_target(p_id uuid,p_token uuid,p_origin text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE job lc_v9_email_delivery%ROWTYPE; state jsonb; subject jsonb; parent_state text; bindings jsonb; total integer; contact jsonb; contact_email text; recipient_ids jsonb; literals jsonb;
BEGIN
 IF p_origin !~ '^https://[^/@?#[:space:]]+(:[0-9]+)?$' THEN RETURN NULL; END IF;
 SELECT * INTO job FROM lc_v9_email_delivery WHERE id=p_id AND lease_token=p_token
  AND status='leased' AND started_at IS NULL AND lease_until>clock_timestamp();
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF job.case_id IS NOT NULL THEN
  SELECT c.data,c.data->>'state',jsonb_build_object('personId',c.data->'facts'->>'personId','employmentId',c.data->'facts'->>'employmentId')
   INTO state,parent_state,subject FROM lc_v9_case c
   WHERE c.id=job.case_id AND c.tenant_id=job.tenant_id AND c.company_id=job.company_id;
 ELSE
  SELECT p.data->'lifecycleV9',c.data->>'state',p.data->'lifecycleV9Subject',CASE WHEN p.data ? 'caseContactEmail' THEN p.data->>'caseContactEmail' WHEN c.data->'source' ? 'email' THEN c.data->'source'->>'email' ELSE c.data->'local'->>'email' END
   INTO state,parent_state,subject,contact_email FROM lc_onboarding_case c JOIN lc_onboarding_private p ON p.case_id=c.id AND p.tenant_id=c.tenant_id
   WHERE c.id=job.onboarding_case_id AND c.tenant_id=job.tenant_id AND c.company_id=job.company_id
    AND (p.data->'lifecycleV9Subject'->>'personId') IS NOT DISTINCT FROM c.data->>'personId'
    AND (p.data->'lifecycleV9Subject'->>'employmentId') IS NOT DISTINCT FROM c.data->>'employmentId';
 END IF;
 IF (parent_state IS DISTINCT FROM 'submitted' AND NOT app.lc_v9_is_self_test(job.payload->'mail')) OR
  (job.payload->'mail'->'test'='true'::jsonb AND NOT app.lc_v9_is_self_test(job.payload->'mail')) OR subject IS DISTINCT FROM job.payload->'subject' OR
  NOT EXISTS(SELECT 1 FROM jsonb_array_elements(state->'mails') m WHERE m->>'id'=job.mail_id AND m->>'status'='sending')
 THEN RETURN NULL; END IF;
 -- A document changed through another writer must never be marked sent as a different copy.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(job.payload->'documents') frozen
  WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(state->'documents') current WHERE current=frozen)) THEN RETURN NULL; END IF;
 contact:=job.payload->'mail'->'delivery'->'contact';
 IF contact IS NOT NULL THEN
  IF job.onboarding_case_id IS NULL OR contact->>'kind' IS DISTINCT FROM 'onboardingContact' OR
   contact->>'caseId' IS DISTINCT FROM job.onboarding_case_id::text OR contact->>'email' IS DISTINCT FROM trim(contact_email) OR
   job.payload->'mail'->'to'->>0 IS DISTINCT FROM contact->>'email' OR
   jsonb_array_length(job.payload->'mail'->'delivery'->'linkDocumentIds')<>0 THEN RETURN NULL; END IF;
 END IF;
 recipient_ids:=(CASE WHEN contact IS NULL THEN job.payload->'mail'->'to' ELSE '[]'::jsonb END)||coalesce(job.payload->'mail'->'cc','[]'::jsonb);
 SELECT coalesce(jsonb_agg(jsonb_build_object('key',r.uid,'email',app.lc_v9_literal_address(r.uid),'position',r.ordinality+(CASE WHEN contact IS NULL THEN 0 ELSE 1 END)) ORDER BY r.ordinality) FILTER(WHERE r.uid LIKE 'address:%'),'[]'::jsonb)
  INTO literals FROM jsonb_array_elements_text(recipient_ids) WITH ORDINALITY r(uid,ordinality);
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(literals) r WHERE r->>'email' IS NULL) THEN RETURN NULL; END IF;
 SELECT coalesce(jsonb_agg(r.uid ORDER BY r.ordinality),'[]'::jsonb) INTO recipient_ids FROM jsonb_array_elements_text(recipient_ids) WITH ORDINALITY r(uid,ordinality) WHERE r.uid NOT LIKE 'address:%';
 SELECT count(*) INTO total FROM jsonb_array_elements_text(recipient_ids);
 SELECT jsonb_agg(jsonb_build_object('userId',r.uid,'subject',identity.subject,'issuer',identity.issuer) ORDER BY r.ordinality)
  INTO bindings
  FROM jsonb_array_elements_text(recipient_ids) WITH ORDINALITY r(uid,ordinality)
  JOIN app_user u ON u.id::text=r.uid AND u.tenant_id=job.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
  JOIN app_external_identity identity ON identity.app_user_id=u.id AND identity.issuer=p_origin||'/auth/'||job.tenant_id::text AND identity.revoked_at IS NULL;
 bindings:=coalesce(bindings,'[]'::jsonb);
 IF jsonb_array_length(bindings)<>total OR total<1 AND contact IS NULL AND jsonb_array_length(literals)=0 OR
  (SELECT count(DISTINCT b->>'userId') FROM jsonb_array_elements(bindings) b)<>total THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('id',job.id,'tenantId',job.tenant_id,'companyId',job.company_id,'caseId',coalesce(job.case_id,job.onboarding_case_id),'payload',job.payload,'bindings',bindings,'contact',contact,'literals',literals);
END;
$$;
REVOKE ALL ON FUNCTION app.lc_v9_email_target(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lc_v9_email_target(uuid,uuid,text) TO ai_hr_app;

-- This statement commits before SMTP starts. A crash after this boundary becomes uncertain;
-- an expired lease with this marker is never requeued automatically.
CREATE OR REPLACE FUNCTION app.lc_v9_email_start(p_id uuid,p_token uuid,p_origin text,p_proof jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE target jsonb;
BEGIN
 PERFORM 1 FROM lc_v9_email_delivery WHERE id=p_id AND lease_token=p_token FOR UPDATE;
 target:=app.lc_v9_email_target(p_id,p_token,p_origin);
 IF target IS NULL OR jsonb_typeof(p_proof) IS DISTINCT FROM 'object' OR p_proof->'bindings' IS DISTINCT FROM target->'bindings' OR p_proof->'contact' IS DISTINCT FROM target->'contact' OR coalesce(p_proof->'literals','[]'::jsonb) IS DISTINCT FROM target->'literals' OR
    jsonb_typeof(p_proof->'addresses') IS DISTINCT FROM 'array' OR jsonb_array_length(p_proof->'addresses')<>jsonb_array_length(target->'bindings')+jsonb_array_length(target->'literals')+(CASE WHEN target->'contact' IS NOT NULL AND target->'contact'<>'null'::jsonb THEN 1 ELSE 0 END) OR
    coalesce(p_proof->>'relayRevision','')='' THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(target->'literals') literal WHERE p_proof->'addresses'->>((literal->>'position')::integer-1) IS DISTINCT FROM literal->>'email') THEN RETURN false; END IF;
 UPDATE lc_v9_email_delivery SET status='sending',started_at=clock_timestamp(),recipient_proof=p_proof,updated_at=now()
  WHERE id=p_id AND lease_token=p_token AND status='leased' AND started_at IS NULL;
 RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION app.lc_v9_email_start(uuid,uuid,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lc_v9_email_start(uuid,uuid,text,jsonb) TO ai_hr_app;
