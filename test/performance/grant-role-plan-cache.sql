-- Reuse the SQL expression plan, never a decision, caller or input value.
CREATE OR REPLACE FUNCTION app.grants_have_role_for(grants jsonb,wanted_role text,wanted_company uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
 RETURN (
SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(grants,'[]'::jsonb)) g
 WHERE g->>'role'=wanted_role AND (g->>'companyId' IS NULL OR (g->>'companyId')::uuid=wanted_company OR app.is_company_descendant(wanted_company,(g->>'companyId')::uuid)))
 );
END;
$$;
