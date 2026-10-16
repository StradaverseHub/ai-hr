-- Legacy/default/model calls remain questions. Only server-produced zero-model capabilities use
-- the second classification; the existing usage owner remains the sole metering record.
ALTER TABLE assistant_exchange ADD COLUMN interaction_kind text NOT NULL DEFAULT 'question' CHECK(interaction_kind IN ('question','capability'));
--> statement-breakpoint
ALTER TABLE assistant_exchange ADD CONSTRAINT assistant_exchange_capability_no_model CHECK(interaction_kind='question' OR (turn_count=0 AND provider IS NULL AND model IS NULL AND input_tokens=0 AND output_tokens=0 AND cached_input_tokens=0 AND tool_calls='[]'::jsonb));
CREATE FUNCTION app.assistant_exchange_kind_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN IF NEW.interaction_kind IS DISTINCT FROM OLD.interaction_kind THEN RAISE EXCEPTION 'Exchange classification is immutable';END IF;RETURN NEW;END $$;
REVOKE ALL ON FUNCTION app.assistant_exchange_kind_guard() FROM PUBLIC;
CREATE TRIGGER assistant_exchange_kind_guard BEFORE UPDATE ON assistant_exchange FOR EACH ROW EXECUTE FUNCTION app.assistant_exchange_kind_guard();
--> statement-breakpoint
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
 exchange_id uuid,helpful boolean,feedback_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(conversation_id,tenant_id,app_user_id) REFERENCES assistant_conversation(id,tenant_id,app_user_id),
 FOREIGN KEY(exchange_id,tenant_id,app_user_id) REFERENCES assistant_exchange(id,tenant_id,app_user_id),
 UNIQUE(conversation_id,request_id),UNIQUE(conversation_id,revision),CHECK(revision>1),CHECK((helpful IS NULL)=(feedback_at IS NULL)),CHECK(helpful IS NULL OR exchange_id IS NOT NULL)
);
--> statement-breakpoint
CREATE FUNCTION app.assistant_confirmed_payload_valid(p jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v jsonb;seen text[]:=ARRAY[]::text[];
BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(p))<>2 OR p->>'typeId' IS DISTINCT FROM 'close_fixed_upstream' OR jsonb_typeof(p->'verdictIds') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
 IF jsonb_array_length(p->'verdictIds') NOT BETWEEN 1 AND 50 OR octet_length(p::text)>4096 THEN RETURN false;END IF;
 FOR v IN SELECT value FROM jsonb_array_elements(p->'verdictIds') LOOP
  IF jsonb_typeof(v)<>'string' OR (v#>>'{}') !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' OR lower(v#>>'{}')=ANY(seen) THEN RETURN false;END IF;seen:=array_append(seen,lower(v#>>'{}'));
 END LOOP;RETURN true;
END $$;
REVOKE ALL ON FUNCTION app.assistant_confirmed_payload_valid(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_confirmed_payload_valid(jsonb) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_confirmation_result_valid(p jsonb,n integer) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE closed numeric;stale numeric;
BEGIN
 IF p IS NULL THEN RETURN true;END IF;
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(p))<>2 OR jsonb_typeof(p->'closed') IS DISTINCT FROM 'number' OR jsonb_typeof(p->'stale') IS DISTINCT FROM 'number' THEN RETURN false;END IF;
 closed:=(p->>'closed')::numeric;stale:=(p->>'stale')::numeric;
 RETURN closed=trunc(closed) AND stale=trunc(stale) AND closed>=0 AND stale>=0 AND closed+stale=n;
END $$;
REVOKE ALL ON FUNCTION app.assistant_confirmation_result_valid(jsonb,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_confirmation_result_valid(jsonb,integer) TO ai_hr_app;
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
 CHECK((status='completed')=(result IS NOT NULL)),CHECK(status NOT IN ('executing','completed','uncertain') OR request_id IS NOT NULL),
 CHECK(app.assistant_confirmed_payload_valid(payload)),CHECK(result IS NULL OR octet_length(result::text)<=4096),CHECK(app.assistant_confirmation_result_valid(result,jsonb_array_length(payload->'verdictIds')))
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
 IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.app_user_id IS DISTINCT FROM OLD.app_user_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN RAISE EXCEPTION 'Conversation identity is immutable';END IF;
 IF TG_TABLE_NAME='assistant_conversation' THEN
  IF NEW.revision NOT IN (OLD.revision,OLD.revision+1) THEN RAISE EXCEPTION 'Invalid conversation revision';END IF;
  IF (NEW.sign_in_hash IS DISTINCT FROM OLD.sign_in_hash OR NEW.authority_stamp IS DISTINCT FROM OLD.authority_stamp OR NEW.company_ids IS DISTINCT FROM OLD.company_ids OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR OLD.invalidated_at IS NOT NULL AND NEW.invalidated_at IS DISTINCT FROM OLD.invalidated_at) THEN RAISE EXCEPTION 'Conversation binding is immutable';END IF;END IF;
 IF TG_TABLE_NAME='assistant_conversation_turn' THEN IF (NEW.conversation_id IS DISTINCT FROM OLD.conversation_id OR NEW.request_id IS DISTINCT FROM OLD.request_id OR NEW.revision IS DISTINCT FROM OLD.revision OR OLD.exchange_id IS NOT NULL AND NEW.exchange_id IS DISTINCT FROM OLD.exchange_id) THEN RAISE EXCEPTION 'Conversation turn is immutable';END IF;END IF;
 IF TG_TABLE_NAME='assistant_confirmation' THEN
  IF NEW.conversation_id IS DISTINCT FROM OLD.conversation_id OR NEW.payload IS DISTINCT FROM OLD.payload OR NEW.precondition_digest IS DISTINCT FROM OLD.precondition_digest OR NEW.authority_stamp IS DISTINCT FROM OLD.authority_stamp OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN RAISE EXCEPTION 'Confirmed proposal is immutable';END IF;
  IF OLD.request_id IS NOT NULL AND NEW.request_id IS DISTINCT FROM OLD.request_id THEN RAISE EXCEPTION 'Confirmation request is immutable';END IF;
  IF NEW.revision<>OLD.revision+CASE WHEN OLD.status='executing' AND NEW.status IN ('completed','uncertain') THEN 1 ELSE 0 END THEN RAISE EXCEPTION 'Invalid confirmation revision';END IF;
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
  -- Canonical archive/restore cycles must not revive an old conversation with identical current flags.
  'loginLifecycle',(SELECT jsonb_build_array(e.id,e.event_type,e.occurred_at) FROM domain_event e WHERE e.tenant_id=app.current_tenant_id() AND e.aggregate_type='app-user' AND e.aggregate_id=app.current_user_id() AND e.event_type IN ('app-user.archived','app-user.restored') ORDER BY e.occurred_at DESC,e.id DESC LIMIT 1),
  'source',identity_email.report_access_stamp(app.current_tenant_id()),
  'aiControls',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.id),'[]'::jsonb) FROM ai_control_policy c WHERE c.tenant_id=app.current_tenant_id()),
  'providerRevision',(SELECT coalesce(jsonb_agg(jsonb_build_array(c.id,c.provider,c.model,c.is_active,c.updated_at) ORDER BY c.id),'[]'::jsonb) FROM ai_provider_config c WHERE c.tenant_id=app.current_tenant_id()),
  'assistantGrants',(SELECT coalesce(jsonb_agg(jsonb_build_array(g.id,g.granted_at,g.revoked_at) ORDER BY g.id),'[]'::jsonb) FROM assistant_grant g WHERE g.tenant_id=app.current_tenant_id() AND g.app_user_id=app.current_user_id()))::text,'UTF8')),'hex');
END $$;
REVOKE ALL ON FUNCTION app.assistant_authority_stamp(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_authority_stamp(uuid[]) TO ai_hr_app;
--> statement-breakpoint
-- Private handoff metadata only; editable content is submitted to the canonical Feedback owner.
CREATE UNIQUE INDEX assistant_turn_exchange_ref_uq ON assistant_conversation_turn(conversation_id,exchange_id,tenant_id,app_user_id);
CREATE UNIQUE INDEX assistant_feedback_result_tenant_uq ON feedback_request(id,tenant_id);
CREATE TABLE assistant_feedback_draft(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,app_user_id uuid NOT NULL,conversation_id uuid NOT NULL,source_exchange_id uuid NOT NULL,handoff_exchange_id uuid NOT NULL,
 revision integer NOT NULL DEFAULT 1 CHECK(revision IN(1,2)),feedback_id uuid,submit_digest text,submitted_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL DEFAULT now()+interval '30 minutes',UNIQUE(conversation_id,source_exchange_id),
 FOREIGN KEY(feedback_id,tenant_id) REFERENCES feedback_request(id,tenant_id),
 FOREIGN KEY(conversation_id,tenant_id,app_user_id) REFERENCES assistant_conversation(id,tenant_id,app_user_id),
 FOREIGN KEY(conversation_id,source_exchange_id,tenant_id,app_user_id) REFERENCES assistant_conversation_turn(conversation_id,exchange_id,tenant_id,app_user_id),
 FOREIGN KEY(conversation_id,handoff_exchange_id,tenant_id,app_user_id) REFERENCES assistant_conversation_turn(conversation_id,exchange_id,tenant_id,app_user_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(source_exchange_id,tenant_id,app_user_id) REFERENCES assistant_exchange(id,tenant_id,app_user_id),
 FOREIGN KEY(handoff_exchange_id,tenant_id,app_user_id) REFERENCES assistant_exchange(id,tenant_id,app_user_id),
 CHECK((feedback_id IS NULL)=(submit_digest IS NULL) AND(feedback_id IS NULL)=(submitted_at IS NULL)),CHECK(submit_digest IS NULL OR submit_digest~'^[0-9a-f]{64}$'),CHECK((feedback_id IS NULL AND revision=1) OR(feedback_id IS NOT NULL AND revision=2)));
ALTER TABLE assistant_feedback_draft ENABLE ROW LEVEL SECURITY;ALTER TABLE assistant_feedback_draft FORCE ROW LEVEL SECURITY;
CREATE POLICY assistant_feedback_draft_self ON assistant_feedback_draft FOR ALL USING(tenant_id=app.current_tenant_id() AND app_user_id=app.current_user_id()) WITH CHECK(tenant_id=app.current_tenant_id() AND app_user_id=app.current_user_id());
REVOKE ALL ON assistant_feedback_draft FROM PUBLIC,ai_hr_app;GRANT SELECT,INSERT,UPDATE ON assistant_feedback_draft TO ai_hr_app;
CREATE FUNCTION app.assistant_feedback_draft_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Handoff history is retained';END IF;
 IF TG_OP='INSERT' AND(NEW.feedback_id IS NOT NULL OR NEW.revision<>1) THEN RAISE EXCEPTION 'A handoff starts unsubmitted';END IF;
 IF TG_OP='UPDATE' THEN
  IF OLD.feedback_id IS NOT NULL OR (to_jsonb(NEW)-ARRAY['feedback_id','submit_digest','submitted_at','revision'])<>(to_jsonb(OLD)-ARRAY['feedback_id','submit_digest','submitted_at','revision']) OR NEW.feedback_id IS NULL OR NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'Handoff identity/result is immutable';END IF;
  IF NOT EXISTS(SELECT 1 FROM public.feedback_request f WHERE f.id=NEW.feedback_id AND f.tenant_id=NEW.tenant_id AND f.reporter_user_id=NEW.app_user_id) THEN RAISE EXCEPTION 'Exact own Feedback result required';END IF;
 END IF;RETURN NEW;
END;$$;
REVOKE ALL ON FUNCTION app.assistant_feedback_draft_guard() FROM PUBLIC;
CREATE TRIGGER assistant_feedback_draft_guard BEFORE INSERT OR UPDATE OR DELETE ON assistant_feedback_draft FOR EACH ROW EXECUTE FUNCTION app.assistant_feedback_draft_guard();
