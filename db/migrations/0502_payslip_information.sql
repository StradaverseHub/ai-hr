-- Display-only company settings. Existing slips and payroll amounts are unchanged.
CREATE TABLE payslip_information_setting (
 company_id uuid PRIMARY KEY REFERENCES company(id),
 tenant_id uuid NOT NULL REFERENCES tenant(id),
 fields jsonb NOT NULL CHECK (jsonb_typeof(fields) = 'array')
);
--> statement-breakpoint
ALTER TABLE payslip_information_setting ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY payslip_information_read ON payslip_information_setting FOR SELECT USING (
 tenant_id = app.current_tenant_id()
 AND EXISTS (SELECT 1 FROM public.company c WHERE c.id = company_id AND c.tenant_id = app.current_tenant_id()) AND (
 app.can_admin_payroll_for(company_id) OR EXISTS (
 SELECT 1 FROM public.payslip ps JOIN public.payroll_batch pb ON pb.id = ps.batch_id
 WHERE pb.company_id = payslip_information_setting.company_id AND ps.tenant_id = payslip_information_setting.tenant_id
 AND pb.status = 'closed' AND (pb.released_at IS NULL OR pb.released_at <= now())
 )));
--> statement-breakpoint
CREATE POLICY payslip_information_write ON payslip_information_setting FOR ALL USING (
 tenant_id = app.current_tenant_id()
 AND EXISTS (SELECT 1 FROM public.company c WHERE c.id = company_id AND c.tenant_id = app.current_tenant_id())
 AND app.can_admin_payroll_for(company_id)
) WITH CHECK (tenant_id = app.current_tenant_id()
 AND EXISTS (SELECT 1 FROM public.company c WHERE c.id = company_id AND c.tenant_id = app.current_tenant_id())
 AND app.can_admin_payroll_for(company_id));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON payslip_information_setting TO ai_hr_app;
--> statement-breakpoint
