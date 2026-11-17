-- DBA cleanup IMMEDIATELY after applying the proposal, on success OR failure. No app membership is granted.
BEGIN;
REVOKE ai_hr_mobile_offline_counter FROM ai_hr_owner;
REVOKE CREATE ON SCHEMA app FROM ai_hr_mobile_offline_counter;
COMMIT;
