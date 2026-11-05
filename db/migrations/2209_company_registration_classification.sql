-- Explicit employer/grouping/test metadata. No name-based classification or live data backfill.
CREATE TABLE company_registration_classification(
 company_id uuid PRIMARY KEY REFERENCES company(id),tenant_id uuid NOT NULL REFERENCES tenant(id),
 entity_kind text NOT NULL DEFAULT 'legal_entity' CHECK(entity_kind IN('legal_entity','grouping_node')),
 is_test_entity boolean NOT NULL DEFAULT false,revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 changed_by uuid NOT NULL REFERENCES app_user(id),updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE company_registration_classification ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_registration_classification FORCE ROW LEVEL SECURITY;
CREATE POLICY company_registration_classification_read ON company_registration_classification FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.is_admin_for(company_id));
CREATE POLICY company_registration_classification_write ON company_registration_classification FOR ALL USING(tenant_id=app.current_tenant_id() AND app.is_admin_for(company_id)) WITH CHECK(tenant_id=app.current_tenant_id() AND changed_by=app.current_user_id() AND app.is_admin_for(company_id) AND EXISTS(SELECT 1 FROM company c WHERE c.id=company_id AND c.tenant_id=company_registration_classification.tenant_id));
GRANT SELECT,INSERT,UPDATE ON company_registration_classification TO ai_hr_app;
