CREATE TABLE payroll_txn_import_attempt (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),
 operation_id uuid NOT NULL,created_by uuid NOT NULL REFERENCES app_user(id),company_ids jsonb NOT NULL CHECK(jsonb_typeof(company_ids)='array'),
 source_name text NOT NULL CHECK(length(source_name) BETWEEN 1 AND 255),source_hash text NOT NULL CHECK(source_hash~'^[0-9a-f]{64}$'),
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
 IF (NEW.id,NEW.tenant_id,NEW.operation_id,NEW.created_by,NEW.company_ids,NEW.source_name,NEW.source_hash,NEW.method,NEW.records,NEW.created_at)
  IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.operation_id,OLD.created_by,OLD.company_ids,OLD.source_name,OLD.source_hash,OLD.method,OLD.records,OLD.created_at)
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
