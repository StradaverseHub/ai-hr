CREATE FUNCTION app._ai_spend_bounds() RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF current_setting('statement_timeout')::interval=interval '0' OR current_setting('statement_timeout')::interval>interval '5 seconds' THEN PERFORM set_config('statement_timeout','5s',true);END IF;
 IF current_setting('lock_timeout')::interval=interval '0' OR current_setting('lock_timeout')::interval>interval '500 milliseconds' THEN PERFORM set_config('lock_timeout','500ms',true);END IF;
END $$;
REVOKE ALL ON FUNCTION app._ai_spend_bounds() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- UNALLOCATED / UNJOURNALED / UNAPPLIED. Application inference USD allocation, NOT invoice cap.
-- No production capability/budget/key seed. Apply after action/concurrency/provider-readiness drafts.
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
