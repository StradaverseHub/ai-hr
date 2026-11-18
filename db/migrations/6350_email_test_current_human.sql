-- Forward guard: a queued self-test still requires the actual named human, not only a non-null person key.
CREATE OR REPLACE FUNCTION app.automation_email_test_target(p_id uuid,p_token uuid,p_origin text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE job public.automation_email_delivery; bindings jsonb; target_user uuid;
BEGIN
 IF p_origin IS NULL OR p_origin!~'^https://[^/@?#[:space:]]+(:[0-9]+)?$' THEN RETURN NULL;END IF;
 SELECT * INTO job FROM public.automation_email_delivery WHERE id=p_id AND lease_token=p_token AND status='leased' AND started_at IS NULL AND lease_until>clock_timestamp() AND payload->>'purpose'='templateTest';
 IF NOT FOUND THEN RETURN NULL;END IF;
 target_user:=job.created_by;
 IF job.payload->'test'->>'userId' IS DISTINCT FROM target_user::text OR job.payload->'test'->>'templateId' IS DISTINCT FROM job.subject_id::text
 OR job.payload->'mail'->'to' IS DISTINCT FROM jsonb_build_array(target_user) OR job.payload->'mail'->'cc' IS DISTINCT FROM '[]'::jsonb
 OR job.payload->'test'->>'authority' IS DISTINCT FROM app.automation_email_test_authority(job.tenant_id,target_user)
 OR NOT EXISTS(SELECT 1 FROM public.tenant tenant JOIN public.tenant_module module ON module.tenant_id=tenant.id WHERE tenant.id=job.tenant_id AND tenant.status IN('active','trial') AND module.module_code='lifecycle' AND module.status IN('active','trial') AND (module.expires_at IS NULL OR module.expires_at>now()))
 OR NOT EXISTS(SELECT 1 FROM public.automation_email_template_version v WHERE v.tenant_id=job.tenant_id AND v.template_id=job.subject_id AND v.module=job.module AND v.revision::text=job.payload->'test'->>'revision' AND NOT v.retired)
 THEN RETURN NULL;END IF;
 SELECT jsonb_agg(jsonb_build_object('userId',u.id,'subject',i.subject,'issuer',i.issuer)) INTO bindings FROM public.app_user u
 JOIN public.person person ON person.tenant_id=u.tenant_id AND person.id=u.person_id AND length(btrim(person.full_name))>0
 JOIN public.app_external_identity i ON i.app_user_id=u.id AND i.issuer=p_origin||'/auth/'||job.tenant_id::text AND i.revoked_at IS NULL
 WHERE u.tenant_id=job.tenant_id AND u.id=target_user AND u.person_id::text=job.payload->'test'->>'personId' AND u.person_id IS NOT NULL AND u.archived_at IS NULL AND NOT app.login_blocked(u.id);
 IF coalesce(jsonb_array_length(bindings),0)<>1 THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('id',job.id,'tenantId',job.tenant_id,'module',job.module,'subjectId',job.subject_id,'payload',job.payload,'bindings',bindings);
END $$;
