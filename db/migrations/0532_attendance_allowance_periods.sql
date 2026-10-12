-- ADR-0106: explicit opt-in rules, immutable definitions, period evidence and payroll-owned sources.
-- No existing attendance, policy criteria/scope, or historical payroll component is rewritten.
ALTER TABLE attendance_allowance_policy ADD COLUMN policy_type text NOT NULL DEFAULT 'earning';
--> statement-breakpoint
UPDATE attendance_allowance_policy p SET policy_type='deduction'
FROM pay_component c WHERE c.id=p.pay_component_id AND c.kind='deduction';
--> statement-breakpoint
ALTER TABLE attendance_allowance_policy ADD COLUMN version integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE attendance_allowance_policy ADD COLUMN rules jsonb;
--> statement-breakpoint
ALTER TABLE attendance_allowance_policy ADD CONSTRAINT attendance_allowance_policy_type_ck CHECK (policy_type IN ('earning','deduction'));
--> statement-breakpoint
CREATE TABLE attendance_allowance_version (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),
 company_id uuid NOT NULL REFERENCES company(id),policy_id uuid NOT NULL REFERENCES attendance_allowance_policy(id),
 version integer NOT NULL CHECK(version>0),snapshot jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,policy_id,version)
);
--> statement-breakpoint
INSERT INTO attendance_allowance_version(tenant_id,company_id,policy_id,version,snapshot)
SELECT tenant_id,company_id,id,version,to_jsonb(p) FROM attendance_allowance_policy p;
--> statement-breakpoint
CREATE TABLE attendance_allowance_result (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),
 company_id uuid NOT NULL REFERENCES company(id),policy_id uuid NOT NULL REFERENCES attendance_allowance_policy(id),
 policy_version integer NOT NULL,employment_id uuid NOT NULL REFERENCES employment(id),pay_month text NOT NULL,
 period_key text NOT NULL,period_from date NOT NULL,period_to date NOT NULL,amount numeric(12,2) NOT NULL CHECK(amount>=0),
 qualified boolean NOT NULL,evidence jsonb NOT NULL,input_digest text NOT NULL,
 status text NOT NULL DEFAULT 'calculated' CHECK(status IN ('calculated','transferred','superseded')),
 calculated_at timestamptz NOT NULL DEFAULT now(),CHECK(period_to>=period_from),
 CONSTRAINT attendance_allowance_result_uq UNIQUE(tenant_id,policy_id,policy_version,employment_id,period_key)
);
--> statement-breakpoint
CREATE INDEX attendance_allowance_result_month_idx ON attendance_allowance_result(tenant_id,company_id,pay_month);
--> statement-breakpoint
CREATE TABLE payroll_attendance_allowance_source (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),
 company_id uuid NOT NULL REFERENCES company(id),batch_id uuid NOT NULL REFERENCES payroll_batch(id) ON DELETE CASCADE,
 policy_id uuid NOT NULL REFERENCES attendance_allowance_policy(id),result_id uuid NOT NULL REFERENCES attendance_allowance_result(id),
 employment_id uuid NOT NULL REFERENCES employment(id),component_id uuid NOT NULL REFERENCES pay_component(id),
 pay_month text NOT NULL,period_key text NOT NULL,amount numeric(12,2) NOT NULL CHECK(amount>=0),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT payroll_attendance_allowance_source_uq UNIQUE(tenant_id,policy_id,employment_id,period_key)
);
--> statement-breakpoint
CREATE INDEX payroll_attendance_allowance_batch_idx ON payroll_attendance_allowance_source(batch_id,employment_id,component_id);
--> statement-breakpoint
CREATE TABLE attendance_allowance_transfer (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),
 company_id uuid NOT NULL REFERENCES company(id),policy_id uuid NOT NULL REFERENCES attendance_allowance_policy(id),
 policy_version integer NOT NULL,batch_id uuid REFERENCES payroll_batch(id) ON DELETE SET NULL,batch_ref uuid NOT NULL,
 status text NOT NULL CHECK(status IN ('transferred','failed')),error_code text,input_digest text,
 created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE attendance_allowance_version ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY attendance_allowance_version_read ON attendance_allowance_version FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.is_admin_for(company_id));
--> statement-breakpoint
CREATE POLICY attendance_allowance_version_insert ON attendance_allowance_version FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.is_admin_for(company_id));
--> statement-breakpoint
GRANT SELECT,INSERT ON attendance_allowance_version TO ai_hr_app;
--> statement-breakpoint
ALTER TABLE attendance_allowance_result ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY attendance_allowance_result_rls ON attendance_allowance_result FOR ALL USING(tenant_id=app.current_tenant_id() AND app.is_admin_for(company_id) AND app.can_admin_employment(employment_id)) WITH CHECK(tenant_id=app.current_tenant_id() AND app.is_admin_for(company_id) AND app.can_admin_employment(employment_id));
--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON attendance_allowance_result TO ai_hr_app;
--> statement-breakpoint
ALTER TABLE payroll_attendance_allowance_source ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY payroll_attendance_allowance_source_rls ON payroll_attendance_allowance_source FOR ALL USING(tenant_id=app.current_tenant_id() AND app.is_admin_for(company_id) AND app.can_admin_employment(employment_id)) WITH CHECK(tenant_id=app.current_tenant_id() AND app.is_admin_for(company_id) AND app.can_admin_employment(employment_id));
--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE,DELETE ON payroll_attendance_allowance_source TO ai_hr_app;
--> statement-breakpoint
ALTER TABLE attendance_allowance_transfer ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY attendance_allowance_transfer_rls ON attendance_allowance_transfer FOR ALL USING(tenant_id=app.current_tenant_id() AND app.is_admin_for(company_id)) WITH CHECK(tenant_id=app.current_tenant_id() AND app.is_admin_for(company_id));
--> statement-breakpoint
GRANT SELECT,INSERT ON attendance_allowance_transfer TO ai_hr_app;

--> statement-breakpoint
CREATE TABLE attendance_allowance_result_revision (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),company_id uuid NOT NULL REFERENCES company(id),
 result_id uuid NOT NULL REFERENCES attendance_allowance_result(id),employment_id uuid NOT NULL REFERENCES employment(id),
 input_digest text NOT NULL,amount numeric(12,2) NOT NULL CHECK(amount>=0),evidence jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(result_id,input_digest)
);
--> statement-breakpoint
ALTER TABLE attendance_allowance_result_revision ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY attendance_allowance_result_revision_read ON attendance_allowance_result_revision FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.is_admin_for(company_id) AND app.can_admin_employment(employment_id));
--> statement-breakpoint
CREATE POLICY attendance_allowance_result_revision_insert ON attendance_allowance_result_revision FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.is_admin_for(company_id) AND app.can_admin_employment(employment_id));
--> statement-breakpoint
GRANT SELECT,INSERT ON attendance_allowance_result_revision TO ai_hr_app;

--> statement-breakpoint
REVOKE UPDATE,DELETE ON attendance_allowance_version,attendance_allowance_result_revision,attendance_allowance_transfer FROM ai_hr_app;
--> statement-breakpoint
REVOKE DELETE ON attendance_allowance_result FROM ai_hr_app;
--> statement-breakpoint
-- A manual edit cannot quietly overwrite a sum still owned by automatic allowance sources. The
-- projection writes the exact sum AFTER updating sources, in the same run-locked transaction.
CREATE FUNCTION app.attendance_allowance_component_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_sum numeric; source_count integer;
BEGIN
 SELECT count(*),coalesce(sum(amount),0) INTO source_count,source_sum
 FROM payroll_attendance_allowance_source WHERE batch_id=OLD.batch_id AND employment_id=OLD.employment_id AND component_id=OLD.component_id;
 IF source_count>0 AND (NEW.amount<>source_sum OR NEW.notes IS DISTINCT FROM 'Attendance allowance sources'
   OR (NEW.tenant_id,NEW.batch_id,NEW.employment_id,NEW.component_id) IS DISTINCT FROM (OLD.tenant_id,OLD.batch_id,OLD.employment_id,OLD.component_id)) THEN
  RAISE EXCEPTION 'This payroll input is owned by attendance allowance sources; recalculate the policy first';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER attendance_allowance_component_guard BEFORE UPDATE ON payroll_batch_component FOR EACH ROW EXECUTE FUNCTION app.attendance_allowance_component_guard();
--> statement-breakpoint
-- Draft teardown and an explicit payroll input deletion release the current sources while preserving
-- the immutable calculation revisions and transfer attempt references.
CREATE FUNCTION app.attendance_allowance_component_release() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE attendance_allowance_result SET status='superseded' WHERE id IN (
  SELECT result_id FROM payroll_attendance_allowance_source WHERE batch_id=OLD.batch_id AND employment_id=OLD.employment_id AND component_id=OLD.component_id
 );
 DELETE FROM payroll_attendance_allowance_source WHERE batch_id=OLD.batch_id AND employment_id=OLD.employment_id AND component_id=OLD.component_id;
 RETURN OLD;
END $$;
--> statement-breakpoint
CREATE TRIGGER attendance_allowance_component_release AFTER DELETE ON payroll_batch_component FOR EACH ROW EXECUTE FUNCTION app.attendance_allowance_component_release();
--> statement-breakpoint
-- Tenant tags never legitimise a foreign reference. Keep identity checks local to these additive
-- tables and use the caller's RLS context; no SECURITY DEFINER broadens payroll or employee reads.
CREATE FUNCTION app.attendance_allowance_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='attendance_allowance_result_revision' THEN
  IF NOT EXISTS(SELECT 1 FROM attendance_allowance_result r WHERE r.id=NEW.result_id AND r.tenant_id=NEW.tenant_id AND r.company_id=NEW.company_id AND r.employment_id=NEW.employment_id AND r.input_digest=NEW.input_digest AND r.amount=NEW.amount) THEN
   RAISE EXCEPTION 'Invalid allowance result revision identity';
  END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM attendance_allowance_policy p WHERE p.id=NEW.policy_id AND p.tenant_id=NEW.tenant_id AND p.company_id=NEW.company_id) THEN
   RAISE EXCEPTION 'Invalid allowance policy identity';
  END IF;
 END IF;
 IF TG_TABLE_NAME='attendance_allowance_result' THEN
  IF NOT EXISTS(SELECT 1 FROM employment e WHERE e.id=NEW.employment_id AND e.tenant_id=NEW.tenant_id)
    OR NOT EXISTS(SELECT 1 FROM attendance_allowance_version v WHERE v.tenant_id=NEW.tenant_id AND v.policy_id=NEW.policy_id AND v.version=NEW.policy_version) THEN
   RAISE EXCEPTION 'Invalid allowance result identity';
  END IF;
  IF TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM payroll_attendance_allowance_source s JOIN payroll_batch b ON b.id=s.batch_id WHERE s.result_id=OLD.id AND b.status='closed') THEN
   RAISE EXCEPTION 'Closed payroll allowance evidence is immutable';
  END IF;
  IF TG_OP='UPDATE' AND (NEW.tenant_id,NEW.company_id,NEW.policy_id,NEW.policy_version,NEW.employment_id,NEW.pay_month,NEW.period_key,NEW.period_from,NEW.period_to) IS DISTINCT FROM (OLD.tenant_id,OLD.company_id,OLD.policy_id,OLD.policy_version,OLD.employment_id,OLD.pay_month,OLD.period_key,OLD.period_from,OLD.period_to) THEN
   RAISE EXCEPTION 'An allowance result identity cannot change';
  END IF;
 END IF;
 IF TG_TABLE_NAME='payroll_attendance_allowance_source' THEN
  IF NOT EXISTS(SELECT 1 FROM payroll_batch b WHERE b.id=NEW.batch_id AND b.tenant_id=NEW.tenant_id AND b.company_id=NEW.company_id AND b.pay_period=NEW.pay_month AND b.status<>'closed')
   OR NOT EXISTS(SELECT 1 FROM attendance_allowance_result r JOIN attendance_allowance_policy p ON p.id=r.policy_id WHERE r.id=NEW.result_id AND r.tenant_id=NEW.tenant_id AND r.company_id=NEW.company_id AND r.policy_id=NEW.policy_id AND r.employment_id=NEW.employment_id AND r.period_key=NEW.period_key AND r.pay_month=NEW.pay_month AND r.amount=NEW.amount AND r.qualified AND p.pay_component_id=NEW.component_id AND p.version=r.policy_version)
   OR NOT EXISTS(SELECT 1 FROM pay_component c WHERE c.id=NEW.component_id AND c.tenant_id=NEW.tenant_id) THEN
   RAISE EXCEPTION 'Invalid allowance payroll source identity';
  END IF;
 END IF;
 IF TG_TABLE_NAME='attendance_allowance_transfer' THEN
  -- Keep access to batch_id inside this table branch: the other trigger records have no such field.
  IF NEW.batch_id IS NOT NULL THEN
   IF NOT EXISTS(SELECT 1 FROM payroll_batch b WHERE b.id=NEW.batch_id AND b.tenant_id=NEW.tenant_id AND b.company_id=NEW.company_id) THEN
    RAISE EXCEPTION 'Invalid allowance transfer identity';
   END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER attendance_allowance_version_identity BEFORE INSERT ON attendance_allowance_version FOR EACH ROW EXECUTE FUNCTION app.attendance_allowance_identity_guard();
--> statement-breakpoint
CREATE TRIGGER attendance_allowance_result_identity BEFORE INSERT OR UPDATE ON attendance_allowance_result FOR EACH ROW EXECUTE FUNCTION app.attendance_allowance_identity_guard();
--> statement-breakpoint
CREATE TRIGGER attendance_allowance_result_revision_identity BEFORE INSERT ON attendance_allowance_result_revision FOR EACH ROW EXECUTE FUNCTION app.attendance_allowance_identity_guard();
--> statement-breakpoint
CREATE TRIGGER payroll_attendance_allowance_source_identity BEFORE INSERT OR UPDATE ON payroll_attendance_allowance_source FOR EACH ROW EXECUTE FUNCTION app.attendance_allowance_identity_guard();
--> statement-breakpoint
CREATE TRIGGER attendance_allowance_transfer_identity BEFORE INSERT ON attendance_allowance_transfer FOR EACH ROW EXECUTE FUNCTION app.attendance_allowance_identity_guard();
--> statement-breakpoint
CREATE FUNCTION app.attendance_allowance_closed_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM payroll_batch b WHERE b.id=OLD.batch_id AND b.status='closed') THEN
  RAISE EXCEPTION 'Closed payroll allowance sources are immutable';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER attendance_allowance_closed_source_guard BEFORE UPDATE OR DELETE ON payroll_attendance_allowance_source FOR EACH ROW EXECUTE FUNCTION app.attendance_allowance_closed_source_guard();
