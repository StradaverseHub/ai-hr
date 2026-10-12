-- Additive opt-in. No historical attendance or group is rewritten.
CREATE TABLE attendance_rotation (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id),
 rule_id uuid NOT NULL REFERENCES attendance_rule(id) ON DELETE RESTRICT,
 effective_from date NOT NULL, anchor_date date NOT NULL,
 unit text NOT NULL CHECK(unit IN ('week','day')), length integer NOT NULL CHECK(length>0),
 allowed_shift_ids uuid[] NOT NULL, days jsonb NOT NULL,
 created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT attendance_rotation_rule_date_uq UNIQUE(rule_id,effective_from),
 CHECK (length*(CASE unit WHEN 'week' THEN 7 ELSE 1 END) BETWEEN 1 AND 366),
 CHECK (jsonb_typeof(days)='array' AND jsonb_array_length(days)=length*(CASE unit WHEN 'week' THEN 7 ELSE 1 END)),
 CHECK (unit<>'week' OR extract(isodow FROM anchor_date)=1)
);--> statement-breakpoint
CREATE INDEX attendance_rotation_tenant_rule_idx ON attendance_rotation(tenant_id,rule_id);--> statement-breakpoint
ALTER TABLE attendance_rotation ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE attendance_rotation FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY attendance_rotation_read ON attendance_rotation FOR SELECT USING(tenant_id=app.current_tenant_id());--> statement-breakpoint
CREATE POLICY attendance_rotation_insert ON attendance_rotation FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.is_group_admin());--> statement-breakpoint
GRANT SELECT,INSERT ON attendance_rotation TO ai_hr_app;--> statement-breakpoint
-- Validate cross-tenant references and the JSON shape at the database boundary, too.
CREATE FUNCTION app.validate_attendance_rotation() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE item jsonb; sid uuid; working boolean := false;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Schedule rotation versions are immutable'; END IF;
 IF NEW.effective_from <= (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date THEN RAISE EXCEPTION 'Rotation must take effect tomorrow or later'; END IF;
 PERFORM 1 FROM attendance_rule WHERE id=NEW.rule_id AND tenant_id=NEW.tenant_id AND NOT is_default FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Choose a non-Standard Schedule Group in this tenant'; END IF;
 FOREACH sid IN ARRAY NEW.allowed_shift_ids LOOP
  PERFORM 1 FROM shift WHERE id=sid AND tenant_id=NEW.tenant_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown shift in rotation pool'; END IF;
 END LOOP;
 FOR item IN SELECT value FROM jsonb_array_elements(NEW.days) LOOP
  IF jsonb_typeof(item)<>'object' OR coalesce(item->>'kind','') NOT IN ('full','half','off','rest') THEN RAISE EXCEPTION 'Invalid rotation day'; END IF;
  IF item->>'kind' IN ('full','half') THEN
   working := true;
   sid := (item->>'shiftId')::uuid;
   IF sid IS NULL OR NOT(sid=ANY(NEW.allowed_shift_ids)) THEN RAISE EXCEPTION 'Working rotation day must use an allowed shift'; END IF;
  ELSIF item->>'shiftId' IS NOT NULL THEN RAISE EXCEPTION 'Nonworking rotation day cannot assign a shift'; END IF;
 END LOOP;
 IF NOT working THEN RAISE EXCEPTION 'Rotation requires a working day'; END IF;
 RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER attendance_rotation_validate BEFORE INSERT OR UPDATE OR DELETE ON attendance_rotation FOR EACH ROW EXECUTE FUNCTION app.validate_attendance_rotation();--> statement-breakpoint
-- A JSON reference must still retain its immutable source shift, just like a roster FK.
CREATE FUNCTION app.retain_rotation_shift() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM attendance_rotation WHERE tenant_id=OLD.tenant_id AND OLD.id=ANY(allowed_shift_ids)) THEN
  RAISE EXCEPTION 'Shift is retained by a schedule rotation; archive it instead';
 END IF;
 RETURN OLD;
END $$;--> statement-breakpoint
CREATE TRIGGER shift_rotation_retained BEFORE DELETE ON shift FOR EACH ROW EXECUTE FUNCTION app.retain_rotation_shift();
