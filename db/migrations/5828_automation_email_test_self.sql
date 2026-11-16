-- A saved-template test is a separate, explicit purpose in the existing immutable mail queue.
-- The only recipient is the actual signed-in template editor. Default CC and real case data are never used.
-- Seal the sources read by the existing permission owner instead of impersonating the editor in the sender.
CREATE FUNCTION app.automation_email_test_authority(p_tenant uuid,p_user uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT encode(sha256(jsonb_build_object(
  'date',(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date,
  'roles',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]'::jsonb) FROM public.role_assignment r WHERE r.tenant_id=p_tenant AND r.app_user_id=p_user),
  'contractRoles',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]'::jsonb) FROM public.contract_role_assignment r WHERE r.tenant_id=p_tenant AND r.user_id=p_user),
  'contractMembers',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]'::jsonb) FROM public.contract_access_member r WHERE r.tenant_id=p_tenant AND r.user_id=p_user),
  'contractPermissions',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]'::jsonb) FROM public.contract_access_role r WHERE r.tenant_id=p_tenant),
  'probationMembers',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]'::jsonb) FROM public.probation_access_member r WHERE r.tenant_id=p_tenant AND r.user_id=p_user),
  'probationPermissions',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]'::jsonb) FROM public.probation_access_role r WHERE r.tenant_id=p_tenant),
  'probationRules',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.tenant_id),'[]'::jsonb) FROM public.probation_access_rule r WHERE r.tenant_id=p_tenant),
  'access',(SELECT to_jsonb(g) FROM app.access_profile_write_generation g WHERE g.tenant_id=p_tenant),
  'nativeGroups',(SELECT jsonb_build_object('revision',revision,'data',data) FROM public.lc_onboarding_config WHERE tenant_id=p_tenant),
  'lifecycle',(SELECT jsonb_build_object('revision',revision,'data',data) FROM public.lc_v9_config WHERE tenant_id=p_tenant),
  'companies',(SELECT coalesce(jsonb_agg(jsonb_build_array(c.id,c.parent_company_id,c.archived_at) ORDER BY c.id),'[]'::jsonb) FROM public.company c WHERE c.tenant_id=p_tenant),
  'modules',(SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.id),'[]'::jsonb) FROM public.tenant_module m WHERE m.tenant_id=p_tenant AND m.module_code='lifecycle')
 )::text::bytea),'hex')
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.automation_email_test_authority(uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.automation_email_test_queue(p_template uuid,p_expected integer,p_request uuid,p_subject text,p_values jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id(); u uuid:=app.current_user_id(); pid uuid; template public.automation_email_template_version; result uuid; v_body text; v_key text; v_value text;
BEGIN
 PERFORM app.access_workforce_write_lock();
 SELECT * INTO template FROM public.automation_email_template_version WHERE tenant_id=t AND template_id=p_template ORDER BY revision DESC LIMIT 1;
 IF template.template_id IS NULL OR app.automation_can_manage(template.module,'templates') IS NOT TRUE OR app.contract_verified_human(u) IS NOT TRUE THEN RAISE EXCEPTION 'This email template is unavailable' USING ERRCODE='42501';END IF;
 IF template.revision IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'This email template changed' USING ERRCODE='40001';END IF;
 SELECT person_id INTO pid FROM public.app_user WHERE tenant_id=t AND id=u;
 IF template.retired OR p_request IS NULL OR length(btrim(coalesce(p_subject,''))) NOT BETWEEN 1 AND 500 OR jsonb_typeof(p_values) IS DISTINCT FROM 'object' OR octet_length(p_values::text)>65536 THEN RAISE EXCEPTION 'Save a valid template before testing it' USING ERRCODE='22023';END IF;
 IF (SELECT count(*) FROM jsonb_each(p_values))>200 OR EXISTS(SELECT 1 FROM jsonb_each(p_values) value WHERE length(value.key)>100 OR jsonb_typeof(value.value) IS DISTINCT FROM 'string' OR length(value.value#>>'{}')>1000) THEN RAISE EXCEPTION 'Use bounded fictional preview values for this test' USING ERRCODE='22023';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.app_external_identity i WHERE i.app_user_id=u AND i.revoked_at IS NULL AND i.issuer LIKE '%/auth/'||t::text) THEN RAISE EXCEPTION 'Your account needs a verified sign-in email before sending a test' USING ERRCODE='22023';END IF;
 v_body:=template.body;
 FOR v_key,v_value IN SELECT key,value FROM jsonb_each_text(p_values) WHERE key<>'case.link' LOOP
  v_body:=replace(v_body,'{{'||v_key||'}}',v_value);
 END LOOP;
 IF length(v_body)>20000 THEN RAISE EXCEPTION 'The merged test message is too long' USING ERRCODE='22023';END IF;
 INSERT INTO public.automation_email_delivery(tenant_id,module,subject_id,mail_key,payload,created_by)
 VALUES(t,template.module,p_template,'test:'||u::text||':'||p_request::text,jsonb_build_object('version',1,'module',template.module,'subjectId',p_template,'purpose','templateTest',
  'test',jsonb_build_object('templateId',p_template,'revision',template.revision,'userId',u,'personId',pid,'authority',app.automation_email_test_authority(t,u)),'context',jsonb_build_object('kind','templateTest'),
  'recipientPeople',jsonb_build_object(u::text,pid),'linkPath','/automation/templates','mail',jsonb_build_object('id','test:'||p_request::text,'to',jsonb_build_array(u),'cc','[]'::jsonb,
   'templateId',p_template,'templateRevision',template.revision,'subject','[TEST] '||p_subject,'body',v_body,'richBody',CASE WHEN template.body_doc IS NULL THEN NULL ELSE jsonb_build_object('doc',template.body_doc,'values',p_values,'sourceTemplate',jsonb_build_object('id',p_template,'revision',template.revision)) END,
   'delivery',jsonb_build_object('version',1,'sender','noreply','pdfDocumentIds','[]'::jsonb,'linkDocumentIds','[]'::jsonb,'assets','[]'::jsonb))),u)
 ON CONFLICT(tenant_id,mail_key) DO NOTHING RETURNING id INTO result;
 IF result IS NULL THEN SELECT id INTO result FROM public.automation_email_delivery WHERE tenant_id=t AND mail_key='test:'||u::text||':'||p_request::text AND subject_id=p_template AND payload->'test'->>'revision'=p_expected::text;END IF;
 IF result IS NULL THEN RAISE EXCEPTION 'This test request changed. Start a new test' USING ERRCODE='40001';END IF;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
 SELECT t,'automation-email',p_template,'automation.email-test-queued','user',u,jsonb_build_object('templateId',p_template,'revision',p_expected,'deliveryId',result)
 WHERE NOT EXISTS(SELECT 1 FROM public.domain_event WHERE tenant_id=t AND aggregate_type='automation-email' AND event_type='automation.email-test-queued' AND payload->>'deliveryId'=result::text);
 RETURN result;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.automation_email_test_queue(uuid,integer,uuid,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.automation_email_test_queue(uuid,integer,uuid,text,jsonb) TO ai_hr_app;
--> statement-breakpoint
-- Private sender capability check. No caller supplies a user/tenant identity or address at delivery time.
CREATE FUNCTION app.automation_email_test_target(p_id uuid,p_token uuid,p_origin text) RETURNS jsonb
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
 JOIN public.app_external_identity i ON i.app_user_id=u.id AND i.issuer=p_origin||'/auth/'||job.tenant_id::text AND i.revoked_at IS NULL
 WHERE u.tenant_id=job.tenant_id AND u.id=target_user AND u.person_id::text=job.payload->'test'->>'personId' AND u.person_id IS NOT NULL AND u.archived_at IS NULL AND NOT app.login_blocked(u.id);
 IF coalesce(jsonb_array_length(bindings),0)<>1 THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('id',job.id,'tenantId',job.tenant_id,'module',job.module,'subjectId',job.subject_id,'payload',job.payload,'bindings',bindings);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.automation_email_test_target(uuid,uuid,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Exact 5813 non-test implementation retained privately. CREATE OR REPLACE below preserves the public target OID,
-- including prepared callers and the existing start function, rather than renaming their cached capability target.
CREATE FUNCTION app.automation_email_target_before_template_tests(p_id uuid,p_token uuid,p_origin text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE job public.automation_email_delivery%ROWTYPE; recipients jsonb; bindings jsonb; total integer;
BEGIN
 IF p_origin IS NULL OR p_origin!~'^https://[^/@?#[:space:]]+(:[0-9]+)?$' THEN RETURN NULL;END IF;
 SELECT * INTO job FROM public.automation_email_delivery WHERE id=p_id AND lease_token=p_token AND status='leased' AND started_at IS NULL AND lease_until>clock_timestamp();
 IF NOT FOUND THEN RETURN NULL;END IF;
 IF job.module='probation' AND NOT EXISTS(SELECT 1 FROM public.probation_case c WHERE c.id=job.subject_id AND c.tenant_id=job.tenant_id) THEN RETURN NULL;END IF;
 IF job.module='contract_staff' AND app.contract_shared_delivery_eligible(job.tenant_id,job.subject_id,job.payload->'context') IS NOT TRUE THEN RETURN NULL;END IF;
 recipients:=coalesce(job.payload->'mail'->'to','[]'::jsonb)||coalesce(job.payload->'mail'->'cc','[]'::jsonb);
 SELECT count(*) INTO total FROM jsonb_array_elements_text(recipients);
 SELECT jsonb_agg(jsonb_build_object('userId',r.uid,'subject',identity.subject,'issuer',identity.issuer) ORDER BY r.ordinality) INTO bindings
 FROM jsonb_array_elements_text(recipients) WITH ORDINALITY r(uid,ordinality)
 JOIN public.app_user u ON u.id::text=r.uid AND u.tenant_id=job.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
 JOIN public.app_external_identity identity ON identity.app_user_id=u.id AND identity.issuer=p_origin||'/auth/'||job.tenant_id::text AND identity.revoked_at IS NULL AND (job.module<>'contract_staff' OR u.person_id::text=job.payload->'context'->'recipientPeople'->>u.id::text);
 bindings:=coalesce(bindings,'[]'::jsonb);
 IF total<1 OR jsonb_array_length(bindings)<>total OR (SELECT count(DISTINCT b->>'userId') FROM jsonb_array_elements(bindings) b)<>total THEN RETURN NULL;END IF;
 IF job.module='contract_staff' THEN job.payload:=jsonb_set(job.payload,'{linkPath}',to_jsonb(app.contract_shared_delivery_link(job.tenant_id,job.subject_id,(job.payload->'mail'->'to'->>0)::uuid,job.payload->'context')));END IF;
 RETURN jsonb_build_object('id',job.id,'tenantId',job.tenant_id,'module',job.module,'subjectId',job.subject_id,'payload',job.payload,'bindings',bindings);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.automation_email_target_before_template_tests(uuid,uuid,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.automation_email_target(p_id uuid,p_token uuid,p_origin text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.automation_email_delivery WHERE id=p_id AND payload->>'purpose'='templateTest') THEN RETURN app.automation_email_test_target(p_id,p_token,p_origin);END IF;
 RETURN app.automation_email_target_before_template_tests(p_id,p_token,p_origin);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.automation_email_target(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.automation_email_target(uuid,uuid,text) TO ai_hr_app;
