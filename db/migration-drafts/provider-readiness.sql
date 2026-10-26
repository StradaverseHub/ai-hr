-- Centrally reserved source-only: 0625_provider_readiness, journal idx 618, timestamp 1793023949848.
-- UNJOURNALED / UNAPPLIED. Supersedes surrendered AI0613-0620 reservations.
-- Preserve frozen0612 and human0620_onehr_panel_manager_anonymity (idx613/1793023949843).
-- Refresh canonical prefix and actual staging watermark before release-owner journal/application.
CREATE TABLE public.ai_provider_candidate (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
 provider text NOT NULL CHECK(provider='openrouter'), version_token uuid NOT NULL DEFAULT gen_random_uuid(),
 model text NOT NULL CHECK(length(model) BETWEEN 3 AND 200 AND model ~ '^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$' AND lower(model) !~ '^openrouter/'),
 api_key_ciphertext text NOT NULL, key_last4 text NOT NULL CHECK(length(key_last4) BETWEEN 1 AND 4),
 provider_options jsonb NOT NULL CHECK(app.ai_openrouter_options_valid(provider_options)),
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by_user_id uuid NOT NULL REFERENCES app_user(id),
 UNIQUE(tenant_id,provider)
);
--> statement-breakpoint
CREATE TABLE public.ai_provider_protocol_evaluation (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
 evaluated_by_user_id uuid NOT NULL REFERENCES app_user(id), candidate_id uuid NOT NULL REFERENCES ai_provider_candidate(id) ON DELETE CASCADE,
 candidate_version uuid NOT NULL, candidate_fingerprint text NOT NULL CHECK(candidate_fingerprint ~ '^[a-f0-9]{64}$'),
 principal_fingerprint text NOT NULL CHECK(principal_fingerprint ~ '^[a-f0-9]{64}$'),
 suite_version integer NOT NULL CHECK(suite_version=1), account_review_version integer NOT NULL CHECK(account_review_version=1),
 summary jsonb NOT NULL CHECK(jsonb_typeof(summary)='object' AND octet_length(summary::text)<=4096),
 issued_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '1 hour',
 consumed_at timestamptz, consumed_tx xid8, promoted_at timestamptz,
 CHECK(expires_at>issued_at AND expires_at<=issued_at+interval '1 hour'),
 CHECK((consumed_at IS NULL)=(consumed_tx IS NULL)), CHECK(promoted_at IS NULL OR consumed_at IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE public.ai_provider_candidate ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_provider_candidate FORCE ROW LEVEL SECURITY;
ALTER TABLE public.ai_provider_protocol_evaluation ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_provider_protocol_evaluation FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_provider_candidate,public.ai_provider_protocol_evaluation FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._ai_provider_evaluation_actor_valid() RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT app.current_tenant_id() IS NOT NULL AND app.current_user_id() IS NOT NULL
 AND current_setting('transaction_isolation')='read committed' AND app.is_group_admin()
 AND app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM app_user u JOIN tenant t ON t.id=u.tenant_id
 WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL
 AND NOT app.login_blocked(u.id) AND t.status IN('active','trial'))
$$;
REVOKE ALL ON FUNCTION app._ai_provider_evaluation_actor_valid() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.ai_provider_candidate_view_v1()
 RETURNS TABLE(id uuid,version_token uuid,provider text,model text,key_last4 text,provider_options jsonb,updated_at timestamptz)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT app._ai_provider_evaluation_actor_valid() THEN RAISE EXCEPTION 'AI candidate unavailable';END IF;
 RETURN QUERY SELECT c.id,c.version_token,c.provider,c.model,c.key_last4,c.provider_options,c.updated_at FROM ai_provider_candidate c
 WHERE c.tenant_id=app.current_tenant_id();
END $$;
--> statement-breakpoint
CREATE FUNCTION app.ai_provider_evaluation_candidate_v1(wanted_provider text)
 RETURNS TABLE(id uuid,version_token uuid,provider text,model text,api_key_ciphertext text,provider_options jsonb)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF wanted_provider IS DISTINCT FROM 'openrouter' OR NOT app._ai_provider_evaluation_actor_valid() THEN RAISE EXCEPTION 'AI candidate unavailable';END IF;
 RETURN QUERY SELECT c.id,c.version_token,c.provider,c.model,c.api_key_ciphertext,c.provider_options FROM ai_provider_candidate c
 WHERE c.tenant_id=app.current_tenant_id() AND c.provider=wanted_provider;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.ai_provider_candidate_save_v1(wanted_model text,wanted_ciphertext text,wanted_last4 text,wanted_options jsonb)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE cipher text;last4 text;rid uuid;
BEGIN
 IF NOT app._ai_provider_evaluation_actor_valid() OR wanted_model IS NULL OR NOT app.ai_openrouter_options_valid(wanted_options)
 THEN RAISE EXCEPTION 'AI candidate unavailable';END IF;
 IF wanted_ciphertext IS NOT NULL THEN cipher:=wanted_ciphertext;last4:=wanted_last4;
 ELSE
  SELECT c.api_key_ciphertext,c.key_last4 INTO cipher,last4 FROM ai_provider_candidate c
   WHERE c.tenant_id=app.current_tenant_id() AND c.provider='openrouter';
  IF cipher IS NULL THEN SELECT c.api_key_ciphertext,c.key_last4 INTO cipher,last4 FROM ai_provider_config c
   WHERE c.tenant_id=app.current_tenant_id() AND c.provider::text='openrouter';END IF;
 END IF;
 IF cipher IS NULL OR cipher='' OR length(cipher)>16384 OR last4 IS NULL THEN RAISE EXCEPTION 'AI candidate unavailable';END IF;
 INSERT INTO ai_provider_candidate(tenant_id,provider,model,api_key_ciphertext,key_last4,provider_options,updated_by_user_id)
 VALUES(app.current_tenant_id(),'openrouter',wanted_model,cipher,last4,wanted_options,app.current_user_id())
 ON CONFLICT(tenant_id,provider) DO UPDATE SET version_token=gen_random_uuid(),model=excluded.model,
 api_key_ciphertext=excluded.api_key_ciphertext,key_last4=excluded.key_last4,provider_options=excluded.provider_options,
 updated_at=now(),updated_by_user_id=app.current_user_id() RETURNING id INTO rid;
 RETURN rid;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.ai_provider_evaluation_record_v1(evaluation_id uuid,candidate uuid,candidate_version uuid,fingerprint text,principal text,metrics jsonb)
 RETURNS TABLE(issued_at timestamptz,expires_at timestamptz) LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c ai_provider_candidate;report ai_provider_protocol_evaluation;field text;value jsonb;
BEGIN
 IF NOT app._ai_provider_evaluation_actor_valid() OR jsonb_typeof(metrics)<>'object' OR octet_length(metrics::text)>4096
 OR metrics IS NULL OR (SELECT count(*) FROM jsonb_object_keys(metrics))<>7
 OR metrics->'calls' IS DISTINCT FROM '3'::jsonb OR metrics->'accountChargeCredits' IS DISTINCT FROM 'null'::jsonb
 OR (metrics-'calls'-'elapsedMs'-'usageReportedCalls'-'inputTokens'-'outputTokens'-'cachedInputTokens'-'accountChargeCredits')<>'{}'::jsonb
 THEN RAISE EXCEPTION 'AI evaluation unavailable';END IF;
 IF jsonb_typeof(metrics->'elapsedMs') IS DISTINCT FROM 'number' OR (metrics->>'elapsedMs') !~ '^[0-9]+$'
 OR (metrics->>'elapsedMs')::numeric>60000 OR jsonb_typeof(metrics->'usageReportedCalls') IS DISTINCT FROM 'number'
 OR (metrics->>'usageReportedCalls') !~ '^[0-3]$' THEN RAISE EXCEPTION 'AI evaluation unavailable';END IF;
 FOREACH field IN ARRAY ARRAY['inputTokens','outputTokens','cachedInputTokens'] LOOP
  value:=metrics->field;
  IF (metrics->>'usageReportedCalls')='3' THEN
   IF jsonb_typeof(value) IS DISTINCT FROM 'number' OR value::text !~ '^[0-9]+$' OR value::text::numeric>9007199254740991
   THEN RAISE EXCEPTION 'AI evaluation unavailable';END IF;
  ELSIF value IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'AI evaluation unavailable';END IF;
 END LOOP;
 SELECT * INTO c FROM ai_provider_candidate p WHERE p.id=candidate AND p.tenant_id=app.current_tenant_id() FOR SHARE;
 IF c.id IS NULL OR c.version_token IS DISTINCT FROM ai_provider_evaluation_record_v1.candidate_version THEN RAISE EXCEPTION 'AI evaluation unavailable';END IF;
 INSERT INTO ai_provider_protocol_evaluation(id,tenant_id,evaluated_by_user_id,candidate_id,candidate_version,
 candidate_fingerprint,principal_fingerprint,suite_version,account_review_version,summary)
 VALUES(evaluation_id,app.current_tenant_id(),app.current_user_id(),candidate,ai_provider_evaluation_record_v1.candidate_version,fingerprint,principal,1,1,metrics)
 RETURNING * INTO report;
 RETURN QUERY SELECT report.issued_at,report.expires_at;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.ai_provider_evaluation_consume_v1(evaluation_id uuid,fingerprint text,principal text)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE report ai_provider_protocol_evaluation;
BEGIN
 IF NOT app._ai_provider_evaluation_actor_valid() THEN RAISE EXCEPTION 'AI evaluation unavailable';END IF;
 SELECT * INTO report FROM ai_provider_protocol_evaluation e WHERE e.id=evaluation_id AND e.tenant_id=app.current_tenant_id()
 AND e.evaluated_by_user_id=app.current_user_id() FOR UPDATE NOWAIT;
 IF report.id IS NULL OR report.consumed_at IS NOT NULL OR report.expires_at<=now() OR report.issued_at>now()
 OR report.candidate_fingerprint IS DISTINCT FROM fingerprint OR report.principal_fingerprint IS DISTINCT FROM principal
 OR NOT EXISTS(SELECT 1 FROM ai_provider_candidate c WHERE c.id=report.candidate_id AND c.tenant_id=app.current_tenant_id()
 AND c.version_token=report.candidate_version) THEN RAISE EXCEPTION 'AI evaluation unavailable';END IF;
 UPDATE ai_provider_protocol_evaluation SET consumed_at=now(),consumed_tx=pg_current_xact_id() WHERE id=report.id;
 RETURN report.id;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.ai_provider_candidate_promote_v1(evaluation_id uuid)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE report ai_provider_protocol_evaluation;c ai_provider_candidate;rid uuid;
BEGIN
 IF NOT app._ai_provider_evaluation_actor_valid() THEN RAISE EXCEPTION 'AI evaluation unavailable';END IF;
 SELECT * INTO report FROM ai_provider_protocol_evaluation e WHERE e.id=evaluation_id AND e.tenant_id=app.current_tenant_id()
 AND e.evaluated_by_user_id=app.current_user_id() FOR UPDATE NOWAIT;
 IF report.id IS NULL OR report.consumed_tx IS DISTINCT FROM pg_current_xact_id() OR report.promoted_at IS NOT NULL
 OR report.expires_at<=now() THEN RAISE EXCEPTION 'AI evaluation unavailable';END IF;
 SELECT * INTO c FROM ai_provider_candidate p WHERE p.id=report.candidate_id AND p.tenant_id=app.current_tenant_id() FOR UPDATE NOWAIT;
 IF c.id IS NULL OR c.version_token IS DISTINCT FROM report.candidate_version THEN RAISE EXCEPTION 'AI evaluation unavailable';END IF;
 UPDATE ai_provider_config SET is_active=false WHERE tenant_id=app.current_tenant_id() AND is_active;
 INSERT INTO ai_provider_config(tenant_id,provider,model,api_key_ciphertext,key_last4,provider_options,is_active,created_by_user_id,updated_by_user_id)
 VALUES(app.current_tenant_id(),'openrouter'::ai_provider,c.model,c.api_key_ciphertext,c.key_last4,c.provider_options,true,app.current_user_id(),app.current_user_id())
 ON CONFLICT(tenant_id,provider) DO UPDATE SET model=excluded.model,api_key_ciphertext=excluded.api_key_ciphertext,key_last4=excluded.key_last4,
 provider_options=excluded.provider_options,is_active=true,updated_at=now(),updated_by_user_id=app.current_user_id() RETURNING id INTO rid;
 UPDATE ai_provider_protocol_evaluation SET promoted_at=now() WHERE id=report.id;
 RETURN rid;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.ai_provider_candidate_remove_v1() RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE rid uuid;
BEGIN
 IF NOT app._ai_provider_evaluation_actor_valid() THEN RAISE EXCEPTION 'AI candidate unavailable';END IF;
 DELETE FROM ai_provider_candidate WHERE tenant_id=app.current_tenant_id() AND provider='openrouter' RETURNING id INTO rid;
 RETURN rid;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.ai_provider_candidate_view_v1(),app.ai_provider_evaluation_candidate_v1(text),
 app.ai_provider_candidate_save_v1(text,text,text,jsonb),app.ai_provider_evaluation_record_v1(uuid,uuid,uuid,text,text,jsonb),
 app.ai_provider_evaluation_consume_v1(uuid,text,text),app.ai_provider_candidate_promote_v1(uuid),app.ai_provider_candidate_remove_v1() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ai_provider_candidate_view_v1(),app.ai_provider_evaluation_candidate_v1(text),
 app.ai_provider_candidate_save_v1(text,text,text,jsonb),app.ai_provider_evaluation_record_v1(uuid,uuid,uuid,text,text,jsonb),
 app.ai_provider_evaluation_consume_v1(uuid,text,text),app.ai_provider_candidate_promote_v1(uuid),app.ai_provider_candidate_remove_v1() TO ai_hr_app;

--> statement-breakpoint
-- Additive terminal accounting only. Historical rows stay NULL; no estimated price/backfill.
ALTER TABLE public.ai_model_run
 ADD COLUMN reported_input_tokens bigint,
 ADD COLUMN reported_output_tokens bigint,
 ADD COLUMN reported_cached_input_tokens bigint,
 ADD COLUMN openrouter_account_cost_credits numeric,
 ADD COLUMN observed_round_trip_ms double precision,
 ADD COLUMN provider_observation_status text;
--> statement-breakpoint
ALTER TABLE public.ai_model_run ADD CONSTRAINT ai_model_run_observation_fields CHECK(coalesce((
 (provider_observation_status IS NULL AND num_nonnulls(reported_input_tokens,reported_output_tokens,reported_cached_input_tokens,openrouter_account_cost_credits,observed_round_trip_ms)=0)
 OR (provider_observation_status IN ('missing','conflicting','invalid') AND num_nonnulls(reported_input_tokens,reported_output_tokens,reported_cached_input_tokens,openrouter_account_cost_credits,observed_round_trip_ms)=0)
 OR (provider_observation_status='reported' AND provider='openrouter'
  AND num_nonnulls(reported_input_tokens,reported_output_tokens,reported_cached_input_tokens) IN (0,3)
  AND (reported_input_tokens IS NULL OR (reported_input_tokens BETWEEN 0 AND 1000000000 AND reported_output_tokens BETWEEN 0 AND 1000000000 AND reported_cached_input_tokens BETWEEN 0 AND 1000000000 AND reported_input_tokens+reported_output_tokens+reported_cached_input_tokens<=1000000000 AND actual_tokens IS NOT DISTINCT FROM reported_input_tokens+reported_output_tokens+reported_cached_input_tokens))
  AND (openrouter_account_cost_credits IS NULL OR (openrouter_account_cost_credits>=0 AND openrouter_account_cost_credits<'Infinity'::numeric))
  AND (observed_round_trip_ms IS NULL OR (observed_round_trip_ms>=0 AND observed_round_trip_ms<'Infinity'::double precision)))
),false));
--> statement-breakpoint
-- Same pending-run/current-tenant/current-user owner and lock order as historical app.ai_settle.
-- The trusted server adapter owns response provenance; this SQL never certifies provider capability.
CREATE FUNCTION app.ai_settle_observed(wanted_run uuid,succeeded boolean,tokens bigint,observation_status text,
 input_count bigint,output_count bigint,cached_count bigint,account_credits numeric,round_trip_ms double precision)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actual_provider text;
BEGIN
 IF observation_status IS NULL OR observation_status NOT IN ('missing','reported','conflicting','invalid')
  OR (observation_status<>'reported' AND num_nonnulls(input_count,output_count,cached_count,account_credits,round_trip_ms)<>0)
  OR num_nonnulls(input_count,output_count,cached_count) NOT IN (0,3)
  OR (input_count IS NOT NULL AND (input_count NOT BETWEEN 0 AND 1000000000 OR output_count NOT BETWEEN 0 AND 1000000000 OR cached_count NOT BETWEEN 0 AND 1000000000 OR input_count+output_count+cached_count>1000000000 OR tokens IS DISTINCT FROM input_count+output_count+cached_count))
  OR (account_credits IS NOT NULL AND NOT(account_credits>=0 AND account_credits<'Infinity'::numeric))
  OR (round_trip_ms IS NOT NULL AND NOT(round_trip_ms>=0 AND round_trip_ms<'Infinity'::double precision))
 THEN RAISE EXCEPTION 'Invalid AI accounting observation'; END IF;
 PERFORM pg_advisory_xact_lock(hashtext('ai-control'),hashtext(app.current_tenant_id()::text));
 SELECT r.provider INTO actual_provider FROM public.ai_model_run r
 WHERE r.id=wanted_run AND r.tenant_id=app.current_tenant_id() AND r.user_id IS NOT DISTINCT FROM app.current_user_id() AND r.state='pending'
 FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'AI request not found'; END IF;
 IF observation_status='reported' AND actual_provider<>'openrouter' THEN RAISE EXCEPTION 'Invalid AI accounting observation'; END IF;
 PERFORM app.ai_settle(wanted_run,succeeded,tokens);
 UPDATE public.ai_model_run SET reported_input_tokens=input_count,reported_output_tokens=output_count,
  reported_cached_input_tokens=cached_count,openrouter_account_cost_credits=account_credits,
  observed_round_trip_ms=round_trip_ms,provider_observation_status=observation_status
 WHERE id=wanted_run AND tenant_id=app.current_tenant_id() AND user_id IS NOT DISTINCT FROM app.current_user_id();
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.ai_settle_observed(uuid,boolean,bigint,text,bigint,bigint,bigint,numeric,double precision) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ai_settle_observed(uuid,boolean,bigint,text,bigint,bigint,bigint,numeric,double precision) TO ai_hr_app;
