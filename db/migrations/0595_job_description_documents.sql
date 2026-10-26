-- Job documentation owner. All functions are invoker rights; company scope is enforced on every node.
CREATE TABLE job_document (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id),
 company_id uuid NOT NULL REFERENCES company(id), job_code text NOT NULL, normalized_code text NOT NULL,
 inactive boolean NOT NULL DEFAULT false, created_by uuid NOT NULL REFERENCES app_user(id),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,company_id,normalized_code), UNIQUE(tenant_id,id),
 CHECK(length(job_code) BETWEEN 1 AND 80), CHECK(length(normalized_code) BETWEEN 1 AND 160)
);
--> statement-breakpoint
CREATE TABLE job_document_form (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id),
 company_id uuid NOT NULL REFERENCES company(id), version integer NOT NULL CHECK(version>0), definition jsonb NOT NULL,
 created_by uuid NOT NULL REFERENCES app_user(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,company_id,version), UNIQUE(tenant_id,id), CHECK(jsonb_typeof(definition)='object')
);
--> statement-breakpoint
CREATE TABLE job_document_revision (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id), job_id uuid NOT NULL,
 version integer NOT NULL CHECK(version>0), status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','submitted','approved')),
 lock_version integer NOT NULL DEFAULT 1, title text NOT NULL, document_owner text NOT NULL DEFAULT '',
 org jsonb NOT NULL DEFAULT '{}', org_labels jsonb NOT NULL DEFAULT '{}', answers jsonb NOT NULL DEFAULT '{}', definition jsonb NOT NULL,
 business_unit_id uuid GENERATED ALWAYS AS (nullif(org->>'businessUnit','')::uuid) STORED REFERENCES business_unit(id),
 department_id uuid GENERATED ALWAYS AS (nullif(org->>'department','')::uuid) STORED REFERENCES department(id),
 position_id uuid GENERATED ALWAYS AS (nullif(org->>'position','')::uuid) STORED REFERENCES position(id),
 grade_id uuid GENERATED ALWAYS AS (nullif(org->>'grade','')::uuid) STORED REFERENCES job_grade(id),
 location_id uuid GENERATED ALWAYS AS (nullif(org->>'location','')::uuid) STORED REFERENCES location(id),
 reports_to_position_id uuid GENERATED ALWAYS AS (nullif(org->>'reportsTo','')::uuid) STORED REFERENCES position(id),
 effective_on date, review_on date, reason text NOT NULL DEFAULT '', approver_id uuid REFERENCES app_user(id),
 prepared_by uuid NOT NULL REFERENCES app_user(id), last_edited_by uuid NOT NULL REFERENCES app_user(id), contributor_ids uuid[] NOT NULL DEFAULT '{}',
 submitted_by uuid REFERENCES app_user(id), submitted_at timestamptz, approved_by uuid REFERENCES app_user(id), approved_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,job_id) REFERENCES job_document(tenant_id,id) ON DELETE CASCADE,
 UNIQUE(tenant_id,id), UNIQUE(job_id,version), CHECK(length(title) BETWEEN 1 AND 200),
 CHECK(review_on IS NULL OR effective_on IS NULL OR review_on>=effective_on),
 CHECK(status<>'approved' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL AND effective_on IS NOT NULL AND review_on IS NOT NULL AND approved_by<>prepared_by AND approved_by<>last_edited_by AND approved_by<>submitted_by))
);
--> statement-breakpoint
CREATE UNIQUE INDEX job_document_one_working_revision ON job_document_revision(job_id) WHERE status<>'approved';
--> statement-breakpoint
CREATE TABLE job_document_review (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),revision_id uuid NOT NULL,
 reviewer_id uuid NOT NULL REFERENCES app_user(id), decision text NOT NULL DEFAULT 'pending' CHECK(decision IN ('pending','reviewed','returned')),
 comments text NOT NULL DEFAULT '', decided_at timestamptz,
 FOREIGN KEY(tenant_id,revision_id) REFERENCES job_document_revision(tenant_id,id) ON DELETE CASCADE,
 UNIQUE(revision_id,reviewer_id), CHECK(length(comments)<=4000)
);
--> statement-breakpoint
CREATE TABLE job_document_attachment (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),revision_id uuid NOT NULL,
 filename text NOT NULL CHECK(length(filename) BETWEEN 1 AND 180),mime_type text NOT NULL CHECK(mime_type IN ('application/pdf','text/plain','image/png','image/jpeg','application/vnd.openxmlformats-officedocument.wordprocessingml.document')),
 content bytea NOT NULL CHECK(octet_length(content) BETWEEN 1 AND 2097152), created_by uuid NOT NULL REFERENCES app_user(id),created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,revision_id) REFERENCES job_document_revision(tenant_id,id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE job_document_audit (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),job_id uuid NOT NULL,
 revision_id uuid,action text NOT NULL,actor_id uuid NOT NULL REFERENCES app_user(id),before_value jsonb,after_value jsonb,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,job_id) REFERENCES job_document(tenant_id,id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX job_document_company_idx ON job_document(tenant_id,company_id,updated_at);
--> statement-breakpoint
CREATE FUNCTION app.job_document_scope(p_tenant uuid,p_job uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT p_tenant=app.current_tenant_id() AND EXISTS(SELECT 1 FROM job_document j WHERE j.tenant_id=p_tenant AND j.id=p_job AND app.access_workforce_company(j.company_id,'workforce.view'))
$$;
--> statement-breakpoint
CREATE FUNCTION app.job_revision_scope(p_tenant uuid,p_revision uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT p_tenant=app.current_tenant_id() AND EXISTS(SELECT 1 FROM job_document_revision r WHERE r.tenant_id=p_tenant AND r.id=p_revision AND app.job_document_scope(r.tenant_id,r.job_id))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.job_document_scope(uuid,uuid),app.job_revision_scope(uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.job_document_scope(uuid,uuid),app.job_revision_scope(uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
ALTER TABLE job_document ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE job_document FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY job_document_read ON job_document FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.access_workforce_company(company_id,'workforce.view'));
--> statement-breakpoint
CREATE POLICY job_document_insert ON job_document FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.access_workforce_company(company_id,'workforce.maintain') AND created_by=app.current_user_id());
--> statement-breakpoint
CREATE POLICY job_document_update ON job_document FOR UPDATE USING(tenant_id=app.current_tenant_id() AND app.access_workforce_company(company_id,'workforce.maintain')) WITH CHECK(tenant_id=app.current_tenant_id() AND app.access_workforce_company(company_id,'workforce.maintain'));
--> statement-breakpoint
CREATE POLICY job_document_delete ON job_document FOR DELETE USING(tenant_id=app.current_tenant_id() AND app.access_workforce_company(company_id,'workforce.maintain'));
--> statement-breakpoint
ALTER TABLE job_document_form ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE job_document_form FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY job_document_form_scope ON job_document_form FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.access_workforce_company(company_id,'workforce.view'));
--> statement-breakpoint
CREATE POLICY job_document_form_insert ON job_document_form FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.access_workforce_company(company_id,'workforce.maintain') AND app.access_configuration_not_denied() AND created_by=app.current_user_id());
--> statement-breakpoint
ALTER TABLE job_document_revision ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE job_document_revision FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY job_document_revision_read ON job_document_revision FOR SELECT USING(app.job_document_scope(tenant_id,job_id));
--> statement-breakpoint
CREATE POLICY job_document_revision_write ON job_document_revision FOR ALL USING(app.job_document_scope(tenant_id,job_id) AND EXISTS(SELECT 1 FROM job_document j WHERE j.id=job_id AND j.tenant_id=job_document_revision.tenant_id AND app.access_workforce_company(j.company_id,'workforce.maintain'))) WITH CHECK(app.job_document_scope(tenant_id,job_id) AND EXISTS(SELECT 1 FROM job_document j WHERE j.id=job_id AND j.tenant_id=job_document_revision.tenant_id AND app.access_workforce_company(j.company_id,'workforce.maintain')));
--> statement-breakpoint
ALTER TABLE job_document_review ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE job_document_review FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY job_document_review_read ON job_document_review FOR SELECT USING(app.job_revision_scope(tenant_id,revision_id));
--> statement-breakpoint
CREATE POLICY job_document_review_write ON job_document_review FOR ALL USING(app.job_revision_scope(tenant_id,revision_id) AND EXISTS(SELECT 1 FROM job_document j WHERE j.id=(select job_id from job_document_revision where id=job_document_review.revision_id) AND j.tenant_id=job_document_review.tenant_id AND app.access_workforce_company(j.company_id,'workforce.maintain'))) WITH CHECK(app.job_revision_scope(tenant_id,revision_id) AND EXISTS(SELECT 1 FROM job_document j WHERE j.id=(select job_id from job_document_revision where id=job_document_review.revision_id) AND j.tenant_id=job_document_review.tenant_id AND app.access_workforce_company(j.company_id,'workforce.maintain')));
--> statement-breakpoint
ALTER TABLE job_document_attachment ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE job_document_attachment FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY job_document_attachment_read ON job_document_attachment FOR SELECT USING(app.job_revision_scope(tenant_id,revision_id));
--> statement-breakpoint
CREATE POLICY job_document_attachment_write ON job_document_attachment FOR ALL USING(app.job_revision_scope(tenant_id,revision_id) AND EXISTS(SELECT 1 FROM job_document j WHERE j.id=(select job_id from job_document_revision where id=job_document_attachment.revision_id) AND j.tenant_id=job_document_attachment.tenant_id AND app.access_workforce_company(j.company_id,'workforce.maintain'))) WITH CHECK(app.job_revision_scope(tenant_id,revision_id) AND EXISTS(SELECT 1 FROM job_document j WHERE j.id=(select job_id from job_document_revision where id=job_document_attachment.revision_id) AND j.tenant_id=job_document_attachment.tenant_id AND app.access_workforce_company(j.company_id,'workforce.maintain')));
--> statement-breakpoint
ALTER TABLE job_document_audit ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE job_document_audit FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY job_document_audit_read ON job_document_audit FOR SELECT USING(app.job_document_scope(tenant_id,job_id));
--> statement-breakpoint
CREATE POLICY job_document_audit_insert ON job_document_audit FOR INSERT WITH CHECK(app.job_document_scope(tenant_id,job_id) AND actor_id=app.current_user_id() AND EXISTS(SELECT 1 FROM job_document j WHERE j.id=job_id AND j.tenant_id=job_document_audit.tenant_id AND app.access_workforce_company(j.company_id,'workforce.maintain')));
--> statement-breakpoint
CREATE FUNCTION app.guard_job_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
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
 IF OLD.status='approved' THEN RAISE EXCEPTION 'Approved revisions are immutable'; END IF;
 IF NEW.tenant_id<>OLD.tenant_id OR NEW.job_id<>OLD.job_id OR NEW.id<>OLD.id OR NEW.version<>OLD.version OR NEW.prepared_by<>OLD.prepared_by OR NEW.definition<>OLD.definition THEN RAISE EXCEPTION 'Revision identity and form snapshot are immutable'; END IF;
 IF NEW.lock_version<>OLD.lock_version+1 THEN RAISE EXCEPTION 'Stale revision'; END IF;
 IF OLD.status='submitted' AND (NEW.title<>OLD.title OR NEW.org<>OLD.org OR NEW.org_labels<>OLD.org_labels OR NEW.answers<>OLD.answers OR NEW.document_owner<>OLD.document_owner OR NEW.effective_on IS DISTINCT FROM OLD.effective_on OR NEW.review_on IS DISTINCT FROM OLD.review_on OR NEW.reason<>OLD.reason OR NEW.approver_id IS DISTINCT FROM OLD.approver_id OR NEW.last_edited_by<>OLD.last_edited_by) THEN RAISE EXCEPTION 'Return the document before editing'; END IF;
 IF OLD.status='draft' THEN
  NEW.contributor_ids:=ARRAY(SELECT DISTINCT unnest(OLD.contributor_ids || ARRAY[app.current_user_id()]));
 ELSE NEW.contributor_ids:=OLD.contributor_ids; END IF;
 IF NEW.status='approved' THEN
  IF OLD.status<>'submitted' OR NEW.approver_id IS DISTINCT FROM app.current_user_id() OR NEW.approved_by IS DISTINCT FROM app.current_user_id() OR NEW.approved_by=ANY(OLD.contributor_ids) OR NEW.approved_by=OLD.submitted_by OR NOT EXISTS(SELECT 1 FROM job_document_review WHERE revision_id=OLD.id) OR EXISTS(SELECT 1 FROM job_document_review WHERE revision_id=OLD.id AND decision<>'reviewed') THEN RAISE EXCEPTION 'An independent named approver and completed reviews are required'; END IF;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER job_revision_guard BEFORE INSERT OR UPDATE OR DELETE ON job_document_revision FOR EACH ROW EXECUTE FUNCTION app.guard_job_revision();
--> statement-breakpoint
CREATE FUNCTION app.guard_job_children() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE r job_document_revision;
BEGIN
 SELECT * INTO r FROM job_document_revision WHERE id=COALESCE(NEW.revision_id,OLD.revision_id) FOR UPDATE;
 IF NOT FOUND THEN RETURN COALESCE(NEW,OLD); END IF;
 IF r.status='approved' THEN RAISE EXCEPTION 'Approved revision history is immutable'; END IF;
 IF TG_TABLE_NAME='job_document_attachment' AND r.status<>'draft' THEN RAISE EXCEPTION 'Attachments may change only in draft'; END IF;
 IF TG_TABLE_NAME='job_document_review' THEN
  IF TG_OP='UPDATE' THEN
   IF r.status<>'submitted' OR NEW.reviewer_id<>OLD.reviewer_id OR NEW.revision_id<>OLD.revision_id OR NEW.tenant_id<>OLD.tenant_id OR NEW.reviewer_id<>app.current_user_id() OR NEW.reviewer_id=ANY(r.contributor_ids) OR NEW.reviewer_id=r.submitted_by THEN RAISE EXCEPTION 'Only the named independent reviewer may decide'; END IF;
  ELSIF r.status<>'draft' THEN RAISE EXCEPTION 'Review assignments may change only in draft'; END IF;
 END IF;
 RETURN COALESCE(NEW,OLD);
END $$;
--> statement-breakpoint
CREATE TRIGGER job_review_guard BEFORE INSERT OR UPDATE OR DELETE ON job_document_review FOR EACH ROW EXECUTE FUNCTION app.guard_job_children();
--> statement-breakpoint
CREATE TRIGGER job_attachment_guard BEFORE INSERT OR UPDATE OR DELETE ON job_document_attachment FOR EACH ROW EXECUTE FUNCTION app.guard_job_children();
--> statement-breakpoint
CREATE FUNCTION app.guard_job_master() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM job_document_revision WHERE job_id=OLD.id AND (status<>'draft' OR version<>1 OR submitted_at IS NOT NULL)) OR EXISTS(SELECT 1 FROM job_document_attachment a JOIN job_document_revision r ON r.id=a.revision_id WHERE r.job_id=OLD.id) THEN RAISE EXCEPTION 'Only unused initial drafts may be deleted'; END IF;
  RETURN OLD;
 END IF;
 IF NEW.tenant_id<>OLD.tenant_id OR NEW.company_id<>OLD.company_id OR NEW.job_code<>OLD.job_code OR NEW.normalized_code<>OLD.normalized_code OR NEW.created_by<>OLD.created_by THEN RAISE EXCEPTION 'Job identity is immutable'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER job_master_guard BEFORE UPDATE OR DELETE ON job_document FOR EACH ROW EXECUTE FUNCTION app.guard_job_master();
--> statement-breakpoint
REVOKE ALL ON job_document,job_document_form,job_document_revision,job_document_review,job_document_attachment,job_document_audit FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE,DELETE ON job_document,job_document_revision,job_document_review,job_document_attachment TO ai_hr_app;
--> statement-breakpoint
GRANT SELECT,INSERT ON job_document_form,job_document_audit TO ai_hr_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.guard_job_revision(),app.guard_job_children(),app.guard_job_master() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Narrow metadata seam: an HR document maintainer may check one named reviewer in that exact company.
-- No document bytes or security configuration is returned; arbitrary-company callers fail closed.
CREATE FUNCTION app.job_document_reviewer_eligible(p_company uuid,p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.current_user_id() IS NOT NULL AND app.principal_snapshot_current()
  AND app.access_workforce_company(p_company,'workforce.maintain')
  AND EXISTS(SELECT 1 FROM public.company co JOIN public.app_user u ON u.tenant_id=co.tenant_id
   JOIN public.role_assignment ra ON ra.tenant_id=u.tenant_id AND ra.app_user_id=u.id
   JOIN public.access_capability cap ON cap.id='workforce.maintain'
   WHERE co.id=p_company AND co.tenant_id=app.current_tenant_id() AND u.id=p_user
    AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
    AND ra.role::text IN ('hr_admin','super_admin') AND app.access_scope_covers(ra.company_id,co.id,co.tenant_id)
    AND (NOT cap.supported OR app.access_allowed_for(u.id,cap.id,co.id)));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.job_document_reviewer_eligible(uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.job_document_reviewer_eligible(uuid,uuid) TO ai_hr_app;
