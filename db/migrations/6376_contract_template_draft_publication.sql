-- History publication is for drafts. Earlier published versions remain immutable history; a new draft can copy their wording.
CREATE FUNCTION app.automation_document_draft_publication_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.live_version IS NOT NULL AND NEW.live_version IS DISTINCT FROM OLD.live_version AND EXISTS(
  SELECT 1 FROM public.domain_event e WHERE e.tenant_id=OLD.tenant_id AND e.aggregate_id=OLD.id
  AND e.event_type IN('automation.document.published','automation.document.publishVersion') AND e.payload->>'version'=NEW.live_version::text
 ) THEN RAISE EXCEPTION 'Only a draft version can be published. Copy earlier wording into a new draft.' USING ERRCODE='22023';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.automation_document_draft_publication_guard() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER automation_document_draft_publication_guard BEFORE UPDATE OF live_version ON public.automation_document_template FOR EACH ROW EXECUTE FUNCTION app.automation_document_draft_publication_guard();
