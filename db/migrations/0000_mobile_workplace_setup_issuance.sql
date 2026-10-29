-- ADR-0161 — operator intents for mobile workplace setups, and the operator's status read.
-- PLACEHOLDER NUMBER: renamed and journaled by the integrator; until then drizzle never applies it.
--
-- The web tier cannot read or write another tenant's tenant_setting (tenant RLS; 0313 refuses the app
-- role on platform keys) and must never load the signing key. So the operator console records an INTENT
-- here and the owner-role provisioning runner executes it (module_change_request, 0345/0601). The only
-- write path for the application role is app.operator_request_mobile_setup; the only cross-tenant read
-- is app.operator_mobile_setup. Both re-check the operator in the database (app.assert_customer_operator).
CREATE TABLE mobile_setup_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  action text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  -- Import only: the uploaded signed setup — public routing data, never a key. The runner verifies it
  -- again against the app's trust anchors, this server's origin and the customer's organization code.
  setup jsonb,
  -- A refusal or failure reason CODE written by the runner. Never a message, path or payload.
  error text,
  claimed_at timestamptz,
  -- The operator's app_user id (installation tenant). No FK: the row must outlive a login change.
  requested_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  CONSTRAINT mobile_setup_request_action_ck CHECK (action IN ('issue', 'import')),
  CONSTRAINT mobile_setup_request_status_ck CHECK (status IN ('pending', 'running', 'done', 'failed')),
  CONSTRAINT mobile_setup_request_setup_ck CHECK ((action = 'import') = (setup IS NOT NULL)),
  CONSTRAINT mobile_setup_request_setup_size_ck CHECK (setup IS NULL OR (jsonb_typeof(setup) = 'object' AND length(setup::text) <= 16384)),
  CONSTRAINT mobile_setup_request_error_ck CHECK (error IS NULL OR error ~ '^[a-z_]{1,40}$')
);
--> statement-breakpoint
-- One open intent per customer: a second click cannot queue a second signing or a competing import.
CREATE UNIQUE INDEX mobile_setup_request_one_open ON mobile_setup_request (tenant_id) WHERE status IN ('pending', 'running');
--> statement-breakpoint
CREATE INDEX mobile_setup_request_claim_idx ON mobile_setup_request (status, created_at, id);
--> statement-breakpoint
CREATE INDEX mobile_setup_request_tenant_idx ON mobile_setup_request (tenant_id, created_at DESC, id DESC);
--> statement-breakpoint
-- bootstrap-db.sql's default privileges hand ai_hr_app full CRUD on every new table, so the narrowing is
-- explicit. SELECT is granted (a dev restore has no default privileges, 0345/0354) and RLS confines it to
-- the caller's own tenant, as for module_change_request. No INSERT/UPDATE/DELETE for the app role.
ALTER TABLE mobile_setup_request ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON mobile_setup_request FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
GRANT SELECT ON mobile_setup_request TO ai_hr_app;
--> statement-breakpoint
CREATE POLICY mobile_setup_request_read ON mobile_setup_request FOR SELECT USING (tenant_id = app.current_tenant_id());
--> statement-breakpoint
-- Status only: the customer's stored setup value (signed PUBLIC routing data the operator already sees in
-- parts — server, organization code, account name), its provenance and the ten latest intents. Nothing
-- here can hold or reveal a key. The web tier re-verifies the setup before it shows a link.
CREATE FUNCTION app.operator_mobile_setup(p_tenant uuid)
RETURNS TABLE(setting jsonb, source text, updated_at timestamptz, requests jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM app.assert_customer_operator();
 RETURN QUERY SELECT s.value, s.source, s.updated_at,
  coalesce((SELECT jsonb_agg(jsonb_build_object('id',r.id,'action',r.action,'status',r.status,'error',r.error,
    'createdAt',r.created_at,'decidedAt',r.decided_at) ORDER BY r.created_at DESC,r.id DESC)
   FROM (SELECT x.id,x.action,x.status,x.error,x.created_at,x.decided_at FROM public.mobile_setup_request x
    WHERE x.tenant_id=t.id ORDER BY x.created_at DESC,x.id DESC LIMIT 10) r),'[]'::jsonb)
 FROM public.tenant t
 LEFT JOIN public.tenant_setting s ON s.tenant_id=t.id AND s.key='mobile.workplace_setup'
 WHERE t.id=p_tenant AND t.id<>'00000000-0000-0000-0000-000000000000'::uuid;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.operator_mobile_setup(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.operator_mobile_setup(uuid) TO ai_hr_app;
--> statement-breakpoint
-- The operator's only write: record an intent and its audit event. Whether this installation can sign is
-- decided by the runner, which holds the key; it refuses an issue intent it cannot honour.
CREATE FUNCTION app.operator_request_mobile_setup(p_tenant uuid, p_action text, p_setup jsonb DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result uuid;
BEGIN
 PERFORM app.assert_customer_operator();
 PERFORM pg_advisory_xact_lock(hashtextextended('mobile-setup-request:'||coalesce(p_tenant::text,''),0));
 IF p_tenant IS NULL OR NOT EXISTS(SELECT 1 FROM public.tenant WHERE id=p_tenant AND id<>'00000000-0000-0000-0000-000000000000'::uuid)
 THEN RAISE EXCEPTION 'OPERATOR_CUSTOMER_MISSING'; END IF;
 IF p_action IS NULL OR p_action NOT IN ('issue','import') THEN RAISE EXCEPTION 'OPERATOR_SETUP_ACTION_INVALID'; END IF;
 IF (p_action='import') <> (p_setup IS NOT NULL)
    OR (p_setup IS NOT NULL AND (jsonb_typeof(p_setup)<>'object' OR length(p_setup::text)>16384))
 THEN RAISE EXCEPTION 'OPERATOR_SETUP_FILE_INVALID'; END IF;
 IF EXISTS(SELECT 1 FROM public.mobile_setup_request WHERE tenant_id=p_tenant AND status IN ('pending','running'))
 THEN RAISE EXCEPTION 'OPERATOR_SETUP_PENDING'; END IF;
 INSERT INTO public.mobile_setup_request(tenant_id,action,setup,requested_by)
 VALUES(p_tenant,p_action,p_setup,app.current_user_id()) RETURNING id INTO result;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
 VALUES(p_tenant,'mobile-setup-request',result,'mobile.workplace-setup.requested','user',app.current_user_id(),
  jsonb_build_object('action',p_action));
 RETURN result;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.operator_request_mobile_setup(uuid,text,jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.operator_request_mobile_setup(uuid,text,jsonb) TO ai_hr_app;
