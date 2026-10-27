-- SOURCE ONLY fragment. Consolidate with the coordinated native outcome migration BEFORE first
-- application. UNALLOCATED / UNJOURNALED / UNAPPLIED; never edit an already applied 0627 file.
-- Historical proof of a human-selected canonical completion is not current HR truth, a quality
-- score or causal attribution. Independent evaluators read their own freshly authorized facts.
ALTER TABLE public.ai_agent_candidate_provenance ADD COLUMN native_refs jsonb NOT NULL DEFAULT '[]'::jsonb
 CHECK(jsonb_typeof(native_refs)='array' AND jsonb_array_length(native_refs)<=1);
--> statement-breakpoint
-- Only metadata already bound to a currently visible candidate can be checked by the migration
-- owner's FORCE-RLS policy. No arbitrary association/job reader or author impersonation is exposed.
CREATE FUNCTION app.agent_native_signal_custody_visible(wanted_kind text,wanted_id uuid,wanted_tenant uuid,wanted_owner uuid)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET row_security=on AS $$
BEGIN
 IF wanted_kind IS NULL OR wanted_kind NOT IN('association','job') OR wanted_id IS NULL OR wanted_tenant IS NULL OR wanted_owner IS NULL
 OR app.current_user_id() IS NULL OR app.current_tenant_id() IS NULL OR wanted_tenant IS DISTINCT FROM app.current_tenant_id()
 OR app.principal_snapshot_current() IS DISTINCT FROM true OR current_setting('transaction_isolation')<>'read committed' THEN RETURN false;END IF;
 RETURN EXISTS(SELECT 1 FROM public.ai_agent_candidate c JOIN public.ai_agent_candidate_provenance p
 ON p.candidate_id=c.id AND p.tenant_id=c.tenant_id AND p.owner_user_id=c.owner_user_id
 WHERE c.tenant_id=wanted_tenant AND c.owner_user_id=wanted_owner AND(c.owner_user_id=app.current_user_id() OR app.is_group_admin())
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(p.native_refs) r WHERE
 CASE wanted_kind WHEN 'association' THEN r->>'associationId' ELSE r->>'jobId' END=wanted_id::text));
END $$;
REVOKE ALL ON FUNCTION app.agent_native_signal_custody_visible(text,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.agent_native_signal_custody_visible(text,uuid,uuid,uuid) TO ai_hr_app;
CREATE POLICY native_outcome_candidate_owner ON public.ai_native_outcome_association FOR SELECT TO PUBLIC
 USING(current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.ai_native_outcome_association'::regclass))
 AND tenant_id=app.current_tenant_id() AND app.principal_snapshot_current()
 AND app.agent_native_signal_custody_visible('association',id,tenant_id,user_id));
CREATE POLICY native_outcome_job_candidate_owner ON public.ai_agent_job_receipt FOR SELECT TO PUBLIC
 USING(current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.ai_agent_job_receipt'::regclass))
 AND tenant_id=app.current_tenant_id() AND app.principal_snapshot_current()
 AND app.agent_native_signal_custody_visible('job',id,tenant_id,user_id));
--> statement-breakpoint
CREATE FUNCTION app.agent_candidate_native_signals_current(wanted_candidate uuid) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET row_security=on AS $$
DECLARE c public.ai_agent_candidate%ROWTYPE;p public.ai_agent_candidate_provenance%ROWTYPE;r jsonb;
BEGIN
 IF wanted_candidate IS NULL OR app.current_user_id() IS NULL OR app.current_tenant_id() IS NULL
 OR app.principal_snapshot_current() IS DISTINCT FROM true OR current_setting('transaction_isolation')<>'read committed' THEN RETURN false;END IF;
 SELECT * INTO c FROM public.ai_agent_candidate WHERE id=wanted_candidate AND tenant_id=app.current_tenant_id()
 AND(owner_user_id=app.current_user_id() OR app.is_group_admin());IF NOT FOUND THEN RETURN false;END IF;
 SELECT * INTO p FROM public.ai_agent_candidate_provenance WHERE candidate_id=c.id AND tenant_id=c.tenant_id AND owner_user_id=c.owner_user_id;
 IF NOT FOUND OR coalesce(jsonb_typeof(p.native_refs),'')<>'array' OR jsonb_array_length(p.native_refs)>1 THEN RETURN false;END IF;
 IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('native-outcome:v1:'||c.tenant_id::text||':'||c.owner_user_id::text,0)) THEN RETURN false;END IF;
 FOR r IN SELECT value FROM jsonb_array_elements(p.native_refs) LOOP
  IF coalesce(jsonb_typeof(r),'')<>'object' OR (SELECT count(*) FROM jsonb_object_keys(r))<>8
  OR coalesce(r->>'associationId','')!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
  OR coalesce(r->>'jobId','')!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
  OR coalesce(r->>'associationReceiptDigest','')!~'^[a-f0-9]{64}$' OR coalesce(r->>'nativeDigest','')!~'^[a-f0-9]{64}$'
  OR coalesce(r->>'jobReceiptDigest','')!~'^[a-f0-9]{64}$' OR coalesce(r->>'expiresAt','')!~'^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$'
  OR(c.kind='canonical_specialist_v1' AND c.module_code IS DISTINCT FROM r->>'module') THEN RETURN false;END IF;
  IF NOT EXISTS(SELECT 1 FROM public.ai_native_outcome_association a JOIN public.ai_agent_job_receipt j
   ON j.id=a.job_id AND j.tenant_id=a.tenant_id AND j.user_id=a.user_id
   WHERE a.id=(r->>'associationId')::uuid AND j.id=(r->>'jobId')::uuid AND a.tenant_id=c.tenant_id AND a.user_id=c.owner_user_id
   AND a.consented AND a.action=r->>'action' AND a.expires_at>now() AND a.expires_at=(r->>'expiresAt')::timestamptz
   AND j.expires_at>=a.expires_at AND j.request_nonce IS NOT NULL AND a.native_digest=r->>'nativeDigest'
   AND a.job_receipt_digest=r->>'jobReceiptDigest' AND encode(sha256(convert_to(a.receipt,'UTF8')),'hex')=r->>'associationReceiptDigest'
   AND encode(sha256(convert_to(j.receipt,'UTF8')),'hex')=r->>'jobReceiptDigest') THEN RETURN false;END IF;
 END LOOP;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION app.agent_candidate_native_signals_current(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.agent_candidate_native_signals_current(uuid) TO ai_hr_app;
