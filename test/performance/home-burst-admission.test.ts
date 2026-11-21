/**
 * A 9 am Home burst on the default web pool: 100 concurrent Home role reads for ONE tenant, while another tenant's
 * single Home reads, same-tenant clock-ins, a same-tenant Personnel search and authentication-lane work (login reads
 * and writes) arrive during it. Every request must be served; none may be refused with the capacity error.
 *
 * Two phases. `installed` runs the installed Home role reader as it is. `held` keeps each burst transaction open for
 * 2 to 4 seconds (about 3 s on average), the per-read time the v17 gate observed under runner load, so the burst
 * needs about 37 s to drain through the eight permits one tenant may use: longer than the 30 s admission budget.
 * Hosted measurement with hard outcomes; it never changes an installation and supplies no release evidence.
 */
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {client,withTenant,type SessionContext} from '../../db/client';
import {applicationDatabaseBudget,databaseAdmissionShares} from '../../db/capacity';
import {withIdempotentDatabaseRead} from '../../db/workload';
import * as s from '../../db/schema';
import {hireEmployee} from '../../core/org';
import {searchWorkforceEmployees} from '../../core/read';
import {captureEmployeeClock,ownClockToday} from '../../packs/attendance/service';
import {authTransaction,readAuthRecord} from '../../lib/internal-auth/store';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {configureAttendanceSubmissionFixtures} from '../helpers/attendance-submission-fixture';
import {adminCtx,closeAll,createAppUser,harnessSnapshot,migrateTestDb,owner,resetDb,seedBase,type Base} from '../harness';
beforeAll(migrateTestDb);afterAll(closeAll);

type Timing={acquired:()=>void;finished:()=>void};
type PerfHooks={__aihrPerfBeginTransaction?:(poolMax:number)=>Timing;__aihrPerfBeginPoolWork?:(poolMax:number)=>Timing;
 __aihrDbAdmission?:WeakMap<object,{snapshot:()=>Record<string,number>}>};
const hooks=globalThis as unknown as PerfHooks;
const label=new AsyncLocalStorage<string>();
type Outcome={label:string;ms:number;error?:string};
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const percentile=(values:number[],p:number)=>{const sorted=[...values].sort((a,b)=>a-b);return sorted.length?sorted[Math.min(sorted.length-1,Math.ceil(p*sorted.length)-1)]:null;};
const summary=(outcomes:Outcome[])=>{const ms=outcomes.map(o=>o.ms);return {count:outcomes.length,refused:outcomes.filter(o=>o.error).length,
 p50Ms:percentile(ms,0.5),p95Ms:percentile(ms,0.95),maxMs:ms.length?Math.max(...ms):null,errors:[...new Set(outcomes.flatMap(o=>o.error?[o.error]:[]))]};};
async function timed(name:string,work:()=>Promise<unknown>):Promise<Outcome>{
 const started=performance.now();
 try{await label.run(name,work);return {label:name,ms:performance.now()-started};}
 catch(error){return {label:name,ms:performance.now()-started,error:String(error)};}
}

/** Employees with a login, an employment and a role grant, inserted in bulk exactly as home-role-query does. */
async function homeUsers(base:Base,count:number){
 const users=Array.from({length:count},(_,index)=>({index,id:randomUUID(),personId:randomUUID(),employmentId:randomUUID()}));
 await owner.db.insert(s.person).values(users.map(u=>({id:u.personId,tenantId:base.tenantId,fullName:'Fictional burst employee '+u.index,primaryEmail:u.id+'@example.invalid'})));
 await owner.db.insert(s.employment).values(users.map(u=>({id:u.employmentId,tenantId:base.tenantId,personId:u.personId,companyId:base.companyId,hiredOn:'2025-01-01'})));
 await owner.db.insert(s.assignment).values(users.map(u=>({tenantId:base.tenantId,employmentId:u.employmentId,companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time' as const,validFrom:'2025-01-01'})));
 await owner.db.insert(s.appUser).values(users.map(u=>({id:u.id,tenantId:base.tenantId,personId:u.personId,workosUserId:'home_burst_'+u.id})));
 await owner.db.insert(s.roleAssignment).values(users.map(u=>({tenantId:base.tenantId,appUserId:u.id,role:'employee' as const,companyId:base.companyId})));
 return users.map(u=>({...u,ctx:{...adminCtx(base),userId:u.id,personId:u.personId,roles:['employee'],grants:[{role:'employee',companyId:base.companyId}]} as SessionContext}));
}
/** Employees who can clock in through the real web clock command. */
async function clockWorkers(base:Base,count:number){
 const workers=[];
 for(let i=0;i<count;i++){
  const hired=await hireEmployee(adminCtx(base),{person:{fullName:'Fictional burst clocker '+i,primaryEmail:randomUUID()+'@example.invalid'},
   companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
  const userId=await createAppUser(base.tenantId,hired.personId,'employee');
  const ctx:SessionContext={tenantId:base.tenantId,userId,personId:hired.personId,roles:['employee'],entitlements:harnessSnapshot(base.tenantId)};
  workers.push({ctx,employmentId:hired.employmentId,clockContext:(await ownClockToday(ctx,undefined,hired.employmentId)).clockContext});
 }
 return workers;
}

it('serves a 100-read same-tenant Home burst while another tenant, clock-in, Personnel and login keep working',async()=>{
 await resetDb();
 const burstTenant=await seedBase(),otherTenant=await seedBase();
 await configureAttendanceSubmissionFixtures(burstTenant);
 const burstUsers=await homeUsers(burstTenant,100),otherUsers=await homeUsers(otherTenant,20);
 const clockers=await clockWorkers(burstTenant,12);
 for(const table of ['person','employment','assignment','app_user','role_assignment'])await owner.client.unsafe('analyze '+table);
 const role=async(ctx:SessionContext,employmentId:string,holdSeconds=0)=>{
  const [row]=await withTenant(ctx,tx=>tx.execute(holdSeconds
   ?sql`select app.own_home_dashboard_role(${employmentId}::uuid) as role, pg_sleep(${holdSeconds})::text as held`
   :sql`select app.own_home_dashboard_role(${employmentId}::uuid) as role`));
  if(row.role!=='employee')throw new Error('Unexpected Home role '+String(row.role));
 };
 const budget=applicationDatabaseBudget(process.env),admission=hooks.__aihrDbAdmission?.get(client);
 expect(admission).toBeDefined();
 const configured={poolMax:budget.poolMax,waitMs:budget.waitMs,maxWaiting:budget.maxWaiting,...databaseAdmissionShares(budget.poolMax,budget.maxWaiting,budget.role),
  snapshot:admission!.snapshot()};
 // Admission wait (request to permit) and held time (permit to release) of every transaction, by caller.
 const transactions:{label:string;waitMs:number;heldMs:number}[]=[];
 const begin=()=>{const name=label.getStore()??'unlabelled',start=performance.now();let acquiredAt:number|undefined;
  return {acquired:()=>{acquiredAt=performance.now();},finished:()=>{const end=performance.now();transactions.push({label:name,waitMs:(acquiredAt??end)-start,heldMs:acquiredAt===undefined?0:end-acquiredAt});}};};
 const previous={transaction:hooks.__aihrPerfBeginTransaction,poolWork:hooks.__aihrPerfBeginPoolWork};
 hooks.__aihrPerfBeginTransaction=begin;hooks.__aihrPerfBeginPoolWork=begin;
 const phases:Record<string,unknown>={};
 try{
  // Warm every connection and plan once, then measure the other tenant and login alone as the reference.
  await Promise.all(otherUsers.slice(0,8).map(u=>role(u.ctx,u.employmentId)));
  const alone:Outcome[]=[],loginAlone:Outcome[]=[];
  for(const u of otherUsers.slice(0,10))alone.push(await timed('other-alone',()=>role(u.ctx,u.employmentId)));
  for(let i=0;i<5;i++)loginAlone.push(await timed('login-alone',()=>readAuthRecord('home-burst-probe:'+randomUUID())));
  phases.reference={otherTenantAlone:summary(alone),loginAlone:summary(loginAlone)};
  for(const [phase,clockSlice] of [['installed',clockers.slice(0,6)],['held',clockers.slice(6)]] as const){
   const hold=(index:number)=>phase==='held'?2+((index*37)%200)/100:0;
   transactions.length=0;
   const started=performance.now();let peakWaiting=0,done=false;
   const burst=Promise.all(burstUsers.map((u,index)=>timed('burst',()=>role(u.ctx,u.employmentId,hold(index)))));
   void burst.finally(()=>{done=true;});
   // Queued behind the whole burst: the worst place a same-tenant command can arrive.
   const clocks=Promise.all(clockSlice.map((worker,index)=>timed('clock-in',async()=>{await sleep(index*50);
    await captureEmployeeClock(worker.ctx,{employmentId:worker.employmentId,clockContext:worker.clockContext,action:'in',requestId:randomUUID(),lat:null,lng:null,accuracy:null});})));
   const personnel=Promise.all([0,1,2].map(index=>timed('personnel',async()=>{await sleep(index*100);
    await withIdempotentDatabaseRead(()=>searchWorkforceEmployees(adminCtx(burstTenant),[burstTenant.companyId],'Fictional'));})));
   const other:Outcome[]=[],login:Outcome[]=[];
   const otherLoop=(async()=>{for(let i=0;!done;i++){const u=otherUsers[i%otherUsers.length];other.push(await timed('other',()=>role(u.ctx,u.employmentId)));await sleep(200);}})();
   const loginLoop=(async()=>{while(!done){
    login.push(await timed('login',()=>readAuthRecord('home-burst-probe:'+randomUUID())));
    login.push(await timed('login',()=>authTransaction('home-burst-probe:'+randomUUID(),async tx=>tx.unsafe('select 1 as ok'))));
    await sleep(300);}})();
   const sampler=(async()=>{while(!done){peakWaiting=Math.max(peakWaiting,admission!.snapshot().waiting);await sleep(50);}})();
   const burstOutcomes=await burst,drainMs=performance.now()-started;
   const [clockOutcomes,personnelOutcomes]=await Promise.all([clocks,personnel,otherLoop,loginLoop,sampler]);
   const burstTransactions=transactions.filter(t=>t.label==='burst');
   phases[phase]={holdSeconds:phase==='held'?{min:2,max:3.99}:0,drainMs,peakWaiting,
    burstTenant:summary(burstOutcomes),burstAdmissionWaitMs:{p50:percentile(burstTransactions.map(t=>t.waitMs),0.5),p95:percentile(burstTransactions.map(t=>t.waitMs),0.95),max:Math.max(0,...burstTransactions.map(t=>t.waitMs))},
    burstHeldMs:{p50:percentile(burstTransactions.map(t=>t.heldMs),0.5),max:Math.max(0,...burstTransactions.map(t=>t.heldMs))},
    otherTenant:summary(other),login:summary(login),sameTenantClockIn:summary(clockOutcomes),sameTenantPersonnelSearch:summary(personnelOutcomes)};
  }
 }finally{
  hooks.__aihrPerfBeginTransaction=previous.transaction;hooks.__aihrPerfBeginPoolWork=previous.poolWork;
  const evidence={kind:'HOME_BURST_ADMISSION_MEASUREMENT',releaseEligible:false,configured,phases};
  console.info('[home-burst-admission] '+JSON.stringify(evidence));
  const evidenceDir=process.env.AIHR_FOCUSED_EVIDENCE_DIR;
  if(evidenceDir)writeFileSync(join(evidenceDir,'home-burst-admission.json'),JSON.stringify(evidence,null,2));
 }
 for(const phase of ['installed','held']){
  const result=phases[phase] as Record<string,{count:number;refused:number;errors:string[];maxMs:number|null}>;
  // Every request is served: the burst, the other tenant, login, same-tenant clock-in and Personnel.
  for(const path of ['burstTenant','otherTenant','login','sameTenantClockIn','sameTenantPersonnelSearch']){
   expect(result[path].errors,phase+' '+path).toEqual([]);expect(result[path].count,phase+' '+path).toBeGreaterThan(0);
  }
  expect(result.burstTenant.count).toBe(100);
  // Another tenant never waits behind the burst: at most for one burst read to release its permit.
  expect(result.otherTenant.maxMs!,phase+' other tenant').toBeLessThan(15_000);
  expect(result.login.maxMs!,phase+' login').toBeLessThan(15_000);
 }
 // The held burst really outlasted the 30 s admission budget, so the outcome above is the drain being served.
 expect((phases.held as {drainMs:number}).drainMs).toBeGreaterThan(30_000);
},300_000);
