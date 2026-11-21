-- Test-only comparison under the installed owner.
DO $proof$
DECLARE source text; definition text;
BEGIN
 SELECT p.prosrc,pg_catalog.pg_get_functiondef(p.oid) INTO source,definition
 FROM pg_catalog.pg_proc p
 JOIN pg_catalog.pg_roles owner_role ON owner_role.oid=p.proowner
 WHERE p.oid='app.contract_shared_navigation_access()'::regprocedure
   AND owner_role.rolname=current_user AND NOT owner_role.rolsuper AND NOT owner_role.rolbypassrls;
 IF encode(sha256(convert_to(source,'UTF8')),'hex') IS DISTINCT FROM
  'b6aa90640d3ce45dc2fb1135af3008d7dc297090071ca8ff7534bb18624e288c' THEN
  RAISE EXCEPTION 'Unexpected Contract navigation predecessor or owner';
 END IF;
 definition:=replace(definition,' WITH legacy AS MATERIALIZED',$candidate$
 WITH intake_companies AS MATERIALIZED (
  SELECT DISTINCT a.company_id FROM public.contract_role_assignment a
  WHERE a.tenant_id=app.current_tenant_id() AND a.user_id=app.current_user_id()
    AND a.role IN ('gbs','pbp')
 ), legacy AS MATERIALIZED$candidate$);
 definition:=replace(definition,
  'SELECT 1 FROM public.company co WHERE co.tenant_id=app.current_tenant_id() AND co.archived_at IS NULL AND app.contract_company_entitled(co.id)',
  'SELECT 1 FROM intake_companies candidate JOIN public.company co ON co.id=candidate.company_id WHERE co.tenant_id=app.current_tenant_id() AND co.archived_at IS NULL AND app.contract_company_entitled(co.id)');
 EXECUTE definition;
END
$proof$;
