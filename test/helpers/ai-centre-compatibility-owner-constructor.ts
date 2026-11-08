/** Fixed isolated-DB fixture custody, not a migration or installed provisioning API. */
import {expect} from 'vitest';
import type {ISql,Sql} from 'postgres';

type Acl={grantee:string;grantor:string;privilege:string;grantable:boolean};
type ObjectRow={kind:string;identity:string;owner:string;move:boolean;command:string|null;attributes:unknown;acl:Acl[];definition:string|null};
const schemas=['app','public','drizzle'];
const quote=(value:string)=>'"'+value.replaceAll('"','""')+'"';
async function inventory(q:ISql,oldOwner:string,newOwner:string):Promise<ObjectRow[]>{
 const rows: ObjectRow[]=[];
 rows.push(...await q<ObjectRow[]>`select 'schema' as kind,quote_ident(n.nspname) as identity,n.nspowner::regrole::text as owner,
  n.nspowner=${oldOwner}::regrole as move,format('ALTER SCHEMA %I OWNER TO %I',n.nspname,${newOwner}) as command,
  to_jsonb(n)-'nspowner'-'nspacl' as attributes,
  (select coalesce(jsonb_agg(jsonb_build_object('grantee',a.grantee::regrole::text,'grantor',a.grantor::regrole::text,'privilege',a.privilege_type,'grantable',a.is_grantable)),'[]') from aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner)))a)as acl,null::text as definition
  from pg_namespace n where n.nspname=any(${schemas}) order by n.nspname`);
 rows.push(...await q<ObjectRow[]>`select 'relation' as kind,format('%I.%I',n.nspname,c.relname)as identity,c.relowner::regrole::text as owner,
  c.relowner=${oldOwner}::regrole and not exists(select 1 from pg_depend d where d.classid='pg_class'::regclass and d.objid=c.oid and d.deptype='e') as move,
  format('ALTER %s %I.%I OWNER TO %I',case c.relkind when 'S' then 'SEQUENCE' when 'v' then 'VIEW' when 'm' then 'MATERIALIZED VIEW' when 'f' then 'FOREIGN TABLE' else 'TABLE' end,n.nspname,c.relname,${newOwner})as command,
  to_jsonb(c)-'relowner'-'relacl' as attributes,
  (select coalesce(jsonb_agg(jsonb_build_object('grantee',a.grantee::regrole::text,'grantor',a.grantor::regrole::text,'privilege',a.privilege_type,'grantable',a.is_grantable)),'[]')from aclexplode(coalesce(c.relacl,acldefault(case when c.relkind='S' then 'S'::"char" else 'r'::"char" end,c.relowner)))a)as acl,
  case when c.relkind in('v','m')then pg_get_viewdef(c.oid,true)else null end as definition
  from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname=any(${schemas}) and c.relkind in('r','p','S','v','m','f')order by n.nspname,c.relname`);
 rows.push(...await q<ObjectRow[]>`select 'function' as kind,format('%I.%I(%s)',n.nspname,p.proname,pg_get_function_identity_arguments(p.oid))as identity,p.proowner::regrole::text as owner,
  p.proowner=${oldOwner}::regrole and not exists(select 1 from pg_depend d where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e')as move,
  format('ALTER %s %I.%I(%s) OWNER TO %I',case p.prokind when 'p' then 'PROCEDURE' when 'a' then 'AGGREGATE' else 'FUNCTION' end,n.nspname,p.proname,pg_get_function_identity_arguments(p.oid),${newOwner})as command,
  to_jsonb(p)-'proowner'-'proacl' as attributes,
  (select coalesce(jsonb_agg(jsonb_build_object('grantee',a.grantee::regrole::text,'grantor',a.grantor::regrole::text,'privilege',a.privilege_type,'grantable',a.is_grantable)),'[]')from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a)as acl,
  case when p.prokind<>'a'then pg_get_functiondef(p.oid)else(select to_jsonb(a)::text from pg_aggregate a where a.aggfnoid=p.oid)end as definition
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname=any(${schemas})order by n.nspname,p.proname,p.oid`);
 rows.push(...await q<ObjectRow[]>`select 'type' as kind,format('%I.%I',n.nspname,t.typname)as identity,t.typowner::regrole::text as owner,
  t.typowner=${oldOwner}::regrole and not exists(select 1 from pg_depend d where d.classid='pg_type'::regclass and d.objid=t.oid and d.deptype='e')as move,
  case when t.typelem=0 and t.typtype<>'m' and(t.typrelid=0 or c.relkind='c')then format('ALTER %s %I.%I OWNER TO %I',case when t.typtype='d'then 'DOMAIN'else 'TYPE'end,n.nspname,t.typname,${newOwner})else null end as command,
  to_jsonb(t)-'typowner'-'typacl' as attributes,
  (select coalesce(jsonb_agg(jsonb_build_object('grantee',a.grantee::regrole::text,'grantor',a.grantor::regrole::text,'privilege',a.privilege_type,'grantable',a.is_grantable)),'[]')from aclexplode(coalesce(t.typacl,acldefault('T',t.typowner)))a)as acl,null::text as definition
  from pg_type t join pg_namespace n on n.oid=t.typnamespace left join pg_class c on c.oid=t.typrelid where n.nspname=any(${schemas})order by n.nspname,t.typname`);
 rows.push(...await q<ObjectRow[]>`select 'column' as kind,format('%I.%I.%I',n.nspname,c.relname,a.attname)as identity,c.relowner::regrole::text as owner,
  c.relowner=${oldOwner}::regrole and not exists(select 1 from pg_depend d where d.classid='pg_class'::regclass and d.objid=c.oid and d.deptype='e')as move,null::text as command,
  to_jsonb(a)-'attacl' as attributes,
  (select coalesce(jsonb_agg(jsonb_build_object('grantee',x.grantee::regrole::text,'grantor',x.grantor::regrole::text,'privilege',x.privilege_type,'grantable',x.is_grantable)),'[]')from aclexplode(a.attacl)x)as acl,null::text as definition
  from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
  where n.nspname=any(${schemas})and c.relkind in('r','p','v','m','f')and a.attnum>0 and not a.attisdropped order by n.nspname,c.relname,a.attnum`);
 return rows;
}
const sorted=(rows:Acl[])=>rows.slice().sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
const stable=(rows:ObjectRow[],oldOwner:string,newOwner:string)=>rows.map(row=>({
 kind:row.kind,identity:row.identity,owner:row.move?newOwner:row.owner,attributes:row.attributes,definition:row.definition,
 acl:sorted(row.acl.map(acl=>row.move?{...acl,grantee:acl.grantee===oldOwner?newOwner:acl.grantee,grantor:acl.grantor===oldOwner?newOwner:acl.grantor}:acl)),
})).sort((a,b)=>(a.kind+'/'+a.identity).localeCompare(b.kind+'/'+b.identity));

export async function constructAiCentreCompatibilityOwner(connection:Sql,database:string,role:string){
 expect(database).toMatch(/^ai_hr_ai_compat_[0-9a-f]{32}$/);expect(role).toMatch(/^aihr_ai_compat_[0-9a-f]{32}$/);
 const [realm]=await connection`select current_database()as database,current_user as role,session_user as login,inet_server_addr()='127.0.0.1'::inet as loopback`;
 expect(realm).toEqual({database,role:'postgres',login:'postgres',loopback:true});
 const before=await inventory(connection,'postgres',role);
 expect(before.length).toBeGreaterThan(100);expect(before.length).toBeLessThanOrEqual(40000);
 expect(Buffer.byteLength(JSON.stringify(before))).toBeLessThanOrEqual(64*1024*1024);
 // No default-ACL synthesis: this historical source has none. Any unreviewed
 // constructor default privileges require a separate explicit fixture decision.
 expect(await connection`select oid from pg_default_acl`).toEqual([]);
 const policies=await connection`select to_jsonb(p)as row from pg_policies p where schemaname=any(${schemas})order by schemaname,tablename,policyname`;
 const triggers=await connection`select to_jsonb(t)as row from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname=any(${schemas})order by t.oid`;
 await connection.begin(async tx=>{
  for(const row of before)if(row.move&&row.command)await tx.unsafe(row.command);
  const after=await inventory(tx,'postgres',role);
  expect(stable(after,'postgres',role)).toEqual(stable(before,'postgres',role));
  expect(await tx`select to_jsonb(p)as row from pg_policies p where schemaname=any(${schemas})order by schemaname,tablename,policyname`).toEqual(policies);
  expect(await tx`select to_jsonb(t)as row from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname=any(${schemas})order by t.oid`).toEqual(triggers);
 });
 // Exact actual staging owner memberships; never inherit or SET the postgres role.
 for(const [granted,inherit]of [['ai_hr_app',false],['ai_hr_draft_discard_port',false],['ai_hr_rewards_post_reader',true]]as const){
  expect((await connection`select rolname from pg_roles where rolname=${granted}`)).toHaveLength(1);
  await connection.unsafe(`GRANT ${quote(granted)} TO ${quote(role)} WITH INHERIT ${inherit?'TRUE':'FALSE'}, SET TRUE, ADMIN FALSE`);
 }
 const memberships=await connection`select granted.rolname as granted_role,grantor.rolname as grantor,m.admin_option,m.inherit_option,m.set_option from pg_auth_members m join pg_roles granted on granted.oid=m.roleid join pg_roles grantor on grantor.oid=m.grantor where m.member=${role}::regrole order by granted.rolname`;
 expect(Array.from(memberships)).toEqual([
  {granted_role:'ai_hr_app',grantor:'postgres',admin_option:false,inherit_option:false,set_option:true},
  {granted_role:'ai_hr_draft_discard_port',grantor:'postgres',admin_option:false,inherit_option:false,set_option:true},
  {granted_role:'ai_hr_rewards_post_reader',grantor:'postgres',admin_option:false,inherit_option:true,set_option:true},
 ]);
 const after=await inventory(connection,'postgres',role);
 return {realm,memberships,before,after,transferred:before.filter(row=>row.move).length,perKind:Object.fromEntries(['schema','relation','function','type','column'].map(kind=>[kind,before.filter(row=>row.kind===kind&&row.move).length]))};
}
