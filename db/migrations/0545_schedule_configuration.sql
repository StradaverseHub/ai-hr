-- Approved25468aa3 / ba0dfca1: shift display/duration and Schedule Group ownership.
ALTER TABLE shift DROP CONSTRAINT shift_color_token_ck;--> statement-breakpoint
ALTER TABLE shift ADD CONSTRAINT shift_color_token_ck CHECK(color IS NULL OR color IN ('indigo','green','orange','blue','red','purple','teal','grey') OR color ~ '^#[0-9A-F]{6}$');--> statement-breakpoint
ALTER TABLE attendance_rule ADD COLUMN label text;--> statement-breakpoint
ALTER TABLE attendance_rule ADD COLUMN duty_roster_control boolean NOT NULL DEFAULT false;--> statement-breakpoint
-- Existing manual roster permission is preserved explicitly; new groups remain Off.
UPDATE attendance_rule SET duty_roster_control=true;--> statement-breakpoint
CREATE TABLE attendance_rule_shift (
 tenant_id uuid NOT NULL REFERENCES tenant(id), rule_id uuid NOT NULL REFERENCES attendance_rule(id) ON DELETE CASCADE,
 shift_id uuid NOT NULL REFERENCES shift(id) ON DELETE RESTRICT, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(rule_id,shift_id)
);--> statement-breakpoint
INSERT INTO attendance_rule_shift(tenant_id,rule_id,shift_id) SELECT tenant_id,rule_id,id FROM shift WHERE rule_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE attendance_rule_shift ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE attendance_rule_shift FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY attendance_rule_shift_read ON attendance_rule_shift FOR SELECT USING(tenant_id=app.current_tenant_id());--> statement-breakpoint
CREATE POLICY attendance_rule_shift_write ON attendance_rule_shift FOR ALL USING(tenant_id=app.current_tenant_id() AND app.is_admin()) WITH CHECK(tenant_id=app.current_tenant_id() AND app.is_admin());--> statement-breakpoint
GRANT SELECT,INSERT,DELETE ON attendance_rule_shift TO ai_hr_app;--> statement-breakpoint
CREATE TABLE attendance_exception_revision (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id),
 rule_id uuid NOT NULL REFERENCES attendance_rule(id) ON DELETE RESTRICT, effective_from date NOT NULL,
 enabled boolean NOT NULL, created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(rule_id,effective_from)
);--> statement-breakpoint
ALTER TABLE attendance_exception_revision ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE attendance_exception_revision FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY attendance_exception_revision_read ON attendance_exception_revision FOR SELECT USING(tenant_id=app.current_tenant_id());--> statement-breakpoint
CREATE POLICY attendance_exception_revision_insert ON attendance_exception_revision FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.is_admin());--> statement-breakpoint
GRANT SELECT,INSERT ON attendance_exception_revision TO ai_hr_app;--> statement-breakpoint
CREATE FUNCTION app.validate_board_schedule_reference() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_TABLE_NAME='attendance_exception_revision' THEN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Exception revisions are immutable'; END IF;
  IF NEW.effective_from <= (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date THEN RAISE EXCEPTION 'Exception changes take effect tomorrow or later'; END IF;
 END IF;
 PERFORM 1 FROM attendance_rule WHERE id=NEW.rule_id AND tenant_id=NEW.tenant_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Unknown Schedule Group in this tenant'; END IF;
 IF TG_TABLE_NAME='attendance_rule_shift' THEN
  PERFORM 1 FROM shift WHERE id=NEW.shift_id AND tenant_id=NEW.tenant_id AND archived_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown or archived shift'; END IF;
 END IF;
 RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER attendance_rule_shift_reference BEFORE INSERT OR UPDATE ON attendance_rule_shift FOR EACH ROW EXECUTE FUNCTION app.validate_board_schedule_reference();--> statement-breakpoint
CREATE TRIGGER attendance_exception_revision_reference BEFORE INSERT OR UPDATE OR DELETE ON attendance_exception_revision FOR EACH ROW EXECUTE FUNCTION app.validate_board_schedule_reference();

--> statement-breakpoint
ALTER TABLE shift ALTER COLUMN start_time DROP NOT NULL;--> statement-breakpoint
ALTER TABLE shift ALTER COLUMN end_time DROP NOT NULL;--> statement-breakpoint
ALTER TABLE shift ADD CONSTRAINT shift_fixed_anchors_required CHECK(type='full_flexi' OR (start_time IS NOT NULL AND end_time IS NOT NULL));--> statement-breakpoint
ALTER TABLE shift ADD CONSTRAINT shift_full_flexi_duration_required CHECK(type<>'full_flexi' OR (normal_minutes_override IS NOT NULL AND normal_minutes_override BETWEEN 1 AND 1440));
