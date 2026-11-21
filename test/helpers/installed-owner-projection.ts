/** Canonical test-only installed-ownership projection, extracted byte-for-byte from the restricted-owner rehearsal.
 * No execution at import, role provisioning, permission expansion or production use. */
const OWNER='ai_hr_owner';
export const PROJECT_INSTALLED_OWNERSHIP=`DO $project$
DECLARE source oid:=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user); target text:='${OWNER}'; r record;
BEGIN
 FOR r IN SELECT n.nspname FROM pg_catalog.pg_namespace n WHERE n.nspowner=source
  AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_%'
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_namespace'::regclass AND d.objid=n.oid AND d.deptype='e')
 LOOP EXECUTE format('ALTER SCHEMA %I OWNER TO %I',r.nspname,target); END LOOP;
 FOR r IN SELECT c.oid,c.relkind FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE c.relowner=source AND c.relkind IN ('r','p','v','m','f')
  AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_%'
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_class'::regclass AND d.objid=c.oid AND d.deptype='e')
 LOOP EXECUTE format('ALTER %s %s OWNER TO %I',CASE r.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END,r.oid::regclass,target); END LOOP;
 -- Sequences a column owns followed their table above.
 FOR r IN SELECT c.oid FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE c.relowner=source AND c.relkind='S'
  AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_%'
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_class'::regclass AND d.objid=c.oid AND d.deptype='e')
 LOOP EXECUTE format('ALTER SEQUENCE %s OWNER TO %I',r.oid::regclass,target); END LOOP;
 FOR r IN SELECT p.oid,p.prokind FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
  WHERE p.proowner=source
  AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_%'
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')
 LOOP EXECUTE format('ALTER %s %s OWNER TO %I',CASE r.prokind WHEN 'a' THEN 'AGGREGATE' WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END,r.oid::regprocedure,target); END LOOP;
 -- Enums, domains, ranges and standalone composites; array and table row types follow their owners.
 FOR r IN SELECT t.oid,t.typtype FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace
  WHERE t.typowner=source AND t.typtype IN ('b','c','d','e','r')
  AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_%'
  AND NOT (t.typtype='c' AND EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid=t.typrelid AND c.relkind<>'c'))
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_type e WHERE e.typarray=t.oid)
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_type'::regclass AND d.objid=t.oid AND d.deptype='e')
 LOOP EXECUTE format('ALTER %s %s OWNER TO %I',CASE r.typtype WHEN 'd' THEN 'DOMAIN' ELSE 'TYPE' END,r.oid::regtype,target); END LOOP;
 FOR r IN SELECT p.oid,a.privilege_type,a.is_grantable FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
  CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a
  WHERE p.proowner<>source AND a.grantee=source AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_%'
 LOOP
  EXECUTE format('GRANT %s ON ROUTINE %s TO %I%s',r.privilege_type,r.oid::regprocedure,target,CASE WHEN r.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
  EXECUTE format('REVOKE %s ON ROUTINE %s FROM %I',r.privilege_type,r.oid::regprocedure,current_user);
 END LOOP;
 FOR r IN SELECT c.oid,c.relkind,a.privilege_type,a.is_grantable FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
  WHERE c.relowner<>source AND a.grantee=source AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_%'
 LOOP
  EXECUTE format('GRANT %s ON %s %s TO %I%s',r.privilege_type,CASE r.relkind WHEN 'S' THEN 'SEQUENCE' ELSE 'TABLE' END,r.oid::regclass,target,CASE WHEN r.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
  EXECUTE format('REVOKE %s ON %s %s FROM %I',r.privilege_type,CASE r.relkind WHEN 'S' THEN 'SEQUENCE' ELSE 'TABLE' END,r.oid::regclass,current_user);
 END LOOP;
 FOR r IN SELECT c.oid,att.attname,a.privilege_type,a.is_grantable FROM pg_catalog.pg_attribute att JOIN pg_catalog.pg_class c ON c.oid=att.attrelid
  JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL pg_catalog.aclexplode(att.attacl) a
  WHERE c.relowner<>source AND a.grantee=source AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_%'
 LOOP
  EXECUTE format('GRANT %s (%I) ON TABLE %s TO %I%s',r.privilege_type,r.attname,r.oid::regclass,target,CASE WHEN r.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
  EXECUTE format('REVOKE %s (%I) ON TABLE %s FROM %I',r.privilege_type,r.attname,r.oid::regclass,current_user);
 END LOOP;
 FOR r IN SELECT n.nspname,a.privilege_type,a.is_grantable FROM pg_catalog.pg_namespace n CROSS JOIN LATERAL pg_catalog.aclexplode(n.nspacl) a
  WHERE n.nspowner<>source AND a.grantee=source AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_%'
 LOOP
  EXECUTE format('GRANT %s ON SCHEMA %I TO %I%s',r.privilege_type,r.nspname,target,CASE WHEN r.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
  EXECUTE format('REVOKE %s ON SCHEMA %I FROM %I',r.privilege_type,r.nspname,current_user);
 END LOOP;
 FOR r IN SELECT t.oid,t.typtype,a.privilege_type,a.is_grantable FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace
  CROSS JOIN LATERAL pg_catalog.aclexplode(t.typacl) a
  WHERE t.typowner<>source AND a.grantee=source AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_%'
 LOOP
  EXECUTE format('GRANT %s ON %s %s TO %I%s',r.privilege_type,CASE r.typtype WHEN 'd' THEN 'DOMAIN' ELSE 'TYPE' END,r.oid::regtype,target,CASE WHEN r.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
  EXECUTE format('REVOKE %s ON %s %s FROM %I',r.privilege_type,CASE r.typtype WHEN 'd' THEN 'DOMAIN' ELSE 'TYPE' END,r.oid::regtype,current_user);
 END LOOP;
 -- Policies a migration addressed to its own role (storage-owner and retention policies on forced tables).
 FOR r IN SELECT pol.polname,pol.polrelid,(SELECT string_agg(CASE WHEN x=0 THEN 'PUBLIC' WHEN x=source THEN quote_ident(target)
   ELSE quote_ident(pg_catalog.pg_get_userbyid(x)) END,',') FROM unnest(pol.polroles) x) AS roles
  FROM pg_catalog.pg_policy pol WHERE source=ANY(pol.polroles)
 LOOP EXECUTE format('ALTER POLICY %I ON %s TO %s',r.polname,r.polrelid::regclass,r.roles); END LOOP;
 EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM ai_hr_app',current_user);
 EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE USAGE, SELECT ON SEQUENCES FROM ai_hr_app',current_user);
END $project$`;
