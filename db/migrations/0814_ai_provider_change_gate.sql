-- 0694 — WP14 / R19 of the October 2026 AI architecture review (reserved by the AI programme: when 1793330000020).
-- 1. Per-feature caps. A feature row of ai_control_policy may now hold daily_requests and monthly_tokens like any
--    other scope (0541 and 0662 forced them to NULL). ai_admit (live definition 0678) already counts a feature row
--    against every run of that feature in the tenant, and the 0541 write policy already admits feature rows only for
--    a group administrator, so neither changes here. The constraint is replaced, never edited in place.
-- 2. A provider or model change is a release. A direct-provider change (Anthropic, OpenAI, Google, AI gateway) is
--    stored PENDING in ai_provider_pending_config; the gateway never reads it. A group administrator runs the fixed
--    baseline holdout suites against the pending configuration (feature provider_evaluation, that administrator's own
--    allowances, rooted on the run row), and activation is refused until the run has passed or a group administrator
--    has accepted a failure with a recorded reason. OpenRouter keeps its existing candidate table and receipt, and
--    its promotion additionally checks the same baseline gate. The platform default (environment key and
--    AI_DRAFT_MODEL) is recorded by fingerprint so AI management can say when it has not been re-evaluated.
ALTER TABLE ai_control_policy DROP CONSTRAINT ai_control_policy_check;
--> statement-breakpoint
ALTER TABLE ai_control_policy ADD CONSTRAINT ai_control_policy_check CHECK(
 (kind='feature' AND subject_id IS NULL AND feature_id IS NOT NULL AND scope_key='feature:'||feature_id)
 OR(kind IN ('company','user') AND subject_id IS NOT NULL AND feature_id IS NULL AND scope_key=kind||':'||subject_id::text)
 OR(kind='user_default' AND subject_id IS NULL AND feature_id IS NULL AND scope_key='user_default')
 OR(kind='group_role' AND subject_id IS NULL AND feature_id IS NULL
  AND scope_key IN ('group_role:employee','group_role:manager','group_role:hr_admin','group_role:super_admin','group_role:payroll_partner','group_role:performance_comp_partner','group_role:performance_partner'))
 OR(kind IN ('group_company','group_department') AND subject_id IS NOT NULL AND feature_id IS NULL AND scope_key=kind||':'||subject_id::text));
--> statement-breakpoint
CREATE TABLE public.ai_provider_pending_config (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
 provider text NOT NULL CHECK(provider IN ('anthropic','openai','google','ai_gateway')),
 version_token uuid NOT NULL DEFAULT gen_random_uuid(),
 model text NOT NULL CHECK(length(model) BETWEEN 1 AND 200 AND model=btrim(model)),
 api_key_ciphertext text NOT NULL CHECK(length(api_key_ciphertext) BETWEEN 1 AND 16384),
 key_last4 text NOT NULL CHECK(length(key_last4) BETWEEN 1 AND 4),
 provider_options jsonb NOT NULL CHECK(CASE WHEN provider='ai_gateway' THEN app.ai_gateway_options_valid(provider_options) ELSE provider_options='{}'::jsonb END),
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by_user_id uuid NOT NULL REFERENCES app_user(id),
 UNIQUE(tenant_id,provider)
);
--> statement-breakpoint
-- History of baseline runs. No FK to the pending row: a run stays as evidence after its change is activated or discarded.
CREATE TABLE public.ai_provider_baseline_run (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
 target_kind text NOT NULL CHECK(target_kind IN ('pending','openrouter_candidate','environment')),
 target_id uuid, target_version uuid,
 provider text NOT NULL CHECK(provider IN ('anthropic','openai','google','openrouter','ai_gateway')),
 model text NOT NULL CHECK(length(model) BETWEEN 1 AND 200),
 config_fingerprint text NOT NULL CHECK(config_fingerprint ~ '^[a-f0-9]{64}$'),
 suite_digest text NOT NULL CHECK(suite_digest ~ '^[a-f0-9]{64}$'),
 state text NOT NULL DEFAULT 'evaluating' CHECK(state IN ('evaluating','passed','failed','accepted')),
 suites jsonb NOT NULL CHECK(jsonb_typeof(suites)='object' AND octet_length(suites::text)<=4096),
 started_by_user_id uuid NOT NULL REFERENCES app_user(id), started_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 accepted_by_user_id uuid REFERENCES app_user(id), accepted_reason text, accepted_at timestamptz,
 CHECK((target_kind='environment')=(target_id IS NULL AND target_version IS NULL)),
 CHECK(target_kind='environment' OR(target_id IS NOT NULL AND target_version IS NOT NULL)),
 CHECK((state='accepted')=(accepted_by_user_id IS NOT NULL AND accepted_at IS NOT NULL AND accepted_reason IS NOT NULL)),
 CHECK(accepted_reason IS NULL OR length(btrim(accepted_reason)) BETWEEN 10 AND 1000)
);
--> statement-breakpoint
CREATE INDEX ai_provider_baseline_run_target ON public.ai_provider_baseline_run(tenant_id,target_kind,target_id,target_version,updated_at DESC);
--> statement-breakpoint
CREATE INDEX ai_provider_baseline_run_fingerprint ON public.ai_provider_baseline_run(tenant_id,config_fingerprint,updated_at DESC);
--> statement-breakpoint
ALTER TABLE public.ai_provider_pending_config ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.ai_provider_pending_config FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.ai_provider_baseline_run ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.ai_provider_baseline_run FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON public.ai_provider_pending_config,public.ai_provider_baseline_run FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Run history carries no secret: group administrators of the current tenant read it directly. Every write goes
-- through the SECURITY DEFINER functions below.
GRANT SELECT ON public.ai_provider_baseline_run TO ai_hr_app;
--> statement-breakpoint
CREATE POLICY ai_provider_baseline_run_read ON public.ai_provider_baseline_run FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.is_group_admin());
--> statement-breakpoint
-- The installation owner is not BYPASSRLS (0686): only the owner executing these issuers, for a freshly
-- authorised group administrator in the current tenant, may use the rows.
CREATE POLICY ai_provider_pending_config_owner_custody ON public.ai_provider_pending_config
 FOR ALL TO PUBLIC
 USING (
  current_user=pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid='public.ai_provider_pending_config'::regclass))
  AND tenant_id=app.current_tenant_id() AND app._ai_provider_evaluation_actor_valid()
 )
 WITH CHECK (
  current_user=pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid='public.ai_provider_pending_config'::regclass))
  AND tenant_id=app.current_tenant_id() AND app._ai_provider_evaluation_actor_valid()
 );
--> statement-breakpoint
-- The application role may SELECT this table, so its policies are planned for that role too: use only functions the
-- role may execute. Every writer below re-checks app._ai_provider_evaluation_actor_valid() itself.
CREATE POLICY ai_provider_baseline_run_owner_custody ON public.ai_provider_baseline_run
 FOR ALL TO PUBLIC
 USING (
  current_user=pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid='public.ai_provider_baseline_run'::regclass))
  AND tenant_id=app.current_tenant_id() AND app.is_group_admin()
 )
 WITH CHECK (
  current_user=pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid='public.ai_provider_baseline_run'::regclass))
  AND tenant_id=app.current_tenant_id() AND app.is_group_admin()
 );
--> statement-breakpoint
-- The live row remembers the passed or accepted run that admitted it. Any later in-place change of provider, model,
-- key or options that does not name a new run clears it, so AI management can flag a configuration whose exact
-- current version was never baseline-evaluated (including every configuration activated before this migration).
-- Display evidence only: it never blocks the active configuration from serving. No FK: run history outlives rows.
ALTER TABLE public.ai_provider_config ADD COLUMN baseline_run_id uuid;
--> statement-breakpoint
GRANT SELECT (baseline_run_id) ON public.ai_provider_config TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.ai_provider_config_baseline_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.baseline_run_id IS NOT DISTINCT FROM OLD.baseline_run_id AND (NEW.provider IS DISTINCT FROM OLD.provider OR NEW.model IS DISTINCT FROM OLD.model
  OR NEW.api_key_ciphertext IS DISTINCT FROM OLD.api_key_ciphertext OR NEW.provider_options IS DISTINCT FROM OLD.provider_options)
 THEN NEW.baseline_run_id:=NULL;END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.ai_provider_config_baseline_guard() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE TRIGGER ai_provider_config_baseline_guard BEFORE UPDATE ON public.ai_provider_config FOR EACH ROW EXECUTE FUNCTION app.ai_provider_config_baseline_guard();
--> statement-breakpoint
-- Progress is {"<suite>":{"total":n,"passed":p,"failed":f,"next":x}}, with passed+failed=next<=total. The state is
-- DERIVED here, never posted: failed if any case failed, passed once every suite is complete, else evaluating.
CREATE FUNCTION app._ai_provider_baseline_state(progress jsonb) RETURNS text
 LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE suite text;counts jsonb;complete boolean:=true;failing boolean:=false;field text;
BEGIN
 IF progress IS NULL OR jsonb_typeof(progress)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(progress)) NOT BETWEEN 1 AND 8 THEN RETURN NULL;END IF;
 FOR suite,counts IN SELECT e.key,e.value FROM jsonb_each(progress) e LOOP
  IF suite !~ '^[a-z][a-z_]{0,39}$' OR jsonb_typeof(counts)<>'object'
   OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(counts) k)<>ARRAY['failed','next','passed','total']::text[] THEN RETURN NULL;END IF;
  FOREACH field IN ARRAY ARRAY['failed','next','passed','total'] LOOP
   IF jsonb_typeof(counts->field)<>'number' OR (counts->>field) !~ '^[0-9]{1,6}$' THEN RETURN NULL;END IF;
  END LOOP;
  IF (counts->>'total')::int<1 OR (counts->>'next')::int>(counts->>'total')::int
   OR (counts->>'passed')::int+(counts->>'failed')::int<>(counts->>'next')::int THEN RETURN NULL;END IF;
  IF (counts->>'failed')::int>0 THEN failing:=true;END IF;
  IF (counts->>'next')::int<(counts->>'total')::int THEN complete:=false;END IF;
 END LOOP;
 RETURN CASE WHEN failing THEN 'failed' WHEN complete THEN 'passed' ELSE 'evaluating' END;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app._ai_provider_baseline_state(jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- A run counts only for the exact current version of its target (a re-save mints a new version token).
CREATE FUNCTION app._ai_provider_baseline_target_current(wanted_kind text,wanted_target uuid,wanted_version uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT CASE wanted_kind
  WHEN 'pending' THEN EXISTS(SELECT 1 FROM ai_provider_pending_config p WHERE p.id=wanted_target AND p.tenant_id=app.current_tenant_id() AND p.version_token=wanted_version)
  WHEN 'openrouter_candidate' THEN EXISTS(SELECT 1 FROM ai_provider_candidate c WHERE c.id=wanted_target AND c.tenant_id=app.current_tenant_id() AND c.version_token=wanted_version)
  WHEN 'environment' THEN wanted_target IS NULL AND wanted_version IS NULL
  ELSE false END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app._ai_provider_baseline_target_current(text,uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.ai_provider_pending_view_v1()
 RETURNS TABLE(id uuid,version_token uuid,provider text,model text,key_last4 text,provider_options jsonb,updated_at timestamptz)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT app._ai_provider_evaluation_actor_valid() THEN RAISE EXCEPTION 'AI pending change unavailable';END IF;
 RETURN QUERY SELECT p.id,p.version_token,p.provider,p.model,p.key_last4,p.provider_options,p.updated_at FROM ai_provider_pending_config p
 WHERE p.tenant_id=app.current_tenant_id() ORDER BY p.provider;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.ai_provider_pending_resolve_v1(wanted_provider text)
 RETURNS TABLE(id uuid,version_token uuid,provider text,model text,api_key_ciphertext text,provider_options jsonb)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT app._ai_provider_evaluation_actor_valid() OR wanted_provider IS NULL THEN RAISE EXCEPTION 'AI pending change unavailable';END IF;
 RETURN QUERY SELECT p.id,p.version_token,p.provider,p.model,p.api_key_ciphertext,p.provider_options FROM ai_provider_pending_config p
 WHERE p.tenant_id=app.current_tenant_id() AND p.provider=wanted_provider;
END $$;
--> statement-breakpoint
-- Omitting the key keeps the pending key, else the stored key of that provider. The live row is never touched.
CREATE FUNCTION app.ai_provider_pending_save_v1(wanted_provider text,wanted_model text,wanted_ciphertext text,wanted_last4 text,wanted_options jsonb)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE cipher text;last4 text;rid uuid;
BEGIN
 IF NOT app._ai_provider_evaluation_actor_valid() OR wanted_provider IS NULL OR wanted_provider NOT IN ('anthropic','openai','google','ai_gateway')
 OR wanted_model IS NULL OR wanted_options IS NULL THEN RAISE EXCEPTION 'AI pending change unavailable';END IF;
 IF wanted_ciphertext IS NOT NULL THEN cipher:=wanted_ciphertext;last4:=wanted_last4;
 ELSE
  SELECT x.api_key_ciphertext,x.key_last4 INTO cipher,last4 FROM ai_provider_pending_config x
   WHERE x.tenant_id=app.current_tenant_id() AND x.provider=wanted_provider;
  IF cipher IS NULL THEN SELECT c.api_key_ciphertext,c.key_last4 INTO cipher,last4 FROM ai_provider_config c
   WHERE c.tenant_id=app.current_tenant_id() AND c.provider::text=wanted_provider;END IF;
 END IF;
 IF cipher IS NULL OR cipher='' OR length(cipher)>16384 OR last4 IS NULL THEN RAISE EXCEPTION 'AI pending change unavailable';END IF;
 INSERT INTO ai_provider_pending_config(tenant_id,provider,model,api_key_ciphertext,key_last4,provider_options,updated_by_user_id)
 VALUES(app.current_tenant_id(),wanted_provider,wanted_model,cipher,last4,wanted_options,app.current_user_id())
 ON CONFLICT(tenant_id,provider) DO UPDATE SET version_token=gen_random_uuid(),model=excluded.model,api_key_ciphertext=excluded.api_key_ciphertext,
 key_last4=excluded.key_last4,provider_options=excluded.provider_options,updated_at=now(),updated_by_user_id=app.current_user_id() RETURNING ai_provider_pending_config.id INTO rid;
 RETURN rid;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.ai_provider_pending_remove_v1(wanted_provider text) RETURNS uuid
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE rid uuid;
BEGIN
 IF NOT app._ai_provider_evaluation_actor_valid() OR wanted_provider IS NULL THEN RAISE EXCEPTION 'AI pending change unavailable';END IF;
 DELETE FROM ai_provider_pending_config x WHERE x.tenant_id=app.current_tenant_id() AND x.provider=wanted_provider RETURNING x.id INTO rid;
 RETURN rid;
END $$;
--> statement-breakpoint
-- A run starts with every suite at zero, for a target version that exists now. The environment target is offered
-- only while the tenant has no active configuration of its own (it is then the configuration in use).
CREATE FUNCTION app.ai_provider_baseline_start_v1(wanted_kind text,wanted_target uuid,wanted_version uuid,wanted_provider text,wanted_model text,
 fingerprint text,wanted_suite text,initial jsonb) RETURNS uuid
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE rid uuid;
BEGIN
 IF NOT app._ai_provider_evaluation_actor_valid() OR app._ai_provider_baseline_state(initial) IS DISTINCT FROM 'evaluating'
 OR EXISTS(SELECT 1 FROM jsonb_each(initial) e WHERE (e.value->>'next')::int<>0)
 OR NOT app._ai_provider_baseline_target_current(wanted_kind,wanted_target,wanted_version) THEN RAISE EXCEPTION 'AI baseline unavailable';END IF;
 IF wanted_kind='pending' AND NOT EXISTS(SELECT 1 FROM ai_provider_pending_config p WHERE p.id=wanted_target AND p.tenant_id=app.current_tenant_id()
  AND p.provider=wanted_provider AND p.model=wanted_model) THEN RAISE EXCEPTION 'AI baseline unavailable';END IF;
 IF wanted_kind='openrouter_candidate' AND NOT EXISTS(SELECT 1 FROM ai_provider_candidate c WHERE c.id=wanted_target AND c.tenant_id=app.current_tenant_id()
  AND c.provider=wanted_provider AND c.model=wanted_model) THEN RAISE EXCEPTION 'AI baseline unavailable';END IF;
 IF wanted_kind='environment' AND EXISTS(SELECT 1 FROM ai_provider_config c WHERE c.tenant_id=app.current_tenant_id() AND c.is_active)
 THEN RAISE EXCEPTION 'AI baseline unavailable';END IF;
 INSERT INTO ai_provider_baseline_run(tenant_id,target_kind,target_id,target_version,provider,model,config_fingerprint,suite_digest,suites,started_by_user_id)
 VALUES(app.current_tenant_id(),wanted_kind,wanted_target,wanted_version,wanted_provider,wanted_model,fingerprint,wanted_suite,initial,app.current_user_id())
 RETURNING ai_provider_baseline_run.id INTO rid;
 RETURN rid;
END $$;
--> statement-breakpoint
-- Only the administrator who started a run records its progress. Counts only move forward; the state is derived.
CREATE FUNCTION app.ai_provider_baseline_record_v1(wanted_run uuid,progress jsonb) RETURNS text
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r ai_provider_baseline_run;derived text;suite text;counts jsonb;earlier jsonb;
BEGIN
 IF NOT app._ai_provider_evaluation_actor_valid() THEN RAISE EXCEPTION 'AI baseline unavailable';END IF;
 SELECT * INTO r FROM ai_provider_baseline_run x WHERE x.id=wanted_run AND x.tenant_id=app.current_tenant_id() FOR UPDATE;
 IF r.id IS NULL OR r.state<>'evaluating' OR r.started_by_user_id IS DISTINCT FROM app.current_user_id() THEN RAISE EXCEPTION 'AI baseline unavailable';END IF;
 derived:=app._ai_provider_baseline_state(progress);
 IF derived IS NULL OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(progress) k) IS DISTINCT FROM (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(r.suites) k)
 THEN RAISE EXCEPTION 'AI baseline unavailable';END IF;
 FOR suite,counts IN SELECT e.key,e.value FROM jsonb_each(progress) e LOOP
  earlier:=r.suites->suite;
  IF (counts->>'total')::int<>(earlier->>'total')::int OR (counts->>'next')::int<(earlier->>'next')::int
   OR (counts->>'passed')::int<(earlier->>'passed')::int OR (counts->>'failed')::int<(earlier->>'failed')::int THEN RAISE EXCEPTION 'AI baseline unavailable';END IF;
 END LOOP;
 UPDATE ai_provider_baseline_run SET suites=progress,state=derived,updated_at=now() WHERE id=r.id;
 RETURN derived;
END $$;
--> statement-breakpoint
-- A group administrator may accept a failed or unfinished run of the CURRENT target version, with a reason.
CREATE FUNCTION app.ai_provider_baseline_accept_v1(wanted_run uuid,reason text) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r ai_provider_baseline_run;
BEGIN
 IF NOT app._ai_provider_evaluation_actor_valid() OR reason IS NULL OR length(btrim(reason)) NOT BETWEEN 10 AND 1000 THEN RAISE EXCEPTION 'AI baseline unavailable';END IF;
 SELECT * INTO r FROM ai_provider_baseline_run x WHERE x.id=wanted_run AND x.tenant_id=app.current_tenant_id() FOR UPDATE;
 IF r.id IS NULL OR r.state NOT IN ('failed','evaluating') OR NOT app._ai_provider_baseline_target_current(r.target_kind,r.target_id,r.target_version)
 THEN RAISE EXCEPTION 'AI baseline unavailable';END IF;
 UPDATE ai_provider_baseline_run SET state='accepted',accepted_by_user_id=app.current_user_id(),accepted_reason=btrim(reason),accepted_at=now(),updated_at=now() WHERE id=r.id;
END $$;
--> statement-breakpoint
-- The passed or accepted run that admits this exact target version, or NULL.
CREATE FUNCTION app.ai_provider_baseline_gate_v1(wanted_kind text,wanted_target uuid,wanted_version uuid,wanted_suite text) RETURNS uuid
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE rid uuid;
BEGIN
 IF NOT app._ai_provider_evaluation_actor_valid() THEN RAISE EXCEPTION 'AI baseline unavailable';END IF;
 IF NOT app._ai_provider_baseline_target_current(wanted_kind,wanted_target,wanted_version) THEN RETURN NULL;END IF;
 SELECT x.id INTO rid FROM ai_provider_baseline_run x WHERE x.tenant_id=app.current_tenant_id() AND x.target_kind=wanted_kind
  AND x.target_id IS NOT DISTINCT FROM wanted_target AND x.target_version IS NOT DISTINCT FROM wanted_version
  AND x.suite_digest=wanted_suite AND x.state IN ('passed','accepted') ORDER BY x.updated_at DESC,x.id LIMIT 1;
 RETURN rid;
END $$;
--> statement-breakpoint
-- Promotion of a pending change: the gate, the single-active switch, the live row and removal of the pending row
-- happen in one transaction. A changed version, a missing run or a failed run refuses everything.
CREATE FUNCTION app.ai_provider_pending_activate_v1(wanted_pending uuid,wanted_version uuid,wanted_suite text)
 RETURNS TABLE(config_id uuid,baseline_run_id uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p ai_provider_pending_config;rid uuid;cid uuid;
BEGIN
 IF NOT app._ai_provider_evaluation_actor_valid() THEN RAISE EXCEPTION 'AI pending change unavailable';END IF;
 SELECT * INTO p FROM ai_provider_pending_config x WHERE x.id=wanted_pending AND x.tenant_id=app.current_tenant_id() FOR UPDATE;
 IF p.id IS NULL OR p.version_token IS DISTINCT FROM wanted_version THEN RAISE EXCEPTION 'AI pending change unavailable';END IF;
 rid:=app.ai_provider_baseline_gate_v1('pending',p.id,p.version_token,wanted_suite);
 IF rid IS NULL THEN RAISE EXCEPTION 'AI baseline required';END IF;
 UPDATE ai_provider_config c SET is_active=false WHERE c.tenant_id=p.tenant_id AND c.is_active;
 INSERT INTO ai_provider_config(tenant_id,provider,model,api_key_ciphertext,key_last4,provider_options,is_active,created_by_user_id,updated_by_user_id,baseline_run_id)
 VALUES(p.tenant_id,p.provider::ai_provider,p.model,p.api_key_ciphertext,p.key_last4,p.provider_options,true,app.current_user_id(),app.current_user_id(),rid)
 ON CONFLICT(tenant_id,provider) DO UPDATE SET model=excluded.model,api_key_ciphertext=excluded.api_key_ciphertext,key_last4=excluded.key_last4,
 provider_options=excluded.provider_options,is_active=true,updated_at=now(),updated_by_user_id=app.current_user_id(),baseline_run_id=excluded.baseline_run_id RETURNING ai_provider_config.id INTO cid;
 DELETE FROM ai_provider_pending_config x WHERE x.id=p.id;
 RETURN QUERY SELECT cid,rid;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.ai_provider_pending_view_v1(),app.ai_provider_pending_resolve_v1(text),
 app.ai_provider_pending_save_v1(text,text,text,text,jsonb),app.ai_provider_pending_remove_v1(text),
 app.ai_provider_baseline_start_v1(text,uuid,uuid,text,text,text,text,jsonb),app.ai_provider_baseline_record_v1(uuid,jsonb),
 app.ai_provider_baseline_accept_v1(uuid,text),app.ai_provider_baseline_gate_v1(text,uuid,uuid,text),
 app.ai_provider_pending_activate_v1(uuid,uuid,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.ai_provider_pending_view_v1(),app.ai_provider_pending_resolve_v1(text),
 app.ai_provider_pending_save_v1(text,text,text,text,jsonb),app.ai_provider_pending_remove_v1(text),
 app.ai_provider_baseline_start_v1(text,uuid,uuid,text,text,text,text,jsonb),app.ai_provider_baseline_record_v1(uuid,jsonb),
 app.ai_provider_baseline_accept_v1(uuid,text),app.ai_provider_baseline_gate_v1(text,uuid,uuid,text),
 app.ai_provider_pending_activate_v1(uuid,uuid,text) TO ai_hr_app;
--> statement-breakpoint
-- Same signature and clauses as 0654, plus one root: an unfinished baseline run started by this group administrator.
CREATE OR REPLACE FUNCTION app._ai_optional_root_allowed(wanted_root uuid,wanted_feature text,wanted_kind text)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT wanted_root IS NOT NULL AND wanted_kind IN('agent','evaluation') AND(
 (wanted_feature='provider_evaluation' AND EXISTS(SELECT 1 FROM ai_provider_candidate x WHERE x.id=wanted_root AND x.tenant_id=app.current_tenant_id() AND app._ai_provider_evaluation_actor_valid())) OR
 (wanted_feature='provider_evaluation' AND wanted_kind='evaluation' AND EXISTS(SELECT 1 FROM ai_provider_baseline_run x WHERE x.id=wanted_root AND x.tenant_id=app.current_tenant_id()
  AND x.state='evaluating' AND x.started_by_user_id=app.current_user_id() AND app._ai_provider_evaluation_actor_valid())) OR
 (wanted_feature IN('module_agent_evaluation','module_agent_planning') AND EXISTS(SELECT 1 FROM ai_agent_candidate x WHERE x.id=wanted_root AND x.tenant_id=app.current_tenant_id() AND(x.owner_user_id=app.current_user_id() OR app.is_group_admin()))) OR
 app._ai_spend_task_root_current(wanted_root,wanted_feature,wanted_kind))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app._ai_optional_root_allowed(uuid,text,text) FROM PUBLIC,ai_hr_app;
