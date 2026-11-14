import type postgres from 'postgres';
import {expect} from 'vitest';
/** The installed role topology for populated upgrade rehearsals, copied verbatim from
 * test/restricted-owner-release-upgrade.test.ts (which keeps its own copy; a test file cannot be imported without
 * registering its cases). Everything the superuser built becomes ai_hr_owner's, purpose-owned objects keep their
 * NOLOGIN owners, and the superuser's emulated default privileges are removed. Disposable databases only. */
export const PROJECT_INSTALLED_OWNERSHIP=`DO $project$
DECLARE source oid:=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user); target text:='ai_hr_owner'; r record;
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

/** Anything still owned by, granted to or defaulted for the connected superuser outside system schemas and extensions. */
export const SUPERUSER_LEFTOVERS=`WITH su AS (SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user),
 userns AS (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname NOT IN ('pg_catalog','information_schema') AND nspname NOT LIKE 'pg\\_%'),
 ext AS (SELECT classid,objid FROM pg_catalog.pg_depend WHERE deptype='e')
SELECT 'schema '||n.nspname AS object FROM pg_catalog.pg_namespace n WHERE n.oid IN (SELECT oid FROM userns) AND n.nspowner=(SELECT oid FROM su)
 AND NOT EXISTS(SELECT 1 FROM ext WHERE classid='pg_catalog.pg_namespace'::regclass AND objid=n.oid)
UNION ALL SELECT 'relation '||c.oid::regclass FROM pg_catalog.pg_class c WHERE c.relnamespace IN (SELECT oid FROM userns) AND c.relowner=(SELECT oid FROM su)
 AND NOT EXISTS(SELECT 1 FROM ext WHERE classid='pg_catalog.pg_class'::regclass AND objid=c.oid)
UNION ALL SELECT 'routine '||p.oid::regprocedure FROM pg_catalog.pg_proc p WHERE p.pronamespace IN (SELECT oid FROM userns) AND p.proowner=(SELECT oid FROM su)
 AND NOT EXISTS(SELECT 1 FROM ext WHERE classid='pg_catalog.pg_proc'::regclass AND objid=p.oid)
UNION ALL SELECT 'type '||t.oid::regtype FROM pg_catalog.pg_type t WHERE t.typnamespace IN (SELECT oid FROM userns) AND t.typowner=(SELECT oid FROM su)
 AND NOT EXISTS(SELECT 1 FROM ext WHERE classid='pg_catalog.pg_type'::regclass AND objid=t.oid)
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_type e JOIN ext ON ext.classid='pg_catalog.pg_type'::regclass AND ext.objid=e.oid WHERE e.typarray=t.oid)
UNION ALL SELECT 'operator '||o.oid::regoperator FROM pg_catalog.pg_operator o WHERE o.oprnamespace IN (SELECT oid FROM userns) AND o.oprowner=(SELECT oid FROM su)
 AND NOT EXISTS(SELECT 1 FROM ext WHERE classid='pg_catalog.pg_operator'::regclass AND objid=o.oid)
UNION ALL SELECT 'operator class '||c.opcname FROM pg_catalog.pg_opclass c WHERE c.opcnamespace IN (SELECT oid FROM userns) AND c.opcowner=(SELECT oid FROM su)
 AND NOT EXISTS(SELECT 1 FROM ext WHERE classid='pg_catalog.pg_opclass'::regclass AND objid=c.oid)
UNION ALL SELECT 'operator family '||f.opfname FROM pg_catalog.pg_opfamily f WHERE f.opfnamespace IN (SELECT oid FROM userns) AND f.opfowner=(SELECT oid FROM su)
 AND NOT EXISTS(SELECT 1 FROM ext WHERE classid='pg_catalog.pg_opfamily'::regclass AND objid=f.oid)
UNION ALL SELECT 'collation '||c.collname FROM pg_catalog.pg_collation c WHERE c.collnamespace IN (SELECT oid FROM userns) AND c.collowner=(SELECT oid FROM su)
 AND NOT EXISTS(SELECT 1 FROM ext WHERE classid='pg_catalog.pg_collation'::regclass AND objid=c.oid)
UNION ALL SELECT 'conversion '||c.conname FROM pg_catalog.pg_conversion c WHERE c.connamespace IN (SELECT oid FROM userns) AND c.conowner=(SELECT oid FROM su)
UNION ALL SELECT 'text search configuration '||c.cfgname FROM pg_catalog.pg_ts_config c WHERE c.cfgnamespace IN (SELECT oid FROM userns) AND c.cfgowner=(SELECT oid FROM su)
UNION ALL SELECT 'text search dictionary '||d.dictname FROM pg_catalog.pg_ts_dict d WHERE d.dictnamespace IN (SELECT oid FROM userns) AND d.dictowner=(SELECT oid FROM su)
UNION ALL SELECT 'statistics '||s.stxname FROM pg_catalog.pg_statistic_ext s WHERE s.stxnamespace IN (SELECT oid FROM userns) AND s.stxowner=(SELECT oid FROM su)
UNION ALL SELECT 'event trigger '||e.evtname FROM pg_catalog.pg_event_trigger e WHERE e.evtowner=(SELECT oid FROM su)
UNION ALL SELECT 'publication '||p.pubname FROM pg_catalog.pg_publication p WHERE p.pubowner=(SELECT oid FROM su)
UNION ALL SELECT 'foreign server '||s.srvname FROM pg_catalog.pg_foreign_server s WHERE s.srvowner=(SELECT oid FROM su)
UNION ALL SELECT 'grant on routine '||p.oid::regprocedure FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a
 WHERE p.pronamespace IN (SELECT oid FROM userns) AND a.grantee=(SELECT oid FROM su) AND p.proowner<>(SELECT oid FROM su)
UNION ALL SELECT 'grant on relation '||c.oid::regclass FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
 WHERE c.relnamespace IN (SELECT oid FROM userns) AND a.grantee=(SELECT oid FROM su) AND c.relowner<>(SELECT oid FROM su)
UNION ALL SELECT 'grant on column '||c.oid::regclass||'.'||att.attname FROM pg_catalog.pg_attribute att JOIN pg_catalog.pg_class c ON c.oid=att.attrelid
 CROSS JOIN LATERAL pg_catalog.aclexplode(att.attacl) a WHERE c.relnamespace IN (SELECT oid FROM userns) AND a.grantee=(SELECT oid FROM su)
UNION ALL SELECT 'grant on schema '||n.nspname FROM pg_catalog.pg_namespace n CROSS JOIN LATERAL pg_catalog.aclexplode(n.nspacl) a
 WHERE n.oid IN (SELECT oid FROM userns) AND a.grantee=(SELECT oid FROM su) AND n.nspowner<>(SELECT oid FROM su)
UNION ALL SELECT 'grant on type '||t.oid::regtype FROM pg_catalog.pg_type t CROSS JOIN LATERAL pg_catalog.aclexplode(t.typacl) a
 WHERE t.typnamespace IN (SELECT oid FROM userns) AND a.grantee=(SELECT oid FROM su) AND t.typowner<>(SELECT oid FROM su)
UNION ALL SELECT 'policy '||pol.polname||' on '||pol.polrelid::regclass FROM pg_catalog.pg_policy pol WHERE (SELECT oid FROM su)=ANY(pol.polroles)
UNION ALL SELECT 'default privileges in '||coalesce(n.nspname,'every schema') FROM pg_catalog.pg_default_acl d LEFT JOIN pg_catalog.pg_namespace n ON n.oid=d.defaclnamespace
 WHERE d.defaclrole=(SELECT oid FROM su)
ORDER BY 1`;

type Keyed=Record<string,unknown>;
const OWNER='ai_hr_owner';
/** The catalogue comparison of test/restricted-owner-release-upgrade.test.ts, copied verbatim: owners, ACLs, row
 * security, policies, triggers, routine bodies and row counts, with the migrating role ($1) shown as ai_hr_owner. */
/** Objects outside system schemas and extensions, keyed by identity, with the migrating role ($1) shown as ai_hr_owner. */
export const USER_SCOPE=(alias:string,namespace:string,catalog:string)=>`${namespace} IN (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname NOT IN ('pg_catalog','information_schema') AND nspname NOT LIKE 'pg\\_%')
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.${catalog}'::regclass AND d.objid=${alias}.oid AND d.deptype='e')`;
const ROLE=(expression:string)=>`CASE WHEN ${expression}=0 THEN 'PUBLIC' WHEN pg_catalog.pg_get_userbyid(${expression})=$1 THEN '${OWNER}' ELSE pg_catalog.pg_get_userbyid(${expression})::text END`;
const ACL=(acl:string)=>`(SELECT coalesce(jsonb_agg(x ORDER BY x::text),'[]'::jsonb) FROM (SELECT DISTINCT jsonb_build_array(${ROLE('a.grantee')},${ROLE('a.grantor')},a.privilege_type,a.is_grantable) x FROM pg_catalog.aclexplode(${acl}) a) acl)`;
export const CATALOGUE:Record<string,string>={
 schemas:`SELECT n.nspname AS key,jsonb_build_object('owner',${ROLE('n.nspowner')},'acl',${ACL(`coalesce(n.nspacl,pg_catalog.acldefault('n',n.nspowner))`)}) AS value
  FROM pg_catalog.pg_namespace n WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_%'
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_namespace'::regclass AND d.objid=n.oid AND d.deptype='e')`,
 relations:`SELECT c.oid::regclass::text AS key,jsonb_build_object('kind',c.relkind,'owner',${ROLE('c.relowner')},'rls',c.relrowsecurity,'force',c.relforcerowsecurity,
   'acl',${ACL(`coalesce(c.relacl,pg_catalog.acldefault((CASE WHEN c.relkind='S' THEN 's' ELSE 'r' END)::"char",c.relowner))`)},
   'view',CASE WHEN c.relkind IN ('v','m') THEN md5(pg_catalog.pg_get_viewdef(c.oid)) END) AS value
  FROM pg_catalog.pg_class c WHERE c.relkind IN ('r','p','v','m','S','f','c') AND ${USER_SCOPE('c','c.relnamespace','pg_class')}`,
 columns:`SELECT c.oid::regclass::text||'.'||att.attname AS key,${ACL('att.attacl')} AS value
  FROM pg_catalog.pg_attribute att JOIN pg_catalog.pg_class c ON c.oid=att.attrelid
  WHERE att.attacl IS NOT NULL AND att.attnum>0 AND NOT att.attisdropped AND ${USER_SCOPE('c','c.relnamespace','pg_class')}`,
 routines:`SELECT p.oid::regprocedure::text AS key,jsonb_build_object('kind',p.prokind,'owner',${ROLE('p.proowner')},'definer',p.prosecdef,'volatility',p.provolatile,
   'config',p.proconfig,'result',pg_catalog.pg_get_function_result(p.oid),'body',md5(p.prosrc),
   'acl',${ACL(`coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))`)}) AS value
  FROM pg_catalog.pg_proc p WHERE ${USER_SCOPE('p','p.pronamespace','pg_proc')}`,
 types:`SELECT t.oid::regtype::text AS key,jsonb_build_object('owner',${ROLE('t.typowner')},'acl',${ACL(`coalesce(t.typacl,pg_catalog.acldefault('T',t.typowner))`)}) AS value
  FROM pg_catalog.pg_type t WHERE t.typtype IN ('b','d','e','r','m') AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_type e WHERE e.typarray=t.oid)
  AND ${USER_SCOPE('t','t.typnamespace','pg_type')}`,
 policies:`SELECT pol.polrelid::regclass::text||'.'||pol.polname AS key,jsonb_build_object('command',pol.polcmd,'permissive',pol.polpermissive,
   'roles',(SELECT jsonb_agg(${ROLE('r.role')} ORDER BY ${ROLE('r.role')}) FROM unnest(pol.polroles) r(role)),
   'using',pg_catalog.pg_get_expr(pol.polqual,pol.polrelid),'check',pg_catalog.pg_get_expr(pol.polwithcheck,pol.polrelid)) AS value
  FROM pg_catalog.pg_policy pol`,
 triggers:`SELECT t.tgrelid::regclass::text||'.'||t.tgname AS key,jsonb_build_object('enabled',t.tgenabled,'definition',pg_catalog.pg_get_triggerdef(t.oid)) AS value
  FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal AND ${USER_SCOPE('c','c.relnamespace','pg_class')}`,
 rows:`SELECT c.oid::regclass::text AS key,(xpath('/row/n/text()',query_to_xml(format('SELECT count(*) AS n FROM %s',c.oid::regclass),false,true,'')))[1]::text AS value
  FROM pg_catalog.pg_class c WHERE c.relkind IN ('r','p') AND ${USER_SCOPE('c','c.relnamespace','pg_class')}`,
};
export async function catalogue(sql:postgres.Sql,superuser:string):Promise<Record<string,Keyed>>{
 const out:Record<string,Keyed>={};
 for(const [kind,query] of Object.entries(CATALOGUE)){
  const rows=await sql.unsafe<{key:string;value:unknown}[]>(query,query.includes('$1')?[superuser]:[]);
  out[kind]=Object.fromEntries(rows.map(row=>[row.key,row.value]));
  expect(rows.length,kind+' has distinct keys').toBe(Object.keys(out[kind]).length);
 }
 return out;
}
export function differences(reference:Record<string,Keyed>,restricted:Record<string,Keyed>):string[]{
 const found:string[]=[];
 for(const kind of Object.keys(CATALOGUE)){
  const a=reference[kind],b=restricted[kind];
  for(const key of [...new Set([...Object.keys(a),...Object.keys(b)])].sort()){
   const left=JSON.stringify(a[key]),right=JSON.stringify(b[key]);
   if(left!==right)found.push(`${kind} ${key}: superuser ${left??'absent'}; ${OWNER} ${right??'absent'}`);
  }
 }
 return found;
}
