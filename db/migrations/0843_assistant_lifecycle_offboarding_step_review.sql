-- Coordinator allocated0735 /idx715 /when1793330000072. UNAPPLIED PROVISIONAL DEVELOPMENT ONLY.
-- One closed offboarding kind in the EXISTING physical encrypted ledger. No V9/outcome engine.
INSERT INTO app.assistant_action_kind(id,module,tier_ceiling,category,review_kind) VALUES
 ('lifecycle.offboarding.step.complete','lifecycle','confirm','own_work','lifecycle.offboarding.step.complete');
--> statement-breakpoint
-- Extend only the three predicates that reject the new nullable-case family. Freeze their names
-- before DDL; preserve every other dedicated guard and every predecessor expression once.
DO $$ DECLARE item record;previous text;scope_name text;case_name text;matches integer; BEGIN
 SELECT count(*),min(conname) INTO matches,scope_name FROM pg_constraint
 WHERE conrelid='app.assistant_own_leave_review'::regclass AND contype='c'
 AND pg_get_expr(conbin,conrelid) LIKE '%testing_execution_id IS NOT NULL%'
 AND pg_get_expr(conbin,conrelid) LIKE '%employment_id IS NULL%';
 IF matches<>1 THEN RAISE EXCEPTION '0735: unexpected scope predicate';END IF;
 SELECT count(*),min(conname) INTO matches,case_name FROM pg_constraint
 WHERE conrelid='app.assistant_own_leave_review'::regclass AND contype='c'
 AND pg_get_expr(conbin,conrelid) LIKE '%lifecycle_case_id IS NOT NULL%';
 IF matches<>1 THEN RAISE EXCEPTION '0735: unexpected lifecycle predicate';END IF;
 FOR item IN SELECT * FROM (VALUES
  (scope_name,'company_id IS NOT NULL AND testing_execution_id IS NULL AND testing_run_id IS NULL AND testing_event_id IS NULL'),
  (case_name,'lifecycle_case_id IS NOT NULL AND ((state=''completed'')=(lifecycle_submitted_event_id IS NOT NULL))'),
  ('assistant_review_kind_columns','leave_request_id IS NULL AND submission_event_id IS NULL AND notification_event_id IS NULL AND profile_request_id IS NULL AND profile_requested_event_id IS NULL AND claim_draft_id IS NULL AND claim_saved_event_id IS NULL AND performance_ack_event_id IS NULL')
 ) requirements(name,expression) LOOP
  SELECT pg_get_expr(conbin,conrelid) INTO previous FROM pg_constraint WHERE conrelid='app.assistant_own_leave_review'::regclass AND conname=item.name;
  IF previous IS NULL THEN RAISE EXCEPTION '0735: missing predicate %',item.name;END IF;
  RAISE NOTICE '0735 bounded predicate % predecessor bytes %',item.name,octet_length(previous);
  EXECUTE format('ALTER TABLE app.assistant_own_leave_review DROP CONSTRAINT %I',item.name);
  EXECUTE format('ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT %I CHECK (CASE WHEN action_kind=''lifecycle.offboarding.step.complete'' THEN (%s) ELSE (%s) END)',item.name,item.expression,previous);
 END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE app.assistant_own_leave_review ADD COLUMN offboarding_step_effect_commitment text,
 ADD COLUMN offboarding_step_case_version text,ADD COLUMN offboarding_step_version text;
--> statement-breakpoint
ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT assistant_step_effect_columns CHECK (
 CASE WHEN action_kind IN ('lifecycle.offboarding.step.complete','lifecycle.offboarding.step.undo') THEN
 ((state='awaiting_confirmation')=(offboarding_step_effect_commitment IS NOT NULL))
 AND (offboarding_step_effect_commitment IS NULL OR offboarding_step_effect_commitment ~ '^[a-f0-9]{64}$')
 AND ((state='completed')=(offboarding_step_case_version IS NOT NULL)) AND ((state='completed')=(offboarding_step_version IS NOT NULL))
 AND (offboarding_step_case_version IS NULL OR offboarding_step_case_version ~ '^[0-9]+$')
 AND (offboarding_step_version IS NULL OR offboarding_step_version ~ '^[0-9]+$')
 ELSE offboarding_step_effect_commitment IS NULL AND offboarding_step_case_version IS NULL AND offboarding_step_version IS NULL END);
--> statement-breakpoint
ALTER TABLE app.assistant_own_leave_review ADD COLUMN offboarding_step_key text,
 ADD COLUMN offboarding_expect_completion boolean,ADD COLUMN offboarding_completion_event_id uuid UNIQUE;
--> statement-breakpoint
-- Explicit closed set of this kind's columns. Every actual foreign dedicated/receipt/scope column
-- must be NULL, including later predecessor extensions, without copying their predicate trees.
DO $$ DECLARE unrelated text; BEGIN
 SELECT string_agg(format('%I IS NULL',attname),' AND ' ORDER BY attnum) INTO unrelated FROM pg_attribute
 WHERE attrelid='app.assistant_own_leave_review'::regclass AND attnum>0 AND NOT attisdropped
 AND attname<>ALL(ARRAY['offboarding_step_effect_commitment','offboarding_step_case_version','offboarding_step_version','action_kind','id','tenant_id','user_id','person_id','employment_id','company_id','intent_digest','reviewed_digest','state','created_at','expires_at','lifecycle_case_id','lifecycle_case_person_id','lifecycle_submitted_event_id','offboarding_step_key','offboarding_expect_completion','offboarding_completion_event_id']);
 IF unrelated IS NULL THEN RAISE EXCEPTION '0735: predecessor custody columns missing';END IF;
 EXECUTE 'ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT assistant_offboarding_step_columns CHECK (CASE WHEN action_kind=''lifecycle.offboarding.step.complete'' THEN
  lifecycle_case_id IS NOT NULL AND company_id IS NOT NULL AND offboarding_step_key IS NOT NULL AND length(offboarding_step_key) BETWEEN 1 AND 100 AND offboarding_step_key<>''resign_outcome'' AND offboarding_expect_completion IS NOT NULL
  AND ((state=''completed'')=(lifecycle_submitted_event_id IS NOT NULL))
  AND ((offboarding_completion_event_id IS NOT NULL)=(state=''completed'' AND offboarding_expect_completion)) AND ('||unrelated||')
 ELSE offboarding_step_key IS NULL AND offboarding_expect_completion IS NULL AND offboarding_completion_event_id IS NULL END)';
END $$;
--> statement-breakpoint
-- Pure typed-row serialization only: caller authority and current_date retain their TimeZone.
CREATE FUNCTION app._assistant_step_json(p_row public.lc_case) RETURNS jsonb
 LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$ SELECT to_jsonb(p_row) $$;
REVOKE ALL ON FUNCTION app._assistant_step_json(public.lc_case) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._assistant_step_json(p_row public.lc_case_step) RETURNS jsonb
 LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$ SELECT to_jsonb(p_row) $$;
REVOKE ALL ON FUNCTION app._assistant_step_json(public.lc_case_step) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._assistant_step_json(p_row public.lc_comment) RETURNS jsonb
 LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$ SELECT to_jsonb(p_row) $$;
REVOKE ALL ON FUNCTION app._assistant_step_json(public.lc_comment) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._assistant_step_json(p_row public.it_requisition) RETURNS jsonb
 LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$ SELECT to_jsonb(p_row) $$;
REVOKE ALL ON FUNCTION app._assistant_step_json(public.it_requisition) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._assistant_step_json(p_row public.it_requisition_item) RETURNS jsonb
 LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$ SELECT to_jsonb(p_row) $$;
REVOKE ALL ON FUNCTION app._assistant_step_json(public.it_requisition_item) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._assistant_step_json(p_row public.it_asset) RETURNS jsonb
 LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$ SELECT to_jsonb(p_row) $$;
REVOKE ALL ON FUNCTION app._assistant_step_json(public.it_asset) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._assistant_step_json(p_row public.lc_step_def) RETURNS jsonb
 LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$ SELECT to_jsonb(p_row) $$;
REVOKE ALL ON FUNCTION app._assistant_step_json(public.lc_step_def) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._assistant_step_json(p_row public.lc_history) RETURNS jsonb
 LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$ SELECT to_jsonb(p_row) $$;
REVOKE ALL ON FUNCTION app._assistant_step_json(public.lc_history) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._assistant_step_json(p_row public.domain_event) RETURNS jsonb
 LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$ SELECT to_jsonb(p_row) $$;
REVOKE ALL ON FUNCTION app._assistant_step_json(public.domain_event) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Private whole-effect projection; never emitted into domain_event or returned to app callers.
-- Native clock-generated done_at/completed_at are represented by non-null markers only where
-- the reviewed native operation owns that field. All other values/versions remain exact.
CREATE FUNCTION app._assistant_step_effect(p_case uuid,p_step text,p_done boolean,p_transition boolean,p_reference text,p_notes text,p_detail jsonb,p_predicted boolean) RETURNS text
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT encode(sha256(convert_to(jsonb_build_array(
  CASE WHEN p_transition AND p_predicted THEN app._assistant_step_json(c)||jsonb_build_object('status',CASE WHEN p_done THEN 'completed' ELSE 'in_progress' END,'completed_at',CASE WHEN p_done THEN to_jsonb('native-clock'::text) ELSE 'null'::jsonb END) WHEN p_transition AND NOT p_predicted AND p_done AND c.status='completed' AND c.completed_at IS NOT NULL AND isfinite(c.completed_at) THEN app._assistant_step_json(c)||jsonb_build_object('completed_at','native-clock') ELSE app._assistant_step_json(c) END,
  CASE WHEN p_transition THEN 'native-version' ELSE c.xmin::text END,
  (SELECT coalesce(jsonb_agg(jsonb_build_array(app._assistant_step_json(d),d.xmin::text) ORDER BY d.id),'[]'::jsonb) FROM public.lc_step_def d WHERE d.tenant_id=c.tenant_id AND d.kind='offboarding'),
  (SELECT coalesce(jsonb_agg(jsonb_build_array(app._assistant_step_json(a),a.xmin::text) ORDER BY a.step_key),'[]'::jsonb) FROM public.lc_case_step a WHERE a.case_id=c.id AND a.step_key<>p_step),
  (SELECT coalesce(jsonb_agg(jsonb_build_array(app._assistant_step_json(d),d.xmin::text) ORDER BY d.id),'[]'::jsonb) FROM public.domain_event d WHERE d.tenant_id=c.tenant_id AND (d.aggregate_type='lifecycle-case' AND d.aggregate_id=c.id OR d.aggregate_type='lifecycle-requisition' AND d.aggregate_id IN (SELECT id FROM public.it_requisition WHERE case_id=c.id) OR d.aggregate_type='lifecycle-asset' AND d.aggregate_id IN (SELECT a.id FROM public.it_asset a JOIN public.it_requisition q ON q.id=a.requisition_id WHERE q.case_id=c.id)) AND d.xmin<>pg_current_xact_id()::xid),
  (SELECT coalesce(jsonb_agg(jsonb_build_array(app._assistant_step_json(h),h.xmin::text) ORDER BY h.id),'[]'::jsonb) FROM public.lc_history h WHERE h.tenant_id=c.tenant_id AND (h.ref_type='case' AND h.ref_id=c.id OR h.ref_type='requisition' AND h.ref_id IN (SELECT id FROM public.it_requisition WHERE case_id=c.id) OR h.ref_type='asset' AND h.ref_id IN (SELECT a.id FROM public.it_asset a JOIN public.it_requisition q ON q.id=a.requisition_id WHERE q.case_id=c.id)) AND h.xmin<>pg_current_xact_id()::xid),
  CASE WHEN p_predicted THEN jsonb_build_array(p_detail) ELSE (SELECT jsonb_agg(h.detail ORDER BY h.id) FROM public.lc_history h WHERE h.tenant_id=c.tenant_id AND h.ref_type='case' AND h.ref_id=c.id AND h.action=CASE WHEN p_done THEN 'step.done' ELSE 'step.undone' END AND h.detail->>'key'=p_step AND h.xmin=pg_current_xact_id()::xid) END,
  CASE WHEN NOT p_transition THEN NULL WHEN p_predicted THEN jsonb_build_array('{}'::jsonb) ELSE (SELECT jsonb_agg(h.detail ORDER BY h.id) FROM public.lc_history h WHERE h.tenant_id=c.tenant_id AND h.ref_type='case' AND h.ref_id=c.id AND h.action=CASE WHEN p_done THEN 'case.completed' ELSE 'case.reverted' END AND h.xmin=pg_current_xact_id()::xid) END,
  CASE WHEN p_predicted THEN jsonb_build_object('tenant_id',c.tenant_id,'case_id',c.id,'step_key',p_step,'done',p_done,'done_by',CASE WHEN p_done THEN app.current_user_id() ELSE NULL END,'done_at',CASE WHEN p_done THEN to_jsonb('native-clock'::text) ELSE 'null'::jsonb END,'reference',CASE WHEN p_done THEN p_reference ELSE a.reference END,'notes',CASE WHEN p_done THEN p_notes ELSE a.notes END)
   ELSE app._assistant_step_json(a)||CASE WHEN p_done AND a.done_at IS NOT NULL THEN jsonb_build_object('done_at','native-clock') ELSE '{}'::jsonb END END,
  (SELECT coalesce(jsonb_agg(jsonb_build_array(app._assistant_step_json(x),x.xmin::text) ORDER BY x.id),'[]'::jsonb) FROM public.lc_comment x WHERE x.case_id=c.id),
  (SELECT coalesce(jsonb_agg(jsonb_build_array(app._assistant_step_json(x),x.xmin::text) ORDER BY x.id),'[]'::jsonb) FROM public.it_requisition x WHERE x.case_id=c.id),
  (SELECT coalesce(jsonb_agg(jsonb_build_array(app._assistant_step_json(x),x.xmin::text) ORDER BY x.requisition_id,x.item_key),'[]'::jsonb) FROM public.it_requisition_item x JOIN public.it_requisition q ON q.id=x.requisition_id WHERE q.case_id=c.id),
  (SELECT coalesce(jsonb_agg(jsonb_build_array(app._assistant_step_json(x),x.xmin::text) ORDER BY x.id),'[]'::jsonb) FROM public.it_asset x JOIN public.it_requisition q ON q.id=x.requisition_id WHERE q.case_id=c.id)
 )::text,'UTF8')),'hex') FROM public.lc_case c LEFT JOIN public.lc_case_step a ON a.case_id=c.id AND a.step_key=p_step
 WHERE c.id=p_case AND c.tenant_id=app.current_tenant_id() AND c.kind='offboarding';
$$;
REVOKE ALL ON FUNCTION app._assistant_step_effect(uuid,text,boolean,boolean,text,text,jsonb,boolean) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._assistant_step_scrub() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN
 -- Completed receipt identity is permanent. Business-table fences below last only this root
 -- transaction. Canonical erasure may clear private content/digests, never retarget identity.
 IF OLD.action_kind IN ('lifecycle.offboarding.step.complete','lifecycle.offboarding.step.undo') AND OLD.state='completed'
  AND (TG_OP='DELETE' OR (to_jsonb(NEW)-ARRAY['intent_digest','reviewed_digest','offboarding_step_effect_commitment'])
   IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['intent_digest','reviewed_digest','offboarding_step_effect_commitment'])) THEN
  RAISE EXCEPTION 'Lifecycle review unavailable' USING ERRCODE='42501';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;
 IF NEW.action_kind IN ('lifecycle.offboarding.step.complete','lifecycle.offboarding.step.undo') AND (NEW.state<>'awaiting_confirmation' OR NEW.intent_digest IS NULL OR NEW.reviewed_digest IS NULL) THEN NEW.offboarding_step_effect_commitment:=NULL;END IF;
 RETURN NEW;END $$;
REVOKE ALL ON FUNCTION app._assistant_step_scrub() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER assistant_step_private_scrub BEFORE UPDATE OR DELETE ON app.assistant_own_leave_review
 FOR EACH ROW EXECUTE FUNCTION app._assistant_step_scrub();
--> statement-breakpoint
-- A later BEFORE trigger can rewrite NEW after an earlier guard ran. This nondeferrable
-- AFTER companion checks the persisted postimage; it never rewrites domain or custody data.
CREATE FUNCTION app._assistant_step_identity_after() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN
 IF OLD.action_kind IN ('lifecycle.offboarding.step.complete','lifecycle.offboarding.step.undo') AND OLD.state='completed'
  AND (TG_OP='DELETE' OR (to_jsonb(NEW)-ARRAY['intent_digest','reviewed_digest','offboarding_step_effect_commitment'])
   IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['intent_digest','reviewed_digest','offboarding_step_effect_commitment'])) THEN
  RAISE EXCEPTION 'Lifecycle review unavailable' USING ERRCODE='42501';END IF;
 RETURN NULL;END $$;
REVOKE ALL ON FUNCTION app._assistant_step_identity_after() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER assistant_step_identity_after AFTER UPDATE OR DELETE ON app.assistant_own_leave_review
 FOR EACH ROW EXECUTE FUNCTION app._assistant_step_identity_after();
--> statement-breakpoint
CREATE INDEX assistant_step_root_identity ON app.assistant_own_leave_review
 (lifecycle_case_id,offboarding_step_version)
 WHERE action_kind IN ('lifecycle.offboarding.step.complete','lifecycle.offboarding.step.undo') AND state='completed';
--> statement-breakpoint
CREATE FUNCTION app._assistant_step_domain_fence() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE row_data jsonb;case_id uuid;parent_id uuid;which integer;BEGIN
 FOR which IN 1..2 LOOP
  IF (which=1 AND TG_OP='INSERT') OR (which=2 AND TG_OP='DELETE') THEN CONTINUE;END IF;
  row_data:=CASE WHEN which=1 THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;case_id:=NULL;
  IF TG_TABLE_NAME IN ('lc_step_def','lc_staff') AND EXISTS(SELECT 1 FROM app.assistant_own_leave_review r WHERE r.tenant_id=(row_data->>'tenant_id')::uuid AND r.action_kind IN ('lifecycle.offboarding.step.complete','lifecycle.offboarding.step.undo') AND r.state='completed' AND r.offboarding_step_version=pg_current_xact_id()::xid::text) THEN RAISE EXCEPTION 'Lifecycle review unavailable' USING ERRCODE='42501';END IF;
  IF TG_TABLE_NAME='lc_case' THEN case_id:=(row_data->>'id')::uuid;
  ELSIF TG_TABLE_NAME IN ('lc_case_step','lc_comment','it_requisition') THEN case_id:=(row_data->>'case_id')::uuid;
  ELSIF TG_TABLE_NAME IN ('it_requisition_item','it_asset') THEN
   parent_id:=(row_data->>'requisition_id')::uuid;
   SELECT q.case_id INTO case_id FROM public.it_requisition q WHERE q.id=parent_id;
  ELSIF TG_TABLE_NAME='domain_event' AND row_data->>'aggregate_type'='lifecycle-case' THEN case_id:=(row_data->>'aggregate_id')::uuid;
  ELSIF TG_TABLE_NAME='domain_event' AND row_data->>'aggregate_type'='lifecycle-requisition' THEN SELECT q.case_id INTO case_id FROM public.it_requisition q WHERE q.id=(row_data->>'aggregate_id')::uuid;
  ELSIF TG_TABLE_NAME='domain_event' AND row_data->>'aggregate_type'='lifecycle-asset' THEN SELECT q.case_id INTO case_id FROM public.it_asset a JOIN public.it_requisition q ON q.id=a.requisition_id WHERE a.id=(row_data->>'aggregate_id')::uuid;
  ELSIF TG_TABLE_NAME='lc_history' AND row_data->>'ref_type'='case' THEN case_id:=(row_data->>'ref_id')::uuid;
  ELSIF TG_TABLE_NAME='lc_history' AND row_data->>'ref_type'='requisition' THEN SELECT q.case_id INTO case_id FROM public.it_requisition q WHERE q.id=(row_data->>'ref_id')::uuid;
  ELSIF TG_TABLE_NAME='lc_history' AND row_data->>'ref_type'='asset' THEN SELECT q.case_id INTO case_id FROM public.it_asset a JOIN public.it_requisition q ON q.id=a.requisition_id WHERE a.id=(row_data->>'ref_id')::uuid;
  END IF;
  IF case_id IS NOT NULL AND EXISTS(SELECT 1 FROM app.assistant_own_leave_review r
   WHERE r.action_kind IN ('lifecycle.offboarding.step.complete','lifecycle.offboarding.step.undo') AND r.state='completed'
    AND r.lifecycle_case_id=case_id AND r.offboarding_step_version=pg_current_xact_id()::xid::text) THEN
   RAISE EXCEPTION 'Lifecycle review unavailable' USING ERRCODE='42501';END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END $$;
REVOKE ALL ON FUNCTION app._assistant_step_domain_fence() FROM PUBLIC,ai_hr_app;
DO $$ DECLARE table_name text;BEGIN
 FOREACH table_name IN ARRAY ARRAY['lc_case','lc_case_step','lc_comment','it_requisition','it_requisition_item','it_asset','domain_event','lc_history','lc_step_def','lc_staff'] LOOP
  EXECUTE format('CREATE TRIGGER assistant_step_root_fence BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION app._assistant_step_domain_fence()',table_name);
  EXECUTE format('CREATE TRIGGER assistant_step_root_fence_after AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION app._assistant_step_domain_fence()',table_name);
 END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION app._assistant_step_body_fence() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM app.assistant_own_leave_review r WHERE r.id=NEW.action_id
  AND r.action_kind IN ('lifecycle.offboarding.step.complete','lifecycle.offboarding.step.undo') AND r.state='completed'
  AND r.offboarding_step_version=pg_current_xact_id()::xid::text) THEN
  RAISE EXCEPTION 'Lifecycle review unavailable' USING ERRCODE='42501';END IF;
 RETURN NEW;END $$;
REVOKE ALL ON FUNCTION app._assistant_step_body_fence() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER assistant_step_body_fence BEFORE INSERT OR UPDATE ON app.assistant_own_leave_review_content
 FOR EACH ROW EXECUTE FUNCTION app._assistant_step_body_fence();
CREATE TRIGGER assistant_step_body_fence_after AFTER INSERT OR UPDATE ON app.assistant_own_leave_review_content
 FOR EACH ROW EXECUTE FUNCTION app._assistant_step_body_fence();
--> statement-breakpoint
CREATE FUNCTION app.assistant_offboarding_step_source(p_case uuid,p_step text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c public.lc_case%ROWTYPE;item record;stamp text; BEGIN
 PERFORM app._assistant_lifecycle_review_identity(NULL,false);
 IF p_step IS NULL OR length(p_step) NOT BETWEEN 1 AND 100 OR p_step='resign_outcome' THEN RAISE EXCEPTION 'Lifecycle review unavailable' USING ERRCODE='42501';END IF;
 -- Protect definition insert/delete phantoms as well as updates; fail fast rather than wait on config edits.
 LOCK TABLE public.lc_staff IN SHARE MODE NOWAIT;
 LOCK TABLE public.lc_step_def IN SHARE MODE NOWAIT;
 SELECT * INTO c FROM public.lc_case WHERE id=p_case AND tenant_id=app.current_tenant_id() AND kind='offboarding' FOR UPDATE NOWAIT;
 IF NOT FOUND OR c.status='cancelled' OR coalesce(app.lc_level(c.company_id),0)<1 THEN RAISE EXCEPTION 'Lifecycle review unavailable' USING ERRCODE='42501';END IF;
 FOR item IN SELECT id,tenant_id,company_id FROM public.it_requisition WHERE case_id=p_case ORDER BY id FOR UPDATE NOWAIT LOOP
  IF item.tenant_id<>app.current_tenant_id() OR coalesce(app.lc_level(item.company_id),0)<1 THEN RAISE EXCEPTION 'Lifecycle review unavailable' USING ERRCODE='42501';END IF;
 END LOOP;
 PERFORM 1 FROM public.lc_case_step WHERE case_id=p_case ORDER BY step_key FOR SHARE NOWAIT;
 PERFORM 1 FROM public.lc_comment WHERE case_id=p_case ORDER BY id FOR SHARE NOWAIT;
 PERFORM 1 FROM public.it_requisition_item a JOIN public.it_requisition q ON q.id=a.requisition_id WHERE q.case_id=p_case ORDER BY a.requisition_id,a.item_key FOR SHARE OF a NOWAIT;
 FOR item IN SELECT a.id,a.tenant_id,a.company_id FROM public.it_asset a JOIN public.it_requisition q ON q.id=a.requisition_id WHERE q.case_id=p_case ORDER BY a.id FOR SHARE OF a NOWAIT LOOP
  IF item.tenant_id<>app.current_tenant_id() OR coalesce(app.lc_level(item.company_id),0)<1 THEN RAISE EXCEPTION 'Lifecycle review unavailable' USING ERRCODE='42501';END IF;
 END LOOP;

 SELECT encode(sha256(convert_to(jsonb_build_array(app._assistant_step_effect(c.id,p_step,false,false,NULL,NULL,NULL,false),app._assistant_step_json(c),(SELECT xmin::text FROM public.lc_case WHERE id=c.id),
  (SELECT coalesce(jsonb_agg(jsonb_build_array(d.xmin::text,app._assistant_step_json(d)) ORDER BY d.id),'[]'::jsonb) FROM public.lc_step_def d WHERE d.tenant_id=c.tenant_id AND d.kind='offboarding'),
  (SELECT coalesce(jsonb_agg(jsonb_build_array(a.xmin::text,app._assistant_step_json(a)) ORDER BY a.step_key),'[]'::jsonb) FROM public.lc_case_step a WHERE a.tenant_id=c.tenant_id AND a.case_id=c.id))::text,'UTF8')),'hex') INTO stamp;
 RETURN jsonb_build_object('caseId',c.id,'caseNumber',c.number,'casePersonId',c.person_id,'employmentId',c.employment_id,'companyId',c.company_id,'stepKey',p_step,'status',c.status,'sourceDigest',stamp);
END $$;
REVOKE ALL ON FUNCTION app.assistant_offboarding_step_source(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_offboarding_step_source(uuid,text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._assistant_offboarding_step_review_json(p_id uuid) RETURNS jsonb
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('metadata',jsonb_build_object('actionId',r.id,'action',r.action_kind,'contractVersion',1,
 'binding',jsonb_build_object('tenantId',r.tenant_id,'userId',r.user_id,'personId',r.person_id,'employmentId',r.employment_id,'companyId',r.company_id,'caseId',r.lifecycle_case_id,'casePersonId',r.lifecycle_case_person_id,'stepKey',r.offboarding_step_key),
 'intentDigest',r.intent_digest,'reviewedDigest',r.reviewed_digest,'state',r.state,'createdAt',to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'expiresAt',to_char(r.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
 'sealed',CASE WHEN r.state='awaiting_confirmation' AND c.action_id IS NOT NULL THEN jsonb_build_object('formatVersion',1,'kid',c.kid,'wrappedDek',c.wrapped_dek,'ciphertext',c.ciphertext) ELSE NULL END,
 'eventId',r.lifecycle_submitted_event_id,'completionEventId',r.offboarding_completion_event_id,'expectedCompletion',r.offboarding_expect_completion)
 FROM app.assistant_own_leave_review r LEFT JOIN app.assistant_own_leave_review_content c ON c.action_id=r.id WHERE r.id=p_id AND r.person_id IS NOT DISTINCT FROM (SELECT a.person_id FROM public.app_user a WHERE a.id=app.current_user_id() AND a.tenant_id=app.current_tenant_id()) AND r.action_kind='lifecycle.offboarding.step.complete';
$$;
REVOKE ALL ON FUNCTION app._assistant_offboarding_step_review_json(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Public native pure-data integrity anchor; catalogue remains owned by lifecycle-defaults.ts.
-- SQL contains only its reviewed canonical JSON-byte digest, never a second fallback label list.
-- Native projection: JSON.stringify(defaultStepDefs('offboarding').map(({key,label})=>({key,label}))).
CREATE FUNCTION app._assistant_step_label(p_step text,p_defaults text) RETURNS text
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE label text;BEGIN
 IF EXISTS(SELECT 1 FROM public.lc_step_def d WHERE d.tenant_id=app.current_tenant_id() AND d.kind='offboarding') THEN
  -- Native ordering/.find remains native-owned. Ambiguous multi-company keys need its UI.
  IF (SELECT count(*) FROM public.lc_step_def d WHERE d.tenant_id=app.current_tenant_id() AND d.kind='offboarding' AND d.step_key=p_step AND d.active)>1 THEN RAISE EXCEPTION 'Lifecycle review unavailable' USING ERRCODE='42501';END IF;
  SELECT d.label INTO label FROM public.lc_step_def d WHERE d.tenant_id=app.current_tenant_id() AND d.kind='offboarding' AND d.step_key=p_step AND d.active;
 ELSE
  IF p_defaults IS NULL OR octet_length(p_defaults)>32768 OR encode(sha256(convert_to(p_defaults,'UTF8')),'hex')<>'98000f93b4b7afe5d4efe07eb581b5d0f037109b5942a3131fbbe0f6b51413d0' THEN RAISE EXCEPTION 'Lifecycle review unavailable' USING ERRCODE='42501';END IF;
  SELECT item->>'label' INTO label FROM jsonb_array_elements(p_defaults::jsonb) item WHERE item->>'key'=p_step;
 END IF;
 IF label IS NULL OR length(label) NOT BETWEEN 1 AND 300 THEN RAISE EXCEPTION 'Lifecycle review unavailable' USING ERRCODE='42501';END IF;
 RETURN label;
END $$;
REVOKE ALL ON FUNCTION app._assistant_step_label(text,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_offboarding_step_review_prepare(p_id uuid,p_person uuid,p_case uuid,p_case_person uuid,p_employment uuid,p_company uuid,p_step text,p_expect_completion boolean,p_reference text,p_notes text,p_defaults text,
 p_intent_digest text,p_reviewed_digest text,p_kid text,p_wrapped_dek text,p_ciphertext text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source jsonb;at_time timestamptz;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();
BEGIN
 PERFORM app._assistant_lifecycle_review_identity(p_person);
 source:=app.assistant_offboarding_step_source(p_case,p_step);
 IF source->>'status'<>'in_progress' OR p_expect_completion IS NULL OR EXISTS(SELECT 1 FROM public.lc_case_step WHERE tenant_id=t AND case_id=p_case AND step_key=p_step AND done) THEN RAISE EXCEPTION 'Lifecycle review unavailable' USING ERRCODE='42501';END IF;
 IF (source->>'casePersonId')::uuid IS DISTINCT FROM p_case_person OR (source->>'employmentId')::uuid IS DISTINCT FROM p_employment OR (source->>'companyId')::uuid IS DISTINCT FROM p_company THEN RAISE EXCEPTION 'Lifecycle review unavailable' USING ERRCODE='42501';END IF;
 -- A preparation in the same privacy-erasure transaction must not create new uncaptured private text.
 IF EXISTS(SELECT 1 FROM app.home_greeting_erasure_intent i WHERE i.xact_id=pg_current_xact_id()
  AND i.tenant_id=t AND (i.person_id=p_person OR i.person_id=p_case_person OR app._assistant_lifecycle_review_person(p_case,i.person_id,t)))
  OR EXISTS(SELECT 1 FROM app.assistant_review_erasure_intent i WHERE i.xact_id=pg_current_xact_id()
   AND i.tenant_id=t AND (i.person_id=p_person OR i.person_id=p_case_person OR app._assistant_lifecycle_review_person(p_case,i.person_id,t))) THEN
  RAISE EXCEPTION 'Own-leave review unavailable' USING ERRCODE='42501';END IF;
 IF p_id IS NULL OR p_intent_digest IS NULL OR p_intent_digest !~ '^[a-f0-9]{64}$'
  OR p_reviewed_digest IS NULL OR p_reviewed_digest !~ '^[a-f0-9]{64}$' OR p_kid IS NULL OR p_kid !~ '^[a-f0-9]{16}$'
  OR p_wrapped_dek IS NULL OR length(p_wrapped_dek) NOT BETWEEN 1 AND 512
  OR p_ciphertext IS NULL OR octet_length(p_ciphertext) NOT BETWEEN 1 AND 65536 THEN
  RAISE EXCEPTION 'Own-leave review unavailable' USING ERRCODE='22023';END IF;
 IF p_reference IS DISTINCT FROM nullif(btrim(left(p_reference,100)),'') OR p_notes IS DISTINCT FROM nullif(btrim(left(p_notes,2000)),'') THEN RAISE EXCEPTION 'Lifecycle review unavailable' USING ERRCODE='22023';END IF;
 at_time:=clock_timestamp();
 -- Private review admission is separate from model quota. The identity owner already holds the
 -- tenant Access lock, serializing competing preparations and privacy/custody transitions. Bounds
 -- apply to this login only: at most five unexpired pending reviews and twenty preparations per
 -- rolling ten minutes. Discard/expiry cannot reset the creation-rate budget. SQL owns every time.
 IF (SELECT count(*) FROM app.assistant_own_leave_review WHERE tenant_id=t AND user_id=u
   AND state='awaiting_confirmation' AND expires_at>at_time)>=5
  OR (SELECT count(*) FROM app.assistant_own_leave_review WHERE tenant_id=t AND user_id=u
   AND created_at>at_time-interval '10 minutes')>=20 THEN
  RAISE EXCEPTION 'Own-leave review unavailable' USING ERRCODE='54000';END IF;
 INSERT INTO app.assistant_own_leave_review
  (action_kind,id,tenant_id,user_id,person_id,employment_id,company_id,lifecycle_case_id,lifecycle_case_person_id,offboarding_step_key,offboarding_expect_completion,offboarding_step_effect_commitment,intent_digest,reviewed_digest,state,created_at,expires_at)
 VALUES('lifecycle.offboarding.step.complete',p_id,t,u,p_person,p_employment,p_company,p_case,p_case_person,p_step,p_expect_completion,app._assistant_step_effect(p_case,p_step,true,p_expect_completion,p_reference,p_notes,jsonb_build_object('step',app._assistant_step_label(p_step,p_defaults),'key',p_step,'reference',p_reference),true),
  p_intent_digest,p_reviewed_digest,'awaiting_confirmation',at_time,at_time+interval '10 minutes') ON CONFLICT(id) DO NOTHING;
 IF NOT FOUND THEN RAISE EXCEPTION 'Own-leave review unavailable' USING ERRCODE='42501';END IF;
 INSERT INTO app.assistant_own_leave_review_content VALUES(p_id,p_kid,p_wrapped_dek,p_ciphertext);
 RETURN app._assistant_offboarding_step_review_json(p_id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_offboarding_step_review_prepare(uuid,uuid,uuid,uuid,uuid,uuid,text,boolean,text,text,text,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_offboarding_step_review_prepare(uuid,uuid,uuid,uuid,uuid,uuid,text,boolean,text,text,text,text,text,text,text,text) TO ai_hr_app;

--> statement-breakpoint
-- Nomination-only current login metadata; no body/case facts before the source-owned interval.
CREATE FUNCTION app.assistant_offboarding_step_review_subject(p_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;
BEGIN
 PERFORM app._assistant_lifecycle_review_identity(NULL,false);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND person_id IS NOT DISTINCT FROM (SELECT person_id FROM public.app_user WHERE id=app.current_user_id() AND tenant_id=app.current_tenant_id()) AND action_kind='lifecycle.offboarding.step.complete';
 IF NOT FOUND THEN RAISE EXCEPTION 'Lifecycle review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_lifecycle_review_identity(r.person_id);RETURN jsonb_build_object('caseId',r.lifecycle_case_id,'stepKey',r.offboarding_step_key);
END $$;
REVOKE ALL ON FUNCTION app.assistant_offboarding_step_review_subject(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_offboarding_step_review_subject(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_offboarding_step_review_read(p_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;source jsonb;
BEGIN
 PERFORM app._assistant_lifecycle_review_identity(NULL,false);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND person_id IS NOT DISTINCT FROM (SELECT person_id FROM public.app_user WHERE id=app.current_user_id() AND tenant_id=app.current_tenant_id()) AND action_kind='lifecycle.offboarding.step.complete';
 IF NOT FOUND THEN RAISE EXCEPTION 'Lifecycle review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_lifecycle_review_identity(r.person_id);source:=app.assistant_offboarding_step_source(r.lifecycle_case_id,r.offboarding_step_key);
 IF (source->>'casePersonId')::uuid IS DISTINCT FROM r.lifecycle_case_person_id OR (source->>'employmentId')::uuid IS DISTINCT FROM r.employment_id OR (source->>'companyId')::uuid IS DISTINCT FROM r.company_id THEN RAISE EXCEPTION 'Lifecycle review unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=r.id FOR UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Lifecycle review unavailable' USING ERRCODE='42501';END IF;
 IF r.state='awaiting_confirmation' AND clock_timestamp()>=r.expires_at THEN UPDATE app.assistant_own_leave_review SET state='expired',intent_digest=NULL,reviewed_digest=NULL WHERE id=r.id;END IF;
 DELETE FROM app.assistant_own_leave_review_content c USING app.assistant_own_leave_review a WHERE c.action_id=a.id AND a.id=r.id AND a.state<>'awaiting_confirmation';
 RETURN app._assistant_offboarding_step_review_json(r.id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_offboarding_step_review_read(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_offboarding_step_review_read(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_offboarding_step_review_complete(p_id uuid,p_reviewed_digest text,p_case uuid,p_event uuid,p_completion uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;actual app.assistant_own_leave_review%ROWTYPE;v_case text;v_step text;expected text;actual_effect text;clock_image jsonb;audit_image jsonb;source jsonb;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();
BEGIN
 PERFORM app._assistant_lifecycle_review_identity(NULL,false);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=t AND user_id=u AND person_id IS NOT DISTINCT FROM (SELECT person_id FROM public.app_user WHERE id=app.current_user_id() AND tenant_id=app.current_tenant_id()) AND action_kind='lifecycle.offboarding.step.complete';
 IF NOT FOUND OR p_case IS NULL OR p_case IS DISTINCT FROM r.lifecycle_case_id OR p_event IS NULL THEN RAISE EXCEPTION 'Lifecycle review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_lifecycle_review_identity(r.person_id);source:=app.assistant_offboarding_step_source(p_case,r.offboarding_step_key);
 IF (source->>'casePersonId')::uuid IS DISTINCT FROM r.lifecycle_case_person_id OR (source->>'employmentId')::uuid IS DISTINCT FROM r.employment_id OR (source->>'companyId')::uuid IS DISTINCT FROM r.company_id THEN RAISE EXCEPTION 'Lifecycle review unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=r.id FOR UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Lifecycle review unavailable' USING ERRCODE='42501';END IF;
 IF r.state='completed' THEN
  IF r.lifecycle_submitted_event_id IS DISTINCT FROM p_event OR r.offboarding_completion_event_id IS DISTINCT FROM p_completion THEN RAISE EXCEPTION 'Lifecycle review unavailable' USING ERRCODE='42501';END IF;
 ELSIF r.state='awaiting_confirmation' AND clock_timestamp()<r.expires_at THEN
  IF p_reviewed_digest IS DISTINCT FROM r.reviewed_digest THEN RAISE EXCEPTION 'Lifecycle review unavailable' USING ERRCODE='42501';END IF;
  IF (p_completion IS NOT NULL) IS DISTINCT FROM r.offboarding_expect_completion OR p_event=p_completion THEN RAISE EXCEPTION 'Lifecycle review unavailable' USING ERRCODE='42501';END IF;
  IF NOT EXISTS(SELECT 1 FROM public.lc_case c JOIN public.lc_case_step a ON a.case_id=c.id AND a.tenant_id=c.tenant_id AND a.step_key=r.offboarding_step_key AND a.done AND a.done_at IS NOT NULL AND isfinite(a.done_at) AND a.done_at>=r.created_at AND a.done_at<=clock_timestamp() AND a.done_by=u
   JOIN public.domain_event d ON d.id=p_event AND d.tenant_id=c.tenant_id AND d.aggregate_type='lifecycle-case' AND d.aggregate_id=c.id AND d.event_type='lifecycle-case.step-done' AND d.actor_type='user' AND d.actor_id=u
    AND d.subject_employment_id IS NOT DISTINCT FROM c.employment_id AND d.payload=jsonb_build_object('action','step.done','number',c.number,'step',a.step_key) AND d.occurred_at=transaction_timestamp()
   JOIN public.lc_history h ON h.ref_type='case' AND h.ref_id=c.id AND h.tenant_id=c.tenant_id AND h.action='step.done' AND h.actor_user_id=u AND h.detail->>'key'=a.step_key AND h.at=transaction_timestamp()
   WHERE c.id=p_case AND c.tenant_id=t AND c.kind='offboarding' AND c.status=CASE WHEN r.offboarding_expect_completion THEN 'completed' ELSE 'in_progress' END
    AND c.person_id IS NOT DISTINCT FROM r.lifecycle_case_person_id AND c.employment_id IS NOT DISTINCT FROM r.employment_id AND c.company_id=r.company_id
    AND a.xmin=pg_current_xact_id()::xid AND h.xmin=pg_current_xact_id()::xid AND d.xmin=pg_current_xact_id()::xid) THEN RAISE EXCEPTION 'Lifecycle review unavailable' USING ERRCODE='42501';END IF;
  IF r.offboarding_expect_completion THEN
   IF NOT EXISTS(SELECT 1 FROM public.domain_event d JOIN public.lc_case c ON c.id=d.aggregate_id AND c.tenant_id=d.tenant_id
    JOIN public.lc_history h ON h.ref_id=c.id AND h.tenant_id=c.tenant_id AND h.ref_type='case' AND h.action='case.completed' AND h.actor_user_id=u AND h.xmin=pg_current_xact_id()::xid AND h.at=transaction_timestamp()
    WHERE d.id=p_completion AND c.id=p_case AND c.tenant_id=t AND c.status='completed' AND c.completed_at IS NOT NULL AND isfinite(c.completed_at) AND c.completed_at>=r.created_at AND c.completed_at<=clock_timestamp() AND c.completed_at>=(SELECT a.done_at FROM public.lc_case_step a WHERE a.case_id=c.id AND a.step_key=r.offboarding_step_key) AND c.xmin=pg_current_xact_id()::xid
     AND d.aggregate_type='lifecycle-case' AND d.event_type='lifecycle-case.completed' AND d.actor_type='user' AND d.actor_id=u AND d.subject_employment_id IS NOT DISTINCT FROM c.employment_id
     AND d.occurred_at=transaction_timestamp() AND d.payload=jsonb_build_object('action','case.completed','number',c.number,'kind','offboarding') AND d.xmin=pg_current_xact_id()::xid)
    THEN RAISE EXCEPTION 'Lifecycle review unavailable' USING ERRCODE='42501';END IF;
  ELSIF EXISTS(SELECT 1 FROM public.domain_event d WHERE d.tenant_id=t AND d.aggregate_id=p_case AND d.event_type='lifecycle-case.completed' AND d.xmin=pg_current_xact_id()::xid) THEN RAISE EXCEPTION 'Lifecycle review unavailable' USING ERRCODE='42501';END IF;
  -- Exactly one original native step history/event plus the separately consented derived pair.
  -- Related IT event/history and duplicate native entries are unsupported, even if rows are unchanged.
  IF (SELECT count(*) FROM public.domain_event d JOIN public.lc_case c ON c.id=p_case WHERE d.tenant_id=t AND (d.aggregate_type='lifecycle-case' AND d.aggregate_id=c.id OR d.aggregate_type='lifecycle-requisition' AND d.aggregate_id IN (SELECT id FROM public.it_requisition WHERE case_id=c.id) OR d.aggregate_type='lifecycle-asset' AND d.aggregate_id IN (SELECT a.id FROM public.it_asset a JOIN public.it_requisition q ON q.id=a.requisition_id WHERE q.case_id=c.id)) AND d.xmin=pg_current_xact_id()::xid)<>(1+CASE WHEN r.offboarding_expect_completion THEN 1 ELSE 0 END)
   OR (SELECT count(*) FROM public.lc_history h JOIN public.lc_case c ON c.id=p_case WHERE h.tenant_id=t AND (h.ref_type='case' AND h.ref_id=c.id OR h.ref_type='requisition' AND h.ref_id IN (SELECT id FROM public.it_requisition WHERE case_id=c.id) OR h.ref_type='asset' AND h.ref_id IN (SELECT a.id FROM public.it_asset a JOIN public.it_requisition q ON q.id=a.requisition_id WHERE q.case_id=c.id)) AND h.xmin=pg_current_xact_id()::xid)<>(1+CASE WHEN r.offboarding_expect_completion THEN 1 ELSE 0 END) THEN RAISE EXCEPTION 'Lifecycle review unavailable' USING ERRCODE='42501';END IF;
  SELECT c.xmin::text,a.xmin::text INTO v_case,v_step FROM public.lc_case c JOIN public.lc_case_step a ON a.case_id=c.id AND a.step_key=r.offboarding_step_key WHERE c.id=p_case;
  actual_effect:=app._assistant_step_effect(p_case,r.offboarding_step_key,true,r.offboarding_expect_completion,NULL,NULL,NULL,false);
  IF actual_effect IS DISTINCT FROM r.offboarding_step_effect_commitment THEN RAISE EXCEPTION 'Lifecycle review unavailable' USING ERRCODE='42501';END IF;
  SELECT jsonb_build_array(app._assistant_step_json(c),app._assistant_step_json(a)) INTO clock_image FROM public.lc_case c JOIN public.lc_case_step a ON a.case_id=c.id AND a.step_key=r.offboarding_step_key WHERE c.id=p_case;
  SELECT jsonb_build_array((SELECT jsonb_agg(app._assistant_step_json(d) ORDER BY d.id) FROM public.domain_event d WHERE d.tenant_id=t AND (d.aggregate_type='lifecycle-case' AND d.aggregate_id=p_case OR d.aggregate_type='lifecycle-requisition' AND d.aggregate_id IN (SELECT id FROM public.it_requisition WHERE case_id=p_case) OR d.aggregate_type='lifecycle-asset' AND d.aggregate_id IN (SELECT a.id FROM public.it_asset a JOIN public.it_requisition q ON q.id=a.requisition_id WHERE q.case_id=p_case)) AND d.xmin=pg_current_xact_id()::xid),(SELECT jsonb_agg(app._assistant_step_json(h) ORDER BY h.id) FROM public.lc_history h WHERE h.tenant_id=t AND (h.ref_type='case' AND h.ref_id=p_case OR h.ref_type='requisition' AND h.ref_id IN (SELECT id FROM public.it_requisition WHERE case_id=p_case) OR h.ref_type='asset' AND h.ref_id IN (SELECT a.id FROM public.it_asset a JOIN public.it_requisition q ON q.id=a.requisition_id WHERE q.case_id=p_case)) AND h.xmin=pg_current_xact_id()::xid)) INTO audit_image;
  expected:=r.offboarding_step_effect_commitment;
  UPDATE app.assistant_own_leave_review SET state='completed',intent_digest=NULL,reviewed_digest=NULL,lifecycle_submitted_event_id=p_event,offboarding_completion_event_id=p_completion,offboarding_step_case_version=v_case,offboarding_step_version=v_step WHERE id=r.id;
  DELETE FROM app.assistant_own_leave_review_content WHERE action_id=r.id;
  SELECT * INTO actual FROM app.assistant_own_leave_review WHERE id=r.id;
  IF NOT FOUND OR clock_timestamp()>=r.expires_at OR to_jsonb(actual) IS DISTINCT FROM (to_jsonb(r)||jsonb_build_object('state','completed','intent_digest',NULL,'reviewed_digest',NULL,'lifecycle_submitted_event_id',p_event,'offboarding_completion_event_id',p_completion,'offboarding_step_effect_commitment',NULL,'offboarding_step_case_version',v_case,'offboarding_step_version',v_step))
   OR audit_image IS DISTINCT FROM (SELECT jsonb_build_array((SELECT jsonb_agg(app._assistant_step_json(d) ORDER BY d.id) FROM public.domain_event d WHERE d.tenant_id=t AND (d.aggregate_type='lifecycle-case' AND d.aggregate_id=p_case OR d.aggregate_type='lifecycle-requisition' AND d.aggregate_id IN (SELECT id FROM public.it_requisition WHERE case_id=p_case) OR d.aggregate_type='lifecycle-asset' AND d.aggregate_id IN (SELECT a.id FROM public.it_asset a JOIN public.it_requisition q ON q.id=a.requisition_id WHERE q.case_id=p_case)) AND d.xmin=pg_current_xact_id()::xid),(SELECT jsonb_agg(app._assistant_step_json(h) ORDER BY h.id) FROM public.lc_history h WHERE h.tenant_id=t AND (h.ref_type='case' AND h.ref_id=p_case OR h.ref_type='requisition' AND h.ref_id IN (SELECT id FROM public.it_requisition WHERE case_id=p_case) OR h.ref_type='asset' AND h.ref_id IN (SELECT a.id FROM public.it_asset a JOIN public.it_requisition q ON q.id=a.requisition_id WHERE q.case_id=p_case)) AND h.xmin=pg_current_xact_id()::xid)))
   OR clock_image IS DISTINCT FROM (SELECT jsonb_build_array(app._assistant_step_json(c),app._assistant_step_json(a)) FROM public.lc_case c JOIN public.lc_case_step a ON a.case_id=c.id AND a.step_key=r.offboarding_step_key WHERE c.id=p_case)
   OR EXISTS(SELECT 1 FROM app.assistant_own_leave_review_content WHERE action_id=r.id)
   OR app._assistant_step_effect(p_case,r.offboarding_step_key,true,r.offboarding_expect_completion,NULL,NULL,NULL,false) IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Lifecycle review unavailable' USING ERRCODE='42501';END IF;
 ELSE RAISE EXCEPTION 'Lifecycle review unavailable' USING ERRCODE='42501';END IF;
 RETURN app._assistant_offboarding_step_review_json(r.id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_offboarding_step_review_complete(uuid,text,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_offboarding_step_review_complete(uuid,text,uuid,uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_offboarding_step_review_discard(p_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;
BEGIN
 PERFORM app._assistant_lifecycle_review_identity(NULL,false);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND person_id IS NOT DISTINCT FROM (SELECT person_id FROM public.app_user WHERE id=app.current_user_id() AND tenant_id=app.current_tenant_id()) AND action_kind='lifecycle.offboarding.step.complete' FOR UPDATE NOWAIT;
 IF NOT FOUND OR r.state='completed' THEN RAISE EXCEPTION 'Lifecycle review unavailable' USING ERRCODE='42501';END IF;
 IF r.state='awaiting_confirmation' THEN
  UPDATE app.assistant_own_leave_review SET state=CASE WHEN clock_timestamp()>=r.expires_at THEN 'expired' ELSE 'discarded' END,intent_digest=NULL,reviewed_digest=NULL WHERE id=r.id;
 END IF;
 DELETE FROM app.assistant_own_leave_review_content WHERE action_id=r.id;
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=r.id;
 RETURN jsonb_build_object('action','lifecycle.offboarding.step.complete','contractVersion',1,'actionId',r.id,'state',r.state);
END $$;
REVOKE ALL ON FUNCTION app.assistant_offboarding_step_review_discard(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_offboarding_step_review_discard(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_offboarding_step_reviews_index() RETURNS TABLE(action text,action_id uuid,state text,created_at timestamptz,expires_at timestamptz)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM app._assistant_lifecycle_review_identity(NULL,false);
 RETURN QUERY SELECT r.action_kind,r.id,r.state,r.created_at,r.expires_at FROM app.assistant_own_leave_review r WHERE r.tenant_id=app.current_tenant_id() AND r.user_id=app.current_user_id() AND r.person_id IS NOT DISTINCT FROM (SELECT a.person_id FROM public.app_user a WHERE a.id=app.current_user_id() AND a.tenant_id=app.current_tenant_id()) AND r.action_kind='lifecycle.offboarding.step.complete' ORDER BY r.created_at DESC,r.id DESC LIMIT 25;
END $$;
REVOKE ALL ON FUNCTION app.assistant_offboarding_step_reviews_index() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_offboarding_step_reviews_index() TO ai_hr_app;

--> statement-breakpoint
--> statement-breakpoint
CREATE FUNCTION app.assistant_offboarding_step_reference(p_case uuid,p_step text,p_event uuid,p_completion uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source jsonb;c public.lc_case%ROWTYPE; BEGIN
 source:=app.assistant_offboarding_step_source(p_case,p_step);
 SELECT * INTO c FROM public.lc_case WHERE id=p_case AND tenant_id=app.current_tenant_id();
 IF NOT EXISTS(SELECT 1 FROM public.lc_case_step a JOIN public.domain_event d ON d.aggregate_id=a.case_id AND d.tenant_id=a.tenant_id
  WHERE a.case_id=c.id AND a.tenant_id=c.tenant_id AND a.step_key=p_step AND a.done AND a.done_by=app.current_user_id()
   AND d.id=p_event AND d.aggregate_type='lifecycle-case' AND d.event_type='lifecycle-case.step-done' AND d.actor_type='user' AND d.actor_id=app.current_user_id()
   AND d.subject_employment_id IS NOT DISTINCT FROM c.employment_id AND d.payload=jsonb_build_object('action','step.done','number',c.number,'step',p_step))
  OR (p_completion IS NOT NULL AND (c.status<>'completed' OR NOT EXISTS(SELECT 1 FROM public.domain_event d WHERE d.id=p_completion AND d.tenant_id=c.tenant_id AND d.aggregate_id=c.id AND d.aggregate_type='lifecycle-case' AND d.event_type='lifecycle-case.completed' AND d.actor_type='user' AND d.actor_id=app.current_user_id() AND d.subject_employment_id IS NOT DISTINCT FROM c.employment_id)))
 OR NOT EXISTS(SELECT 1 FROM app.assistant_own_leave_review r JOIN public.lc_case_step a ON a.case_id=r.lifecycle_case_id AND a.step_key=r.offboarding_step_key
  WHERE r.action_kind='lifecycle.offboarding.step.complete' AND r.state='completed' AND r.tenant_id=c.tenant_id AND r.user_id=app.current_user_id()
   AND r.lifecycle_case_id=c.id AND r.lifecycle_submitted_event_id=p_event AND r.offboarding_completion_event_id IS NOT DISTINCT FROM p_completion
   AND r.offboarding_step_version=a.xmin::text AND r.offboarding_step_case_version=(SELECT x.xmin::text FROM public.lc_case x WHERE x.id=c.id))
 THEN RAISE EXCEPTION 'Lifecycle review unavailable' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('caseId',c.id,'stepKey',p_step,'status',CASE WHEN p_completion IS NOT NULL THEN 'completed' ELSE 'in_progress' END,'stepEventId',p_event,'completionEventId',p_completion);
END $$;
REVOKE ALL ON FUNCTION app.assistant_offboarding_step_reference(uuid,text,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_offboarding_step_reference(uuid,text,uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
-- Extend only the three closed learning/discovery owner mappings; preserve all predecessor bodies.
DO $$ DECLARE target regprocedure;definition text;marker text;replacement text; BEGIN
 FOR target IN SELECT signature::regprocedure FROM unnest(ARRAY[
  'app.native_outcome_review_completed(text,uuid)',
  'app.native_outcome_targets_require(uuid,uuid,uuid,text,uuid,uuid)',
  'app.native_outcome_completed_review_choices(jsonb)']) signature LOOP
  definition:=pg_get_functiondef(target);
  IF target='app.native_outcome_targets_require(uuid,uuid,uuid,text,uuid,uuid)'::regprocedure THEN
   marker:='WHEN ''lifecycle.acknowledgement.submit'' THEN r.lifecycle_submitted_event_id';
   replacement:=marker||' WHEN ''lifecycle.offboarding.step.complete'' THEN r.lifecycle_submitted_event_id';
  ELSE marker:='''lifecycle.acknowledgement.submit''';replacement:=marker||',''lifecycle.offboarding.step.complete'''; END IF;
  IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION '0735: unexpected outcome mapping %',target;END IF;
  EXECUTE replace(definition,marker,replacement);
 END LOOP;
END $$;
