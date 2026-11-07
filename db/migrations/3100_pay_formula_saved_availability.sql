-- Approved feedback a6e02303: saved immutable revisions are immediately available.
-- Keep the original activation events and successful test receipts as optional history.
CREATE FUNCTION app.pay_formula_saved(p_code text) RETURNS TABLE(id uuid,code text,revision_id uuid,ordinal integer,program jsonb,content_hash text,dependencies jsonb,test_id uuid,dependency_fingerprint text,evaluator_version text,registry_version text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app SET row_security=off AS $$
 SELECT f.id,f.formula_id,r.id,r.ordinal,r.program,r.content_hash,r.dependencies,
   NULL::uuid,NULL::text,r.dependency_snapshot->>'evaluator',r.dependency_snapshot->>'registry'
 FROM public.pay_formula f
 JOIN LATERAL(SELECT rev.* FROM public.pay_formula_revision rev WHERE rev.formula_id=f.id AND rev.tenant_id=f.tenant_id ORDER BY rev.ordinal DESC LIMIT 1) r ON true
 WHERE f.tenant_id=app.current_tenant_id() AND f.formula_id=p_code
   AND app.pay_formula_definition_read()
   AND NOT EXISTS(SELECT 1 FROM public.pay_formula_event e WHERE e.formula_id=f.id AND e.tenant_id=f.tenant_id AND e.kind='deleted')
$$;
REVOKE ALL ON FUNCTION app.pay_formula_saved(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.pay_formula_saved(text) TO ai_hr_app;
--> statement-breakpoint
-- Compatibility for older callers; a separate successful test is no longer authority to link.
CREATE OR REPLACE FUNCTION app.pay_formula_active(p_code text) RETURNS TABLE(id uuid,code text,revision_id uuid,ordinal integer,program jsonb,content_hash text,dependencies jsonb,test_id uuid,dependency_fingerprint text,evaluator_version text,registry_version text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app SET row_security=off AS $$
 SELECT * FROM app.pay_formula_saved(p_code)
$$;
CREATE OR REPLACE FUNCTION app.pay_formula_bind_pay_item() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE a record;
BEGIN
 IF NEW.rule->>'kind'='formula_builder' AND (TG_OP='INSERT' OR NEW.rule IS DISTINCT FROM OLD.rule) THEN
  SELECT * INTO a FROM app.pay_formula_saved(NEW.rule->>'formulaId');
  IF a.id IS NULL OR NEW.rule->'dependencies' IS DISTINCT FROM a.dependencies THEN RAISE EXCEPTION 'A saved formula and its recorded dependencies are required'; END IF;
 END IF;
 RETURN NEW;
END $$;
