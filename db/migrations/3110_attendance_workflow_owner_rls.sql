-- Preserve the applied 3101 bodies and all tenant/actor/candidate checks.
-- ai_hr_owner is intentionally not SUPERUSER/BYPASSRLS. Disabling row_security propagates
-- into the forced-RLS access catalogue and errors even for its authorized schema owner.
-- Keep RLS enabled so the existing owner-only policies adjudicate those reads normally.
ALTER FUNCTION app.attendance_workflow_companies(uuid) SET row_security=on;
ALTER FUNCTION app.attendance_workflow_applies(uuid,uuid) SET row_security=on;
ALTER FUNCTION app.attendance_workflow_all_companies_admin(uuid) SET row_security=on;
ALTER FUNCTION app.attendance_selected_approver_eligible(uuid,uuid) SET row_security=on;
ALTER FUNCTION app.attendance_workflow_v3_approver_options(uuid[]) SET row_security=on;
