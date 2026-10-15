-- ADR-0120: explicit policy, employee-specific allocation, immutable provenance and automatic work queue.
CREATE TABLE replacement_holiday_policy (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),company_id uuid NOT NULL REFERENCES company(id),
 effective_from date NOT NULL,regime text NOT NULL CHECK(regime IN ('MY_EA_60D','MY_SABAH_103','company_confirmed')),
 confirmed boolean NOT NULL DEFAULT false,rest_mode text NOT NULL CHECK(rest_mode IN ('scheduled_rest','last_weekly_rest')),
 half_eligible boolean NOT NULL DEFAULT false,search_days integer NOT NULL CHECK(search_days BETWEEN 1 AND 366),
 reason text NOT NULL CHECK(length(trim(reason))>0),created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,company_id,effective_from)
);--> statement-breakpoint
CREATE TABLE replacement_holiday (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),employment_id uuid NOT NULL REFERENCES employment(id),company_id uuid NOT NULL REFERENCES company(id),
 source_holiday_id uuid NOT NULL REFERENCES holiday(id),source_date date NOT NULL,source_name text NOT NULL,
 policy_id uuid REFERENCES replacement_holiday_policy(id),input_digest text NOT NULL,status text NOT NULL CHECK(status IN ('allocated','review','not_required')),
 replacement_date date,proposed_date date,reason text NOT NULL,manual boolean NOT NULL DEFAULT false,manual_reason text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,employment_id,source_holiday_id),
 CHECK(replacement_date IS NULL OR replacement_date>source_date),CHECK(NOT manual OR (manual_reason IS NOT NULL AND length(trim(manual_reason))>0)),CHECK(status<>'allocated' OR replacement_date IS NOT NULL),CHECK(status<>'not_required' OR replacement_date IS NULL)
);--> statement-breakpoint
CREATE UNIQUE INDEX replacement_holiday_employee_date_uq ON replacement_holiday(tenant_id,employment_id,replacement_date) WHERE replacement_date IS NOT NULL;--> statement-breakpoint
CREATE TABLE replacement_holiday_revision (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),allocation_id uuid NOT NULL REFERENCES replacement_holiday(id),employment_id uuid NOT NULL REFERENCES employment(id),company_id uuid NOT NULL REFERENCES company(id),
 snapshot jsonb NOT NULL,created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE TABLE replacement_holiday_queue (
 tenant_id uuid NOT NULL REFERENCES tenant(id),employment_id uuid NOT NULL REFERENCES employment(id) ON DELETE CASCADE,generation bigint NOT NULL DEFAULT 1,
 requested_at timestamptz NOT NULL DEFAULT now(),claimed_at timestamptz,claimed_generation bigint,last_error text,calendar_conflicts jsonb NOT NULL DEFAULT '[]'::jsonb,PRIMARY KEY(tenant_id,employment_id)
);--> statement-breakpoint
ALTER TABLE replacement_holiday_policy ENABLE ROW LEVEL SECURITY;ALTER TABLE replacement_holiday_policy FORCE ROW LEVEL SECURITY;
ALTER TABLE replacement_holiday ENABLE ROW LEVEL SECURITY;ALTER TABLE replacement_holiday FORCE ROW LEVEL SECURITY;
ALTER TABLE replacement_holiday_revision ENABLE ROW LEVEL SECURITY;ALTER TABLE replacement_holiday_revision FORCE ROW LEVEL SECURITY;
ALTER TABLE replacement_holiday_queue ENABLE ROW LEVEL SECURITY;ALTER TABLE replacement_holiday_queue FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY replacement_holiday_policy_read ON replacement_holiday_policy FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.is_admin_for(company_id));
CREATE POLICY replacement_holiday_policy_insert ON replacement_holiday_policy FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.is_admin_for(company_id));
CREATE POLICY replacement_holiday_read ON replacement_holiday FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.can_see_employment(employment_id));
CREATE POLICY replacement_holiday_write ON replacement_holiday FOR ALL USING(tenant_id=app.current_tenant_id() AND app.can_admin_employment(employment_id) AND app.is_admin_for(company_id)) WITH CHECK(tenant_id=app.current_tenant_id() AND app.can_admin_employment(employment_id) AND app.is_admin_for(company_id));
CREATE POLICY replacement_holiday_revision_read ON replacement_holiday_revision FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.can_see_employment(employment_id));
CREATE POLICY replacement_holiday_revision_insert ON replacement_holiday_revision FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.can_admin_employment(employment_id) AND app.is_admin_for(company_id));
CREATE POLICY replacement_holiday_queue_admin ON replacement_holiday_queue FOR ALL USING(tenant_id=app.current_tenant_id() AND app.can_admin_employment(employment_id)) WITH CHECK(tenant_id=app.current_tenant_id() AND app.can_admin_employment(employment_id));
-- The trusted trigger definer may enqueue other employees in the changed tenant; app clients cannot.
CREATE POLICY replacement_holiday_queue_definer ON replacement_holiday_queue FOR ALL USING(current_user<>'ai_hr_app') WITH CHECK(current_user<>'ai_hr_app' AND EXISTS(SELECT 1 FROM employment e WHERE e.id=employment_id AND e.tenant_id=replacement_holiday_queue.tenant_id));
--> statement-breakpoint
GRANT SELECT,INSERT ON replacement_holiday_policy,replacement_holiday_revision TO ai_hr_app;
GRANT SELECT,INSERT,UPDATE ON replacement_holiday TO ai_hr_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON replacement_holiday_queue TO ai_hr_app;--> statement-breakpoint
CREATE FUNCTION app.validate_replacement_holiday() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_TABLE_NAME IN ('replacement_holiday_policy','replacement_holiday_revision') AND TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Replacement holiday history is immutable';END IF;
 IF TG_TABLE_NAME='replacement_holiday_policy' THEN
  IF NEW.effective_from<(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date THEN RAISE EXCEPTION 'New policy versions cannot change a past effective date';END IF;
  IF NOT EXISTS(SELECT 1 FROM company WHERE id=NEW.company_id AND tenant_id=NEW.tenant_id) THEN RAISE EXCEPTION 'Company is unavailable in this tenant';END IF;
 ELSIF TG_TABLE_NAME='replacement_holiday_revision' THEN
  IF NOT EXISTS(SELECT 1 FROM replacement_holiday WHERE id=NEW.allocation_id AND tenant_id=NEW.tenant_id AND employment_id=NEW.employment_id AND company_id=NEW.company_id) THEN RAISE EXCEPTION 'Allocation provenance is unavailable';END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM employment WHERE id=NEW.employment_id AND tenant_id=NEW.tenant_id) OR NOT EXISTS(SELECT 1 FROM company WHERE id=NEW.company_id AND tenant_id=NEW.tenant_id) THEN RAISE EXCEPTION 'Employee or company is unavailable in this tenant';END IF;
  IF TG_OP='INSERT' AND NOT EXISTS(SELECT 1 FROM employment WHERE id=NEW.employment_id AND company_id=NEW.company_id) THEN RAISE EXCEPTION 'Allocation company does not match employment';END IF;
  IF NOT EXISTS(SELECT 1 FROM holiday WHERE id=NEW.source_holiday_id AND tenant_id=NEW.tenant_id) THEN RAISE EXCEPTION 'Original holiday is unavailable in this tenant';END IF;
  IF NEW.status='allocated' AND NOT EXISTS(SELECT 1 FROM replacement_holiday_policy WHERE id=NEW.policy_id AND confirmed) THEN RAISE EXCEPTION 'An assigned replacement requires a confirmed policy';END IF;
  IF NEW.policy_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM replacement_holiday_policy WHERE id=NEW.policy_id AND tenant_id=NEW.tenant_id AND company_id=NEW.company_id AND (effective_from<=NEW.source_date OR NEW.manual)) THEN RAISE EXCEPTION 'Replacement policy does not apply to this company and source date';END IF;
 END IF;
 RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER replacement_holiday_policy_validate BEFORE INSERT OR UPDATE OR DELETE ON replacement_holiday_policy FOR EACH ROW EXECUTE FUNCTION app.validate_replacement_holiday();
CREATE TRIGGER replacement_holiday_validate BEFORE INSERT OR UPDATE ON replacement_holiday FOR EACH ROW EXECUTE FUNCTION app.validate_replacement_holiday();
CREATE TRIGGER replacement_holiday_revision_validate BEFORE INSERT OR UPDATE OR DELETE ON replacement_holiday_revision FOR EACH ROW EXECUTE FUNCTION app.validate_replacement_holiday();--> statement-breakpoint
-- Queue changes transactionally. The worker claims briefly, then locks the employee before reconciling;
-- it removes only its claimed generation so a concurrent input change is never lost.
CREATE FUNCTION app.enqueue_replacement_holidays() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE payload jsonb;tid uuid;eid uuid;
BEGIN
 payload:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 tid:=(payload->>'tenant_id')::uuid;
 IF TG_TABLE_NAME='employment' THEN eid:=(payload->>'id')::uuid;
 ELSIF payload ? 'employment_id' THEN eid:=(payload->>'employment_id')::uuid;
 END IF;
 INSERT INTO replacement_holiday_queue(tenant_id,employment_id)
 SELECT e.tenant_id,e.id FROM employment e WHERE e.tenant_id=tid AND (eid IS NULL OR e.id=eid)
 ON CONFLICT(tenant_id,employment_id) DO UPDATE SET generation=replacement_holiday_queue.generation+1,requested_at=now(),claimed_at=NULL,claimed_generation=NULL;
 RETURN NULL;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app.enqueue_replacement_holidays() FROM PUBLIC;--> statement-breakpoint
DO $$ DECLARE tab text;BEGIN
 FOREACH tab IN ARRAY ARRAY['employment','employment_shift_arrangement','roster_assignment','shift','attendance_rule','attendance_rule_shift','attendance_rotation','attendance_policy','attendance_day_adjustment','holiday','holiday_group','holiday_group_holiday','replacement_holiday_policy','company'] LOOP
  EXECUTE format('CREATE TRIGGER replacement_holiday_dirty AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app.enqueue_replacement_holidays()',tab);
 END LOOP;
END $$;--> statement-breakpoint
INSERT INTO replacement_holiday_queue(tenant_id,employment_id) SELECT tenant_id,id FROM employment;
