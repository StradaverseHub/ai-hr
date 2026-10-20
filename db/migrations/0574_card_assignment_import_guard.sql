-- Card IDs remain employment.card_id. The probe returns no hidden holder information.
-- Serialize every identifier writer, not only the workbook: a concurrent Personnel edit must
-- not introduce a card/code/IC collision between preview and confirmation.
CREATE FUNCTION app.card_identifier_free(p_employment uuid, p_card text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.employment target
   WHERE target.id=p_employment AND target.tenant_id=app.current_tenant_id()
   AND app.is_admin_for(target.company_id))
 AND NOT EXISTS(SELECT 1 FROM public.employment e
   LEFT JOIN public.employee_statutory_my s ON s.person_id=e.person_id AND s.tenant_id=e.tenant_id
   WHERE e.tenant_id=app.current_tenant_id() AND e.id<>p_employment
   AND (lower(btrim(e.card_id))=lower(btrim(p_card)) OR (e.terminated_on IS NULL AND
    (lower(btrim(e.employee_code))=lower(btrim(p_card)) OR
     (regexp_replace(p_card,'[^0-9]','','g')<>'' AND regexp_replace(coalesce(s.ic_number,''),'[^0-9]','','g')=regexp_replace(p_card,'[^0-9]','','g'))))))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.card_identifier_free(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.card_identifier_free(uuid,text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.guard_card_identifiers() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE changed_card boolean; changed_code boolean;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text||':card-identifiers',0));
 IF TG_TABLE_NAME='employment' THEN
  changed_card := TG_OP='INSERT'; changed_code := TG_OP='INSERT';
  IF TG_OP='UPDATE' THEN
   changed_card := NEW.card_id IS DISTINCT FROM OLD.card_id OR (NEW.terminated_on IS NULL AND OLD.terminated_on IS NOT NULL);
   changed_code := NEW.employee_code IS DISTINCT FROM OLD.employee_code OR (NEW.terminated_on IS NULL AND OLD.terminated_on IS NOT NULL);
  END IF;
  IF changed_card AND NEW.card_id IS NOT NULL AND EXISTS(
   SELECT 1 FROM public.employment e LEFT JOIN public.employee_statutory_my s ON s.person_id=e.person_id AND s.tenant_id=e.tenant_id
   WHERE e.tenant_id=NEW.tenant_id AND e.id<>NEW.id AND
   (lower(btrim(e.card_id))=lower(btrim(NEW.card_id)) OR (e.terminated_on IS NULL AND
    (lower(btrim(e.employee_code))=lower(btrim(NEW.card_id)) OR
     (regexp_replace(NEW.card_id,'[^0-9]','','g')<>'' AND regexp_replace(coalesce(s.ic_number,''),'[^0-9]','','g')=regexp_replace(NEW.card_id,'[^0-9]','','g'))))))
  THEN RAISE EXCEPTION 'Card identifier conflicts with another employment' USING ERRCODE='23505'; END IF;
  IF changed_code AND NEW.terminated_on IS NULL AND NEW.employee_code IS NOT NULL AND EXISTS(
   SELECT 1 FROM public.employment e WHERE e.tenant_id=NEW.tenant_id AND e.id<>NEW.id
   AND e.terminated_on IS NULL AND lower(btrim(e.card_id))=lower(btrim(NEW.employee_code)))
  THEN RAISE EXCEPTION 'Employee identifier conflicts with an assigned card' USING ERRCODE='23505'; END IF;
  IF changed_code AND NEW.terminated_on IS NULL AND EXISTS(
   SELECT 1 FROM public.employee_statutory_my s JOIN public.employment e ON e.tenant_id=s.tenant_id
   WHERE s.tenant_id=NEW.tenant_id AND s.person_id=NEW.person_id AND e.id<>NEW.id AND e.terminated_on IS NULL
   AND regexp_replace(coalesce(s.ic_number,''),'[^0-9]','','g')<>''
   AND regexp_replace(e.card_id,'[^0-9]','','g')=regexp_replace(s.ic_number,'[^0-9]','','g'))
  THEN RAISE EXCEPTION 'Identity identifier conflicts with an assigned card' USING ERRCODE='23505'; END IF;
 ELSE
  IF TG_OP='UPDATE' AND NEW.ic_number IS NOT DISTINCT FROM OLD.ic_number THEN RETURN NEW; END IF;
  IF regexp_replace(coalesce(NEW.ic_number,''),'[^0-9]','','g')<>'' AND EXISTS(
   SELECT 1 FROM public.employment e WHERE e.tenant_id=NEW.tenant_id
   AND (e.person_id<>NEW.person_id OR EXISTS(SELECT 1 FROM public.employment other WHERE other.tenant_id=NEW.tenant_id AND other.person_id=NEW.person_id AND other.id<>e.id AND other.terminated_on IS NULL))
   AND e.terminated_on IS NULL AND regexp_replace(e.card_id,'[^0-9]','','g')=regexp_replace(NEW.ic_number,'[^0-9]','','g'))
  THEN RAISE EXCEPTION 'Identity identifier conflicts with an assigned card' USING ERRCODE='23505'; END IF;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.guard_card_identifiers() FROM PUBLIC;
CREATE TRIGGER employment_card_identifier_guard BEFORE INSERT OR UPDATE OF card_id, employee_code, terminated_on ON public.employment FOR EACH ROW EXECUTE FUNCTION app.guard_card_identifiers();
CREATE TRIGGER statutory_card_identifier_guard BEFORE INSERT OR UPDATE OF ic_number ON public.employee_statutory_my FOR EACH ROW EXECUTE FUNCTION app.guard_card_identifiers();
