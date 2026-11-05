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
--> statement-breakpoint
-- Optional predecessor: Rewards setup's nonlogin reader gets only classification rows it may manage.
-- Standalone statutory-readiness candidates need not contain the independent Rewards migrations.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ai_hr_reward_setup_reader') AND to_regprocedure('app.reward_setup_allowed(uuid,text)') IS NOT NULL THEN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ai_hr_reward_setup_reader' AND (rolcanlogin OR rolsuper OR rolbypassrls)) THEN RAISE EXCEPTION 'Unsafe Rewards setup reader'; END IF;
  EXECUTE 'GRANT SELECT ON company_registration_classification TO ai_hr_reward_setup_reader';
  EXECUTE 'CREATE POLICY company_registration_setup_reader ON company_registration_classification FOR SELECT TO ai_hr_reward_setup_reader USING(tenant_id=app.current_tenant_id() AND app.reward_setup_allowed(company_id,''manage''))';
 END IF;
END $$;
