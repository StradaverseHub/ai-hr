-- Item ef720d3a — Bank Information custom payment holder on employee_statutory_my (additive, backward-compatible).
-- Supports paying an employee's salary into a third party's account (spouse / authorised person) when a banking
-- restriction applies. enable_custom_holder_name / enable_custom_holder_id are the two opt-in switches; the
-- custom_* text columns carry the alternative account-holder name / identification. Defaults preserve every
-- existing row: both flags OFF ⇒ payment resolves to the employee (current behaviour). This changes only the
-- PAYEE identity for disbursement — never any pay figure, tax, or statutory calculation.
ALTER TABLE "employee_statutory_my" ADD COLUMN IF NOT EXISTS "enable_custom_holder_name" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "employee_statutory_my" ADD COLUMN IF NOT EXISTS "custom_holder_name" text;
--> statement-breakpoint
ALTER TABLE "employee_statutory_my" ADD COLUMN IF NOT EXISTS "enable_custom_holder_id" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "employee_statutory_my" ADD COLUMN IF NOT EXISTS "custom_holder_id" text;
