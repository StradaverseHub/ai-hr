-- A derived verifier key cannot decrypt credentials. Runtime SQL cannot mint account admission.
CREATE TABLE app.organisation_admission_verifier(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),secret bytea NOT NULL CHECK(octet_length(secret)=32));
CREATE TABLE app.organisation_admission_proof(tenant_id uuid NOT NULL,user_id uuid NOT NULL,payload jsonb NOT NULL,PRIMARY KEY(tenant_id,user_id),FOREIGN KEY(user_id,tenant_id) REFERENCES public.app_user(id,tenant_id) ON DELETE CASCADE);
ALTER TABLE app.organisation_admission_verifier ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.organisation_admission_verifier FORCE ROW LEVEL SECURITY;
ALTER TABLE app.organisation_admission_proof ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.organisation_admission_proof FORCE ROW LEVEL SECURITY;
CREATE POLICY organisation_admission_owner ON app.organisation_admission_verifier FOR ALL USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
CREATE POLICY organisation_admission_owner ON app.organisation_admission_proof FOR ALL USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
REVOKE ALL ON app.organisation_admission_verifier,app.organisation_admission_proof FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE TABLE app.organisation_native_identity_history(tenant_id uuid NOT NULL,user_id uuid NOT NULL,PRIMARY KEY(tenant_id,user_id),FOREIGN KEY(user_id,tenant_id) REFERENCES public.app_user(id,tenant_id) ON DELETE CASCADE);
ALTER TABLE app.organisation_native_identity_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.organisation_native_identity_history FORCE ROW LEVEL SECURITY;
CREATE POLICY organisation_admission_owner ON app.organisation_native_identity_history FOR ALL USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
REVOKE ALL ON app.organisation_native_identity_history FROM PUBLIC,ai_hr_app;
INSERT INTO app.organisation_native_identity_history SELECT DISTINCT u.tenant_id,u.id FROM public.app_user u JOIN public.app_external_identity i ON i.app_user_id=u.id WHERE i.issuer~'/auth/[^/]+$';
CREATE FUNCTION app.organisation_remember_native_identity() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP<>'INSERT' AND OLD.issuer~'/auth/[^/]+$' THEN INSERT INTO app.organisation_native_identity_history SELECT u.tenant_id,u.id FROM app_user u WHERE u.id=OLD.app_user_id ON CONFLICT DO NOTHING;END IF;
 IF TG_OP<>'DELETE' AND NEW.issuer~'/auth/[^/]+$' THEN INSERT INTO app.organisation_native_identity_history SELECT u.tenant_id,u.id FROM app_user u WHERE u.id=NEW.app_user_id ON CONFLICT DO NOTHING;END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END $$;
REVOKE ALL ON FUNCTION app.organisation_remember_native_identity() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER organisation_remember_native_identity AFTER INSERT OR UPDATE OR DELETE ON public.app_external_identity FOR EACH ROW EXECUTE FUNCTION app.organisation_remember_native_identity();
--> statement-breakpoint
-- Signature is over exact UTF8 payload bytes; jsonb is parsed only AFTER signature validation.
CREATE FUNCTION app.organisation_admission_submit(p_payload text,p_signature text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE k bytea;c jsonb;expected bytea;received bytea;difference integer:=0;j integer;n numeric:=extract(epoch FROM clock_timestamp())*1000;BEGIN
 IF p_payload IS NULL OR octet_length(p_payload)>4096 OR p_signature IS NULL OR p_signature!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Invalid organisation admission';END IF;
 SELECT secret INTO k FROM app.organisation_admission_verifier WHERE singleton;
 IF k IS NULL THEN RAISE EXCEPTION 'Invalid organisation admission';END IF;
 expected:=app._ai_spend_hmac_sha256(convert_to(p_payload,'UTF8'),k);received:=decode(p_signature,'hex');
 FOR j IN 0..31 LOOP difference:=difference | (get_byte(expected,j) # get_byte(received,j));END LOOP;
 IF difference<>0 THEN RAISE EXCEPTION 'Invalid organisation admission';END IF;
 c:=p_payload::jsonb;
 IF jsonb_typeof(c)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(c))<>13 OR NOT(c ?& ARRAY['v','purpose','tenantId','userId','personId','issuer','subject','bindingCreatedAt','credentialDigest','available','activeUntil','issuedAt','expiresAt'])
 OR EXISTS(SELECT 1 FROM jsonb_each(c) e WHERE e.key IN('purpose','tenantId','userId','issuer','subject','bindingCreatedAt','credentialDigest') AND jsonb_typeof(e.value)<>'string')
 OR jsonb_typeof(c->'personId') NOT IN('string','null')
 OR c->'v'<>'1'::jsonb OR c->>'purpose'<>'aihr-company-organisation-admission-v1'
 OR jsonb_typeof(c->'available')<>'boolean' OR jsonb_typeof(c->'issuedAt')<>'number' OR jsonb_typeof(c->'expiresAt')<>'number'
 OR (c->>'issuedAt')!~'^[0-9]{1,16}$' OR (c->>'expiresAt')!~'^[0-9]{1,16}$'
 OR (c->>'expiresAt')::numeric>9007199254740991 OR (c->>'issuedAt')::numeric>n OR (c->>'expiresAt')::numeric<=n OR (c->>'expiresAt')::numeric-(c->>'issuedAt')::numeric NOT BETWEEN 1 AND 60000
 OR (c->>'credentialDigest')!~'^[a-f0-9]{64}$' OR length(c->>'issuer')>500
 OR (c->>'bindingCreatedAt')!~'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$'
 OR (c->>'issuer') NOT LIKE ('%/auth/'||(c->>'tenantId'))
 OR NOT(jsonb_typeof(c->'activeUntil')='null' OR (jsonb_typeof(c->'activeUntil')='string' AND (c->>'activeUntil')~'^\d{4}-\d{2}-\d{2}$')) THEN RAISE EXCEPTION 'Invalid organisation admission';END IF;
 -- Casts and canonical UUID comparison also reject malformed identities, without exposing material.
 IF NOT EXISTS(SELECT 1 FROM app_user u JOIN app_external_identity i ON i.app_user_id=u.id WHERE u.id=(c->>'userId')::uuid AND u.tenant_id=(c->>'tenantId')::uuid AND u.person_id IS NOT DISTINCT FROM (c->>'personId')::uuid AND i.issuer=c->>'issuer' AND i.subject=(c->>'subject')::uuid::text AND i.revoked_at IS NULL AND to_char(i.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')=c->>'bindingCreatedAt') THEN RAISE EXCEPTION 'Invalid organisation admission';END IF;
 INSERT INTO app.organisation_admission_proof(tenant_id,user_id,payload) VALUES((c->>'tenantId')::uuid,(c->>'userId')::uuid,c)
 ON CONFLICT(tenant_id,user_id) DO UPDATE SET payload=excluded.payload WHERE (organisation_admission_proof.payload->>'issuedAt')::numeric<=(excluded.payload->>'issuedAt')::numeric;
END $$;
REVOKE ALL ON FUNCTION app.organisation_admission_submit(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.organisation_admission_submit(text,text) TO ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.organisation_actor_account_available(p_actor uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE u app_user;i app_external_identity;c jsonb;r app_internal_auth_record;BEGIN
 -- Parent UPDATE lock conflicts with identity FK KEY SHARE, closing concurrent new/rebound bindings.
 -- Lock order stays user -> verifier -> identity -> credential throughout native admission.
 SELECT * INTO u FROM app_user WHERE id=p_actor AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF u.id IS NULL OR u.archived_at IS NOT NULL OR app.login_blocked(u.id) THEN RETURN false;END IF;
 -- A revoked/missing native binding never falls back to compatibility admission.
 IF NOT EXISTS(SELECT 1 FROM app.organisation_native_identity_history h WHERE h.tenant_id=u.tenant_id AND h.user_id=u.id) THEN RETURN true;END IF;
 PERFORM 1 FROM app.organisation_admission_verifier WHERE singleton FOR SHARE;
 IF NOT FOUND THEN RETURN false;END IF;
 IF (SELECT count(*) FROM app_external_identity x WHERE x.app_user_id=u.id AND x.issuer~'/auth/[^/]+$' AND x.revoked_at IS NULL)<>1 THEN RETURN false;END IF;
 SELECT * INTO i FROM app_external_identity x WHERE x.app_user_id=u.id AND x.issuer~'/auth/[^/]+$' AND x.revoked_at IS NULL FOR SHARE;
 SELECT payload INTO c FROM app.organisation_admission_proof WHERE tenant_id=u.tenant_id AND user_id=u.id;
 IF c IS NULL OR c->'available'<>'true'::jsonb OR (c->>'expiresAt')::numeric<=extract(epoch FROM now())*1000 OR (c->>'issuedAt')::numeric>extract(epoch FROM now())*1000
 OR c->>'issuer'<>i.issuer OR c->>'subject'<>i.subject OR c->>'tenantId'<>u.tenant_id::text OR c->>'userId'<>u.id::text OR (c->>'personId')::uuid IS DISTINCT FROM u.person_id
 OR c->>'bindingCreatedAt'<>to_char(i.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
 OR (c->>'activeUntil' IS NOT NULL AND (c->>'activeUntil')::date<(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) THEN RETURN false;END IF;
 SELECT * INTO r FROM app_internal_auth_record WHERE record_key='credential:'||i.subject AND (expires_at IS NULL OR expires_at>now()) FOR SHARE;
 RETURN r.record_key IS NOT NULL AND encode(sha256(convert_to(r.sealed,'UTF8')),'hex')=c->>'credentialDigest';
END $$;
REVOKE ALL ON FUNCTION app.organisation_actor_account_available(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Self lookup breaks the admission/RLS cycle. Foreign lookup requires this exact accessible run.
CREATE FUNCTION app.organisation_admission_identity(p_actor uuid,p_run uuid DEFAULT NULL) RETURNS TABLE(binding jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT app.principal_snapshot_current() OR p_actor IS NULL THEN RAISE EXCEPTION 'Organisation account is unavailable' USING ERRCODE='42501';END IF;
 IF p_actor<>app.current_user_id() AND (p_run IS NULL OR NOT app.company_org_run_access(p_run) OR NOT EXISTS(SELECT 1 FROM company_organisation_run r WHERE r.id=p_run AND r.tenant_id=app.current_tenant_id() AND p_actor IN(r.requested_by,r.checked_by))) THEN RAISE EXCEPTION 'Organisation account is unavailable' USING ERRCODE='42501';END IF;
 RETURN QUERY SELECT jsonb_build_object('tenantId',u.tenant_id,'userId',u.id,'personId',u.person_id,'issuer',i.issuer,'subject',i.subject,'bindingCreatedAt',to_char(i.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) FROM app_user u JOIN app_external_identity i ON i.app_user_id=u.id WHERE u.tenant_id=app.current_tenant_id() AND u.id=p_actor AND i.revoked_at IS NULL AND i.issuer~'/auth/[^/]+$';
END $$;
CREATE FUNCTION app.organisation_admission_run_actors(p_run uuid) RETURNS TABLE(actor uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT app.company_org_run_access(p_run) THEN RAISE EXCEPTION 'Organisation run is unavailable' USING ERRCODE='42501';END IF;
 RETURN QUERY SELECT DISTINCT a.id FROM company_organisation_run r CROSS JOIN LATERAL(VALUES(r.requested_by),(r.checked_by)) a(id) WHERE r.id=p_run AND r.tenant_id=app.current_tenant_id() AND a.id IS NOT NULL;
END $$;
REVOKE ALL ON FUNCTION app.organisation_admission_identity(uuid,uuid),app.organisation_admission_run_actors(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.organisation_admission_identity(uuid,uuid),app.organisation_admission_run_actors(uuid) TO ai_hr_app;
