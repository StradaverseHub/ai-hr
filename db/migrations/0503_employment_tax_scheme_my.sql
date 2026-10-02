-- r380 / 2b9235f6: explicit employer-period approval declaration; no inferred/backfilled approvals.
CREATE TABLE employment_tax_scheme_my (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenant(id),
 employment_id uuid NOT NULL REFERENCES employment(id),
 company_id uuid NOT NULL REFERENCES company(id),
 scheme text NOT NULL CHECK (scheme IN ('rep','knowledge_worker','c_suite')),
 valid_from text NOT NULL CHECK (valid_from ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' AND left(valid_from,4) <> '0000'),
 valid_to text NOT NULL CHECK (valid_to ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' AND left(valid_to,4) <> '0000' AND valid_to >= valid_from),
 approval_reference text NOT NULL CHECK (length(btrim(approval_reference)) BETWEEN 1 AND 300),
 declared_by_user_id uuid NOT NULL REFERENCES app_user(id),
 declared_at timestamptz NOT NULL DEFAULT now(),
 archived_at timestamptz
);
--> statement-breakpoint
CREATE INDEX employment_tax_scheme_my_lookup ON employment_tax_scheme_my(tenant_id,employment_id,company_id,valid_from,valid_to) WHERE archived_at IS NULL;
--> statement-breakpoint
ALTER TABLE employment_tax_scheme_my ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT ON employment_tax_scheme_my TO ai_hr_app;
--> statement-breakpoint
-- Immutable approval facts: the only app update is explicit archival (revoke + new declaration).
GRANT UPDATE (archived_at) ON employment_tax_scheme_my TO ai_hr_app;
--> statement-breakpoint
CREATE POLICY employment_tax_scheme_my_read ON employment_tax_scheme_my FOR SELECT USING (
 tenant_id=app.current_tenant_id() AND app.can_admin_payroll_for(company_id)
 AND EXISTS (SELECT 1 FROM employment e WHERE e.id=employment_id AND e.tenant_id=employment_tax_scheme_my.tenant_id AND app.can_admin_payroll_for(e.company_id))
);
--> statement-breakpoint
CREATE POLICY employment_tax_scheme_my_insert ON employment_tax_scheme_my FOR INSERT WITH CHECK (
 tenant_id=app.current_tenant_id() AND app.is_admin_for(company_id)
 AND EXISTS (SELECT 1 FROM employment e JOIN company c ON c.id=e.company_id AND c.tenant_id=e.tenant_id WHERE e.id=employment_id AND e.tenant_id=employment_tax_scheme_my.tenant_id AND e.company_id=employment_tax_scheme_my.company_id AND c.country='MY')
 AND declared_by_user_id=app.current_user_id() AND declared_at=now() AND archived_at IS NULL
 AND EXISTS (SELECT 1 FROM app_user u WHERE u.id=declared_by_user_id AND u.tenant_id=employment_tax_scheme_my.tenant_id)
);
--> statement-breakpoint
CREATE POLICY employment_tax_scheme_my_update ON employment_tax_scheme_my FOR UPDATE USING (
 tenant_id=app.current_tenant_id() AND app.is_admin_for(company_id)
 AND EXISTS (SELECT 1 FROM employment e WHERE e.id=employment_id AND e.tenant_id=employment_tax_scheme_my.tenant_id AND app.is_admin_for(e.company_id))
) WITH CHECK (
 archived_at=now() AND tenant_id=app.current_tenant_id() AND app.is_admin_for(company_id)
 AND EXISTS (SELECT 1 FROM employment e WHERE e.id=employment_id AND e.tenant_id=employment_tax_scheme_my.tenant_id AND app.is_admin_for(e.company_id))
);
--> statement-breakpoint
-- Integer month ordinals avoid timezone/date-cast volatility inside the exclusion expression.
ALTER TABLE employment_tax_scheme_my ADD CONSTRAINT employment_tax_scheme_my_no_overlap EXCLUDE USING gist (
 tenant_id WITH =, employment_id WITH =, company_id WITH =,
 int4range((left(valid_from,4)::integer*12+right(valid_from,2)::integer),
           (left(valid_to,4)::integer*12+right(valid_to,2)::integer+1),'[)') WITH &&
) WHERE (archived_at IS NULL);
