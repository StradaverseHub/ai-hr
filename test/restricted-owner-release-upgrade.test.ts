/** Restricted-owner upgrade rehearsal of every migration above main.
 *
 * Installations apply migrations with `pnpm db:migrate` as ai_hr_owner (deploy/bootstrap-db.sql: a LOGIN that is
 * NOSUPERUSER, NOCREATEDB and NOCREATEROLE and owns the database), never as the superuser that builds every other
 * test database. A superuser-only rehearsal cannot see a statement the owner may not run: staging refused 5010 with
 * "must be owner of function reward_uploaded_snapshot_roster" although every CI run had passed.
 *
 * This test builds main's exact ordered prefix, populates one fictional tenant with the prefix-seed helper, and gives
 * a copy the installed role topology: the database, its schemas and every object the prefix created belong to
 * ai_hr_owner; the purpose-owned definers keep their NOLOGIN owner roles (ai_hr_reward_setup_reader and the others)
 * and grants; the bootstrap grants and default privileges hold; and the installation DBA's Rewards prerequisite
 * (deploy/runner-control/rewards-deletion-role-prerequisite.sql) is applied verbatim. The CI cluster's ai_hr_owner is
 * the restricted login and holds only the operator-provisioned SET-only draft-discard edge, so it is a member of no
 * purpose role, as on staging. Every migration above main is then applied through the stock engine, in one
 * transaction, by the literal ai_hr_owner login, as deploy/deploy.sh does.
 *
 * A superuser-applied twin of the same populated baseline is the reference. The restricted run must succeed, raise no
 * privilege warning, change no purpose-owned object or role membership, and leave the same catalogue (owners, ACLs,
 * row security, policies, triggers, function and view bodies, with the migrating role's name normalised) and the same
 * row counts as the reference. That catches a refused statement (ownership, ALTER on another role's table, CREATE in a
 * schema the owner may not use, role or extension changes) and a silently different one (a GRANT the owner may not
 * give, a backfill row security hides from it). When the restricted run is refused, every refusing migration is
 * listed, not only the first.
 *
 * The bootstrap's SET-only downgrade edge (ai_hr_app to ai_hr_owner) is a cluster-wide membership that the CI role
 * fixture does not hold; no release statement switches role, so it does not change this rehearsal. Disposable
 * databases only; nothing here touches an installation. */
import {createHash,randomUUID} from 'node:crypto';
import {copyFileSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import postgres from 'postgres';
import {getTableName} from 'drizzle-orm';
import {drizzle} from 'drizzle-orm/postgres-js';
import {migrate} from 'drizzle-orm/postgres-js/migrator';
import type {PgTable} from 'drizzle-orm/pg-core';
import {afterAll,expect,it} from 'vitest';
import * as schema from '../db/schema';
import {createDb} from '../db/client';
import {hireEmployee} from '../core/org';
import {closeAll,entitledCtx,owner,resetDb,seedBase,setModule} from './harness';
import {copyTenantRowsAtPrefix} from './helpers/prefix-seed';

type Entry={idx:number;version:string;when:number;tag:string;breakpoints:boolean};
type Notice={severity:string;code:string;message:string};
type Keyed=Record<string,unknown>;
const OWNER='ai_hr_owner';
/** Main (6a21b7382, the installed staging and production source) ends its journal here. */
const MAIN_PREFIX=729;
const MAIN_LAST:Entry={idx:4200,version:'7',when:1793330004500,tag:'4800_ai_shared_leave_groups_read',breakpoints:true};
/** Release definers that read the staged-row tables but belong to purpose roles, as installed (2205, 2208, 4100). */
const PURPOSE_OWNED_READERS:Record<string,string>={
 'app.reward_uploaded_snapshot_roster(uuid,date)':'ai_hr_reward_setup_reader',
 'app.reward_create_planned_unit_bound(uuid,uuid,uuid)':'ai_hr_reward_setup_reader',
 'app.reward_setup_grade_choices()':'ai_hr_reward_setup_reader',
 'app.reward_uploaded_validation(uuid)':'ai_hr_reward_upload_reader',
};
/** SQLSTATE 01006 privilege_not_revoked and 01007 privilege_not_granted: a GRANT or REVOKE that did nothing. */
const PRIVILEGE_WARNINGS=new Set(['01006','01007']);
const sha256=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');

afterAll(closeAll);

/** Everything the prefix created as the superuser becomes ai_hr_owner's, as if ai_hr_owner had run it; grants the
 * superuser held on purpose-owned objects (for example 0859's EXECUTE to the ledger owner) move to ai_hr_owner; the
 * superuser's emulated default privileges are removed. Extension members and system schemas are left alone. */
const PROJECT_INSTALLED_OWNERSHIP=`DO $project$
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

/** Anything still owned by, granted to or defaulted for the connected superuser outside system schemas and extensions. */
const SUPERUSER_LEFTOVERS=`WITH su AS (SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user),
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

/** Objects outside system schemas and extensions, keyed by identity, with the migrating role ($1) shown as ai_hr_owner. */
const USER_SCOPE=(alias:string,namespace:string,catalog:string)=>`${namespace} IN (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname NOT IN ('pg_catalog','information_schema') AND nspname NOT LIKE 'pg\\_%')
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.${catalog}'::regclass AND d.objid=${alias}.oid AND d.deptype='e')`;
const ROLE=(expression:string)=>`CASE WHEN ${expression}=0 THEN 'PUBLIC' WHEN pg_catalog.pg_get_userbyid(${expression})=$1 THEN '${OWNER}' ELSE pg_catalog.pg_get_userbyid(${expression})::text END`;
const ACL=(acl:string)=>`(SELECT coalesce(jsonb_agg(x ORDER BY x::text),'[]'::jsonb) FROM (SELECT DISTINCT jsonb_build_array(${ROLE('a.grantee')},${ROLE('a.grantor')},a.privilege_type,a.is_grantable) x FROM pg_catalog.aclexplode(${acl}) a) acl)`;
const CATALOGUE:Record<string,string>={
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
async function catalogue(sql:postgres.Sql,superuser:string):Promise<Record<string,Keyed>>{
 const out:Record<string,Keyed>={};
 for(const [kind,query] of Object.entries(CATALOGUE)){
  const rows=await sql.unsafe<{key:string;value:unknown}[]>(query,query.includes('$1')?[superuser]:[]);
  out[kind]=Object.fromEntries(rows.map(row=>[row.key,row.value]));
  expect(rows.length,kind+' has distinct keys').toBe(Object.keys(out[kind]).length);
 }
 return out;
}
function differences(reference:Record<string,Keyed>,restricted:Record<string,Keyed>):string[]{
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
/** Every object owned by a role other than ai_hr_owner and the superuser: the purpose-owned definers and their grants. */
const purposeOwned=async(sql:postgres.Sql,superuser:string)=>[...await sql.unsafe<{key:string;owner:string;definer:boolean;config:string[]|null;body:string;acl:string|null}[]>(
 `SELECT p.oid::regprocedure::text AS key,pg_catalog.pg_get_userbyid(p.proowner)::text AS owner,p.prosecdef AS definer,p.proconfig AS config,
   md5(p.prosrc) AS body,p.proacl::text AS acl
  FROM pg_catalog.pg_proc p WHERE pg_catalog.pg_get_userbyid(p.proowner) NOT IN ($1,'${OWNER}') AND ${USER_SCOPE('p','p.pronamespace','pg_proc')}
  UNION ALL SELECT c.oid::regclass::text,pg_catalog.pg_get_userbyid(c.relowner)::text,false,NULL,c.relkind::text,c.relacl::text
  FROM pg_catalog.pg_class c WHERE pg_catalog.pg_get_userbyid(c.relowner) NOT IN ($1,'${OWNER}') AND ${USER_SCOPE('c','c.relnamespace','pg_class')}
  ORDER BY 1`,[superuser])];
const ownerRoleGraph=async(sql:postgres.Sql)=>[...await sql.unsafe<Keyed[]>(`SELECT r.rolname::text AS role,m.rolname::text AS member,a.inherit_option AS inherit,a.set_option AS "set",a.admin_option AS admin
 FROM pg_catalog.pg_auth_members a JOIN pg_catalog.pg_roles r ON r.oid=a.roleid JOIN pg_catalog.pg_roles m ON m.oid=a.member
 WHERE r.rolname='${OWNER}' OR m.rolname='${OWNER}' ORDER BY 1,2`)];
const ownerAttributes=async(sql:postgres.Sql)=>[...await sql.unsafe<Keyed[]>(`SELECT rolcanlogin AS login,rolinherit AS inherit,rolsuper AS super,rolcreatedb AS createdb,
 rolcreaterole AS createrole,rolreplication AS replication,rolbypassrls AS bypassrls FROM pg_catalog.pg_roles WHERE rolname='${OWNER}'`)];
const ledger=async(sql:postgres.Sql)=>[...await sql.unsafe<{hash:string;created_at:string}[]>('SELECT hash,created_at::text AS created_at FROM drizzle.__drizzle_migrations ORDER BY id')];
const leftovers=async(sql:postgres.Sql)=>[...await sql.unsafe<{object:string}[]>(SUPERUSER_LEFTOVERS)].map(row=>row.object);
const describeRefusal=(tag:string,error:unknown)=>{
 const cause=(error as {cause?:{code?:string;message?:string}}).cause??(error as {code?:string;message?:string});
 return `${tag}: ${cause.code??'?'} ${cause.message??String(error)}`;
};

it('applies every migration above main as the restricted ai_hr_owner login on the installed role topology, matching a superuser twin',async()=>{
 const journal=JSON.parse(readFileSync('db/migrations/meta/_journal.json','utf8')) as {entries:Entry[]};
 expect(journal.entries[MAIN_PREFIX-1]).toEqual(MAIN_LAST);
 const prefix=journal.entries.slice(0,MAIN_PREFIX),release=journal.entries.slice(MAIN_PREFIX);
 expect(release.length,'the release adds migrations above main').toBeGreaterThan(0);
 for(const entry of release)expect(entry.when,entry.tag+' sits above the installed watermark').toBeGreaterThan(MAIN_LAST.when);
 const expectedLedger=journal.entries.map(entry=>({hash:sha256(readFileSync(`db/migrations/${entry.tag}.sql`)),created_at:String(entry.when)}));

 const base=new URL(process.env.TEST_MIGRATION_DATABASE_URL!);
 expect(['127.0.0.1','localhost']).toContain(base.hostname);expect(base.username).not.toBe(OWNER);expect(base.username).not.toBe('ai_hr_app');
 const at=(database:string,user?:string)=>{const url=new URL(base);url.pathname='/'+database;if(user){url.username=user;url.password='';}return url.toString();};
 const id=randomUUID().replaceAll('-',''),names={baseline:'ai_hr_owner_rehearsal_base_'+id,reference:'ai_hr_owner_rehearsal_ref_'+id,
  restricted:'ai_hr_owner_rehearsal_owner_'+id,diagnosis:'ai_hr_owner_rehearsal_diag_'+id};
 const admin=postgres(at('postgres'),{max:1,onnotice:()=>{}});
 const folder=mkdtempSync(join(tmpdir(),'aihr-restricted-owner-'));mkdirSync(join(folder,'meta'));
 const open:postgres.Sql[]=[];
 const connect=(url:string,notices?:Notice[])=>{
  const sql=postgres(url,{max:1,connect_timeout:10,onnotice:notice=>{notices?.push({severity:String(notice.severity),code:String(notice.code),message:String(notice.message)});}});
  open.push(sql);return sql;
 };
 const close=async(sql:postgres.Sql)=>{await sql.end({timeout:5});open.splice(open.indexOf(sql),1);};
 try{
  const [cluster]=await admin.unsafe<{superuser:string;super:boolean;version:number}[]>(`SELECT current_user::text AS superuser,
   (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname=current_user) AS super,current_setting('server_version_num')::int AS version`);
  expect(cluster.super,'the fixture builder is the cluster superuser').toBe(true);expect(cluster.version).toBeGreaterThanOrEqual(160000);
  const superuser=cluster.superuser;
  // The CI cluster's migration owner is the bootstrap's restricted login (test/helpers/personnel-draft-discard-ci-role-fixture.ts).
  expect(await ownerAttributes(admin)).toEqual([{login:true,inherit:true,super:false,createdb:false,createrole:false,replication:false,bypassrls:false}]);

  // 1. Main's exact prefix, as the superuser, with the bootstrap's grants and default privileges (deploy/bootstrap-db.sql).
  await admin.unsafe(`CREATE DATABASE "${names.baseline}"`);
  const baseline=connect(at(names.baseline));
  await baseline.unsafe(`GRANT USAGE ON SCHEMA public TO ai_hr_app;
   ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ai_hr_app;
   ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER} IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ai_hr_app;
   ALTER DEFAULT PRIVILEGES FOR ROLE "${superuser}" IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ai_hr_app;
   ALTER DEFAULT PRIVILEGES FOR ROLE "${superuser}" IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ai_hr_app;
   DO $platform$ BEGIN IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='ai_hr_platform') THEN GRANT USAGE ON SCHEMA public TO ai_hr_platform; END IF; END $platform$;`);
  for(const entry of journal.entries)copyFileSync(`db/migrations/${entry.tag}.sql`,join(folder,`${entry.tag}.sql`));
  writeFileSync(join(folder,'meta/_journal.json'),JSON.stringify({...journal,entries:prefix}));
  await migrate(drizzle(baseline),{migrationsFolder:folder});
  expect(await ledger(baseline)).toEqual(expectedLedger.slice(0,MAIN_PREFIX));

  // 2. One populated fictional tenant, created by the real services and copied at the prefix (test/helpers/prefix-seed.ts).
  await resetDb();const b=await seedBase();await setModule(b.tenantId,'payroll','active');const ctx=await entitledCtx(b);
  await hireEmployee(ctx,{person:{fullName:'Fictional restricted-owner employee',primaryEmail:randomUUID()+'@restricted-owner.test'},
   companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',employeeCode:'OWNER-001',hiredOn:'2025-01-01'});
  const target=createDb(at(names.baseline),{max:1});
  try{
   const tables:PgTable[]=[schema.tenant,schema.company,schema.department,schema.position,schema.costCenter,schema.leaveType,
    schema.person,schema.appUser,schema.roleAssignment,schema.employment,schema.assignment];
   const copied:Record<string,number>={};
   for(const table of tables)copied[getTableName(table)]=await copyTenantRowsAtPrefix(owner,target,table,b.tenantId);
   for(const name of ['tenant','company','person','app_user','role_assignment','employment','assignment'])expect(copied[name],name+' rows copied').toBeGreaterThan(0);
  }finally{await target.client.end({timeout:5});}
  await close(baseline);

  // 3. Two copies of the populated prefix: the superuser reference, and the installed ownership for ai_hr_owner.
  await admin.unsafe(`CREATE DATABASE "${names.reference}" TEMPLATE "${names.baseline}"`);
  await admin.unsafe(`CREATE DATABASE "${names.restricted}" TEMPLATE "${names.baseline}" OWNER ${OWNER}`);
  const observer=connect(at(names.restricted));
  await observer.unsafe(`GRANT CONNECT ON DATABASE "${names.restricted}" TO ai_hr_app`);
  await observer.unsafe(PROJECT_INSTALLED_OWNERSHIP);
  await observer.unsafe(readFileSync('deploy/runner-control/rewards-deletion-role-prerequisite.sql','utf8'));
  expect(await leftovers(observer),'installed ownership: nothing is left to the superuser').toEqual([]);
  const [database]=await observer.unsafe<{owner:string;app:string;drizzle:string;ledger:string}[]>(`SELECT
   (SELECT pg_catalog.pg_get_userbyid(datdba) FROM pg_catalog.pg_database WHERE datname=current_database())::text AS owner,
   pg_catalog.pg_get_userbyid((SELECT nspowner FROM pg_catalog.pg_namespace WHERE nspname='app'))::text AS app,
   pg_catalog.pg_get_userbyid((SELECT nspowner FROM pg_catalog.pg_namespace WHERE nspname='drizzle'))::text AS drizzle,
   pg_catalog.pg_get_userbyid((SELECT relowner FROM pg_catalog.pg_class WHERE oid='drizzle.__drizzle_migrations'::regclass))::text AS ledger`);
  expect(database).toEqual({owner:OWNER,app:OWNER,drizzle:OWNER,ledger:OWNER});
  const purposeBefore=await purposeOwned(observer,superuser);
  for(const [signature,role] of Object.entries(PURPOSE_OWNED_READERS))expect(purposeBefore.find(row=>row.key===signature)?.owner,signature).toBe(role);
  const purposeRoles=[...new Set(purposeBefore.map(row=>row.owner))].sort();
  expect(purposeRoles).toEqual(expect.arrayContaining(['ai_hr_reward_setup_reader','ai_hr_reward_upload_reader']));
  // As on staging: the migration owner is a member of no purpose role. Its only membership is the operator's
  // SET-only draft-discard edge, which lets 0859/0946's guarded transfer switch to that one owner.
  const graphBefore=await ownerRoleGraph(observer);
  expect(graphBefore.filter(edge=>edge.member===OWNER&&edge.role!=='ai_hr_draft_discard_port'&&edge.role!=='ai_hr_app')).toEqual([]);
  for(const edge of graphBefore.filter(edge=>edge.member===OWNER))expect(edge).toMatchObject({inherit:false,set:true,admin:false});
  for(const role of purposeRoles.filter(role=>role!=='ai_hr_draft_discard_port')){
   const [membership]=await observer.unsafe<{member:boolean}[]>(`SELECT pg_catalog.pg_has_role('${OWNER}',$1,'MEMBER') AS member`,[role]);
   expect(membership.member,`${OWNER} is not a member of ${role}`).toBe(false);
  }

  // 4. The reference: the same populated prefix upgraded by the superuser, as every other CI database is.
  const referenceNotices:Notice[]=[];
  const reference=connect(at(names.reference),referenceNotices);
  await reference.unsafe(`GRANT EXECUTE ON FUNCTION app.reward_setup_allowed(uuid,text) TO ${OWNER}`);
  await migrate(drizzle(reference),{migrationsFolder:'db/migrations'});
  expect(await ledger(reference)).toEqual(expectedLedger);

  // 5. The installation's course: the stock engine, one transaction, the literal restricted login.
  const ownerNotices:Notice[]=[];
  const restricted=connect(at(names.restricted,OWNER),ownerNotices);
  const [login]=await restricted.unsafe<{session:string;current:string;role:string}[]>(`SELECT session_user::text AS session,current_user::text AS current,current_setting('role') AS role`);
  expect(login).toEqual({session:OWNER,current:OWNER,role:'none'});
  let refused:unknown;
  try{await migrate(drizzle(restricted),{migrationsFolder:'db/migrations'});}catch(error){refused=error;}
  if(refused){
   // List every refusing migration: apply each one alone as the owner on a fresh copy, and where it is refused,
   // apply it as the superuser and hand its objects to the owner, so later migrations meet the installed shape.
   await close(restricted);await close(observer);
   await admin.unsafe(`CREATE DATABASE "${names.diagnosis}" TEMPLATE "${names.restricted}" OWNER ${OWNER}`);
   const builder=connect(at(names.diagnosis)),ownerLogin=connect(at(names.diagnosis,OWNER)),found:string[]=[];
   for(const [index,entry] of release.entries()){
    writeFileSync(join(folder,'meta/_journal.json'),JSON.stringify({...journal,entries:journal.entries.slice(0,MAIN_PREFIX+index+1)}));
    try{await migrate(drizzle(ownerLogin),{migrationsFolder:folder});}
    catch(error){
     found.push(describeRefusal(entry.tag,error));
     await migrate(drizzle(builder),{migrationsFolder:folder});
     await builder.unsafe(PROJECT_INSTALLED_OWNERSHIP);
    }
   }
   expect(found,`ai_hr_owner was refused (${describeRefusal('first',refused)}); every refusing migration`).toEqual([]);
   throw refused;
  }
  expect(await ledger(restricted)).toEqual(expectedLedger);
  const warnings=(notices:Notice[])=>notices.filter(notice=>notice.severity==='WARNING').map(notice=>`${notice.code} ${notice.message}`).sort();
  expect(ownerNotices.filter(notice=>PRIVILEGE_WARNINGS.has(notice.code)),'no GRANT or REVOKE silently did nothing').toEqual([]);
  expect(warnings(ownerNotices)).toEqual(warnings(referenceNotices));

  // 6. Nothing about the purpose owners changed, nothing new belongs to anyone but the owner, and both upgrades agree.
  expect(await purposeOwned(observer,superuser)).toEqual(purposeBefore);
  expect(await ownerRoleGraph(observer)).toEqual(graphBefore);
  expect(await ownerAttributes(observer)).toEqual([{login:true,inherit:true,super:false,createdb:false,createrole:false,replication:false,bypassrls:false}]);
  expect(await leftovers(observer)).toEqual([]);
  const referenceCatalogue=await catalogue(reference,superuser),restrictedCatalogue=await catalogue(observer,superuser);
  expect(Object.keys(restrictedCatalogue.routines).length).toBeGreaterThan(1000);
  expect(Number(restrictedCatalogue.rows.employment),'the populated tenant survives').toBeGreaterThan(0);
  expect(differences(referenceCatalogue,restrictedCatalogue)).toEqual([]);

  // 7. A second run of the engine as the owner is a no-op.
  await migrate(drizzle(restricted),{migrationsFolder:'db/migrations'});
  expect(await ledger(restricted)).toEqual(expectedLedger);
 }finally{
  for(const sql of [...open])await sql.end({timeout:5});
  for(const name of Object.values(names))await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.end({timeout:5});rmSync(folder,{recursive:true,force:true});
 }
},900_000);
