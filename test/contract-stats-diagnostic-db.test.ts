// TEMPORARY CI diagnostic (not for merge): where does Contract preview test time go, with and without fixture statistics?
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {type SessionContext} from '../db/client';
import {closeAll,migrateTestDb,resetDb,seedBase,setModule,entitledCtx,createAppUser,owner,type Base} from './harness';
import {v9Setup} from '../packs/lifecycle/service';
import {saveContractSharedRole,saveContractSharedMember,contractSharedPage,contractTemplatePreviewCases,contractTemplatePreviewValues,contractRoutingPreviewCases,contractRoutingCheck} from '../packs/contracts/service';
import type {Routing} from '../lib/automation/routing';
let b:Base,admin:SessionContext;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'lifecycle','active');admin=await entitledCtx(b);const [person]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,'Fictional Contract administrator',${randomUUID()+'@contracts.test'}) returning id`);await owner.db.execute(sql`update app_user set person_id=${person.id}::uuid where tenant_id=${b.tenantId}::uuid and id=${b.adminUserId}::uuid`);admin={...admin,personId:person.id};await v9Setup(admin);});
async function ordinary(){
 const [p]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,'Fictional Contract operator',${randomUUID()+'@contracts.test'}) returning id`);
 const userId=await createAppUser(b.tenantId,p.id,'employee');
 return {...admin,userId,personId:p.id,roles:['employee'],grants:undefined} as SessionContext;
}
async function seedScale(){
  await owner.db.execute(sql`
   with companies as (
    insert into company(tenant_id,legal_name) select ${b.tenantId}::uuid,'Contract scale company '||lpad(n::text,2,'0') from generate_series(1,70) n returning id,legal_name
   ), numbered as materialized(select id,row_number() over(order by legal_name) as n from companies), fixture as materialized(
    select series.n,gen_random_uuid() as person_id,gen_random_uuid() as employment_id,gen_random_uuid() as term_id,gen_random_uuid() as case_id,c.id as company_id
    from generate_series(1,1000) series(n) join numbered c on c.n=((series.n-1)%70)+1
   ), people as (
    insert into person(id,tenant_id,full_name,primary_email) select person_id,${b.tenantId}::uuid,'Contract scale employee '||lpad(n::text,4,'0'),'scale-'||n||'@contracts.test' from fixture
   ), employments as (
    insert into employment(id,tenant_id,person_id,company_id,hired_on,employee_code,contract_start_date,contract_end_date,contract_number)
    select employment_id,${b.tenantId}::uuid,person_id,company_id,'2026-01-01'::date,'SCALE-'||n,'2026-01-01'::date,'2027-12-31'::date,4 from fixture
   ), terms as (
    insert into contract_term(id,tenant_id,company_id,employment_id,version,kind,start_on,end_on,source_revision)
    select term_id,${b.tenantId}::uuid,company_id,employment_id,1,'project','2026-01-01'::date,'2027-12-31'::date,'scale-fixture' from fixture
   )
   insert into contract_case(id,tenant_id,company_id,employment_id,term_id,number,revision,data)
   select case_id,${b.tenantId}::uuid,company_id,employment_id,term_id,'CT-2026-'||lpad(n::text,4,'0'),1,
    jsonb_build_object('revision',1,'state','upcoming','term',jsonb_build_object('startOn','2026-01-01','endOn','2027-12-31'),'decision',NULL,'decisionDraft',NULL) from fixture`);
}
type Step={step:string;ms:number};
async function timed<T>(steps:Step[],step:string,fn:()=>Promise<T>):Promise<T>{const t=performance.now();try{return await fn();}finally{steps.push({step,ms:Math.round(performance.now()-t)});}}
async function stats(){
 const rows=await owner.db.execute<{relname:string;n_live_tup:number;n_mod_since_analyze:number;last_autoanalyze:string|null;last_analyze:string|null;reltuples:number}>(sql`
  select s.relname,s.n_live_tup::int,s.n_mod_since_analyze::int,s.last_autoanalyze::text,s.last_analyze::text,c.reltuples::float8 as reltuples
  from pg_stat_user_tables s join pg_class c on c.oid=s.relid where s.relname in ('contract_case','contract_term','employment','person','company','app_user') order by s.relname`);
 const [settings]=await owner.db.execute<{jit:string;autovacuum:string;naptime:string;version:string}>(sql`select current_setting('jit') jit,current_setting('autovacuum') autovacuum,current_setting('autovacuum_naptime') naptime,version()`);
 return {settings,tables:[...rows]};
}
async function scenarios(steps:Step[]){
 admin=await timed(steps,'entitledCtx',async()=>({...await entitledCtx(b),personId:admin.personId}));
 // Test 1 shape
 const native=await timed(steps,'t1.page20',()=>contractSharedPage(admin,{limit:20}));
 const choices=await timed(steps,'t1.previewCases',()=>contractTemplatePreviewCases(admin));
 expect(choices).toHaveLength(20);
 await timed(steps,'t1.previewValues',()=>contractTemplatePreviewValues(admin,choices[0].id));
 const editor=await timed(steps,'t1.ordinary',ordinary),roleId=randomUUID(),companyId=native.rows[0].companyId;
 await timed(steps,'t1.saveRole',()=>saveContractSharedRole(admin,{id:roleId,name:'One company template reviewer',permissions:['view','templates'],expectedRevision:0}));
 await timed(steps,'t1.saveMember',()=>saveContractSharedMember(admin,{id:randomUUID(),roleId,userId:editor.userId,companyId,businessGroupId:null,validFrom:'2020-01-01',validTo:null,revoked:false}));
 await timed(steps,'t1.scopedPage20',()=>contractSharedPage(editor,{limit:20}));
 await timed(steps,'t1.scopedPreviewCases',()=>contractTemplatePreviewCases(editor));
 // Test 2 shape
 const cases=await timed(steps,'t2.page1',()=>contractSharedPage(admin,{limit:1})),editor2=await timed(steps,'t2.ordinary',ordinary),role2=randomUUID();
 await timed(steps,'t2.saveRole',()=>saveContractSharedRole(admin,{id:role2,name:'Template editor only',permissions:['templates'],expectedRevision:0}));
 await timed(steps,'t2.saveMember',()=>saveContractSharedMember(admin,{id:randomUUID(),roleId:role2,userId:editor2.userId,companyId:cases.rows[0].companyId,businessGroupId:null,validFrom:'2020-01-01',validTo:null,revoked:false}));
 await timed(steps,'t2.previewCasesEmpty',()=>contractTemplatePreviewCases(editor2));
 await timed(steps,'t2.routingPreviewRefused',()=>contractRoutingPreviewCases(editor2).catch(e=>e));
 // Test 3 shape
 const named=await timed(steps,'t3.ordinary',ordinary);
 const routing:Routing={id:randomUUID(),name:'Fictional matching row',rows:[{match:{company:[cases.rows[0].companyId]},assignTo:{kind:'people',userIds:[named.userId!]}},{match:{},assignTo:{kind:'people',userIds:[admin.userId!]}}]};
 const checker=await timed(steps,'t3.ordinary2',ordinary),role3=randomUUID();
 await timed(steps,'t3.saveRole',()=>saveContractSharedRole(admin,{id:role3,name:'Scoped routing checker',permissions:['view','groups'],expectedRevision:0}));
 await timed(steps,'t3.saveMember',()=>saveContractSharedMember(admin,{id:randomUUID(),roleId:role3,userId:checker.userId,companyId:cases.rows[0].companyId,businessGroupId:null,validFrom:'2020-01-01',validTo:null,revoked:false}));
 await timed(steps,'t3.routingCheckScoped',()=>contractRoutingCheck(checker,routing,cases.rows[0].id));
 await timed(steps,'t3.routingCheckAdmin',()=>contractRoutingCheck(admin,routing,cases.rows[0].id));
}
for(const round of [1,2])describe(`Contract statistics diagnostic round ${round}`,()=>{
 for(const mode of ['cold','analyzed'] as const)it(`${mode} fixture`,async()=>{
  const steps:Step[]=[];
  await timed(steps,'seedScale',seedScale);
  if(mode==='analyzed')await timed(steps,'analyze',()=>owner.client.unsafe('analyze'));
  const before=await stats();
  await scenarios(steps);
  const after=await stats();
  console.log('CONTRACT_DIAG '+JSON.stringify({round,mode,totalMs:steps.reduce((s,x)=>s+x.ms,0),steps,before,after}));
 },600_000);
});
