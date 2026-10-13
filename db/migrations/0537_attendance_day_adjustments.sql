-- A correction belongs to one employment/date. Original schedules and application proposals stay intact.
CREATE TABLE attendance_day_adjustment (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id),
 employment_id uuid NOT NULL REFERENCES employment(id), attendance_date date NOT NULL,
 shift_id uuid REFERENCES shift(id), day_kind text CHECK(day_kind IN ('workday','off_day','rest_day','holiday')),
 manual_ot_rows jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(manual_ot_rows)='object'),
 version integer NOT NULL DEFAULT 1 CHECK(version>0), reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 500),
 updated_by text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT attendance_day_adjustment_day_uq UNIQUE(tenant_id,employment_id,attendance_date)
);--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON attendance_day_adjustment TO ai_hr_app;--> statement-breakpoint
ALTER TABLE attendance_day_adjustment ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON attendance_day_adjustment USING (
 tenant_id=app.current_tenant_id() AND employment_id=ANY((SELECT app.visible_employment_ids())::uuid[])
) WITH CHECK (
 tenant_id=app.current_tenant_id() AND app.can_admin_employment(employment_id)
 AND NOT EXISTS(SELECT 1 FROM employment e JOIN app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id
   WHERE e.id=employment_id AND u.id=app.current_user_id())
);--> statement-breakpoint
CREATE FUNCTION app.attendance_day_adjustment_links() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='UPDATE' AND (NEW.id,NEW.tenant_id,NEW.employment_id,NEW.attendance_date) IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.employment_id,OLD.attendance_date) THEN RAISE EXCEPTION 'Attendance date correction identity is immutable'; END IF;
 IF NOT EXISTS(SELECT 1 FROM employment e WHERE e.id=NEW.employment_id AND e.tenant_id=NEW.tenant_id)
 OR (NEW.shift_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM shift s WHERE s.id=NEW.shift_id AND s.tenant_id=NEW.tenant_id))
 THEN RAISE EXCEPTION 'Invalid attendance date correction reference'; END IF;
 RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER attendance_day_adjustment_links BEFORE INSERT OR UPDATE ON attendance_day_adjustment
 FOR EACH ROW EXECUTE FUNCTION app.attendance_day_adjustment_links();--> statement-breakpoint
ALTER TABLE attendance_correction ADD COLUMN admin_amendment jsonb;--> statement-breakpoint
CREATE FUNCTION app.attendance_admin_amendment_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.admin_amendment IS DISTINCT FROM OLD.admin_amendment THEN
  IF NOT app.can_admin_employment(OLD.employment_id) OR OLD.status<>'pending' OR NEW.status<>'pending'
    OR NEW.admin_amendment IS NULL OR jsonb_typeof(NEW.admin_amendment)<>'object'
    OR NEW.admin_amendment->>'actorId' IS DISTINCT FROM app.current_user_id()::text
    OR coalesce(length(btrim(NEW.admin_amendment->>'reason')),0) NOT BETWEEN 1 AND 500
    OR EXISTS(SELECT 1 FROM attendance_workflow_request w WHERE w.correction_id=OLD.id AND w.current_stage>0)
    OR EXISTS(SELECT 1 FROM employment e JOIN app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id
      WHERE e.id=OLD.employment_id AND u.id=app.current_user_id())
    OR (to_jsonb(OLD)-'admin_amendment') IS DISTINCT FROM (to_jsonb(NEW)-'admin_amendment')
  THEN RAISE EXCEPTION 'An attendance amendment requires an authorised administrator before any approval stage'; END IF;
 END IF;
 RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER attendance_admin_amendment_guard BEFORE UPDATE ON attendance_correction
 FOR EACH ROW EXECUTE FUNCTION app.attendance_admin_amendment_guard();
