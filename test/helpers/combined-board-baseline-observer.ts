/** Read-only installed-owner observers for the exact Board-prefix rehearsal.
 * Finite observer SQL copied from test/restricted-owner-release-upgrade.test.ts at c89d24c158af559758cc1e1d935c09c6eb6a9086.
 * Preserves role/ACL normalization, purpose owners and SET-only membership comparisons.
 * Added native constraint/index identities and PostgreSQL-text public row images.
 * No connections, hooks, provisioning or queries run at import. Disposable synthetic fixtures only.
 */
import type postgres from 'postgres';
import {expect} from 'vitest';
export type Row=Record<string,unknown>;
export type Catalogue=Record<string,Row>;
export type PublicRowSnapshot=Record<string,{columns:string[];rows:string[]}>;
const OWNER='ai_hr_owner';

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
 constraints:`SELECT c.conrelid::regclass::text||'.'||c.conname AS key,jsonb_build_object(
   'type',c.contype,'definition',pg_catalog.pg_get_constraintdef(c.oid),'validated',c.convalidated,
   'deferrable',c.condeferrable,'deferred',c.condeferred,'noInherit',c.connoinherit,'local',c.conislocal,'inherited',c.coninhcount) AS value
  FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class r ON r.oid=c.conrelid WHERE ${USER_SCOPE('r','r.relnamespace','pg_class')}`,
 indexes:`SELECT i.indexrelid::regclass::text AS key,jsonb_build_object('table',i.indrelid::regclass::text,
   'definition',pg_catalog.pg_get_indexdef(i.indexrelid),'unique',i.indisunique,'primary',i.indisprimary,
   'exclusion',i.indisexclusion,'immediate',i.indimmediate,'valid',i.indisvalid,'ready',i.indisready,
   'live',i.indislive,'clustered',i.indisclustered,'replicaIdentity',i.indisreplident) AS value
  FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indrelid WHERE ${USER_SCOPE('c','c.relnamespace','pg_class')}`,
 rows:`SELECT c.oid::regclass::text AS key,(xpath('/row/n/text()',query_to_xml(format('SELECT count(*) AS n FROM %s',c.oid::regclass),false,true,'')))[1]::text AS value
  FROM pg_catalog.pg_class c WHERE c.relkind IN ('r','p') AND ${USER_SCOPE('c','c.relnamespace','pg_class')}`,
};
export async function snapshotCatalogue(sql:postgres.Sql,superuser:string):Promise<Catalogue>{
 const out:Catalogue={};
 for(const [kind,query] of Object.entries(CATALOGUE)){
  const rows=await sql.unsafe<{key:string;value:unknown}[]>(query,query.includes('$1')?[superuser]:[]);
  out[kind]=Object.fromEntries(rows.map(row=>[row.key,row.value]));
  expect(rows.length,kind+' has distinct keys').toBe(Object.keys(out[kind]).length);
 }
 return out;
}
export function catalogueDifferences(reference:Catalogue,restricted:Catalogue):string[]{
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
export const purposeOwned=async(sql:postgres.Sql,superuser:string)=>[...await sql.unsafe<{key:string;owner:string;definer:boolean;config:string[]|null;body:string;acl:string|null}[]>(
 `SELECT p.oid::regprocedure::text AS key,pg_catalog.pg_get_userbyid(p.proowner)::text AS owner,p.prosecdef AS definer,p.proconfig AS config,
   md5(p.prosrc) AS body,p.proacl::text AS acl
  FROM pg_catalog.pg_proc p WHERE pg_catalog.pg_get_userbyid(p.proowner) NOT IN ($1,'${OWNER}') AND ${USER_SCOPE('p','p.pronamespace','pg_proc')}
  UNION ALL SELECT c.oid::regclass::text,pg_catalog.pg_get_userbyid(c.relowner)::text,false,NULL,c.relkind::text,c.relacl::text
  FROM pg_catalog.pg_class c WHERE pg_catalog.pg_get_userbyid(c.relowner) NOT IN ($1,'${OWNER}') AND ${USER_SCOPE('c','c.relnamespace','pg_class')}
  ORDER BY 1`,[superuser])];
export const ownerRoleGraph=async(sql:postgres.Sql)=>[...await sql.unsafe<Row[]>(`SELECT r.rolname::text AS role,m.rolname::text AS member,a.inherit_option AS inherit,a.set_option AS "set",a.admin_option AS admin
 FROM pg_catalog.pg_auth_members a JOIN pg_catalog.pg_roles r ON r.oid=a.roleid JOIN pg_catalog.pg_roles m ON m.oid=a.member
 WHERE r.rolname='${OWNER}' OR m.rolname='${OWNER}' ORDER BY 1,2`)];
export const ownerAttributes=async(sql:postgres.Sql)=>[...await sql.unsafe<Row[]>(`SELECT rolcanlogin AS login,rolinherit AS inherit,rolsuper AS super,rolcreatedb AS createdb,
 rolcreaterole AS createrole,rolreplication AS replication,rolbypassrls AS bypassrls FROM pg_catalog.pg_roles WHERE rolname='${OWNER}'`)];
export const ledger=async(sql:postgres.Sql)=>[...await sql.unsafe<{hash:string;created_at:string}[]>('SELECT hash,created_at::text AS created_at FROM drizzle.__drizzle_migrations ORDER BY id')];
export const leftovers=async(sql:postgres.Sql)=>[...await sql.unsafe<{object:string}[]>(SUPERUSER_LEFTOVERS)].map(row=>row.object);
/** Capture original public columns BEFORE upgrade; pass that exact map AFTER upgrade.
 * Duplicate rows remain a multiset. Values stay PostgreSQL JSONB text (no JS numeric/date conversion).
 * Only the disposable fixture superuser may observe physical rows through FORCE RLS. No app schema reads.
 * Identifiers are validated against the public catalogue and quoted individually.
 */
export async function snapshotPublicRows(sql:postgres.Sql,columns?:Record<string,string[]>):Promise<PublicRowSnapshot>{
 const [actor]=await sql.unsafe<{superuser:boolean}[]>(`SELECT rolsuper AS superuser FROM pg_catalog.pg_roles WHERE rolname=current_user`);
 expect(actor?.superuser,'row-image observer is the disposable fixture superuser').toBe(true);
 const tables=await sql.unsafe<{identity:string;schema:string;table:string;columns:string[]}[]>(`SELECT
  pg_catalog.format('%I.%I',n.nspname,c.relname) AS identity,n.nspname AS schema,c.relname AS table,
  coalesce(array_agg(a.attname::text ORDER BY a.attnum) FILTER(WHERE a.attnum IS NOT NULL),'{}'::text[]) AS columns
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
  WHERE n.nspname='public' AND c.relkind IN('r','p')
  GROUP BY c.oid,n.nspname,c.relname ORDER BY n.nspname,c.relname`);
 const known=new Map(tables.map(table=>[table.identity,table]));
 if(columns)for(const identity of Object.keys(columns))expect(known.has(identity),identity+' original public table still exists').toBe(true);
 const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"';
 const result:PublicRowSnapshot={};
 for(const table of tables){
  if(columns&&!Object.hasOwn(columns,table.identity))continue;
  const selected=columns?columns[table.identity]:table.columns;
  expect(new Set(selected).size,table.identity+' projection has distinct columns').toBe(selected.length);
  for(const name of selected)expect(table.columns.includes(name),table.identity+'.'+name+' original column still exists').toBe(true);
  const relation=quote(table.schema)+'.'+quote(table.table);
  const projection=selected.length?'SELECT to_jsonb(projected)::text AS value FROM (SELECT '+selected.map(quote).join(',')+' FROM '+relation+') projected':"SELECT '{}'::text AS value FROM "+relation;
  const rows=await sql.unsafe<{value:string}[]>('SELECT value FROM ('+projection+') snapshot ORDER BY value COLLATE "C"');
  result[table.identity]={columns:[...selected],rows:rows.map(row=>row.value)};
 }
 return result;
}
