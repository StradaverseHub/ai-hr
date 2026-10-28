-- UNALLOCATED SOURCE DRAFT. Do not journal or apply until the migration coordinator allocates its slot.
ALTER TABLE app_invitation ADD COLUMN email_locale text NOT NULL DEFAULT 'en' CHECK(email_locale IN ('en','ms','zh','vi','ta','th'));
--> statement-breakpoint
CREATE TABLE email_design (
 tenant_id uuid NOT NULL REFERENCES tenant(id),kind text NOT NULL CHECK(length(kind) BETWEEN 1 AND 80),
 locale text NOT NULL CHECK(locale IN ('en','ms','zh','vi','ta','th')),
 revision integer NOT NULL CHECK(revision>0),document jsonb,
 updated_by uuid REFERENCES app_user(id),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,kind,locale),CHECK(document IS NULL OR (jsonb_typeof(document)='object' AND octet_length(document::text)<=100000))
);
--> statement-breakpoint
CREATE TABLE email_design_version (
 tenant_id uuid NOT NULL REFERENCES tenant(id),kind text NOT NULL,locale text NOT NULL,revision integer NOT NULL,
 document jsonb,created_by uuid REFERENCES app_user(id),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,kind,locale,revision)
);
--> statement-breakpoint
CREATE TABLE email_asset (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),
 token text NOT NULL UNIQUE DEFAULT replace(gen_random_uuid()::text||gen_random_uuid()::text,'-',''),
 sha256 text NOT NULL,mime text NOT NULL CHECK(mime IN ('image/png','image/jpeg','image/gif','image/webp')),
 bytes bytea NOT NULL CHECK(octet_length(bytes) BETWEEN 1 AND 2097152),
 uploaded_by uuid NOT NULL REFERENCES app_user(id),uploaded_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE email_design ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_design FORCE ROW LEVEL SECURITY;
ALTER TABLE email_design_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_design_version FORCE ROW LEVEL SECURITY;
ALTER TABLE email_asset ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_asset FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE FUNCTION app.email_design_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.app_user u JOIN public.role_assignment r ON r.app_user_id=u.id AND r.tenant_id=u.tenant_id
 WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
 AND r.role::text IN ('hr_admin','super_admin') AND r.company_id IS NULL); $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.email_design_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.email_design_admin() TO ai_hr_app;
--> statement-breakpoint
CREATE POLICY email_design_owner ON email_design FOR ALL USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
CREATE POLICY email_design_admin ON email_design FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.email_design_admin());
CREATE POLICY email_design_version_owner ON email_design_version FOR ALL USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
CREATE POLICY email_design_version_admin ON email_design_version FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.email_design_admin());
CREATE POLICY email_asset_owner ON email_asset FOR ALL USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
CREATE POLICY email_asset_admin ON email_asset FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.email_design_admin());
--> statement-breakpoint
REVOKE ALL ON email_design,email_design_version,email_asset FROM PUBLIC,ai_hr_app;
GRANT SELECT ON email_design,email_design_version,email_asset TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.email_design_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Email design history is immutable' USING ERRCODE='23514'; END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.email_design_history_immutable() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER email_design_history_immutable BEFORE UPDATE OR DELETE ON email_design_version FOR EACH ROW EXECUTE FUNCTION app.email_design_history_immutable();
--> statement-breakpoint
CREATE FUNCTION app.email_design_save(p_kind text,p_locale text,p_document jsonb,p_expected integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();actor uuid:=app.current_user_id();r integer;
BEGIN
 IF actor IS NULL OR NOT app.email_design_admin() THEN RAISE EXCEPTION 'Email design permission required' USING ERRCODE='42501'; END IF;
 IF p_kind IS NULL OR length(p_kind) NOT BETWEEN 1 AND 80 OR p_locale NOT IN ('en','ms','zh','vi','ta','th') OR p_expected IS NULL OR p_expected<0 OR (p_document IS NOT NULL AND (jsonb_typeof(p_document)<>'object' OR octet_length(p_document::text)>100000 OR p_document->>'kind' IS DISTINCT FROM p_kind)) THEN RAISE EXCEPTION 'Invalid email design' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('email-design:'||t::text||':'||p_kind||':'||p_locale,0));
 SELECT revision INTO r FROM public.email_design WHERE tenant_id=t AND kind=p_kind AND locale=p_locale;
 IF coalesce(r,0)<>p_expected THEN RAISE EXCEPTION 'Email design changed' USING ERRCODE='40001'; END IF;
 r:=coalesce(r,0)+1;
 INSERT INTO public.email_design(tenant_id,kind,locale,revision,document,updated_by) VALUES(t,p_kind,p_locale,r,p_document,actor)
 ON CONFLICT(tenant_id,kind,locale) DO UPDATE SET revision=excluded.revision,document=excluded.document,updated_by=actor,updated_at=now();
 INSERT INTO public.email_design_version(tenant_id,kind,locale,revision,document,created_by) VALUES(t,p_kind,p_locale,r,p_document,actor);
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
 VALUES(t,'email-design',actor,'email-design.saved','user',actor,jsonb_build_object('kind',p_kind,'locale',p_locale,'revision',r,'default',p_document IS NULL));
 RETURN r;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.email_design_save(text,text,jsonb,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.email_design_save(text,text,jsonb,integer) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.email_asset_save(p_mime text,p_bytes bytea) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE token text;
BEGIN
 IF app.current_user_id() IS NULL OR NOT app.email_design_admin() THEN RAISE EXCEPTION 'Email design permission required' USING ERRCODE='42501'; END IF;
 INSERT INTO public.email_asset(tenant_id,sha256,mime,bytes,uploaded_by) VALUES(app.current_tenant_id(),encode(sha256(p_bytes),'hex'),p_mime,p_bytes,app.current_user_id()) RETURNING email_asset.token INTO token;
 RETURN token;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.email_asset_save(text,bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.email_asset_save(text,bytea) TO ai_hr_app;
--> statement-breakpoint
-- Public recipients receive only the opaque token embedded in their email; the route never lists assets.
CREATE FUNCTION app.email_asset_read(p_token text) RETURNS TABLE(mime text,bytes bytea)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT a.mime,a.bytes FROM public.email_asset a WHERE a.token=p_token AND p_token ~ '^[a-f0-9]{64}$'; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.email_asset_read(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.email_asset_read(text) TO ai_hr_app;
--> statement-breakpoint
-- Private read owner. No direct grant: each public delivery function binds the tenant to a live lease.
CREATE FUNCTION app.email_design_delivery(p_tenant uuid,p_kind text,p_locale text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('kind',p_kind,'locale',CASE WHEN p_locale IN ('en','ms','zh','vi','ta','th') THEN p_locale ELSE 'en' END,
 'data',jsonb_build_object('company_name',(SELECT name FROM public.tenant WHERE id=p_tenant)),'document',(SELECT d.document FROM public.email_design d WHERE d.tenant_id=p_tenant AND d.kind=p_kind AND d.locale=CASE WHEN p_locale IN ('en','ms','zh','vi','ta','th') THEN p_locale ELSE 'en' END)); $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.email_design_delivery(uuid,text,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Details are resolved only after a delivery owner has admitted the exact recipient.
CREATE FUNCTION app.email_design_recipient_data(p_tenant uuid,p_user uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_strip_nulls(jsonb_build_object('first_name',coalesce(p.first_name,split_part(p.full_name,' ',1)), 'company_name',t.name))
 FROM public.tenant t LEFT JOIN public.app_user u ON u.tenant_id=t.id AND u.id=p_user
 LEFT JOIN public.person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id WHERE t.id=p_tenant; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.email_design_recipient_data(uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.email_design_notification_data(p_id uuid,p_tenant uuid,p_user uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.email_design_recipient_data(p_tenant,p_user)||coalesce((
 SELECT jsonb_build_object('count',jsonb_array_length(r.tasks)::text,'cycle',c.name,'things',CASE WHEN jsonb_array_length(r.tasks)=1 THEN 'thing is' ELSE 'things are' END)
 FROM public.notification_delivery d JOIN public.performance_assessment_reminder_recipient r ON r.source_event_id=d.source_event_id AND r.tenant_id=d.tenant_id AND r.user_id=p_user
 JOIN public.performance_assessment_reminder_run run ON run.id=r.run_id AND run.tenant_id=r.tenant_id
 JOIN public.review_cycle c ON c.id=run.cycle_id AND c.tenant_id=run.tenant_id
 WHERE d.id=p_id AND d.tenant_id=p_tenant LIMIT 1),'{}'::jsonb); $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.email_design_notification_data(uuid,uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.email_design_account(p_id uuid,p_token uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.email_design_delivery(d.tenant_id,d.kind,i.email_locale)||jsonb_build_object('data',jsonb_strip_nulls(jsonb_build_object('first_name',coalesce(p.first_name,split_part(p.full_name,' ',1)),'company_name',coalesce(c.legal_name,t.name)))) FROM public.account_email_delivery d JOIN public.app_invitation i ON i.id=d.invitation_id AND i.tenant_id=d.tenant_id JOIN public.tenant t ON t.id=d.tenant_id LEFT JOIN public.person p ON p.id=i.person_id AND p.tenant_id=i.tenant_id LEFT JOIN public.company c ON c.id=i.company_id AND c.tenant_id=i.tenant_id
 WHERE d.id=p_id AND d.status='pending' AND d.lease_token=p_token AND d.lease_until>now() AND d.kind='invitation'; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.email_design_account(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.email_design_account(uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.email_design_notification(p_id uuid,p_token uuid,p_origin text,p_kind text,p_locale text,p_cc boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid;target record;cc jsonb;u uuid;
BEGIN
 IF p_cc THEN
  cc:=app.internal_auth_attendance_cc_target(p_id,p_token,p_origin);
  IF cc IS NULL OR p_kind<>'attendance_cc' OR p_locale IS DISTINCT FROM cc->>'locale' THEN RETURN NULL; END IF;
  SELECT tenant_id INTO t FROM public.attendance_workflow_cc_delivery WHERE id=p_id;u:=(cc->>'userId')::uuid;
 ELSE
  SELECT * INTO target FROM app.internal_auth_notification_target(p_id,p_token,p_origin);
  IF NOT FOUND OR p_locale IS DISTINCT FROM target.locale OR p_kind NOT IN ('workflow.'||target.category,'assessment_reminder') THEN RETURN NULL; END IF;
  IF p_kind='assessment_reminder' AND NOT EXISTS(SELECT 1 FROM app.internal_auth_notification_summary(p_id,p_token,p_origin) x WHERE x.required) THEN RETURN NULL; END IF;
  SELECT tenant_id INTO t FROM public.app_user WHERE id=target.user_id;u:=target.user_id;
 END IF;
 IF t IS NULL THEN RETURN NULL; END IF;
 RETURN app.email_design_delivery(t,p_kind,p_locale)||jsonb_build_object('data',app.email_design_notification_data(p_id,t,u));
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.email_design_notification(uuid,uuid,text,text,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.email_design_notification(uuid,uuid,text,text,text,boolean) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.email_design_report(p_id uuid,p_token uuid,p_origin text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c jsonb;
BEGIN
 c:=app.internal_auth_report_lock_context(p_id,p_token,p_origin);
 IF c->>'status'<>'ready' THEN RETURN NULL; END IF;
 RETURN app.email_design_delivery((c#>>'{context,target,tenantId}')::uuid,'employee_master_report',c#>>'{context,target,locale}')||jsonb_build_object('data',app.email_design_recipient_data((c#>>'{context,target,tenantId}')::uuid,(c#>>'{context,target,recipientUserId}')::uuid));
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.email_design_report(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.email_design_report(uuid,uuid,text) TO ai_hr_app;
--> statement-breakpoint
-- Compatibility adapter retains the same leased-recipient authority as the embedded sender.
CREATE FUNCTION identity_email.delivery_design(p_id uuid,p_token uuid,p_issuer text,p_kind text,p_locale text,p_cc boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid;target record;cc jsonb;u uuid;
BEGIN
 IF p_cc THEN
  cc:=identity_email.attendance_cc_target(p_id,p_token,p_issuer);
  IF cc IS NULL OR p_kind<>'attendance_cc' OR p_locale IS DISTINCT FROM cc->>'locale' THEN RETURN NULL; END IF;
  SELECT tenant_id INTO t FROM public.attendance_workflow_cc_delivery WHERE id=p_id;u:=(cc->>'userId')::uuid;
 ELSE
  SELECT * INTO target FROM identity_email.delivery_target(p_id,p_token,p_issuer);
  IF NOT FOUND OR p_locale IS DISTINCT FROM target.locale OR p_kind NOT IN ('workflow.'||target.category,'assessment_reminder') THEN RETURN NULL; END IF;
  IF p_kind='assessment_reminder' AND NOT EXISTS(SELECT 1 FROM identity_email.delivery_summary(p_id,p_token,p_issuer) x WHERE x.required) THEN RETURN NULL; END IF;
  SELECT tenant_id INTO t FROM public.app_user WHERE id=target.user_id;u:=target.user_id;
 END IF;
 IF t IS NULL THEN RETURN NULL; END IF;
 RETURN app.email_design_delivery(t,p_kind,p_locale)||jsonb_build_object('data',app.email_design_notification_data(p_id,t,u));
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION identity_email.delivery_design(uuid,uuid,text,text,text,boolean) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION identity_email.report_design(p_id uuid,p_token uuid,p_issuer text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE target jsonb;
BEGIN
 target:=identity_email.report_target(p_id,p_token,p_issuer);
 IF target IS NULL THEN RETURN NULL; END IF;
 RETURN app.email_design_delivery((target->>'tenantId')::uuid,'employee_master_report',target->>'locale')||jsonb_build_object('data',app.email_design_recipient_data((target->>'tenantId')::uuid,(target->>'recipientUserId')::uuid));
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION identity_email.report_design(uuid,uuid,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Move the existing subject/opening verbatim; their setting rows remain immutable historical evidence.
-- A missing original author stays unknown rather than being attributed to another administrator.
DO $$
DECLARE source record;words jsonb;doc jsonb;l text;
BEGIN
 FOR source IN SELECT tenant_id,value,updated_by,updated_at FROM public.tenant_setting WHERE key='performance.reminder_words' LOOP
  BEGIN words:=CASE WHEN jsonb_typeof(source.value)='string' THEN (source.value#>>'{}')::jsonb ELSE source.value END;
  EXCEPTION WHEN invalid_text_representation THEN CONTINUE; END;
  IF jsonb_typeof(words)<>'object' OR jsonb_typeof(words->'subject')<>'string' OR jsonb_typeof(words->'opening')<>'string' THEN CONTINUE; END IF;
  FOREACH l IN ARRAY ARRAY['en','ms','zh','vi','ta','th'] LOOP
   doc:=jsonb_build_object('version',1,'kind','assessment_reminder','subject',words->>'subject','background','#f5f5f5','blocks',jsonb_build_array(
    jsonb_build_object('id','00000000-0000-4000-8000-000000000001','type','header','label','AIHR','style',jsonb_build_object('background','#222244','color','#ffffff','padding',24)),
    jsonb_build_object('id','00000000-0000-4000-8000-000000000003','type','text','heading','','runs',jsonb_build_array(jsonb_build_object('text',words->>'opening')),'style','{}'::jsonb),
    jsonb_build_object('id','00000000-0000-4000-8000-000000000002','type','system','style',jsonb_build_object('background','#ffffff','color','#202020'))));
   INSERT INTO public.email_design(tenant_id,kind,locale,revision,document,updated_by,updated_at) VALUES(source.tenant_id,'assessment_reminder',l,1,doc,source.updated_by,source.updated_at);
   INSERT INTO public.email_design_version(tenant_id,kind,locale,revision,document,created_by,created_at) VALUES(source.tenant_id,'assessment_reminder',l,1,doc,source.updated_by,source.updated_at);
  END LOOP;
 END LOOP;
END; $$;
--> statement-breakpoint
CREATE FUNCTION app.email_design_assessment_words() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('subject',d.document->>'subject','opening',b.value#>>'{runs,0,text}')
 FROM public.email_design d CROSS JOIN LATERAL jsonb_array_elements(d.document->'blocks') WITH ORDINALITY b(value,position)
 WHERE d.tenant_id=app.current_tenant_id() AND d.kind='assessment_reminder' AND d.locale='en'
 AND d.document IS NOT NULL AND b.value->>'type'='text'
 ORDER BY (b.value->>'id'='00000000-0000-4000-8000-000000000003') DESC,b.position LIMIT 1; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.email_design_assessment_words() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.email_design_assessment_words() TO ai_hr_app;

--> statement-breakpoint
-- Recovery's application owner has already verified its encrypted exact account binding.
-- This read grants no edit authority and cannot select another tenant or principal.
CREATE FUNCTION app.email_design_authenticated(p_kind text,p_locale text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.email_design_delivery(u.tenant_id,p_kind,p_locale)||jsonb_build_object('data',jsonb_build_object('first_name',coalesce(p.first_name,split_part(p.full_name,' ',1),''),'company_name',t.name))
 FROM public.app_user u JOIN public.tenant t ON t.id=u.tenant_id LEFT JOIN public.person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id
 WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND p_kind='recovery'; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.email_design_authenticated(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.email_design_authenticated(text,text) TO ai_hr_app;
--> statement-breakpoint
-- The legacy value is retained as history, with no customer writer competing with the design owner.
UPDATE public.setting_definition SET customer_visible=false,description='Historical assessment wording, migrated to Email templates; no longer editable.' WHERE key='performance.reminder_words';
--> statement-breakpoint
CREATE FUNCTION app.email_design_legacy_words_retired() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF (CASE WHEN TG_OP='DELETE' THEN OLD.key ELSE NEW.key END)='performance.reminder_words' AND NOT app.acting_as_owner() THEN RAISE EXCEPTION 'Use Email templates for assessment wording' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;RETURN NEW;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.email_design_legacy_words_retired() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER email_design_legacy_words_retired BEFORE INSERT OR UPDATE OR DELETE ON tenant_setting FOR EACH ROW EXECUTE FUNCTION app.email_design_legacy_words_retired();

--> statement-breakpoint
CREATE FUNCTION app.email_design_audit_owner() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF (NEW.aggregate_type='email-design' OR NEW.event_type LIKE 'email-design.%') AND NOT app.acting_as_owner() THEN RAISE EXCEPTION 'Email design audit owner required' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.email_design_audit_owner() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER email_design_audit_owner BEFORE INSERT ON domain_event FOR EACH ROW EXECUTE FUNCTION app.email_design_audit_owner();
