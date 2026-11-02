-- BK53: preserve every selected compensation witness when a month is calculated once.
-- Existing line witnesses remain valid; no issued payroll or historical line is rewritten.
CREATE TABLE back_pay_source (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  run_id uuid NOT NULL REFERENCES back_pay_run(id),
  source_compensation_id uuid NOT NULL REFERENCES compensation(id),
  CONSTRAINT back_pay_source_run_source_unique UNIQUE (run_id, source_compensation_id)
);
--> statement-breakpoint
CREATE INDEX back_pay_source_lookup_idx ON back_pay_source(tenant_id, source_compensation_id);
--> statement-breakpoint
ALTER TABLE back_pay_source ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON back_pay_source FROM PUBLIC;
REVOKE UPDATE, DELETE ON back_pay_source FROM ai_hr_app;
GRANT SELECT, INSERT ON back_pay_source TO ai_hr_app;
--> statement-breakpoint
CREATE POLICY back_pay_source_read ON back_pay_source FOR SELECT USING (
 tenant_id=app.current_tenant_id() AND EXISTS (
  SELECT 1 FROM back_pay_run r WHERE r.id=run_id AND r.tenant_id=back_pay_source.tenant_id AND app.is_admin_for(r.company_id)
 )
);
--> statement-breakpoint
CREATE POLICY back_pay_source_insert ON back_pay_source FOR INSERT WITH CHECK (
 tenant_id=app.current_tenant_id() AND EXISTS (
  SELECT 1 FROM back_pay_run r JOIN compensation c ON c.id=source_compensation_id
  JOIN employment e ON e.id=c.employment_id AND e.tenant_id=c.tenant_id
  WHERE r.id=run_id AND r.tenant_id=back_pay_source.tenant_id
   AND c.tenant_id=back_pay_source.tenant_id AND e.company_id=r.company_id
   AND r.status='draft' AND app.is_admin_for(r.company_id)
 )
);
