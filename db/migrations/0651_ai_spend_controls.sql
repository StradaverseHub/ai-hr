-- AI spend controls (N5): allocation, receipt reconciliation, native tasks, reviewed free carriers and
-- reviewed metered carriers as ONE migration. Receipt reconciliation adds a NOT NULL column without a
-- default to app.ai_spend_reservation created here, which is only valid in this same migration.
-- Part 1 of 5: allocation.
CREATE FUNCTION app._ai_spend_bounds() RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF current_setting('statement_timeout')::interval=interval '0' OR current_setting('statement_timeout')::interval>interval '5 seconds' THEN PERFORM set_config('statement_timeout','5s',true);END IF;
 IF current_setting('lock_timeout')::interval=interval '0' OR current_setting('lock_timeout')::interval>interval '500 milliseconds' THEN PERFORM set_config('lock_timeout','500ms',true);END IF;
END $$;
REVOKE ALL ON FUNCTION app._ai_spend_bounds() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Application inference USD allocation, NOT invoice cap.
-- No production capability/budget/key seed. Applies after 0621, 0648 and 0625.
-- Certified catalog is SOURCE/RELEASE owned; app admins can set allocations, never certify prices.
CREATE TABLE app.ai_spend_capability(
 digest text PRIMARY KEY CHECK(digest~'^[a-f0-9]{64}$'),provider text NOT NULL,model text NOT NULL,operation text NOT NULL CHECK(operation IN('draft','conversation')),
 max_request_nanos bigint NOT NULL CHECK(max_request_nanos>0),source_digest text NOT NULL CHECK(source_digest~'^[a-f0-9]{64}$'),
 verified_at timestamptz NOT NULL,expires_at timestamptz NOT NULL CHECK(expires_at>verified_at),revoked_at timestamptz,
 semantics text NOT NULL CHECK(semantics='complete_inference_usd_ceiling_v1')
);
--> statement-breakpoint
CREATE TABLE app.ai_spend_budget(
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),scope_key text NOT NULL,kind text NOT NULL CHECK(kind IN('tenant','company','user','feature')),
 subject_id uuid,feature_id text,monthly_nanos bigint NOT NULL CHECK(monthly_nanos>=0),root_nanos bigint NOT NULL CHECK(root_nanos>=0),
 updated_at timestamptz NOT NULL DEFAULT now(),updated_by uuid REFERENCES public.app_user(id),PRIMARY KEY(tenant_id,scope_key),
 CHECK((kind='tenant' AND scope_key='tenant' AND subject_id IS NULL AND feature_id IS NULL) OR
 (kind IN('company','user') AND subject_id IS NOT NULL AND feature_id IS NULL AND scope_key=kind||':'||subject_id::text) OR
 (kind='feature' AND subject_id IS NULL AND feature_id IS NOT NULL AND scope_key='feature:'||feature_id))
);
--> statement-breakpoint
CREATE TABLE app.ai_spend_root(
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),root_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN('agent','evaluation')),
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,root_id)
);
--> statement-breakpoint
CREATE TABLE app.ai_spend_reservation(
 run_id uuid PRIMARY KEY REFERENCES public.ai_model_run(id),tenant_id uuid NOT NULL REFERENCES public.tenant(id),root_id uuid NOT NULL,
 user_id uuid NOT NULL REFERENCES public.app_user(id),company_ids uuid[] NOT NULL,feature_id text NOT NULL,
 capability_digest text NOT NULL REFERENCES app.ai_spend_capability(digest),request_digest text NOT NULL CHECK(request_digest~'^[a-f0-9]{64}$'),
 reserved_nanos bigint NOT NULL CHECK(reserved_nanos>0),confirmed_nanos bigint CHECK(confirmed_nanos>=0),
 state text NOT NULL DEFAULT 'held' CHECK(state IN('held','confirmed','breach')),created_at timestamptz NOT NULL DEFAULT now(),settled_at timestamptz,
 FOREIGN KEY(tenant_id,root_id) REFERENCES app.ai_spend_root(tenant_id,root_id),
 CHECK((state='held' AND confirmed_nanos IS NULL AND settled_at IS NULL) OR(state IN('confirmed','breach') AND confirmed_nanos IS NOT NULL AND settled_at IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX ai_spend_reservation_scope ON app.ai_spend_reservation(tenant_id,created_at);
CREATE INDEX ai_spend_reservation_root ON app.ai_spend_reservation(tenant_id,root_id);
--> statement-breakpoint
ALTER TABLE app.ai_spend_capability ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ai_spend_budget ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ai_spend_root ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ai_spend_reservation ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.ai_spend_capability,app.ai_spend_budget,app.ai_spend_root,app.ai_spend_reservation FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.ai_spend_reserve(wanted_run uuid,wanted_root uuid,wanted_kind text,wanted_capability text,wanted_request text,wanted_nanos bigint)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE tid uuid:=app.current_tenant_id();uid uuid:=app.current_user_id();r ai_model_run;c app.ai_spend_capability;p app.ai_spend_budget;
 used numeric;root_used numeric;month_start timestamptz:=date_trunc('month',now() AT TIME ZONE 'Asia/Kuala_Lumpur') AT TIME ZONE 'Asia/Kuala_Lumpur';
BEGIN
 PERFORM app._ai_spend_bounds();
 IF tid IS NULL OR uid IS NULL OR wanted_kind NOT IN('agent','evaluation') OR wanted_root IS NULL OR wanted_request!~'^[a-f0-9]{64}$' OR wanted_nanos IS NULL OR wanted_nanos<=0
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
 INSERT INTO app.ai_spend_reservation(run_id,tenant_id,root_id,user_id,company_ids,feature_id,capability_digest,request_digest,reserved_nanos)
 VALUES(wanted_run,tid,wanted_root,uid,r.company_ids,r.feature_id,wanted_capability,wanted_request,wanted_nanos);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.ai_spend_reserve(uuid,uuid,text,text,text,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ai_spend_reserve(uuid,uuid,text,text,text,bigint) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.ai_spend_settle(wanted_run uuid,actual_nanos bigint)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE tid uuid:=app.current_tenant_id();uid uuid:=app.current_user_id();r app.ai_spend_reservation;
BEGIN
 PERFORM app._ai_spend_bounds();
 IF tid IS NULL OR uid IS NULL OR actual_nanos<0 THEN RAISE EXCEPTION 'AI spend settlement unavailable';END IF;
 PERFORM pg_advisory_xact_lock(hashtext('ai-control'),hashtext(tid::text));
 SELECT * INTO r FROM app.ai_spend_reservation WHERE run_id=wanted_run AND tenant_id=tid AND user_id=uid FOR UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'AI spend reservation unavailable';END IF;
 IF actual_nanos IS NULL THEN RETURN;END IF;
 IF r.state<>'held' THEN IF r.confirmed_nanos<>actual_nanos THEN RAISE EXCEPTION 'AI spend settlement changed';END IF;RETURN;END IF;
 -- No public caller can assert monetary costs. A future source-owned certified receipt reconciler
 -- needs a distinct evidence-verifying function. Current gateway ONLY passes NULL and holds exposure.
 RAISE EXCEPTION 'Verified USD receipt reconciliation unavailable';
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.ai_spend_settle(uuid,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ai_spend_settle(uuid,bigint) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.ai_spend_budget_save(wanted_kind text,wanted_subject uuid,wanted_feature text,monthly bigint,root_limit bigint)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE tid uuid:=app.current_tenant_id();k text;
BEGIN
 PERFORM app._ai_spend_bounds();
 IF tid IS NULL OR NOT app._ai_provider_evaluation_actor_valid() OR wanted_kind NOT IN('tenant','user','company','feature') OR monthly IS NULL OR root_limit IS NULL OR monthly<0 OR root_limit<0 THEN RAISE EXCEPTION 'AI spend administration unavailable';END IF;
 PERFORM pg_advisory_xact_lock(hashtext('ai-control'),hashtext(tid::text));
 IF wanted_kind='tenant' THEN IF wanted_subject IS NOT NULL OR wanted_feature IS NOT NULL THEN RAISE EXCEPTION 'Invalid spend scope';END IF;k:='tenant';
 ELSIF wanted_kind='feature' THEN IF wanted_subject IS NOT NULL OR wanted_feature IS NULL OR wanted_feature NOT IN('provider_evaluation','module_agent_evaluation','module_agent_planning') THEN RAISE EXCEPTION 'Invalid spend scope';END IF;k:='feature:'||wanted_feature;
 ELSE IF wanted_feature IS NOT NULL OR wanted_subject IS NULL OR(wanted_kind='user' AND NOT EXISTS(SELECT 1 FROM app_user WHERE id=wanted_subject AND tenant_id=tid)) OR(wanted_kind='company' AND NOT EXISTS(SELECT 1 FROM company WHERE id=wanted_subject AND tenant_id=tid)) THEN RAISE EXCEPTION 'Invalid spend scope';END IF;k:=wanted_kind||':'||wanted_subject::text;END IF;
 INSERT INTO app.ai_spend_budget(tenant_id,scope_key,kind,subject_id,feature_id,monthly_nanos,root_nanos,updated_by) VALUES(tid,k,wanted_kind,wanted_subject,wanted_feature,monthly,root_limit,app.current_user_id())
 ON CONFLICT(tenant_id,scope_key) DO UPDATE SET monthly_nanos=excluded.monthly_nanos,root_nanos=excluded.root_nanos,updated_by=excluded.updated_by,updated_at=now();
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.ai_spend_budget_save(text,uuid,text,bigint,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ai_spend_budget_save(text,uuid,text,bigint,bigint) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.ai_spend_status() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF NOT app._ai_provider_evaluation_actor_valid() THEN RAISE EXCEPTION 'AI spend administration unavailable';END IF;
 SELECT jsonb_build_object('currency','USD','unit','nano_usd','semantics','application_inference_allocation','certifiedLiveRoutes',0,
 'budgets',coalesce((SELECT jsonb_agg(jsonb_build_object('scopeKey',scope_key,'monthlyNanos',monthly_nanos::text,'rootNanos',root_nanos::text) ORDER BY scope_key) FROM app.ai_spend_budget WHERE tenant_id=app.current_tenant_id()),'[]'::jsonb),
 'heldNanos',coalesce((SELECT sum(reserved_nanos)::text FROM app.ai_spend_reservation WHERE tenant_id=app.current_tenant_id() AND state='held'),'0'),
 'confirmedNanos',(SELECT sum(confirmed_nanos)::text FROM app.ai_spend_reservation WHERE tenant_id=app.current_tenant_id() AND confirmed_nanos IS NOT NULL),
 'breached',EXISTS(SELECT 1 FROM app.ai_spend_reservation WHERE tenant_id=app.current_tenant_id() AND state='breach')) INTO result;
 RETURN result;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.ai_spend_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ai_spend_status() TO ai_hr_app;

--> statement-breakpoint
-- ONLY a future evidence-verifying owner may call this. No app/admin amount submission can release
-- unknown exposure. Tests calling as owner prove ledger semantics, NOT provider receipt provenance.
CREATE FUNCTION app._ai_spend_confirm_verified_receipt(wanted_run uuid,actual_nanos bigint)
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
 UPDATE app.ai_spend_reservation SET confirmed_nanos=actual_nanos,state=CASE WHEN actual_nanos>reserved_nanos THEN 'breach' ELSE 'confirmed' END,settled_at=now() WHERE run_id=wanted_run;
END $$;
REVOKE ALL ON FUNCTION app._ai_spend_confirm_verified_receipt(uuid,bigint) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Part 2 of 5: receipt reconciliation, after the allocation above.
-- Dedicated purpose key is operator-provisioned in private verifier store + server environment only.
-- No source secret/key/capability seed, automatic provisioning, provider activation or live request.
-- HMAC-SHA256 is RFC 2104 over the PostgreSQL built-in sha256(bytea), so no extension (pgcrypto) or
-- database CREATE privilege is needed. It produces the same bytes as node:crypto createHmac('sha256')
-- and pgcrypto hmac(...,'sha256'); the install refuses unless RFC 4231 vectors and a 32-byte key case match.
CREATE FUNCTION app._ai_spend_hmac_sha256(message bytea,secret bytea) RETURNS bytea
 LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog,pg_temp AS $$
DECLARE k bytea:=secret;inner_pad bytea;outer_pad bytea;i integer;
BEGIN
 IF octet_length(k)>64 THEN k:=sha256(k);END IF;
 k:=k||decode(repeat('00',64-octet_length(k)),'hex');inner_pad:=k;outer_pad:=k;
 FOR i IN 0..63 LOOP inner_pad:=set_byte(inner_pad,i,get_byte(k,i)#54);outer_pad:=set_byte(outer_pad,i,get_byte(k,i)#92);END LOOP;
 RETURN sha256(outer_pad||sha256(inner_pad||message));
END $$;
REVOKE ALL ON FUNCTION app._ai_spend_hmac_sha256(bytea,bytea) FROM PUBLIC,ai_hr_app;
DO $$BEGIN
 IF encode(app._ai_spend_hmac_sha256(convert_to('what do ya want for nothing?','UTF8'),convert_to('Jefe','UTF8')),'hex')<>'5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843'
 OR encode(app._ai_spend_hmac_sha256(convert_to('Test Using Larger Than Block-Size Key - Hash Key First','UTF8'),decode(repeat('aa',131),'hex')),'hex')<>'60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54'
 OR encode(app._ai_spend_hmac_sha256(convert_to('aihr.hmac.self-test.v1','UTF8'),decode('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f','hex')),'hex')<>'16a46d78e0177611d0045c1355d66c044a7bad9d33d836f54d202b5521b92bf8'
 THEN RAISE EXCEPTION 'Spend receipt HMAC-SHA256 self-test failed';END IF;
END$$;
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
 expected:=app._ai_spend_hmac_sha256(convert_to(signed_payload,'UTF8'),k.secret);received:=decode(signed_mac,'hex');
 -- Fixed 32-byte comparison, no data-dependent early-return prefix oracle. HMAC is the built-in helper above.
 FOR i IN 0..31 LOOP difference:=difference | (get_byte(expected,i) # get_byte(received,i));END LOOP;
 IF difference<>0 THEN RAISE EXCEPTION 'AI spend receipt unavailable';END IF;
 charge:=(p->>9)::bigint;IF ceil((p->>11)::numeric*1000000000)<>charge THEN RAISE EXCEPTION 'AI spend receipt amount changed';END IF;proof_digest:=encode(pg_catalog.sha256(convert_to(signed_payload,'UTF8')),'hex');
 IF r.receipt_digest IS NOT NULL THEN IF r.receipt_digest<>proof_digest OR r.generation_id<>p->>8 OR r.confirmed_nanos<>charge THEN RAISE EXCEPTION 'AI spend receipt changed';END IF;RETURN r.state;END IF;
 IF r.state<>'held' THEN RAISE EXCEPTION 'AI spend receipt unavailable';END IF;
 UPDATE app.ai_spend_reservation SET generation_id=p->>8,receipt_digest=proof_digest WHERE run_id=r.run_id;
 PERFORM app._ai_spend_confirm_verified_receipt(r.run_id,charge);
 -- The private canonical confirmer owns breach policy (including carrier-specific ceilings).
 -- Return its stored decision, never recompute a weaker rule from allocation size alone.
 RETURN (SELECT x.state FROM app.ai_spend_reservation x WHERE x.run_id=r.run_id);
END $$;
REVOKE ALL ON FUNCTION app.ai_spend_reconcile_receipt(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ai_spend_reconcile_receipt(text,text) TO ai_hr_app;
--> statement-breakpoint
-- Part 3 of 5: native spend tasks, after allocation + receipt reconciliation above.
-- Source-owned identities only. No raw question, HR payload, prompt hash or credential is stored.
-- Native source roots survive retries/source revisions/time windows; no automated TTL may delete
-- a root and thereby replenish its lifetime allowance. Erasure/accounting policy needs explicit owner.
CREATE TABLE app.ai_spend_task(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES public.tenant(id),created_by uuid NOT NULL REFERENCES public.app_user(id),
 feature_id text NOT NULL CHECK(feature_id IN('hr_assistant','readiness_reminders','claims_triage','payroll_hypotheses','performance_assistant','performance_review')),
 source_kind text NOT NULL CHECK(source_kind IN('assistant_question','readiness_template','claim_request','payroll_batch','performance_review_message','performance_feedback_message','performance_guide_request')),
 source_id uuid NOT NULL,operation text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,feature_id,source_kind,source_id,operation)
);
ALTER TABLE app.ai_spend_task ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.ai_spend_task FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._ai_spend_task_source_allowed(feature text,kind text,native_id uuid,operation text)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT app.current_tenant_id() IS NOT NULL AND app.current_user_id() IS NOT NULL AND app.principal_snapshot_current()
 AND EXISTS(SELECT 1 FROM app_user u JOIN tenant t ON t.id=u.tenant_id WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND t.status IN('active','trial'))
 AND CASE
 WHEN feature='hr_assistant' AND kind='assistant_question' AND operation='question' THEN EXISTS(SELECT 1 FROM assistant_grant g WHERE g.tenant_id=app.current_tenant_id() AND g.app_user_id=app.current_user_id() AND g.revoked_at IS NULL)
 WHEN feature='claims_triage' AND kind='claim_request' AND operation='triage' THEN EXISTS(SELECT 1 FROM claim_request q WHERE q.id=native_id AND q.tenant_id=app.current_tenant_id() AND q.status='pending' AND q.employment_id=ANY(app.visible_employment_ids()))
 WHEN feature='payroll_hypotheses' AND kind='payroll_batch' AND operation='hypotheses' THEN EXISTS(SELECT 1 FROM payroll_batch b WHERE b.id=native_id AND b.tenant_id=app.current_tenant_id() AND app.can_admin_payroll_for(b.company_id)
  AND NOT EXISTS(SELECT 1 FROM payslip s WHERE s.batch_id=b.id AND s.tenant_id=b.tenant_id AND app.can_admin_payroll_employment(s.employment_id) IS NOT TRUE))
 WHEN feature='performance_assistant' AND kind='performance_review_message' AND operation~'^([a-f0-9-]{36}:)?(setting|results|moderation|competency|career|evidence):[a-f0-9-]{36}$' THEN EXISTS(SELECT 1 FROM performance_onehr_review r WHERE r.review_id=native_id AND r.tenant_id=app.current_tenant_id()
  AND(app.onehr_manager(r.review_id) OR app.onehr_moderator(r.review_id) OR EXISTS(SELECT 1 FROM employment e WHERE e.id=r.employment_id AND e.tenant_id=r.tenant_id AND app.is_self_person(e.person_id))))
 WHEN feature='performance_assistant' AND kind='performance_feedback_message' AND operation~'^([a-f0-9-]{36}:)?feedback:[a-f0-9-]{36}$' THEN app.onehr_feedback_card(native_id) IS NOT NULL
 WHEN feature='performance_review' AND kind='performance_guide_request' AND operation='guide' THEN EXISTS(SELECT 1 FROM performance_assessment_guide_use g WHERE g.id=native_id AND g.tenant_id=app.current_tenant_id() AND g.actor_user_id=app.current_user_id() AND g.status='reserved')
 WHEN feature='readiness_reminders' AND kind='readiness_template' AND native_id=app.current_tenant_id() AND operation~'^(no_compensation|no_bank_account|no_identity|no_tax_number|no_epf_number|no_socso_number):(employee|hr)$' THEN app.is_admin()
 ELSE false END
$$;
REVOKE ALL ON FUNCTION app._ai_spend_task_source_allowed(text,text,uuid,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.ai_spend_task_issue(wanted_feature text,wanted_source_kind text,wanted_source_id uuid,wanted_operation text)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE root uuid;source uuid:=wanted_source_id;controls record;
BEGIN
 PERFORM app._ai_spend_bounds();
 IF current_setting('transaction_isolation')<>'read committed' OR current_setting('transaction_read_only')<>'off'
 OR wanted_feature IS NULL OR wanted_source_kind IS NULL OR wanted_operation IS NULL OR NOT app._ai_spend_task_source_allowed(wanted_feature,wanted_source_kind,wanted_source_id,wanted_operation) THEN RAISE EXCEPTION 'AI spend task unavailable';END IF;
 SELECT * INTO STRICT controls FROM app._ai_control_context(wanted_feature,false);
 IF controls.feature_paused OR EXISTS(SELECT 1 FROM app._ai_applicable_policies(wanted_feature,controls.company_ids) p WHERE NOT p.enabled) THEN RAISE EXCEPTION 'AI spend task paused';END IF;
 IF wanted_source_kind='assistant_question' THEN
  IF wanted_source_id IS NOT NULL THEN RAISE EXCEPTION 'AI question task must be source issued';END IF;
  -- One invocation is one new human question intent. Internal turns never call this issuer again.
  source:=gen_random_uuid();
 END IF;
 IF wanted_source_kind IN('performance_review_message','performance_feedback_message') THEN
  -- The native owner has already checked actual current review/feedback + prior message receipt.
  -- Persist its nonce under the ACTUAL actor; browser nonce alone is never a permission/root.
  IF wanted_operation!~'^(setting|results|moderation|competency|career|evidence|feedback):[a-f0-9-]{36}$' THEN RAISE EXCEPTION 'AI Performance operation unavailable';END IF;
  wanted_operation:=app.current_user_id()::text||':'||wanted_operation;
 END IF;
 INSERT INTO app.ai_spend_task(tenant_id,created_by,feature_id,source_kind,source_id,operation)
 VALUES(app.current_tenant_id(),app.current_user_id(),wanted_feature,wanted_source_kind,source,wanted_operation)
 ON CONFLICT(tenant_id,feature_id,source_kind,source_id,operation) DO NOTHING;
 SELECT t.id INTO STRICT root FROM app.ai_spend_task t WHERE t.tenant_id=app.current_tenant_id() AND t.feature_id=wanted_feature AND t.source_kind=wanted_source_kind AND t.source_id=source AND t.operation=wanted_operation;
 RETURN root;
END $$;
REVOKE ALL ON FUNCTION app.ai_spend_task_issue(text,text,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ai_spend_task_issue(text,text,uuid,text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._ai_spend_task_root_current(wanted_root uuid,wanted_feature text,wanted_kind text)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT wanted_kind='agent' AND EXISTS(SELECT 1 FROM app.ai_spend_task t WHERE t.id=wanted_root AND t.tenant_id=app.current_tenant_id() AND t.feature_id=wanted_feature
 AND(t.source_kind NOT IN('assistant_question','performance_review_message','performance_feedback_message','performance_guide_request') OR t.created_by=app.current_user_id()) AND app._ai_spend_task_source_allowed(t.feature_id,t.source_kind,t.source_id,t.operation))
$$;
REVOKE ALL ON FUNCTION app._ai_spend_task_root_current(uuid,text,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.ai_spend_reserve(wanted_run uuid,wanted_root uuid,wanted_kind text,wanted_capability text,wanted_request text,wanted_nanos bigint,wanted_configuration text)
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
 IF NOT(r.feature_id='provider_evaluation' AND EXISTS(SELECT 1 FROM ai_provider_candidate x WHERE x.id=wanted_root AND x.tenant_id=tid AND app._ai_provider_evaluation_actor_valid()))
 AND NOT(r.feature_id IN('module_agent_evaluation','module_agent_planning') AND EXISTS(SELECT 1 FROM ai_agent_candidate x WHERE x.id=wanted_root AND x.tenant_id=tid AND(x.owner_user_id=uid OR app.is_group_admin()))) AND NOT app._ai_spend_task_root_current(wanted_root,r.feature_id,wanted_kind) THEN RAISE EXCEPTION 'AI spend root unavailable';END IF;
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
CREATE OR REPLACE FUNCTION app.ai_spend_budget_save(wanted_kind text,wanted_subject uuid,wanted_feature text,monthly bigint,root_limit bigint)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE tid uuid:=app.current_tenant_id();k text;
BEGIN
 PERFORM app._ai_spend_bounds();
 IF tid IS NULL OR NOT app._ai_provider_evaluation_actor_valid() OR wanted_kind NOT IN('tenant','user','company','feature') OR monthly IS NULL OR root_limit IS NULL OR monthly<0 OR root_limit<0 THEN RAISE EXCEPTION 'AI spend administration unavailable';END IF;
 PERFORM pg_advisory_xact_lock(hashtext('ai-control'),hashtext(tid::text));
 IF wanted_kind='tenant' THEN IF wanted_subject IS NOT NULL OR wanted_feature IS NOT NULL THEN RAISE EXCEPTION 'Invalid spend scope';END IF;k:='tenant';
 ELSIF wanted_kind='feature' THEN IF wanted_subject IS NOT NULL OR wanted_feature IS NULL OR wanted_feature NOT IN('provider_evaluation','module_agent_evaluation','module_agent_planning','hr_assistant','readiness_reminders','claims_triage','payroll_hypotheses','performance_assistant','performance_review') THEN RAISE EXCEPTION 'Invalid spend scope';END IF;k:='feature:'||wanted_feature;
 ELSE IF wanted_feature IS NOT NULL OR wanted_subject IS NULL OR(wanted_kind='user' AND NOT EXISTS(SELECT 1 FROM app_user WHERE id=wanted_subject AND tenant_id=tid)) OR(wanted_kind='company' AND NOT EXISTS(SELECT 1 FROM company WHERE id=wanted_subject AND tenant_id=tid)) THEN RAISE EXCEPTION 'Invalid spend scope';END IF;k:=wanted_kind||':'||wanted_subject::text;END IF;
 INSERT INTO app.ai_spend_budget(tenant_id,scope_key,kind,subject_id,feature_id,monthly_nanos,root_nanos,updated_by) VALUES(tid,k,wanted_kind,wanted_subject,wanted_feature,monthly,root_limit,app.current_user_id())
 ON CONFLICT(tenant_id,scope_key) DO UPDATE SET monthly_nanos=excluded.monthly_nanos,root_nanos=excluded.root_nanos,updated_by=excluded.updated_by,updated_at=now();
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.ai_spend_budget_save(text,uuid,text,bigint,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ai_spend_budget_save(text,uuid,text,bigint,bigint) TO ai_hr_app;
--> statement-breakpoint
-- Part 4 of 5: reviewed free carriers. No current route or certificate is installed by this migration.
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
 expected:=app._ai_spend_hmac_sha256(convert_to('aihr.reviewed-carrier-signer.v1'||E'\n'||tid::text||E'\n'||uid::text||E'\n'||wanted_configuration||E'\n'||wanted_request,'UTF8'),k.secret);received:=decode(wanted_signature,'hex');
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
--> statement-breakpoint
-- Part 5 of 5: reviewed metered carriers, after the reviewed free carriers. No current paid endpoint/rate/record
-- is supplied. Conditional complete native-meter contracts are release-owned, not user price inputs.
-- Reserve FULL documented native C input + FULL allowed M output: (C*P+M*Q)*1000 nanoUSD.
-- Exact endpoint contracts MUST include every billable input (templates/tools) and reasoning output;
-- unknown/variable cache/storage/server tool/BYOK/request/other charges disqualify this carrier.
-- ONLY the release/database owner may insert a record after independent external review of the
-- exact controlled workspace/key/endpoint/account invariants and source contract. An app admin,
-- key metadata, model price list or a successful completion is NOT certification. Account changes
-- must invalidate the certificate BEFORE mutation; expiry is not a substitute for that control.
CREATE TABLE app.ai_spend_reviewed_metered_carrier_catalog(
 capability_digest text PRIMARY KEY REFERENCES app.ai_spend_capability(digest),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 carrier text NOT NULL CHECK(carrier='openrouter_fixed_metered_text_v1'),
 configuration_digest text NOT NULL CHECK(configuration_digest~'^[a-f0-9]{64}$'),
 model text NOT NULL CHECK(model~'^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$' AND lower(model) NOT LIKE 'openrouter/%'),
 operation text NOT NULL CHECK(operation IN('draft','conversation')),
 endpoint_slug text NOT NULL CHECK(length(endpoint_slug)<=128 AND endpoint_slug~'^[a-z0-9]+([-/][a-z0-9]+)*$'),
 native_context_tokens bigint NOT NULL CHECK(native_context_tokens BETWEEN 1 AND 1000000000),
 completion_tokens bigint NOT NULL CHECK(completion_tokens BETWEEN 1 AND 32768 AND completion_tokens<=native_context_tokens),
 prompt_usd_per_million bigint NOT NULL CHECK(prompt_usd_per_million BETWEEN 1 AND 1000000),
 completion_usd_per_million bigint NOT NULL CHECK(completion_usd_per_million BETWEEN 1 AND 1000000),
 native_contract_digest text NOT NULL CHECK(native_contract_digest~'^[a-f0-9]{64}$'),
 endpoint_revision_digest text NOT NULL CHECK(endpoint_revision_digest~'^[a-f0-9]{64}$'),
 documentation_digest text NOT NULL CHECK(documentation_digest~'^[a-f0-9]{64}$'),
 source_digest text NOT NULL CHECK(source_digest~'^[a-f0-9]{64}$'),
 workspace_control_digest text NOT NULL CHECK(workspace_control_digest~'^[a-f0-9]{64}$'),
 review_evidence_digest text NOT NULL CHECK(review_evidence_digest~'^[a-f0-9]{64}$'),
 independent_evidence_digest text NOT NULL CHECK(independent_evidence_digest~'^[a-f0-9]{64}$' AND independent_evidence_digest<>review_evidence_digest),
 invariants jsonb NOT NULL CHECK(invariants='{"controlledWorkspace":true,"accountMutationGoverned":true,"noByok":true,"noDefaultPlugins":true,"noEnforcedPlugins":true,"noPresetInjection":true,"noServerTools":true,"noPaidCacheWrites":true,"noOtherCharges":true,"zdrEndpoint":true,"noTraining":true,"parametersEnforced":true,"exactEndpointOnly":true,"hardNativeContextAllInput":true,"completionIncludesAllReasoning":true,"noContextExtensions":true,"endpointMutationGoverned":true,"completeBillingDimensions":true}'::jsonb),
 reviewed_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,revoked_at timestamptz,
 CHECK(expires_at>reviewed_at AND expires_at<=reviewed_at+interval '24 hours')
);
--> statement-breakpoint
ALTER TABLE app.ai_spend_reviewed_metered_carrier_catalog ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.ai_spend_reviewed_metered_carrier_catalog FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.ai_spend_reviewed_metered_carrier(wanted_configuration text,wanted_model text,wanted_operation text,wanted_source text,wanted_signer text,wanted_signature text,wanted_request text)
 RETURNS TABLE(profile jsonb) LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE tid uuid:=app.current_tenant_id();uid uuid:=app.current_user_id();k app.ai_spend_receipt_verifier;expected bytea;received bytea;difference integer:=0;i integer;
BEGIN
 PERFORM app._ai_spend_bounds();
 IF tid IS NULL OR uid IS NULL OR wanted_configuration IS NULL OR wanted_configuration!~'^[a-f0-9]{64}$' OR wanted_source IS NULL OR wanted_source!~'^[a-f0-9]{64}$' OR wanted_operation NOT IN('draft','conversation') OR current_setting('transaction_read_only')<>'off' OR current_setting('transaction_isolation')<>'read committed' THEN RETURN;END IF;
 IF wanted_signer IS NULL OR wanted_signer!~'^[A-Za-z0-9_-]{1,64}$' OR wanted_signature IS NULL OR wanted_signature!~'^[a-f0-9]{64}$' OR wanted_request IS NULL OR wanted_request!~'^[a-f0-9]{64}$' THEN RETURN;END IF;
 IF NOT pg_try_advisory_xact_lock(hashtext('ai-control'),hashtext(tid::text)) THEN RAISE EXCEPTION 'Reviewed spend carrier busy';END IF;
 SELECT * INTO k FROM app.ai_spend_receipt_verifier WHERE key_id=wanted_signer AND enabled AND valid_from<=now() AND(retired_at IS NULL OR retired_at>now()) FOR SHARE NOWAIT;
 IF NOT FOUND THEN RETURN;END IF;
 expected:=app._ai_spend_hmac_sha256(convert_to('aihr.reviewed-carrier-signer.v1'||E'\n'||tid::text||E'\n'||uid::text||E'\n'||wanted_configuration||E'\n'||wanted_request,'UTF8'),k.secret);received:=decode(wanted_signature,'hex');
 FOR i IN 0..31 LOOP difference:=difference | (get_byte(expected,i)#get_byte(received,i));END LOOP;IF difference<>0 THEN RETURN;END IF;
 -- Current principal/provider/source access is independently required by canonical admission.
 -- This private projection exposes only the exact tenant/configuration certificate, not keys.
 RETURN QUERY SELECT jsonb_build_object('carrier','openrouter_fixed_metered_text_v1','meterContract',jsonb_build_object('semantics','all_native_input_and_all_generated_output_v1','nativeContextTokens',r.native_context_tokens,'completionTokens',r.completion_tokens,'promptUsdPerMillion',r.prompt_usd_per_million,'completionUsdPerMillion',r.completion_usd_per_million,'nativeContractDigest',r.native_contract_digest,'endpointRevisionDigest',r.endpoint_revision_digest,'documentationDigest',r.documentation_digest),'capabilityDigest',r.capability_digest,'sourceDigest',r.source_digest,
 'configurationDigest',r.configuration_digest,'model',r.model,'operation',r.operation,'endpointSlug',r.endpoint_slug,
 'workspaceControlDigest',r.workspace_control_digest,'reviewEvidenceDigest',r.review_evidence_digest,
 'independentEvidenceDigest',r.independent_evidence_digest,'expiresAt',least(r.expires_at,c.expires_at,coalesce(k.retired_at,'infinity'::timestamptz))::text,'invariants',r.invariants)
 FROM app.ai_spend_reviewed_metered_carrier_catalog r JOIN app.ai_spend_capability c ON c.digest=r.capability_digest
 WHERE r.tenant_id=tid AND r.configuration_digest=wanted_configuration AND r.model=wanted_model AND r.operation=wanted_operation AND r.source_digest=wanted_source
 AND r.reviewed_at<=now() AND r.expires_at>now() AND r.revoked_at IS NULL
 AND c.provider='openrouter' AND c.model=r.model AND c.operation=r.operation AND c.max_request_nanos::numeric=(r.native_context_tokens::numeric*r.prompt_usd_per_million+r.completion_tokens::numeric*r.completion_usd_per_million)*1000 AND c.source_digest=r.source_digest
 AND c.semantics='complete_inference_usd_ceiling_v1' AND c.verified_at<=now() AND c.expires_at>now() AND c.revoked_at IS NULL
 ORDER BY r.expires_at DESC,r.capability_digest LIMIT 2 FOR SHARE OF r,c NOWAIT;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.ai_spend_reviewed_metered_carrier(text,text,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ai_spend_reviewed_metered_carrier(text,text,text,text,text,text,text) TO ai_hr_app;
--> statement-breakpoint
-- Retain historical complete-meter contracts for already admitted receipts. Renewals insert a
-- distinct reviewed capability; only monotonic revocation may update an existing record.
CREATE FUNCTION app._ai_spend_reviewed_metered_carrier_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Reviewed carrier history cannot be deleted';END IF;
 IF (to_jsonb(NEW)-'revoked_at') IS DISTINCT FROM(to_jsonb(OLD)-'revoked_at') OR(OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN RAISE EXCEPTION 'Reviewed carrier identity cannot change';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app._ai_spend_reviewed_metered_carrier_immutable() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER ai_spend_reviewed_metered_carrier_immutable BEFORE UPDATE OR DELETE ON app.ai_spend_reviewed_metered_carrier_catalog FOR EACH ROW EXECUTE FUNCTION app._ai_spend_reviewed_metered_carrier_immutable();
--> statement-breakpoint
-- Honest administration metadata: a reviewed record is NOT a live/routable/capability PASS.
-- The legacy zero field stays for compatibility and must not be rendered as an availability count.
CREATE OR REPLACE FUNCTION app.ai_spend_status() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF NOT app._ai_provider_evaluation_actor_valid() THEN RAISE EXCEPTION 'AI spend administration unavailable';END IF;
 SELECT jsonb_build_object('currency','USD','unit','nano_usd','semantics','application_inference_allocation','certifiedLiveRoutes',0,
 'reviewedCarrierRecords',((SELECT count(*)::int FROM app.ai_spend_reviewed_carrier_catalog r JOIN app.ai_spend_capability c ON c.digest=r.capability_digest WHERE r.tenant_id=app.current_tenant_id() AND r.reviewed_at<=now() AND r.expires_at>now() AND r.revoked_at IS NULL AND c.verified_at<=now() AND c.expires_at>now() AND c.revoked_at IS NULL AND c.provider='openrouter' AND c.model=r.model AND c.operation=r.operation AND c.source_digest=r.source_digest AND c.max_request_nanos=1)+(SELECT count(*)::int FROM app.ai_spend_reviewed_metered_carrier_catalog r JOIN app.ai_spend_capability c ON c.digest=r.capability_digest WHERE r.tenant_id=app.current_tenant_id() AND r.reviewed_at<=now() AND r.expires_at>now() AND r.revoked_at IS NULL AND c.verified_at<=now() AND c.expires_at>now() AND c.revoked_at IS NULL AND c.provider='openrouter' AND c.model=r.model AND c.operation=r.operation AND c.source_digest=r.source_digest AND c.max_request_nanos::numeric=(r.native_context_tokens::numeric*r.prompt_usd_per_million+r.completion_tokens::numeric*r.completion_usd_per_million)*1000)),
 'liveCapability','not_verified_here',
 'budgets',coalesce((SELECT jsonb_agg(jsonb_build_object('scopeKey',scope_key,'monthlyNanos',monthly_nanos::text,'rootNanos',root_nanos::text) ORDER BY scope_key) FROM app.ai_spend_budget WHERE tenant_id=app.current_tenant_id()),'[]'::jsonb),
 'heldNanos',coalesce((SELECT sum(reserved_nanos)::text FROM app.ai_spend_reservation WHERE tenant_id=app.current_tenant_id() AND state='held'),'0'),
 'confirmedNanos',(SELECT sum(confirmed_nanos)::text FROM app.ai_spend_reservation WHERE tenant_id=app.current_tenant_id() AND confirmed_nanos IS NOT NULL),
 'breached',EXISTS(SELECT 1 FROM app.ai_spend_reservation WHERE tenant_id=app.current_tenant_id() AND state='breach')) INTO result;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.ai_spend_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ai_spend_status() TO ai_hr_app;
