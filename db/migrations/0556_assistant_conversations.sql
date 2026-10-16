-- One session conversation points at the existing private exchange audit. No second usage/credit store.
CREATE UNIQUE INDEX assistant_app_user_identity_uq ON app_user(id,tenant_id);
--> statement-breakpoint
CREATE UNIQUE INDEX assistant_exchange_identity_uq ON assistant_exchange(id,tenant_id,app_user_id);
--> statement-breakpoint
CREATE TABLE assistant_conversation (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),
 app_user_id uuid NOT NULL,sign_in_hash text NOT NULL,
 authority_stamp text NOT NULL,company_ids uuid[] NOT NULL DEFAULT '{}',revision integer NOT NULL DEFAULT 1,
 pending_request_id uuid,busy_until timestamptz,invalidated_at timestamptz,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '8 hours',created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,tenant_id,app_user_id),
 FOREIGN KEY(app_user_id,tenant_id) REFERENCES app_user(id,tenant_id),
 CHECK(sign_in_hash ~ '^[a-f0-9]{64}$' AND authority_stamp ~ '^[a-f0-9]{64}$'),
 CHECK(cardinality(company_ids)<=100 AND array_position(company_ids,NULL) IS NULL),
 CHECK(revision BETWEEN 1 AND 100000),CHECK((pending_request_id IS NULL)=(busy_until IS NULL))
);
CREATE UNIQUE INDEX assistant_conversation_current_uq ON assistant_conversation(tenant_id,app_user_id,sign_in_hash) WHERE invalidated_at IS NULL;
--> statement-breakpoint
CREATE TABLE assistant_conversation_turn (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,app_user_id uuid NOT NULL,
 conversation_id uuid NOT NULL,request_id uuid NOT NULL,revision integer NOT NULL,
 exchange_id uuid,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(conversation_id,tenant_id,app_user_id) REFERENCES assistant_conversation(id,tenant_id,app_user_id),
 FOREIGN KEY(exchange_id,tenant_id,app_user_id) REFERENCES assistant_exchange(id,tenant_id,app_user_id),
 UNIQUE(conversation_id,request_id),UNIQUE(conversation_id,revision),CHECK(revision>1)
);
--> statement-breakpoint
CREATE TABLE assistant_confirmation (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,app_user_id uuid NOT NULL,
 conversation_id uuid NOT NULL,revision integer NOT NULL DEFAULT 1,
 authority_stamp text NOT NULL,payload jsonb NOT NULL,precondition_digest text NOT NULL,
 status text NOT NULL DEFAULT 'awaiting',request_id uuid,result jsonb,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes',created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(conversation_id,tenant_id,app_user_id) REFERENCES assistant_conversation(id,tenant_id,app_user_id),
 CHECK(authority_stamp ~ '^[a-f0-9]{64}$' AND precondition_digest ~ '^[a-f0-9]{64}$'),
 CHECK(revision>0),CHECK(status IN ('awaiting','executing','completed','refused','uncertain')),
 CHECK(jsonb_typeof(payload)='object' AND payload->>'typeId'='close_fixed_upstream'
  AND jsonb_typeof(payload->'verdictIds')='array' AND jsonb_array_length(payload->'verdictIds') BETWEEN 1 AND 50
  AND octet_length(payload::text)<=4096),CHECK(result IS NULL OR octet_length(result::text)<=4096)
);
CREATE INDEX assistant_confirmation_conversation_idx ON assistant_confirmation(conversation_id,created_at DESC);
--> statement-breakpoint
-- Same self-only visibility as assistant_exchange. Admin status is never a transcript permission.
ALTER TABLE assistant_conversation ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant_conversation FORCE ROW LEVEL SECURITY;
ALTER TABLE assistant_conversation_turn ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant_conversation_turn FORCE ROW LEVEL SECURITY;
ALTER TABLE assistant_confirmation ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant_confirmation FORCE ROW LEVEL SECURITY;
CREATE POLICY assistant_conversation_self ON assistant_conversation FOR ALL USING(tenant_id=app.current_tenant_id() AND app_user_id=app.current_user_id()) WITH CHECK(tenant_id=app.current_tenant_id() AND app_user_id=app.current_user_id());
CREATE POLICY assistant_conversation_turn_self ON assistant_conversation_turn FOR ALL USING(tenant_id=app.current_tenant_id() AND app_user_id=app.current_user_id()) WITH CHECK(tenant_id=app.current_tenant_id() AND app_user_id=app.current_user_id());
CREATE POLICY assistant_confirmation_self ON assistant_confirmation FOR ALL USING(tenant_id=app.current_tenant_id() AND app_user_id=app.current_user_id()) WITH CHECK(tenant_id=app.current_tenant_id() AND app_user_id=app.current_user_id());
REVOKE ALL ON assistant_conversation,assistant_conversation_turn,assistant_confirmation FROM PUBLIC,ai_hr_app;
GRANT SELECT,INSERT,UPDATE ON assistant_conversation,assistant_conversation_turn,assistant_confirmation TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_conversation_identity_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.app_user_id IS DISTINCT FROM OLD.app_user_id OR NEW.id IS DISTINCT FROM OLD.id THEN RAISE EXCEPTION 'Conversation identity is immutable';END IF;
 IF TG_TABLE_NAME='assistant_conversation' THEN IF (NEW.sign_in_hash IS DISTINCT FROM OLD.sign_in_hash OR NEW.authority_stamp IS DISTINCT FROM OLD.authority_stamp OR NEW.company_ids IS DISTINCT FROM OLD.company_ids OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR OLD.invalidated_at IS NOT NULL AND NEW.invalidated_at IS DISTINCT FROM OLD.invalidated_at) THEN RAISE EXCEPTION 'Conversation binding is immutable';END IF;END IF;
 IF TG_TABLE_NAME='assistant_conversation_turn' THEN IF (NEW.conversation_id IS DISTINCT FROM OLD.conversation_id OR NEW.request_id IS DISTINCT FROM OLD.request_id OR NEW.revision IS DISTINCT FROM OLD.revision OR OLD.exchange_id IS NOT NULL AND NEW.exchange_id IS DISTINCT FROM OLD.exchange_id) THEN RAISE EXCEPTION 'Conversation turn is immutable';END IF;END IF;
 IF TG_TABLE_NAME='assistant_confirmation' THEN
  IF NEW.conversation_id IS DISTINCT FROM OLD.conversation_id OR NEW.payload IS DISTINCT FROM OLD.payload OR NEW.precondition_digest IS DISTINCT FROM OLD.precondition_digest OR NEW.authority_stamp IS DISTINCT FROM OLD.authority_stamp OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN RAISE EXCEPTION 'Confirmed proposal is immutable';END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT(OLD.status='awaiting' AND NEW.status IN ('executing','refused') OR OLD.status='executing' AND NEW.status IN ('completed','uncertain')) THEN RAISE EXCEPTION 'Invalid proposal transition';END IF;
  IF OLD.status IN ('completed','refused','uncertain') AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Final proposal is immutable';END IF;
 END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.assistant_conversation_identity_guard() FROM PUBLIC;
CREATE TRIGGER assistant_conversation_identity_guard BEFORE UPDATE ON assistant_conversation FOR EACH ROW EXECUTE FUNCTION app.assistant_conversation_identity_guard();
CREATE TRIGGER assistant_conversation_turn_identity_guard BEFORE UPDATE ON assistant_conversation_turn FOR EACH ROW EXECUTE FUNCTION app.assistant_conversation_identity_guard();
CREATE TRIGGER assistant_confirmation_identity_guard BEFORE UPDATE ON assistant_confirmation FOR EACH ROW EXECUTE FUNCTION app.assistant_conversation_identity_guard();
--> statement-breakpoint
-- This hash is not retrieval authority. The service first resolves real entitlements with their
-- canonical owner and calls mayUseAssistantTx in the SAME scoped transaction. No report/notification
-- module, report visibility or private transport grant is required or exposed.
CREATE FUNCTION app.assistant_authority_stamp(p_companies uuid[]) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actual jsonb;supplied jsonb;actual_roles text[];
BEGIN
 SELECT p.grants INTO actual FROM app.principal(app.current_user_id()) p JOIN app_user u ON u.id=app.current_user_id()
 WHERE p.tenant_id=app.current_tenant_id() AND u.tenant_id=p.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id);
 IF actual IS NULL OR p_companies IS NULL OR cardinality(p_companies)>100 OR array_position(p_companies,NULL) IS NOT NULL THEN RAISE EXCEPTION 'Assistant context unavailable';END IF;
 SELECT coalesce(jsonb_agg(g ORDER BY g->>'role',g->>'companyId'),'[]'::jsonb) INTO actual FROM jsonb_array_elements(actual) g;
 SELECT coalesce(jsonb_agg(g ORDER BY g->>'role',g->>'companyId'),'[]'::jsonb) INTO supplied FROM jsonb_array_elements(coalesce(nullif(current_setting('app.grants',true),'')::jsonb,'[]'::jsonb)) g;
 SELECT coalesce(array_agg(DISTINCT g->>'role' ORDER BY g->>'role'),ARRAY[]::text[]) INTO actual_roles FROM jsonb_array_elements(actual) g;
 IF actual IS DISTINCT FROM supplied OR actual_roles IS DISTINCT FROM ARRAY(SELECT DISTINCT role FROM unnest(app.current_roles()) role ORDER BY role)
 OR EXISTS(SELECT 1 FROM unnest(p_companies) id WHERE NOT EXISTS(SELECT 1 FROM company c WHERE c.id=id AND c.tenant_id=app.current_tenant_id()))
 OR NOT EXISTS(SELECT 1 FROM assistant_grant g WHERE g.tenant_id=app.current_tenant_id() AND g.app_user_id=app.current_user_id() AND g.revoked_at IS NULL) THEN RAISE EXCEPTION 'Assistant context unavailable';END IF;
 RETURN encode(sha256(convert_to(jsonb_build_object('purpose','assistant-authority-v1','actor',app.current_user_id(),
  'person',(SELECT u.person_id FROM app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id()),
  'companies',ARRAY(SELECT DISTINCT id FROM unnest(p_companies) id ORDER BY id),
  'source',identity_email.report_access_stamp(app.current_tenant_id()),
  'aiControls',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.id),'[]'::jsonb) FROM ai_control_policy c WHERE c.tenant_id=app.current_tenant_id()),
  'providerRevision',(SELECT coalesce(jsonb_agg(jsonb_build_array(c.id,c.provider,c.model,c.is_active,c.updated_at) ORDER BY c.id),'[]'::jsonb) FROM ai_provider_config c WHERE c.tenant_id=app.current_tenant_id()),
  'assistantGrants',(SELECT coalesce(jsonb_agg(jsonb_build_array(g.id,g.granted_at,g.revoked_at) ORDER BY g.id),'[]'::jsonb) FROM assistant_grant g WHERE g.tenant_id=app.current_tenant_id() AND g.app_user_id=app.current_user_id()))::text,'UTF8')),'hex');
END $$;
REVOKE ALL ON FUNCTION app.assistant_authority_stamp(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_authority_stamp(uuid[]) TO ai_hr_app;
