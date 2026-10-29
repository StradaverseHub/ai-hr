CREATE TABLE payroll_txn_import_attempt (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),
 operation_id uuid NOT NULL,created_by uuid NOT NULL REFERENCES app_user(id),company_ids jsonb NOT NULL CHECK(jsonb_typeof(company_ids)='array'),
 source_name text NOT NULL CHECK(length(source_name) BETWEEN 1 AND 255),source_hash text NOT NULL CHECK(source_hash~'^[0-9a-f]{64}$'),
 bindings jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(bindings)='object'),
 method text NOT NULL CHECK(method IN ('monthly','daily')),records jsonb NOT NULL,preview jsonb NOT NULL,outcomes jsonb NOT NULL DEFAULT '[]',
 state text NOT NULL DEFAULT 'validated' CHECK(state IN ('validated','completed','reverted')),written integer NOT NULL DEFAULT 0 CHECK(written BETWEEN 0 AND 2000),
 recalc_batch_ids jsonb NOT NULL DEFAULT '[]',created_at timestamptz NOT NULL DEFAULT now(),reverted_at timestamptz,reverted_by uuid REFERENCES app_user(id),
 CONSTRAINT payroll_txn_import_operation UNIQUE(tenant_id,created_by,operation_id),
 CHECK(jsonb_typeof(records)='array' AND jsonb_array_length(records)<=2000),CHECK(jsonb_typeof(outcomes)='array'),
 CHECK((state='reverted')=(reverted_at IS NOT NULL AND reverted_by IS NOT NULL))
);
ALTER TABLE payroll_txn_import_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_txn_import_attempt FORCE ROW LEVEL SECURITY;
CREATE POLICY payroll_txn_import_scope ON payroll_txn_import_attempt FOR ALL
 USING(tenant_id=app.current_tenant_id() AND app.current_user_id() IS NOT NULL AND app.principal_snapshot_current() AND app.is_admin()
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(company_ids) c WHERE NOT app.is_admin_for(c::uuid)))
 WITH CHECK(tenant_id=app.current_tenant_id() AND app.current_user_id() IS NOT NULL AND app.principal_snapshot_current() AND app.is_admin()
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(company_ids) c WHERE NOT app.is_admin_for(c::uuid)));
GRANT SELECT,INSERT,UPDATE ON payroll_txn_import_attempt TO ai_hr_app;
-- Source and original row outcomes cannot be rewritten when an import is reversed.
CREATE FUNCTION app.payroll_txn_import_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.created_by IS DISTINCT FROM app.current_user_id() THEN RAISE EXCEPTION 'Import actor mismatch' USING ERRCODE='42501'; END IF;
  RETURN NEW;
 END IF;
 IF (NEW.id,NEW.tenant_id,NEW.operation_id,NEW.created_by,NEW.company_ids,NEW.source_name,NEW.source_hash,NEW.method,NEW.records,NEW.bindings,NEW.created_at)
  IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.operation_id,OLD.created_by,OLD.company_ids,OLD.source_name,OLD.source_hash,OLD.method,OLD.records,OLD.bindings,OLD.created_at)
 THEN RAISE EXCEPTION 'Import source is immutable' USING ERRCODE='23514'; END IF;
 IF OLD.state='validated' AND NEW.state='completed' THEN
  IF jsonb_array_length(NEW.outcomes)<>jsonb_array_length(NEW.preview->'rows') OR NEW.written<>(SELECT count(*) FROM jsonb_array_elements(NEW.outcomes) o WHERE o->>'state'='imported')
  THEN RAISE EXCEPTION 'Import outcomes do not reconcile' USING ERRCODE='23514'; END IF;
 ELSIF OLD.state='completed' AND NEW.state='reverted' THEN
  IF (NEW.preview,NEW.outcomes,NEW.written,NEW.recalc_batch_ids) IS DISTINCT FROM (OLD.preview,OLD.outcomes,OLD.written,OLD.recalc_batch_ids)
  OR NEW.reverted_by IS DISTINCT FROM app.current_user_id() THEN RAISE EXCEPTION 'Import outcomes are immutable' USING ERRCODE='23514'; END IF;
 ELSE RAISE EXCEPTION 'Invalid import transition' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER payroll_txn_import_immutable BEFORE INSERT OR UPDATE ON payroll_txn_import_attempt FOR EACH ROW EXECUTE FUNCTION app.payroll_txn_import_immutable();

--> statement-breakpoint
-- Runtime has no broad employment UPDATE grant (required even by FOR SHARE). Only lock the
-- immutable identities of one caller-authorized attempt; this helper cannot modify any business row.
CREATE FUNCTION app.payroll_txn_import_lock_bindings(p_attempt uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $$
DECLARE a public.payroll_txn_import_attempt;bound jsonb;field text;uuid_pattern text:='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
BEGIN
 IF nullif(current_setting('app.agent_principal_id',true),'') IS NOT NULL OR app.current_user_id() IS NULL OR NOT app.principal_snapshot_current() OR NOT app.is_admin() THEN
  RAISE EXCEPTION 'Import access denied' USING ERRCODE='42501'; END IF;
 SELECT * INTO a FROM public.payroll_txn_import_attempt WHERE id=p_attempt AND tenant_id=app.current_tenant_id();
 IF a.id IS NULL OR jsonb_array_length(a.company_ids)=0 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(a.company_ids) c WHERE NOT app.is_admin_for(c::uuid)) THEN
  RAISE EXCEPTION 'Import access denied' USING ERRCODE='42501'; END IF;
 -- Stored JSON is immutable, not trusted: runtime INSERT remains subject to direct-input abuse.
 FOR bound IN SELECT value FROM jsonb_each(a.bindings) LOOP
  IF jsonb_typeof(bound)<>'object' OR NOT (bound ?& ARRAY['employmentId','companyId','componentId','intendedCycleId','targetBatchId','payPeriod']) THEN
   RAISE EXCEPTION 'Import binding unavailable' USING ERRCODE='42501'; END IF;
  FOREACH field IN ARRAY ARRAY['employmentId','companyId','componentId'] LOOP
   IF (bound->>field ~ uuid_pattern) IS NOT TRUE THEN RAISE EXCEPTION 'Import binding unavailable' USING ERRCODE='42501'; END IF;
  END LOOP;
  FOREACH field IN ARRAY ARRAY['intendedCycleId','targetBatchId'] LOOP
   IF bound->field<>'null'::jsonb AND (bound->>field ~ uuid_pattern) IS NOT TRUE THEN RAISE EXCEPTION 'Import binding unavailable' USING ERRCODE='42501'; END IF;
  END LOOP;
  IF NOT (a.company_ids ? ((bound->>'companyId')::uuid)::text) THEN RAISE EXCEPTION 'Import binding unavailable' USING ERRCODE='42501'; END IF;
 END LOOP;
 -- Filter by actual company before each role-bypassing lock, then verify relationships under locks.
 PERFORM b.id FROM public.payroll_batch b WHERE b.tenant_id=a.tenant_id AND a.company_ids ? b.company_id::text AND b.id IN
  (SELECT (value->>'targetBatchId')::uuid FROM jsonb_each(a.bindings)) ORDER BY b.id FOR UPDATE;
 PERFORM e.id FROM public.employment e WHERE e.tenant_id=a.tenant_id AND a.company_ids ? e.company_id::text AND e.id IN
  (SELECT (value->>'employmentId')::uuid FROM jsonb_each(a.bindings)) ORDER BY e.id FOR SHARE;
 PERFORM c.id FROM public.pay_component c WHERE c.tenant_id=a.tenant_id AND c.id IN
  (SELECT (value->>'componentId')::uuid FROM jsonb_each(a.bindings)) ORDER BY c.id FOR SHARE;
 PERFORM c.id FROM public.payroll_cycle c WHERE c.tenant_id=a.tenant_id AND a.company_ids ? c.company_id::text AND c.id IN
  (SELECT (value->>'intendedCycleId')::uuid FROM jsonb_each(a.bindings)) ORDER BY c.id FOR SHARE;
 FOR bound IN SELECT value FROM jsonb_each(a.bindings) LOOP
  IF NOT EXISTS(SELECT 1 FROM public.company c WHERE c.id=(bound->>'companyId')::uuid AND c.tenant_id=a.tenant_id)
   OR NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.id=(bound->>'employmentId')::uuid AND e.tenant_id=a.tenant_id AND e.company_id=(bound->>'companyId')::uuid)
   -- Pay components are tenant-wide catalogue rows, with no company ownership column.
   OR NOT EXISTS(SELECT 1 FROM public.pay_component c WHERE c.id=(bound->>'componentId')::uuid AND c.tenant_id=a.tenant_id)
   OR (bound->>'intendedCycleId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.payroll_cycle c WHERE c.id=(bound->>'intendedCycleId')::uuid AND c.tenant_id=a.tenant_id AND c.company_id=(bound->>'companyId')::uuid))
   OR (bound->>'targetBatchId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.payroll_batch r WHERE r.id=(bound->>'targetBatchId')::uuid AND r.tenant_id=a.tenant_id AND r.company_id=(bound->>'companyId')::uuid AND r.pay_period=bound->>'payPeriod')) THEN
   RAISE EXCEPTION 'Import binding unavailable' USING ERRCODE='42501'; END IF;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION app.payroll_txn_import_lock_bindings(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.payroll_txn_import_lock_bindings(uuid) TO ai_hr_app;
