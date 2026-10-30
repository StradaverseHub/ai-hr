-- UNAPPLIED PROVISIONAL development compatibility allocation0754/idx733/when1793330000091.
-- Original0734/0744 and all historical SQL remain immutable. Reconcile actual ledger at integration.
-- Four exact live-target FKs become immutable historical bindings. Event FKs remain.
DO $$
DECLARE binding record;constraint_row record;found_count integer;
BEGIN
 FOR binding IN SELECT * FROM (VALUES
  ('payroll_reopen_batch_id','public.payroll_batch'),
  ('payroll_reopen_period_id','public.pay_period'),
  ('payroll_reset_batch_id','public.payroll_batch'),
  ('payroll_reset_period_id','public.pay_period')
 ) AS names(column_name,target_name) LOOP
  SELECT count(*) INTO found_count FROM pg_constraint c JOIN pg_attribute a
   ON a.attrelid=c.conrelid AND a.attnum=c.conkey[1]
   WHERE c.conrelid='app.assistant_own_leave_review'::regclass AND c.contype='f'
    AND cardinality(c.conkey)=1 AND a.attname=binding.column_name
    AND c.confrelid=binding.target_name::regclass AND c.confdeltype='a';
  IF found_count<>1 THEN RAISE EXCEPTION 'Payroll review live-target FK drift: %',binding.column_name;END IF;
  SELECT c.conname INTO constraint_row FROM pg_constraint c JOIN pg_attribute a
   ON a.attrelid=c.conrelid AND a.attnum=c.conkey[1]
   WHERE c.conrelid='app.assistant_own_leave_review'::regclass AND c.contype='f'
    AND cardinality(c.conkey)=1 AND a.attname=binding.column_name
    AND c.confrelid=binding.target_name::regclass AND c.confdeltype='a';
  EXECUTE format('ALTER TABLE app.assistant_own_leave_review DROP CONSTRAINT %I',constraint_row.conname);
 END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.assistant_payroll_review_historical_binding() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE batch_id uuid;period_id uuid;
BEGIN
 IF TG_RELID<>'app.assistant_own_leave_review'::regclass OR TG_OP NOT IN('INSERT','UPDATE') THEN
  RAISE EXCEPTION 'Payroll review binding operation unavailable';
 END IF;
 IF TG_OP='UPDATE' AND (OLD.action_kind IN('payroll.reopen','payroll.reset') OR NEW.action_kind IN('payroll.reopen','payroll.reset')) THEN
  IF ROW(NEW.id,NEW.tenant_id,NEW.user_id,NEW.company_id,NEW.action_kind,
   NEW.payroll_reopen_batch_id,NEW.payroll_reopen_period_id,NEW.payroll_reset_batch_id,NEW.payroll_reset_period_id)
   IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.user_id,OLD.company_id,OLD.action_kind,
   OLD.payroll_reopen_batch_id,OLD.payroll_reopen_period_id,OLD.payroll_reset_batch_id,OLD.payroll_reset_period_id)
  THEN RAISE EXCEPTION 'Payroll review historical binding is immutable' USING ERRCODE='23514';END IF;
 ELSIF TG_OP='INSERT' AND NEW.action_kind IN('payroll.reopen','payroll.reset') THEN
  batch_id:=CASE WHEN NEW.action_kind='payroll.reopen' THEN NEW.payroll_reopen_batch_id ELSE NEW.payroll_reset_batch_id END;
  period_id:=CASE WHEN NEW.action_kind='payroll.reopen' THEN NEW.payroll_reopen_period_id ELSE NEW.payroll_reset_period_id END;
  -- Replace FK deletion concurrency protection, not just a snapshot EXISTS. Match native
  -- physical delete order: batch BEFORE optional parent. Both locks live until whole Tx end.
  PERFORM b.id FROM public.payroll_batch b
   WHERE b.id=batch_id AND b.tenant_id=NEW.tenant_id AND b.company_id=NEW.company_id
    AND b.pay_period_id=period_id FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payroll review target binding unavailable' USING ERRCODE='23503';END IF;
  PERFORM p.id FROM public.pay_period p JOIN public.payroll_batch b ON b.pay_period_id=p.id
   WHERE b.id=batch_id AND p.id=period_id AND b.tenant_id=NEW.tenant_id AND p.tenant_id=NEW.tenant_id
    AND b.company_id=NEW.company_id AND p.company_id=NEW.company_id AND p.period=b.pay_period
   FOR KEY SHARE OF p;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payroll review target binding unavailable' USING ERRCODE='23503';END IF;
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.assistant_payroll_review_historical_binding() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER assistant_payroll_review_historical_binding AFTER INSERT OR UPDATE ON app.assistant_own_leave_review
 FOR EACH ROW EXECUTE FUNCTION app.assistant_payroll_review_historical_binding();
--> statement-breakpoint
CREATE FUNCTION app.assistant_payroll_review_target_deleted() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE target_is_batch boolean;review_row record;
BEGIN
 IF TG_OP<>'DELETE' OR TG_RELID NOT IN('public.payroll_batch'::regclass,'public.pay_period'::regclass) THEN
  RAISE EXCEPTION 'Payroll review retirement operation unavailable';
 END IF;
 target_is_batch:=TG_RELID='public.payroll_batch'::regclass;
 -- No new scope/status restriction on unrelated native/SYSTEM/owner/tenant cleanup paths.
 IF NOT EXISTS(SELECT 1 FROM app.assistant_own_leave_review r
  WHERE r.tenant_id=OLD.tenant_id AND r.company_id=OLD.company_id
   AND ((r.action_kind='payroll.reset' AND CASE WHEN target_is_batch THEN r.payroll_reset_batch_id=OLD.id ELSE r.payroll_reset_period_id=OLD.id END)
    OR (r.action_kind='payroll.reopen' AND CASE WHEN target_is_batch THEN r.payroll_reopen_batch_id=OLD.id ELSE r.payroll_reopen_period_id=OLD.id END)))
 THEN RETURN NULL;END IF;
 -- Actual OLD row already deleted through native/RLS owner; never a caller-nominated target UUID.
 -- Same financial scope used by canonical teardown's Attendance release. Keep native SYSTEM semantics.
 IF OLD.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NOT app.can_admin_payroll_for(OLD.company_id)
  OR (target_is_batch AND OLD.status::text<>'draft') OR (NOT target_is_batch AND OLD.status::text<>'open')
 THEN RAISE EXCEPTION 'Payroll review target deletion unavailable' USING ERRCODE='42501';END IF;
 FOR review_row IN SELECT r.id FROM app.assistant_own_leave_review r
  WHERE r.tenant_id=OLD.tenant_id AND r.company_id=OLD.company_id
   AND ((r.action_kind='payroll.reset' AND CASE WHEN target_is_batch THEN r.payroll_reset_batch_id=OLD.id ELSE r.payroll_reset_period_id=OLD.id END)
    OR (r.action_kind='payroll.reopen' AND CASE WHEN target_is_batch THEN r.payroll_reopen_batch_id=OLD.id ELSE r.payroll_reopen_period_id=OLD.id END))
  ORDER BY r.user_id,r.id FOR UPDATE NOWAIT
 LOOP
  PERFORM action_id FROM app.assistant_own_leave_review_content WHERE action_id=review_row.id FOR UPDATE NOWAIT;
  -- Cross-user pending rows target the actually deleted run; no sibling/foreign-company selection.
  UPDATE app.assistant_own_leave_review SET state='refused',intent_digest=NULL,reviewed_digest=NULL,
   payroll_reopen_person_ids=NULL,payroll_reset_person_ids=NULL,payroll_reset_proof=NULL
   WHERE id=review_row.id AND state='awaiting_confirmation';
  DELETE FROM app.assistant_own_leave_review_content WHERE action_id=review_row.id;
 END LOOP;
 -- Completed minimal ledger/event/protected historical commitment remains; no change to canonical
 -- native_outcome_source_capture/targets/association retention or its PDPA discovery ownership.
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.assistant_payroll_review_target_deleted() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER assistant_payroll_review_batch_deleted AFTER DELETE ON public.payroll_batch
 FOR EACH ROW EXECUTE FUNCTION app.assistant_payroll_review_target_deleted();
CREATE TRIGGER assistant_payroll_review_period_deleted AFTER DELETE ON public.pay_period
 FOR EACH ROW EXECUTE FUNCTION app.assistant_payroll_review_target_deleted();

--> statement-breakpoint
-- PRIVATE UNRUN SQL PROPOSAL. Append to root-owned UNAPPLIED mapped0860 after0842/0851.
-- Not source-cleared or repository-adopted. No new ledger/table/app authority.
ALTER TABLE app.assistant_own_leave_review ADD COLUMN payroll_completion_root jsonb;
CREATE FUNCTION app._payroll_completion_uuid_array(value jsonb) RETURNS boolean
 LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE item jsonb;
BEGIN
 IF jsonb_typeof(value) IS DISTINCT FROM 'array' THEN RETURN false;END IF;
 FOR item IN SELECT v FROM jsonb_array_elements(value) v LOOP
  IF jsonb_typeof(item) IS DISTINCT FROM 'string' OR (item#>>'{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN false;END IF;
 END LOOP;
 RETURN (SELECT count(DISTINCT v) FROM jsonb_array_elements(value) v)=jsonb_array_length(value);
END $$;
REVOKE ALL ON FUNCTION app._payroll_completion_uuid_array(jsonb) FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app._payroll_completion_shape(value jsonb,p_kind text,p_state text) RETURNS boolean
 LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE phase text;item record;member jsonb;meta jsonb;ids jsonb;
BEGIN
 IF value IS NULL THEN RETURN true;END IF;
 IF p_kind IS NULL OR p_kind NOT IN('payroll.reset','payroll.reopen') OR jsonb_typeof(value) IS DISTINCT FROM 'object' OR octet_length(value::text)>2000000 THEN RETURN false;END IF;
 phase:=value->>'phase';IF phase IS NULL OR jsonb_typeof(value->'phase') IS DISTINCT FROM 'string' THEN RETURN false;END IF;
 IF phase='prepared' THEN
  IF p_kind<>'payroll.reopen' OR p_state IS DISTINCT FROM 'awaiting_confirmation'
   OR value-ARRAY['phase','source']<>'{}'::jsonb OR NOT(value?&ARRAY['phase','source'])
   OR jsonb_typeof(value->'source') IS DISTINCT FROM 'object' OR (value->'source')-ARRAY['rows','meta']<>'{}'::jsonb
   OR jsonb_typeof(value->'source'->'rows') IS DISTINCT FROM 'object' OR value->'source'->'rows'='{}'::jsonb
   OR jsonb_typeof(value->'source'->'meta') IS DISTINCT FROM 'object' THEN RETURN false;END IF;
  FOR item IN SELECT key,val FROM jsonb_each(value->'source'->'rows') AS v(key,val) LOOP
   IF item.key NOT IN('payroll_batch','company','payroll_cycle','pay_period','payslip','employee_loan','loan_repayment','claim_request','payroll_individual_txn','payroll_input','payroll_batch_component','payroll_statutory_adjustment','statutory_report') OR jsonb_typeof(item.val) IS DISTINCT FROM 'object' THEN RETURN false;END IF;
   FOR member IN SELECT jsonb_build_array(key,val) FROM jsonb_each(item.val) AS v(key,val) LOOP
    IF member->>0 !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR jsonb_typeof(member->1) IS DISTINCT FROM 'string' OR member->>1 !~ '^[0-9a-f]{64}$' THEN RETURN false;END IF;
   END LOOP;
  END LOOP;
  meta:=value->'source'->'meta';
  IF NOT(meta?&ARRAY['exportHash','payPeriod','companyId','periodId','runType','runSeq','statutoryReports','people','employees','loanIds','payslips','applied','claims','consumed','recalcMarked','beforeBatchHash','beforeTotalsHash']) OR meta-ARRAY['exportHash','payPeriod','companyId','periodId','runType','runSeq','statutoryReports','people','employees','loanIds','payslips','applied','claims','consumed','recalcMarked','beforeBatchHash','beforeTotalsHash']<>'{}'::jsonb
   OR app._payroll_completion_uuid_array(meta->'people') IS NOT TRUE
   OR app._payroll_completion_uuid_array(meta->'employees') IS NOT TRUE
   OR app._payroll_completion_uuid_array(meta->'loanIds') IS NOT TRUE
   OR jsonb_typeof(meta->'companyId') IS DISTINCT FROM 'string' OR jsonb_typeof(meta->'periodId') IS DISTINCT FROM 'string'
   OR meta->>'companyId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   OR meta->>'periodId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   OR jsonb_typeof(meta->'payPeriod') IS DISTINCT FROM 'string' OR meta->>'payPeriod' !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
   OR jsonb_typeof(meta->'exportHash') IS DISTINCT FROM 'string' OR meta->>'exportHash' !~ '^[0-9a-f]{64}$' THEN RETURN false;END IF;
  IF jsonb_typeof(meta->'runType') IS DISTINCT FROM 'string' OR meta->>'runType' NOT IN('regular','off_cycle','bonus','adjustment')
   OR jsonb_typeof(meta->'runSeq') IS DISTINCT FROM 'number' OR meta->>'runSeq' !~ '^[1-9][0-9]*$'
   OR jsonb_typeof(meta->'recalcMarked') IS DISTINCT FROM 'boolean' THEN RETURN false;END IF;
  FOREACH phase IN ARRAY ARRAY['statutoryReports','payslips','applied','claims','consumed'] LOOP
   IF jsonb_typeof(meta->phase) IS DISTINCT FROM 'number' OR meta->>phase !~ '^[0-9]+$' THEN RETURN false;END IF;
  END LOOP;
  FOREACH phase IN ARRAY ARRAY['beforeBatchHash','beforeTotalsHash'] LOOP
   IF jsonb_typeof(meta->phase) IS DISTINCT FROM 'string' OR meta->>phase !~ '^[0-9a-f]{64}$' THEN RETURN false;END IF;
  END LOOP;
  RETURN true;
 ELSIF phase='completed' THEN
  IF p_state IS DISTINCT FROM 'completed' OR NOT(value?&ARRAY['phase','xid','batchId','periodId','month','scope','loanIds','capture','authorityHash'])
   OR value-ARRAY['phase','xid','batchId','periodId','month','scope','loanIds','capture','authorityHash']<>'{}'::jsonb
   OR jsonb_typeof(value->'authorityHash') IS DISTINCT FROM 'string' OR value->>'authorityHash' !~ '^[0-9a-f]{64}$'
   OR jsonb_typeof(value->'xid') IS DISTINCT FROM 'string' OR value->>'xid' !~ '^[0-9]+$'
   OR jsonb_typeof(value->'batchId') IS DISTINCT FROM 'string' OR jsonb_typeof(value->'periodId') IS DISTINCT FROM 'string'
   OR value->>'batchId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   OR value->>'periodId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   OR jsonb_typeof(value->'month') IS DISTINCT FROM 'string' OR value->>'month' !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
   OR jsonb_typeof(value->'scope') IS DISTINCT FROM 'object' OR value->'scope'='{}'::jsonb
   OR app._payroll_completion_uuid_array(value->'loanIds') IS NOT TRUE
   OR jsonb_typeof(value->'capture') IS DISTINCT FROM 'object' THEN RETURN false;END IF;
  FOR item IN SELECT key,val FROM jsonb_each(value->'scope') AS v(key,val) LOOP
   IF item.key NOT IN('payroll_batch','company','payroll_cycle','pay_period','payslip','employee_loan','loan_repayment','claim_request','payroll_individual_txn','payroll_input','payroll_batch_component','payroll_statutory_adjustment','statutory_report')
    OR app._payroll_completion_uuid_array(item.val) IS NOT TRUE THEN RETURN false;END IF;
  END LOOP;
  meta:=value->'capture';
  IF NOT(meta?&ARRAY['captureId','eventId','targets']) OR meta-ARRAY['captureId','eventId','targets']<>'{}'::jsonb
   OR jsonb_typeof(meta->'captureId') IS DISTINCT FROM 'string' OR jsonb_typeof(meta->'eventId') IS DISTINCT FROM 'string'
   OR meta->>'captureId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   OR meta->>'eventId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   OR jsonb_typeof(meta->'targets') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
  FOR member IN SELECT v FROM jsonb_array_elements(meta->'targets') v LOOP
   IF jsonb_typeof(member) IS DISTINCT FROM 'array' THEN RETURN false;END IF;
   IF jsonb_array_length(member)<>2 OR jsonb_typeof(member->0) IS DISTINCT FROM 'string'
    OR member->>0 NOT IN('person','employment') OR jsonb_typeof(member->1) IS DISTINCT FROM 'string'
    OR member->>1 !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN false;END IF;
  END LOOP;
  RETURN (SELECT count(DISTINCT v) FROM jsonb_array_elements(meta->'targets') v)=jsonb_array_length(meta->'targets');
 END IF;
 RETURN false;
END $$;
REVOKE ALL ON FUNCTION app._payroll_completion_shape(jsonb,text,text) FROM PUBLIC,ai_hr_app;
ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT payroll_completion_root_closed CHECK(app._payroll_completion_shape(payroll_completion_root,action_kind,state) IS TRUE);
CREATE INDEX payroll_completion_current_root ON app.assistant_own_leave_review((payroll_completion_root->>'xid')) WHERE action_kind IN('payroll.reset','payroll.reopen') AND state='completed' AND payroll_completion_root->>'phase'='completed';
--> statement-breakpoint
-- Uses the existing bounded native-visible reset source owner, including exact0121/0492/0660/0709
-- filters. This is not a new hidden-row read owner or alternate money algorithm.
CREATE FUNCTION app._payroll_completion_snapshot(p_batch uuid,p_loans uuid[] DEFAULT NULL,p_individuals uuid[] DEFAULT NULL,p_reopen boolean DEFAULT false) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source jsonb;batch public.payroll_batch%ROWTYPE;parent public.pay_period%ROWTYPE;
BEGIN
 source:=app._payroll_reset_source(p_batch,p_loans,p_individuals);
 IF p_reopen THEN
  SELECT * INTO batch FROM public.payroll_batch WHERE id=p_batch AND tenant_id=app.current_tenant_id();
  SELECT * INTO parent FROM public.pay_period WHERE id=batch.pay_period_id AND tenant_id=batch.tenant_id;
  -- Only these two native status changes are allowed. Sibling statuses remain fully committed.
  source:=jsonb_set(source,ARRAY['rows','payroll_batch',p_batch::text],to_jsonb(app._payroll_reset_hash(app._payroll_reset_json(batch)-'status')));
  source:=jsonb_set(source,ARRAY['rows','pay_period',parent.id::text],to_jsonb(app._payroll_reset_hash(app._payroll_reset_json(parent)-'status')));
 END IF;
 RETURN source;
END $$;
REVOKE ALL ON FUNCTION app._payroll_completion_snapshot(uuid,uuid[],uuid[],boolean) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- SQL derives the exact effect/cohort target set; caller lists and count-only require() are not proof.
CREATE FUNCTION app._payroll_completion_capture(p_old app.assistant_own_leave_review,p_event uuid,p_meta jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c app.native_outcome_source_capture%ROWTYPE;physical xid;expected jsonb;actual jsonb;
BEGIN
 SELECT * INTO c FROM app.native_outcome_source_capture WHERE tenant_id=p_old.tenant_id AND user_id=p_old.user_id
  AND person_id IS NOT DISTINCT FROM p_old.person_id AND action=p_old.action_kind
  AND source_kind='review' AND source_id=p_old.id AND review_id=p_old.id AND event_id=p_event;
 SELECT xmin INTO physical FROM app.native_outcome_source_capture WHERE id=c.id;
 IF c.id IS NULL OR physical IS DISTINCT FROM pg_current_xact_id()::xid OR c.expires_at<=clock_timestamp()
 OR c.expires_at IS DISTINCT FROM least(p_old.created_at+interval '30 days',now()+interval '30 days') OR NOT EXISTS(SELECT 1 FROM public.domain_event d WHERE d.id=p_event
 AND d.tenant_id=p_old.tenant_id AND d.actor_type='user' AND d.actor_id=p_old.user_id AND d.xmin=pg_current_xact_id()::xid) THEN
  RAISE EXCEPTION 'Payroll completion privacy capture unavailable' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_array(kind,id) ORDER BY kind,id),'[]'::jsonb) INTO expected FROM(
  SELECT DISTINCT 'person'::text kind,value::uuid id FROM jsonb_array_elements_text(coalesce(p_meta->'people','[]'::jsonb))
  UNION SELECT 'employment',value::uuid FROM jsonb_array_elements_text(coalesce(p_meta->'employees','[]'::jsonb))
  UNION SELECT 'person',p_old.person_id WHERE p_old.person_id IS NOT NULL) targets;
 SELECT coalesce(jsonb_agg(jsonb_build_array(kind,target_id) ORDER BY kind,target_id),'[]'::jsonb) INTO actual
  FROM app.native_outcome_source_target WHERE capture_id=c.id;
 IF actual IS DISTINCT FROM expected OR c.target_count<>jsonb_array_length(expected)

 THEN RAISE EXCEPTION 'Payroll completion privacy target set changed' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('captureId',c.id,'eventId',p_event,'targets',expected);
END $$;
REVOKE ALL ON FUNCTION app._payroll_completion_capture(app.assistant_own_leave_review,uuid,jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Actual actor dependencies, independent of caller GUCs. Only a private authorization hash is
-- retained; no role values, financial hashes or policy content survive completion. Canonical
-- role-assignment and effective-membership owners remain authoritative. VOLATILE is required so
-- an ordinary AFTER writer sees its own statement, including after SET CONSTRAINTS IMMEDIATE.
-- Role coverage uses the native ancestry owner, so changing an intermediate ancestor also changes
-- this commitment. Retired state is boolean; caller timezone is never changed for serialization.
CREATE FUNCTION app._payroll_completion_authority(p_tenant uuid,p_user uuid,p_company uuid) RETURNS text
 LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH seats AS (
  SELECT DISTINCT m.group_id,m.company_id FROM public.access_effective_membership m
  WHERE m.tenant_id=p_tenant AND m.user_id=p_user
 ), roles AS (
  SELECT DISTINCT r.role::text role,r.company_id,
   (r.company_id IS NULL OR app.is_company_descendant(p_company,r.company_id)) AS target_covered
  FROM public.role_assignment r
  WHERE r.tenant_id=p_tenant AND r.app_user_id=p_user
 ), grants AS (
  SELECT DISTINCT a.capability_id,a.company_id FROM public.access_group_grant a
  WHERE a.tenant_id=p_tenant AND a.retired_at IS NULL
   AND EXISTS(SELECT 1 FROM seats m WHERE m.group_id=a.group_id)
 ), overrides AS (
  SELECT DISTINCT o.capability_id,o.company_id,o.effect FROM public.access_user_override o
  WHERE o.tenant_id=p_tenant AND o.user_id=p_user AND o.retired_at IS NULL
 ), capabilities AS (
  SELECT capability_id FROM grants UNION SELECT capability_id FROM overrides
 )
 SELECT app._payroll_reset_hash(jsonb_build_object(
  'actor',(SELECT jsonb_build_array(u.id,u.person_id,u.archived_at,app.login_blocked(u.id)) FROM public.app_user u WHERE u.id=p_user AND u.tenant_id=p_tenant),
  'companyPath',coalesce((SELECT jsonb_agg(jsonb_build_array(c.id,c.parent_company_id) ORDER BY c.id) FROM public.company c WHERE c.tenant_id=p_tenant AND app.is_company_descendant(p_company,c.id)),'[]'::jsonb),
  'roles',coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.role,r.company_id) FROM roles r),'[]'::jsonb),
  'initialized',coalesce((SELECT c.initialized FROM public.access_configuration c WHERE c.tenant_id=p_tenant),false),
  'seats',coalesce((SELECT jsonb_agg(jsonb_build_array(m.group_id,m.company_id,g.legacy_key,g.system_administrator,(g.retired_at IS NOT NULL)) ORDER BY m.group_id,m.company_id) FROM seats m JOIN public.access_group g ON g.id=m.group_id AND g.tenant_id=p_tenant),'[]'::jsonb),
  'grants',coalesce((SELECT jsonb_agg(to_jsonb(g) ORDER BY g.capability_id,g.company_id) FROM grants g),'[]'::jsonb),
  'overrides',coalesce((SELECT jsonb_agg(to_jsonb(o) ORDER BY o.capability_id,o.company_id,o.effect) FROM overrides o),'[]'::jsonb),
  'capabilities',coalesce((SELECT jsonb_agg(jsonb_build_array(c.id,c.scope,c.supported,c.bindings) ORDER BY c.id) FROM public.access_capability c JOIN capabilities d ON d.capability_id=c.id),'[]'::jsonb),
  'payrollPermissions',coalesce((SELECT jsonb_agg(jsonb_build_array(g.permission_key,g.role,g.company_id,g.allowed) ORDER BY g.permission_key,g.role,g.company_id) FROM public.payroll_permission_grant g WHERE g.tenant_id=p_tenant AND EXISTS(SELECT 1 FROM roles r WHERE r.role=g.role) AND app.access_scope_covers(g.company_id,p_company,p_tenant)),'[]'::jsonb)
 ));
$$;
REVOKE ALL ON FUNCTION app._payroll_completion_authority(uuid,uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._payroll_completion_root(p_old app.assistant_own_leave_review,p_event uuid,p_snapshot jsonb,p_before_rows jsonb DEFAULT NULL) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE scope jsonb;capture jsonb;
BEGIN
 -- Relevance IDs only; no completed source/financial-value hashes or full row JSON.
 SELECT coalesce(jsonb_object_agg(relation,ids),'{}'::jsonb) INTO scope FROM(
  SELECT relation,jsonb_agg(id ORDER BY id) ids FROM(
   SELECT DISTINCT e.key relation,r.key id FROM jsonb_each(p_snapshot->'rows') e
    CROSS JOIN LATERAL jsonb_each(e.value) r
   UNION SELECT DISTINCT e.key,r.key FROM jsonb_each(coalesce(p_before_rows,'{}'::jsonb)) e
    CROSS JOIN LATERAL jsonb_each(e.value) r) x GROUP BY relation) y;
 capture:=app._payroll_completion_capture(p_old,p_event,CASE WHEN p_old.action_kind='payroll.reset' THEN p_old.payroll_reset_proof->'source'->'meta' ELSE p_old.payroll_completion_root->'source'->'meta' END);
 RETURN jsonb_build_object('phase','completed','xid',pg_current_xact_id()::text,'batchId',
  coalesce(p_old.payroll_reset_batch_id,p_old.payroll_reopen_batch_id),'periodId',
  coalesce(p_old.payroll_reset_period_id,p_old.payroll_reopen_period_id),'month',p_snapshot->'meta'->>'payPeriod',
  'scope',scope,'loanIds',p_snapshot->'meta'->'loanIds','capture',capture,
  'authorityHash',app._payroll_completion_authority(p_old.tenant_id,p_old.user_id,p_old.company_id));
END $$;
REVOKE ALL ON FUNCTION app._payroll_completion_root(app.assistant_own_leave_review,uuid,jsonb,jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Root fence uses actual OLD+NEW and original root xid, independent of a caller context switch.
CREATE FUNCTION app._payroll_completion_writer_fence() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE oldj jsonb;newj jsonb;r app.assistant_own_leave_review%ROWTYPE;root jsonb;rowj jsonb;
 relation text:=TG_TABLE_NAME;relevant boolean;candidate jsonb;
BEGIN
 IF TG_OP NOT IN('INSERT','UPDATE','DELETE') THEN RAISE EXCEPTION 'Payroll root writer unavailable' USING ERRCODE='42501';END IF;
 IF TG_OP<>'INSERT' THEN oldj:=to_jsonb(OLD);END IF;
 IF TG_OP<>'DELETE' THEN newj:=to_jsonb(NEW);END IF;
 IF TG_RELID='app.assistant_own_leave_review'::regclass AND TG_OP<>'INSERT'
 AND oldj->>'action_kind' IN('payroll.reset','payroll.reopen') AND oldj->>'state'='completed' THEN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Payroll historical receipt anchor is immutable' USING ERRCODE='42501';END IF;
  IF oldj IS DISTINCT FROM newj THEN
   -- The canonical later-transaction erasure may clear only the private relevance IDs, never
   -- event/proof/person/identity/expiry/receipt fields. There is no arbitrary caller scrub GUC.
   IF NOT (oldj->'payroll_completion_root' IS NOT NULL AND oldj->'payroll_completion_root'<>'null'::jsonb
    AND oldj->'payroll_completion_root'->>'xid' IS DISTINCT FROM pg_current_xact_id()::text
    AND newj=(oldj||jsonb_build_object('payroll_completion_root',NULL))
    AND EXISTS(SELECT 1 FROM app.home_greeting_erasure_intent i
     WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=(oldj->>'tenant_id')::uuid
      AND i.tenant_id=app.current_tenant_id() AND i.user_id=app.current_user_id()
      AND app.principal_snapshot_current() IS TRUE AND app.can_admin_employment(i.employment_id) IS TRUE
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(oldj->'payroll_completion_root'->'capture'->'targets') target
       WHERE (target->>0='person' AND target->>1=i.person_id::text) OR (target->>0='employment' AND target->>1=i.employment_id::text))))
   THEN RAISE EXCEPTION 'Payroll historical receipt anchor changed' USING ERRCODE='42501';END IF;
  END IF;
 END IF;
 -- AFTER must also enforce protected OLD directly: a later BEFORE trigger might remove/retype
 -- the live row so selecting only current completed roots would miss the very seal it destroyed.
 IF TG_RELID='app.assistant_own_leave_review'::regclass AND TG_OP<>'INSERT'
  AND oldj->'payroll_completion_root'->>'phase'='completed'
  AND oldj->'payroll_completion_root'->>'xid'=pg_current_xact_id()::text
  AND (TG_OP='DELETE' OR oldj IS DISTINCT FROM newj)
 THEN RAISE EXCEPTION 'Payroll completed ledger root is immutable' USING ERRCODE='42501';END IF;
 FOR r IN SELECT * FROM app.assistant_own_leave_review
  WHERE action_kind IN('payroll.reset','payroll.reopen') AND state='completed'
   AND payroll_completion_root->>'phase'='completed'
   AND payroll_completion_root->>'xid'=pg_current_xact_id()::text LOOP
  root:=r.payroll_completion_root;relevant:=false;
  -- Do not freeze a whole tenant's Access configuration. Unrelated user/group/policy edits,
  -- revision bookkeeping and later independent legitimate changes leave this commitment intact.
  -- AFTER is deliberate: BEFORE sees the old state, and an advisory lock cannot stop self-writes.
  IF TG_WHEN='AFTER' AND relation IN('role_assignment','access_configuration','access_group',
   'access_membership','access_group_grant','access_user_override','access_capability',
   'payroll_permission_grant','app_user','employment','company')
   AND app._payroll_completion_authority(r.tenant_id,r.user_id,r.company_id)
    IS DISTINCT FROM root->>'authorityHash'
  THEN RAISE EXCEPTION 'Payroll completion actor authority changed' USING ERRCODE='42501';END IF;
  IF TG_RELID='app.assistant_own_leave_review'::regclass THEN
   IF oldj->>'id'=r.id::text OR newj->>'id'=r.id::text THEN
    -- Existing body-retired owner may perform an identical no-op UPDATE.
    IF oldj->'payroll_completion_root'->>'xid'=pg_current_xact_id()::text AND (TG_OP<>'UPDATE' OR oldj IS DISTINCT FROM newj) THEN RAISE EXCEPTION 'Payroll completion ledger is sealed' USING ERRCODE='42501';END IF;
   END IF;
   CONTINUE;
  ELSIF TG_RELID='app.assistant_own_leave_review_content'::regclass THEN
   IF oldj->>'action_id'=r.id::text OR newj->>'action_id'=r.id::text THEN
    IF TG_OP<>'DELETE' THEN RAISE EXCEPTION 'Payroll completed body is sealed' USING ERRCODE='42501';END IF;
   END IF;
   CONTINUE;
  END IF;
  FOREACH candidate IN ARRAY ARRAY[oldj,newj] LOOP
   IF candidate IS NULL THEN CONTINUE;END IF;
   IF TG_RELID='app.native_outcome_source_target'::regclass THEN
    relevant:=relevant OR candidate->>'capture_id'=root->'capture'->>'captureId';
   ELSIF TG_RELID='app.native_outcome_source_capture'::regclass THEN
    relevant:=relevant OR candidate->>'id'=root->'capture'->>'captureId'
     OR candidate->>'source_id'=r.id::text OR candidate->>'review_id'=r.id::text;
   ELSIF TG_RELID='public.ai_native_outcome_association'::regclass THEN
    relevant:=relevant OR candidate->>'source_capture_id'=root->'capture'->>'captureId'
     OR candidate->>'review_id'=r.id::text;
   ELSIF candidate->>'tenant_id'=r.tenant_id::text THEN
    relevant:=relevant OR (relation='app_user' AND candidate->>'id'=r.user_id::text)
     OR (relation='employment' AND EXISTS(SELECT 1 FROM jsonb_array_elements(root->'capture'->'targets') target WHERE target->>0='employment' AND target->>1=candidate->>'id'))
     OR coalesce((root->'scope'->relation)?(candidate->>'id'),false)
     OR candidate->>'batch_id'=root->>'batchId' OR candidate->>'payroll_batch_id'=root->>'batchId'
     OR candidate->>'consumed_batch_id'=root->>'batchId'
     OR candidate->>'reserved_batch_id'=root->>'batchId' OR candidate->>'applied_batch_id'=root->>'batchId'
     OR candidate->>'pay_period_id'=root->>'periodId'
     OR (relation='loan_repayment' AND coalesce((root->'loanIds')?(candidate->>'loan_id'),false))
     OR (relation='statutory_report' AND candidate->>'company_id'=r.company_id::text AND candidate->>'period_key'=root->>'month')
     OR (relation='domain_event' AND (candidate->>'id'=root->'capture'->>'eventId'
      OR candidate->>'aggregate_id'=root->>'batchId' OR candidate->>'aggregate_id'=root->>'periodId'
      OR coalesce((root->'scope'->'employee_loan')?(candidate->>'aggregate_id'),false)
      OR coalesce((root->'scope'->'loan_repayment')?(candidate->>'aggregate_id'),false)
      OR coalesce((root->'scope'->'claim_request')?(candidate->>'aggregate_id'),false)));
   END IF;
  END LOOP;
  IF relevant IS TRUE THEN RAISE EXCEPTION 'Payroll completion transaction is sealed' USING ERRCODE='42501';END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END $$;
REVOKE ALL ON FUNCTION app._payroll_completion_writer_fence() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
DO $$
DECLARE target regclass;name text;timing text;
BEGIN
 FOREACH target IN ARRAY ARRAY[
 'public.payroll_batch'::regclass,'public.pay_period'::regclass,'public.company'::regclass,
 'public.payroll_cycle'::regclass,'public.payslip'::regclass,'public.payroll_input'::regclass,
 'public.payroll_batch_component'::regclass,'public.payroll_statutory_adjustment'::regclass,
 'public.loan_repayment'::regclass,'public.employee_loan'::regclass,'public.claim_request'::regclass,
 'public.payroll_individual_txn'::regclass,'public.statutory_report'::regclass,
 'public.domain_event'::regclass,'public.payroll_status_history'::regclass,
 'public.app_user'::regclass,'public.employment'::regclass,
 'public.role_assignment'::regclass,'public.access_configuration'::regclass,
 'public.access_group'::regclass,'public.access_membership'::regclass,
 'public.access_group_grant'::regclass,'public.access_user_override'::regclass,
 'public.access_capability'::regclass,'public.payroll_permission_grant'::regclass,
 'app.assistant_own_leave_review'::regclass,'app.assistant_own_leave_review_content'::regclass,
 'app.native_outcome_source_capture'::regclass,'app.native_outcome_source_target'::regclass,
 'public.ai_native_outcome_association'::regclass] LOOP
  FOREACH timing IN ARRAY ARRAY['BEFORE','AFTER'] LOOP
   name:='payroll_completion_'||lower(timing);
   EXECUTE format('CREATE TRIGGER %I %s INSERT OR UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION app._payroll_completion_writer_fence()',name,timing,target);
  END LOOP;
 END LOOP;
END $$;

--> statement-breakpoint
-- Same exact existing native reset effect verifier, except admission reads protected OLD composite
-- supplied only by private completion/constraint owners, never caller JSON; no persisted proof rewrite.
CREATE FUNCTION app._payroll_reset_closed_effect(p_old app.assistant_own_leave_review,p_event uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;proof jsonb;progress jsonb;current_source jsonb;e public.domain_event%ROWTYPE;h public.payroll_status_history%ROWTYPE;x jsonb;kind text;seen jsonb:='{}'::jsonb;effect record;expected_type text;expected_subject uuid;expected_aggregate uuid;event_hashes jsonb:='{}'::jsonb;event_count integer:=0;counts jsonb;selected_count int;updated_count int;claim_count int;slip_count int;consumed_count int;reopened_count int;recalc_count int;physical xid;history_before jsonb;commitment text;
BEGIN
 r:=p_old;
 IF r.tenant_id IS DISTINCT FROM app.current_tenant_id() OR r.user_id IS DISTINCT FROM app.current_user_id() OR r.action_kind<>'payroll.reset' OR r.state<>'awaiting_confirmation' THEN RAISE EXCEPTION 'Payroll reset root identity changed' USING ERRCODE='42501';END IF;
 IF clock_timestamp()>=r.expires_at OR r.payroll_reset_proof->>'phase' IS DISTINCT FROM 'actual' OR r.payroll_reset_proof->>'xid' IS DISTINCT FROM pg_current_xact_id()::text THEN RAISE EXCEPTION 'Payroll reset completion unavailable';END IF;
 PERFORM app._assistant_payroll_reset_review_identity(r.person_id);
 proof:=r.payroll_reset_proof;
 IF proof->'pendingLoans'<>'{}'::jsonb THEN RAISE EXCEPTION 'Payroll reset loan effects incomplete';END IF;
 -- Recompute every original scope and every current scope, including now-released retargeted
 -- individual rows and schedules whose applied marker has been cleared. Reject new relation keys too.
 current_source:=app._payroll_reset_source(r.payroll_reset_batch_id,
 ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(proof->'source'->'meta'->'loanIds')),
 ARRAY(SELECT key::uuid FROM jsonb_each(coalesce(proof->'source'->'rows'->'payroll_individual_txn','{}'::jsonb))));
 SELECT coalesce(jsonb_object_agg(key,value),'{}'::jsonb) INTO progress FROM jsonb_each(proof->'progress') WHERE value<>'{}'::jsonb;
 IF current_source->'rows' IS DISTINCT FROM progress OR current_source->'meta'->>'exportHash' IS DISTINCT FROM proof->'source'->'meta'->>'exportHash' THEN RAISE EXCEPTION 'Payroll reset full source/progress mismatch';END IF;
 FOR x IN SELECT value FROM jsonb_array_elements(proof->'observed') LOOP
  kind:=((x->>'kind')||':'||(x->>'id')||':'||CASE WHEN x->>'kind'='loan' THEN coalesce(x->>'repaymentId','') ELSE '' END);
  IF seen?kind THEN RAISE EXCEPTION 'Payroll reset duplicate transition';END IF;
  seen:=seen||jsonb_build_object(kind,true);
  IF x->>'kind'='shortfall' AND ((SELECT count(*) FROM jsonb_array_elements(proof->'observed') step WHERE step->>'kind'='repayment' AND step->>'id'=x->>'repaymentId')<>1 OR (SELECT count(*) FROM jsonb_array_elements(proof->'observed') step WHERE step->>'kind'='loan' AND step->>'repaymentId'=x->>'repaymentId')<>1) THEN RAISE EXCEPTION 'Payroll reset orphan shortfall';END IF;
 END LOOP;
 SELECT count(*) FILTER(WHERE value->>'kind'='payslip'),count(*) FILTER(WHERE value->>'kind'='repayment'),count(*) FILTER(WHERE value->>'kind'='claim'),count(*) FILTER(WHERE value->>'kind'='consumed'),count(*) FILTER(WHERE value->>'kind'='loan' AND (value->>'reopened')::boolean),count(*) FILTER(WHERE value->>'kind'='recalc') INTO slip_count,updated_count,claim_count,consumed_count,reopened_count,recalc_count FROM jsonb_array_elements(proof->'observed');
 selected_count:=(proof->'source'->'meta'->>'applied')::int;
 IF slip_count<>(proof->'source'->'meta'->>'payslips')::int OR claim_count<>(proof->'source'->'meta'->>'claims')::int OR consumed_count<>(proof->'source'->'meta'->>'consumed')::int OR recalc_count<>(CASE WHEN (proof->'source'->'meta'->>'recalcMarked')::boolean THEN 1 ELSE 0 END) OR (SELECT count(*) FROM jsonb_array_elements(proof->'observed') WHERE value->>'kind'='batch')<>1 OR (SELECT count(*) FROM jsonb_array_elements(proof->'observed') WHERE value->>'kind'='loan')<>updated_count THEN RAISE EXCEPTION 'Payroll reset effect inventory mismatch';END IF;
 -- Every originally applied native-visible repayment with a native-visible loan must be restored.
 IF EXISTS(SELECT 1 FROM public.loan_repayment q WHERE q.tenant_id=r.tenant_id AND q.applied_batch_id=r.payroll_reset_batch_id AND q.status='applied' AND app.can_see_employment(q.employment_id) AND EXISTS(SELECT 1 FROM public.employee_loan l WHERE l.id=q.loan_id AND l.tenant_id=q.tenant_id AND app.can_see_employment(l.employment_id))) THEN RAISE EXCEPTION 'Payroll reset repayment omitted';END IF;
 SELECT * INTO e FROM public.domain_event WHERE id=p_event AND tenant_id=r.tenant_id AND aggregate_type='payroll-batch' AND aggregate_id=r.payroll_reset_batch_id AND event_type='payroll-batch.reset' AND actor_type='user' AND actor_id=r.user_id AND subject_employment_id IS NULL AND xmin=pg_current_xact_id()::xid;
 IF NOT FOUND OR app._payroll_reset_hash(to_jsonb(e.payload->>'reason')) IS DISTINCT FROM proof->>'reasonHash' THEN RAISE EXCEPTION 'Payroll reset event mismatch';END IF;
 SELECT * INTO h FROM public.payroll_status_history WHERE id=(e.payload->>'statusHistoryId')::uuid AND tenant_id=r.tenant_id AND batch_id=r.payroll_reset_batch_id AND action='rollback' AND from_status='processed' AND to_status='draft' AND actor_type='user' AND actor_id=r.user_id AND xmin=pg_current_xact_id()::xid;
 IF NOT FOUND OR h.reason IS DISTINCT FROM e.payload->>'reason' OR app._payroll_reset_hash(h.before) IS DISTINCT FROM proof->'source'->'meta'->>'beforeTotalsHash' OR e.payload->>'companyId' IS DISTINCT FROM r.company_id::text OR e.payload->>'payPeriodId' IS DISTINCT FROM r.payroll_reset_period_id::text OR e.payload->>'payPeriod' IS DISTINCT FROM proof->'source'->'meta'->>'payPeriod' OR e.payload->>'fromStatus' IS DISTINCT FROM 'processed' OR e.payload->>'toStatus' IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'Payroll reset history mismatch';END IF;
 counts:=jsonb_build_object('payslipsCleared',slip_count,'loanInstalmentsReversed',selected_count,'loansReopened',reopened_count,'claimsReverted',claim_count);
 IF h.after IS DISTINCT FROM (jsonb_build_object('status','draft','totals',NULL,'employeeCount',0)||counts) THEN RAISE EXCEPTION 'Payroll reset native counts mismatch';END IF;
 IF e.payload IS DISTINCT FROM (jsonb_build_object('statusHistoryId',h.id,'fromStatus','processed','toStatus','draft','companyId',r.company_id,'payPeriod',proof->'source'->'meta'->>'payPeriod','payPeriodId',r.payroll_reset_period_id,'runType',proof->'source'->'meta'->>'runType','runSeq',(proof->'source'->'meta'->>'runSeq')::int,'reason',h.reason,'statutoryReportsForPeriod',(proof->'source'->'meta'->>'statutoryReports')::int)||counts) THEN RAISE EXCEPTION 'Payroll reset native payload mismatch';END IF;
 -- Exact event-per-effect multisets, all linked to this reset event by the unchanged native writer.
 FOR x IN SELECT value FROM jsonb_array_elements(proof->'observed') WHERE value->>'kind' IN('repayment','claim','recalc') OR (value->>'kind'='loan' AND (value->>'reopened')::boolean) LOOP
  kind:=x->>'kind';expected_type:=CASE kind WHEN 'repayment' THEN 'loan.instalment.reversed' WHEN 'loan' THEN 'loan.reopened' WHEN 'claim' THEN 'claim-request.payment-reversed' ELSE 'payroll-batch.recalc-cleared' END;
  expected_aggregate:=CASE WHEN kind='recalc' THEN r.payroll_reset_batch_id ELSE (x->>'id')::uuid END;
  expected_subject:=CASE WHEN kind='recalc' THEN NULL ELSE (x->>'employmentId')::uuid END;
  IF (SELECT count(*) FROM public.domain_event d WHERE d.tenant_id=r.tenant_id AND d.event_type=expected_type AND d.aggregate_id=expected_aggregate AND d.aggregate_type=CASE kind WHEN 'repayment' THEN 'loan-repayment' WHEN 'loan' THEN 'employee-loan' WHEN 'claim' THEN 'claim-request' ELSE 'payroll-batch' END AND (kind<>'repayment' OR d.payload->>'loanId'=x->>'loanId') AND d.actor_type='user' AND d.actor_id=r.user_id AND d.subject_employment_id IS NOT DISTINCT FROM expected_subject AND d.payload->>'resetEventId'=p_event::text AND d.xmin=pg_current_xact_id()::xid AND d.payload=CASE WHEN kind='recalc' THEN jsonb_build_object('resetEventId',p_event) WHEN kind='repayment' THEN jsonb_build_object('batchId',r.payroll_reset_batch_id,'loanId',x->>'loanId','reason','payroll-reset','resetEventId',p_event) ELSE jsonb_build_object('batchId',r.payroll_reset_batch_id,'reason','payroll-reset','resetEventId',p_event) END)<>1 THEN RAISE EXCEPTION 'Payroll reset exact native event missing';END IF;
  event_count:=event_count+1;
 END LOOP;
 IF (SELECT count(*) FROM jsonb_array_elements(proof->'observed') WHERE value->>'kind'='history')<>1 OR (SELECT count(*) FROM jsonb_array_elements(proof->'observed') WHERE value->>'kind'='event')<>event_count+1 OR (SELECT count(*) FROM public.domain_event d WHERE d.tenant_id=r.tenant_id AND d.payload->>'resetEventId'=p_event::text)<>event_count THEN RAISE EXCEPTION 'Payroll reset extra native event';END IF;
 SELECT jsonb_object_agg(d.id::text,app._payroll_reset_hash(app._payroll_reset_json(d))) INTO event_hashes FROM public.domain_event d WHERE d.tenant_id=r.tenant_id AND (d.id=p_event OR d.payload->>'resetEventId'=p_event::text);
 commitment:=app._payroll_reset_hash(jsonb_build_object('source',proof->'source','observed',proof->'observed','progress',proof->'progress','history',app._payroll_reset_hash(app._payroll_reset_json(h)),'events',event_hashes));
 proof:=jsonb_build_object('phase','completed','commitment',commitment,'statusHistoryId',h.id,'resetEventId',p_event,'counts',counts,'historyHash',app._payroll_reset_hash(app._payroll_reset_json(h)),'eventHashes',event_hashes);
 RETURN proof;
END $$;
REVOKE ALL ON FUNCTION app._payroll_reset_closed_effect(app.assistant_own_leave_review,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._payroll_completion_assert(p_old app.assistant_own_leave_review,p_new app.assistant_own_leave_review) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE event_id uuid;current_source jsonb;before_source jsonb;minimal jsonb;expected jsonb;root jsonb;
BEGIN
 IF p_old.state<>'awaiting_confirmation' OR p_new.state<>'completed'
 OR p_old.tenant_id IS DISTINCT FROM app.current_tenant_id() OR p_old.user_id IS DISTINCT FROM app.current_user_id()
 OR clock_timestamp()>=p_old.expires_at THEN RAISE EXCEPTION 'Payroll completion root unavailable' USING ERRCODE='42501';END IF;
 IF p_old.action_kind='payroll.reset' THEN
  event_id:=p_new.payroll_reset_event_id;minimal:=app._payroll_reset_closed_effect(p_old,event_id);
  before_source:=p_old.payroll_reset_proof->'source';
  current_source:=app._payroll_completion_snapshot(p_old.payroll_reset_batch_id,
   ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(before_source->'meta'->'loanIds')),
   ARRAY(SELECT key::uuid FROM jsonb_each(coalesce(before_source->'rows'->'payroll_individual_txn','{}'::jsonb))),false);
  root:=app._payroll_completion_root(p_old,event_id,current_source,before_source->'rows');
  expected:=to_jsonb(p_old)||jsonb_build_object('state','completed','intent_digest',NULL,'reviewed_digest',NULL,
   'payroll_reset_event_id',event_id,'payroll_reset_person_ids',NULL,'payroll_reset_proof',minimal,'payroll_completion_root',root);
  PERFORM app._assistant_payroll_reset_review_source(p_old.person_id,p_old.payroll_reset_batch_id,p_old.company_id,p_old.payroll_reset_period_id);
 ELSIF p_old.action_kind='payroll.reopen' THEN
  IF p_old.payroll_completion_root->>'phase' IS DISTINCT FROM 'prepared' THEN RAISE EXCEPTION 'Payroll reopening needs a fresh review' USING ERRCODE='42501';END IF;
  before_source:=p_old.payroll_completion_root->'source';event_id:=p_new.payroll_reopened_event_id;
  current_source:=app._payroll_completion_snapshot(p_old.payroll_reopen_batch_id,
   ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(before_source->'meta'->'loanIds')),
   ARRAY(SELECT key::uuid FROM jsonb_each(coalesce(before_source->'rows'->'payroll_individual_txn','{}'::jsonb))),true);
  IF current_source->'rows' IS DISTINCT FROM before_source->'rows'
   OR current_source->'meta'->>'exportHash' IS DISTINCT FROM before_source->'meta'->>'exportHash'
   OR app.read_own_payroll_reopen_effect(p_old.payroll_reopen_batch_id,event_id) IS NULL
  THEN RAISE EXCEPTION 'Payroll reopening full financial source changed' USING ERRCODE='42501';END IF;
  -- Exact current-root native transition admission is preserved by the completion owner below.
  root:=app._payroll_completion_root(p_old,event_id,current_source,before_source->'rows');
  expected:=to_jsonb(p_old)||jsonb_build_object('state','completed','intent_digest',NULL,'reviewed_digest',NULL,
   'payroll_reopened_event_id',event_id,'payroll_reopen_person_ids',NULL,'payroll_completion_root',root);
  PERFORM app._assistant_payroll_reopen_review_source(p_old.person_id,p_old.payroll_reopen_batch_id,p_old.company_id,p_old.payroll_reopen_period_id);
 ELSE RAISE EXCEPTION 'Unexpected Payroll completion kind' USING ERRCODE='42501';END IF;
 IF app.native_outcome_targets_require(p_old.tenant_id,p_old.user_id,p_old.person_id,p_old.action_kind,p_old.id,event_id) IS NOT TRUE THEN RAISE EXCEPTION 'Payroll completed privacy owner unavailable' USING ERRCODE='42501';END IF;
 IF to_jsonb(p_new) IS DISTINCT FROM expected OR EXISTS(SELECT 1 FROM app.assistant_own_leave_review_content WHERE action_id=p_old.id)
 THEN RAISE EXCEPTION 'Payroll whole completed custody changed' USING ERRCODE='42501';END IF;
END $$;
REVOKE ALL ON FUNCTION app._payroll_completion_assert(app.assistant_own_leave_review,app.assistant_own_leave_review) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._payroll_completion_final() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actual app.assistant_own_leave_review%ROWTYPE;physical xid;
BEGIN
 IF TG_RELID<>'app.assistant_own_leave_review'::regclass OR TG_OP<>'UPDATE'
 THEN RAISE EXCEPTION 'Payroll final verifier operation unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO actual FROM app.assistant_own_leave_review WHERE id=OLD.id;
 SELECT xmin INTO physical FROM app.assistant_own_leave_review WHERE id=OLD.id;
 IF actual.id IS NULL OR physical<>pg_current_xact_id()::xid OR to_jsonb(actual) IS DISTINCT FROM to_jsonb(NEW)
 THEN RAISE EXCEPTION 'Payroll completed root changed' USING ERRCODE='42501';END IF;
 PERFORM app._payroll_completion_assert(OLD,actual);RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app._payroll_completion_final() FROM PUBLIC,ai_hr_app;
CREATE CONSTRAINT TRIGGER payroll_completion_final AFTER UPDATE ON app.assistant_own_leave_review
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 WHEN (OLD.action_kind IN('payroll.reset','payroll.reopen') AND OLD.state='awaiting_confirmation' AND NEW.state='completed')
 EXECUTE FUNCTION app._payroll_completion_final();

--> statement-breakpoint
-- Exact existing native completion admissions retained; reset now atomically stores completed proof+root.
CREATE OR REPLACE FUNCTION app.assistant_payroll_reset_review_complete(p_id uuid,p_reviewed_digest text,p_event uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;actual app.assistant_own_leave_review%ROWTYPE;minimal jsonb;source jsonb;root jsonb;
BEGIN
 PERFORM app._assistant_payroll_reset_review_identity(NULL,false);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND action_kind='payroll.reset' FOR UPDATE NOWAIT;
 IF NOT FOUND OR p_event IS NULL THEN RAISE EXCEPTION 'Payroll reset unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_payroll_reset_review_source(r.person_id,r.payroll_reset_batch_id,r.company_id,r.payroll_reset_period_id);
 IF r.state='completed' THEN
  IF r.payroll_reset_event_id IS DISTINCT FROM p_event OR app.read_own_payroll_reset_effect(r.payroll_reset_batch_id,p_event) IS NULL THEN RAISE EXCEPTION 'Payroll reset unavailable' USING ERRCODE='42501';END IF;
 ELSIF r.state='awaiting_confirmation' AND clock_timestamp()<r.expires_at THEN
  IF r.reviewed_digest IS DISTINCT FROM p_reviewed_digest OR r.payroll_reset_person_ids IS NULL OR NOT EXISTS(SELECT 1 FROM app.assistant_own_leave_review_content WHERE action_id=r.id) THEN RAISE EXCEPTION 'Payroll reset unavailable' USING ERRCODE='42501';END IF;
  minimal:=app._payroll_reset_complete_effect(r.id,p_event,false);
  source:=app._payroll_completion_snapshot(r.payroll_reset_batch_id,
   ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(r.payroll_reset_proof->'source'->'meta'->'loanIds')),
   ARRAY(SELECT key::uuid FROM jsonb_each(coalesce(r.payroll_reset_proof->'source'->'rows'->'payroll_individual_txn','{}'::jsonb))),false);
  root:=app._payroll_completion_root(r,p_event,source,r.payroll_reset_proof->'source'->'rows');
  UPDATE app.assistant_own_leave_review SET state='completed',intent_digest=NULL,reviewed_digest=NULL,payroll_reset_event_id=p_event,payroll_reset_person_ids=NULL,payroll_reset_proof=minimal,payroll_completion_root=root WHERE id=r.id;
  DELETE FROM app.assistant_own_leave_review_content WHERE action_id=r.id;
  SELECT * INTO actual FROM app.assistant_own_leave_review WHERE id=r.id;
  PERFORM app._payroll_completion_assert(r,actual);
 ELSE RAISE EXCEPTION 'Payroll reset unavailable' USING ERRCODE='42501';END IF;
 RETURN app._assistant_payroll_reset_review_json(r.id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_payroll_reset_review_complete(uuid,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_payroll_reset_review_complete(uuid,text,uuid) TO ai_hr_app;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.assistant_payroll_reopen_review_complete(p_id uuid,p_reviewed_digest text,p_event uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;actual app.assistant_own_leave_review%ROWTYPE;source jsonb;root jsonb;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();
BEGIN
 PERFORM app._assistant_payroll_reopen_review_identity(NULL,false);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=t AND user_id=u AND action_kind='payroll.reopen' FOR UPDATE NOWAIT;
 IF NOT FOUND OR p_event IS NULL THEN RAISE EXCEPTION 'Payroll reopen review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_payroll_reopen_review_source(r.person_id,r.payroll_reopen_batch_id,r.company_id,r.payroll_reopen_period_id);
 IF r.state='completed' THEN
  IF r.payroll_reopened_event_id IS DISTINCT FROM p_event THEN RAISE EXCEPTION 'Payroll reopen review unavailable' USING ERRCODE='42501';END IF;
 ELSIF r.state='awaiting_confirmation' AND clock_timestamp()<r.expires_at THEN
  IF r.reviewed_digest IS DISTINCT FROM p_reviewed_digest OR r.payroll_reopen_person_ids IS NULL OR NOT EXISTS(SELECT 1 FROM app.assistant_own_leave_review_content c WHERE c.action_id=r.id) THEN RAISE EXCEPTION 'Payroll reopen review unavailable' USING ERRCODE='42501';END IF;
  IF app.read_own_payroll_reopen_effect(r.payroll_reopen_batch_id,p_event) IS NULL OR NOT EXISTS(
   SELECT 1 FROM public.payroll_batch b JOIN public.domain_event d ON d.id=p_event AND d.tenant_id=b.tenant_id
   JOIN public.payroll_status_history h ON h.id=(d.payload->>'statusHistoryId')::uuid AND h.tenant_id=b.tenant_id
   JOIN public.pay_period parent ON parent.id=b.pay_period_id AND parent.tenant_id=b.tenant_id
   WHERE b.id=r.payroll_reopen_batch_id AND b.company_id=r.company_id AND b.pay_period_id=r.payroll_reopen_period_id
    AND b.tenant_id=t AND b.status='processed' AND parent.status='open'
    AND b.xmin=pg_current_xact_id()::xid AND h.xmin=pg_current_xact_id()::xid AND d.xmin=pg_current_xact_id()::xid
    AND (NOT (d.payload->>'reopenedPeriod')::boolean OR (parent.xmin=pg_current_xact_id()::xid AND EXISTS(
     SELECT 1 FROM public.domain_event pe WHERE pe.id=(d.payload->>'periodReopenedEventId')::uuid AND pe.tenant_id=t AND pe.xmin=pg_current_xact_id()::xid)))
  ) THEN RAISE EXCEPTION 'Payroll reopen review unavailable' USING ERRCODE='42501';END IF;
  IF r.payroll_completion_root->>'phase' IS DISTINCT FROM 'prepared' THEN RAISE EXCEPTION 'Payroll reopening needs a fresh review' USING ERRCODE='42501';END IF;
  source:=app._payroll_completion_snapshot(r.payroll_reopen_batch_id,
   ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(r.payroll_completion_root->'source'->'meta'->'loanIds')),
   ARRAY(SELECT key::uuid FROM jsonb_each(coalesce(r.payroll_completion_root->'source'->'rows'->'payroll_individual_txn','{}'::jsonb))),true);
  root:=app._payroll_completion_root(r,p_event,source,r.payroll_completion_root->'source'->'rows');
  UPDATE app.assistant_own_leave_review SET state='completed',intent_digest=NULL,reviewed_digest=NULL,payroll_reopened_event_id=p_event,payroll_reopen_person_ids=NULL,payroll_completion_root=root WHERE id=r.id;
  DELETE FROM app.assistant_own_leave_review_content WHERE action_id=r.id;
  SELECT * INTO actual FROM app.assistant_own_leave_review WHERE id=r.id;
  PERFORM app._payroll_completion_assert(r,actual);
 ELSE RAISE EXCEPTION 'Payroll reopen review unavailable' USING ERRCODE='42501';END IF;
 RETURN app._assistant_payroll_reopen_review_json(r.id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_payroll_reopen_review_complete(uuid,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_payroll_reopen_review_complete(uuid,text,uuid) TO ai_hr_app;
--> statement-breakpoint
ALTER FUNCTION app.assistant_payroll_reopen_review_prepare(uuid,uuid,uuid,uuid,uuid,uuid[],uuid,uuid[],text,text,text,text,text) RENAME TO _assistant_payroll_reopen_prepare_before_root;
CREATE FUNCTION app.assistant_payroll_reopen_review_prepare(p_id uuid,p_person uuid,p_batch uuid,p_company uuid,p_period uuid,p_people uuid[],p_prior uuid,p_coverage uuid[],p_intent_digest text,p_reviewed_digest text,p_kid text,p_wrapped_dek text,p_ciphertext text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source jsonb;root jsonb;r app.assistant_own_leave_review%ROWTYPE;actual app.assistant_own_leave_review%ROWTYPE;
 batch public.payroll_batch%ROWTYPE;parent public.pay_period%ROWTYPE;period_key text;
BEGIN
 PERFORM app._assistant_payroll_reopen_review_source(p_person,p_batch,p_company,p_period);
 SELECT * INTO batch FROM public.payroll_batch WHERE id=p_batch AND tenant_id=app.current_tenant_id() AND company_id=p_company AND pay_period_id=p_period;
 IF NOT FOUND OR batch.status<>'closed' OR batch.pay_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' THEN RAISE EXCEPTION 'Payroll reopening source unavailable' USING ERRCODE='42501';END IF;
 -- Same exact native JSON.stringify([tenant,company,month]) advisory key text; UUID/month have no spaces.
 period_key:='payroll-period:['||to_jsonb(batch.tenant_id)::text||','||to_jsonb(batch.company_id)::text||','||to_jsonb(batch.pay_period)::text||']';
 PERFORM pg_advisory_xact_lock(hashtextextended(period_key,0));
 SELECT * INTO batch FROM public.payroll_batch WHERE id=p_batch AND tenant_id=app.current_tenant_id() AND company_id=p_company AND pay_period_id=p_period AND status='closed' FOR UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Payroll reopening source changed' USING ERRCODE='42501';END IF;
 SELECT * INTO parent FROM public.pay_period WHERE id=p_period AND tenant_id=batch.tenant_id AND company_id=batch.company_id AND period=batch.pay_period FOR UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Payroll reopening parent changed' USING ERRCODE='42501';END IF;
 source:=app._payroll_completion_snapshot(p_batch,NULL,NULL,true);
 PERFORM app._assistant_payroll_reopen_prepare_before_root(p_id,p_person,p_batch,p_company,p_period,p_people,p_prior,p_coverage,p_intent_digest,p_reviewed_digest,p_kid,p_wrapped_dek,p_ciphertext);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id;
 root:=jsonb_build_object('phase','prepared','source',source);
 UPDATE app.assistant_own_leave_review SET payroll_completion_root=root WHERE id=p_id;
 SELECT * INTO actual FROM app.assistant_own_leave_review WHERE id=p_id;
 IF to_jsonb(actual) IS DISTINCT FROM (to_jsonb(r)||jsonb_build_object('payroll_completion_root',root))
 OR app._payroll_completion_snapshot(p_batch,NULL,NULL,true) IS DISTINCT FROM source
 THEN RAISE EXCEPTION 'Payroll reopening preparation changed' USING ERRCODE='42501';END IF;
 RETURN app._assistant_payroll_reopen_review_json(p_id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_payroll_reopen_review_prepare(uuid,uuid,uuid,uuid,uuid,uuid[],uuid,uuid[],text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_payroll_reopen_review_prepare(uuid,uuid,uuid,uuid,uuid,uuid[],uuid,uuid[],text,text,text,text,text) TO ai_hr_app;
REVOKE ALL ON FUNCTION app._assistant_payroll_reopen_prepare_before_root(uuid,uuid,uuid,uuid,uuid,uuid[],uuid,uuid[],text,text,text,text,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._payroll_completion_body_retired() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_RELID<>'app.assistant_own_leave_review_content'::regclass OR TG_OP<>'DELETE'
 THEN RAISE EXCEPTION 'Payroll proof retirement unavailable' USING ERRCODE='42501';END IF;
 -- DELETE is outside central0861. Its body tuple is already held, so never block while
 -- upgrading/acquiring the parent. Exact unrelated/missing/completed/already-cleared rows
 -- remain no-op; a competing SHARE or UPDATE fails the whole writer with native55P03.
 PERFORM 1 FROM app.assistant_own_leave_review WHERE id=OLD.action_id
  AND action_kind IN('payroll.reset','payroll.reopen') AND state<>'completed' AND payroll_completion_root IS NOT NULL
 FOR UPDATE NOWAIT;
 IF NOT FOUND THEN RETURN NULL;END IF;
 UPDATE app.assistant_own_leave_review SET payroll_completion_root=NULL WHERE id=OLD.action_id
  AND action_kind IN('payroll.reset','payroll.reopen') AND state<>'completed' AND payroll_completion_root IS NOT NULL;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app._payroll_completion_body_retired() FROM PUBLIC,ai_hr_app;
-- Run before legacy assistant_payroll_reopen/reset_body_retired: those existing cohort/proof
-- cleanup callbacks must inherit this parent lock, rather than block before reaching it.
CREATE TRIGGER assistant_payroll_completion_body_retired AFTER DELETE ON app.assistant_own_leave_review_content FOR EACH ROW EXECUTE FUNCTION app._payroll_completion_body_retired();
--> statement-breakpoint
-- Canonical privacy intent admits the later transaction. Preserve its existing capture/target erasure,
-- and clear only the newly retained private root relevance state; no event/history or receipt rewrite.
ALTER FUNCTION app.native_outcome_targets_redact(uuid) RENAME TO _native_outcome_targets_redact_before_payroll_root;
CREATE FUNCTION app.native_outcome_targets_redact(p_employment uuid) RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE i app.home_greeting_erasure_intent%ROWTYPE;total integer;
BEGIN
 total:=app._native_outcome_targets_redact_before_payroll_root(p_employment);
 SELECT * INTO i FROM app.home_greeting_erasure_intent WHERE xact_id=pg_current_xact_id() AND tenant_id=app.current_tenant_id()
  AND user_id=app.current_user_id() AND employment_id=p_employment;
 IF NOT FOUND OR app.principal_snapshot_current() IS NOT TRUE OR app.can_admin_employment(p_employment) IS NOT TRUE
 THEN RAISE EXCEPTION 'Payroll root erasure admission unavailable' USING ERRCODE='42501';END IF;
 UPDATE app.assistant_own_leave_review r SET payroll_completion_root=NULL
 WHERE r.tenant_id=i.tenant_id AND r.action_kind IN('payroll.reset','payroll.reopen') AND r.payroll_completion_root->>'phase'='completed'
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(r.payroll_completion_root->'capture'->'targets') target
  WHERE (target->>0='person' AND target->>1=i.person_id::text) OR (target->>0='employment' AND target->>1=i.employment_id::text));
 RETURN total;
END $$;
REVOKE ALL ON FUNCTION app.native_outcome_targets_redact(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.native_outcome_targets_redact(uuid) TO ai_hr_app;
REVOKE ALL ON FUNCTION app._native_outcome_targets_redact_before_payroll_root(uuid) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
-- Reopening pending whole-source hashes cover non-payslip subjects too. Its existing native
-- context/caller/cohort now all use the same private bounded source metadata; canonical capture
-- already unions stored reopen PERSON cohort and caller native EMPLOYMENT targets. No app fields.
CREATE OR REPLACE FUNCTION app.payroll_reopen_review_context(p_batch uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE b public.payroll_batch%ROWTYPE;c public.company%ROWTYPE;parent public.pay_period%ROWTYPE;cycle public.payroll_cycle%ROWTYPE;witness jsonb;stable_witness jsonb;people uuid[];employees uuid[];
BEGIN
 PERFORM app._assistant_payroll_reopen_review_identity(NULL,false,false);
 SELECT * INTO b FROM public.payroll_batch WHERE id=p_batch AND tenant_id=app.current_tenant_id();
 IF NOT FOUND OR app.can_admin_payroll_for(b.company_id) IS NOT TRUE THEN RAISE EXCEPTION 'Payroll reopening unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO c FROM public.company WHERE id=b.company_id AND tenant_id=b.tenant_id;
 SELECT * INTO parent FROM public.pay_period WHERE id=b.pay_period_id AND tenant_id=b.tenant_id AND company_id=b.company_id AND period=b.pay_period;
 IF NOT FOUND THEN RAISE EXCEPTION 'Payroll parent unavailable';END IF;
 SELECT * INTO cycle FROM public.payroll_cycle WHERE id=b.payroll_cycle_id AND tenant_id=b.tenant_id;
 IF (SELECT count(*) FROM public.domain_event e WHERE e.tenant_id=b.tenant_id AND e.aggregate_id=b.id)>10000 OR (SELECT count(*) FROM public.statutory_report r WHERE r.tenant_id=b.tenant_id AND r.company_id=b.company_id AND r.period_key=b.pay_period)>10000 THEN RAISE EXCEPTION 'Payroll reopening requires native handoff' USING ERRCODE='54000';END IF;
 SELECT ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(app._payroll_completion_snapshot(b.id,NULL,NULL,true)->'meta'->'people')) INTO people;
 SELECT ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(app._payroll_completion_snapshot(b.id,NULL,NULL,true)->'meta'->'employees')) INTO employees;
 IF cardinality(people)>10000 OR cardinality(employees)>10000 THEN RAISE EXCEPTION 'Payroll reopening requires native handoff' USING ERRCODE='54000';END IF;
 SELECT jsonb_build_object('financialSource',app._payroll_reset_hash(app._payroll_completion_snapshot(b.id,NULL,NULL,true)->'rows'),'batch',to_jsonb(b),'batchVersion',(SELECT xmin::text FROM public.payroll_batch WHERE id=b.id),'parent',to_jsonb(parent),'parentVersion',(SELECT xmin::text FROM public.pay_period WHERE id=parent.id),'company',to_jsonb(c),'cycle',to_jsonb(cycle),'adopted',app.payroll_history_batch_adopted(b.id),
 'events',(SELECT coalesce(jsonb_agg(jsonb_build_array(e.id,e.xmin::text) ORDER BY e.id),'[]'::jsonb) FROM public.domain_event e WHERE e.tenant_id=b.tenant_id AND e.aggregate_id=b.id),
 'reports',(SELECT coalesce(jsonb_agg(jsonb_build_array(r.id,r.status,r.xmin::text) ORDER BY r.id),'[]'::jsonb) FROM public.statutory_report r WHERE r.tenant_id=b.tenant_id AND r.company_id=b.company_id AND r.period_key=b.pay_period),
 'people',people,'employees',employees) INTO witness;
 IF octet_length(witness::text)>1000000 THEN RAISE EXCEPTION 'Payroll reopening requires native handoff' USING ERRCODE='54000';END IF;
 SELECT jsonb_build_object('financialSource',app._payroll_reset_hash(app._payroll_completion_snapshot(b.id,NULL,NULL,true)->'rows'),'batch',to_jsonb(b)-'status','parent',to_jsonb(parent)-'status','company',to_jsonb(c),'companyVersion',(SELECT xmin::text FROM public.company WHERE id=c.id),'cycle',to_jsonb(cycle),'cycleVersion',(SELECT xmin::text FROM public.payroll_cycle WHERE id=cycle.id),'people',people,'employees',employees,
 'exports',(SELECT coalesce(jsonb_agg(jsonb_build_array(e.id,e.xmin::text) ORDER BY e.id),'[]'::jsonb) FROM public.domain_event e WHERE e.tenant_id=b.tenant_id AND e.aggregate_id=b.id AND e.event_type='payroll-batch.payment-summary.exported'),
 'reports',(SELECT coalesce(jsonb_agg(jsonb_build_array(r.id,r.status,r.xmin::text) ORDER BY r.id),'[]'::jsonb) FROM public.statutory_report r WHERE r.tenant_id=b.tenant_id AND r.company_id=b.company_id AND r.period_key=b.pay_period)) INTO stable_witness;
 RETURN jsonb_build_object('companyName',c.legal_name,'cycleName',cycle.name,'sourceDigest',encode(sha256(convert_to(witness::text,'UTF8')),'hex'),'stableSourceDigest',encode(sha256(convert_to(stable_witness::text,'UTF8')),'hex'),'people',people,'employees',employees);
END $$;
REVOKE ALL ON FUNCTION app.payroll_reopen_review_context(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.payroll_reopen_review_context(uuid) TO ai_hr_app;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app._assistant_payroll_reopen_prepare_before_root(p_id uuid,p_person uuid,p_batch uuid,p_company uuid,p_period uuid,p_people uuid[],p_prior uuid,p_coverage uuid[],p_intent_digest text,p_reviewed_digest text,p_kid text,p_wrapped_dek text,p_ciphertext text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();at_time timestamptz;people uuid[];
BEGIN
 PERFORM app._assistant_payroll_reopen_review_source(p_person,p_batch,p_company,p_period);
 IF NOT EXISTS(SELECT 1 FROM public.payroll_batch b JOIN public.pay_period p ON p.id=b.pay_period_id WHERE b.id=p_batch AND b.tenant_id=t AND b.status='closed' AND p.status IN('open','closed')) THEN RAISE EXCEPTION 'Payroll reopen review unavailable' USING ERRCODE='42501';END IF;
 IF p_prior IS NOT NULL OR p_coverage IS DISTINCT FROM ARRAY[]::uuid[] THEN RAISE EXCEPTION 'Payroll reopening source unavailable' USING ERRCODE='42501';END IF;
 SELECT ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(app._payroll_completion_snapshot(p_batch,NULL,NULL,true)->'meta'->'people')) INTO people;
 IF p_people IS NULL OR p_people IS DISTINCT FROM people THEN RAISE EXCEPTION 'Payroll reopen review unavailable' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT 1 FROM app.home_greeting_erasure_intent i WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=t AND (i.person_id=p_person OR i.person_id=ANY(people))) OR EXISTS(SELECT 1 FROM app.assistant_review_erasure_intent i WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=t AND (i.person_id=p_person OR i.person_id=ANY(people))) THEN RAISE EXCEPTION 'Payroll reopen review unavailable' USING ERRCODE='42501';END IF;
 IF p_id IS NULL OR p_intent_digest IS NULL OR p_intent_digest !~ '^[a-f0-9]{64}$' OR p_reviewed_digest IS NULL OR p_reviewed_digest !~ '^[a-f0-9]{64}$' OR p_kid IS NULL OR p_kid !~ '^[a-f0-9]{16}$' OR p_wrapped_dek IS NULL OR length(p_wrapped_dek) NOT BETWEEN 1 AND 512 OR p_ciphertext IS NULL OR octet_length(p_ciphertext) NOT BETWEEN 1 AND 65536 THEN RAISE EXCEPTION 'Payroll reopen review unavailable' USING ERRCODE='22023';END IF;
 at_time:=clock_timestamp();
 IF (SELECT count(*) FROM app.assistant_own_leave_review WHERE tenant_id=t AND user_id=u AND state='awaiting_confirmation' AND expires_at>at_time)>=5 OR (SELECT count(*) FROM app.assistant_own_leave_review WHERE tenant_id=t AND user_id=u AND created_at>at_time-interval '10 minutes')>=20 THEN RAISE EXCEPTION 'Payroll reopen review unavailable' USING ERRCODE='54000';END IF;
 INSERT INTO app.assistant_own_leave_review(action_kind,id,tenant_id,user_id,person_id,employment_id,company_id,payroll_reopen_batch_id,payroll_reopen_period_id,payroll_reopen_person_ids,intent_digest,reviewed_digest,state,created_at,expires_at)
 VALUES('payroll.reopen',p_id,t,u,p_person,NULL,p_company,p_batch,p_period,people,p_intent_digest,p_reviewed_digest,'awaiting_confirmation',at_time,at_time+interval '10 minutes') ON CONFLICT(id) DO NOTHING;
 IF NOT FOUND THEN RAISE EXCEPTION 'Payroll reopen review unavailable' USING ERRCODE='42501';END IF;
 INSERT INTO app.assistant_own_leave_review_content VALUES(p_id,p_kid,p_wrapped_dek,p_ciphertext);
 RETURN app._assistant_payroll_reopen_review_json(p_id);
END $$;
REVOKE ALL ON FUNCTION app._assistant_payroll_reopen_prepare_before_root(uuid,uuid,uuid,uuid,uuid,uuid[],uuid,uuid[],text,text,text,text,text) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
-- Exact owned retirement statements scrub prepared private source atomically with terminal state.
CREATE OR REPLACE FUNCTION app.assistant_payroll_reopen_review_read(p_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;
BEGIN
 PERFORM app._assistant_payroll_reopen_review_identity(NULL,false);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND action_kind='payroll.reopen' FOR UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Payroll reopen review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_payroll_reopen_review_source(r.person_id,r.payroll_reopen_batch_id,r.company_id,r.payroll_reopen_period_id);
 IF r.state='awaiting_confirmation' AND (r.payroll_reopen_person_ids IS NULL OR NOT EXISTS(SELECT 1 FROM app.assistant_own_leave_review_content c WHERE c.action_id=r.id)) THEN RAISE EXCEPTION 'Payroll reopen review unavailable' USING ERRCODE='42501';END IF;
 IF r.state='awaiting_confirmation' AND clock_timestamp()>=r.expires_at THEN UPDATE app.assistant_own_leave_review SET state='expired',intent_digest=NULL,reviewed_digest=NULL,payroll_reopen_person_ids=NULL,payroll_completion_root=NULL WHERE id=r.id;END IF;
 DELETE FROM app.assistant_own_leave_review_content c USING app.assistant_own_leave_review a WHERE c.action_id=a.id AND a.id=r.id AND a.state<>'awaiting_confirmation';
 RETURN app._assistant_payroll_reopen_review_json(r.id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_payroll_reopen_review_read(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_payroll_reopen_review_read(uuid) TO ai_hr_app;

--> statement-breakpoint
-- Exact owned retirement statements scrub prepared private source atomically with terminal state.
CREATE OR REPLACE FUNCTION app.assistant_payroll_reopen_review_discard(p_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;
BEGIN
 PERFORM app._assistant_payroll_reopen_review_identity(NULL,false);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND action_kind='payroll.reopen' FOR UPDATE NOWAIT;
 IF NOT FOUND OR r.state='completed' THEN RAISE EXCEPTION 'Payroll reopen review unavailable' USING ERRCODE='42501';END IF;
 IF r.state='awaiting_confirmation' THEN UPDATE app.assistant_own_leave_review SET state=CASE WHEN clock_timestamp()>=r.expires_at THEN 'expired' ELSE 'discarded' END,intent_digest=NULL,reviewed_digest=NULL,payroll_reopen_person_ids=NULL,payroll_completion_root=NULL WHERE id=r.id;END IF;
 DELETE FROM app.assistant_own_leave_review_content WHERE action_id=r.id;
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=r.id;
 RETURN jsonb_build_object('action','payroll.reopen','contractVersion',1,'actionId',r.id,'state',r.state);
END $$;
REVOKE ALL ON FUNCTION app.assistant_payroll_reopen_review_discard(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_payroll_reopen_review_discard(uuid) TO ai_hr_app;

--> statement-breakpoint
-- Native actual-target retirement keeps exact0754authority/sibling semantics and scrubs pending source.
CREATE OR REPLACE FUNCTION app.assistant_payroll_review_target_deleted() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE target_is_batch boolean;review_row record;
BEGIN
 IF TG_OP<>'DELETE' OR TG_RELID NOT IN('public.payroll_batch'::regclass,'public.pay_period'::regclass) THEN
  RAISE EXCEPTION 'Payroll review retirement operation unavailable';
 END IF;
 target_is_batch:=TG_RELID='public.payroll_batch'::regclass;
 -- No new scope/status restriction on unrelated native/SYSTEM/owner/tenant cleanup paths.
 IF NOT EXISTS(SELECT 1 FROM app.assistant_own_leave_review r
  WHERE r.tenant_id=OLD.tenant_id AND r.company_id=OLD.company_id
   AND ((r.action_kind='payroll.reset' AND CASE WHEN target_is_batch THEN r.payroll_reset_batch_id=OLD.id ELSE r.payroll_reset_period_id=OLD.id END)
    OR (r.action_kind='payroll.reopen' AND CASE WHEN target_is_batch THEN r.payroll_reopen_batch_id=OLD.id ELSE r.payroll_reopen_period_id=OLD.id END)))
 THEN RETURN NULL;END IF;
 -- Actual OLD row already deleted through native/RLS owner; never a caller-nominated target UUID.
 -- Same financial scope used by canonical teardown's Attendance release. Keep native SYSTEM semantics.
 IF OLD.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NOT app.can_admin_payroll_for(OLD.company_id)
  OR (target_is_batch AND OLD.status::text<>'draft') OR (NOT target_is_batch AND OLD.status::text<>'open')
 THEN RAISE EXCEPTION 'Payroll review target deletion unavailable' USING ERRCODE='42501';END IF;
 FOR review_row IN SELECT r.id FROM app.assistant_own_leave_review r
  WHERE r.tenant_id=OLD.tenant_id AND r.company_id=OLD.company_id
   AND ((r.action_kind='payroll.reset' AND CASE WHEN target_is_batch THEN r.payroll_reset_batch_id=OLD.id ELSE r.payroll_reset_period_id=OLD.id END)
    OR (r.action_kind='payroll.reopen' AND CASE WHEN target_is_batch THEN r.payroll_reopen_batch_id=OLD.id ELSE r.payroll_reopen_period_id=OLD.id END))
  ORDER BY r.user_id,r.id FOR UPDATE NOWAIT
 LOOP
  PERFORM action_id FROM app.assistant_own_leave_review_content WHERE action_id=review_row.id FOR UPDATE NOWAIT;
  -- Cross-user pending rows target the actually deleted run; no sibling/foreign-company selection.
  UPDATE app.assistant_own_leave_review SET state='refused',intent_digest=NULL,reviewed_digest=NULL,
   payroll_reopen_person_ids=NULL,payroll_reset_person_ids=NULL,payroll_reset_proof=NULL,payroll_completion_root=NULL
   WHERE id=review_row.id AND state='awaiting_confirmation';
  DELETE FROM app.assistant_own_leave_review_content WHERE action_id=review_row.id;
 END LOOP;
 -- Completed minimal ledger/event/protected historical commitment remains; no change to canonical
 -- native_outcome_source_capture/targets/association retention or its PDPA discovery ownership.
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.assistant_payroll_review_target_deleted() FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
-- Exact canonical 0622 shared expiry owner: only the private reopening pending state clears
-- atomically before the strict CHECK; existing actor, admission, limit and ordering stay intact.
CREATE OR REPLACE FUNCTION app.assistant_own_leave_reviews_expire(p_limit integer DEFAULT 100) RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();ids uuid[];
BEGIN
 IF t IS NULL OR app.current_user_id() IS NULL OR current_setting('transaction_isolation')<>'read committed'
  OR current_setting('transaction_read_only')<>'off' OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
  RAISE EXCEPTION 'Review cleanup unavailable' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0));
 IF app.principal_snapshot_current() IS NOT TRUE OR app.is_group_admin() IS NOT TRUE OR NOT EXISTS(
  SELECT 1 FROM public.app_user a WHERE a.id=app.current_user_id() AND a.tenant_id=t
   AND a.archived_at IS NULL AND NOT app.login_blocked(a.id)) THEN
  RAISE EXCEPTION 'Review cleanup unavailable' USING ERRCODE='42501';END IF;
 SELECT coalesce(array_agg(d.id),'{}') INTO ids FROM (
  SELECT id FROM app.assistant_own_leave_review WHERE tenant_id=t AND state='awaiting_confirmation'
   AND expires_at<=clock_timestamp() ORDER BY expires_at,id LIMIT p_limit FOR UPDATE) d;
 UPDATE app.assistant_own_leave_review SET intent_digest=NULL,reviewed_digest=NULL,state='expired',payroll_completion_root=CASE WHEN action_kind='payroll.reopen' THEN NULL ELSE payroll_completion_root END,org_manager_person_id=NULL,org_previous_manager_person_id=NULL WHERE id=ANY(ids) AND tenant_id=t;
 DELETE FROM app.assistant_own_leave_review_content WHERE action_id=ANY(ids);
 RETURN cardinality(ids);
END $$;
REVOKE ALL ON FUNCTION app.assistant_own_leave_reviews_expire(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_own_leave_reviews_expire(integer) TO ai_hr_app;

--> statement-breakpoint
-- Exact canonical 0622 shared expiry owner: only the private reopening pending state clears
-- atomically before the strict CHECK; existing actor, admission, limit and ordering stay intact.
CREATE OR REPLACE FUNCTION app.assistant_own_leave_reviews_expire_own(p_limit integer DEFAULT 100) RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();ids uuid[];
BEGIN
 IF t IS NULL OR u IS NULL OR current_setting('transaction_isolation')<>'read committed'
  OR current_setting('transaction_read_only')<>'off' OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
  RAISE EXCEPTION 'Review cleanup unavailable' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0));
 IF app.principal_snapshot_current() IS NOT TRUE OR NOT EXISTS(
  SELECT 1 FROM public.app_user a WHERE a.id=u AND a.tenant_id=t AND a.archived_at IS NULL AND NOT app.login_blocked(a.id)) THEN
  RAISE EXCEPTION 'Review cleanup unavailable' USING ERRCODE='42501';END IF;
 SELECT coalesce(array_agg(d.id),'{}') INTO ids FROM (
  SELECT id FROM app.assistant_own_leave_review WHERE tenant_id=t AND user_id=u AND state='awaiting_confirmation'
   AND expires_at<=clock_timestamp() ORDER BY expires_at,id LIMIT p_limit FOR UPDATE) d;
 UPDATE app.assistant_own_leave_review SET intent_digest=NULL,reviewed_digest=NULL,state='expired',payroll_completion_root=CASE WHEN action_kind='payroll.reopen' THEN NULL ELSE payroll_completion_root END,org_manager_person_id=NULL,org_previous_manager_person_id=NULL WHERE id=ANY(ids) AND tenant_id=t AND user_id=u;
 DELETE FROM app.assistant_own_leave_review_content WHERE action_id=ANY(ids);
 RETURN cardinality(ids);
END $$;
REVOKE ALL ON FUNCTION app.assistant_own_leave_reviews_expire_own(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_own_leave_reviews_expire_own(integer) TO ai_hr_app;
