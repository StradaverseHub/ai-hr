-- UNALLOCATED / UNJOURNALED / UNAPPLIED. Apply AFTER ai-spend-allocation.sql.
-- Dedicated purpose key is operator-provisioned in private verifier store + server environment only.
-- No source secret/key/capability seed, automatic provisioning, provider activation or live request.
-- Standard pgcrypto HMAC-SHA256 interoperates with node:crypto on Node20/22. Shadow installation
-- must verify the extension is available to the normal migration owner before any release claim.
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;
DO $$BEGIN IF to_regprocedure('public.hmac(bytea,bytea,text)') IS NULL OR to_regprocedure('public.digest(bytea,text)') IS NULL THEN RAISE EXCEPTION 'Spend receipt verification requires supported pgcrypto schema';END IF;END$$;
--> statement-breakpoint
CREATE TABLE app.ai_spend_receipt_verifier(
 key_id text PRIMARY KEY CHECK(key_id~'^[A-Za-z0-9_-]{1,64}$'),secret bytea NOT NULL CHECK(octet_length(secret)=32),
 enabled boolean NOT NULL DEFAULT true,valid_from timestamptz NOT NULL DEFAULT now(),retired_at timestamptz CHECK(retired_at IS NULL OR retired_at>valid_from)
);
ALTER TABLE app.ai_spend_receipt_verifier ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.ai_spend_receipt_verifier FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
ALTER TABLE app.ai_spend_reservation ADD COLUMN configuration_digest text NOT NULL CHECK(configuration_digest~'^[a-f0-9]{64}$'),
 ADD COLUMN generation_id text CHECK(generation_id~'^gen-[A-Za-z0-9_-]{1,240}$'),ADD COLUMN receipt_digest text CHECK(receipt_digest~'^[a-f0-9]{64}$');
CREATE UNIQUE INDEX ai_spend_generation_once ON app.ai_spend_reservation(generation_id) WHERE generation_id IS NOT NULL;
--> statement-breakpoint
DROP FUNCTION app.ai_spend_reserve(uuid,uuid,text,text,text,bigint);
CREATE FUNCTION app.ai_spend_reserve(wanted_run uuid,wanted_root uuid,wanted_kind text,wanted_capability text,wanted_request text,wanted_nanos bigint,wanted_configuration text)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE tid uuid:=app.current_tenant_id();uid uuid:=app.current_user_id();r ai_model_run;c app.ai_spend_capability;p app.ai_spend_budget;
 used numeric;root_used numeric;month_start timestamptz:=date_trunc('month',now() AT TIME ZONE 'Asia/Kuala_Lumpur') AT TIME ZONE 'Asia/Kuala_Lumpur';
BEGIN
 PERFORM app._ai_spend_bounds();
 IF tid IS NULL OR uid IS NULL OR wanted_kind NOT IN('agent','evaluation') OR wanted_root IS NULL OR wanted_request!~'^[a-f0-9]{64}$' OR wanted_nanos IS NULL OR wanted_nanos<=0 OR wanted_configuration IS NULL OR wanted_configuration!~'^[a-f0-9]{64}$'
 OR current_setting('transaction_isolation')<>'read committed' OR current_setting('transaction_read_only')<>'off' THEN RAISE EXCEPTION 'AI spend allocation unavailable';END IF;
 PERFORM pg_advisory_xact_lock(hashtext('ai-control'),hashtext(tid::text));
 IF NOT EXISTS(SELECT 1 FROM app_user u WHERE u.id=uid AND u.tenant_id=tid AND u.archived_at IS NULL AND NOT app.login_blocked(uid)) THEN RAISE EXCEPTION 'AI spend allocation unavailable';END IF;
 SELECT * INTO r FROM ai_model_run WHERE id=wanted_run AND tenant_id=tid AND user_id=uid FOR UPDATE NOWAIT;
 IF NOT FOUND OR r.state<>'pending' OR NOT EXISTS(SELECT 1 FROM ai_model_run fresh WHERE fresh.id=r.id AND fresh.xmin=pg_current_xact_id()::xid) THEN RAISE EXCEPTION 'AI spend allocation requires this admission';END IF;
 -- A native persisted candidate is nominated, not a random browser UUID. Current native/source
 -- authorization remains the trusted source callback; independent evaluators share the SAME root.
 IF NOT EXISTS(SELECT 1 FROM ai_provider_candidate x WHERE x.id=wanted_root AND x.tenant_id=tid AND app._ai_provider_evaluation_actor_valid())
 AND NOT EXISTS(SELECT 1 FROM ai_agent_candidate x WHERE x.id=wanted_root AND x.tenant_id=tid AND(x.owner_user_id=uid OR app.is_group_admin())) THEN RAISE EXCEPTION 'AI spend root unavailable';END IF;
 SELECT * INTO c FROM app.ai_spend_capability WHERE digest=wanted_capability AND provider=r.provider AND model=r.model AND operation=r.operation AND revoked_at IS NULL AND verified_at<=now() AND expires_at>now();
 IF NOT FOUND OR c.max_request_nanos<>wanted_nanos THEN RAISE EXCEPTION 'AI spend ceiling unavailable';END IF;
 IF EXISTS(SELECT 1 FROM app.ai_spend_reservation WHERE run_id=wanted_run) THEN RAISE EXCEPTION 'AI spend already reserved';END IF;
 IF NOT EXISTS(SELECT 1 FROM app.ai_spend_budget WHERE tenant_id=tid AND kind='tenant') THEN RAISE EXCEPTION 'AI spend budget missing';END IF;
 IF EXISTS(SELECT 1 FROM app.ai_spend_reservation WHERE tenant_id=tid AND state='breach') THEN RAISE EXCEPTION 'AI spend ceiling breach requires review';END IF;
 INSERT INTO app.ai_spend_root(tenant_id,root_id,kind) VALUES(tid,wanted_root,wanted_kind) ON CONFLICT DO NOTHING;
 -- kind records the initial use only. Evaluation and an agent using the SAME persisted
 -- candidate share this root, rather than changing purpose to mint another lifetime allowance.
 FOR p IN SELECT * FROM app.ai_spend_budget WHERE tenant_id=tid AND(kind='tenant' OR(kind='user' AND subject_id=uid) OR(kind='company' AND subject_id=ANY(r.company_ids)) OR(kind='feature' AND feature_id=r.feature_id)) ORDER BY scope_key LOOP
  -- Unknown exposure survives month rollover and process death; no TTL or success flag releases it.
  SELECT coalesce(sum(CASE WHEN state='held' THEN reserved_nanos ELSE confirmed_nanos END),0) INTO used FROM app.ai_spend_reservation x WHERE x.tenant_id=tid AND(x.state='held' OR x.created_at>=month_start)
   AND(p.kind='tenant' OR(p.kind='user' AND x.user_id=uid) OR(p.kind='company' AND p.subject_id=ANY(x.company_ids)) OR(p.kind='feature' AND x.feature_id=p.feature_id));
  -- Full root exposure is cumulative across evaluators, arms, retries, features and time windows.
  SELECT coalesce(sum(CASE WHEN state='held' THEN reserved_nanos ELSE confirmed_nanos END),0) INTO root_used FROM app.ai_spend_reservation x WHERE x.tenant_id=tid AND x.root_id=wanted_root;
  IF used+wanted_nanos>p.monthly_nanos OR root_used+wanted_nanos>p.root_nanos THEN RAISE EXCEPTION 'AI spend allocation exhausted';END IF;
 END LOOP;
 INSERT INTO app.ai_spend_reservation(run_id,tenant_id,root_id,user_id,company_ids,feature_id,capability_digest,request_digest,configuration_digest,reserved_nanos)
 VALUES(wanted_run,tid,wanted_root,uid,r.company_ids,r.feature_id,wanted_capability,wanted_request,wanted_configuration,wanted_nanos);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.ai_spend_reserve(uuid,uuid,text,text,text,bigint,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ai_spend_reserve(uuid,uuid,text,text,text,bigint,text) TO ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.ai_spend_reconcile_receipt(signed_payload text,signed_mac text)
 RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p jsonb;r app.ai_spend_reservation;k app.ai_spend_receipt_verifier;expected bytea;received bytea;difference integer:=0;i integer;charge bigint;proof_digest text;
BEGIN
 PERFORM app._ai_spend_bounds();
 IF signed_payload IS NULL OR octet_length(signed_payload)>4096 OR signed_mac IS NULL OR signed_mac!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'AI spend receipt unavailable';END IF;
 p:=signed_payload::jsonb;
 IF jsonb_typeof(p)<>'array' OR jsonb_array_length(p)<>12 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p) e WHERE jsonb_typeof(e)<>'string')
 OR p->>0<>'aihr.openrouter.usd-receipt.v1' OR p->>1 IS DISTINCT FROM app.current_tenant_id()::text OR p->>2 IS DISTINCT FROM app.current_user_id()::text
 OR p->>8!~'^gen-[A-Za-z0-9_-]{1,240}$' OR p->>9!~'^(0|[1-9][0-9]{0,18})$' OR p->>11!~'^(0|[1-9][0-9]{0,127}e-?[0-9]{1,3})$' THEN RAISE EXCEPTION 'AI spend receipt unavailable';END IF;
 PERFORM pg_advisory_xact_lock(hashtext('ai-control'),hashtext(app.current_tenant_id()::text));
 SELECT * INTO r FROM app.ai_spend_reservation WHERE run_id=(p->>3)::uuid AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() FOR UPDATE NOWAIT;
 IF NOT FOUND OR p->>4<>r.root_id::text OR p->>5<>r.request_digest OR p->>6<>r.capability_digest OR p->>7<>r.configuration_digest
 OR NOT EXISTS(SELECT 1 FROM ai_model_run m WHERE m.id=r.run_id AND m.tenant_id=r.tenant_id AND m.user_id=r.user_id AND m.provider='openrouter') THEN RAISE EXCEPTION 'AI spend receipt unavailable';END IF;
 SELECT * INTO k FROM app.ai_spend_receipt_verifier WHERE key_id=p->>10 AND enabled AND valid_from<=r.created_at AND(retired_at IS NULL OR r.created_at<retired_at) FOR SHARE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'AI spend receipt unavailable';END IF;
 expected:=public.hmac(convert_to(signed_payload,'UTF8'),k.secret,'sha256');received:=decode(signed_mac,'hex');
 -- Fixed 32-byte comparison, no data-dependent early-return prefix oracle. HMAC itself is pgcrypto.
 FOR i IN 0..31 LOOP difference:=difference | (get_byte(expected,i) # get_byte(received,i));END LOOP;
 IF difference<>0 THEN RAISE EXCEPTION 'AI spend receipt unavailable';END IF;
 charge:=(p->>9)::bigint;IF ceil((p->>11)::numeric*1000000000)<>charge THEN RAISE EXCEPTION 'AI spend receipt amount changed';END IF;proof_digest:=encode(public.digest(convert_to(signed_payload,'UTF8'),'sha256'),'hex');
 IF r.receipt_digest IS NOT NULL THEN IF r.receipt_digest<>proof_digest OR r.generation_id<>p->>8 OR r.confirmed_nanos<>charge THEN RAISE EXCEPTION 'AI spend receipt changed';END IF;RETURN r.state;END IF;
 IF r.state<>'held' THEN RAISE EXCEPTION 'AI spend receipt unavailable';END IF;
 UPDATE app.ai_spend_reservation SET generation_id=p->>8,receipt_digest=proof_digest WHERE run_id=r.run_id;
 PERFORM app._ai_spend_confirm_verified_receipt(r.run_id,charge);
 RETURN CASE WHEN charge>r.reserved_nanos THEN 'breach' ELSE 'confirmed' END;
END $$;
REVOKE ALL ON FUNCTION app.ai_spend_reconcile_receipt(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ai_spend_reconcile_receipt(text,text) TO ai_hr_app;
