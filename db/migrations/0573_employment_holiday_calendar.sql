-- Dated calendar choices supersede no legacy fallback and backfill no assumed history.
-- 0569-0572 must be released first, or in the same ordered migration batch.
CREATE TABLE employment_holiday_calendar (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenant(id),
 employment_id uuid NOT NULL REFERENCES employment(id),
 valid_from date NOT NULL,
 valid_to date,
 kind text NOT NULL CHECK (kind IN ('none','state','group')),
 work_state text,
 holiday_group_id uuid REFERENCES holiday_group(id),
 replaces_id uuid UNIQUE REFERENCES employment_holiday_calendar(id),
 recorded_by uuid NOT NULL REFERENCES app_user(id),
 recorded_at timestamptz NOT NULL DEFAULT now(),
 superseded_at timestamptz,
 CHECK (valid_to IS NULL OR valid_to > valid_from),
 CHECK ((kind='none' AND work_state IS NULL AND holiday_group_id IS NULL)
  OR (kind='state' AND work_state IS NOT NULL AND length(btrim(work_state))>0 AND holiday_group_id IS NULL)
  OR (kind='group' AND work_state IS NULL AND holiday_group_id IS NOT NULL)),
 EXCLUDE USING gist (employment_id WITH =, daterange(valid_from,valid_to,'[)') WITH &&) WHERE (superseded_at IS NULL)
);
CREATE INDEX employment_holiday_calendar_dates ON employment_holiday_calendar(tenant_id,employment_id,valid_from) WHERE superseded_at IS NULL;
ALTER TABLE employment_holiday_calendar ENABLE ROW LEVEL SECURITY;
CREATE POLICY employment_holiday_calendar_read ON employment_holiday_calendar FOR SELECT USING (
 tenant_id=app.current_tenant_id() AND app.can_see_employment(employment_id)
);
CREATE POLICY employment_holiday_calendar_insert ON employment_holiday_calendar FOR INSERT WITH CHECK (
 tenant_id=app.current_tenant_id() AND app.can_admin_employment(employment_id) AND recorded_by=app.current_user_id()
);
CREATE POLICY employment_holiday_calendar_update ON employment_holiday_calendar FOR UPDATE USING (
 tenant_id=app.current_tenant_id() AND app.can_admin_employment(employment_id)
) WITH CHECK (tenant_id=app.current_tenant_id() AND app.can_admin_employment(employment_id));
GRANT SELECT,INSERT,UPDATE ON employment_holiday_calendar TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.guard_employment_holiday_calendar() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF OLD.superseded_at IS NOT NULL OR NEW.superseded_at IS NULL
    OR (to_jsonb(OLD)-'superseded_at') IS DISTINCT FROM (to_jsonb(NEW)-'superseded_at') THEN
   RAISE EXCEPTION 'Calendar history is immutable; replace the active assignment';
  END IF;
 ELSE
  IF NEW.superseded_at IS NOT NULL THEN RAISE EXCEPTION 'A new calendar assignment must be active'; END IF;
  IF NOT EXISTS(SELECT 1 FROM employment e WHERE e.id=NEW.employment_id AND e.tenant_id=NEW.tenant_id)
    OR NOT EXISTS(SELECT 1 FROM app_user u WHERE u.id=NEW.recorded_by AND u.tenant_id=NEW.tenant_id)
    OR NEW.holiday_group_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM holiday_group g WHERE g.id=NEW.holiday_group_id AND g.tenant_id=NEW.tenant_id)
    OR NEW.replaces_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM employment_holiday_calendar p WHERE p.id=NEW.replaces_id AND p.tenant_id=NEW.tenant_id AND p.employment_id=NEW.employment_id AND p.superseded_at IS NOT NULL) THEN
   RAISE EXCEPTION 'Calendar assignment references must belong to the same tenant and employee';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER employment_holiday_calendar_guard BEFORE INSERT OR UPDATE ON employment_holiday_calendar FOR EACH ROW EXECUTE FUNCTION app.guard_employment_holiday_calendar();
REVOKE ALL ON FUNCTION app.guard_employment_holiday_calendar() FROM PUBLIC;
