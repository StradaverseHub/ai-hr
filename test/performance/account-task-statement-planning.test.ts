/** Hosted diagnostic: the planning time, execution time and cached-plan memory of the account task statement
 * (core/account-task-bundle.ts) and of each of its sections, for an administrator, a manager and an employee of a small
 * fictional tenant. It runs only when the hosted focused controller selects this file; every other run skips it. It
 * changes no installation and supplies no release evidence. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>{
 const file='test/performance/account-task-statement-planning.test.ts';
 let selected=false;
 try{selected=(JSON.parse(process.env.AIHR_FOCUSED_TESTS??'[]') as unknown[]).includes(file);}catch{selected=false;}
 return {hostedFocused:selected&&process.env.GITHUB_ACTIONS==='true'&&Boolean(process.env.AIHR_FOCUSED_EVIDENCE_DIR)};
});
import {sql,type SQL} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../../db/client';
import * as s from '../../db/schema';
import {hireEmployee,setReportingLine} from '../../core/org';
import {MODULE_CATALOG} from '../../packs/catalog';
import {accountTaskCallerSql,accountTaskStatement,accountTaskStatementSections,type AccountTaskModules} from '../../core/account-task-bundle';
import {closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase} from '../harness';

const print=(label:string,value:unknown)=>console.info('[task-statement-planning] '+label+' '+JSON.stringify(value));
type Plan={'Planning Time':number;'Execution Time'?:number};
async function explain(ctx:SessionContext,build:(tx:Parameters<Parameters<typeof withTenant>[1]>[0])=>SQL,analyze=false){
 return withTenant(ctx,async tx=>{
  await tx.execute(sql`set local jit=off`);
  const [row]=await tx.execute<{'QUERY PLAN':Plan[]}>(analyze?sql`explain (analyze, summary, format json) ${build(tx)}`:sql`explain (summary, format json) ${build(tx)}`);
  const plan=row['QUERY PLAN'][0];
  return {planningMs:Math.round(plan['Planning Time']*10)/10,...(plan['Execution Time']!==undefined?{executionMs:Math.round(plan['Execution Time']*10)/10}:{})};
 },{readOnlySnapshot:true});
}
/** Cached plan memory this backend holds after preparing and running the statement once more. */
async function cachedPlanMemory(ctx:SessionContext,build:(tx:Parameters<Parameters<typeof withTenant>[1]>[0])=>SQL){
 return withTenant(ctx,async tx=>{
  await tx.execute(sql`set local jit=off`);
  const memory=async()=>Number((await tx.execute<{bytes:string}>(sql`select coalesce(sum(total_bytes),0)::text as bytes from pg_backend_memory_contexts
   where name in ('CachedPlanSource','CachedPlanQuery','CachedPlan')`))[0]?.bytes??0);
  const before=await memory();
  for(let run=0;run<6;run++)await tx.execute(build(tx));
  return {cachedPlanBytes:(await memory())-before};
 },{readOnlySnapshot:true});
}

describe.skipIf(!state.hostedFocused)('account task statement planning',()=>{
 beforeAll(migrateTestDb,120_000);
 afterAll(closeAll,120_000);
 it('reports each section\'s planning time and the statement\'s cached plan memory',async()=>{
  await resetDb();
  const b=await seedBase();
  await owner.db.insert(s.tenantModule).values(MODULE_CATALOG.filter(m=>!m.isCore&&m.packBacked).map(m=>({tenantId:b.tenantId,moduleCode:m.code,status:'active' as const}))).onConflictDoNothing();
  const admin=await entitledCtx(b);
  const hire=(name:string)=>hireEmployee(admin,{person:{fullName:name,primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2025-01-01'});
  const lead=await hire('Fictional planning manager'),member=await hire('Fictional planning employee');
  await setReportingLine(admin,{subordinateEmploymentId:member.employmentId,managerEmploymentId:lead.employmentId,lineType:'administrative',validFrom:'2025-01-01'});
  const actor=async(personId:string,role:string):Promise<SessionContext>=>({...admin,userId:await createAppUser(b.tenantId,personId,role),personId,roles:[role],grants:[{role,companyId:null}]});
  const actors:Record<string,SessionContext>={admin,manager:await actor(lead.personId,'manager'),employee:await actor(member.personId,'employee')};
  const all:AccountTaskModules={attendance:true,claims:true,performance:true,rewards:true,lifecycle:true};
  const report:Record<string,unknown>={kind:'ACCOUNT_TASK_STATEMENT_PLANNING_DIAGNOSTIC',releaseEligible:false,fictional:true};
  for(const [label,ctx] of Object.entries(actors)){
   const sections:Record<string,unknown>={};
   const names=await withTenant(ctx,async tx=>accountTaskStatementSections(tx,ctx,all).map(([name])=>name));
   for(const name of names){
    const runs=[];
    for(let attempt=0;attempt<2;attempt++)runs.push(await explain(ctx,tx=>sql`with ${accountTaskCallerSql(ctx)} select ${accountTaskStatementSections(tx,ctx,all).find(([section])=>section===name)![1]} as section`));
    sections[name]=runs.at(-1);
   }
   const whole=(tx:Parameters<Parameters<typeof withTenant>[1]>[0])=>accountTaskStatement(accountTaskStatementSections(tx,ctx,all),ctx);
   const statement=[];for(let attempt=0;attempt<3;attempt++)statement.push(await explain(ctx,whole,true));
   // The application role may not read pg_backend_memory_contexts on every installation: report the refusal instead.
   const memory=await cachedPlanMemory(ctx,whole).catch(error=>({unavailable:String((error as {cause?:{code?:string}})?.cause?.code??(error as Error)?.message).slice(0,80)}));
   report[label]={sections,statement,memory};
   print(label,{statement,memory,sections});
  }
  if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'account-task-statement-planning.json'),JSON.stringify(report,null,1));
  expect(Object.keys(report).length).toBeGreaterThan(3);
 },600_000);
});
