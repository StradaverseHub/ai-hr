-- Direct field selection. Legacy declaration rows remain unmodified and immutable.
CREATE TABLE employment_tax_selection_my (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id),
 employment_id uuid NOT NULL REFERENCES employment(id), company_id uuid NOT NULL REFERENCES company(id),
 scheme text CHECK(scheme IN ('resident','non_resident','rep','knowledge_worker','c_suite')),
 transition_state text NOT NULL CHECK(transition_state IN ('resolved','confirmation_required')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0), legacy_scheme text,
 source text NOT NULL CHECK(source IN ('legacy_conversion','explicit')),
 provenance jsonb NOT NULL CHECK(jsonb_typeof(provenance)='object'),
 updated_by_user_id uuid REFERENCES app_user(id),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(transition_state <> 'resolved' OR scheme IS NOT NULL),
 UNIQUE(tenant_id,employment_id,company_id)
);
--> statement-breakpoint
ALTER TABLE employment_tax_selection_my ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON employment_tax_selection_my FROM ai_hr_app;
--> statement-breakpoint
GRANT SELECT,INSERT ON employment_tax_selection_my TO ai_hr_app;
--> statement-breakpoint
GRANT UPDATE(scheme,transition_state,version,updated_by_user_id,updated_at) ON employment_tax_selection_my TO ai_hr_app;
--> statement-breakpoint
CREATE POLICY employment_tax_selection_my_read ON employment_tax_selection_my FOR SELECT USING (
 tenant_id=app.current_tenant_id() AND app.can_admin_payroll_for(company_id)
 AND EXISTS(SELECT 1 FROM employment e WHERE e.id=employment_id AND e.tenant_id=employment_tax_selection_my.tenant_id AND app.can_admin_payroll_for(e.company_id))
);
--> statement-breakpoint
CREATE POLICY employment_tax_selection_my_insert ON employment_tax_selection_my FOR INSERT WITH CHECK (
 tenant_id=app.current_tenant_id() AND app.is_admin_for(company_id)
 AND updated_by_user_id=app.current_user_id() AND created_at=now() AND updated_at=now() AND version=1
 AND EXISTS(SELECT 1 FROM app_user u WHERE u.id=updated_by_user_id AND u.tenant_id=employment_tax_selection_my.tenant_id)
 AND EXISTS(SELECT 1 FROM company c WHERE c.id=company_id AND c.tenant_id=employment_tax_selection_my.tenant_id AND c.country='MY')
 AND EXISTS(SELECT 1 FROM employment e WHERE e.id=employment_id AND e.tenant_id=employment_tax_selection_my.tenant_id AND app.is_admin_for(e.company_id)
 AND (e.company_id=employment_tax_selection_my.company_id OR EXISTS(SELECT 1 FROM assignment a WHERE a.employment_id=e.id AND a.tenant_id=e.tenant_id AND a.company_id=employment_tax_selection_my.company_id AND a.superseded_at IS NULL)))
);
--> statement-breakpoint
CREATE POLICY employment_tax_selection_my_update ON employment_tax_selection_my FOR UPDATE USING (
 tenant_id=app.current_tenant_id() AND app.is_admin_for(company_id)
 AND EXISTS(SELECT 1 FROM employment e WHERE e.id=employment_id AND e.tenant_id=employment_tax_selection_my.tenant_id AND app.is_admin_for(e.company_id))
) WITH CHECK (
 tenant_id=app.current_tenant_id() AND app.is_admin_for(company_id)
 AND updated_by_user_id=app.current_user_id() AND updated_at=now()
 AND EXISTS(SELECT 1 FROM app_user u WHERE u.id=updated_by_user_id AND u.tenant_id=employment_tax_selection_my.tenant_id)
 AND EXISTS(SELECT 1 FROM employment e WHERE e.id=employment_id AND e.tenant_id=employment_tax_selection_my.tenant_id AND app.is_admin_for(e.company_id))
);
--> statement-breakpoint
CREATE FUNCTION guard_employment_tax_selection_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.version <> OLD.version+1 THEN RAISE EXCEPTION 'tax selection revision mismatch'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER employment_tax_selection_revision BEFORE UPDATE ON employment_tax_selection_my FOR EACH ROW EXECUTE FUNCTION guard_employment_tax_selection_revision();
--> statement-breakpoint
-- Deterministic initial conversion, as the migration owner; no invented HR actor/approval.
-- Old declaration records are diagnostic evidence only and are never rewritten.
WITH contexts AS (
 SELECT e.tenant_id,e.id employment_id,e.person_id,e.company_id FROM employment e JOIN company c ON c.id=e.company_id AND c.tenant_id=e.tenant_id AND c.country='MY'
 UNION
 SELECT e.tenant_id,e.id,e.person_id,a.company_id FROM employment e JOIN assignment a ON a.employment_id=e.id AND a.tenant_id=e.tenant_id AND a.superseded_at IS NULL JOIN company c ON c.id=a.company_id AND c.tenant_id=e.tenant_id AND c.country='MY'
), inputs AS (
 SELECT x.*,e.company_id current_company_id,
 CASE WHEN s.tax_residency='resident' AND s.is_resident=false THEN 'non_resident' ELSE coalesce(s.tax_residency,CASE WHEN s.is_resident=false THEN 'non_resident' ELSE 'resident' END) END legacy,
 (SELECT count(DISTINCT z.company_id) FROM employment z WHERE z.person_id=x.person_id AND z.tenant_id=x.tenant_id AND z.terminated_on IS NULL) current_employers,
 (SELECT count(DISTINCT a.company_id) FROM assignment a WHERE a.employment_id=x.employment_id AND a.tenant_id=x.tenant_id AND a.superseded_at IS NULL) assignment_employers,
 coalesce((SELECT jsonb_agg(d.id ORDER BY d.id) FROM employment_tax_scheme_my d WHERE d.tenant_id=x.tenant_id AND d.employment_id=x.employment_id AND d.company_id=x.company_id AND d.archived_at IS NULL AND
 (EXISTS(SELECT 1 FROM assignment a WHERE a.employment_id=x.employment_id AND a.tenant_id=x.tenant_id AND a.company_id=x.company_id AND a.superseded_at IS NULL AND a.valid_from <= (to_date(d.valid_to||'-01','YYYY-MM-DD')+interval '1 month'-interval '1 day')::date AND (a.valid_to IS NULL OR a.valid_to>to_date(d.valid_from||'-01','YYYY-MM-DD')))
 OR (e.company_id=x.company_id AND e.hired_on <= (to_date(d.valid_to||'-01','YYYY-MM-DD')+interval '1 month'-interval '1 day')::date AND (e.terminated_on IS NULL OR e.terminated_on>=to_date(d.valid_from||'-01','YYYY-MM-DD'))))), '[]'::jsonb) declaration_ids
 FROM contexts x JOIN employment e ON e.id=x.employment_id AND e.tenant_id=x.tenant_id LEFT JOIN employee_statutory_my s ON s.person_id=x.person_id AND s.tenant_id=x.tenant_id
), decisions AS (
 SELECT i.*,
 CASE WHEN legacy IN ('resident','non_resident') THEN jsonb_array_length(declaration_ids)>0
 WHEN legacy IN ('rep','knowledge_worker') THEN current_company_id<>company_id OR current_employers<>1 OR assignment_employers>1
 OR EXISTS(SELECT 1 FROM employment_tax_scheme_my d WHERE d.id IN (SELECT value::uuid FROM jsonb_array_elements_text(declaration_ids)) AND d.scheme<>legacy)
 ELSE true END needs_confirmation FROM inputs i
)
INSERT INTO employment_tax_selection_my(tenant_id,employment_id,company_id,scheme,transition_state,legacy_scheme,source,provenance)
SELECT tenant_id,employment_id,company_id,CASE WHEN legacy IN ('resident','non_resident','rep','knowledge_worker','c_suite') THEN legacy END,
 CASE WHEN needs_confirmation THEN 'confirmation_required' ELSE 'resolved' END,legacy,'legacy_conversion',
 jsonb_build_object('reason',CASE WHEN needs_confirmation THEN 'legacy_context_ambiguous' ELSE 'legacy_unambiguous' END,'declarationIds',declaration_ids)
FROM decisions ON CONFLICT(tenant_id,employment_id,company_id) DO NOTHING;
