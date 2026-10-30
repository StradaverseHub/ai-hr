-- UNALLOCATED V9 companion draft. Immutable shared email files/images; metadata stays in definitions.
CREATE TABLE lc_v9_email_asset (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id),
 email_template_id text NOT NULL, kind text NOT NULL CHECK(kind IN ('file','image')),
 filename text NOT NULL, mime_type text NOT NULL CHECK(mime_type IN ('application/pdf','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','image/png','image/jpeg','image/gif','image/webp','text/plain','text/csv')), content bytea NOT NULL,
 content_hash text GENERATED ALWAYS AS (encode(sha256(content),'hex')) STORED,
 uploaded_by uuid NOT NULL REFERENCES app_user(id), uploaded_by_name text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(octet_length(content)>0 AND octet_length(content)<=CASE WHEN kind='image' THEN 1048576 ELSE 10485760 END),
 CHECK(kind<>'image' OR mime_type IN ('image/png','image/jpeg','image/gif','image/webp'))
);
CREATE INDEX lc_v9_email_asset_parent ON lc_v9_email_asset(tenant_id,email_template_id,kind,content_hash);
ALTER TABLE lc_v9_email_asset ENABLE ROW LEVEL SECURITY;
CREATE POLICY lc_v9_email_asset_read ON lc_v9_email_asset FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.current_user_id() IS NOT NULL AND (app.is_admin() OR app.is_group_admin()));
CREATE POLICY lc_v9_email_asset_insert ON lc_v9_email_asset FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.is_group_admin() AND uploaded_by=app.current_user_id());
GRANT SELECT,INSERT ON lc_v9_email_asset TO ai_hr_app;
REVOKE UPDATE,DELETE ON lc_v9_email_asset FROM ai_hr_app;
CREATE FUNCTION app.lc_v9_email_asset_integrity() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM app_user u LEFT JOIN person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id
  WHERE u.id=NEW.uploaded_by AND u.tenant_id=NEW.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
   AND coalesce(p.full_name,'User')=NEW.uploaded_by_name) OR
  NOT EXISTS(SELECT 1 FROM lc_v9_config c CROSS JOIN LATERAL jsonb_array_elements(c.data->'emails') e
   WHERE c.tenant_id=NEW.tenant_id AND e->>'id'=NEW.email_template_id)
 THEN RAISE EXCEPTION 'Email asset must belong to its actual template and uploader'; END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.lc_v9_email_asset_integrity() FROM PUBLIC;
CREATE TRIGGER lc_v9_email_asset_integrity BEFORE INSERT ON lc_v9_email_asset FOR EACH ROW EXECUTE FUNCTION app.lc_v9_email_asset_integrity();

CREATE FUNCTION app.lc_v9_email_assets(p_id uuid,p_token uuid,p_origin text)
RETURNS TABLE(id uuid,kind text,filename text,mime_type text,bytes text,content_hash text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE target jsonb;
BEGIN
 target:=app.lc_v9_email_target(p_id,p_token,p_origin);
 IF target IS NULL THEN RETURN; END IF;
 RETURN QUERY SELECT f.id,f.kind,f.filename,f.mime_type,encode(f.content,'base64'),f.content_hash
  FROM jsonb_array_elements(coalesce(target->'payload'->'mail'->'delivery'->'assets','[]'::jsonb)) frozen
  JOIN lc_v9_email_asset f ON f.id::text=frozen->>'id' AND f.tenant_id=(target->>'tenantId')::uuid
   AND f.email_template_id=target->'payload'->'mail'->>'templateId' AND f.kind=frozen->>'kind'
   AND f.filename=frozen->>'name' AND f.mime_type=frozen->>'mimeType' AND f.content_hash=frozen->>'contentHash';
END;
$$;
REVOKE ALL ON FUNCTION app.lc_v9_email_assets(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lc_v9_email_assets(uuid,uuid,text) TO ai_hr_app;
