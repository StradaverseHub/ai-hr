-- Existing companies retain no additional uncertainty cap. Every enforced site still requires
-- containment of distance + reported accuracy within its own radius.
ALTER TABLE attendance_policy ADD COLUMN geofence_maximum_accuracy_m integer;
ALTER TABLE attendance_policy ADD CONSTRAINT attendance_policy_geofence_accuracy_positive
  CHECK (geofence_maximum_accuracy_m IS NULL OR geofence_maximum_accuracy_m > 0);
