-- A migration-owned installation identity. Application sessions cannot replace/read the raw row.
CREATE TABLE mobile_integrity_installation (
 singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
 installation_id uuid NOT NULL DEFAULT gen_random_uuid()
);
CREATE UNIQUE INDEX mobile_integrity_installation_id_uq ON mobile_integrity_installation(installation_id);
INSERT INTO mobile_integrity_installation(singleton) VALUES(true);
ALTER TABLE mobile_integrity_installation ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON mobile_integrity_installation FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.mobile_integrity_installation_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT installation_id FROM public.mobile_integrity_installation WHERE singleton
$$;
REVOKE ALL ON FUNCTION app.mobile_integrity_installation_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.mobile_integrity_installation_id() TO ai_hr_app;
--> statement-breakpoint
-- Row scope follows the active own-profile subject, never manager/report or administrator visibility.
CREATE FUNCTION app.mobile_integrity_subject(wanted uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM public.employment e JOIN public.app_user u
 ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id
 WHERE e.id=wanted AND e.tenant_id=app.current_tenant_id() AND u.id=app.current_user_id()
 AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND e.blacklisted_at IS NULL
 AND e.hired_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
 AND (LEAST(e.resignation_date,e.last_working_date,e.terminated_on) IS NULL
 OR LEAST(e.resignation_date,e.last_working_date,e.terminated_on)>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date))
$$;
REVOKE ALL ON FUNCTION app.mobile_integrity_subject(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.mobile_integrity_subject(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE TABLE mobile_integrity_challenge (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),
 actor_id uuid NOT NULL REFERENCES app_user(id),employment_id uuid NOT NULL REFERENCES employment(id),
 installation_id uuid NOT NULL REFERENCES mobile_integrity_installation(installation_id),
 app_installation_id uuid NOT NULL,request_id uuid NOT NULL,
 purpose text NOT NULL CHECK(purpose IN ('device.enrollment','clock.online')),
 binding_hash text NOT NULL CHECK(binding_hash ~ '^[a-f0-9]{64}$'),
 nonce text NOT NULL CHECK(length(nonce)=43 AND nonce ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'),
 issued_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,consumed_at timestamptz,
 CHECK(expires_at>issued_at AND expires_at<=issued_at+interval '10 minutes'),
 CHECK(consumed_at IS NULL OR consumed_at>=issued_at AND consumed_at<=expires_at)
);
CREATE UNIQUE INDEX mobile_integrity_challenge_intent_uq ON mobile_integrity_challenge(tenant_id,actor_id,request_id);
CREATE UNIQUE INDEX mobile_integrity_challenge_nonce_uq ON mobile_integrity_challenge(nonce);
CREATE INDEX mobile_integrity_challenge_pending_idx ON mobile_integrity_challenge(tenant_id,actor_id,expires_at) WHERE consumed_at IS NULL;
ALTER TABLE mobile_integrity_challenge ENABLE ROW LEVEL SECURITY;
ALTER TABLE mobile_integrity_challenge FORCE ROW LEVEL SECURITY;
REVOKE ALL ON mobile_integrity_challenge FROM PUBLIC,ai_hr_app;
GRANT SELECT,INSERT ON mobile_integrity_challenge TO ai_hr_app;
GRANT UPDATE(consumed_at) ON mobile_integrity_challenge TO ai_hr_app;
CREATE POLICY mobile_integrity_challenge_own ON mobile_integrity_challenge
 USING(tenant_id=app.current_tenant_id() AND actor_id=app.current_user_id() AND app.mobile_integrity_subject(employment_id))
 WITH CHECK(tenant_id=app.current_tenant_id() AND actor_id=app.current_user_id()
 AND installation_id=app.mobile_integrity_installation_id() AND app.mobile_integrity_subject(employment_id));
--> statement-breakpoint
CREATE FUNCTION app.mobile_integrity_challenge_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL
 OR (to_jsonb(NEW)-'consumed_at') IS DISTINCT FROM (to_jsonb(OLD)-'consumed_at') THEN
  RAISE EXCEPTION 'Integrity challenge is immutable';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.mobile_integrity_challenge_immutable() FROM PUBLIC;
CREATE TRIGGER mobile_integrity_challenge_immutable BEFORE UPDATE ON mobile_integrity_challenge
 FOR EACH ROW EXECUTE FUNCTION app.mobile_integrity_challenge_immutable();
