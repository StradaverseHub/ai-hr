/** ADR-0174 follow-up populated upgrade through 2900–2902, on an owned disposable localhost database only.
 * Cross-tenant references present at the 704-entry boundary must stop the whole upgrade with a report naming
 * every offending table and leave the ledger and every function untouched. Once the owner resolves them, the
 * upgrade validates the seven keys, rewrites no row, changes no grant or policy, appends pg_temp to every
 * unpinned path and changes only the four function bodies it re-issues. This supplies no staging acceptance. */
import {createHash,randomUUID} from 'node:crypto';
import {copyFileSync,mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import postgres from 'postgres';
import {migrate} from 'drizzle-orm/postgres-js/migrator';
import {expect,it} from 'vitest';
import {createDb} from '../db/client';

type Entry={idx:number;version:string;when:number;tag:string;breakpoints:boolean};
type Fn={fn:string;body:string;owner:string;acl:string|null;config:string[]|null;definer:boolean};
const hash=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
const TAIL=[
 {idx:2200,version:'7',when:1793330002500,tag:'2900_definer_search_path_pin',breakpoints:true},
 {idx:2201,version:'7',when:1793330002501,tag:'2901_company_reference_tenant_fk_not_valid',breakpoints:true},
 {idx:2202,version:'7',when:1793330002502,tag:'2902_company_reference_tenant_fk_validate',breakpoints:true},
];
/** Unpinned functions in the 704-entry prefix (catalog, 7 November 2026); 2900 pins every one of them. */
const UNPINNED_AT_BOUNDARY=263;
const KEYS=['company_parent_company_tenant_fk','notice_owner_company_tenant_fk','overtime_pattern_creation_company_tenant_fk',
 'overtime_pattern_version_creation_company_tenant_fk','performance_kpi_library_group_company_tenant_fk','reporting_line_scope_company_tenant_fk',
 'teras_chat_company_tenant_fk'];
const REISSUED=['app.can_see_employment(uuid)','app.can_see_person(uuid)','app.heads_department_of(uuid,uuid)','app.is_admin_report_of(uuid,uuid)'];
/** What 2900 does to a path: append pg_temp; a bare `public` resolves identically as `pg_catalog, public, pg_temp`. */
const pinned=(config:string[]|null)=>config?.map(setting=>{
 if(!setting.startsWith('search_path='))return setting;
 const parts=setting.slice('search_path='.length).split(',').map(part=>part.trim());
 if(parts.at(-1)==='pg_temp')return setting;
 return 'search_path='+(parts.length===1&&parts[0]==='public'?['pg_catalog','public']:parts).concat('pg_temp').join(', ');
})??null;

it('stops on cross-tenant references, then pins every definer and validates the seven keys without changing data or grants',async()=>{
 const journal=JSON.parse(readFileSync('db/migrations/meta/_journal.json','utf8')) as {entries:Entry[]};
 const boundary=journal.entries.findIndex(row=>row.tag===TAIL[0].tag);
 expect(boundary).toBe(704);
 expect(journal.entries.slice(boundary,boundary+TAIL.length)).toEqual(TAIL);
 expect(journal.entries[boundary-1]).toEqual({idx:1900,version:'7',when:1793330002200,tag:'2600_onboarding_current_personnel',breakpoints:true});
 const prefix=journal.entries.slice(0,boundary),through=journal.entries.slice(0,boundary+TAIL.length);
 const root=mkdtempSync(join(tmpdir(),'company-reference-fk-upgrade-')),database='ai_hr_company_ref_upgrade_'+randomUUID().replaceAll('-','');
 const folder=(name:string,entries:Entry[])=>{
  const dir=join(root,name);mkdirSync(join(dir,'meta'),{recursive:true});
  for(const row of entries)copyFileSync('db/migrations/'+row.tag+'.sql',join(dir,row.tag+'.sql'));
  writeFileSync(join(dir,'meta/_journal.json'),JSON.stringify({...journal,entries}));return dir;
 };
 const ownerUrl=new URL(process.env.TEST_MIGRATION_DATABASE_URL!),appUrl=new URL(process.env.TEST_DATABASE_URL!);
 expect(['127.0.0.1','localhost']).toContain(ownerUrl.hostname);expect(['127.0.0.1','localhost']).toContain(appUrl.hostname);
 expect(ownerUrl.username).not.toBe('ai_hr_app');expect(appUrl.username).toBe('ai_hr_app');
 ownerUrl.pathname='/postgres';const admin=postgres(ownerUrl.toString(),{max:1,onnotice:()=>{}});
 ownerUrl.pathname='/'+database;appUrl.pathname='/'+database;
 const storage=createDb(ownerUrl.toString(),{max:1}),application=createDb(appUrl.toString(),{max:1});let created=false;
 const tenantA=randomUUID(),tenantB=randomUUID(),holdingA=randomUUID(),subsidiaryA=randomUUID(),holdingB=randomUUID(),subsidiaryB=randomUUID(),misparented=randomUUID();
 const deptA=randomUUID(),deptB=randomUUID(),userA=randomUUID(),userManagerA=randomUUID();
 const [managerA,reportA,managerB,reportB]=[randomUUID(),randomUUID(),randomUUID(),randomUUID()],persons=[randomUUID(),randomUUID(),randomUUID(),randomUUID()];
 const strayLine=randomUUID(),ownChat=randomUUID(),strayChat=randomUUID();
 const ledger=()=>storage.client`select id,hash,created_at::text as created_at from drizzle.__drizzle_migrations order by id`;
 const keys=()=>storage.client`select conrelid::regclass::text as rel,conname,convalidated from pg_constraint where conname=any(${KEYS}) order by 1`;
 const native=async()=>{
  const rows:Record<string,unknown>={};
  for(const table of ['tenant','company','person','app_user','role_assignment','department','employment','assignment','reporting_line','notice','performance_kpi_library','teras_chat']){
   rows[table]=await storage.client.unsafe(`select to_jsonb(t) as row from public.${table} t where ${table==='tenant'?'id':'tenant_id'}=any($1::uuid[]) order by to_jsonb(t)::text`,[[tenantA,tenantB]]);
  }
  return rows;
 };
 const functions=async()=>await storage.client<Fn[]>`select p.oid::regprocedure::text as fn,p.prosrc as body,pg_get_userbyid(p.proowner)::text as owner,
  p.proacl::text as acl,p.proconfig as config,p.prosecdef as definer from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname in ('public','app','identity_email') order by 1`;
 const privileges=async()=>({
  relations:await storage.client`select c.oid::regclass::text as rel,c.relacl::text as acl,c.relrowsecurity as rls,c.relforcerowsecurity as force
   from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','app') and c.relkind in ('r','p','v','m','S') order by 1`,
  columns:await storage.client`select a.attrelid::regclass::text as rel,a.attname::text as col,a.attacl::text as acl from pg_attribute a
   join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','app') and a.attacl is not null order by 1,2`,
  policies:await storage.client`select schemaname::text,tablename::text,policyname::text,permissive::text,roles::text,cmd::text,qual,with_check from pg_policies
   where schemaname in ('public','app') order by 1,2,3`,
 });
 const unpinned=async()=>(await storage.client<{count:number}[]>`select count(*)::int as count from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname in ('public','app','identity_email') and (p.prosecdef or p.proconfig is not null)
  and not exists(select 1 from unnest(coalesce(p.proconfig,'{}')) c where c like 'search_path=%' and replace(c,' ','') like '%,pg\\_temp')`)[0].count;
 const asTenant=<T>(tenant:string,user:string,role:string,body:(tx:postgres.TransactionSql)=>Promise<T>)=>application.client.begin(async tx=>{
  await tx`select set_config('app.tenant_id',${tenant},true),set_config('app.user_id',${user},true),set_config('app.roles',${role},true),
   set_config('app.grants',${JSON.stringify([{role,companyId:null}])},true)`;
  return body(tx);
 });
 // From tenant A's manager: their own report, and tenant B's manager/report/company ids.
 const answers=()=>asTenant(tenantA,userManagerA,'manager',tx=>tx`select app.can_see_employment(${reportA}::uuid) as own_report,
  app.is_admin_report_of(${reportA}::uuid,${managerA}::uuid) as own_line,app.is_admin_report_of(${reportB}::uuid,${managerB}::uuid) as foreign_line,
  app.heads_department_of(${reportB}::uuid,${managerB}::uuid) as foreign_head,app.is_company_descendant(${subsidiaryB}::uuid,${holdingB}::uuid) as foreign_tree,
  app.is_company_descendant(${subsidiaryA}::uuid,${holdingA}::uuid) as own_tree`);
 try{
  await admin.unsafe(`CREATE DATABASE "${database}"`);created=true;
  await migrate(storage.db,{migrationsFolder:folder('prefix',prefix)});
  const beforeLedger=await ledger();expect(beforeLedger).toHaveLength(704);
  expect(beforeLedger.map(row=>row.hash)).toEqual(prefix.map(row=>hash(readFileSync('db/migrations/'+row.tag+'.sql'))));
  expect(await keys()).toEqual([]);
  expect(await unpinned()).toBe(UNPINNED_AT_BOUNDARY);

  await storage.client`insert into tenant(id,workos_org_id,name) values(${tenantA},${randomUUID()},'Fictional reference group A'),(${tenantB},${randomUUID()},'Fictional reference group B')`;
  await storage.client`insert into company(id,tenant_id,legal_name) values(${holdingA},${tenantA},'Fictional A holding'),(${holdingB},${tenantB},'Fictional B holding')`;
  await storage.client`insert into company(id,tenant_id,legal_name,parent_company_id) values(${subsidiaryA},${tenantA},'Fictional A subsidiary',${holdingA}),(${subsidiaryB},${tenantB},'Fictional B subsidiary',${holdingB})`;
  await storage.client`insert into department(id,tenant_id,company_id,name) values(${deptA},${tenantA},${holdingA},'Fictional A operations'),(${deptB},${tenantB},${holdingB},'Fictional B operations')`;
  await storage.client`insert into person(id,tenant_id,full_name,primary_email) values
   (${persons[0]},${tenantA},'Fictional A manager','ref-fk-a-manager@example.invalid'),(${persons[1]},${tenantA},'Fictional A report','ref-fk-a-report@example.invalid'),
   (${persons[2]},${tenantB},'Fictional B manager','ref-fk-b-manager@example.invalid'),(${persons[3]},${tenantB},'Fictional B report','ref-fk-b-report@example.invalid')`;
  await storage.client`insert into app_user(id,tenant_id,person_id,workos_user_id) values(${userA},${tenantA},null,${randomUUID()}),(${userManagerA},${tenantA},${persons[0]},${randomUUID()})`;
  await storage.client`insert into role_assignment(tenant_id,app_user_id,role) values(${tenantA},${userA},'hr_admin'),(${tenantA},${userManagerA},'manager')`;
  await storage.client`insert into employment(id,tenant_id,person_id,company_id,hired_on) values
   (${managerA},${tenantA},${persons[0]},${holdingA},'2024-01-01'),(${reportA},${tenantA},${persons[1]},${holdingA},'2024-01-01'),
   (${managerB},${tenantB},${persons[2]},${holdingB},'2024-01-01'),(${reportB},${tenantB},${persons[3]},${holdingB},'2024-01-01')`;
  await storage.client`insert into assignment(tenant_id,employment_id,department_id,employment_type,valid_from) values
   (${tenantA},${managerA},${deptA},'full_time','2024-01-01'),(${tenantA},${reportA},${deptA},'full_time','2024-01-01'),
   (${tenantB},${managerB},${deptB},'full_time','2024-01-01'),(${tenantB},${reportB},${deptB},'full_time','2024-01-01')`;
  await storage.client`insert into reporting_line(tenant_id,subordinate_employment_id,manager_employment_id,line_type,valid_from,scope_company_id) values
   (${tenantA},${reportA},${managerA},'administrative','2024-01-01',${holdingA}),(${tenantB},${reportB},${managerB},'administrative','2024-01-01',null)`;
  await storage.client`insert into performance_kpi_library(tenant_id,name,template,group_company_id) values(${tenantA},'Fictional group KPI','{}'::jsonb,${holdingA})`;
  await storage.client`insert into teras_chat(id,tenant_id,app_user_id,person_id,company_id,scope_digest) values(${ownChat},${tenantA},${userManagerA},${persons[0]},${holdingA},${'a'.repeat(64)})`;
  // The gap 2900 closes: tenant A's session still sees tenant B's department-head walk, whose seed department is
  // never company-checked. 2126 already pinned the company tree to the session tenant, which incidentally stops
  // the reporting-line walk (each hop asks app.is_company_descendant).
  expect(await answers()).toEqual([{own_report:true,own_line:true,foreign_line:false,foreign_head:true,foreign_tree:false,own_tree:true}]);

  // The defects the old keys accepted: a tenant A company under tenant B's holding, a tenant A line scoped to B, and a
  // tenant A chat naming B's company (teras_chat.company_id had no key at all).
  await storage.client`insert into company(id,tenant_id,legal_name,parent_company_id) values(${misparented},${tenantA},'Fictional misparented company',${holdingB})`;
  await storage.client`insert into reporting_line(id,tenant_id,subordinate_employment_id,manager_employment_id,line_type,valid_from,valid_to,scope_company_id)
   values(${strayLine},${tenantA},${managerA},${reportA},'administrative','2020-01-01','2020-12-31',${holdingB})`;
  await storage.client`insert into teras_chat(id,tenant_id,app_user_id,person_id,company_id,scope_digest) values(${strayChat},${tenantA},${userManagerA},${persons[0]},${holdingB},${'b'.repeat(64)})`;
  const withDefects=await native(),beforePrivileges=await privileges(),beforeFunctions=await functions();
  const refused=await migrate(storage.db,{migrationsFolder:folder('through',through)}).then(()=>null,(e:unknown)=>e);
  const chain:{message?:string;detail?:string;code?:string}[]=[];
  for(let cur=refused as {message?:string;detail?:string;code?:string;cause?:unknown}|null,i=0;cur&&i<4;cur=cur.cause as typeof cur,i++)chain.push(cur);
  const report=chain.find(link=>link.code==='23503');
  expect(report?.message).toBe('Rows reference a company of another tenant; review them before validating');
  expect(report?.detail?.split('; ')).toEqual([
   expect.stringMatching(/^public\.company: Key \(parent_company_id, tenant_id\)=\([0-9a-f-]{36}, [0-9a-f-]{36}\) is not present in table "company"\.$/),
   expect.stringMatching(/^public\.reporting_line: Key \(scope_company_id, tenant_id\)=\([0-9a-f-]{36}, [0-9a-f-]{36}\) is not present in table "company"\.$/),
   expect.stringMatching(/^public\.teras_chat: Key \(company_id, tenant_id\)=\([0-9a-f-]{36}, [0-9a-f-]{36}\) is not present in table "company"\.$/),
  ]);
  expect(await ledger()).toEqual(beforeLedger);expect(await keys()).toEqual([]);
  expect(await native()).toEqual(withDefects);expect(await functions()).toEqual(beforeFunctions);expect(await unpinned()).toBe(UNPINNED_AT_BOUNDARY);

  // The owner resolves the defects deliberately; the upgrade itself never rewrites or deletes them.
  await storage.client`update company set parent_company_id=null where id=${misparented}`;
  await storage.client`delete from reporting_line where id=${strayLine}`;
  await storage.client`delete from teras_chat where id=${strayChat}`;
  const upgradeNative=await native();
  await migrate(storage.db,{migrationsFolder:folder('through-resolved',through)});
  const afterLedger=await ledger();
  expect(afterLedger).toHaveLength(707);expect(afterLedger.slice(0,704)).toEqual(beforeLedger);
  expect(afterLedger.slice(704).map(row=>({hash:row.hash,created_at:row.created_at}))).toEqual(
   TAIL.map(row=>({hash:hash(readFileSync('db/migrations/'+row.tag+'.sql')),created_at:String(row.when)})));
  expect(await native()).toEqual(upgradeNative);
  expect(await privileges()).toEqual(beforePrivileges);
  const installed=await keys();
  expect(installed.map(row=>row.conname).sort()).toEqual([...KEYS].sort());
  expect(installed.filter(row=>!row.convalidated)).toEqual([]);

  // Functions: the same set, owners and ACLs; four re-issued bodies; every other change is pg_temp on the path.
  const afterFunctions=await functions();
  expect(afterFunctions.map(f=>f.fn)).toEqual(beforeFunctions.map(f=>f.fn));
  const before=new Map(beforeFunctions.map(f=>[f.fn,f]));
  const changedBodies=afterFunctions.filter(f=>f.body!==before.get(f.fn)!.body).map(f=>f.fn);
  expect(changedBodies.sort()).toEqual([...REISSUED].sort());
  expect(afterFunctions.map(f=>({fn:f.fn,owner:f.owner,acl:f.acl,definer:f.definer}))).toEqual(beforeFunctions.map(f=>({fn:f.fn,owner:f.owner,acl:f.acl,definer:f.definer})));
  const expectedConfig=beforeFunctions.map(f=>({fn:f.fn,config:f.definer||f.config?pinned(f.config):f.config}));
  expect(afterFunctions.map(f=>({fn:f.fn,config:f.config}))).toEqual(expectedConfig);
  expect(expectedConfig.filter((f,i)=>JSON.stringify(f.config)!==JSON.stringify(beforeFunctions[i].config))).toHaveLength(UNPINNED_AT_BOUNDARY);
  expect(await unpinned()).toBe(0);
  // Functions of the dedicated owner roles were altered as those roles and keep them.
  expect(['app.reward_senior_awards_for_post(uuid)','app.reward_setup_company_eligible(uuid,integer)','app.own_job_architecture_description(uuid)']
   .map(fn=>before.get(fn)!.owner)).toEqual(['ai_hr_rewards_post_reader','ai_hr_reward_setup_reader','ai_hr_job_profile_reader']);

  expect(await answers()).toEqual([{own_report:true,own_line:true,foreign_line:false,foreign_head:false,foreign_tree:false,own_tree:true}]);
  await expect(storage.client`insert into reporting_line(tenant_id,subordinate_employment_id,manager_employment_id,line_type,valid_from,valid_to,scope_company_id)
   values(${tenantA},${managerA},${reportA},'administrative','2020-01-01','2020-12-31',${holdingB})`)
   .rejects.toMatchObject({code:'23503',constraint_name:'reporting_line_scope_company_tenant_fk'});

  const beforeRerun=await native();await migrate(storage.db,{migrationsFolder:folder('rerun',through)});
  expect(await ledger()).toEqual(afterLedger);expect(await native()).toEqual(beforeRerun);
 }finally{
  await application.client.end();await storage.client.end();if(created)await admin.unsafe(`DROP DATABASE "${database}" WITH (FORCE)`);await admin.end();rmSync(root,{recursive:true,force:true});
 }
},300000);
