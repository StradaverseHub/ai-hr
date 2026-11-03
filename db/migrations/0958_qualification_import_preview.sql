-- The deployment owner provisions a distinct random 32-byte secret in this singleton
-- and the corresponding QUALIFICATION_IMPORT_REVIEW_KEY in the application environment.
CREATE TABLE app.qualification_import_review_key (
 singleton boolean PRIMARY KEY CHECK(singleton),
 secret bytea NOT NULL CHECK(octet_length(secret)=32)
);
CREATE TABLE app.qualification_import_preview (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL,
 actor_id uuid NOT NULL,
 expires_at timestamptz NOT NULL,
 packet jsonb
);
CREATE INDEX qualification_import_preview_expiry ON app.qualification_import_preview(expires_at);
CREATE INDEX qualification_import_preview_actor_expiry
 ON app.qualification_import_preview(tenant_id,actor_id,expires_at);
REVOKE ALL ON app.qualification_import_review_key,app.qualification_import_preview FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.stage_qualification_import_preview(p_payload text,p_mac text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE k bytea;expected bytea;received bytea;difference integer:=0;i integer;payload jsonb;result uuid;deadline timestamptz;
 tid uuid:=app.current_tenant_id();uid uuid:=app.current_user_id();
BEGIN
 IF tid IS NULL OR uid IS NULL OR app.principal_snapshot_current() IS NOT TRUE
  OR p_payload IS NULL OR octet_length(p_payload)>1900000
  OR p_mac IS NULL OR p_mac !~ '^[0-9a-f]{64}$' THEN
  RAISE EXCEPTION 'Qualification import review unavailable' USING ERRCODE='42501';
 END IF;
 SELECT secret INTO k FROM app.qualification_import_review_key WHERE singleton;
 IF k IS NULL THEN RAISE EXCEPTION 'Qualification import review unavailable' USING ERRCODE='42501';END IF;
 expected:=app._ai_spend_hmac_sha256(convert_to('aihr.qualification-import.v1'||chr(10)||p_payload,'UTF8'),k);
 received:=decode(p_mac,'hex');
 FOR i IN 0..31 LOOP difference:=difference | (get_byte(expected,i) # get_byte(received,i));END LOOP;
 IF difference<>0 THEN RAISE EXCEPTION 'Qualification import review unavailable' USING ERRCODE='42501';END IF;
 payload:=p_payload::jsonb;
 IF payload->>'tenantId' IS DISTINCT FROM tid::text OR payload->>'userId' IS DISTINCT FROM uid::text
  OR coalesce(payload->>'sourceHash','') !~ '^[0-9a-f]{64}$'
  OR coalesce(payload->>'snapshot','') !~ '^[0-9a-f]{64}$'
  OR jsonb_typeof(payload->'records') IS DISTINCT FROM 'array'
  OR app.data_permission_read_stamp() IS NULL OR payload->>'accessStamp' IS DISTINCT FROM app.data_permission_read_stamp() THEN
  RAISE EXCEPTION 'Qualification import review unavailable' USING ERRCODE='42501';
 END IF;
 deadline:=to_timestamp((payload->>'expiresAt')::double precision/1000);
 IF deadline IS NULL OR deadline<=clock_timestamp() OR deadline>clock_timestamp()+interval '15 minutes'
  OR jsonb_array_length(payload->'records') NOT BETWEEN 1 AND 500 THEN
  RAISE EXCEPTION 'Qualification import review unavailable' USING ERRCODE='42501';
 END IF;
 DELETE FROM app.qualification_import_preview WHERE expires_at<=clock_timestamp();
 IF (SELECT count(*) FROM app.qualification_import_preview WHERE tenant_id=tid AND actor_id=uid AND packet IS NOT NULL)>=16 THEN
  RAISE EXCEPTION 'Too many active Qualification import previews' USING ERRCODE='42501';
 END IF;
 INSERT INTO app.qualification_import_preview(id,tenant_id,actor_id,expires_at,packet)
 VALUES((payload->>'nonce')::uuid,tid,uid,deadline,payload) RETURNING id INTO result;
 RETURN result;
END;
$$;
--> statement-breakpoint
-- The caller consumes and applies in the same transaction. Failure restores the packet.
CREATE FUNCTION app.take_qualification_import_preview(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF app.principal_snapshot_current() IS NOT TRUE THEN RETURN NULL;END IF;
 SELECT packet INTO result FROM app.qualification_import_preview
 WHERE id=p_id AND tenant_id=app.current_tenant_id() AND actor_id=app.current_user_id()
  AND expires_at>clock_timestamp() AND packet->>'accessStamp'=app.data_permission_read_stamp()
 FOR UPDATE;
 IF result IS NOT NULL THEN
  UPDATE app.qualification_import_preview SET packet=NULL WHERE id=p_id;
 END IF;
 RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION app.stage_qualification_import_preview(text,text),app.take_qualification_import_preview(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.stage_qualification_import_preview(text,text),app.take_qualification_import_preview(uuid) TO ai_hr_app;
