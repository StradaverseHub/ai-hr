-- Approved 83fd4d82: durable future-company scope, checked unused deletion and historical archive.
ALTER TABLE public.attendance_workflow_template ADD COLUMN all_companies boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.attendance_workflow_companies(wanted uuid) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET row_security=on AS $$
 SELECT CASE WHEN t.all_companies THEN ARRAY(SELECT c.id FROM public.company c WHERE c.tenant_id=t.tenant_id ORDER BY c.id)
 ELSE ARRAY(SELECT a.company_id FROM public.attendance_workflow_company a WHERE a.template_id=t.id AND a.tenant_id=t.tenant_id ORDER BY a.company_id) END
 FROM public.attendance_workflow_template t WHERE t.id=wanted AND t.tenant_id=app.current_tenant_id()
$$;
CREATE OR REPLACE FUNCTION app.attendance_workflow_applies(wanted uuid,wanted_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET row_security=on AS $$
 SELECT EXISTS(SELECT 1 FROM public.attendance_workflow_template t JOIN public.company c ON c.id=wanted_company AND c.tenant_id=t.tenant_id
 WHERE t.id=wanted AND t.tenant_id=app.current_tenant_id() AND (t.all_companies OR EXISTS(SELECT 1 FROM public.attendance_workflow_company a WHERE a.template_id=t.id AND a.tenant_id=t.tenant_id AND a.company_id=c.id)))
$$;
CREATE OR REPLACE FUNCTION app.attendance_workflow_all_companies_admin(wanted uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET row_security=on AS $$
 SELECT app.principal_snapshot_current() AND EXISTS(SELECT 1 FROM public.attendance_workflow_template t WHERE t.id=wanted AND t.tenant_id=app.current_tenant_id()
 AND CASE WHEN t.all_companies THEN app.is_admin_for(NULL::uuid) ELSE EXISTS(SELECT 1 FROM public.attendance_workflow_company a WHERE a.template_id=t.id AND a.tenant_id=t.tenant_id)
 AND NOT EXISTS(SELECT 1 FROM public.attendance_workflow_company a WHERE a.template_id=t.id AND a.tenant_id=t.tenant_id AND NOT app.is_admin_for(a.company_id)) END)
$$;
--> statement-breakpoint
-- The global lock is first in both paths: shared submissions, exclusive configuration mutations.
-- A future company has no assignment row to lock, so company-only locks are insufficient.
CREATE FUNCTION app.attendance_workflow_scope_lock() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET row_security=on AS $$
BEGIN
 IF TG_TABLE_NAME='attendance_workflow_request' THEN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.tenant_id::text||':attendance-workflow-scope:'||NEW.application_type,0));
 ELSE
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text||':attendance-workflow-scope:'||NEW.application_type,0));
  IF NEW.all_companies AND (NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NOT app.principal_snapshot_current() OR NOT app.is_admin_for(NULL::uuid)) THEN RAISE EXCEPTION 'All Company requires organisation-wide administration' USING ERRCODE='42501';END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.attendance_workflow_scope_lock() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER a_attendance_workflow_scope_lock BEFORE INSERT ON public.attendance_workflow_request FOR EACH ROW EXECUTE FUNCTION app.attendance_workflow_scope_lock();
CREATE TRIGGER a_attendance_workflow_scope_lock BEFORE INSERT OR UPDATE ON public.attendance_workflow_template FOR EACH ROW EXECUTE FUNCTION app.attendance_workflow_scope_lock();
--> statement-breakpoint
-- Finite, transaction-local authority for deleting only an unused workflow lineage.
CREATE TABLE app.attendance_workflow_delete_intent(tx bigint NOT NULL,template_id uuid NOT NULL,tenant_id uuid NOT NULL,user_id uuid NOT NULL,PRIMARY KEY(tx,template_id));
REVOKE ALL ON app.attendance_workflow_delete_intent FROM PUBLIC,ai_hr_app;
ALTER TABLE app.attendance_workflow_delete_intent ENABLE ROW LEVEL SECURITY;
CREATE POLICY attendance_workflow_delete_intent_owner ON app.attendance_workflow_delete_intent FOR ALL TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
CREATE FUNCTION app.attendance_workflow_unused_delete_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET row_security=on AS $$
DECLARE wanted uuid;
BEGIN
 IF TG_TABLE_NAME='attendance_workflow_template' THEN wanted:=OLD.id;ELSE wanted:=OLD.template_id;END IF;
 IF TG_OP<>'DELETE' OR NOT app.principal_snapshot_current() OR NOT EXISTS(SELECT 1 FROM app.attendance_workflow_delete_intent i WHERE i.tx=txid_current() AND i.template_id=wanted AND i.tenant_id=OLD.tenant_id AND i.user_id=app.current_user_id()) THEN RAISE EXCEPTION 'Workflow history cannot be deleted';END IF;
 IF EXISTS(SELECT 1 FROM public.attendance_workflow_request w WHERE w.template_id=wanted AND w.tenant_id=OLD.tenant_id) THEN RAISE EXCEPTION 'Used workflows must be archived' USING ERRCODE='P5101';END IF;
 RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION app.attendance_workflow_unused_delete_guard() FROM PUBLIC,ai_hr_app;
DROP TRIGGER attendance_workflow_template_immutable ON public.attendance_workflow_template;
CREATE TRIGGER attendance_workflow_template_immutable BEFORE UPDATE ON public.attendance_workflow_template FOR EACH ROW EXECUTE FUNCTION app.attendance_workflow_immutable();
CREATE TRIGGER attendance_workflow_template_unused_delete BEFORE DELETE ON public.attendance_workflow_template FOR EACH ROW EXECUTE FUNCTION app.attendance_workflow_unused_delete_guard();
DROP TRIGGER attendance_workflow_company_immutable ON public.attendance_workflow_company;
CREATE TRIGGER attendance_workflow_company_immutable BEFORE UPDATE ON public.attendance_workflow_company FOR EACH ROW EXECUTE FUNCTION app.payroll_history_immutable();
CREATE TRIGGER attendance_workflow_company_unused_delete BEFORE DELETE ON public.attendance_workflow_company FOR EACH ROW EXECUTE FUNCTION app.attendance_workflow_unused_delete_guard();
REVOKE DELETE ON public.attendance_workflow_template,public.attendance_workflow_company FROM ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.attendance_workflow_retirement_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET row_security=on AS $$
BEGIN
 IF NEW.retired_at IS DISTINCT FROM OLD.retired_at THEN
  IF OLD.retired_at IS NOT NULL OR OLD.superseded_at IS NOT NULL OR NEW.retired_at IS NULL OR NEW.superseded_at IS NULL OR NOT app.principal_snapshot_current() OR NOT app.attendance_workflow_all_companies_admin(OLD.id) THEN RAISE EXCEPTION 'A current workflow and its complete administrative scope are required to archive configuration';END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(OLD.tenant_id::text||':attendance-workflow-scope:'||OLD.application_type,0));
 END IF;
 IF OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at THEN RAISE EXCEPTION 'Retained workflow versions cannot be reopened or rewritten';END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.attendance_workflow_remove(wanted_lineage uuid,expected_version integer,archive boolean) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET row_security=on AS $$
DECLARE current_template public.attendance_workflow_template;history public.attendance_workflow_template;used boolean;
BEGIN
 IF NOT app.principal_snapshot_current() OR archive IS NULL THEN RAISE EXCEPTION 'A current administrator identity is required' USING ERRCODE='42501';END IF;
 SELECT t.* INTO current_template FROM public.attendance_workflow_template t WHERE t.lineage_id=wanted_lineage AND t.tenant_id=app.current_tenant_id() AND t.superseded_at IS NULL;
 IF NOT FOUND OR NOT app.attendance_workflow_all_companies_admin(current_template.id) THEN RAISE EXCEPTION 'The workflow is no longer available' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(current_template.tenant_id::text||':attendance-workflow-scope:'||current_template.application_type,0));
 PERFORM pg_advisory_xact_lock(hashtextextended(current_template.tenant_id::text||':attendance-workflow-lineage:'||wanted_lineage::text,0));
 SELECT t.* INTO current_template FROM public.attendance_workflow_template t WHERE t.id=current_template.id AND t.tenant_id=app.current_tenant_id() FOR UPDATE;
 IF current_template.superseded_at IS NOT NULL OR current_template.version IS DISTINCT FROM expected_version THEN RAISE EXCEPTION 'The workflow changed; reload' USING ERRCODE='P5102';END IF;
 -- Check the entire code/lineage history, not only pending requests or the newest definition.
 SELECT EXISTS(SELECT 1 FROM public.attendance_workflow_request w JOIN public.attendance_workflow_template t ON t.id=w.template_id AND t.tenant_id=w.tenant_id WHERE t.lineage_id=wanted_lineage AND w.tenant_id=app.current_tenant_id()) INTO used;
 IF NOT archive AND used THEN RAISE EXCEPTION 'This workflow has already been used by approval transactions and cannot be deleted. Please archive it instead.' USING ERRCODE='P5101';END IF;
 IF archive THEN
  UPDATE public.attendance_workflow_template SET superseded_at=clock_timestamp(),retired_at=clock_timestamp() WHERE id=current_template.id AND tenant_id=current_template.tenant_id;
 ELSE
  FOR history IN SELECT t.* FROM public.attendance_workflow_template t WHERE t.lineage_id=wanted_lineage AND t.tenant_id=app.current_tenant_id() ORDER BY t.version FOR UPDATE LOOP
   IF NOT app.attendance_workflow_all_companies_admin(history.id) THEN RAISE EXCEPTION 'All historical company assignments require administration' USING ERRCODE='42501';END IF;
   INSERT INTO app.attendance_workflow_delete_intent VALUES(txid_current(),history.id,history.tenant_id,app.current_user_id());
  END LOOP;
  DELETE FROM public.attendance_workflow_company a USING app.attendance_workflow_delete_intent i WHERE i.tx=txid_current() AND i.template_id=a.template_id AND i.tenant_id=a.tenant_id AND i.user_id=app.current_user_id();
  DELETE FROM public.attendance_workflow_template t USING app.attendance_workflow_delete_intent i WHERE i.tx=txid_current() AND i.template_id=t.id AND i.tenant_id=t.tenant_id AND i.user_id=app.current_user_id();
  DELETE FROM app.attendance_workflow_delete_intent WHERE tx=txid_current() AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id();
 END IF;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
 VALUES(current_template.tenant_id,'attendance-workflow-template',wanted_lineage,CASE WHEN archive THEN 'attendance-workflow-template.archived' ELSE 'attendance-workflow-template.deleted' END,'user',app.current_user_id(),jsonb_build_object('companyId',current_template.company_id,'templateId',current_template.id,'version',expected_version,'name',current_template.name));
 RETURN current_template.id;
END $$;
REVOKE ALL ON FUNCTION app.attendance_workflow_remove(uuid,integer,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.attendance_workflow_remove(uuid,integer,boolean) TO ai_hr_app;
-- Old callers must use the same checked deletion semantics; no retained-deleted configuration path.
CREATE OR REPLACE FUNCTION app.attendance_workflow_retire(wanted_lineage uuid,expected_version integer) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET row_security=on AS $$SELECT app.attendance_workflow_remove(wanted_lineage,expected_version,false)$$;

--> statement-breakpoint
-- A globally active definition carries the global administrator's future-company intent.
-- Initialise only absent routing switches; never override a deliberate company/type opt-out.
CREATE FUNCTION app.attendance_workflow_global_setting() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET row_security=on AS $$
BEGIN
 IF TG_TABLE_NAME='company' THEN
  -- Hold both application-type barriers before reading definitions. The order is fixed;
  -- ordinary workflow writers take only their one type barrier and never the other.
  -- This VOLATILE trigger's INSERT/SELECT obtains a fresh READ COMMITTED snapshot after
  -- a waited-on writer commits, so neither first-definition/first-company commit order
  -- can miss the other's newly committed row. These locks live through company commit.
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text||':attendance-workflow-scope:irregularity',0));
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text||':attendance-workflow-scope:self_overtime',0));
  INSERT INTO public.attendance_workflow_setting(tenant_id,company_id,application_type,enabled)
   SELECT NEW.tenant_id,NEW.id,t.application_type,true FROM public.attendance_workflow_template t
   WHERE t.tenant_id=NEW.tenant_id AND t.all_companies AND t.active AND t.superseded_at IS NULL AND t.retired_at IS NULL
   GROUP BY t.application_type ON CONFLICT(tenant_id,company_id,application_type) DO NOTHING;
 ELSIF NEW.all_companies AND NEW.active THEN
  INSERT INTO public.attendance_workflow_setting(tenant_id,company_id,application_type,enabled)
   SELECT NEW.tenant_id,c.id,NEW.application_type,true FROM public.company c WHERE c.tenant_id=NEW.tenant_id
   ON CONFLICT(tenant_id,company_id,application_type) DO NOTHING;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.attendance_workflow_global_setting() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER attendance_workflow_global_setting AFTER INSERT ON public.attendance_workflow_template FOR EACH ROW EXECUTE FUNCTION app.attendance_workflow_global_setting();
CREATE TRIGGER attendance_workflow_global_setting AFTER INSERT ON public.company FOR EACH ROW EXECUTE FUNCTION app.attendance_workflow_global_setting();
