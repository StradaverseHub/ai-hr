/** Fixed isolated-DB fixture custody, not a migration or installed provisioning API. */
import {expect} from 'vitest';
import {createHash} from 'node:crypto';
import {lstatSync,readFileSync,readdirSync,realpathSync,writeFileSync} from 'node:fs';
import {basename,dirname,join,resolve} from 'node:path';
import {tmpdir as selectedTmpdir} from 'node:os';
import postgres from 'postgres';
import {migrate} from 'drizzle-orm/postgres-js/migrator';
import {createDb} from '../../db/client';
import {workerDb} from '../db-names';

import type {ISql,Sql} from 'postgres';

type Acl={grantee:string;grantor:string;privilege:string;grantable:boolean};
type ObjectRow={kind:string;identity:string;owner:string;move:boolean;command:string|null;attributes:unknown;acl:Acl[];definition:string|null};
const schemas=['app','public','drizzle'];
const quote=(value:string)=>'"'+value.replaceAll('"','""')+'"';
async function inventory(q:ISql,oldOwner:string,newOwner:string):Promise<ObjectRow[]>{
 const rows: ObjectRow[]=[];
 rows.push(...await q<ObjectRow[]>`select 'schema' as kind,quote_ident(n.nspname) as identity,n.nspowner::regrole::text as owner,
  n.nspowner=${oldOwner}::regrole as move,format('ALTER SCHEMA %I OWNER TO %I',n.nspname,${newOwner}::text) as command,
  to_jsonb(n)-'nspowner'-'nspacl' as attributes,
  (select coalesce(jsonb_agg(jsonb_build_object('grantee',a.grantee::regrole::text,'grantor',a.grantor::regrole::text,'privilege',a.privilege_type,'grantable',a.is_grantable)),'[]') from aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner)))a)as acl,null::text as definition
  from pg_namespace n where n.nspname=any(${schemas}) order by n.nspname`);
 rows.push(...await q<ObjectRow[]>`select 'relation' as kind,format('%I.%I',n.nspname,c.relname)as identity,c.relowner::regrole::text as owner,
  c.relowner=${oldOwner}::regrole and not exists(select 1 from pg_depend d where d.classid='pg_class'::regclass and d.objid=c.oid and d.deptype='e') as move,
  format('ALTER %s %I.%I OWNER TO %I',case c.relkind when 'S' then 'SEQUENCE' when 'v' then 'VIEW' when 'm' then 'MATERIALIZED VIEW' when 'f' then 'FOREIGN TABLE' else 'TABLE' end,n.nspname,c.relname,${newOwner}::text)as command,
  to_jsonb(c)-'relowner'-'relacl' as attributes,
  (select coalesce(jsonb_agg(jsonb_build_object('grantee',a.grantee::regrole::text,'grantor',a.grantor::regrole::text,'privilege',a.privilege_type,'grantable',a.is_grantable)),'[]')from aclexplode(coalesce(c.relacl,acldefault(case when c.relkind='S' then 'S'::"char" else 'r'::"char" end,c.relowner)))a)as acl,
  case when c.relkind in('v','m')then pg_get_viewdef(c.oid,true)else null end as definition
  from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname=any(${schemas}) and c.relkind in('r','p','S','v','m','f')order by n.nspname,c.relname`);
 rows.push(...await q<ObjectRow[]>`select 'function' as kind,format('%I.%I(%s)',n.nspname,p.proname,pg_get_function_identity_arguments(p.oid))as identity,p.proowner::regrole::text as owner,
  p.proowner=${oldOwner}::regrole and not exists(select 1 from pg_depend d where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e')as move,
  format('ALTER %s %I.%I(%s) OWNER TO %I',case p.prokind when 'p' then 'PROCEDURE' when 'a' then 'AGGREGATE' else 'FUNCTION' end,n.nspname,p.proname,pg_get_function_identity_arguments(p.oid),${newOwner}::text)as command,
  to_jsonb(p)-'proowner'-'proacl' as attributes,
  (select coalesce(jsonb_agg(jsonb_build_object('grantee',a.grantee::regrole::text,'grantor',a.grantor::regrole::text,'privilege',a.privilege_type,'grantable',a.is_grantable)),'[]')from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a)as acl,
  case when p.prokind<>'a'then pg_get_functiondef(p.oid)else(select to_jsonb(a)::text from pg_aggregate a where a.aggfnoid=p.oid)end as definition
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname=any(${schemas})order by n.nspname,p.proname,p.oid`);
 rows.push(...await q<ObjectRow[]>`select 'type' as kind,format('%I.%I',n.nspname,t.typname)as identity,t.typowner::regrole::text as owner,
  t.typowner=${oldOwner}::regrole and not exists(select 1 from pg_depend d where d.classid='pg_type'::regclass and d.objid=t.oid and d.deptype='e')as move,
  case when t.typelem=0 and t.typtype<>'m' and(t.typrelid=0 or c.relkind='c')then format('ALTER %s %I.%I OWNER TO %I',case when t.typtype='d'then 'DOMAIN'else 'TYPE'end,n.nspname,t.typname,${newOwner}::text)else null end as command,
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

/** Fixed selected755 job / historical710 -> real owner717 rehearsal.
 * Source models return no capability. Native-changing entry points read their own
 * catalogue; no supplied JSON, flag, role map, URL or callback authorizes SQL. */
type SelectedRole={oid:string;name:string;login:boolean;super:boolean;inherit:boolean;createRole:boolean;createDb:boolean;replication:boolean;bypassRls:boolean;connectionLimit:number;passwordNull:boolean;validUntil:string|null;config:string[]|null};
type SelectedMember={role:string;member:string;grantor:string;inherit:boolean;set:boolean;admin:boolean};
type SelectedDatabase={oid:string;name:string;owner:string;template:boolean;allowConnections:boolean};
type SelectedCluster={systemIdentifier:string;startedAt:string;version:number;jit:string;jitAvailable:boolean;maxConnections:number;maxLocks:number};
type SelectedFunction={oid:string;identity:string;name:string;owner:string;bodySha256:string;arguments:string;result:string;language:string;secdef:boolean;strict:boolean;volatility:string;parallel:string;leakproof:boolean;kind:string;retset:boolean;cost:number;rows:number;config:string[]|null;acl:Acl[]};
type SelectedColumn={number:number;name:string;type:string;typeSchema:string;acl:Acl[]};
type SelectedRelation={oid:string;identity:string;owner:string;kind:string;rls:boolean;force:boolean;columns:SelectedColumn[];acl:Acl[]};
type SelectedPolicy={oid:string;name:string;relation:string;command:string;permissive:boolean;roles:string[];using:string|null;check:string|null};
type SelectedSchema={oid:string;name:string;owner:string;acl:Acl[]};
type SelectedSequence={oid:string;identity:string;owner:string;type:string;start:string;increment:string;minimum:string;maximum:string;cache:string;cycle:boolean;tableOid:string;columnNumber:number;dependency:string;acl:Acl[]};
type SelectedShared={databaseOid:string;role:string;className:string;objectOid:string;subId:number;dependency:string;identity:string|null};
type SelectedConnection={serverAddress:string;serverPort:number;clientAddress:string;database:string;databaseOid:string;owner:string;current:string;session:string;systemIdentifier:string;startedAt:string};
type SelectedSnapshot={connection:SelectedConnection;ledgerCount:number;ledgerRowsSha256:string;fingerprints:string[]|null;emptyObjects:number|null;functions:SelectedFunction[];relations:SelectedRelation[];policies:SelectedPolicy[];schemas:SelectedSchema[];sequence:SelectedSequence|null;shared:SelectedShared[]};
export type AiCentreSelectedJobModel={evidence:'source-model-only'|'native-readonly';mode:'full'|'focused';cluster:SelectedCluster;source:{tuples:string;sql:string;fingerprint:string};roles:SelectedRole[];memberships:SelectedMember[];databases:SelectedDatabase[];owned:{database:string;databaseOid:string;role:string;roleOid:string};readers:SelectedSnapshot[];shared:Omit<SelectedShared,'identity'>[]};
type SelectedFunctionSpec=Omit<SelectedFunction,'oid'|'parallel'|'leakproof'|'kind'|'acl'> & {source:string;aclGrantees:string[]};
type SelectedPolicySpec={relation:string;name:string;role:string;command:string;using:'tenant'|null;check:'tenant'|'event'|null};
type SelectedSourceOracle={tupleSha755:string;tupleSha717:string;tupleSha710:string;sqlPairSha755:string;sqlPairSha717:string;ledgerRowsSha755:string;templateFingerprint:string;N:string[];functions:SelectedFunctionSpec[];columns:Record<string,Record<string,Record<string,string[]>>>;columnTypes:Record<string,Record<string,string>>;policies:SelectedPolicySpec[];forceRls:Record<string,boolean>;dynamicAccessRecipients:string[];roleNames:string[];sequenceAcl:string[][];publicReviewPolicies:Record<string,string>;baselineFunctions:SelectedFunctionSpec[]};
const selectedOracle:SelectedSourceOracle={
 "tupleSha755": "61e17a930609f92efd7cca2fa3c6f94b84df30820ea683ebe8d3b34f177ee888",
 "tupleSha717": "1c09c88bea94c7f4966abe99a2c4d28fd49c5a1493ac61ccda0244a7a63c1530",
 "tupleSha710": "0c1400ecff0da4595cbe4106e3aed49097ebf3398ddfaf33b19ef010d7319cc5",
 "sqlPairSha755": "b0fa881bcb5ce07a48dff4decb10531c20bd740e36db8dd45d4df32b6413e209",
 "sqlPairSha717": "9e2dd13f608f0178d26544d8eeade945f5b50dd18bd6444dda87bcdc0cb8f8a2",
 "templateFingerprint": "0ed592e16dd6a093b7e9f3e7558d7ecc55241958427fb3d3a4e2c5a0d8e05701",
 "N": [
  "ai_hr_reward_preparation_reader",
  "ai_hr_reward_preparation_invalidator",
  "ai_hr_company_org_source_reader"
 ],
 "functions": [
  {
   "identity": "app.reward_preparation_upload_state(uuid)",
   "name": "reward_preparation_upload_state",
   "source": "db/migrations/3701_rewards_unit_preparation.sql",
   "bodySha256": "f0157fc22daa094c9e3e5ba3f67d44d5e93ea135454a2437295c51bb8fb84d9b",
   "arguments": "p_unit uuid",
   "result": "jsonb",
   "language": "sql",
   "secdef": true,
   "strict": false,
   "volatility": "s",
   "config": [
    "search_path=pg_catalog,public,app",
    "row_security=on"
   ],
   "retset": false,
   "cost": 100,
   "rows": 0,
   "owner": "ai_hr_reward_preparation_reader",
   "aclGrantees": [
    "ai_hr_reward_preparation_reader"
   ]
  },
  {
   "identity": "app.reward_preparation_released(uuid)",
   "name": "reward_preparation_released",
   "source": "db/migrations/3701_rewards_unit_preparation.sql",
   "bodySha256": "b373c6574febec928c07a7e8f05b91be19157d1d15e4b126b6791187b6a90458",
   "arguments": "p_unit uuid",
   "result": "boolean",
   "language": "sql",
   "secdef": true,
   "strict": false,
   "volatility": "s",
   "config": [
    "search_path=pg_catalog,public,app",
    "row_security=on"
   ],
   "retset": false,
   "cost": 100,
   "rows": 0,
   "owner": "ai_hr_reward_preparation_reader",
   "aclGrantees": [
    "$creator",
    "ai_hr_reward_preparation_reader"
   ]
  },
  {
   "identity": "app.reward_preparation_view(uuid)",
   "name": "reward_preparation_view",
   "source": "db/migrations/3701_rewards_unit_preparation.sql",
   "bodySha256": "af9c74b4151b4fa135d96abbc7f5a9d61fccdcd78fddc43be0e9b402193329f6",
   "arguments": "p_unit uuid",
   "result": "jsonb",
   "language": "plpgsql",
   "secdef": true,
   "strict": false,
   "volatility": "s",
   "config": [
    "search_path=pg_catalog,public,app",
    "row_security=on"
   ],
   "retset": false,
   "cost": 100,
   "rows": 0,
   "owner": "ai_hr_reward_preparation_reader",
   "aclGrantees": [
    "ai_hr_app",
    "ai_hr_reward_preparation_invalidator",
    "ai_hr_reward_preparation_reader"
   ]
  },
  {
   "identity": "app.reward_preparation_source_changed()",
   "name": "reward_preparation_source_changed",
   "source": "db/migrations/3701_rewards_unit_preparation.sql",
   "bodySha256": "a5feabe65b6954026122692079aa7afd3d114f998cf5733f2ecb5a74b3c5bf79",
   "arguments": "",
   "result": "trigger",
   "language": "plpgsql",
   "secdef": true,
   "strict": false,
   "volatility": "v",
   "config": [
    "search_path=pg_catalog,public,app",
    "row_security=on"
   ],
   "retset": false,
   "cost": 100,
   "rows": 0,
   "owner": "ai_hr_reward_preparation_invalidator",
   "aclGrantees": [
    "ai_hr_reward_preparation_invalidator"
   ]
  },
  {
   "identity": "app.company_org_scope_run(uuid)",
   "name": "company_org_scope_run",
   "source": "db/migrations/3701_rewards_unit_preparation.sql",
   "bodySha256": "35a4da30ec6b1918f79f8ad9cca8909895f4ff443f64fd0033e52b2d9708e8cc",
   "arguments": "p_id uuid",
   "result": "TABLE(id uuid,tenant_id uuid,requested_by uuid,authority_company_ids uuid[],company_ids uuid[],mapping jsonb,state text,effective_on date,published_at timestamptz)",
   "language": "sql",
   "secdef": true,
   "strict": false,
   "volatility": "s",
   "config": [
    "search_path=pg_catalog,public,app",
    "row_security=on"
   ],
   "retset": true,
   "cost": 100,
   "rows": 1000,
   "owner": "ai_hr_company_org_source_reader",
   "aclGrantees": [
    "$creator",
    "ai_hr_company_org_source_reader"
   ]
  },
  {
   "identity": "app.company_org_scope_rows(uuid)",
   "name": "company_org_scope_rows",
   "source": "db/migrations/3701_rewards_unit_preparation.sql",
   "bodySha256": "bc6f8df0855df69ea41f1290b0f0b3cc2d0cbd3a04244e5d55ed947e9c888e71",
   "arguments": "p_id uuid",
   "result": "TABLE(run_id uuid,tenant_id uuid,company_id uuid,before_tags jsonb,after_tags jsonb)",
   "language": "sql",
   "secdef": true,
   "strict": false,
   "volatility": "s",
   "config": [
    "search_path=pg_catalog,public,app",
    "row_security=on"
   ],
   "retset": true,
   "cost": 100,
   "rows": 1000,
   "owner": "ai_hr_company_org_source_reader",
   "aclGrantees": [
    "$creator",
    "ai_hr_company_org_source_reader"
   ]
  },
  {
   "identity": "app.company_org_scope_mappings()",
   "name": "company_org_scope_mappings",
   "source": "db/migrations/3701_rewards_unit_preparation.sql",
   "bodySha256": "eb0fad7cb37bac624ae8d54f3d95acdc87c4dc777dd2ae85b691affe23451e60",
   "arguments": "",
   "result": "TABLE(run_id uuid,tenant_id uuid,company_id uuid,business_unit_id uuid,parent_company_id uuid)",
   "language": "sql",
   "secdef": true,
   "strict": false,
   "volatility": "s",
   "config": [
    "search_path=pg_catalog,public,app",
    "row_security=on"
   ],
   "retset": true,
   "cost": 100,
   "rows": 1000,
   "owner": "ai_hr_company_org_source_reader",
   "aclGrantees": [
    "$creator",
    "ai_hr_company_org_source_reader"
   ]
  },
  {
   "identity": "app.reward_policy_unit_origin(uuid)",
   "name": "reward_policy_unit_origin",
   "source": "db/migrations/2205_rewards_review_creation.sql",
   "bodySha256": "cb521a09a4fd4143badb6b33127da90415ce98b37cbf1a742e3115fdf1775bb7",
   "arguments": "p_unit uuid",
   "result": "jsonb",
   "language": "sql",
   "secdef": true,
   "strict": false,
   "volatility": "s",
   "config": [
    "search_path=pg_catalog,public,pg_temp"
   ],
   "retset": false,
   "cost": 100,
   "rows": 0,
   "owner": "$creator",
   "aclGrantees": [
    "$creator",
    "ai_hr_app",
    "ai_hr_reward_preparation_reader"
   ]
  },
  {
   "identity": "app.reward_roles_preparation_audience(uuid)",
   "name": "reward_roles_preparation_audience",
   "source": "db/migrations/2250_rewards_whole_group_grants.sql",
   "bodySha256": "92abcd2772bcf7f55ea0418597f50fcaeeac8d7a7cc047eaf6663c25f1489c9a",
   "arguments": "wanted_unit uuid",
   "result": "SETOF text",
   "language": "sql",
   "secdef": true,
   "strict": false,
   "volatility": "s",
   "config": [
    "search_path=pg_catalog,public,pg_temp"
   ],
   "retset": true,
   "cost": 100,
   "rows": 1000,
   "owner": "$creator",
   "aclGrantees": [
    "$creator",
    "ai_hr_reward_preparation_reader"
   ]
  },
  {
   "identity": "app.reward_access(uuid)",
   "name": "reward_access",
   "source": "db/migrations/0524_rewards.sql",
   "bodySha256": "116213a570122bb7ca982fc967b7a7045054b9bc6f69bf884a5a1a81d5607814",
   "arguments": "wanted_unit uuid",
   "result": "boolean",
   "language": "sql",
   "secdef": true,
   "strict": false,
   "volatility": "s",
   "config": [
    "search_path=public,pg_temp"
   ],
   "retset": false,
   "cost": 100,
   "rows": 0,
   "owner": "$creator",
   "aclGrantees": [
    "$creator",
    "ai_hr_app",
    "ai_hr_draft_discard_port",
    "ai_hr_reward_preparation_reader",
    "ai_hr_reward_setup_reader",
    "ai_hr_reward_upload_reader",
    "ai_hr_rewards_post_reader"
   ]
  },
  {
   "identity": "app.reward_roles(uuid)",
   "name": "reward_roles",
   "source": "db/migrations/3701_rewards_unit_preparation.sql",
   "bodySha256": "840449cd5830e1dbb9fc83cd25c7cb68e4b14868bb8b1634d837078ae2490550",
   "arguments": "wanted_unit uuid",
   "result": "SETOF text",
   "language": "sql",
   "secdef": true,
   "strict": false,
   "volatility": "s",
   "config": [
    "search_path=pg_catalog,public,app",
    "row_security=on"
   ],
   "retset": true,
   "cost": 100,
   "rows": 1000,
   "owner": "$creator",
   "aclGrantees": [
    "$creator",
    "ai_hr_app",
    "ai_hr_reward_preparation_reader",
    "ai_hr_reward_setup_reader",
    "ai_hr_reward_upload_reader",
    "ai_hr_rewards_post_reader"
   ]
  },
  {
   "identity": "app.reward_not_viewing_as()",
   "name": "reward_not_viewing_as",
   "source": "db/migrations/2206_rewards_role_permissions.sql",
   "bodySha256": "df3dd1b1cbd6adabe7411ed7f30acd25df262c8863c1406cd1c9e6613a43e352",
   "arguments": "",
   "result": "boolean",
   "language": "sql",
   "secdef": true,
   "strict": false,
   "volatility": "s",
   "config": [
    "search_path=pg_catalog,public,app"
   ],
   "retset": false,
   "cost": 100,
   "rows": 0,
   "owner": "ai_hr_reward_view_reader",
   "aclGrantees": [
    "PUBLIC",
    "ai_hr_reward_preparation_reader",
    "ai_hr_reward_view_reader"
   ]
  },
  {
   "identity": "app.reward_preparation_context(uuid,jsonb)",
   "name": "reward_preparation_context",
   "source": "db/migrations/3701_rewards_unit_preparation.sql",
   "bodySha256": "597da0800504f59ac180d10617115df392adedfc5bc0a54fe3628c98f7c346b5",
   "arguments": "p_unit uuid,p_preparation jsonb",
   "result": "jsonb",
   "language": "plpgsql",
   "secdef": true,
   "strict": false,
   "volatility": "s",
   "config": [
    "search_path=pg_catalog,public,app"
   ],
   "retset": false,
   "cost": 100,
   "rows": 0,
   "owner": "$creator",
   "aclGrantees": [
    "$creator",
    "ai_hr_reward_preparation_reader"
   ]
  },
  {
   "identity": "app.reward_preparation_audience_allowed(uuid)",
   "name": "reward_preparation_audience_allowed",
   "source": "db/migrations/3701_rewards_unit_preparation.sql",
   "bodySha256": "16659932c759773bae5ba5cb7876fb51dd6aee65aa6c82d6a2b70de66f664766",
   "arguments": "p_unit uuid",
   "result": "boolean",
   "language": "sql",
   "secdef": true,
   "strict": false,
   "volatility": "s",
   "config": [
    "search_path=pg_catalog,public,app",
    "row_security=on"
   ],
   "retset": false,
   "cost": 100,
   "rows": 0,
   "owner": "$creator",
   "aclGrantees": [
    "$creator",
    "ai_hr_reward_preparation_reader"
   ]
  },
  {
   "identity": "app.teras_loop_attribution()",
   "name": "teras_loop_attribution",
   "source": "db/migrations/2004_teras_loop_autonomy.sql",
   "bodySha256": "dc5731cd88af15a50ca1219e37dc6d904a020c09958097b23e310b73430ea09c",
   "arguments": "",
   "result": "jsonb",
   "language": "plpgsql",
   "secdef": false,
   "strict": false,
   "volatility": "s",
   "config": [
    "search_path=pg_catalog,public,pg_temp"
   ],
   "retset": false,
   "cost": 100,
   "rows": 0,
   "owner": "$creator",
   "aclGrantees": [
    "$creator",
    "ai_hr_app",
    "ai_hr_reward_preparation_invalidator",
    "ai_hr_reward_setup_reader"
   ]
  }
 ],
 "columns": {
  "ai_hr_reward_preparation_reader": {
   "public.reward_unit": {
    "SELECT": [
     "id",
     "tenant_id",
     "kind",
     "deleted_at",
     "preparation_required",
     "company_id",
     "business_unit_id"
    ]
   },
   "public.reward_governance": {
    "SELECT": [
     "unit_id",
     "tenant_id",
     "state"
    ]
   },
   "public.reward_unit_setup": {
    "SELECT": [
     "unit_id",
     "tenant_id",
     "salary_version_id",
     "bonus_version_id"
    ]
   },
   "public.reward_library_version": {
    "SELECT": [
     "id",
     "tenant_id",
     "library_id",
     "revision",
     "state"
    ]
   },
   "public.reward_library": {
    "SELECT": [
     "id",
     "tenant_id",
     "name"
    ]
   },
   "public.reward_uploaded_review": {
    "SELECT": [
     "unit_id",
     "tenant_id",
     "current_version",
     "checked_version",
     "checked_by",
     "checked_at",
     "refresh_required"
    ]
   }
  },
  "ai_hr_reward_preparation_invalidator": {
   "public.reward_unit": {
    "SELECT": [
     "id",
     "tenant_id",
     "status",
     "kind",
     "deleted_at",
     "preparation_required"
    ],
    "UPDATE": [
     "approved_digest",
     "updated_at"
    ]
   },
   "public.reward_governance": {
    "SELECT": [
     "unit_id",
     "tenant_id",
     "state"
    ],
    "UPDATE": [
     "state",
     "updated_at"
    ]
   },
   "public.domain_event": {
    "INSERT": [
     "tenant_id",
     "aggregate_type",
     "aggregate_id",
     "event_type",
     "actor_type",
     "actor_id",
     "subject_employment_id",
     "payload"
    ]
   }
  },
  "ai_hr_company_org_source_reader": {
   "public.company_organisation_run": {
    "SELECT": [
     "id",
     "tenant_id",
     "requested_by",
     "authority_company_ids",
     "company_ids",
     "mapping",
     "state",
     "effective_on",
     "published_at"
    ]
   },
   "public.company_organisation_run_row": {
    "SELECT": [
     "run_id",
     "tenant_id",
     "company_id",
     "before_tags",
     "after_tags"
    ]
   },
   "public.company_organisation_mapping": {
    "SELECT": [
     "run_id",
     "tenant_id",
     "company_id",
     "business_unit_id",
     "parent_company_id"
    ]
   }
  }
 },
 "columnTypes": {
  "public.reward_unit": {
   "id": "uuid",
   "tenant_id": "uuid",
   "kind": "text",
   "deleted_at": "timestamp with time zone",
   "preparation_required": "boolean",
   "company_id": "uuid",
   "business_unit_id": "uuid",
   "status": "text",
   "approved_digest": "text",
   "updated_at": "timestamp with time zone"
  },
  "public.reward_governance": {
   "unit_id": "uuid",
   "tenant_id": "uuid",
   "state": "jsonb",
   "updated_at": "timestamp with time zone"
  },
  "public.reward_unit_setup": {
   "unit_id": "uuid",
   "tenant_id": "uuid",
   "salary_version_id": "uuid",
   "bonus_version_id": "uuid"
  },
  "public.reward_library_version": {
   "id": "uuid",
   "tenant_id": "uuid",
   "library_id": "uuid",
   "revision": "integer",
   "state": "text"
  },
  "public.reward_library": {
   "id": "uuid",
   "tenant_id": "uuid",
   "name": "text"
  },
  "public.reward_uploaded_review": {
   "unit_id": "uuid",
   "tenant_id": "uuid",
   "current_version": "integer",
   "checked_version": "integer",
   "checked_by": "uuid",
   "checked_at": "timestamp with time zone",
   "refresh_required": "boolean"
  },
  "public.domain_event": {
   "tenant_id": "uuid",
   "aggregate_type": "text",
   "aggregate_id": "uuid",
   "event_type": "text",
   "actor_type": "actor_type",
   "actor_id": "uuid",
   "subject_employment_id": "uuid",
   "payload": "jsonb",
   "sequence": "bigint"
  },
  "public.company_organisation_run": {
   "id": "uuid",
   "tenant_id": "uuid",
   "requested_by": "text",
   "authority_company_ids": "uuid[]",
   "company_ids": "uuid[]",
   "mapping": "jsonb",
   "state": "text",
   "effective_on": "date",
   "published_at": "timestamp with time zone"
  },
  "public.company_organisation_run_row": {
   "run_id": "uuid",
   "tenant_id": "uuid",
   "company_id": "uuid",
   "before_tags": "jsonb",
   "after_tags": "jsonb"
  },
  "public.company_organisation_mapping": {
   "run_id": "uuid",
   "tenant_id": "uuid",
   "company_id": "uuid",
   "business_unit_id": "uuid",
   "parent_company_id": "uuid"
  }
 },
 "policies": [
  {
   "relation": "public.reward_unit",
   "name": "reward_preparation_unit_read",
   "role": "ai_hr_reward_preparation_reader",
   "command": "r",
   "using": "tenant",
   "check": null
  },
  {
   "relation": "public.reward_governance",
   "name": "reward_preparation_governance_read",
   "role": "ai_hr_reward_preparation_reader",
   "command": "r",
   "using": "tenant",
   "check": null
  },
  {
   "relation": "public.reward_unit_setup",
   "name": "reward_preparation_setup_read",
   "role": "ai_hr_reward_preparation_reader",
   "command": "r",
   "using": "tenant",
   "check": null
  },
  {
   "relation": "public.reward_library_version",
   "name": "reward_preparation_version_read",
   "role": "ai_hr_reward_preparation_reader",
   "command": "r",
   "using": "tenant",
   "check": null
  },
  {
   "relation": "public.reward_library",
   "name": "reward_preparation_library_read",
   "role": "ai_hr_reward_preparation_reader",
   "command": "r",
   "using": "tenant",
   "check": null
  },
  {
   "relation": "public.reward_uploaded_review",
   "name": "reward_preparation_upload_read",
   "role": "ai_hr_reward_preparation_reader",
   "command": "r",
   "using": "tenant",
   "check": null
  },
  {
   "relation": "public.reward_unit",
   "name": "reward_preparation_invalidate_unit",
   "role": "ai_hr_reward_preparation_invalidator",
   "command": "*",
   "using": "tenant",
   "check": "tenant"
  },
  {
   "relation": "public.reward_governance",
   "name": "reward_preparation_invalidate_state",
   "role": "ai_hr_reward_preparation_invalidator",
   "command": "*",
   "using": "tenant",
   "check": "tenant"
  },
  {
   "relation": "public.domain_event",
   "name": "reward_preparation_invalidate_event",
   "role": "ai_hr_reward_preparation_invalidator",
   "command": "a",
   "using": null,
   "check": "event"
  },
  {
   "relation": "public.company_organisation_run",
   "name": "company_org_source_run_read",
   "role": "ai_hr_company_org_source_reader",
   "command": "r",
   "using": "tenant",
   "check": null
  },
  {
   "relation": "public.company_organisation_run_row",
   "name": "company_org_source_row_read",
   "role": "ai_hr_company_org_source_reader",
   "command": "r",
   "using": "tenant",
   "check": null
  },
  {
   "relation": "public.company_organisation_mapping",
   "name": "company_org_source_mapping_read",
   "role": "ai_hr_company_org_source_reader",
   "command": "r",
   "using": "tenant",
   "check": null
  }
 ],
 "forceRls": {
  "public.reward_unit": false,
  "public.reward_governance": true,
  "public.reward_unit_setup": true,
  "public.reward_library_version": true,
  "public.reward_library": true,
  "public.reward_uploaded_review": true,
  "public.domain_event": false,
  "public.company_organisation_run": true,
  "public.company_organisation_run_row": true,
  "public.company_organisation_mapping": true
 },
 "dynamicAccessRecipients": [
  "ai_hr_draft_discard_port",
  "ai_hr_reward_preparation_reader",
  "ai_hr_reward_setup_reader",
  "ai_hr_reward_upload_reader"
 ],
 "roleNames": [
  "ai_hr_app",
  "ai_hr_owner",
  "ai_hr_draft_discard_port",
  "ai_hr_rewards_post_reader",
  "ai_hr_architecture_grade_guard",
  "ai_hr_job_profile_reader",
  "ai_hr_reward_setup_reader",
  "ai_hr_reward_view_reader",
  "ai_hr_reward_upload_reader",
  "ai_hr_reward_preparation_reader",
  "ai_hr_reward_preparation_invalidator",
  "ai_hr_company_org_source_reader"
 ],
 "sequenceAcl": [
  [
   "$creator",
   "SELECT"
  ],
  [
   "$creator",
   "UPDATE"
  ],
  [
   "$creator",
   "USAGE"
  ],
  [
   "ai_hr_app",
   "SELECT"
  ],
  [
   "ai_hr_app",
   "USAGE"
  ],
  [
   "ai_hr_reward_setup_reader",
   "USAGE"
  ],
  [
   "ai_hr_reward_preparation_invalidator",
   "USAGE"
  ]
 ],
 "ledgerRowsSha755": "48941a512cb3dec390d5cfab0ee5b8e7c5f84dfa35927bf5e70942ab4bb4d09d",
 "publicReviewPolicies": {
  "reward_uploaded_review_read": "tenant_id = app.current_tenant_id() AND app.reward_access(unit_id)",
  "reward_uploaded_review_write": "tenant_id = app.current_tenant_id() AND ('gr'::text = ANY ((ARRAY( SELECT app.reward_roles(reward_uploaded_review.unit_id) AS reward_roles)))) AND app.reward_not_viewing_as()"
 },
 "baselineFunctions": [
  {
   "identity": "app._draft_discard_source_snapshot(uuid,uuid)",
   "name": "_draft_discard_source_snapshot",
   "owner": "ai_hr_draft_discard_port",
   "bodySha256": "4095444f8da40644605383b5e8731bc3faac9fb15ec2d9dc0ff8f4e91aecd7dc",
   "arguments": "p_draft uuid,p_company uuid",
   "result": "jsonb",
   "language": "plpgsql",
   "secdef": true,
   "strict": false,
   "volatility": "v",
   "config": [
    "search_path=pg_catalog,public,pg_temp",
    "row_security=on"
   ],
   "retset": false,
   "cost": 100,
   "rows": 0,
   "source": "db/migrations/0946_draft_creation_cohort_custody.sql",
   "aclGrantees": [
    "$creator",
    "ai_hr_draft_discard_port"
   ]
  },
  {
   "identity": "app.reward_setup_allowed(uuid,text)",
   "name": "reward_setup_allowed",
   "owner": "ai_hr_reward_setup_reader",
   "bodySha256": "1f719c09acac186594f8db15182a1f6b13bf7328a534ae7e7858570e6ffc4da1",
   "arguments": "wanted_company uuid,wanted_operation text",
   "result": "boolean",
   "language": "sql",
   "secdef": true,
   "strict": false,
   "volatility": "s",
   "config": [
    "search_path=pg_catalog,public,app"
   ],
   "retset": false,
   "cost": 100,
   "rows": 0,
   "source": "db/migrations/2250_rewards_whole_group_grants.sql",
   "aclGrantees": [
    "$creator",
    "ai_hr_app",
    "ai_hr_reward_setup_reader"
   ]
  }
 ]
};
const selectedHash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const selectedCanonical=(value:unknown):string=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
const selectedDigest=(value:unknown)=>selectedHash(JSON.stringify(value));
function selectedNeed(value:unknown,message='Selected AI upgrade native prerequisite refused'):asserts value{if(!value)throw Error(message);}
function selectedOid(value:unknown):asserts value is string{selectedNeed(typeof value==='string'&&/^[1-9][0-9]*(?![\s\S])/.test(value));}
function selectedInt(value:unknown,minimum=0):asserts value is number{selectedNeed(typeof value==='number'&&Number.isSafeInteger(value)&&value>=minimum);}
function selectedObject(value:unknown):asserts value is Record<string,unknown>{selectedNeed(value!==null&&typeof value==='object'&&!Array.isArray(value));}
function selectedArray(value:unknown):asserts value is unknown[]{selectedNeed(Array.isArray(value));}
const selectedSorted=(values:unknown[])=>values.map(selectedCanonical).sort();
function selectedEqual(actual:unknown,expected:unknown,message='Selected AI upgrade native facts differ'){
 selectedNeed(selectedCanonical(actual)===selectedCanonical(expected),message);
}
function selectedUnique(values:string[]){selectedNeed(new Set(values).size===values.length);}
const selectedCreator=(name:string,creator:string)=>name==='$creator'?creator:name;
function selectedAcl(actual:Acl[],expected:Acl[]){
 selectedArray(actual);
 for(const row of actual){selectedObject(row);selectedNeed(typeof row.grantee==='string'&&typeof row.grantor==='string'&&typeof row.privilege==='string'&&typeof row.grantable==='boolean');}
 selectedEqual(selectedSorted(actual),selectedSorted(expected),'Selected native ACL/grantor/options differ');
 selectedUnique(actual.map(selectedCanonical));
}
function selectedRole(role:SelectedRole){
 selectedObject(role);selectedOid(role.oid);selectedNeed(typeof role.name==='string'&&role.name.length<=180);
 for(const key of ['login','super','inherit','createRole','createDb','replication','bypassRls','passwordNull']as const)selectedNeed(typeof role[key]==='boolean');
 selectedNeed(typeof role.connectionLimit==='number'&&Number.isSafeInteger(role.connectionLimit));
 selectedNeed(role.validUntil===null||typeof role.validUntil==='string');selectedNeed(role.config===null||Array.isArray(role.config)&&role.config.every(value=>typeof value==='string'));
}
function selectedBoundRole(role:SelectedRole,name:string){
 const login=name==='ai_hr_app'||name==='ai_hr_owner'||/^aihr_ai_compat_[0-9a-f]{32}(?![\s\S])/.test(name);
 const inherit=login||name==='ai_hr_draft_discard_port';
 selectedEqual({login:role.login,inherit:role.inherit,super:role.super,createRole:role.createRole,createDb:role.createDb,replication:role.replication,bypassRls:role.bypassRls,connectionLimit:role.connectionLimit,passwordNull:role.passwordNull,validUntil:role.validUntil,config:role.config},
 {login,inherit,super:false,createRole:false,createDb:false,replication:false,bypassRls:false,connectionLimit:-1,passwordNull:true,validUntil:null,config:null});
}
function selectedNames(mode:'full'|'focused'){
 return mode==='full'?{template:'ai_hr_test_tpl',workers:['ai_hr_test_w1']}:{template:'ai_hr_test_tpl_aifocus',workers:['ai_hr_test_w_aifocus1','ai_hr_test_w_aifocus2']};
}
function selectedKnownFunction(row:SelectedFunction,spec:SelectedFunctionSpec,creator:string){
 selectedObject(row);selectedOid(row.oid);
 selectedEqual(row.identity,spec.identity);selectedEqual(row.name,spec.name);selectedEqual(row.owner,selectedCreator(spec.owner,creator));
 selectedNeed(typeof row.bodySha256==='string'&&/^[a-f0-9]{64}(?![\s\S])/.test(row.bodySha256));selectedEqual(row.bodySha256,spec.bodySha256);
 const normalize=(text:string)=>text.replace(/\btimestamptz\b/g,'timestamp with time zone').replace(/\s+/g,'').toLowerCase();
 selectedNeed(typeof row.arguments==='string'&&typeof row.result==='string');
 selectedEqual(normalize(row.arguments),normalize(spec.arguments));selectedEqual(normalize(row.result),normalize(spec.result));
 for(const key of ['language','secdef','strict','volatility','retset','cost','rows']as const)selectedEqual(row[key],spec[key]);
 selectedEqual({parallel:row.parallel,leakproof:row.leakproof,kind:row.kind},{parallel:'u',leakproof:false,kind:'f'});
 selectedNeed(Array.isArray(row.config)&&row.config.every(value=>typeof value==='string'));
 selectedEqual(row.config!.map(normalize),spec.config!.map(normalize));
 const owner=selectedCreator(spec.owner,creator);
 selectedAcl(row.acl,spec.aclGrantees.map(grantee=>({grantee:selectedCreator(grantee,creator),grantor:owner,privilege:'EXECUTE',grantable:false})));
}
/** Only remove a parenthesis pair which encloses the complete expression. */
function selectedOuter(value:string){
 let text=value.trim();
 while(text.startsWith('(')){
  let depth=0,quote=false,end=-1;
  for(let i=0;i<text.length;i++){
   if(text[i]==="'"){if(quote&&text[i+1]==="'"){i++;continue;}quote=!quote;continue;}
   if(quote)continue;if(text[i]==='(')depth++;if(text[i]===')'&&--depth===0){end=i;break;}
  }
  if(end!==text.length-1)break;text=text.slice(1,-1).trim();
 }
 return text;
}
function selectedSqlTokens(value:string){
 let result='',quote=false;
 for(let i=0;i<value.length;i++){
  const char=value[i];if(char==="'"){result+=char;if(quote&&value[i+1]==="'"){result+="'";i++;continue;}quote=!quote;continue;}
  result+=quote?char:/\s/.test(char)?'':char.toLowerCase();
 }
 selectedNeed(!quote);return result;
}
function selectedAndTerms(value:string){
 const text=selectedOuter(value),terms:string[]=[];let depth=0,quote=false,caseDepth=0,start=0;
 for(let i=0;i<text.length;i++){
  const char=text[i];if(char==="'"){if(quote&&text[i+1]==="'"){i++;continue;}quote=!quote;continue;}
  if(quote)continue;if(char==='('){depth++;continue;}if(char===')'){depth--;selectedNeed(depth>=0);continue;}
  if(depth===0&&/[A-Za-z_]/.test(char)){
   const token=/^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i))![0],word=token.toLowerCase();
   if(word==='case')caseDepth++;else if(word==='end'){caseDepth--;selectedNeed(caseDepth>=0);}
   else if(word==='and'&&caseDepth===0){terms.push(text.slice(start,i));start=i+token.length;}
   i+=token.length-1;
  }
 }
 selectedNeed(!quote&&depth===0&&caseDepth===0);terms.push(text.slice(start));return terms;
}
function selectedPolicyExpression(value:string|null,kind:'tenant'|'event'|null){
 if(kind===null){selectedEqual(value,null);return;}selectedNeed(typeof value==='string'&&value.length<=262144);
 if(kind==='tenant'){selectedEqual(selectedSqlTokens(selectedOuter(value!)),'tenant_id=app.current_tenant_id()');return;}
 const terms=selectedAndTerms(value!);selectedEqual(terms.length,5);
 const normalized=terms.map(term=>selectedSqlTokens(selectedOuter(term)).replace(/('(?:[^']|'')*')::text/g,'$1'));
 selectedEqual(normalized[0],'tenant_id=app.current_tenant_id()');
 selectedEqual(normalized[1],"aggregate_type='reward-unit'");
 selectedEqual(normalized[2],"event_type='reward-unit.preparation-invalidated'");
 selectedNeed(['actor_idisnotdistinctfromapp.current_user_id()','not(actor_idisdistinctfromapp.current_user_id())','notactor_idisdistinctfromapp.current_user_id()'].includes(normalized[3]));
 selectedEqual(normalized[4].replace('(actor_type)::text','actor_type::text').replace('when(app.current_user_id()isnull)then','whenapp.current_user_id()isnullthen'),"actor_type::text=casewhenapp.current_user_id()isnullthen'system'else'user'end");
}
function selectedPublicReviewPolicies(policies:SelectedPolicy[]){
 for(const name of ['reward_uploaded_review_read','reward_uploaded_review_write']){
  const found=policies.filter(row=>row.relation==='public.reward_uploaded_review'&&row.name===name);selectedEqual(found.length,1);
  const row=found[0];selectedEqual(row.roles,['PUBLIC']);selectedEqual(row.command,name.endsWith('_read')?'r':'*');selectedEqual(row.permissive,true);
  selectedNeed(typeof row.using==='string');
  const expression=selectedOuter(row.using!),tokens=selectedSqlTokens(expression);
  const prefix="casewhencurrent_user='ai_hr_reward_preparation_reader'::namethenfalseelse";
  selectedNeed(tokens.startsWith(prefix)&&tokens.endsWith('end'),'Selected PUBLIC preparation recursion guard missing');
  const body=tokens.slice(prefix.length,-3);
  selectedEqual(selectedSqlTokens(selectedOuter(body)),selectedSqlTokens(selectedOuter(selectedOracle.publicReviewPolicies[name])));
  if(name.endsWith('_read'))selectedEqual(row.check,null);
  else selectedNeed(typeof row.check==='string'&&selectedSqlTokens(selectedOuter(row.check))===selectedSqlTokens(selectedOuter(selectedOracle.publicReviewPolicies[name])));
 }
}
function selectedNColumns(relation:SelectedRelation,creator:string){
 const expected:Record<string,Acl[]>={};
 for(const [role,tables]of Object.entries(selectedOracle.columns)){
  const grants=tables[relation.identity];if(!grants)continue;
  for(const [privilege,columns]of Object.entries(grants))for(const column of columns)(expected[column]??=[]).push({grantee:role,grantor:creator,privilege,grantable:false});
 }
 selectedArray(relation.columns);selectedUnique(relation.columns.map(row=>row.name));selectedUnique(relation.columns.map(row=>String(row.number)));
 for(const column of relation.columns){
  selectedObject(column);selectedInt(column.number,1);selectedNeed(typeof column.name==='string'&&typeof column.type==='string'&&typeof column.typeSchema==='string');
  const type=selectedOracle.columnTypes[relation.identity]?.[column.name];
  if(type){selectedEqual(column.type,type);selectedEqual(column.typeSchema,type==='actor_type'?'public':'pg_catalog');}
  selectedAcl(column.acl.filter(row=>selectedOracle.N.includes(row.grantee)),expected[column.name]??[]);
 }
 for(const column of Object.keys(expected))selectedEqual(relation.columns.filter(row=>row.name===column).length,1);
 // The serial sequence owner depends on this exact typed native column even
 // though the invalidator INSERT omits it and uses its source-defined default.
 if(relation.identity==='public.domain_event')selectedEqual(relation.columns.filter(row=>row.name==='sequence'&&row.type==='bigint'&&row.typeSchema==='pg_catalog').length,1);
 selectedAcl(relation.acl.filter(row=>selectedOracle.N.includes(row.grantee)),[]);
}
function selectedSnapshot(snapshot:SelectedSnapshot,creator:string,cluster:SelectedCluster,empty=false){
 selectedObject(snapshot);selectedObject(snapshot.connection);const connection=snapshot.connection;
 selectedOid(connection.databaseOid);selectedEqual({serverAddress:connection.serverAddress,serverPort:connection.serverPort,clientAddress:connection.clientAddress},{serverAddress:'127.0.0.1',serverPort:5433,clientAddress:'127.0.0.1'});selectedEqual(connection.current,'postgres');selectedEqual(connection.session,'postgres');
 selectedEqual(connection.systemIdentifier,cluster.systemIdentifier);selectedEqual(connection.startedAt,cluster.startedAt);
 selectedInt(snapshot.ledgerCount);selectedNeed(typeof snapshot.ledgerRowsSha256==='string'&&/^[a-f0-9]{64}(?![\s\S])/.test(snapshot.ledgerRowsSha256));
 if(empty){
  selectedEqual(snapshot.ledgerCount,0);selectedEqual(snapshot.ledgerRowsSha256,selectedDigest([]));selectedEqual(snapshot.fingerprints,null);selectedEqual(snapshot.emptyObjects,0);
  selectedEqual(snapshot.functions,[]);selectedEqual(snapshot.relations,[]);selectedEqual(snapshot.policies,[]);selectedEqual(snapshot.schemas,[]);selectedEqual(snapshot.sequence,null);selectedEqual(snapshot.shared,[]);return;
 }
 selectedEqual(snapshot.emptyObjects,null);selectedEqual(snapshot.ledgerCount,755);selectedEqual(snapshot.ledgerRowsSha256,selectedOracle.ledgerRowsSha755);
 if(connection.database==='ai_hr_dev')selectedEqual(snapshot.fingerprints,null);else selectedEqual(snapshot.fingerprints,[selectedOracle.templateFingerprint]);
 selectedNFootprint(snapshot,creator);
}
function selectedNFootprint(snapshot:SelectedSnapshot,creator:string){
 const connection=snapshot.connection;
 selectedArray(snapshot.functions);selectedEqual(snapshot.functions.length,15);selectedUnique(snapshot.functions.map(row=>row.identity));selectedUnique(snapshot.functions.map(row=>row.oid));
 for(const spec of selectedOracle.functions){const found=snapshot.functions.filter(row=>row.identity===spec.identity);selectedEqual(found.length,1);selectedKnownFunction(found[0],spec,creator);}
 selectedArray(snapshot.relations);selectedEqual(snapshot.relations.length,10);selectedUnique(snapshot.relations.map(row=>row.identity));selectedUnique(snapshot.relations.map(row=>row.oid));
 for(const identity of Object.keys(selectedOracle.columnTypes)){
  const found=snapshot.relations.filter(row=>row.identity===identity);selectedEqual(found.length,1);const row=found[0];selectedOid(row.oid);
  selectedEqual({owner:row.owner,kind:row.kind,rls:row.rls,force:row.force},{owner:creator,kind:'r',rls:true,force:selectedOracle.forceRls[identity]});selectedNColumns(row,creator);
 }
 selectedArray(snapshot.policies);selectedUnique(snapshot.policies.map(row=>row.relation+'/'+row.name));selectedUnique(snapshot.policies.map(row=>row.oid));
 const targeted=snapshot.policies.filter(row=>row.roles.some(role=>selectedOracle.N.includes(role)));selectedEqual(targeted.length,12);
 for(const spec of selectedOracle.policies){
  const found=targeted.filter(row=>row.relation===spec.relation&&row.name===spec.name);selectedEqual(found.length,1);const row=found[0];selectedOid(row.oid);
  selectedEqual({command:row.command,permissive:row.permissive,roles:row.roles},{command:spec.command,permissive:true,roles:[spec.role]});
  selectedPolicyExpression(row.using,spec.using);selectedPolicyExpression(row.check,spec.check);
 }
 selectedPublicReviewPolicies(snapshot.policies);
 selectedArray(snapshot.schemas);selectedEqual(snapshot.schemas.length,2);selectedUnique(snapshot.schemas.map(row=>row.name));selectedUnique(snapshot.schemas.map(row=>row.oid));
 for(const name of ['app','public']){
  const schema=snapshot.schemas.find(row=>row.name===name)!;selectedNeed(schema);selectedOid(schema.oid);const owner=name==='app'?creator:'pg_database_owner';selectedEqual(schema.owner,owner);
  selectedAcl(schema.acl.filter(row=>selectedOracle.N.includes(row.grantee)),selectedOracle.N.map(grantee=>({grantee,grantor:owner,privilege:'USAGE',grantable:false})));
  if(name==='app')selectedNeed(!schema.acl.some(row=>row.grantee==='PUBLIC'&&row.privilege==='CREATE'),'Selected PUBLIC app CREATE differs');
 }
 const sequence=snapshot.sequence;selectedNeed(sequence);selectedOid(sequence!.oid);
 const event=snapshot.relations.find(row=>row.identity==='public.domain_event')!,column=event.columns.find(row=>row.name==='sequence')!;
 selectedEqual({identity:sequence!.identity,owner:sequence!.owner,type:sequence!.type,start:sequence!.start,increment:sequence!.increment,minimum:sequence!.minimum,maximum:sequence!.maximum,cache:sequence!.cache,cycle:sequence!.cycle,tableOid:sequence!.tableOid,columnNumber:sequence!.columnNumber,dependency:sequence!.dependency},
 {identity:'public.domain_event_sequence_seq',owner:creator,type:'bigint',start:'1',increment:'1',minimum:'1',maximum:'9223372036854775807',cache:'1',cycle:false,tableOid:event.oid,columnNumber:column.number,dependency:'a'});
 selectedAcl(sequence!.acl,selectedOracle.sequenceAcl.map(([grantee,privilege])=>({grantee:selectedCreator(grantee,creator),grantor:creator,privilege,grantable:false})));
 const expected:SelectedShared[]=[];
 const add=(role:string,className:string,objectOid:string,subId:number,dependency:string,identity:string)=>expected.push({databaseOid:connection.databaseOid,role,className,objectOid,subId,dependency,identity});
 for(const fn of snapshot.functions){
  if(selectedOracle.N.includes(fn.owner))add(fn.owner,'pg_proc',fn.oid,0,'o',fn.identity);
  const roles=new Set(fn.acl.flatMap(row=>[row.grantee,row.grantor]).filter(role=>selectedOracle.N.includes(role)&&role!==fn.owner));
  for(const role of roles)add(role,'pg_proc',fn.oid,0,'a',fn.identity);
 }
 for(const schema of snapshot.schemas)for(const role of selectedOracle.N)add(role,'pg_namespace',schema.oid,0,'a',schema.name);
 for(const relation of snapshot.relations)for(const column of relation.columns){
  const roles=new Set(column.acl.flatMap(row=>[row.grantee,row.grantor]).filter(role=>selectedOracle.N.includes(role)));
  for(const role of roles)add(role,'pg_class',relation.oid,column.number,'a',relation.identity+'.'+column.name);
 }
 add('ai_hr_reward_preparation_invalidator','pg_class',sequence!.oid,0,'a',sequence!.identity);
 for(const policy of targeted)for(const role of policy.roles)add(role,'pg_policy',policy.oid,0,'r',policy.relation+'#'+policy.name);
 selectedArray(snapshot.shared);for(const row of snapshot.shared){selectedOid(row.databaseOid);selectedOid(row.objectOid);selectedInt(row.subId);selectedNeed(selectedOracle.N.includes(row.role));}
 selectedUnique(snapshot.shared.map(selectedCanonical));selectedEqual(selectedSorted(snapshot.shared),selectedSorted(expected),'Selected N shared-dependency semantic set differs');
}

function selectedCloneOids(snapshot:SelectedSnapshot){
 return selectedSorted([
  ...snapshot.functions.map(row=>['pg_proc',row.identity,row.oid,0]),
  ...snapshot.relations.map(row=>['pg_class',row.identity,row.oid,0]),
  ...snapshot.relations.flatMap(row=>row.columns.map(column=>['pg_class',row.identity+'.'+column.name,row.oid,column.number])),
  ...snapshot.policies.map(row=>['pg_policy',row.relation+'#'+row.name,row.oid,0]),
  ...snapshot.schemas.map(row=>['pg_namespace',row.name,row.oid,0]),
  ['pg_class',snapshot.sequence!.identity,snapshot.sequence!.oid,0],
 ]);
}
/** PURE validation only. A caller-supplied model never reaches the SQL owner. */
export function assertAiCentreSelectedJobCatalogue(value:unknown):asserts value is AiCentreSelectedJobModel{
 selectedObject(value);const model=value as unknown as AiCentreSelectedJobModel;
 selectedNeed(['source-model-only','native-readonly'].includes(model.evidence));selectedNeed(model.mode==='full'||model.mode==='focused');
 selectedObject(model.cluster);selectedNeed(typeof model.cluster.systemIdentifier==='string'&&/^[1-9][0-9]*(?![\s\S])/.test(model.cluster.systemIdentifier)&&typeof model.cluster.startedAt==='string'&&model.cluster.startedAt.length<=80);
 selectedInt(model.cluster.version,160000);selectedNeed(model.cluster.version<170000);
 selectedEqual({jit:model.cluster.jit,available:model.cluster.jitAvailable,maxConnections:model.cluster.maxConnections,maxLocks:model.cluster.maxLocks},{jit:'on',available:true,maxConnections:100,maxLocks:256});
 selectedEqual(model.source,{tuples:selectedOracle.tupleSha755,sql:selectedOracle.sqlPairSha755,fingerprint:selectedOracle.templateFingerprint});
 selectedObject(model.owned);selectedNeed(/^ai_hr_ai_compat_[0-9a-f]{32}(?![\s\S])/.test(model.owned.database)&&/^aihr_ai_compat_[0-9a-f]{32}(?![\s\S])/.test(model.owned.role));selectedOid(model.owned.databaseOid);selectedOid(model.owned.roleOid);
 selectedNeed(model.owned.database.slice('ai_hr_ai_compat_'.length)===model.owned.role.slice('aihr_ai_compat_'.length));
 selectedArray(model.roles);model.roles.forEach(selectedRole);selectedUnique(model.roles.map(row=>row.name));selectedUnique(model.roles.map(row=>row.oid));
 selectedEqual(model.roles.filter(row=>row.name.startsWith('ai_hr_')).map(row=>row.name).sort(),[...selectedOracle.roleNames].sort());
 for(const name of [...selectedOracle.roleNames,model.owned.role]){
  const role=model.roles.find(row=>row.name===name);selectedNeed(role);selectedBoundRole(role!,name);
 }
 selectedEqual(model.roles.find(row=>row.name===model.owned.role)!.oid,model.owned.roleOid);
 for(const role of model.roles)if(!selectedOracle.roleNames.includes(role.name)&&role.name!==model.owned.role)selectedNeed(BigInt(role.oid)<BigInt(16384),'Foreign role in selected job');
 const postgresRole=model.roles.find(row=>row.name==='postgres');selectedNeed(postgresRole&&postgresRole.oid==='10'&&postgresRole.super&&postgresRole.login&&postgresRole.bypassRls);
 selectedNeed(model.roles.some(row=>row.name==='pg_database_owner'&&!row.login&&!row.super&&!row.bypassRls));
 selectedArray(model.memberships);selectedUnique(model.memberships.map(selectedCanonical));
 for(const member of model.memberships){
  for(const key of ['role','member','grantor']as const)selectedNeed(model.roles.some(role=>role.name===member[key]));
  for(const key of ['inherit','set','admin']as const)selectedNeed(typeof member[key]==='boolean');
 }
 const relevant=model.memberships.filter(row=>[row.role,row.member,row.grantor].some(name=>selectedOracle.roleNames.includes(name)||name===model.owned.role));
 selectedEqual(selectedSorted(relevant),selectedSorted([
  {role:'ai_hr_app',member:'ai_hr_draft_discard_port',grantor:'postgres',inherit:true,set:false,admin:false},
  {role:'ai_hr_draft_discard_port',member:'ai_hr_owner',grantor:'postgres',inherit:false,set:true,admin:false},
 ]),'Unexpected selected job role/member/SET/INHERIT/ADMIN/grantor');
 selectedArray(model.databases);selectedUnique(model.databases.map(row=>row.name));selectedUnique(model.databases.map(row=>row.oid));
 const names=selectedNames(model.mode),expected=['postgres','template0','template1','ai_hr_dev','ai_hr_test',names.template,...names.workers,model.owned.database].sort();
 selectedEqual(model.databases.map(row=>row.name).sort(),expected);
 for(const database of model.databases){
  selectedOid(database.oid);const owner=database.name===model.owned.database?model.owned.role:['ai_hr_dev','ai_hr_test'].includes(database.name)?'ai_hr_app':'postgres';
  selectedEqual(database.owner,owner);selectedEqual(database.template,['template0','template1'].includes(database.name));selectedEqual(database.allowConnections,database.name!=='template0');
 }
 selectedEqual(model.databases.find(row=>row.name===model.owned.database)!.oid,model.owned.databaseOid);
 selectedArray(model.readers);const readerNames=['ai_hr_dev','ai_hr_test',names.template,...names.workers];selectedEqual(model.readers.map(row=>row.connection.database).sort(),readerNames.sort());
 for(const snapshot of model.readers){
  const db=model.databases.find(row=>row.name===snapshot.connection.database);selectedNeed(db);selectedEqual(snapshot.connection.databaseOid,db!.oid);selectedEqual(snapshot.connection.owner,db!.owner);
  selectedSnapshot(snapshot,'postgres',model.cluster,snapshot.connection.database==='ai_hr_test');
 }
 const template=model.readers.find(row=>row.connection.database===names.template)!;
 for(const worker of names.workers)selectedEqual(selectedCloneOids(model.readers.find(row=>row.connection.database===worker)!),selectedCloneOids(template),'Selected worker/template local OID correspondence differs');
 selectedArray(model.shared);selectedUnique(model.shared.map(selectedCanonical));
 const projected=model.readers.flatMap(snapshot=>snapshot.shared.map(({identity:_identity,...row})=>row));
 selectedEqual(selectedSorted(model.shared),selectedSorted(projected),'Foreign/global/unknown/dangling N shared dependency');
}

type SelectedBudget={rows:number;bytes:number;cleanup:boolean;guard():void;objects(count:number):void;capture(value:unknown,count:number):void};
function selectedBudget(signal:AbortSignal,startedAt:number):SelectedBudget{
 selectedNeed(signal&&typeof signal.aborted==='boolean'&&Number.isFinite(startedAt)&&startedAt<=performance.now());
 return {rows:0,bytes:0,cleanup:false,guard(){if(!this.cleanup)selectedNeed(!signal.aborted&&performance.now()<startedAt+300000,'Selected native case cancelled or deadline exhausted');},objects(count:number){this.guard();selectedInt(count);this.rows+=count;selectedNeed(this.rows<=40000,'Selected aggregate metadata frontier exceeded');},capture(value:unknown,count:number){
  this.guard();selectedInt(count);const serialized=JSON.stringify(value);selectedNeed(typeof serialized==='string');
  this.rows+=count;this.bytes+=Buffer.byteLength(serialized);
  selectedNeed(this.rows<=40000&&this.bytes<=64*1024*1024,'Selected aggregate metadata frontier exceeded');
 }};
}
const selectedLiteral=(value:string)=>"'"+value.replaceAll("'","''")+"'";
const selectedList=(values:string[])=>values.map(selectedLiteral).join(',');
const selectedNs=()=>selectedList(selectedOracle.N);
const selectedAclSql=(field:string,owner:string,kind='f')=>"(SELECT coalesce(jsonb_agg(jsonb_build_object('grantee',CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,'grantor',pg_get_userbyid(x.grantor),'privilege',x.privilege_type,'grantable',x.is_grantable) ORDER BY x.grantee,x.grantor,x.privilege_type),'[]'::jsonb) FROM pg_catalog.aclexplode(coalesce("+field+",pg_catalog.acldefault('"+kind+"',"+owner+"))) x)";
async function selectedRead<T>(q:ISql,query:string,budget:SelectedBudget):Promise<T[]>{
 budget.guard();const result=await q.unsafe<{value:T}[]>(query);
 selectedNeed(result.length<=40000);const values=result.map(row=>row.value);budget.capture(values,values.length);return values;
}
async function selectedConnection(q:ISql,budget:SelectedBudget){
 const rows=await selectedRead<SelectedConnection&{pid:number;backendStart:string}>(q,
  "SELECT jsonb_build_object('serverAddress',pg_catalog.host(inet_server_addr()),'serverPort',inet_server_port(),'clientAddress',pg_catalog.host(inet_client_addr()),'database',current_database(),'databaseOid',d.oid::text,'owner',pg_get_userbyid(d.datdba),'current',current_user,'session',session_user,"+
  "'systemIdentifier',(SELECT system_identifier::text FROM pg_catalog.pg_control_system()),'startedAt',pg_catalog.pg_postmaster_start_time()::text,'pid',pg_backend_pid(),'backendStart',a.backend_start::text) AS value "+
  "FROM pg_catalog.pg_database d JOIN pg_catalog.pg_stat_activity a ON a.pid=pg_backend_pid() WHERE d.datname=current_database()",budget);
 selectedEqual(rows.length,1);selectedInt(rows[0].pid,2);selectedNeed(typeof rows[0].backendStart==='string');
 selectedEqual({serverAddress:rows[0].serverAddress,serverPort:rows[0].serverPort,clientAddress:rows[0].clientAddress},{serverAddress:'127.0.0.1',serverPort:5433,clientAddress:'127.0.0.1'});
 return rows[0];
}
async function selectedCluster(q:ISql,budget:SelectedBudget){
 const rows=await selectedRead<SelectedCluster>(q,"SELECT jsonb_build_object('systemIdentifier',(SELECT system_identifier::text FROM pg_catalog.pg_control_system()),'startedAt',pg_catalog.pg_postmaster_start_time()::text,"+
  "'version',current_setting('server_version_num')::int,'jit',current_setting('jit'),'jitAvailable',pg_catalog.pg_jit_available(),'maxConnections',current_setting('max_connections')::int,'maxLocks',current_setting('max_locks_per_transaction')::int) AS value",budget);
 selectedEqual(rows.length,1);return rows[0];
}
async function selectedGlobal(q:ISql,role:string|null,budget:SelectedBudget){
 const roles=await selectedRead<SelectedRole>(q,
  "SELECT jsonb_build_object('oid',r.oid::text,'name',r.rolname,'login',r.rolcanlogin,'super',r.rolsuper,'inherit',r.rolinherit,'createRole',r.rolcreaterole,'createDb',r.rolcreatedb,"+
  "'replication',r.rolreplication,'bypassRls',r.rolbypassrls,'connectionLimit',r.rolconnlimit,'passwordNull',r.rolpassword IS NULL,'validUntil',r.rolvaliduntil::text,'config',settings.setconfig) AS value "+
  "FROM pg_catalog.pg_authid r LEFT JOIN pg_catalog.pg_db_role_setting settings ON settings.setrole=r.oid AND settings.setdatabase=0 ORDER BY r.oid LIMIT 40001",budget);
 const memberships=await selectedRead<SelectedMember>(q,
  "SELECT jsonb_build_object('role',pg_get_userbyid(m.roleid),'member',pg_get_userbyid(m.member),'grantor',pg_get_userbyid(m.grantor),'inherit',m.inherit_option,'set',m.set_option,'admin',m.admin_option) AS value "+
  "FROM pg_catalog.pg_auth_members m ORDER BY m.roleid,m.member,m.grantor LIMIT 40001",budget);
 const databases=await selectedRead<SelectedDatabase>(q,
  "SELECT jsonb_build_object('oid',d.oid::text,'name',d.datname,'owner',pg_get_userbyid(d.datdba),'template',d.datistemplate,'allowConnections',d.datallowconn) AS value "+
  "FROM pg_catalog.pg_database d ORDER BY d.datname LIMIT 40001",budget);
 const shared=await selectedRead<Omit<SelectedShared,'identity'>>(q,
  "SELECT jsonb_build_object('databaseOid',s.dbid::text,'role',r.rolname,'className',CASE WHEN n.nspname='pg_catalog' THEN c.relname ELSE NULL END,'objectOid',s.objid::text,'subId',s.objsubid,'dependency',s.deptype) AS value "+
  "FROM pg_catalog.pg_shdepend s JOIN pg_catalog.pg_authid r ON r.oid=s.refobjid JOIN pg_catalog.pg_class c ON c.oid=s.classid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace "+
  "WHERE s.refclassid='pg_catalog.pg_authid'::regclass AND r.rolname IN("+selectedNs()+") ORDER BY s.dbid,r.rolname,s.classid,s.objid,s.objsubid,s.deptype LIMIT 40001",budget);
 if(role!==null)selectedNeed(roles.some(row=>row.name===role));return {roles,memberships,databases,shared};
}
async function selectedFunctions(q:ISql,names:string[],budget:SelectedBudget){
 return selectedRead<SelectedFunction>(q,
  "SELECT jsonb_build_object('oid',p.oid::text,'identity',p.oid::regprocedure::text,'name',p.proname,'owner',pg_get_userbyid(p.proowner),"+
  "'bodySha256',encode(sha256(convert_to(p.prosrc,'UTF8')),'hex'),'arguments',pg_get_function_arguments(p.oid),'result',pg_get_function_result(p.oid),'language',l.lanname,"+
  "'secdef',p.prosecdef,'strict',p.proisstrict,'volatility',p.provolatile,'parallel',p.proparallel,'leakproof',p.proleakproof,'kind',p.prokind,'retset',p.proretset,'cost',p.procost,'rows',p.prorows,'config',p.proconfig,"+
  "'acl',"+selectedAclSql('p.proacl','p.proowner')+") AS value FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace JOIN pg_catalog.pg_language l ON l.oid=p.prolang "+
  "WHERE n.nspname='app' AND p.proname IN("+selectedList(names)+") ORDER BY p.proname,p.oid LIMIT 40001",budget);
}
async function selectedLedger(q:ISql,budget:SelectedBudget){
 const present=await q.unsafe<{present:string|null}[]>("SELECT to_regclass('drizzle.__drizzle_migrations')::text AS present");budget.capture(present,present.length);selectedEqual(present.length,1);
 if(present[0].present===null)return []as {id:number;hash:string;created_at:string}[];
 const rows=await q.unsafe<{id:number;hash:string;created_at:string}[]>("SELECT id,hash,created_at::text AS created_at FROM drizzle.__drizzle_migrations ORDER BY id LIMIT 40001");
 budget.capture(rows,rows.length);selectedNeed(rows.length<=40000);
 let previous=0;for(const row of rows){selectedInt(row.id,1);selectedNeed(row.id>previous);previous=row.id;selectedNeed(typeof row.hash==='string'&&/^[a-f0-9]{64}(?![\s\S])/.test(row.hash)&&typeof row.created_at==='string'&&/^[0-9]+(?![\s\S])/.test(row.created_at));}
 return Array.from(rows);
}
async function selectedSnapshotRead(q:ISql,budget:SelectedBudget,empty=false):Promise<SelectedSnapshot>{
 const actual=await selectedConnection(q,budget),{pid:_pid,backendStart:_backendStart,...connection}=actual;
 selectedEqual(connection.current,'postgres');selectedEqual(connection.session,'postgres');
 const ledger=await selectedLedger(q,budget);
 const stamped=await q.unsafe<{present:string|null}[]>("SELECT to_regclass('public._test_template_fingerprint')::text AS present");budget.capture(stamped,stamped.length);selectedEqual(stamped.length,1);
 let fingerprints:string[]|null=null;
 if(stamped[0].present!==null){const rows=await q.unsafe<{fingerprint:string}[]>("SELECT fingerprint FROM public._test_template_fingerprint ORDER BY fingerprint LIMIT 40001");budget.capture(rows,rows.length);selectedNeed(rows.length<=40000);fingerprints=rows.map(row=>row.fingerprint);}
 if(empty){
  const rows=await q.unsafe<{count:number}[]>("SELECT ((SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%')"+
   "+(SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT IN('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%')"+
   "+(SELECT count(*) FROM pg_catalog.pg_namespace WHERE nspname IN('app','drizzle')))::int AS count");budget.capture(rows,rows.length);selectedEqual(rows.length,1);
  return {connection,ledgerCount:ledger.length,ledgerRowsSha256:selectedDigest(ledger),fingerprints,emptyObjects:rows[0].count,functions:[],relations:[],policies:[],schemas:[],sequence:null,shared:[]};
 }
 const functions=await selectedFunctions(q,selectedOracle.functions.map(row=>row.name),budget);
 const relnames=Object.keys(selectedOracle.columnTypes).map(name=>name.slice('public.'.length));
 const relations=await selectedRead<SelectedRelation>(q,
  "SELECT jsonb_build_object('oid',c.oid::text,'identity',n.nspname||'.'||c.relname,'owner',pg_get_userbyid(c.relowner),'kind',c.relkind,'rls',c.relrowsecurity,'force',c.relforcerowsecurity,"+
  "'acl',"+selectedAclSql('c.relacl','c.relowner','r')+",'columns',(SELECT coalesce(jsonb_agg(jsonb_build_object('number',a.attnum,'name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'typeSchema',tn.nspname,"+
  "'acl',(SELECT coalesce(jsonb_agg(jsonb_build_object('grantee',CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,'grantor',pg_get_userbyid(x.grantor),'privilege',x.privilege_type,'grantable',x.is_grantable) ORDER BY x.grantee,x.grantor,x.privilege_type),'[]'::jsonb) FROM pg_catalog.aclexplode(a.attacl) x)) ORDER BY a.attnum),'[]'::jsonb) "+
  "FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_type t ON t.oid=a.atttypid JOIN pg_catalog.pg_namespace tn ON tn.oid=t.typnamespace WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)) AS value "+
  "FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN("+selectedList(relnames)+") ORDER BY c.relname LIMIT 40001",budget);
 budget.objects(relations.reduce((count,row)=>count+row.columns.length,0));
 const policies=await selectedRead<SelectedPolicy>(q,
  "SELECT jsonb_build_object('oid',p.oid::text,'name',p.polname,'relation',n.nspname||'.'||c.relname,'command',p.polcmd,'permissive',p.polpermissive,"+
  "'roles',(SELECT jsonb_agg(CASE WHEN r.oid=0 THEN 'PUBLIC' ELSE pg_get_userbyid(r.oid) END ORDER BY r.oid) FROM unnest(p.polroles) r(oid)),'using',pg_get_expr(p.polqual,p.polrelid,true),'check',pg_get_expr(p.polwithcheck,p.polrelid,true)) AS value "+
  "FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid=p.polrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN("+selectedList(relnames)+") ORDER BY c.relname,p.polname LIMIT 40001",budget);
 const schemas=await selectedRead<SelectedSchema>(q,"SELECT jsonb_build_object('oid',n.oid::text,'name',n.nspname,'owner',pg_get_userbyid(n.nspowner),'acl',"+selectedAclSql('n.nspacl','n.nspowner','n')+") AS value "+
  "FROM pg_catalog.pg_namespace n WHERE n.nspname IN('public','app') ORDER BY n.nspname",budget);
 const sequences=await selectedRead<SelectedSequence>(q,
  "SELECT jsonb_build_object('oid',c.oid::text,'identity',n.nspname||'.'||c.relname,'owner',pg_get_userbyid(c.relowner),'type',format_type(s.seqtypid,NULL),'start',s.seqstart::text,'increment',s.seqincrement::text,'minimum',s.seqmin::text,'maximum',s.seqmax::text,'cache',s.seqcache::text,'cycle',s.seqcycle,"+
  "'tableOid',d.refobjid::text,'columnNumber',d.refobjsubid,'dependency',d.deptype,'acl',"+selectedAclSql('c.relacl','c.relowner','S')+") AS value "+
  "FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_sequence s ON s.seqrelid=c.oid JOIN pg_catalog.pg_depend d ON d.classid='pg_catalog.pg_class'::regclass AND d.objid=c.oid AND d.objsubid=0 AND d.refclassid='pg_catalog.pg_class'::regclass AND d.deptype IN('a','i') "+
  "WHERE c.oid=to_regclass(pg_get_serial_sequence('public.domain_event','sequence')) LIMIT 40001",budget);
 selectedEqual(sequences.length,1);
 const shared=await selectedRead<SelectedShared>(q,
  "SELECT jsonb_build_object('databaseOid',s.dbid::text,'role',rr.rolname,'className',CASE WHEN cn.nspname='pg_catalog' THEN cl.relname ELSE NULL END,'objectOid',s.objid::text,'subId',s.objsubid,'dependency',s.deptype,"+
  "'identity',CASE WHEN s.classid='pg_catalog.pg_proc'::regclass AND pp.oid IS NOT NULL AND s.objsubid=0 THEN pn.nspname||'.'||pp.proname||'('||pg_get_function_identity_arguments(pp.oid)||')' "+
  "WHEN s.classid='pg_catalog.pg_namespace'::regclass AND nn.oid IS NOT NULL AND s.objsubid=0 THEN nn.nspname "+
  "WHEN s.classid='pg_catalog.pg_class'::regclass AND cc.oid IS NOT NULL THEN ccns.nspname||'.'||cc.relname||CASE WHEN s.objsubid=0 THEN '' WHEN aa.attnum IS NOT NULL THEN '.'||aa.attname ELSE '#unknown' END "+
  "WHEN s.classid='pg_catalog.pg_policy'::regclass AND pol.oid IS NOT NULL AND s.objsubid=0 THEN polns.nspname||'.'||polc.relname||'#'||pol.polname ELSE NULL END) AS value "+
  "FROM pg_catalog.pg_shdepend s JOIN pg_catalog.pg_authid rr ON rr.oid=s.refobjid JOIN pg_catalog.pg_class cl ON cl.oid=s.classid JOIN pg_catalog.pg_namespace cn ON cn.oid=cl.relnamespace "+
  "LEFT JOIN pg_catalog.pg_proc pp ON s.classid='pg_catalog.pg_proc'::regclass AND pp.oid=s.objid LEFT JOIN pg_catalog.pg_namespace pn ON pn.oid=pp.pronamespace "+
  "LEFT JOIN pg_catalog.pg_namespace nn ON s.classid='pg_catalog.pg_namespace'::regclass AND nn.oid=s.objid "+
  "LEFT JOIN pg_catalog.pg_class cc ON s.classid='pg_catalog.pg_class'::regclass AND cc.oid=s.objid LEFT JOIN pg_catalog.pg_namespace ccns ON ccns.oid=cc.relnamespace LEFT JOIN pg_catalog.pg_attribute aa ON aa.attrelid=cc.oid AND aa.attnum=s.objsubid AND NOT aa.attisdropped "+
  "LEFT JOIN pg_catalog.pg_policy pol ON s.classid='pg_catalog.pg_policy'::regclass AND pol.oid=s.objid LEFT JOIN pg_catalog.pg_class polc ON polc.oid=pol.polrelid LEFT JOIN pg_catalog.pg_namespace polns ON polns.oid=polc.relnamespace "+
  "WHERE s.refclassid='pg_catalog.pg_authid'::regclass AND rr.rolname IN("+selectedNs()+") AND s.dbid=(SELECT oid FROM pg_catalog.pg_database WHERE datname=current_database()) ORDER BY rr.rolname,s.classid,s.objid,s.objsubid,s.deptype LIMIT 40001",budget);
 // Function identity arguments include names; the source ABI identity uses types.
 // Resolve through the independently captured actual overload rather than text
 // dropping arbitrary identifiers or accepting caller-chosen object names.
 for(const row of shared)if(row.className==='pg_proc'){
  const fn=functions.find(value=>value.oid===row.objectOid);
  row.identity=fn?.identity??row.identity;
 }
 return {connection,ledgerCount:ledger.length,ledgerRowsSha256:selectedDigest(ledger),fingerprints,emptyObjects:null,functions,relations,policies,schemas,sequence:sequences[0],shared};
}

type SelectedLedger={id:number;hash:string;created_at:string};
type SelectedJournal={version:string;dialect:string;entries:{idx:number;version:string;when:number;tag:string;breakpoints:boolean}[]};
const selectedHistorical={
 '0180_profile_option':{hash:'ae128e75c9491bd1d39537fdddd18ad9307b2050f813b8a056d473dcfda9d41f',when:1781862179000},
 '0212_dashboard_card_config':{hash:'aa9337028da35cd3816d8d66486455595e36aea709c98405868ca36320c99f41',when:1781862211000},
}as const;
function selectedRegular(path:string,maximum=4*1024*1024){
 selectedNeed(resolve(path)===path&&realpathSync(path)===path);const stat=lstatSync(path);
 selectedNeed(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size<=maximum);
 return readFileSync(path);
}
function selectedSource(){
 const root=realpathSync(process.cwd());selectedEqual(root,resolve(process.cwd()));
 const journal=JSON.parse(selectedRegular(join(root,'db/migrations/meta/_journal.json')).toString('utf8'))as SelectedJournal;
 selectedNeed(journal&&Array.isArray(journal.entries)&&journal.entries.length===755);
 selectedEqual(selectedDigest(journal.entries),selectedOracle.tupleSha755);selectedEqual(selectedDigest(journal.entries.slice(0,717)),selectedOracle.tupleSha717);
 const expected=journal.entries.map(row=>{
  selectedInt(row.idx);selectedInt(row.when,1);selectedNeed(typeof row.tag==='string'&&/^[A-Za-z0-9_-]{1,180}(?![\s\S])/.test(row.tag));
  selectedEqual(row.version,'7');selectedEqual(row.breakpoints,true);return row.tag+'.sql';
 });
 selectedUnique(expected);selectedEqual(readdirSync(join(root,'db/migrations')).filter(name=>name.endsWith('.sql')).sort(),[...expected].sort());
 const pairs=journal.entries.map(row=>[row.tag,selectedHash(selectedRegular(join(root,'db/migrations',row.tag+'.sql')))]);
 selectedEqual(selectedDigest(pairs),selectedOracle.sqlPairSha755);selectedEqual(selectedDigest(pairs.slice(0,717)),selectedOracle.sqlPairSha717);
 const digest=createHash('sha256');
 for(const file of [...expected].sort())digest.update(file).update(selectedRegular(join(root,'db/migrations',file)));
 for(const file of ['db/migrations/meta/_journal.json','packs/catalog.ts','test/helpers/personnel-draft-discard-ci-role-fixture.ts'])digest.update(file).update(selectedRegular(join(root,file)));
 selectedEqual(digest.digest('hex'),selectedOracle.templateFingerprint);
 for(const [tag,original]of Object.entries(selectedHistorical)){
  selectedEqual(selectedHash(selectedRegular(join(root,'.github/ci/historical-migrations',tag+'.sql'))),original.hash);
  selectedEqual(journal.entries.find(row=>row.tag===tag)?.when,original.when);
 }
 return {root,journal,pairs};
}
function selectedConfiguration(){
 const env=process.env;selectedEqual(process.platform,'linux');selectedEqual(env.GITHUB_ACTIONS,'true');selectedEqual(env.RUNNER_ENVIRONMENT,'github-hosted');
 selectedEqual(env.GITHUB_REPOSITORY,'StradaverseHub/ai-hr');selectedEqual(env.GITHUB_RUN_ATTEMPT,'1');
 const full=env.GITHUB_WORKFLOW==='alpha-staging-ci'&&typeof env.AIHR_CI_SINGLETON_BINDING==='string';
 const focused=env.GITHUB_WORKFLOW==='alpha-focused-checks'&&env.AIHR_FOCUSED_SUITE_CAPACITY==='true';
 selectedNeed(full!==focused);const mode=full?'full':'focused';
 selectedEqual(env.GITHUB_JOB,full?'test':'selected-tests');selectedEqual(env.VITEST_MAX_WORKERS,full?'1':'2');selectedEqual(env.VITEST_MAX_WORKERS_NODB,full?'1':'2');
 if(full){selectedNeed(env.TEST_DB_NAMESPACE===undefined||env.TEST_DB_NAMESPACE==='');selectedNeed(!Object.keys(env).some(key=>key.startsWith('AIHR_FOCUSED_')));}
 else{
  selectedEqual(env.TEST_DB_NAMESPACE,'aifocus');selectedNeed(!Object.keys(env).some(key=>key.startsWith('AIHR_CI_SINGLETON_')));
  const selected=JSON.parse(env.AIHR_FOCUSED_TESTS??'null');selectedNeed(Array.isArray(selected)&&selected.length===1&&[
   'test/ai-centre-architecture-compatibility-upgrade.test.ts','test/ai-centre-mandate-write-order-upgrade.test.ts',
  ].includes(selected[0]));
 }
 selectedEqual(env.AIHR_CI_PG_PROFILE,'2');selectedEqual(env.AIHR_CI_PG_CONFIGURED_CAP_BYTES,'2113929216');selectedEqual(env.AIHR_CI_PG_PEAK_BUDGET_BYTES,'2147483648');selectedEqual(env.AIHR_CI_PG_JIT,'on');
 const pool=env.VITEST_POOL_ID??env.VITEST_WORKER_ID;selectedNeed(typeof pool==='string'&&/^[12](?![\s\S])/.test(pool));if(full)selectedEqual(pool,'1');
 selectedNeed(env.WORKER_DB!=='0');
 const url=new URL(env.TEST_MIGRATION_DATABASE_URL!);selectedNeed(['postgres:','postgresql:'].includes(url.protocol));
 selectedEqual({host:url.hostname,port:url.port,user:url.username,password:url.password,path:url.pathname,search:url.search,hash:url.hash},
 {host:'127.0.0.1',port:'5433',user:'postgres',password:'',path:'/'+workerDb(pool!),search:'',hash:''});
 for(const [key,user]of Object.entries({MIGRATION_DATABASE_URL:'postgres',DATABASE_URL:'ai_hr_app',TEST_DATABASE_URL:'ai_hr_app'})){
  const actual=new URL(env[key]!);selectedEqual({host:actual.hostname,port:actual.port,user:actual.username,password:actual.password,path:actual.pathname,search:actual.search,hash:actual.hash},
   {host:url.hostname,port:url.port,user,password:'',path:url.pathname,search:'',hash:''});
 }
 const temp=realpathSync(env.RUNNER_TEMP!),directory=join(temp,full?'aihr-ci':'aihr-focused');selectedEqual(realpathSync(directory),directory);
 if(focused)selectedEqual(env.AIHR_FOCUSED_EVIDENCE_DIR,directory);
 return {mode:mode as 'full'|'focused',url,directory};
}
function selectedFolder(folder:string,source:ReturnType<typeof selectedSource>){
 selectedNeed(resolve(folder)===folder&&realpathSync(folder)===folder&&dirname(folder)===realpathSync(selectedTmpdir()));
 selectedNeed(/^aihr-ai-(?:compat|write-order)-[A-Za-z0-9]{6}(?![\s\S])/.test(basename(folder)));
 const stat=lstatSync(folder);selectedNeed(stat.isDirectory()&&!stat.isSymbolicLink()&&stat.uid===process.getuid!()&&(stat.mode&0o077)===0);
 const known=new Set(source.journal.entries.map(row=>row.tag+'.sql'));
 for(const file of readdirSync(folder).filter(name=>name.endsWith('.sql'))){
  selectedNeed(known.has(file));const tag=file.slice(0,-4),original=selectedHistorical[tag as keyof typeof selectedHistorical];
  const expected=original?.hash??source.pairs.find(row=>row[0]===tag)![1];
  selectedEqual(selectedHash(selectedRegular(join(folder,file))),expected);
 }
 for(const row of source.journal.entries.slice(0,717))selectedNeed(lstatSync(join(folder,row.tag+'.sql')).isFile());
 selectedNeed(realpathSync(join(folder,'meta'))===join(folder,'meta')&&lstatSync(join(folder,'meta')).isDirectory());
}
function selectedPrivateLedger(ledger:SelectedLedger[],source:ReturnType<typeof selectedSource>,count:number,prefix?:SelectedLedger[]){
 selectedEqual(ledger.length,count);if(prefix)selectedEqual(ledger.slice(0,prefix.length),prefix);
 selectedEqual(ledger.map(row=>({hash:row.hash,created_at:row.created_at})),source.journal.entries.slice(0,count).map(row=>({
  hash:selectedHistorical[row.tag as keyof typeof selectedHistorical]?.hash??source.pairs.find(pair=>pair[0]===row.tag)![1],created_at:String(row.when),
 })));
}
async function selectedReadonly<T>(client:Sql,run:(q:ISql)=>Promise<T>):Promise<T>{
 return client.begin(async tx=>{
  await tx.unsafe("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  await tx.unsafe("SET LOCAL statement_timeout='10s'");await tx.unsafe("SET LOCAL lock_timeout='5s'");await tx.unsafe("SET LOCAL search_path=pg_catalog,public");
  return run(tx);
 })as unknown as Promise<T>;
}
async function selectedPidAbsent(observer:Sql,pid:number,start:string,deadline:number,budget:SelectedBudget){
 for(;;){
  const rows=await observer.unsafe<{pid:number}[]>("SELECT pid FROM pg_catalog.pg_stat_activity WHERE pid="+pid+" AND backend_start::text="+selectedLiteral(start));
  budget.capture(rows,rows.length);if(rows.length===0)return;
  selectedNeed(performance.now()<deadline,'Selected reserved slot settlement uncertain');
  await new Promise<void>(resolve=>setTimeout(resolve,Math.min(20,Math.max(1,deadline-performance.now()))));
 }
}
async function selectedClose(client:Sql,observer:Sql,identity:{pid:number;backendStart:string}|null,budget:SelectedBudget){
 const deadline=performance.now()+5000;let timer:ReturnType<typeof setTimeout>|undefined;const wasCleanup=budget.cleanup;budget.cleanup=true;
 try{
  const settling=(async()=>{
   await client.end({timeout:5});selectedNeed(identity,'Selected reserved slot identity not captured');
   await selectedPidAbsent(observer,identity!.pid,identity!.backendStart,deadline,budget);
  })();
  // One wall-clock bound covers BOTH socket closure and the native observer.
  // A timed-out observer remains uncertain; the caller must not reuse the slot.
  await Promise.race([settling,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Selected reserved slot close or native settlement uncertain')),Math.max(1,deadline-performance.now()));})]);
 }finally{clearTimeout(timer);budget.cleanup=wasCleanup;}
}
async function selectedJobCapture(storage:Sql,observer:Sql,database:string,role:string,configuration:ReturnType<typeof selectedConfiguration>,budget:SelectedBudget){
 const initial=await selectedReadonly(storage,async q=>{
  const connection=await selectedConnection(q,budget),cluster=await selectedCluster(q,budget),global=await selectedGlobal(q,role,budget);
  selectedEqual({database:connection.database,current:connection.current,session:connection.session,owner:connection.owner},{database,current:'postgres',session:'postgres',owner:role});
  const owner=global.roles.find(row=>row.name===role);selectedNeed(owner);selectedBoundRole(owner!,role);
  for(const name of selectedOracle.N){const n=global.roles.find(row=>row.name===name);selectedNeed(n,'Selected755 prelude role absent; provisioning is not this course');selectedBoundRole(n!,name);}
  const privateLedger=await selectedLedger(q,budget);
  return {connection,cluster,global,owner:owner!,privateLedger};
 });
 const observed=await selectedReadonly(observer,q=>selectedConnection(q,budget));
 selectedEqual({database:observed.database,current:observed.current,session:observed.session,system:observed.systemIdentifier,start:observed.startedAt},
  {database:'postgres',current:'postgres',session:'postgres',system:initial.cluster.systemIdentifier,start:initial.cluster.startedAt});
 const owned={database,databaseOid:initial.connection.databaseOid,role,roleOid:initial.owner.oid};
 const readers=await selectedReaders(observer,configuration,initial.cluster,budget);
 const model:AiCentreSelectedJobModel={evidence:'native-readonly',mode:configuration.mode,cluster:initial.cluster,
  source:{tuples:selectedOracle.tupleSha755,sql:selectedOracle.sqlPairSha755,fingerprint:selectedOracle.templateFingerprint},
  ...initial.global,owned,readers};
 assertAiCentreSelectedJobCatalogue(model);selectedEqual(model.evidence,'native-readonly');
 return {model,privateLedger:initial.privateLedger};
}

async function selectedReaders(observer:Sql,configuration:ReturnType<typeof selectedConfiguration>,cluster:SelectedCluster,budget:SelectedBudget){
 const readers:SelectedSnapshot[]=[];
 const names=selectedNames(configuration.mode);
 // Empty-base read is an explicit additional SERIAL lifetime, not a fifth slot.
 for(const name of ['ai_hr_dev','ai_hr_test',names.template,...names.workers]){
  budget.guard();const url=new URL(configuration.url);url.pathname='/'+name;
  const client=postgres(url.toString(),{max:1,onnotice:()=>{},connection:{statement_timeout:'10000',lock_timeout:'5000'}});
  let identity:{pid:number;backendStart:string}|null=null,primary:unknown;
  try{
   const snapshot=await selectedReadonly(client,async q=>{
    identity=await selectedConnection(q,budget);selectedEqual((identity as SelectedConnection).database,name);
    return selectedSnapshotRead(q,budget,name==='ai_hr_test');
   });
   selectedSnapshot(snapshot,'postgres',cluster,name==='ai_hr_test');readers.push(snapshot);
  }catch(error){primary=error;}
  try{await selectedClose(client,observer,identity,budget);}catch(error){throw new AggregateError([...(primary?[primary]:[]),error],'Selected serial metadata lifetime did not settle');}
  if(primary)throw primary;
 }
 return readers;
}

async function selectedDefaultAcls(q:ISql,budget:SelectedBudget){
 return selectedRead<{owner:string;schema:string;kind:string;acl:Acl[]}>(q,
  "SELECT jsonb_build_object('owner',pg_get_userbyid(d.defaclrole),'schema',n.nspname,'kind',d.defaclobjtype,'acl',"+selectedAclSql('d.defaclacl','d.defaclrole','r')+") AS value FROM pg_catalog.pg_default_acl d LEFT JOIN pg_catalog.pg_namespace n ON n.oid=d.defaclnamespace ORDER BY d.defaclrole,d.defaclnamespace,d.defaclobjtype LIMIT 40001",budget);
}
function selectedExpectedDefaults(role:string){
 return ['r','S'].map(kind=>({owner:role,schema:'public',kind,acl:sorted((kind==='r'?['SELECT','INSERT','UPDATE','DELETE']:['SELECT','USAGE']).map(privilege=>({grantee:'ai_hr_app',grantor:role,privilege,grantable:false})))}));
}
function selectedDefaults(actual:{owner:string;schema:string;kind:string;acl:Acl[]}[],role:string){
 selectedEqual(selectedSorted(actual.map(row=>({...row,acl:sorted(row.acl)}))),selectedSorted(selectedExpectedDefaults(role)),'Selected actual-M public default ACLs differ');
}
async function selectedPrivateIdentity(q:ISql,model:AiCentreSelectedJobModel,budget:SelectedBudget){
 const actual=await selectedConnection(q,budget);
 selectedEqual({database:actual.database,databaseOid:actual.databaseOid,owner:actual.owner,current:actual.current,session:actual.session,systemIdentifier:actual.systemIdentifier,startedAt:actual.startedAt},
 {database:model.owned.database,databaseOid:model.owned.databaseOid,owner:model.owned.role,current:'postgres',session:'postgres',systemIdentifier:model.cluster.systemIdentifier,startedAt:model.cluster.startedAt});
 const rows=await q.unsafe<{oid:string}[]>("SELECT oid::text AS oid FROM pg_catalog.pg_authid WHERE rolname="+selectedLiteral(model.owned.role));budget.capture(rows,rows.length);selectedEqual(rows,[{oid:model.owned.roleOid}]);
}
async function selectedOneFunction(q:ISql,name:string,budget:SelectedBudget){
 const rows=await selectedFunctions(q,[name],budget);selectedEqual(rows.length,1);return rows[0];
}
async function selectedLegacyFunction(q:ISql,role:string,identity:string,budget:SelectedBudget){
 // Same whole row representation as inventory(), restricted to the one causal
 // CREATE/GRANT change. This does not substitute a partial scan for rollback.
 const rows=await q.unsafe<ObjectRow[]>("SELECT 'function' AS kind,format('%I.%I(%s)',n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)) AS identity,pg_get_userbyid(p.proowner) AS owner,"+
  "false AS move,NULL::text AS command,to_jsonb(p)-'proowner'-'proacl' AS attributes,"+selectedAclSql('p.proacl','p.proowner')+" AS acl,pg_get_functiondef(p.oid) AS definition "+
  "FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE p.oid="+selectedLiteral(identity)+"::regprocedure");
 budget.capture(rows,rows.length);selectedEqual(rows.length,1);selectedEqual(rows[0].owner,role);return rows[0];
}
function selectedPatchInventory(rows:ObjectRow[],changed:ObjectRow[]){
 const result=rows.map(row=>({...row}));
 for(const replacement of changed){const found=result.filter(row=>row.kind===replacement.kind&&row.identity===replacement.identity);selectedEqual(found.length,1);const at=result.indexOf(found[0]);result[at]={...replacement,move:found[0].move,command:found[0].command};}
 return result;
}
async function selectedDataDigest(q:ISql,budget:SelectedBudget){
 const tables=await q.unsafe<{identity:string}[]>("SELECT format('%I.%I',n.nspname,c.relname) AS identity FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('public','app') AND c.relkind IN('r','p') ORDER BY n.nspname,c.relname LIMIT 40001");
 budget.capture(tables,tables.length);selectedNeed(tables.length<=40000);
 const facts:{identity:string;count:string;hash:string}[]=[];
 for(const table of tables){budget.guard();const rows=await q.unsafe<{count:string;hash:string}[]>("SELECT count(*)::text AS count,encode(sha256(convert_to(coalesce(string_agg(value,E'\\n' ORDER BY value),''),'UTF8')),'hex') AS hash FROM (SELECT to_jsonb(t)::text AS value FROM "+table.identity+" t LIMIT 40001) x");
  budget.capture(rows,rows.length);selectedEqual(rows.length,1);selectedNeed(BigInt(rows[0].count)<=BigInt(40000),'Private fictional data frontier exceeded');facts.push({identity:table.identity,...rows[0]});}
 return selectedDigest(facts);
}
async function selectedBaselineHelpers(storage:Sql,role:string,budget:SelectedBudget){
 const changed:ObjectRow[]=[];
 for(const spec of selectedOracle.baselineFunctions){
  const before=await selectedOneFunction(storage,spec.name,budget),owner=spec.owner;
  const stableSpec={...spec,aclGrantees:spec.aclGrantees.filter(name=>name!=='$creator')};
  // The disposable postgres bootstrap may retain only its specific explicit
  // execute edge. No other ACL, grant option, owner, body or overload is admitted.
  const ordinary=before.acl.filter(row=>row.grantee!=='postgres');selectedKnownFunction({...before,acl:ordinary},stableSpec,role);
  const previous=before.acl.filter(row=>row.grantee==='postgres');
  selectedNeed(previous.length<=1);if(previous.length)selectedAcl(previous,[{grantee:'postgres',grantor:owner,privilege:'EXECUTE',grantable:false}]);
  await storage.begin(async tx=>{
   await tx.unsafe('SET LOCAL ROLE '+quote(owner));
   await tx.unsafe('GRANT EXECUTE ON FUNCTION '+spec.identity+' TO '+quote(role));
   if(previous.length)await tx.unsafe('REVOKE EXECUTE ON FUNCTION '+spec.identity+' FROM postgres');
  });
  const after=await selectedOneFunction(storage,spec.name,budget);selectedEqual(after.oid,before.oid);selectedKnownFunction(after,spec,role);
  changed.push(await selectedLegacyFunction(storage,owner,spec.identity,budget));
 }
 return changed;
}
async function selectedRoleDeltas(q:ISql,model:AiCentreSelectedJobModel,budget:SelectedBudget,temporary:boolean){
 const global=await selectedGlobal(q,model.owned.role,budget);
 selectedEqual(global.roles,model.roles);selectedEqual(global.databases,model.databases);
 const expected=[...model.memberships,
  ...[['ai_hr_app',false],['ai_hr_draft_discard_port',false],['ai_hr_rewards_post_reader',true]].map(([role,inherit])=>({role,member:model.owned.role,grantor:'postgres',inherit,set:true,admin:false})),
  ...(temporary?selectedOracle.N.map(role=>({role,member:model.owned.role,grantor:'postgres',inherit:true,set:true,admin:false})):[])];
 selectedEqual(selectedSorted(global.memberships),selectedSorted(expected));
 return global;
}
// A private predicate refusal can be distinguished from a failed native query.
// It carries no raw SQL, object identity, credentials or catalogue contents.
const selectedEffectiveCreateRefusal=Error('Selected N effective app CREATE differs');
async function selectedEffectiveAppCreate(q:ISql,budget:SelectedBudget,allowed:boolean){
 const rows=await selectedRead<{role:string;create:boolean}>(q,
  "SELECT jsonb_build_object('role',r.role,'create',pg_catalog.has_schema_privilege(r.role,'app','CREATE')) AS value FROM (VALUES "+
  selectedOracle.N.map(role=>'('+selectedLiteral(role)+'::text)').join(',')+") r(role) ORDER BY r.role",budget);
 selectedEqual(rows.map(row=>row.role),[...selectedOracle.N].sort());
 for(const row of rows)selectedNeed(typeof row.create==='boolean');
 if(rows.some(row=>row.create!==allowed))throw selectedEffectiveCreateRefusal;
}
async function selectedAppCreate(q:ISql,budget:SelectedBudget,allowed:boolean){
 const rows=await selectedRead<{acl:Acl[]}>(q,"SELECT jsonb_build_object('acl',"+selectedAclSql('n.nspacl','n.nspowner','n')+") AS value FROM pg_catalog.pg_namespace n WHERE n.nspname='app'",budget);
 selectedEqual(rows.length,1);const actual=rows[0].acl.filter(row=>selectedOracle.N.includes(row.grantee)&&row.privilege==='CREATE');
 selectedAcl(actual,allowed?selectedOracle.N.map(grantee=>({grantee,grantor:'postgres',privilege:'CREATE',grantable:false})):[]);
 await selectedEffectiveAppCreate(q,budget,allowed);
}
async function selectedMutation(q:ISql,model:AiCentreSelectedJobModel,budget:SelectedBudget,query:string){
 budget.guard();await selectedPrivateIdentity(q,model,budget);await q.unsafe(query);budget.guard();
}
/** The only selected-prefix native-changing owner. Cancellation and the caller's
 * original case clock can refuse work; neither grants a native capability. */
export async function constructAiCentreSelectedPrefixOwner(storage:Sql,admin:Sql,database:string,role:string,folder:string,signal:AbortSignal,caseStartedAt:number){
 const budget=selectedBudget(signal,caseStartedAt),source=selectedSource(),configuration=selectedConfiguration();selectedFolder(folder,source);budget.guard();
 const admission=await selectedJobCapture(storage,admin,database,role,configuration,budget),model=admission.model;
 selectedPrivateLedger(admission.privateLedger,source,710);
 await storage.unsafe("SET statement_timeout='10s'");await storage.unsafe("SET lock_timeout='5s'");
 const noTriggers=await storage.unsafe<{count:number}[]>("SELECT count(*)::int AS count FROM pg_catalog.pg_event_trigger");budget.capture(noTriggers,1);selectedEqual(noTriggers,[{count:0}]);
 const construction=await constructAiCentreCompatibilityOwner(storage,database,role);budget.guard();
 // The unchanged historical constructor performs three whole observations.
 // Count the verified equal intermediate observation, too, in this aggregate.
 budget.capture(construction.before,construction.before.length);budget.capture(construction.after,construction.after.length);budget.capture(construction.after,construction.after.length);
 await selectedBaselineHelpers(storage,role,budget);
 const originalRoles=await selectedLegacyFunction(storage,role,'app.reward_roles(uuid)',budget);
 const originalBody=await selectedOneFunction(storage,'reward_roles',budget);
 selectedEqual(originalBody.bodySha256,selectedOracle.functions.find(row=>row.name==='reward_roles_preparation_audience')!.bodySha256);
 const originalView=await selectedOneFunction(storage,'reward_not_viewing_as',budget);
 selectedKnownFunction(originalView,{...selectedOracle.functions.find(row=>row.name==='reward_not_viewing_as')!,aclGrantees:['ai_hr_reward_view_reader','PUBLIC']},role);
 const originalPolicies=await storage.unsafe("SELECT to_jsonb(p) AS row FROM pg_catalog.pg_policies p WHERE schemaname IN('app','public','drizzle') ORDER BY schemaname,tablename,policyname");budget.capture(originalPolicies,originalPolicies.length);
 const originalTriggers=await storage.unsafe("SELECT to_jsonb(t) AS row FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('app','public','drizzle') ORDER BY t.oid");budget.capture(originalTriggers,originalTriggers.length);
 const originalData=await selectedDataDigest(storage,budget),privateLedger=await selectedLedger(storage,budget);selectedPrivateLedger(privateLedger,source,710);
 selectedEqual(await selectedDefaultAcls(storage,budget),[]);
 await selectedMutation(storage,model,budget,'ALTER DEFAULT PRIVILEGES FOR ROLE '+quote(role)+' IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO ai_hr_app');
 await selectedMutation(storage,model,budget,'ALTER DEFAULT PRIVILEGES FOR ROLE '+quote(role)+' IN SCHEMA public GRANT SELECT,USAGE ON SEQUENCES TO ai_hr_app');
 selectedDefaults(await selectedDefaultAcls(storage,budget),role);
 await selectedRoleDeltas(admin,model,budget,false);await selectedAppCreate(storage,budget,false);
 // Prove PUBLIC cannot hide effective CREATE behind the absence of a direct N
 // ACL. This is one rollback-only mutation of this exact owned private schema.
 const g0=await inventory(storage,'postgres',role);budget.capture(g0,g0.length);
 const g0Ledger=await selectedLedger(storage,budget),publicCreateRollback=Error('Selected private PUBLIC CREATE control rollback');
 let publicCreateRolledBack=false;
 try{await storage.begin(async tx=>{
  budget.guard();await selectedPrivateIdentity(tx,model,budget);
  await tx.unsafe('SET LOCAL ROLE '+quote(role));
  await tx.unsafe('GRANT CREATE ON SCHEMA app TO PUBLIC');
  await tx.unsafe('SET LOCAL ROLE postgres');budget.guard();
  await selectedEffectiveAppCreate(tx,budget,true);
  // selectedAppCreate retains the exact direct ACL check before adjudicating
  // the independently observed effective privileges. Only that predicate's
  // unique refusal proves this expected negative; unrelated errors propagate.
  let refused=false;
  try{await selectedAppCreate(tx,budget,false);}catch(error){if(error!==selectedEffectiveCreateRefusal)throw error;refused=true;}
  selectedNeed(refused,'Selected PUBLIC CREATE control did not refuse');
  budget.guard();throw publicCreateRollback;
 });}catch(error){if(error!==publicCreateRollback)throw error;publicCreateRolledBack=true;}
 selectedNeed(publicCreateRolledBack,'Selected PUBLIC CREATE control did not roll back');budget.guard();
 const g0Restored=await inventory(storage,'postgres',role);budget.capture(g0Restored,g0Restored.length);
 selectedEqual(stable(g0Restored,'postgres',role),stable(g0,'postgres',role),'Whole PUBLIC CREATE rollback differs');
 selectedEqual(await selectedLedger(storage,budget),g0Ledger);await selectedAppCreate(storage,budget,false);
 let migration:ReturnType<typeof createDb>|undefined,ownerIdentity:{pid:number;backendStart:string}|null=null,returned=false,tempMemberships=false,tempCreate=false,tempGrant=false,reservedPoisoned=false,primaryFailure:unknown;
 const viewIdentity='app.reward_not_viewing_as()',viewOwner='ai_hr_reward_view_reader',preparation='ai_hr_reward_preparation_reader';
 const ownerRole=quote(role);
 const cleanupTemporary=async()=>{
  // A failure can leave only these explicitly recorded temporary edges. Do not
  // repair an unknown graph, or drop/recreate any shared native role.
  if(tempGrant){
   const held=await selectedOneFunction(storage,'reward_not_viewing_as',budget);selectedEqual({...held,acl:originalView.acl},originalView);
   const allowed=[...originalView.acl,{grantee:role,grantor:viewOwner,privilege:'EXECUTE',grantable:true},{grantee:preparation,grantor:role,privilege:'EXECUTE',grantable:false},{grantee:preparation,grantor:viewOwner,privilege:'EXECUTE',grantable:false}];
   selectedNeed(held.acl.every(row=>allowed.some(expected=>selectedCanonical(row)===selectedCanonical(expected))),'Unknown outgoing temporary grant chain');
   for(const expected of originalView.acl)selectedNeed(held.acl.some(row=>selectedCanonical(row)===selectedCanonical(expected)));
   await storage.begin(async tx=>{await tx.unsafe('SET LOCAL ROLE '+quote(viewOwner));await tx.unsafe('REVOKE EXECUTE ON FUNCTION '+viewIdentity+' FROM '+ownerRole+' CASCADE');});tempGrant=false;}
  if(tempCreate){await storage.unsafe('REVOKE CREATE ON SCHEMA app FROM '+selectedOracle.N.map(quote).join(','));tempCreate=false;}
  if(tempMemberships){for(const name of selectedOracle.N)await admin.unsafe('REVOKE '+quote(name)+' FROM '+ownerRole);tempMemberships=false;}
 };
 try{
  await selectedPrivateIdentity(storage,model,budget);
  // The app schema is now M-owned. Grantor remains that actual owner, even
  // when the fixed platform connection issues this one temporary grant.
  budget.guard();tempCreate=true;await storage.begin(async tx=>{await tx.unsafe('SET LOCAL ROLE '+ownerRole);await tx.unsafe('GRANT CREATE ON SCHEMA app TO '+selectedOracle.N.map(quote).join(','));});
  tempMemberships=true;for(const name of selectedOracle.N){budget.guard();await admin.unsafe('GRANT '+quote(name)+' TO '+ownerRole+' WITH INHERIT TRUE, SET TRUE, ADMIN FALSE');}
  // Validate CREATE's native M grantor separately from the source prelude ACL.
  const app=await selectedRead<{acl:Acl[]}>(storage,"SELECT jsonb_build_object('acl',"+selectedAclSql('n.nspacl','n.nspowner','n')+") AS value FROM pg_catalog.pg_namespace n WHERE n.nspname='app'",budget);
  selectedEqual(app.length,1);selectedAcl(app[0].acl.filter(row=>selectedOracle.N.includes(row.grantee)&&row.privilege==='CREATE'),selectedOracle.N.map(grantee=>({grantee,grantor:role,privilege:'CREATE',grantable:false})));
  await selectedEffectiveAppCreate(storage,budget,true);
  await selectedRoleDeltas(admin,model,budget,true);
  budget.guard();tempGrant=true;await storage.begin(async tx=>{await tx.unsafe('SET LOCAL ROLE '+quote(viewOwner));await tx.unsafe('GRANT EXECUTE ON FUNCTION '+viewIdentity+' TO '+ownerRole+' WITH GRANT OPTION');});
  const g1=await selectedOneFunction(storage,'reward_not_viewing_as',budget);selectedEqual({...g1,acl:originalView.acl},originalView);
  selectedAcl(g1.acl,[...originalView.acl,{grantee:role,grantor:viewOwner,privilege:'EXECUTE',grantable:true}]);
  // The complete pre-corruption oracle includes BOTH authorized G1 ACL changes.
  const g1Inventory=await inventory(storage,'postgres',role);budget.capture(g1Inventory,g1Inventory.length);
  budget.guard();const login=new URL(configuration.url);login.pathname='/'+database;login.username=role;
  migration=createDb(login.toString(),{max:1});
  const ownerRows=await migration.client.unsafe<{pid:number;backendStart:string;database:string;role:string;login:string;databaseOid:string;loopback:boolean}[]>("SELECT pg_backend_pid() AS pid,a.backend_start::text AS \"backendStart\",current_database() AS database,current_user AS role,session_user AS login,d.oid::text AS \"databaseOid\",inet_server_addr()='127.0.0.1'::inet AS loopback FROM pg_catalog.pg_database d JOIN pg_catalog.pg_stat_activity a ON a.pid=pg_backend_pid() WHERE d.datname=current_database()");
  budget.capture(ownerRows,ownerRows.length);selectedEqual(ownerRows.length,1);const actual=ownerRows[0];selectedInt(actual.pid,2);selectedNeed(typeof actual.backendStart==='string');ownerIdentity={pid:actual.pid,backendStart:actual.backendStart};
  selectedEqual({database:actual.database,role:actual.role,login:actual.login,databaseOid:actual.databaseOid,loopback:actual.loopback},{database,role,login:role,databaseOid:model.owned.databaseOid,loopback:true});
  const corroboration=await admin.unsafe<{datid:string;usename:string}[]>("SELECT datid::text AS datid,usename FROM pg_catalog.pg_stat_activity WHERE pid="+actual.pid+" AND backend_start::text="+selectedLiteral(actual.backendStart));budget.capture(corroboration,corroboration.length);selectedEqual(corroboration,[{datid:model.owned.databaseOid,usename:role}]);
  await migration.client.unsafe("SET statement_timeout='10s'");await migration.client.unsafe("SET lock_timeout='5s'");
  const marker='AS $function$';selectedNeed(typeof originalRoles.definition==='string'&&originalRoles.definition.split(marker).length===2);
  const corrupt=originalRoles.definition.replace(marker,marker+'\n-- reward_roles_preparation_audience');
  budget.guard();await migration.client.unsafe(corrupt);budget.guard();
  const corruptRow=await selectedLegacyFunction(storage,role,'app.reward_roles(uuid)',budget);const expectedCorrupt=selectedPatchInventory(g1Inventory,[corruptRow]);
  writeFileSync(join(folder,'meta/_journal.json'),JSON.stringify({...source.journal,entries:source.journal.entries.slice(0,717)}));
  await expect(migrate(migration.db,{migrationsFolder:folder})).rejects.toMatchObject({cause:{code:'P0001',message:'Preparation audience already installed'}});budget.guard();
  selectedEqual(await selectedLedger(storage,budget),privateLedger);
  const refused=await inventory(storage,'postgres',role);budget.capture(refused,refused.length);selectedEqual(stable(refused,'postgres',role),stable(expectedCorrupt,'postgres',role),'Whole alpha-seven catalogue rollback differs');
  const refusedPolicies=await storage.unsafe("SELECT to_jsonb(p) AS row FROM pg_catalog.pg_policies p WHERE schemaname IN('app','public','drizzle') ORDER BY schemaname,tablename,policyname");budget.capture(refusedPolicies,refusedPolicies.length);selectedEqual(refusedPolicies,originalPolicies);
  const refusedTriggers=await storage.unsafe("SELECT to_jsonb(t) AS row FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('app','public','drizzle') ORDER BY t.oid");budget.capture(refusedTriggers,refusedTriggers.length);selectedEqual(refusedTriggers,originalTriggers);
  selectedEqual(await selectedDataDigest(storage,budget),originalData);selectedDefaults(await selectedDefaultAcls(storage,budget),role);
  budget.guard();await migration.client.unsafe(originalRoles.definition!);budget.guard();
  selectedEqual(await selectedLegacyFunction(storage,role,'app.reward_roles(uuid)',budget),originalRoles);
  budget.guard();await migrate(migration.db,{migrationsFolder:folder});budget.guard();
  const alphaLedger=await selectedLedger(storage,budget);selectedPrivateLedger(alphaLedger,source,717,privateLedger);
  const g2=await selectedOneFunction(storage,'reward_not_viewing_as',budget);selectedEqual({...g2,acl:originalView.acl},originalView);
  selectedAcl(g2.acl,[...g1.acl,{grantee:preparation,grantor:role,privilege:'EXECUTE',grantable:false}]);
  budget.guard();await storage.begin(async tx=>{await tx.unsafe('SET LOCAL ROLE '+quote(viewOwner));await tx.unsafe('GRANT EXECUTE ON FUNCTION '+viewIdentity+' TO '+quote(preparation));});
  const g3=await selectedOneFunction(storage,'reward_not_viewing_as',budget);selectedAcl(g3.acl,[...g2.acl,{grantee:preparation,grantor:viewOwner,privilege:'EXECUTE',grantable:false}]);
  await cleanupTemporary();
  const g5=await selectedOneFunction(storage,'reward_not_viewing_as',budget);selectedEqual({...g5,acl:originalView.acl},originalView);selectedAcl(g5.acl,[...originalView.acl,{grantee:preparation,grantor:viewOwner,privilege:'EXECUTE',grantable:false}]);
  await selectedRoleDeltas(admin,model,budget,false);await selectedAppCreate(storage,budget,false);
  const privateAfter=await selectedReadonly(storage,q=>selectedSnapshotRead(q,budget));selectedNFootprint(privateAfter,role);selectedDefaults(await selectedDefaultAcls(storage,budget),role);
  returned=true;
  return {migration,construction,report:{kind:'FIXED_SOURCE755_PREEXISTING_NATIVE_JOB_710_TO_REAL_OWNER717',releaseAuthorized:false,platformAbsentRoleProvisioningQualified:false,
   source:{tupleSha755:selectedOracle.tupleSha755,sqlPairSha755:selectedOracle.sqlPairSha755,templateFingerprint:selectedOracle.templateFingerprint},mode:configuration.mode,
   cluster:model.cluster,owned:model.owned,globalRoleCount:model.roles.length,globalDatabaseCount:model.databases.length,serialReaders:model.readers.map(row=>row.connection.database),
   nativeTargetedPolicyCount:12,totalObservedPolicies:model.readers.filter(row=>row.emptyObjects===null).map(row=>({database:row.connection.database,count:row.policies.length,publicPreparationWrappers:2})),
   alphaSevenRollback:true,publicCreateRollback:true,effectiveAppCreate:{g0:false,g1:true,g5:false},original710Rows:710,selectedAlphaRows:717,temporaryGrantChain:'G0-G5 native exact grantor/option/postimage verified',metadata:budget},
   closeMigration:async()=>{try{if(migration)await selectedClose(migration.client,admin,ownerIdentity,budget);}catch(error){reservedPoisoned=true;throw error;}},
   verifyPositivePrivateBoundary:async()=>{budget.guard();await selectedPrivateIdentity(storage,model,budget);const value=await selectedReadonly(storage,q=>selectedSnapshotRead(q,budget));selectedNFootprint(value,role);selectedDefaults(await selectedDefaultAcls(storage,budget),role);},
   verifyCleanup:async()=>{
    selectedNeed(!reservedPoisoned,'Uncertain reserved slot cannot admit another lifetime');
    // New read-only lifetimes require remaining original-case time. Cancellation
    // permits only bounded closure/settlement of an already owned slot.
    budget.cleanup=false;budget.guard();
    const current=await selectedReadonly(admin,async q=>({cluster:await selectedCluster(q,budget),...await selectedGlobal(q,null,budget)}));
    selectedEqual(current.cluster,model.cluster);selectedEqual(current.roles,model.roles.filter(row=>row.name!==role));selectedEqual(current.memberships,model.memberships);selectedEqual(current.databases,model.databases.filter(row=>row.name!==database));selectedEqual(current.shared,model.shared);
    const readers=await selectedReaders(admin,configuration,model.cluster,budget);selectedEqual(readers,model.readers);
    return {metadataRows:budget.rows,metadataBytes:budget.bytes,globalNativeRolesUnchanged:true,privateOidsAbsent:true};
   }};
 }catch(error){primaryFailure=error;throw error;}finally{
  if(!returned){budget.cleanup=true;const failures:unknown[]=[];try{await cleanupTemporary();}catch(error){failures.push(error);}if(migration)try{await selectedClose(migration.client,admin,ownerIdentity,budget);}catch(error){failures.push(error);}if(failures.length)throw new AggregateError([...(primaryFailure?[primaryFailure]:[]),...failures],'Selected construction temporary privilege cleanup uncertain');}
 }
}

/** Hypothetical source controls only. These values are never passed to the
 * native-changing owner and cannot attest a server, permission or installation. */
export function aiCentreSelectedJobSourceModel(mode:'full'|'focused'):AiCentreSelectedJobModel{
 selectedNeed(mode==='full'||mode==='focused');
 const token='0123456789abcdef0123456789abcdef',role='aihr_ai_compat_'+token,database='ai_hr_ai_compat_'+token;
 const cluster:SelectedCluster={systemIdentifier:'123456789',startedAt:'2026-11-09 00:00:00+00',version:160015,jit:'on',jitAvailable:true,maxConnections:100,maxLocks:256};
 const bound=(name:string,oid:string):SelectedRole=>({oid,name,login:name==='ai_hr_app'||name==='ai_hr_owner'||name===role,super:false,inherit:['ai_hr_app','ai_hr_owner','ai_hr_draft_discard_port',role].includes(name),createRole:false,createDb:false,replication:false,bypassRls:false,connectionLimit:-1,passwordNull:true,validUntil:null,config:null});
 const roles=[{...bound('postgres','10'),login:true,super:true,inherit:true,createRole:true,createDb:true,replication:true,bypassRls:true},bound('pg_database_owner','6171'),...selectedOracle.roleNames.map((name,index)=>bound(name,String(20000+index))),bound(role,'30000')];
 const names=selectedNames(mode),dbnames=['postgres','template0','template1','ai_hr_dev','ai_hr_test',names.template,...names.workers,database];
 const databases=dbnames.map((name,index)=>({oid:String(40000+index),name,owner:name===database?role:['ai_hr_dev','ai_hr_test'].includes(name)?'ai_hr_app':'postgres',template:['template0','template1'].includes(name),allowConnections:name!=='template0'}));
 const memberships:SelectedMember[]=[{role:'ai_hr_app',member:'ai_hr_draft_discard_port',grantor:'postgres',inherit:true,set:false,admin:false},{role:'ai_hr_draft_discard_port',member:'ai_hr_owner',grantor:'postgres',inherit:false,set:true,admin:false}];
 const shared:Omit<SelectedShared,'identity'>[]=[];
 const readers=['ai_hr_dev','ai_hr_test',names.template,...names.workers].map(name=>{
  const db=databases.find(row=>row.name===name)!,offset=name==='ai_hr_dev'?100000:200000;
  const connection={serverAddress:'127.0.0.1',serverPort:5433,clientAddress:'127.0.0.1',database:name,databaseOid:db.oid,owner:db.owner,current:'postgres',session:'postgres',systemIdentifier:cluster.systemIdentifier,startedAt:cluster.startedAt};
  if(name==='ai_hr_test')return {connection,ledgerCount:0,ledgerRowsSha256:selectedDigest([]),fingerprints:null,emptyObjects:0,functions:[],relations:[],policies:[],schemas:[],sequence:null,shared:[]}as SelectedSnapshot;
  const acl=(grantee:string,grantor:string,privilege:string):Acl=>({grantee,grantor,privilege,grantable:false});
  const functions:SelectedFunction[]=selectedOracle.functions.map((spec,index)=>{
   const owner=selectedCreator(spec.owner,'postgres');return {...spec,owner,oid:String(offset+index+1),parallel:'u',leakproof:false,kind:'f',acl:spec.aclGrantees.map(grantee=>acl(selectedCreator(grantee,'postgres'),owner,'EXECUTE'))};
  });
  const relations:SelectedRelation[]=Object.entries(selectedOracle.columnTypes).map(([identity,types],index)=>({identity,oid:String(offset+100+index),owner:'postgres',kind:'r',rls:true,force:selectedOracle.forceRls[identity],acl:[],columns:Object.entries(types).map(([column,type],at)=>{
   const grants:Acl[]=[];for(const [grantee,tables]of Object.entries(selectedOracle.columns))for(const [privilege,columns]of Object.entries(tables[identity]??{}))if(columns.includes(column))grants.push(acl(grantee,'postgres',privilege));
   return {number:at+1,name:column,type,typeSchema:type==='actor_type'?'public':'pg_catalog',acl:grants};
  })}));
  const tenant='tenant_id = app.current_tenant_id()',event="tenant_id = app.current_tenant_id() AND aggregate_type = 'reward-unit'::text AND event_type = 'reward-unit.preparation-invalidated'::text AND NOT (actor_id IS DISTINCT FROM app.current_user_id()) AND actor_type::text = CASE WHEN app.current_user_id() IS NULL THEN 'system'::text ELSE 'user'::text END";
  const policies:SelectedPolicy[]=selectedOracle.policies.map((spec,index)=>({oid:String(offset+200+index),name:spec.name,relation:spec.relation,command:spec.command,permissive:true,roles:[spec.role],using:spec.using?tenant:null,check:spec.check==='event'?event:spec.check?tenant:null}));
  for(const [index,policyName]of ['reward_uploaded_review_read','reward_uploaded_review_write'].entries())policies.push({oid:String(offset+220+index),name:policyName,relation:'public.reward_uploaded_review',command:index===0?'r':'*',permissive:true,roles:['PUBLIC'],using:"CASE WHEN CURRENT_USER = 'ai_hr_reward_preparation_reader'::name THEN false ELSE ("+selectedOracle.publicReviewPolicies[policyName]+') END',check:index===0?null:selectedOracle.publicReviewPolicies[policyName]});
  const schemas:SelectedSchema[]=['app','public'].map((schema,index)=>({oid:String(offset+300+index),name:schema,owner:schema==='app'?'postgres':'pg_database_owner',acl:selectedOracle.N.map(grantee=>acl(grantee,schema==='app'?'postgres':'pg_database_owner','USAGE'))}));
  const eventRelation=relations.find(row=>row.identity==='public.domain_event')!,eventColumn=eventRelation.columns.find(row=>row.name==='sequence')!;
  const sequence:SelectedSequence={oid:String(offset+400),identity:'public.domain_event_sequence_seq',owner:'postgres',type:'bigint',start:'1',increment:'1',minimum:'1',maximum:'9223372036854775807',cache:'1',cycle:false,tableOid:eventRelation.oid,columnNumber:eventColumn.number,dependency:'a',acl:selectedOracle.sequenceAcl.map(([grantee,privilege])=>acl(selectedCreator(grantee,'postgres'),'postgres',privilege))};
  // Independently construct source-labelled ownership/ACL/policy edges, rather
  // than copying the adjudicator's projected native dependency result.
  const dependencies:SelectedShared[]=[];
  const edge=(r:string,c:string,o:string,sub:number,d:string,identity:string)=>dependencies.push({databaseOid:db.oid,role:r,className:c,objectOid:o,subId:sub,dependency:d,identity});
  selectedOracle.functions.forEach((spec,index)=>{
   const owner=selectedCreator(spec.owner,'postgres'),oid=String(offset+index+1);
   if(selectedOracle.N.includes(owner))edge(owner,'pg_proc',oid,0,'o',spec.identity);
   for(const recipient of new Set(spec.aclGrantees.filter(value=>selectedOracle.N.includes(value)&&value!==owner)))edge(recipient,'pg_proc',oid,0,'a',spec.identity);
  });
  for(const schema of schemas)for(const nativeRole of selectedOracle.N)edge(nativeRole,'pg_namespace',schema.oid,0,'a',schema.name);
  for(const [nativeRole,tables]of Object.entries(selectedOracle.columns))for(const [table,privileges]of Object.entries(tables))for(const column of new Set(Object.values(privileges).flat())){
   const relation=relations.find(row=>row.identity===table)!,attribute=relation.columns.find(row=>row.name===column)!;edge(nativeRole,'pg_class',relation.oid,attribute.number,'a',table+'.'+column);
  }
  edge('ai_hr_reward_preparation_invalidator','pg_class',sequence.oid,0,'a',sequence.identity);
  for(const policy of policies)if(policy.roles[0]!=='PUBLIC')edge(policy.roles[0],'pg_policy',policy.oid,0,'r',policy.relation+'#'+policy.name);
  for(const {identity:_identity,...row}of dependencies)shared.push(row);
  return {connection,ledgerCount:755,ledgerRowsSha256:selectedOracle.ledgerRowsSha755,fingerprints:name==='ai_hr_dev'?null:[selectedOracle.templateFingerprint],emptyObjects:null,functions,relations,policies,schemas,sequence,shared:dependencies};
 });
 return {evidence:'source-model-only',mode,cluster,source:{tuples:selectedOracle.tupleSha755,sql:selectedOracle.sqlPairSha755,fingerprint:selectedOracle.templateFingerprint},roles,memberships,databases,owned:{database,databaseOid:databases.find(row=>row.name===database)!.oid,role,roleOid:'30000'},readers,shared};
}
