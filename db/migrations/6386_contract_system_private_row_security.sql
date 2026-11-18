-- Private system provenance and digest receipts remain owner-only even if a future broad table grant appears.
-- No application grants or row policies: the physical/table owner and existing guarded definers retain their native work.
ALTER TABLE app.contract_system_job_source ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.contract_system_digest ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app.contract_system_job_source,app.contract_system_digest FROM PUBLIC,ai_hr_app;
