-- Approved r378: forward-only correction history and private portal clock evidence. No backfill.
ALTER TABLE attendance_correction ADD COLUMN reject_reason text, ADD COLUMN original_clock_snapshot jsonb;
--> statement-breakpoint
CREATE TABLE attendance_clock_capture (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id), employment_id uuid NOT NULL REFERENCES employment(id),
 attendance_date date NOT NULL, direction attendance_punch_direction NOT NULL, request_id uuid NOT NULL,
 server_recorded_at timestamptz NOT NULL, photo_captured_at timestamptz NOT NULL,
 photo_mime_type text NOT NULL CHECK(photo_mime_type='image/jpeg'), photo_size integer NOT NULL CHECK(photo_size BETWEEN 1 AND 2097152),
 photo_bytes bytea, thumbnail_bytes bytea, decoded_width integer NOT NULL CHECK(decoded_width BETWEEN 1 AND 640), decoded_height integer NOT NULL CHECK(decoded_height BETWEEN 1 AND 640),
 device_id uuid NOT NULL REFERENCES employee_device(id), lat double precision NOT NULL CHECK(lat BETWEEN -90 AND 90), lng double precision NOT NULL CHECK(lng BETWEEN -180 AND 180), accuracy_m double precision NOT NULL CHECK(accuracy_m >= 0 AND accuracy_m < 'Infinity'::float8),
 clocking_location_id uuid NOT NULL REFERENCES clocking_location(id), distance_m integer NOT NULL CHECK(distance_m >= 0), radius_m integer NOT NULL CHECK(radius_m > 0 AND distance_m <= radius_m),
 command_digest text NOT NULL CHECK(command_digest ~ '^[a-f0-9]{64}$'), photo_digest text NOT NULL CHECK(photo_digest ~ '^[a-f0-9]{64}$'),
 photo_purged_at timestamptz, photo_purge_event_id uuid REFERENCES domain_event(id),
 CONSTRAINT attendance_clock_capture_payload CHECK (
   (photo_purged_at IS NULL AND photo_purge_event_id IS NULL AND photo_bytes IS NOT NULL AND thumbnail_bytes IS NOT NULL AND octet_length(photo_bytes)=photo_size AND octet_length(thumbnail_bytes) BETWEEN 1 AND 2097152)
   OR (photo_purged_at IS NOT NULL AND photo_purge_event_id IS NOT NULL AND photo_bytes IS NULL AND thumbnail_bytes IS NULL)
 ),
 CONSTRAINT attendance_clock_capture_request_uq UNIQUE(tenant_id,employment_id,request_id)
);
--> statement-breakpoint
CREATE INDEX attendance_clock_capture_day_idx ON attendance_clock_capture(employment_id,attendance_date,server_recorded_at);
--> statement-breakpoint
ALTER TABLE attendance_punch ADD COLUMN clock_capture_id uuid UNIQUE REFERENCES attendance_clock_capture(id);
--> statement-breakpoint
ALTER TABLE attendance_clock_capture ENABLE ROW LEVEL SECURITY;
CREATE POLICY attendance_clock_capture_read ON attendance_clock_capture FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.can_see_employment(employment_id));
CREATE POLICY attendance_clock_capture_insert ON attendance_clock_capture FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM employment e WHERE e.id=attendance_clock_capture.employment_id AND e.tenant_id=attendance_clock_capture.tenant_id AND app.is_self_person(e.person_id)));
REVOKE ALL ON attendance_clock_capture FROM ai_hr_app;
GRANT SELECT, INSERT ON attendance_clock_capture TO ai_hr_app;
--> statement-breakpoint
-- Only this scoped, audited operation has UPDATE authority. All receipt metadata is immutable.
CREATE FUNCTION app.purge_attendance_clock_photo(capture_id uuid, purge_event_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE subject attendance_clock_capture; BEGIN
 SELECT * INTO subject FROM attendance_clock_capture WHERE id=capture_id AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM employment e WHERE e.id=subject.employment_id AND e.tenant_id=subject.tenant_id AND app.is_admin_for(e.company_id)) THEN RAISE EXCEPTION 'Photo purge is not authorised'; END IF;
 IF subject.photo_purged_at IS NOT NULL THEN RETURN; END IF;
 IF NOT EXISTS(SELECT 1 FROM domain_event e WHERE e.id=purge_event_id AND e.tenant_id=subject.tenant_id AND e.aggregate_id=capture_id AND e.event_type='attendance.clock.photo-purged') THEN RAISE EXCEPTION 'Photo purge audit event required'; END IF;
 UPDATE attendance_clock_capture SET photo_bytes=NULL,thumbnail_bytes=NULL,photo_purged_at=now(),photo_purge_event_id=purge_event_id WHERE id=capture_id;
END $$;
REVOKE ALL ON FUNCTION app.purge_attendance_clock_photo(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.purge_attendance_clock_photo(uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.attendance_capture_punch_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cap attendance_clock_capture; BEGIN
 IF NEW.clock_capture_id IS NOT NULL THEN
  SELECT * INTO cap FROM attendance_clock_capture WHERE id=NEW.clock_capture_id;
  IF NOT FOUND OR cap.tenant_id<>NEW.tenant_id OR cap.employment_id<>NEW.employment_id OR cap.attendance_date<>NEW.attendance_date OR cap.direction<>NEW.direction OR NEW.method<>'web' THEN RAISE EXCEPTION 'Invalid attendance capture reference'; END IF;
 ELSIF current_user='ai_hr_app' AND NOT EXISTS(SELECT 1 FROM employment e WHERE e.id=NEW.employment_id AND app.is_admin_for(e.company_id)) THEN
  -- Existing check-out synthesises a legacy first-IN for the authoritative aggregate. This is not a new clock receipt.
  IF NOT (NEW.direction='in' AND EXISTS(SELECT 1 FROM attendance a WHERE a.id=NEW.attendance_id AND a.check_in_at=NEW.punch_at AND NOT EXISTS(SELECT 1 FROM attendance_punch p WHERE p.attendance_id=a.id)) AND EXISTS(SELECT 1 FROM attendance_clock_capture c WHERE c.employment_id=NEW.employment_id AND c.attendance_date=NEW.attendance_date AND c.direction='out' AND c.server_recorded_at>=statement_timestamp()-interval '5 seconds')) THEN
   RAISE EXCEPTION 'Employee clocking requires a photo capture';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER attendance_capture_punch_guard BEFORE INSERT ON attendance_punch FOR EACH ROW EXECUTE FUNCTION app.attendance_capture_punch_guard();

--> statement-breakpoint
-- A forward fact is frozen at submission, even when NULL on a legacy or OT-only row.
CREATE FUNCTION app.attendance_original_snapshot_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ BEGIN
 IF OLD.original_clock_snapshot IS DISTINCT FROM NEW.original_clock_snapshot THEN
  RAISE EXCEPTION 'Original clock snapshot is immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER attendance_original_snapshot_immutable BEFORE UPDATE ON attendance_correction FOR EACH ROW EXECUTE FUNCTION app.attendance_original_snapshot_immutable();
