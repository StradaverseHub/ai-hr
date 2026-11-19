-- Approved board 12f314cc: retain canonical identity, revision and history; rich content is additive.
ALTER TABLE public.automation_email_template_version ADD COLUMN definition jsonb
 CHECK (definition IS NULL OR (jsonb_typeof(definition)='object' AND pg_column_size(definition)<=300000));
--> statement-breakpoint
CREATE TABLE public.automation_email_asset (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id),
 template_id uuid NOT NULL, module text NOT NULL CHECK(module='probation'), kind text NOT NULL CHECK(kind IN ('image','file')),
 filename text NOT NULL CHECK(length(filename) BETWEEN 1 AND 180), mime_type text NOT NULL CHECK(mime_type IN ('application/pdf','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','image/png','image/jpeg','image/gif','image/webp','text/plain','text/csv')),
 content bytea NOT NULL CHECK(octet_length(content) BETWEEN 1 AND 10485760),
 content_hash text GENERATED ALWAYS AS (encode(sha256(content),'hex')) STORED,
 uploaded_by uuid NOT NULL REFERENCES app_user(id), uploaded_by_name text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(kind<>'image' OR octet_length(content)<=1048576 AND mime_type IN ('image/png','image/jpeg','image/gif','image/webp'))
);
--> statement-breakpoint
CREATE INDEX automation_email_asset_template ON public.automation_email_asset(tenant_id,template_id);
--> statement-breakpoint
ALTER TABLE public.automation_email_asset ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.automation_email_asset FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY automation_email_asset_owner ON public.automation_email_asset FOR ALL TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
--> statement-breakpoint
CREATE POLICY automation_email_asset_read ON public.automation_email_asset FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND app.automation_can_configure(module));
--> statement-breakpoint
CREATE POLICY automation_email_asset_insert ON public.automation_email_asset FOR INSERT TO ai_hr_app WITH CHECK(tenant_id=app.current_tenant_id() AND uploaded_by=app.current_user_id() AND app.automation_can_configure(module) AND EXISTS(SELECT 1 FROM automation_email_template_version v WHERE v.tenant_id=automation_email_asset.tenant_id AND v.template_id=automation_email_asset.template_id AND v.module=automation_email_asset.module));
--> statement-breakpoint
REVOKE ALL ON public.automation_email_asset FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
GRANT SELECT,INSERT ON public.automation_email_asset TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.automation_email_asset_integrity() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF (NEW.filename~'[[:cntrl:]/]' OR strpos(NEW.filename,chr(92))>0) OR NOT EXISTS(SELECT 1 FROM app_user u LEFT JOIN person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id WHERE u.id=NEW.uploaded_by AND u.tenant_id=NEW.tenant_id AND coalesce(p.full_name,'User')=NEW.uploaded_by_name AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) THEN RAISE EXCEPTION 'Email asset requires the actual uploader' USING ERRCODE='22023';END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.automation_email_asset_integrity() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER automation_email_asset_integrity BEFORE INSERT ON automation_email_asset FOR EACH ROW EXECUTE FUNCTION app.automation_email_asset_integrity();
--> statement-breakpoint
-- Wrap the unchanged canonical writer. Only the new revision created in this transaction receives rich metadata.
CREATE FUNCTION app.automation_rich_email_template_save(p_template uuid,p_module text,p_name text,p_active boolean,p_subject text,p_body text,p_cc jsonb,p_retired boolean,p_expected integer,p_reason text,p_definition jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE rev integer; asset jsonb; stored automation_email_asset;prior_definition jsonb;
BEGIN
 IF app.current_tenant_id() IS NULL OR app.current_user_id() IS NULL OR app.automation_can_configure(p_module) IS NOT TRUE THEN RAISE EXCEPTION 'Email templates unavailable' USING ERRCODE='42501';END IF;
 PERFORM app.access_workforce_write_lock();
 PERFORM pg_advisory_xact_lock(hashtextextended('automation-email-template:'||app.current_tenant_id()::text||':'||p_template::text,0));
 SELECT v.definition INTO prior_definition FROM automation_email_template_version v WHERE v.tenant_id=app.current_tenant_id() AND v.template_id=p_template ORDER BY v.revision DESC LIMIT 1;
 IF prior_definition IS NOT NULL AND p_definition IS NULL THEN
  IF p_retired THEN p_definition:=prior_definition;ELSE RAISE EXCEPTION 'Open this email in the rich template builder before saving' USING ERRCODE='22023';END IF;
 END IF;
 IF p_definition IS NOT NULL THEN
  IF p_module<>'probation' OR jsonb_typeof(p_definition) IS DISTINCT FROM 'object' OR pg_column_size(p_definition)>300000 OR p_definition->>'version'<>'1'
    OR jsonb_typeof(p_definition->'bodyDoc') IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_definition->'files') IS DISTINCT FROM 'array' OR jsonb_typeof(p_definition->'images') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_definition->'links') IS DISTINCT FROM 'array' OR jsonb_typeof(p_definition->'attachments') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_definition->'slots') IS DISTINCT FROM 'array'
  THEN RAISE EXCEPTION 'Invalid rich email definition' USING ERRCODE='22023'; END IF;
  IF jsonb_array_length(p_definition->'files')>20 OR jsonb_array_length(p_definition->'images')>3 OR jsonb_array_length(p_definition->'slots')>50 THEN RAISE EXCEPTION 'Too many email assets' USING ERRCODE='22023';END IF;
  FOR asset IN SELECT a FROM jsonb_array_elements((p_definition->'files')||(p_definition->'images')) a LOOP
   SELECT * INTO stored FROM automation_email_asset a WHERE a.id::text=asset->>'id' AND a.tenant_id=app.current_tenant_id() AND a.template_id=p_template AND a.module=p_module;
   IF NOT FOUND OR stored.kind IS DISTINCT FROM asset->>'kind' OR stored.filename IS DISTINCT FROM asset->>'name' OR stored.mime_type IS DISTINCT FROM asset->>'mimeType' OR stored.content_hash IS DISTINCT FROM asset->>'contentHash' OR octet_length(stored.content)::text IS DISTINCT FROM asset->>'size'
   THEN RAISE EXCEPTION 'An email asset receipt is unavailable' USING ERRCODE='22023'; END IF;
  END LOOP;
 END IF;
 rev:=app.automation_email_template_save(p_template,p_module,p_name,p_active,p_subject,p_body,p_cc,p_retired,p_expected,p_reason);
 UPDATE automation_email_template_version SET definition=p_definition WHERE tenant_id=app.current_tenant_id() AND template_id=p_template AND revision=rev;
 RETURN rev;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.automation_rich_email_template_save(uuid,text,text,boolean,text,text,jsonb,boolean,integer,text,jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.automation_rich_email_template_save(uuid,text,text,boolean,text,text,jsonb,boolean,integer,text,jsonb) TO ai_hr_app;

-- Preserve the canonical shared writer's existing ACL. The deferred native guard below
-- protects protocol custody across every writer, including direct legacy RPC calls.

--> statement-breakpoint
-- Both builders share revision identity, not content formats. Check the final stored revision:
-- the rich wrapper first uses the unchanged canonical INSERT and then adds its definition.
-- A deferred native trigger also covers direct calls to every older canonical writer.
CREATE FUNCTION app.automation_email_template_protocol_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE stored public.automation_email_template_version;previous public.automation_email_template_version;
BEGIN
 SELECT * INTO stored FROM public.automation_email_template_version v WHERE v.tenant_id=NEW.tenant_id AND v.template_id=NEW.template_id AND v.revision=NEW.revision;
 SELECT * INTO previous FROM public.automation_email_template_version v WHERE v.tenant_id=NEW.tenant_id AND v.template_id=NEW.template_id AND v.revision<NEW.revision ORDER BY v.revision DESC LIMIT 1;
 IF previous.definition IS NOT NULL AND stored.definition IS NULL THEN
   RAISE EXCEPTION 'Open this email in its rich template builder before saving' USING ERRCODE='22023';
 END IF;
 IF stored.definition IS NOT NULL AND (previous.body_doc IS NOT NULL
   OR jsonb_array_length(coalesce(previous.assets,'[]'::jsonb))>0
   OR jsonb_array_length(coalesce(previous.file_slots,'[]'::jsonb))>0
   OR jsonb_array_length(coalesce(previous.document_ids,'[]'::jsonb))>0) THEN
   RAISE EXCEPTION 'Keep this shared email in its current template builder' USING ERRCODE='22023';
 END IF;
 IF stored.definition IS NOT NULL AND (stored.body_doc IS NOT NULL
   OR jsonb_array_length(coalesce(stored.assets,'[]'::jsonb))>0
   OR jsonb_array_length(coalesce(stored.file_slots,'[]'::jsonb))>0
   OR jsonb_array_length(coalesce(stored.document_ids,'[]'::jsonb))>0) THEN
   RAISE EXCEPTION 'An email revision cannot combine content protocols' USING ERRCODE='22023';
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.automation_email_template_protocol_guard() FROM PUBLIC,ai_hr_app;
CREATE CONSTRAINT TRIGGER automation_email_template_protocol_guard AFTER INSERT OR UPDATE ON public.automation_email_template_version
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.automation_email_template_protocol_guard();
