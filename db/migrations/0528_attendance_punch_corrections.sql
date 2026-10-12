-- Clock corrections retain original punch evidence and apply through the existing approval workflow.
-- Actor ids are text: authenticated user ids are not restricted to UUIDs. No existing row is rewritten.
ALTER TYPE clock_method ADD VALUE IF NOT EXISTS 'admin';--> statement-breakpoint
ALTER TABLE attendance_punch ADD COLUMN voided_at timestamptz,
 ADD COLUMN voided_by text, ADD COLUMN void_reason text,
 ADD CONSTRAINT attendance_punch_void_metadata_ck CHECK (
 (voided_at IS NULL AND voided_by IS NULL AND void_reason IS NULL) OR
 (voided_at IS NOT NULL AND voided_by IS NOT NULL AND void_reason IS NOT NULL AND length(btrim(void_reason)) > 0)
 );--> statement-breakpoint
CREATE UNIQUE INDEX attendance_punch_live_clock_uq ON attendance_punch(attendance_id,punch_at,direction)
 WHERE voided_at IS NULL;--> statement-breakpoint
ALTER TABLE attendance_correction ADD COLUMN clock_changes jsonb;--> statement-breakpoint
ALTER TABLE attendance_correction DROP CONSTRAINT attendance_correction_at_least_one;--> statement-breakpoint
ALTER TABLE attendance_correction ADD CONSTRAINT attendance_correction_at_least_one CHECK (
 proposed_check_in IS NOT NULL OR proposed_check_out IS NOT NULL OR requested_ot_minutes IS NOT NULL OR clock_changes IS NOT NULL
);
