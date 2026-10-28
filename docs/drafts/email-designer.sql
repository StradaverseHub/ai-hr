-- UNALLOCATED SOURCE DRAFT. Do not journal or apply until the migration coordinator allocates its slot.
CREATE TABLE email_design (
 tenant_id uuid NOT NULL REFERENCES tenant(id),kind text NOT NULL CHECK(length(kind) BETWEEN 1 AND 80),
 locale text NOT NULL CHECK(locale IN ('en','ms','zh','vi','ta','th')),
 revision integer NOT NULL CHECK(revision>0),document jsonb,
 updated_by uuid NOT NULL REFERENCES app_user(id),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,kind,locale),CHECK(document IS NULL OR (jsonb_typeof(document)='object' AND octet_length(document::text)<=100000))
);
--> statement-breakpoint
CREATE TABLE email_design_version (
 tenant_id uuid NOT NULL REFERENCES tenant(id),kind text NOT NULL,locale text NOT NULL,revision integer NOT NULL,
 document jsonb,created_by uuid NOT NULL REFERENCES app_user(id),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,kind,locale,revision)
);
--> statement-breakpoint
CREATE TABLE email_asset (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),
 token text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(32),'hex'),
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
CREATE POLICY email_design_owner ON email_design FOR ALL USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
CREATE POLICY email_design_admin ON email_design FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.is_group_admin());
CREATE POLICY email_design_version_owner ON email_design_version FOR ALL USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
CREATE POLICY email_design_version_admin ON email_design_version FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.is_group_admin());
CREATE POLICY email_asset_owner ON email_asset FOR ALL USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
CREATE POLICY email_asset_admin ON email_asset FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.is_group_admin());
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
 IF actor IS NULL OR NOT app.is_group_admin() THEN RAISE EXCEPTION 'Email design permission required' USING ERRCODE='42501'; END IF;
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
 IF app.current_user_id() IS NULL OR NOT app.is_group_admin() THEN RAISE EXCEPTION 'Email design permission required' USING ERRCODE='42501'; END IF;
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
 'document',(SELECT d.document FROM public.email_design d WHERE d.tenant_id=p_tenant AND d.kind=p_kind AND d.locale=CASE WHEN p_locale IN ('en','ms','zh','vi','ta','th') THEN p_locale ELSE 'en' END)); $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.email_design_delivery(uuid,text,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.email_design_account(p_id uuid,p_token uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.email_design_delivery(d.tenant_id,d.kind,'en') FROM public.account_email_delivery d
 WHERE d.id=p_id AND d.status='pending' AND d.lease_token=p_token AND d.lease_until>now() AND d.kind IN ('invitation','recovery'); $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.email_design_account(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.email_design_account(uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.email_design_notification(p_id uuid,p_token uuid,p_origin text,p_kind text,p_locale text,p_cc boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid;target record;cc jsonb;
BEGIN
 IF p_cc THEN
  cc:=app.internal_auth_attendance_cc_target(p_id,p_token,p_origin);
  IF cc IS NULL OR p_kind<>'attendance_cc' OR p_locale IS DISTINCT FROM cc->>'locale' THEN RETURN NULL; END IF;
  SELECT tenant_id INTO t FROM public.attendance_workflow_cc_delivery WHERE id=p_id;
 ELSE
  SELECT * INTO target FROM app.internal_auth_notification_target(p_id,p_token,p_origin);
  IF NOT FOUND OR p_locale IS DISTINCT FROM target.locale OR p_kind NOT IN ('workflow.'||target.category,'assessment_reminder') THEN RETURN NULL; END IF;
  IF p_kind='assessment_reminder' AND NOT EXISTS(SELECT 1 FROM app.internal_auth_notification_summary(p_id,p_token,p_origin) x WHERE x.required) THEN RETURN NULL; END IF;
  SELECT tenant_id INTO t FROM public.app_user WHERE id=target.user_id;
 END IF;
 IF t IS NULL THEN RETURN NULL; END IF;
 RETURN app.email_design_delivery(t,p_kind,p_locale);
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
 RETURN app.email_design_delivery((c#>>'{context,target,tenantId}')::uuid,'employee_master_report',c#>>'{context,target,locale}');
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.email_design_report(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.email_design_report(uuid,uuid,text) TO ai_hr_app;
