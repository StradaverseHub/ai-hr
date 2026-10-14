-- Unavailable WEB location is represented by NULLs, never invented zero coordinates.
-- Native sampled-location validation remains in its existing service/API contract.
ALTER TABLE attendance_clock_capture ALTER COLUMN lat DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE attendance_clock_capture ALTER COLUMN lng DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE attendance_clock_capture ALTER COLUMN accuracy_m DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE attendance_clock_capture ADD CONSTRAINT attendance_clock_capture_location_together
  CHECK (num_nonnulls(lat, lng, accuracy_m) IN (0, 3)
    AND (lat IS NOT NULL OR (clocking_location_id IS NULL AND device_id IS NULL)));
