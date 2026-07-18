-- R45 98ec0d21: rename "Planned Absences" dashboard card to "Leave Calendar" (display only).
-- Idempotent data migration so existing tenants pick up the new stored name.
-- The stable cardKey 'plannedAbsences' is intentionally kept as the renderer binding.
UPDATE dashboard_card_config
SET name = 'Leave Calendar'
WHERE card_key = 'plannedAbsences'
  AND name = 'Planned Absences';
