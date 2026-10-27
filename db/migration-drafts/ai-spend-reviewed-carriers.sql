-- UNALLOCATED / UNAPPLIED. No current route or certificate is installed by this draft.
-- ONLY the release/database owner may insert a record after independent external review of the
-- exact controlled workspace/key/endpoint/account invariants and source contract. An app admin,
-- key metadata, model price list or a successful completion is NOT certification. Account changes
-- must invalidate the certificate BEFORE mutation; expiry is not a substitute for that control.
CREATE TABLE app.ai_spend_reviewed_carrier_catalog(
 capability_digest text PRIMARY KEY REFERENCES app.ai_spend_capability(digest),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 carrier text NOT NULL CHECK(carrier='openrouter_fixed_free_text_v1'),
 configuration_digest text NOT NULL CHECK(configuration_digest~'^[a-f0-9]{64}$'),
 model text NOT NULL CHECK(model~'^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*:free$' AND lower(model) NOT LIKE 'openrouter/%'),
 operation text NOT NULL CHECK(operation IN('draft','conversation')),
 endpoint_slug text NOT NULL CHECK(length(endpoint_slug)<=128 AND endpoint_slug~'^[a-z0-9]+([-/][a-z0-9]+)*$'),
 source_digest text NOT NULL CHECK(source_digest~'^[a-f0-9]{64}$'),
 workspace_control_digest text NOT NULL CHECK(workspace_control_digest~'^[a-f0-9]{64}$'),
 review_evidence_digest text NOT NULL CHECK(review_evidence_digest~'^[a-f0-9]{64}$'),
 independent_evidence_digest text NOT NULL CHECK(independent_evidence_digest~'^[a-f0-9]{64}$' AND independent_evidence_digest<>review_evidence_digest),
 invariants jsonb NOT NULL CHECK(invariants='{"controlledWorkspace":true,"accountMutationGoverned":true,"noByok":true,"noDefaultPlugins":true,"noEnforcedPlugins":true,"noPresetInjection":true,"noServerTools":true,"noPaidCacheWrites":true,"noOtherCharges":true,"zdrEndpoint":true,"noTraining":true,"parametersEnforced":true,"exactEndpointOnly":true}'::jsonb),
 reviewed_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,revoked_at timestamptz,
 CHECK(expires_at>reviewed_at AND expires_at<=reviewed_at+interval '24 hours')
);
--> statement-breakpoint
ALTER TABLE app.ai_spend_reviewed_carrier_catalog ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.ai_spend_reviewed_carrier_catalog FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.ai_spend_reviewed_carrier(wanted_configuration text,wanted_model text,wanted_operation text,wanted_source text,wanted_signer text,wanted_signature text,wanted_request text)
 RETURNS TABLE(profile jsonb) LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE tid uuid:=app.current_tenant_id();uid uuid:=app.current_user_id();k app.ai_spend_receipt_verifier;expected bytea;received bytea;difference integer:=0;i integer;
BEGIN
 PERFORM app._ai_spend_bounds();
 IF tid IS NULL OR uid IS NULL OR wanted_configuration IS NULL OR wanted_configuration!~'^[a-f0-9]{64}$' OR wanted_source IS NULL OR wanted_source!~'^[a-f0-9]{64}$' OR wanted_operation NOT IN('draft','conversation') OR current_setting('transaction_read_only')<>'off' OR current_setting('transaction_isolation')<>'read committed' THEN RETURN;END IF;
 IF wanted_signer IS NULL OR wanted_signer!~'^[A-Za-z0-9_-]{1,64}$' OR wanted_signature IS NULL OR wanted_signature!~'^[a-f0-9]{64}$' OR wanted_request IS NULL OR wanted_request!~'^[a-f0-9]{64}$' THEN RETURN;END IF;
 IF NOT pg_try_advisory_xact_lock(hashtext('ai-control'),hashtext(tid::text)) THEN RAISE EXCEPTION 'Reviewed spend carrier busy';END IF;
 SELECT * INTO k FROM app.ai_spend_receipt_verifier WHERE key_id=wanted_signer AND enabled AND valid_from<=now() AND(retired_at IS NULL OR retired_at>now()) FOR SHARE NOWAIT;
 IF NOT FOUND THEN RETURN;END IF;
 expected:=public.hmac(convert_to('aihr.reviewed-carrier-signer.v1'||E'\n'||tid::text||E'\n'||uid::text||E'\n'||wanted_configuration||E'\n'||wanted_request,'UTF8'),k.secret,'sha256');received:=decode(wanted_signature,'hex');
 FOR i IN 0..31 LOOP difference:=difference | (get_byte(expected,i)#get_byte(received,i));END LOOP;IF difference<>0 THEN RETURN;END IF;
 -- Current principal/provider/source access is independently required by canonical admission.
 -- This private projection exposes only the exact tenant/configuration certificate, not keys.
 RETURN QUERY SELECT jsonb_build_object('capabilityDigest',r.capability_digest,'sourceDigest',r.source_digest,
 'configurationDigest',r.configuration_digest,'model',r.model,'operation',r.operation,'endpointSlug',r.endpoint_slug,
 'workspaceControlDigest',r.workspace_control_digest,'reviewEvidenceDigest',r.review_evidence_digest,
 'independentEvidenceDigest',r.independent_evidence_digest,'expiresAt',least(r.expires_at,c.expires_at,coalesce(k.retired_at,'infinity'::timestamptz))::text,'invariants',r.invariants)
 FROM app.ai_spend_reviewed_carrier_catalog r JOIN app.ai_spend_capability c ON c.digest=r.capability_digest
 WHERE r.tenant_id=tid AND r.configuration_digest=wanted_configuration AND r.model=wanted_model AND r.operation=wanted_operation AND r.source_digest=wanted_source
 AND r.reviewed_at<=now() AND r.expires_at>now() AND r.revoked_at IS NULL
 AND c.provider='openrouter' AND c.model=r.model AND c.operation=r.operation AND c.max_request_nanos=1 AND c.source_digest=r.source_digest
 AND c.semantics='complete_inference_usd_ceiling_v1' AND c.verified_at<=now() AND c.expires_at>now() AND c.revoked_at IS NULL
 ORDER BY r.expires_at DESC,r.capability_digest LIMIT 2 FOR SHARE OF r,c NOWAIT;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.ai_spend_reviewed_carrier(text,text,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ai_spend_reviewed_carrier(text,text,text,text,text,text,text) TO ai_hr_app;
--> statement-breakpoint
-- Source prerequisites0623/0625 have native model CHECKs that forbid every colon. Derive the
-- expected native definitions from their ORIGINAL expressions on identical temporary column
-- types. Refuse drift/ambiguity; never guess an anonymous constraint name or drop another guard.
DO $$
DECLARE actual text;expected text;candidate_constraint text;matches integer;
BEGIN
 CREATE TEMP TABLE _aihr_free_model_config_expected(LIKE public.ai_provider_config) ON COMMIT DROP;
 ALTER TABLE _aihr_free_model_config_expected ADD CONSTRAINT expected_old CHECK(provider::text<>'openrouter' OR(length(model) BETWEEN 3 AND 200 AND model~'^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$' AND model!~'[[:space:]]' AND lower(model)!~'^openrouter/'));
 SELECT pg_get_constraintdef(oid) INTO expected FROM pg_constraint WHERE conrelid='pg_temp._aihr_free_model_config_expected'::regclass AND conname='expected_old';
 SELECT pg_get_constraintdef(oid) INTO actual FROM pg_constraint WHERE conrelid='public.ai_provider_config'::regclass AND conname='ai_provider_config_fixed_router_model_ck' AND contype='c' AND convalidated;
 IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'OpenRouter configuration model prerequisite changed';END IF;
 ALTER TABLE public.ai_provider_config DROP CONSTRAINT ai_provider_config_fixed_router_model_ck;
 ALTER TABLE public.ai_provider_config ADD CONSTRAINT ai_provider_config_fixed_router_model_v2_ck CHECK(provider::text<>'openrouter' OR(length(model) BETWEEN 3 AND 200 AND model~'^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*(:free)?$' AND model!~'[[:space:]]' AND lower(model)!~'^openrouter/'));
 CREATE TEMP TABLE _aihr_free_model_candidate_expected(LIKE public.ai_provider_candidate) ON COMMIT DROP;
 ALTER TABLE _aihr_free_model_candidate_expected ADD CONSTRAINT expected_old CHECK(length(model) BETWEEN 3 AND 200 AND model~'^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$' AND lower(model)!~'^openrouter/');
 SELECT pg_get_constraintdef(oid) INTO expected FROM pg_constraint WHERE conrelid='pg_temp._aihr_free_model_candidate_expected'::regclass AND conname='expected_old';
 SELECT count(*)::int,min(conname::text) INTO matches,candidate_constraint FROM pg_constraint WHERE conrelid='public.ai_provider_candidate'::regclass AND contype='c' AND convalidated AND pg_get_constraintdef(oid)=expected;
 IF matches<>1 THEN RAISE EXCEPTION 'OpenRouter candidate model prerequisite changed';END IF;
 EXECUTE format('ALTER TABLE public.ai_provider_candidate DROP CONSTRAINT %I',candidate_constraint);
 ALTER TABLE public.ai_provider_candidate ADD CONSTRAINT ai_provider_candidate_fixed_router_model_v2_ck CHECK(length(model) BETWEEN 3 AND 200 AND model~'^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*(:free)?$' AND lower(model)!~'^openrouter/');
END $$;
--> statement-breakpoint
-- Retain historical zero-contract classification for already admitted receipts. Renewals insert a
-- distinct reviewed capability; only monotonic revocation may update an existing record.
CREATE FUNCTION app._ai_spend_reviewed_carrier_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Reviewed carrier history cannot be deleted';END IF;
 IF (to_jsonb(NEW)-'revoked_at') IS DISTINCT FROM(to_jsonb(OLD)-'revoked_at') OR(OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN RAISE EXCEPTION 'Reviewed carrier identity cannot change';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app._ai_spend_reviewed_carrier_immutable() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER ai_spend_reviewed_carrier_immutable BEFORE UPDATE OR DELETE ON app.ai_spend_reviewed_carrier_catalog FOR EACH ROW EXECUTE FUNCTION app._ai_spend_reviewed_carrier_immutable();
--> statement-breakpoint
-- Existing generic ledger behavior is unchanged except an authenticated positive charge on the
-- actual reviewed ZERO carrier is a breach even when ceil(USD*1e9)=1<=conservative allocation1.
-- No caller-supplied rule/amount can access this private function; outer HMAC verification owns it.
CREATE OR REPLACE FUNCTION app._ai_spend_confirm_verified_receipt(wanted_run uuid,actual_nanos bigint)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r app.ai_spend_reservation;
BEGIN
 PERFORM app._ai_spend_bounds();
 IF actual_nanos IS NULL OR actual_nanos<0 THEN RAISE EXCEPTION 'Verified spend receipt unavailable';END IF;
 SELECT * INTO r FROM app.ai_spend_reservation WHERE run_id=wanted_run;
 IF NOT FOUND THEN RAISE EXCEPTION 'Spend reservation unavailable';END IF;
 PERFORM pg_advisory_xact_lock(hashtext('ai-control'),hashtext(r.tenant_id::text));
 SELECT * INTO r FROM app.ai_spend_reservation WHERE run_id=wanted_run FOR UPDATE NOWAIT;
 IF r.state<>'held' THEN IF r.confirmed_nanos<>actual_nanos THEN RAISE EXCEPTION 'Verified spend receipt changed';END IF;RETURN;END IF;
 UPDATE app.ai_spend_reservation SET confirmed_nanos=actual_nanos,state=CASE WHEN actual_nanos>reserved_nanos OR(actual_nanos>0 AND EXISTS(
  SELECT 1 FROM app.ai_spend_reviewed_carrier_catalog c WHERE c.capability_digest=r.capability_digest AND c.tenant_id=r.tenant_id AND c.configuration_digest=r.configuration_digest AND c.carrier='openrouter_fixed_free_text_v1'
 )) THEN 'breach' ELSE 'confirmed' END,settled_at=now() WHERE run_id=wanted_run;
END $$;
REVOKE ALL ON FUNCTION app._ai_spend_confirm_verified_receipt(uuid,bigint) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Honest administration metadata: a reviewed record is NOT a live/routable/capability PASS.
-- The legacy zero field stays for compatibility and must not be rendered as an availability count.
CREATE OR REPLACE FUNCTION app.ai_spend_status() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF NOT app._ai_provider_evaluation_actor_valid() THEN RAISE EXCEPTION 'AI spend administration unavailable';END IF;
 SELECT jsonb_build_object('currency','USD','unit','nano_usd','semantics','application_inference_allocation','certifiedLiveRoutes',0,
 'reviewedCarrierRecords',(SELECT count(*)::int FROM app.ai_spend_reviewed_carrier_catalog r JOIN app.ai_spend_capability c ON c.digest=r.capability_digest WHERE r.tenant_id=app.current_tenant_id() AND r.reviewed_at<=now() AND r.expires_at>now() AND r.revoked_at IS NULL AND c.verified_at<=now() AND c.expires_at>now() AND c.revoked_at IS NULL AND c.provider='openrouter' AND c.model=r.model AND c.operation=r.operation AND c.source_digest=r.source_digest AND c.max_request_nanos=1),
 'liveCapability','not_verified_here',
 'budgets',coalesce((SELECT jsonb_agg(jsonb_build_object('scopeKey',scope_key,'monthlyNanos',monthly_nanos::text,'rootNanos',root_nanos::text) ORDER BY scope_key) FROM app.ai_spend_budget WHERE tenant_id=app.current_tenant_id()),'[]'::jsonb),
 'heldNanos',coalesce((SELECT sum(reserved_nanos)::text FROM app.ai_spend_reservation WHERE tenant_id=app.current_tenant_id() AND state='held'),'0'),
 'confirmedNanos',(SELECT sum(confirmed_nanos)::text FROM app.ai_spend_reservation WHERE tenant_id=app.current_tenant_id() AND confirmed_nanos IS NOT NULL),
 'breached',EXISTS(SELECT 1 FROM app.ai_spend_reservation WHERE tenant_id=app.current_tenant_id() AND state='breach')) INTO result;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.ai_spend_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ai_spend_status() TO ai_hr_app;
