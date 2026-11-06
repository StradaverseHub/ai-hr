CREATE TABLE public.payroll_individual_import_job (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  created_by uuid NOT NULL REFERENCES public.app_user(id),
  company_ids jsonb NOT NULL CHECK (jsonb_typeof(company_ids) = 'array' AND jsonb_array_length(company_ids) > 0),
  context jsonb NOT NULL,
  source_name text NOT NULL CHECK (length(source_name) BETWEEN 1 AND 255),
  source_hash text NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  source bytea NOT NULL CHECK (octet_length(source) BETWEEN 1 AND 10485760),
  method text NOT NULL CHECK (method IN ('monthly', 'daily')),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'validating', 'ready', 'confirmed', 'importing', 'completed', 'failed')),
  attempt_id uuid REFERENCES public.payroll_txn_import_attempt(id),
  processed integer NOT NULL DEFAULT 0 CHECK (processed BETWEEN 0 AND 2000),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);
CREATE INDEX payroll_individual_import_job_history ON public.payroll_individual_import_job (tenant_id, created_at DESC, id DESC);
CREATE INDEX payroll_individual_import_job_queue ON public.payroll_individual_import_job (created_at, id)
  WHERE state IN ('pending', 'validating', 'confirmed', 'importing');

ALTER TABLE public.payroll_individual_import_job ENABLE ROW LEVEL SECURITY;
CREATE POLICY payroll_individual_import_job_read ON public.payroll_individual_import_job FOR SELECT TO ai_hr_app
  USING (tenant_id = app.current_tenant_id() AND app.current_user_id() IS NOT NULL
    AND app.principal_snapshot_current() AND app.is_admin()
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(company_ids) c WHERE NOT app.is_admin_for(c::uuid)));
CREATE POLICY payroll_individual_import_job_submit ON public.payroll_individual_import_job FOR INSERT TO ai_hr_app
  WITH CHECK (tenant_id = app.current_tenant_id() AND created_by = app.current_user_id()
    AND app.principal_snapshot_current() AND app.is_admin()
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(company_ids) c WHERE NOT app.is_admin_for(c::uuid)));
CREATE POLICY payroll_individual_import_job_confirm ON public.payroll_individual_import_job FOR UPDATE TO ai_hr_app
  USING (tenant_id = app.current_tenant_id() AND created_by = app.current_user_id()
    AND state = 'ready' AND app.principal_snapshot_current() AND app.is_admin()
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(company_ids) c WHERE NOT app.is_admin_for(c::uuid)))
  WITH CHECK (tenant_id = app.current_tenant_id() AND created_by = app.current_user_id()
    AND state = 'confirmed' AND app.principal_snapshot_current() AND app.is_admin()
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(company_ids) c WHERE NOT app.is_admin_for(c::uuid)));
GRANT SELECT ON public.payroll_individual_import_job TO ai_hr_app;
GRANT INSERT (id, tenant_id, created_by, company_ids, context, source_name, source_hash, source, method)
  ON public.payroll_individual_import_job TO ai_hr_app;
GRANT UPDATE (state) ON public.payroll_individual_import_job TO ai_hr_app;
