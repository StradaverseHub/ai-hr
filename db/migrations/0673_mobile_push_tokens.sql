-- Filename reserved centrally. DRAFT: no journal idx/when, not authorized for application (held like 0647).
-- M10 push (owner decision D6, 28 October 2026, amending ADR-0088 §3): a native push token is bound to
-- (tenant, user, installation) — the login, never an employment, and the app installation id the integrity
-- enrollment already uses (mobile/lib/submission-native.ts nativeIntegrityInstallationId). Delivery is DIRECT to
-- APNs/FCM by scripts/mobile-push-sweep.ts. Payloads are generic: no table here stores notification text.
--
-- RLS is ENABLED and deliberately NOT FORCED. The application role reads and writes only the caller's own rows.
-- The delivery sweep runs as the migration role, which OWNS these tables, so it reads a tenant's registrations
-- without a policy. FORCE would hide every row from that owner on a server, where it is NOSUPERUSER/NOBYPASSRLS,
-- while a postgres-owned test still passed (the ADR-0034 "private reader" trap). A rebinding that must reach
-- ANOTHER user's or tenant's row goes through app.mobile_push_release(), which can only revoke.
CREATE TABLE mobile_push_registration (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenant(id),
 user_id uuid NOT NULL REFERENCES app_user(id),
 installation_id uuid NOT NULL,
 platform text NOT NULL CHECK(platform IN ('ios','android')),
 provider text NOT NULL CHECK(provider IN ('apns','fcm')),
 token text NOT NULL CHECK(length(token) BETWEEN 16 AND 1024 AND token ~ '^[A-Za-z0-9_:.-]+$'),
 locale text NOT NULL CHECK(locale IN ('en','ms')),
 app_version text CHECK(app_version IS NULL OR app_version ~ '^[0-9A-Za-z.+-]{1,32}$'),
 app_build text CHECK(app_build IS NULL OR app_build ~ '^[0-9A-Za-z.+-]{1,32}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 revoked_at timestamptz,
 revoke_reason text CHECK(revoke_reason IN ('logout','turned_off','company_switch','permission_denied','replaced','rebound','invalid_token')),
 CHECK((platform='ios' AND provider='apns') OR (platform='android' AND provider='fcm')),
 CHECK((revoked_at IS NULL)=(revoke_reason IS NULL)),
 CHECK(revoked_at IS NULL OR revoked_at>=created_at),
 CHECK(updated_at>=created_at)
);
-- One active binding per installation in a tenant, and one active binding per device token anywhere: a token that
-- moves to another user or tenant revokes its old binding first (app.mobile_push_release, below).
CREATE UNIQUE INDEX mobile_push_registration_installation_uq ON mobile_push_registration(tenant_id,installation_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX mobile_push_registration_token_uq ON mobile_push_registration(provider,token) WHERE revoked_at IS NULL;
CREATE INDEX mobile_push_registration_user_idx ON mobile_push_registration(tenant_id,user_id) WHERE revoked_at IS NULL;
ALTER TABLE mobile_push_registration ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON mobile_push_registration FROM PUBLIC,ai_hr_app;
GRANT SELECT,INSERT ON mobile_push_registration TO ai_hr_app;
GRANT UPDATE(locale,app_version,app_build,updated_at,revoked_at,revoke_reason) ON mobile_push_registration TO ai_hr_app;
CREATE POLICY mobile_push_registration_own_read ON mobile_push_registration FOR SELECT USING
 (tenant_id=app.current_tenant_id() AND user_id=app.current_user_id());
CREATE POLICY mobile_push_registration_own_insert ON mobile_push_registration FOR INSERT WITH CHECK
 (tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND app.mobile_integrity_actor() AND revoked_at IS NULL);
CREATE POLICY mobile_push_registration_own_update ON mobile_push_registration FOR UPDATE
 USING(tenant_id=app.current_tenant_id() AND user_id=app.current_user_id())
 WITH CHECK(tenant_id=app.current_tenant_id() AND user_id=app.current_user_id());
--> statement-breakpoint
-- The binding (tenant, user, installation, platform, provider, token) never changes; a new token is a new row and the
-- old one is revoked with its reason, so history is kept. A revoked row is final.
CREATE FUNCTION app.mobile_push_registration_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF OLD.revoked_at IS NOT NULL
 OR (to_jsonb(NEW)-'locale'-'app_version'-'app_build'-'updated_at'-'revoked_at'-'revoke_reason')
  IS DISTINCT FROM (to_jsonb(OLD)-'locale'-'app_version'-'app_build'-'updated_at'-'revoked_at'-'revoke_reason') THEN
  RAISE EXCEPTION 'Push registration binding is immutable';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.mobile_push_registration_guard() FROM PUBLIC;
CREATE TRIGGER mobile_push_registration_guard BEFORE UPDATE ON mobile_push_registration
 FOR EACH ROW EXECUTE FUNCTION app.mobile_push_registration_guard();
--> statement-breakpoint
-- Revoke every OTHER active binding of this installation in the caller's tenant (another user signed in on the same
-- phone) and of this device token anywhere (the token moved to another user or tenant). Only revokes: it reads nothing
-- back and cannot bind. The caller's own (tenant, user, installation) row is left to the service under RLS.
CREATE FUNCTION app.mobile_push_release(wanted_installation uuid,wanted_provider text,wanted_token text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE released integer;
BEGIN
 IF app.current_user_id() IS NULL OR app.current_tenant_id() IS NULL OR NOT app.mobile_integrity_actor() THEN
  RAISE EXCEPTION 'Push release requires an active signed-in actor';
 END IF;
 UPDATE public.mobile_push_registration r SET revoked_at=now(),revoke_reason='rebound',updated_at=now()
 WHERE r.revoked_at IS NULL
  AND NOT (r.tenant_id=app.current_tenant_id() AND r.user_id=app.current_user_id() AND r.installation_id=wanted_installation)
  AND ((r.tenant_id=app.current_tenant_id() AND r.installation_id=wanted_installation)
   OR (r.provider=wanted_provider AND r.token=wanted_token));
 GET DIAGNOSTICS released=ROW_COUNT;
 RETURN released;
END $$;
REVOKE ALL ON FUNCTION app.mobile_push_release(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.mobile_push_release(uuid,text,text) TO ai_hr_app;
--> statement-breakpoint
-- At most one push per (notification, registration): the sweep CLAIMS the row (outcome 'pending') before it calls the
-- provider, so a crash after the call leaves 'pending' and is never retried. No title, body, token or provider body is
-- stored; provider_reason is a provider's short code (BadDeviceToken, UNREGISTERED), never free text.
CREATE TABLE mobile_push_delivery (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenant(id),
 notification_id uuid NOT NULL REFERENCES notification(id) ON DELETE CASCADE,
 registration_id uuid NOT NULL REFERENCES mobile_push_registration(id),
 outcome text NOT NULL DEFAULT 'pending' CHECK(outcome IN ('pending','sent','invalid_token','failed','skipped')),
 provider_status integer CHECK(provider_status IS NULL OR provider_status BETWEEN 100 AND 599),
 provider_reason text CHECK(provider_reason IS NULL OR provider_reason ~ '^[A-Za-z_]{1,64}$'),
 claimed_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz,
 CHECK((outcome='pending')=(completed_at IS NULL))
);
CREATE UNIQUE INDEX mobile_push_delivery_once_uq ON mobile_push_delivery(notification_id,registration_id);
CREATE INDEX mobile_push_delivery_registration_idx ON mobile_push_delivery(registration_id);
ALTER TABLE mobile_push_delivery ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON mobile_push_delivery FROM PUBLIC,ai_hr_app;
GRANT SELECT ON mobile_push_delivery TO ai_hr_app;
CREATE POLICY mobile_push_delivery_own_read ON mobile_push_delivery FOR SELECT USING
 (tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM mobile_push_registration r WHERE r.id=registration_id
  AND r.tenant_id=mobile_push_delivery.tenant_id AND r.user_id=app.current_user_id()));
