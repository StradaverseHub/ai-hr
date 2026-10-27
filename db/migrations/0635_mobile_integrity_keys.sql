CREATE FUNCTION app.mobile_integrity_actor() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id()
 AND u.person_id IS NOT NULL AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))
$$;
REVOKE ALL ON FUNCTION app.mobile_integrity_actor() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.mobile_integrity_actor() TO ai_hr_app;
--> statement-breakpoint
CREATE TABLE mobile_integrity_key (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),actor_id uuid NOT NULL REFERENCES app_user(id),
 app_installation_id uuid NOT NULL,installation_id uuid NOT NULL REFERENCES mobile_integrity_installation(installation_id),
 origin_challenge_id uuid NOT NULL REFERENCES mobile_integrity_challenge(id),enrolled_for_employment_id uuid NOT NULL REFERENCES employment(id),
 platform text NOT NULL CHECK(platform='ios'),app_id text NOT NULL CHECK(length(app_id) BETWEEN 12 AND 300),
 environment text NOT NULL CHECK(environment IN ('production','development')),vendor_key_id text NOT NULL CHECK(length(vendor_key_id)=44),
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),public_key_spki bytea NOT NULL CHECK(octet_length(public_key_spki) BETWEEN 64 AND 256),
 proof_digest text NOT NULL CHECK(proof_digest ~ '^[a-f0-9]{64}$'),proof_kind text NOT NULL CHECK(proof_kind IN ('apple_key_proof','apple_app_metadata')),
 metadata jsonb,receipt_ciphertext text NOT NULL CHECK(length(receipt_ciphertext) BETWEEN 1 AND 65536),
 assertion_counter bigint NOT NULL DEFAULT 0 CHECK(assertion_counter BETWEEN 0 AND 4294967295),
 created_at timestamptz NOT NULL DEFAULT now(),revoked_at timestamptz CHECK(revoked_at IS NULL OR revoked_at>=created_at),
 CHECK(proof_kind<>'apple_app_metadata' OR metadata IS NOT NULL)
);
CREATE UNIQUE INDEX mobile_integrity_key_fingerprint_uq ON mobile_integrity_key(fingerprint);
CREATE UNIQUE INDEX mobile_integrity_key_origin_uq ON mobile_integrity_key(origin_challenge_id);
CREATE UNIQUE INDEX mobile_integrity_key_active_install_uq ON mobile_integrity_key(tenant_id,actor_id,app_installation_id,platform) WHERE revoked_at IS NULL;
ALTER TABLE mobile_integrity_key ENABLE ROW LEVEL SECURITY;
ALTER TABLE mobile_integrity_key FORCE ROW LEVEL SECURITY;
REVOKE ALL ON mobile_integrity_key FROM PUBLIC,ai_hr_app;
GRANT SELECT,INSERT ON mobile_integrity_key TO ai_hr_app;
GRANT UPDATE(assertion_counter,revoked_at) ON mobile_integrity_key TO ai_hr_app;
CREATE POLICY mobile_integrity_key_own_read ON mobile_integrity_key FOR SELECT USING
 (tenant_id=app.current_tenant_id() AND actor_id=app.current_user_id() AND app.mobile_integrity_actor());
CREATE POLICY mobile_integrity_key_own_insert ON mobile_integrity_key FOR INSERT WITH CHECK
 (tenant_id=app.current_tenant_id() AND actor_id=app.current_user_id() AND app.mobile_integrity_actor()
 AND EXISTS(SELECT 1 FROM mobile_integrity_challenge c WHERE c.id=origin_challenge_id AND c.tenant_id=mobile_integrity_key.tenant_id
  AND c.actor_id=mobile_integrity_key.actor_id AND c.employment_id=enrolled_for_employment_id AND c.installation_id=mobile_integrity_key.installation_id
  AND c.app_installation_id=mobile_integrity_key.app_installation_id AND c.purpose='device.enrollment' AND c.consumed_at IS NOT NULL));
CREATE POLICY mobile_integrity_key_own_update ON mobile_integrity_key FOR UPDATE
 USING(tenant_id=app.current_tenant_id() AND actor_id=app.current_user_id() AND app.mobile_integrity_actor())
 WITH CHECK(tenant_id=app.current_tenant_id() AND actor_id=app.current_user_id() AND app.mobile_integrity_actor());
--> statement-breakpoint
CREATE FUNCTION app.mobile_integrity_key_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF OLD.revoked_at IS NOT NULL OR (to_jsonb(NEW)-'assertion_counter'-'revoked_at') IS DISTINCT FROM (to_jsonb(OLD)-'assertion_counter'-'revoked_at')
 OR (NEW.revoked_at IS NOT NULL AND NEW.assertion_counter<>OLD.assertion_counter)
 OR (NEW.revoked_at IS NULL AND NEW.assertion_counter<=OLD.assertion_counter) THEN RAISE EXCEPTION 'Integrity key is immutable'; END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.mobile_integrity_key_immutable() FROM PUBLIC;
CREATE TRIGGER mobile_integrity_key_immutable BEFORE UPDATE ON mobile_integrity_key FOR EACH ROW EXECUTE FUNCTION app.mobile_integrity_key_immutable();
