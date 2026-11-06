-- Retire the Job Architecture entry points without changing saved records or the Rewards reader.
--> statement-breakpoint
DROP TRIGGER employment_architecture_grade ON employment;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.job_document_scope(p_tenant uuid,p_job uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT p_tenant=app.current_tenant_id() AND EXISTS(SELECT 1 FROM job_document j WHERE j.tenant_id=p_tenant AND j.id=p_job AND app.access_workforce_company(j.company_id,'workforce.view'))
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.job_document_reviewer_eligible(p_company uuid,p_user uuid) RETURNS boolean
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
CREATE OR REPLACE FUNCTION app.guard_job_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.status<>'draft' OR OLD.version<>1 THEN RAISE EXCEPTION 'Only an unused initial draft may be deleted'; END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'draft' OR NEW.prepared_by IS DISTINCT FROM app.current_user_id() OR NEW.last_edited_by IS DISTINCT FROM app.current_user_id() THEN RAISE EXCEPTION 'Create a draft as the authenticated preparer'; END IF;
  NEW.contributor_ids:=ARRAY[app.current_user_id()];
  NEW.contributor_person_ids:=ARRAY(SELECT person_id FROM app_user WHERE id=app.current_user_id() AND tenant_id=NEW.tenant_id AND person_id IS NOT NULL);
  RETURN NEW;
 END IF;
 IF OLD.status='approved' THEN
  RAISE EXCEPTION 'Approved revisions are immutable';
 END IF;
 IF OLD.status='superseded' THEN RAISE EXCEPTION 'Superseded revisions are immutable'; END IF;
 IF NEW.tenant_id<>OLD.tenant_id OR NEW.job_id<>OLD.job_id OR NEW.id<>OLD.id OR NEW.version<>OLD.version OR NEW.prepared_by<>OLD.prepared_by OR NEW.definition<>OLD.definition THEN RAISE EXCEPTION 'Revision identity and form snapshot are immutable'; END IF;
 IF NEW.lock_version<>OLD.lock_version+1 THEN RAISE EXCEPTION 'Stale revision'; END IF;
 IF OLD.status='submitted' AND (NEW.architecture IS DISTINCT FROM OLD.architecture OR NEW.title<>OLD.title OR NEW.org<>OLD.org OR NEW.org_labels<>OLD.org_labels OR NEW.answers<>OLD.answers OR NEW.document_owner<>OLD.document_owner OR NEW.effective_on IS DISTINCT FROM OLD.effective_on OR NEW.review_on IS DISTINCT FROM OLD.review_on OR NEW.reason<>OLD.reason OR NEW.approver_id IS DISTINCT FROM OLD.approver_id OR NEW.last_edited_by<>OLD.last_edited_by) THEN RAISE EXCEPTION 'Return the document before editing'; END IF;
 IF OLD.status='draft' THEN
  NEW.contributor_ids:=ARRAY(SELECT DISTINCT unnest(OLD.contributor_ids || ARRAY[app.current_user_id()]));
  NEW.contributor_person_ids:=ARRAY(SELECT DISTINCT unnest(OLD.contributor_person_ids||ARRAY(SELECT person_id FROM app_user WHERE id=app.current_user_id() AND tenant_id=NEW.tenant_id AND person_id IS NOT NULL)));
 ELSE NEW.contributor_ids:=OLD.contributor_ids;NEW.contributor_person_ids:=OLD.contributor_person_ids; END IF;
 IF NEW.status='approved' THEN
  IF EXISTS(SELECT 1 FROM unnest(OLD.contributor_ids) actor WHERE app.same_known_person_as_current_user(actor,NULL)) OR EXISTS(SELECT 1 FROM app_user actor WHERE actor.id=app.current_user_id() AND actor.tenant_id=OLD.tenant_id AND actor.person_id=ANY(OLD.contributor_person_ids)) OR OLD.status<>'submitted' OR NEW.approver_id IS DISTINCT FROM app.current_user_id() OR NEW.approved_by IS DISTINCT FROM app.current_user_id() OR NEW.approved_by=ANY(OLD.contributor_ids) OR NEW.approved_by=OLD.submitted_by OR NOT EXISTS(SELECT 1 FROM job_document_review WHERE revision_id=OLD.id) OR EXISTS(SELECT 1 FROM job_document_review WHERE revision_id=OLD.id AND decision<>'reviewed') THEN RAISE EXCEPTION 'An independent named approver and completed reviews are required'; END IF;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
DROP POLICY job_document_architecture_read ON job_document;
--> statement-breakpoint
DROP POLICY job_document_architecture_insert ON job_document;
--> statement-breakpoint
DROP POLICY job_document_architecture_update ON job_document;
--> statement-breakpoint
DROP POLICY job_document_revision_architecture_write ON job_document_revision;
--> statement-breakpoint
DROP POLICY job_document_form_architecture_read ON job_document_form;
--> statement-breakpoint
DROP POLICY job_document_form_architecture_insert ON job_document_form;
--> statement-breakpoint
DROP POLICY job_document_review_architecture_write ON job_document_review;
--> statement-breakpoint
DROP POLICY job_document_attachment_architecture_write ON job_document_attachment;
--> statement-breakpoint
DROP POLICY job_document_audit_architecture_insert ON job_document_audit;
--> statement-breakpoint
REVOKE INSERT, UPDATE ON
  job_architecture_seat, job_architecture_proposal, job_architecture_outlier,
  job_architecture_jd_publication, job_architecture_suggestion, job_architecture_import_preview
FROM ai_hr_app;
--> statement-breakpoint
REVOKE INSERT ON
  job_architecture_catalogue_revision, job_architecture_position_revision,
  job_architecture_jd_publication_history
FROM ai_hr_app;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION app.own_job_architecture_description(uuid) FROM ai_hr_app;
