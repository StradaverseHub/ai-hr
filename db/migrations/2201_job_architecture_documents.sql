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
 catalogue_revision integer NOT NULL,payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),provider_ref text NOT NULL,contract_id text NOT NULL DEFAULT 'job_architecture_advice_v1',prompt_version integer NOT NULL DEFAULT 1 CHECK(prompt_version=1),
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
 OR EXISTS(SELECT 1 FROM public.job_architecture_seat s WHERE s.tenant_id=u.tenant_id AND s.user_id=u.id AND (s.company_id IS NULL OR s.company_id=co.id) AND s.role IN('group_rewards','org_design','pbp','hod') AND s.valid_from<=timezone('Asia/Kuala_Lumpur',now())::date AND (s.valid_to IS NULL OR s.valid_to>=timezone('Asia/Kuala_Lumpur',now())::date))));
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

-- Retain all historical content when publishing a successor.
CREATE OR REPLACE FUNCTION app.guard_job_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.status<>'draft' OR OLD.version<>1 THEN RAISE EXCEPTION 'Only an unused initial draft may be deleted'; END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'draft' OR NEW.prepared_by IS DISTINCT FROM app.current_user_id() OR NEW.last_edited_by IS DISTINCT FROM app.current_user_id() THEN RAISE EXCEPTION 'Create a draft as the authenticated preparer'; END IF;
  NEW.contributor_ids:=ARRAY[app.current_user_id()];
  RETURN NEW;
 END IF;
 IF OLD.status='approved' THEN
  IF NEW.status='superseded' AND NEW.lock_version=OLD.lock_version+1 AND (to_jsonb(NEW)-ARRAY['status','updated_at','lock_version'])=(to_jsonb(OLD)-ARRAY['status','updated_at','lock_version']) AND EXISTS(SELECT 1 FROM job_document j WHERE j.id=OLD.job_id AND j.tenant_id=OLD.tenant_id AND app.job_architecture_can(CASE WHEN j.company_variant THEN j.company_id ELSE NULL END,'check')) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Approved revisions are immutable';
 END IF;
 IF OLD.status='superseded' THEN RAISE EXCEPTION 'Superseded revisions are immutable'; END IF;
 IF NEW.tenant_id<>OLD.tenant_id OR NEW.job_id<>OLD.job_id OR NEW.id<>OLD.id OR NEW.version<>OLD.version OR NEW.prepared_by<>OLD.prepared_by OR NEW.definition<>OLD.definition THEN RAISE EXCEPTION 'Revision identity and form snapshot are immutable'; END IF;
 IF NEW.lock_version<>OLD.lock_version+1 THEN RAISE EXCEPTION 'Stale revision'; END IF;
 IF OLD.status='submitted' AND (NEW.architecture IS DISTINCT FROM OLD.architecture OR NEW.title<>OLD.title OR NEW.org<>OLD.org OR NEW.org_labels<>OLD.org_labels OR NEW.answers<>OLD.answers OR NEW.document_owner<>OLD.document_owner OR NEW.effective_on IS DISTINCT FROM OLD.effective_on OR NEW.review_on IS DISTINCT FROM OLD.review_on OR NEW.reason<>OLD.reason OR NEW.approver_id IS DISTINCT FROM OLD.approver_id OR NEW.last_edited_by<>OLD.last_edited_by) THEN RAISE EXCEPTION 'Return the document before editing'; END IF;
 IF OLD.status='draft' THEN
  NEW.contributor_ids:=ARRAY(SELECT DISTINCT unnest(OLD.contributor_ids || ARRAY[app.current_user_id()]));
 ELSE NEW.contributor_ids:=OLD.contributor_ids; END IF;
 IF NEW.status='approved' THEN
  IF OLD.status<>'submitted' OR NEW.approver_id IS DISTINCT FROM app.current_user_id() OR NEW.approved_by IS DISTINCT FROM app.current_user_id() OR NEW.approved_by=ANY(OLD.contributor_ids) OR NEW.approved_by=OLD.submitted_by OR NOT EXISTS(SELECT 1 FROM job_document_review WHERE revision_id=OLD.id) OR EXISTS(SELECT 1 FROM job_document_review WHERE revision_id=OLD.id AND decision<>'reviewed') THEN RAISE EXCEPTION 'An independent named approver and completed reviews are required'; END IF;
 END IF;
 RETURN NEW;
END $$;


-- Publication history preserves the currently effective document when a successor starts later.
CREATE TABLE job_architecture_jd_publication_history (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id),
 job_unit_id uuid NOT NULL,variant_company_id uuid,job_id uuid NOT NULL,revision_id uuid NOT NULL,
 published_by uuid NOT NULL REFERENCES app_user(id),published_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,revision_id),
 FOREIGN KEY(tenant_id,job_id) REFERENCES job_document(tenant_id,id),
 FOREIGN KEY(tenant_id,revision_id) REFERENCES job_document_revision(tenant_id,id),
 FOREIGN KEY(tenant_id,variant_company_id) REFERENCES company(tenant_id,id)
);
ALTER TABLE job_architecture_jd_publication_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_architecture_jd_publication_history FORCE ROW LEVEL SECURITY;
CREATE POLICY architecture_jd_history_read ON job_architecture_jd_publication_history FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.job_document_scope(tenant_id,job_id));
CREATE POLICY architecture_jd_history_insert ON job_architecture_jd_publication_history FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND published_by=app.current_user_id() AND app.job_architecture_can(variant_company_id,'check'));
GRANT SELECT,INSERT ON job_architecture_jd_publication_history TO ai_hr_app;

CREATE FUNCTION app.guard_architecture_jd_publication() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM job_document j JOIN job_document_revision r ON r.job_id=j.id AND r.tenant_id=j.tenant_id WHERE j.tenant_id=NEW.tenant_id AND j.id=NEW.job_id AND r.id=NEW.revision_id AND j.job_unit_id=NEW.job_unit_id AND NEW.variant_company_id IS NOT DISTINCT FROM CASE WHEN j.company_variant THEN j.company_id ELSE NULL END AND NOT j.inactive AND r.status IN('submitted','approved') AND r.architecture->>'jobUnitId'=NEW.job_unit_id::text AND r.approver_id=app.current_user_id() AND NOT app.current_user_id()=ANY(r.contributor_ids) AND r.submitted_by IS DISTINCT FROM app.current_user_id() AND EXISTS(SELECT 1 FROM job_document_review v WHERE v.revision_id=r.id AND v.tenant_id=r.tenant_id) AND NOT EXISTS(SELECT 1 FROM job_document_review v WHERE v.revision_id=r.id AND v.tenant_id=r.tenant_id AND v.decision<>'reviewed')) THEN RAISE EXCEPTION 'Publish only the independently reviewed bound job description'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER architecture_jd_publication_binding BEFORE INSERT OR UPDATE ON job_architecture_jd_publication FOR EACH ROW EXECUTE FUNCTION app.guard_architecture_jd_publication();
CREATE TRIGGER architecture_jd_history_binding BEFORE INSERT ON job_architecture_jd_publication_history FOR EACH ROW EXECUTE FUNCTION app.guard_architecture_jd_publication();
REVOKE ALL ON FUNCTION app.guard_architecture_jd_publication() FROM PUBLIC;

ALTER TABLE job_architecture_outlier ADD COLUMN business_unit_id uuid REFERENCES business_unit(id);
CREATE FUNCTION app.guard_architecture_outlier_bu() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.business_unit_id IS NOT NULL AND (cardinality(NEW.company_ids)<>1 OR NOT EXISTS(SELECT 1 FROM business_unit b WHERE b.id=NEW.business_unit_id AND b.tenant_id=NEW.tenant_id AND b.archived_at IS NULL AND (b.is_global OR EXISTS(SELECT 1 FROM label_company_assignment a WHERE a.tenant_id=b.tenant_id AND a.label_kind='business_unit' AND a.label_id=b.id AND a.company_id=NEW.company_ids[1])))) THEN RAISE EXCEPTION 'Choose a business unit available to the outlier company'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER architecture_outlier_bu BEFORE INSERT OR UPDATE ON job_architecture_outlier FOR EACH ROW EXECUTE FUNCTION app.guard_architecture_outlier_bu();
REVOKE ALL ON FUNCTION app.guard_architecture_outlier_bu() FROM PUBLIC;

CREATE FUNCTION app.guard_architecture_suggestion_history() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF (to_jsonb(NEW)-ARRAY['decision','decided_by','decided_at','proposal_id','payload']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['decision','decided_by','decided_at','proposal_id','payload']) OR OLD.decision<>'pending' OR NEW.decision='pending' THEN RAISE EXCEPTION 'Suggestion source and decision history are immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER architecture_suggestion_history BEFORE UPDATE ON job_architecture_suggestion FOR EACH ROW EXECUTE FUNCTION app.guard_architecture_suggestion_history();
REVOKE ALL ON FUNCTION app.guard_architecture_suggestion_history() FROM PUBLIC;
