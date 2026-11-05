-- Preserve the existing document engine and add its catalogue binding/current-publication slot.
ALTER TABLE job_document ADD COLUMN job_unit_id uuid;
ALTER TABLE job_document ADD COLUMN company_variant boolean NOT NULL DEFAULT false;
ALTER TABLE job_document_revision ADD COLUMN architecture jsonb;
ALTER TABLE job_document_revision ADD CONSTRAINT job_document_architecture_shape CHECK(architecture IS NULL OR jsonb_typeof(architecture)='object');
ALTER TABLE job_document_revision DROP CONSTRAINT job_document_revision_status_check;
ALTER TABLE job_document_revision ADD CONSTRAINT job_document_revision_status_check CHECK(status IN('draft','submitted','approved','superseded'));
DROP INDEX job_document_one_working_revision;
CREATE UNIQUE INDEX job_document_one_working_revision ON job_document_revision(job_id) WHERE status IN('draft','submitted');
CREATE TABLE job_architecture_jd_publication (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),job_unit_id uuid NOT NULL,
 variant_company_id uuid REFERENCES company(id),job_id uuid NOT NULL,revision_id uuid NOT NULL,
 published_by uuid NOT NULL REFERENCES app_user(id),published_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,job_id) REFERENCES job_document(tenant_id,id),FOREIGN KEY(tenant_id,revision_id) REFERENCES job_document_revision(tenant_id,id),
 UNIQUE(tenant_id,id)
);
CREATE UNIQUE INDEX job_architecture_current_jd ON job_architecture_jd_publication(tenant_id,job_unit_id,coalesce(variant_company_id,'00000000-0000-0000-0000-000000000000'::uuid));
ALTER TABLE job_architecture_jd_publication ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_architecture_jd_publication FORCE ROW LEVEL SECURITY;
CREATE POLICY job_architecture_jd_publication_read ON job_architecture_jd_publication FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.job_document_scope(tenant_id,job_id));
CREATE POLICY job_architecture_jd_publication_write ON job_architecture_jd_publication FOR ALL USING(tenant_id=app.current_tenant_id() AND app.job_architecture_can(variant_company_id,'check')) WITH CHECK(tenant_id=app.current_tenant_id() AND published_by=app.current_user_id() AND app.job_architecture_can(variant_company_id,'check'));
GRANT SELECT,INSERT,UPDATE ON job_architecture_jd_publication TO ai_hr_app;
--> statement-breakpoint
-- Architecture seats extend document permission without granting generic Personnel maintenance.
CREATE OR REPLACE FUNCTION app.job_document_scope(p_tenant uuid,p_job uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT p_tenant=app.current_tenant_id() AND EXISTS(SELECT 1 FROM job_document j WHERE j.tenant_id=p_tenant AND j.id=p_job AND (app.access_workforce_company(j.company_id,'workforce.view') OR app.job_architecture_can(j.company_id,'view')))
$$;
CREATE POLICY job_document_architecture_read ON job_document FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.job_architecture_can(company_id,'view'));
CREATE POLICY job_document_architecture_insert ON job_document FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND created_by=app.current_user_id() AND app.job_architecture_can(company_id,'propose'));
CREATE POLICY job_document_architecture_update ON job_document FOR UPDATE USING(tenant_id=app.current_tenant_id() AND (app.job_architecture_can(company_id,'propose') OR app.job_architecture_can(company_id,'check'))) WITH CHECK(tenant_id=app.current_tenant_id() AND (app.job_architecture_can(company_id,'propose') OR app.job_architecture_can(company_id,'check')));
CREATE POLICY job_document_revision_architecture_write ON job_document_revision FOR ALL USING(app.job_document_scope(tenant_id,job_id) AND EXISTS(SELECT 1 FROM job_document j WHERE j.id=job_id AND j.tenant_id=job_document_revision.tenant_id AND (app.job_architecture_can(j.company_id,'propose') OR app.job_architecture_can(j.company_id,'check')))) WITH CHECK(app.job_document_scope(tenant_id,job_id) AND EXISTS(SELECT 1 FROM job_document j WHERE j.id=job_id AND j.tenant_id=job_document_revision.tenant_id AND (app.job_architecture_can(j.company_id,'propose') OR app.job_architecture_can(j.company_id,'check'))));
CREATE POLICY job_document_form_architecture_read ON job_document_form FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.job_architecture_can(company_id,'view'));
CREATE POLICY job_document_form_architecture_insert ON job_document_form FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.job_architecture_can(company_id,'check') AND created_by=app.current_user_id());
CREATE POLICY job_document_review_architecture_write ON job_document_review FOR ALL USING(app.job_revision_scope(tenant_id,revision_id) AND EXISTS(SELECT 1 FROM job_document_revision r JOIN job_document j ON j.id=r.job_id AND j.tenant_id=r.tenant_id WHERE r.id=job_document_review.revision_id AND r.tenant_id=job_document_review.tenant_id AND (app.job_architecture_can(j.company_id,'propose') OR app.job_architecture_can(j.company_id,'check')))) WITH CHECK(app.job_revision_scope(tenant_id,revision_id) AND EXISTS(SELECT 1 FROM job_document_revision r JOIN job_document j ON j.id=r.job_id AND j.tenant_id=r.tenant_id WHERE r.id=job_document_review.revision_id AND r.tenant_id=job_document_review.tenant_id AND (app.job_architecture_can(j.company_id,'propose') OR app.job_architecture_can(j.company_id,'check'))));
CREATE POLICY job_document_attachment_architecture_write ON job_document_attachment FOR ALL USING(app.job_revision_scope(tenant_id,revision_id) AND EXISTS(SELECT 1 FROM job_document_revision r JOIN job_document j ON j.id=r.job_id AND j.tenant_id=r.tenant_id WHERE r.id=job_document_attachment.revision_id AND r.tenant_id=job_document_attachment.tenant_id AND (app.job_architecture_can(j.company_id,'propose') OR app.job_architecture_can(j.company_id,'check')))) WITH CHECK(app.job_revision_scope(tenant_id,revision_id) AND EXISTS(SELECT 1 FROM job_document_revision r JOIN job_document j ON j.id=r.job_id AND j.tenant_id=r.tenant_id WHERE r.id=job_document_attachment.revision_id AND r.tenant_id=job_document_attachment.tenant_id AND (app.job_architecture_can(j.company_id,'propose') OR app.job_architecture_can(j.company_id,'check'))));
CREATE POLICY job_document_audit_architecture_insert ON job_document_audit FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND actor_id=app.current_user_id() AND app.job_document_scope(tenant_id,job_id));
--> statement-breakpoint
ALTER TABLE job_architecture_outlier ADD COLUMN description text NOT NULL DEFAULT '' CHECK(length(description)<=4000);
ALTER TABLE job_architecture_outlier ADD COLUMN proposed_fix text NOT NULL DEFAULT '' CHECK(length(proposed_fix)<=4000);
ALTER TABLE job_architecture_outlier ADD COLUMN source_id text;
ALTER TABLE job_architecture_outlier ADD COLUMN manual boolean NOT NULL DEFAULT false;
ALTER TABLE job_architecture_outlier ADD COLUMN source_history jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(source_history)='array');
CREATE UNIQUE INDEX job_architecture_outlier_import_source ON job_architecture_outlier(tenant_id,source_id) WHERE source_id IS NOT NULL;
CREATE TABLE job_architecture_suggestion (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),company_id uuid NOT NULL REFERENCES company(id),
 kind text NOT NULL CHECK(kind IN('position','description','outlier')),subject_id uuid NOT NULL,source_digest text NOT NULL CHECK(source_digest~'^[a-f0-9]{64}$'),
 catalogue_revision integer NOT NULL,payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),provider_ref text NOT NULL,
 created_by uuid NOT NULL REFERENCES app_user(id),created_at timestamptz NOT NULL DEFAULT now(),
 decision text NOT NULL DEFAULT 'pending' CHECK(decision IN('pending','accepted','edited','rejected')),decided_by uuid REFERENCES app_user(id),decided_at timestamptz,
 proposal_id uuid,FOREIGN KEY(tenant_id,proposal_id) REFERENCES job_architecture_proposal(tenant_id,id),
 CHECK((decision='pending')=(decided_by IS NULL))
);
ALTER TABLE job_architecture_suggestion ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_architecture_suggestion FORCE ROW LEVEL SECURITY;
CREATE POLICY job_architecture_suggestion_read ON job_architecture_suggestion FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.job_architecture_can(company_id,'view'));
CREATE POLICY job_architecture_suggestion_insert ON job_architecture_suggestion FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND created_by=app.current_user_id() AND app.job_architecture_can(company_id,'propose'));
CREATE POLICY job_architecture_suggestion_update ON job_architecture_suggestion FOR UPDATE USING(tenant_id=app.current_tenant_id() AND decision='pending' AND app.job_architecture_can(company_id,'check')) WITH CHECK(tenant_id=app.current_tenant_id() AND decided_by=app.current_user_id() AND decision<>'pending' AND app.job_architecture_can(company_id,'check'));
GRANT SELECT,INSERT,UPDATE ON job_architecture_suggestion TO ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.job_document_reviewer_eligible(p_company uuid,p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.current_user_id() IS NOT NULL AND app.principal_snapshot_current()
 AND (app.access_workforce_company(p_company,'workforce.maintain') OR app.job_architecture_can(p_company,'propose') OR app.job_architecture_can(p_company,'check'))
 AND EXISTS(SELECT 1 FROM public.company co JOIN public.app_user u ON u.tenant_id=co.tenant_id
 WHERE co.id=p_company AND co.tenant_id=app.current_tenant_id() AND u.id=p_user AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
 AND (EXISTS(SELECT 1 FROM public.role_assignment ra JOIN public.access_capability cap ON cap.id='workforce.maintain'
 WHERE ra.tenant_id=u.tenant_id AND ra.app_user_id=u.id AND ra.role::text IN('hr_admin','super_admin') AND app.access_scope_covers(ra.company_id,co.id,co.tenant_id) AND (NOT cap.supported OR app.access_allowed_for(u.id,cap.id,co.id)))
 OR EXISTS(SELECT 1 FROM public.job_architecture_seat s WHERE s.tenant_id=u.tenant_id AND s.user_id=u.id AND (s.company_id IS NULL OR s.company_id=co.id) AND s.role IN('group_rewards','org_design','pbp') AND s.valid_from<=timezone('Asia/Kuala_Lumpur',now())::date AND (s.valid_to IS NULL OR s.valid_to>=timezone('Asia/Kuala_Lumpur',now())::date))));
$$;
--> statement-breakpoint
CREATE TABLE job_architecture_import_preview(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),created_by uuid NOT NULL REFERENCES app_user(id),
 kind text NOT NULL CHECK(kind IN('catalogue','positions','outliers')),company_id uuid REFERENCES company(id),source_digest text NOT NULL,
 file_digest text NOT NULL CHECK(file_digest~'^[a-f0-9]{64}$'),preview jsonb NOT NULL CHECK(jsonb_typeof(preview)='object'),
 created_at timestamptz NOT NULL DEFAULT now(),consumed_at timestamptz
);
ALTER TABLE job_architecture_import_preview ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_architecture_import_preview FORCE ROW LEVEL SECURITY;
CREATE POLICY job_architecture_import_preview_read ON job_architecture_import_preview FOR SELECT USING(tenant_id=app.current_tenant_id() AND created_by=app.current_user_id() AND app.job_architecture_can(company_id,'propose'));
CREATE POLICY job_architecture_import_preview_insert ON job_architecture_import_preview FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND created_by=app.current_user_id() AND consumed_at IS NULL AND app.job_architecture_can(company_id,'propose'));
CREATE POLICY job_architecture_import_preview_update ON job_architecture_import_preview FOR UPDATE USING(tenant_id=app.current_tenant_id() AND created_by=app.current_user_id() AND consumed_at IS NULL AND app.job_architecture_can(company_id,'propose')) WITH CHECK(tenant_id=app.current_tenant_id() AND created_by=app.current_user_id() AND consumed_at IS NOT NULL AND app.job_architecture_can(company_id,'propose'));
GRANT SELECT,INSERT,UPDATE ON job_architecture_import_preview TO ai_hr_app;
