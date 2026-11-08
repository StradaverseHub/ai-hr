-- ab44b4a2: NULL retains the legacy All Companies meaning. This changes entry admission,
-- never the calculation or validity of a historical transaction.
ALTER TABLE public.pay_component ADD COLUMN applied_company_ids uuid[];
ALTER TABLE public.pay_component ADD CONSTRAINT pay_component_company_selection CHECK (
 applied_company_ids IS NULL OR (cardinality(applied_company_ids)>0 AND array_ndims(applied_company_ids)=1
 AND array_position(applied_company_ids,NULL) IS NULL));
--> statement-breakpoint
CREATE FUNCTION app.pay_component_company_selection_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,app SET row_security=on AS $$
DECLARE selected_id uuid;
BEGIN
 IF TG_OP='UPDATE' AND NEW.applied_company_ids IS NOT DISTINCT FROM OLD.applied_company_ids THEN RETURN NEW; END IF;
 IF NEW.applied_company_ids IS NOT NULL THEN
  IF cardinality(NEW.applied_company_ids)<>(SELECT count(DISTINCT id) FROM unnest(NEW.applied_company_ids) id) THEN
   RAISE EXCEPTION 'Company selection must not contain duplicates';
  END IF;
  FOR selected_id IN SELECT unnest(NEW.applied_company_ids) ORDER BY 1 LOOP
   PERFORM 1 FROM public.company c WHERE c.id=selected_id AND c.tenant_id=NEW.tenant_id FOR KEY SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Company selection is unavailable'; END IF;
   IF NOT app.is_admin_for(selected_id) THEN RAISE EXCEPTION 'Company administration required'; END IF;
  END LOOP;
 END IF;
 IF TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM public.company c WHERE c.tenant_id=NEW.tenant_id AND NOT app.is_admin_for(c.id)) THEN
  RAISE EXCEPTION 'Whole-catalogue company administration required for applicability changes';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.pay_component_company_selection_guard() FROM PUBLIC;
CREATE TRIGGER pay_component_company_selection_guard BEFORE INSERT OR UPDATE OF applied_company_ids ON public.pay_component
 FOR EACH ROW EXECUTE FUNCTION app.pay_component_company_selection_guard();
--> statement-breakpoint
-- An array reference must retain the same company identity as a relational RESTRICT reference.
CREATE FUNCTION app.pay_component_company_in_use(p_company uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,app SET row_security=on AS $$
 SELECT app.is_admin_for(p_company) AND EXISTS(SELECT 1 FROM public.pay_component p
 WHERE p.tenant_id=app.current_tenant_id() AND p_company=ANY(p.applied_company_ids))
$$;
REVOKE ALL ON FUNCTION app.pay_component_company_in_use(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.pay_component_company_in_use(uuid) TO ai_hr_app;
CREATE FUNCTION app.pay_component_company_delete_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,app SET row_security=on AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.pay_component p WHERE p.tenant_id=OLD.tenant_id AND OLD.id=ANY(p.applied_company_ids)) THEN
  RAISE EXCEPTION 'Company is retained by Pay Item applicability' USING ERRCODE='23503';
 END IF;
 RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION app.pay_component_company_delete_guard() FROM PUBLIC;
CREATE TRIGGER pay_component_company_delete_guard BEFORE DELETE ON public.company
 FOR EACH ROW EXECUTE FUNCTION app.pay_component_company_delete_guard();
