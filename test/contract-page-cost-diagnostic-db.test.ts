// TEMPORARY CI diagnostic (not for merge): Contract page cost breakdown (permission calls, JIT).
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {type SessionContext} from '../db/client';
import {closeAll,migrateTestDb,resetDb,seedBase,setModule,entitledCtx,createAppUser,owner,type Base} from './harness';
import {v9Setup} from '../packs/lifecycle/service';
import {withScopedLifecycleTenant} from '../core/module-gate';
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
const q=(tx:any,s:any)=>tx.execute(s);
for(const round of [1,2,3])it(`Contract page cost breakdown round ${round}`,async()=>{
 const steps:Step[]=[];await seedScale();await owner.client.unsafe('analyze');
 admin={...await entitledCtx(b),personId:admin.personId};
 const result:Record<string,unknown>={};
 await withScopedLifecycleTenant(admin,async tx=>{
  for(const jit of ['on','off']){
   await q(tx,sql.raw(`set local jit=${jit}`));
   await timed(steps,`page1.jit-${jit}`,()=>q(tx,sql`select app.contract_shared_page('',1,0)`));
   await timed(steps,`page20.jit-${jit}`,()=>q(tx,sql`select app.contract_shared_page('',20,0)`));
   await timed(steps,`permittedCount.jit-${jit}`,()=>q(tx,sql`select count(*) from public.contract_case c where c.tenant_id=app.current_tenant_id() and app.contract_shared_case_permitted(c.id,'view')`));
   await timed(steps,`companyCurrentCount.jit-${jit}`,()=>q(tx,sql`select count(*) from public.contract_case c where c.tenant_id=app.current_tenant_id() and app.contract_case_company_current(c.id)`));
   await timed(steps,`sharedPermittedCount.jit-${jit}`,()=>q(tx,sql`select count(*) from public.contract_case c where c.tenant_id=app.current_tenant_id() and app.contract_shared_permitted('view',c.company_id,null,c.employment_id)`));
   await timed(steps,`joinsNoPermission.jit-${jit}`,()=>q(tx,sql`select count(*) from public.contract_case c join public.employment e on e.tenant_id=c.tenant_id and e.id=c.employment_id join public.person p on p.tenant_id=e.tenant_id and p.id=e.person_id join public.company co on co.tenant_id=c.tenant_id and co.id=c.company_id where c.tenant_id=app.current_tenant_id()`));
  }
  const [plan]=await q(tx,sql`explain (analyze, buffers, format json) select app.contract_shared_page('',1,0)`);
  result.planTop=JSON.stringify(plan).slice(0,1500);
 });
 console.log('CONTRACT_COST '+JSON.stringify({round,steps,...result}));
},600_000);
