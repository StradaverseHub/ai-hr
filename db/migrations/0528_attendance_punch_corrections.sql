-- Clock corrections retain original punch evidence and apply through the existing approval workflow.
-- Actor attribution also supports service contexts without an app-user UUID. No existing row is rewritten.
ALTER TYPE clock_method ADD VALUE IF NOT EXISTS 'admin';--> statement-breakpoint
ALTER TABLE attendance_punch ADD COLUMN voided_at timestamptz,
 ADD COLUMN voided_by text, ADD COLUMN void_reason text,
 ADD CONSTRAINT attendance_punch_void_metadata_ck CHECK (
 (voided_at IS NULL AND voided_by IS NULL AND void_reason IS NULL) OR
 (voided_at IS NOT NULL AND voided_by IS NOT NULL AND void_reason IS NOT NULL AND length(btrim(void_reason)) > 0)
 );--> statement-breakpoint
-- Separate accepted web captures can share a wall-clock second. Keep both original receipts.
-- Corrections validate the entire effective set under the same subject lock used by every writer.
CREATE UNIQUE INDEX attendance_punch_live_clock_uq ON attendance_punch(attendance_id,punch_at,direction)
 WHERE voided_at IS NULL AND clock_capture_id IS NULL;--> statement-breakpoint
ALTER TABLE attendance_correction ADD COLUMN clock_changes jsonb;--> statement-breakpoint
ALTER TABLE attendance_correction DROP CONSTRAINT attendance_correction_at_least_one;--> statement-breakpoint
ALTER TABLE attendance_correction ADD CONSTRAINT attendance_correction_at_least_one CHECK (
 proposed_check_in IS NOT NULL OR proposed_check_out IS NOT NULL OR requested_ot_minutes IS NOT NULL OR clock_changes IS NOT NULL
);
--> statement-breakpoint
-- A manager or scoped delegate can approve the existing clock-correction workflow.
-- Its synthetic punches are not employee clock receipts: admit only that authority,
-- only for another person's day, and only for the explicit admin method. Employee
-- Web Clocking still requires a valid capture reference under the original guard.
CREATE OR REPLACE FUNCTION app.attendance_capture_punch_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE cap attendance_clock_capture;
BEGIN
 IF NEW.clock_capture_id IS NOT NULL THEN
  SELECT * INTO cap FROM attendance_clock_capture WHERE id=NEW.clock_capture_id;
  IF NOT FOUND OR cap.tenant_id<>NEW.tenant_id OR cap.employment_id<>NEW.employment_id OR cap.attendance_date<>NEW.attendance_date OR cap.direction<>NEW.direction OR NEW.method<>'web' THEN
   RAISE EXCEPTION 'Invalid attendance capture reference';
  END IF;
 ELSIF current_user='ai_hr_app' AND NOT EXISTS(SELECT 1 FROM employment e WHERE e.id=NEW.employment_id AND app.is_admin_for(e.company_id)) THEN
  IF NOT (
   (NEW.method::text='admin' AND EXISTS (
    SELECT 1 FROM employment subject
    JOIN app_user caller ON caller.id=app.current_user_id() AND caller.tenant_id=subject.tenant_id
    WHERE subject.id=NEW.employment_id AND subject.tenant_id=NEW.tenant_id
      AND caller.person_id IS NOT NULL AND caller.person_id<>subject.person_id
      AND (
       EXISTS (
        SELECT 1 FROM reporting_line line JOIN employment manager ON manager.id=line.manager_employment_id
        WHERE line.subordinate_employment_id=subject.id AND manager.person_id=caller.person_id
          AND line.line_type='administrative' AND line.superseded_at IS NULL
          AND line.valid_from<=current_date AND (line.valid_to IS NULL OR line.valid_to>current_date)
       ) OR app.can_decide_via_delegation(subject.id,'attendance','attendance.correction')
      )
   ))
   OR
   -- Unchanged legacy anchor exception from 0500: an accepted OUT supplies the receipt.
   (NEW.direction='in' AND EXISTS(SELECT 1 FROM attendance a WHERE a.id=NEW.attendance_id AND a.check_in_at=NEW.punch_at AND NOT EXISTS(SELECT 1 FROM attendance_punch p WHERE p.attendance_id=a.id)) AND EXISTS(SELECT 1 FROM attendance_clock_capture c WHERE c.employment_id=NEW.employment_id AND c.attendance_date=NEW.attendance_date AND c.direction='out' AND c.server_recorded_at>=statement_timestamp()-interval '5 seconds'))
  ) THEN
   RAISE EXCEPTION 'Employee clocking requires a photo capture';
  END IF;
 END IF;
 RETURN NEW;
END $$;
