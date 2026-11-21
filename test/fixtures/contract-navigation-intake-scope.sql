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

 SELECT p.prosrc,pg_catalog.pg_get_functiondef(p.oid) INTO source,definition
 FROM pg_catalog.pg_proc p
 JOIN pg_catalog.pg_roles owner_role ON owner_role.oid=p.proowner
 WHERE p.oid='app.automation_can_configure(text)'::regprocedure
   AND owner_role.rolname=current_user AND NOT owner_role.rolsuper AND NOT owner_role.rolbypassrls;
 IF encode(sha256(convert_to(source,'UTF8')),'hex') IS DISTINCT FROM
  'b0bb6d4e2743d83d6ab14ee757555fbfd6707db0bb82ff0b8505a44484a434fc' THEN
  RAISE EXCEPTION 'Unexpected shared automation configuration predecessor or owner';
 END IF;
 definition:=replace(definition,$old$WHEN 'contract_staff' THEN app.contract_verified_human$old$,$candidate$
 WHEN 'contract_staff' THEN CASE WHEN (
   EXISTS (SELECT 1 FROM public.role_assignment r WHERE r.tenant_id=app.current_tenant_id()
    AND r.app_user_id=app.current_user_id() AND r.role::text IN ('hr_admin','super_admin'))
   OR EXISTS (SELECT 1 FROM public.contract_role_assignment r WHERE r.tenant_id=app.current_tenant_id()
    AND r.user_id=app.current_user_id() AND r.role='gbs')
   OR EXISTS (SELECT 1 FROM public.contract_access_member m
    JOIN public.contract_access_role r ON r.tenant_id=m.tenant_id AND r.id=m.role_id
    WHERE m.tenant_id=app.current_tenant_id() AND m.user_id=app.current_user_id()
      AND r.permissions && ARRAY['workflows','templates','groups']::text[])
 ) THEN app.contract_verified_human$candidate$);
 definition:=replace(definition,$old$WHEN 'off' THEN$old$,$candidate$ELSE false END
 WHEN 'off' THEN$candidate$);
 EXECUTE definition;
END
$proof$;
