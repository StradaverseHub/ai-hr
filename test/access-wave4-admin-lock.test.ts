/**
 * Reader/writer Access lock, wave 4 (admin, AI Centre and operator tools). Real PostgreSQL through the
 * repository harness: each case holds real transactions open on separate connections and observes what
 * PostgreSQL grants. Strict mode is switched on around the converted calls, so a shared holder asking for
 * the exclusive lock fails deterministically instead of only deadlocking under load.
 */
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {and,eq,sql as dsql} from 'drizzle-orm';
import postgres from 'postgres';
import {randomUUID} from 'node:crypto';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import * as schema from '../db/schema';
import {appendEvent} from '../db/events';
import {accessLockModeHeldTx,lockAccessConfigurationTx,lockAccessConfigurationWriteTx} from '../core/access-configuration-lock';
import {tryAccessConfigurationExclusiveQueuedTx,waitAccessConfigurationExclusiveTx} from '../core/access-exclusive-wait';
import {assertAiCentreRunningSharedTx,assertAiCentreRunningTx,lockAccessForAiControlCheckTx} from '../core/ai-centre-control';
import {runAiCentreActivity} from '../lib/ai/centre-activity';
import {AiAllowanceError} from '../lib/ai/types';
import {hireEmployee,setReportingLine} from '../core/org';
import {grantAssistant} from '../core/assistant-grant';
import {eraseOwnAssistantHistory} from '../core/assistant-history-retention';
import {ownAssistantConversationContext,issueAssistantConversationToken,assertOwnAssistantConversationContextCurrentTx} from '../core/assistant-conversation-context';
import * as perf from '../packs/performance/service';
import {defaultPolicy} from '../packs/performance/onehr/model';
import framework from '../packs/performance/onehr/framework.json';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,entitledCtx,harnessSnapshot,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

const barrier=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};};
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const lockKey=(tenantId:string)=>`hashtextextended('access-configuration:${tenantId}',0)`;
async function settled<T>(promise:Promise<T>,ms=4000):Promise<'timeout'|{value:T}>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([promise.then(value=>({value})),new Promise<'timeout'>(resolve=>{timer=setTimeout(()=>resolve('timeout'),ms);})]);}
 finally{if(timer)clearTimeout(timer);}
}
const sqlState=(reason:unknown)=>{
 let current=reason as {code?:unknown;cause?:unknown}|undefined;
 for(let depth=0;current&&depth<6;depth++){if(typeof current.code==='string')return current.code;current=current.cause as typeof current;}
 return undefined;
};
/** The TypeScript half of strict mode: a shared holder asking for the exclusive lock throws. */
async function strictEnv<T>(work:()=>Promise<T>):Promise<T>{
 const prior=process.env.AIHR_ACCESS_LOCK_STRICT;process.env.AIHR_ACCESS_LOCK_STRICT='on';
 try{return await work();}finally{if(prior===undefined)delete process.env.AIHR_ACCESS_LOCK_STRICT;else process.env.AIHR_ACCESS_LOCK_STRICT=prior;}
}
/** The SQL half: authority triggers refuse a missing or weaker mode. */
const strictTx=(tx:Tx)=>tx.execute(dsql`select set_config('app.access_lock_strict','on',true)`);

let b:Base;
let raw:postgres.Sql;
beforeAll(async()=>{await migrateTestDb();raw=postgres(process.env.TEST_MIGRATION_DATABASE_URL!,{max:24,onnotice:()=>{}});});
beforeEach(async()=>{await resetDb();b=await seedBase();});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
afterAll(async()=>{await raw.end({timeout:5});await closeAll();});

/** Shared writers that overlap continuously: at every moment at least one holds the lock shared. */
function sharedTraffic(tenantId:string,workers=6,holdMs=40){
 const control={stop:false};
 const done=Promise.all(Array.from({length:workers},async(_,index)=>{
  await pause(index*Math.floor(holdMs/workers));
  while(!control.stop)await raw.begin(async tx=>{await tx.unsafe(`select pg_advisory_xact_lock_shared(${lockKey(tenantId)})`);await tx.unsafe(`select pg_sleep(${holdMs/1000})`);});
 }));
 return {stop:async()=>{control.stop=true;await done;}};
}
const plainTry=async(tenantId:string)=>{const [row]=await raw.begin(tx=>tx.unsafe(`select pg_try_advisory_xact_lock(${lockKey(tenantId)}) as owned`));return row.owned as boolean;};

describe('fair exclusive wait for maintenance and operator tools',()=>{
 it('grants the exclusive lock at once when free and keeps it to commit',async()=>{
  await withTenant(adminCtx(b),async tx=>{
   expect(await tryAccessConfigurationExclusiveQueuedTx(tx,b.tenantId)).toBe(true);
   expect(await accessLockModeHeldTx(tx,b.tenantId)).toBe('X');
   // Re-entrant: the editor lock now returns at once.
   await lockAccessConfigurationWriteTx(tx,b.tenantId);
  });
 });
 it('succeeds under continuous overlapping shared writers where a plain try starves',async()=>{
  const traffic=sharedTraffic(b.tenantId);
  try{
   await pause(150);
   const tries:boolean[]=[];
   for(let i=0;i<10;i++){tries.push(await plainTry(b.tenantId));await pause(15);}
   expect(tries.filter(Boolean)).toEqual([]);
   const started=Date.now();
   const owned=await withTenant(adminCtx(b),async tx=>{const owned=await tryAccessConfigurationExclusiveQueuedTx(tx,b.tenantId,2000);return {owned,mode:await accessLockModeHeldTx(tx,b.tenantId)};});
   expect(owned).toEqual({owned:true,mode:'X'});
   // Granted once the current short holders drained, far inside the bound.
   expect(Date.now()-started).toBeLessThan(1500);
  }finally{await traffic.stop();}
 },30000);
 it('returns false at the deadline behind a long holder, holding nothing and leaving the transaction usable',async()=>{
  const held=barrier(),release=barrier();
  const holder=raw.begin(async tx=>{await tx.unsafe(`select pg_advisory_xact_lock_shared(${lockKey(b.tenantId)})`);held.resolve();await release.promise;});
  await held.promise;
  try{
   await withTenant(adminCtx(b),async tx=>{
    await tx.execute(dsql`set local lock_timeout='3s'`);
    const started=Date.now();
    expect(await tryAccessConfigurationExclusiveQueuedTx(tx,b.tenantId,200)).toBe(false);
    expect(Date.now()-started).toBeGreaterThanOrEqual(150);
    expect(await accessLockModeHeldTx(tx,b.tenantId)).toBeNull();
    const [setting]=await tx.execute<{lock_timeout:string}>(dsql`select current_setting('lock_timeout') as lock_timeout`);
    expect(setting.lock_timeout).toBe('3s');
   });
  }finally{release.resolve();await holder;}
 },20000);
 it('delays a later shared writer by at most the bounded wait, never for the long holder\'s whole run',async()=>{
  const held=barrier(),release=barrier();
  const holder=raw.begin(async tx=>{await tx.unsafe(`select pg_advisory_xact_lock_shared(${lockKey(b.tenantId)})`);held.resolve();await release.promise;});
  await held.promise;
  try{
   const waiter=withTenant(adminCtx(b),tx=>tryAccessConfigurationExclusiveQueuedTx(tx,b.tenantId,400));
   await pause(80);
   const started=Date.now();
   await raw.begin(tx=>tx.unsafe(`select pg_advisory_xact_lock_shared(${lockKey(b.tenantId)})`));
   const delayed=Date.now()-started;
   expect(await waiter).toBe(false);
   // Queued behind the exclusive waiter (E1) only until it gave up; the long holder is still running.
   expect(delayed).toBeGreaterThanOrEqual(150);
   expect(delayed).toBeLessThan(2000);
  }finally{release.resolve();await holder;}
 },20000);
 it('refuses a shared holder instead of upgrading, and a foreign tenant',async()=>{
  await expect(withTenant(adminCtx(b),async tx=>{await lockAccessConfigurationTx(tx,b.tenantId);await tryAccessConfigurationExclusiveQueuedTx(tx,b.tenantId);})).rejects.toSatisfy(error=>sqlState(error)==='AL001');
  await expect(withTenant(adminCtx(b),tx=>tryAccessConfigurationExclusiveQueuedTx(tx,randomUUID()))).rejects.toSatisfy(error=>sqlState(error)==='42501');
 });
 it('backs off and retries until a long holder finishes',async()=>{
  const held=barrier();
  const holder=raw.begin(async tx=>{await tx.unsafe(`select pg_advisory_xact_lock_shared(${lockKey(b.tenantId)})`);held.resolve();await pause(700);});
  await held.promise;
  const owned=await withTenant(adminCtx(b),async tx=>{const owned=await waitAccessConfigurationExclusiveTx(tx,b.tenantId,{waitMs:150,attempts:10,backoffMs:100});return {owned,mode:await accessLockModeHeldTx(tx,b.tenantId)};});
  expect(owned).toEqual({owned:true,mode:'X'});
  await holder;
 },20000);
 it('reports false after bounded attempts when the holder outlasts them',async()=>{
  const held=barrier(),release=barrier();
  const holder=raw.begin(async tx=>{await tx.unsafe(`select pg_advisory_xact_lock_shared(${lockKey(b.tenantId)})`);held.resolve();await release.promise;});
  await held.promise;
  try{expect(await withTenant(adminCtx(b),tx=>waitAccessConfigurationExclusiveTx(tx,b.tenantId,{waitMs:50,attempts:3,backoffMs:20}))).toBe(false);}
  finally{release.resolve();await holder;}
 },20000);
});

describe('AI Centre checks join the mode the transaction holds',()=>{
 const mode=(tx:Tx)=>accessLockModeHeldTx(tx,b.tenantId);
 it('lets a converted shared writer run the AI checks without upgrading (strict mode)',async()=>{
  const ctx=adminCtx(b);
  await withTenant(ctx,async tx=>{
   await strictTx(tx);await lockAccessConfigurationTx(tx,b.tenantId);
   await strictEnv(async()=>{await lockAccessForAiControlCheckTx(tx,b.tenantId);expect(await assertAiCentreRunningTx(tx,ctx)).toBeGreaterThanOrEqual(0);});
   expect(await mode(tx)).toBe('S');
  });
  // Control: the exclusive request a shared writer used to make is exactly what strict mode refuses.
  await expect(withTenant(ctx,async tx=>{await lockAccessConfigurationTx(tx,b.tenantId);await strictEnv(()=>lockAccessConfigurationWriteTx(tx,b.tenantId));})).rejects.toThrow(/strict mode/);
 });
 it('keeps the exclusive lock for a carrier that holds nothing',async()=>{
  const ctx=adminCtx(b);
  await withTenant(ctx,async tx=>{await assertAiCentreRunningTx(tx,ctx);expect(await mode(tx)).toBe('X');});
 });
 it('runs a check-only transaction shared: it overlaps a shared writer and still waits for an editor',async()=>{
  const ctx=adminCtx(b);
  {
   const held=barrier(),release=barrier();
   const writer=raw.begin(async tx=>{await tx.unsafe(`select pg_advisory_xact_lock_shared(${lockKey(b.tenantId)})`);held.resolve();await release.promise;});
   await held.promise;
   try{
    const check=await settled(withTenant(ctx,async tx=>{await assertAiCentreRunningSharedTx(tx,ctx);return mode(tx);}),3000);
    expect(check).toEqual({value:'S'});
   }finally{release.resolve();await writer;}
  }
  {
   const held=barrier(),release=barrier();
   const editor=raw.begin(async tx=>{await tx.unsafe(`select pg_advisory_xact_lock(${lockKey(b.tenantId)})`);held.resolve();await release.promise;});
   await held.promise;
   const check=withTenant(ctx,tx=>assertAiCentreRunningSharedTx(tx,ctx));
   expect(await settled(check,400)).toBe('timeout');
   release.resolve();await editor;
   await expect(check).resolves.toBeGreaterThanOrEqual(0);
  }
 },20000);
 it('keeps the stop switch effective for the shared check',async()=>{
  const ctx=adminCtx(b);
  await raw.begin(async tx=>{
   await tx.unsafe(`select set_config('app.tenant_id','${b.tenantId}',true)`);
   await tx.unsafe(`insert into teras_mandate_control(tenant_id,stopped,changed_by_user_id) values('${b.tenantId}',true,'${b.adminUserId}')`);
  });
  await expect(withTenant(ctx,tx=>assertAiCentreRunningSharedTx(tx,ctx))).rejects.toBeInstanceOf(AiAllowanceError);
  await expect(withTenant(ctx,tx=>assertAiCentreRunningTx(tx,ctx))).rejects.toBeInstanceOf(AiAllowanceError);
 });
 it('lets appendEvent inside AI activity join a held shared lock, and keeps exclusive otherwise',async()=>{
  const ctx=adminCtx(b),generation=await withTenant(ctx,tx=>assertAiCentreRunningSharedTx(tx,ctx));
  const event=()=>({tenantId:b.tenantId,aggregateType:'leave-request',aggregateId:randomUUID(),eventType:'leave-request.approved',actor:{type:'system' as const}});
  const modes=await runAiCentreActivity(b.tenantId,generation,async()=>({
   shared:await withTenant(ctx,async tx=>{await lockAccessConfigurationTx(tx,b.tenantId);await appendEvent(tx,event());return mode(tx);}),
   none:await withTenant(ctx,async tx=>{await appendEvent(tx,event());return mode(tx);}),
  }));
  expect(modes).toEqual({shared:'S',none:'X'});
  // Outside AI activity an ordinary event takes no Access lock at all, as before.
  expect(await withTenant(ctx,async tx=>{await appendEvent(tx,event());return mode(tx);})).toBeNull();
 });
 it('lets two shared writers in AI activity append events concurrently without deadlock',async()=>{
  const ctx=adminCtx(b),generation=await withTenant(ctx,tx=>assertAiCentreRunningSharedTx(tx,ctx));
  const entered=[barrier(),barrier()],go=barrier();
  const writers=entered.map(entry=>runAiCentreActivity(b.tenantId,generation,()=>withTenant(ctx,async tx=>{
   await lockAccessConfigurationTx(tx,b.tenantId);entry.resolve();await go.promise;
   await appendEvent(tx,{tenantId:b.tenantId,aggregateType:'leave-request',aggregateId:randomUUID(),eventType:'leave-request.approved',actor:{type:'system'}});
  })));
  await Promise.all(entered.map(entry=>entry.promise));go.resolve();
  const results=await settled(Promise.allSettled(writers),15000);
  expect(results).not.toBe('timeout');
  expect((results as {value:PromiseSettledResult<unknown>[]}).value.map(result=>result.status==='rejected'?sqlState(result.reason):'ok')).toEqual(['ok','ok']);
 },30000);
});

describe('own conversation checks under the shared lock',()=>{
 async function actor(){
  vi.stubEnv('AI_CONFIG_SECRET','fictional-wave4-context-key');
  await setModule(b.tenantId,'assistant','active');
  const admin=adminCtx(b),employee=await hireEmployee(admin,{person:{fullName:'Fictional wave four chat actor',primaryEmail:randomUUID()+'@fixture.test'},
   companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
  const userId=await createAppUser(b.tenantId,employee.personId,'employee');await grantAssistant(admin,{appUserId:userId});
  const ctx:SessionContext={...await entitledCtx(b,['employee']),userId,personId:employee.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
  const first=randomUUID();
  await owner.db.insert(schema.assistantExchange).values({id:first,tenantId:b.tenantId,appUserId:userId,question:'What leave can I take next week?',answer:'Fictional answer',toolCalls:[],stop:'end'});
  const token=issueAssistantConversationToken(ctx,first,null);expect(token).toBeTruthy();
  const context=await ownAssistantConversationContext(ctx,first,'What about tomorrow?',token!);
  return {ctx,context};
 }
 it('reads own rows shared beside other writers, and own-history erasure still waits for it',async()=>{
  const {ctx,context}=await actor();
  const other=barrier(),releaseOther=barrier();
  const writer=raw.begin(async tx=>{await tx.unsafe(`select pg_advisory_xact_lock_shared(${lockKey(b.tenantId)})`);other.resolve();await releaseOther.promise;});
  await other.promise;
  const checked=barrier(),releaseCheck=barrier();
  const check=withTenant(ctx,async tx=>{
   await strictTx(tx);
   await strictEnv(()=>assertOwnAssistantConversationContextCurrentTx(tx,ctx,context));
   const held=await accessLockModeHeldTx(tx,b.tenantId);checked.resolve();await releaseCheck.promise;return held;
  });
  try{
   expect(await settled(checked.promise.then(()=>'checked'),5000)).toEqual({value:'checked'});
   releaseOther.resolve();await writer;
   // Erasure bounds its own wait at 500 ms; it must still be queued well inside that.
   const erase=eraseOwnAssistantHistory(ctx);
   expect(await settled(erase,150)).toBe('timeout');
   releaseCheck.resolve();
   expect(await check).toBe('S');
   await erase;
  }finally{releaseOther.resolve();releaseCheck.resolve();await writer.catch(()=>undefined);await check.catch(()=>undefined);}
  // After the erasure the same context is no longer current.
  await expect(withTenant(ctx,tx=>assertOwnAssistantConversationContextCurrentTx(tx,ctx,context))).rejects.toThrow();
 },60000);
});

describe('OneHR own plan acknowledgement under the shared lock',()=>{
 async function closedPlan(){
  await setModule(b.tenantId,'performance','active');
  const admin=adminCtx(b),year=Number(todayInKualaLumpur().slice(0,4)),hire=(name:string)=>hireEmployee(admin,{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:`${year-2}-01-01`});
  const employee=await hire('Fictional wave four plan owner'),manager=await hire('Fictional wave four plan manager');
  const userId=await createAppUser(b.tenantId,employee.personId,'employee'),managerId=await createAppUser(b.tenantId,manager.personId,'manager');
  const [grade]=await owner.db.insert(schema.jobGrade).values({tenantId:b.tenantId,code:'12',name:'Fictional Grade 12'}).returning({id:schema.jobGrade.id});
  for(const person of [employee,manager])await owner.db.update(schema.employment).set({gradeId:grade.id}).where(eq(schema.employment.id,person.employmentId));
  await setReportingLine(admin,{subordinateEmploymentId:employee.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:`${year-2}-01-01`});
  const ctx:SessionContext={tenantId:b.tenantId,userId,personId:employee.personId,roles:['employee'],entitlements:harnessSnapshot(b.tenantId)};
  const managerCtx:SessionContext={tenantId:b.tenantId,userId:managerId,personId:manager.personId,roles:['manager'],entitlements:harnessSnapshot(b.tenantId)};
  const {cycleId}=await perf.createCycle(admin,{name:'Fictional OneHR Annual',companyId:b.companyId,periodStart:`${year}-01-01`,periodEnd:`${year}-12-31`});
  await perf.configureOnehrCycle(admin,cycleId,null,defaultPolicy(framework));await perf.openCycle(admin,{cycleId});
  const [review]=await owner.db.select({id:schema.performanceReview.id}).from(schema.performanceReview).where(and(eq(schema.performanceReview.cycleId,cycleId),eq(schema.performanceReview.employmentId,employee.employmentId)));
  await perf.saveOnehrPlan(ctx,review.id,null,{career:{aspiration:'Fictional facilitation development',mobility:'stay',mobilityNote:'',targetProfileId:null},goals:[{id:randomUUID(),area:'Fictional facilitation',dueOn:'',onJob:'Human fixture workshop',fromOthers:'',formalLearning:'',status:'not_started'}]},true);
  let [plan]=await owner.db.select().from(schema.onehrPlan).where(and(eq(schema.onehrPlan.employmentId,employee.employmentId),eq(schema.onehrPlan.planYear,year+1)));
  await perf.reviewOnehrPlan(managerCtx,plan.id,plan.revision,'Agreed','Fictional recorded career conversation',true,undefined,todayInKualaLumpur());
  [plan]=await owner.db.select().from(schema.onehrPlan).where(eq(schema.onehrPlan.id,plan.id));
  return {ctx,plan};
 }
 const acknowledgements=(planId:string)=>owner.db.select({id:schema.domainEvent.id}).from(schema.domainEvent).where(and(eq(schema.domainEvent.aggregateId,planId),eq(schema.domainEvent.eventType,'onehr.plan-acknowledged')));
 it('holds Access shared, passes strict mode and completes while another writer holds the lock',async()=>{
  const {ctx,plan}=await closedPlan();
  const held=barrier(),release=barrier();
  const writer=raw.begin(async tx=>{await tx.unsafe(`select pg_advisory_xact_lock_shared(${lockKey(b.tenantId)})`);held.resolve();await release.promise;});
  await held.promise;
  try{
   const outcome=await settled(withTenant(ctx,async tx=>{
    await strictTx(tx);
    const effect=await strictEnv(()=>perf.acknowledgeOnehrPlanTx(tx,ctx,plan.id,plan.revision));
    return {revision:effect.planRevision,mode:await accessLockModeHeldTx(tx,b.tenantId)};
   }),10000);
   expect(outcome).toEqual({value:{revision:plan.revision+1,mode:'S'}});
  }finally{release.resolve();await writer;}
  expect(await acknowledgements(plan.id)).toHaveLength(1);
 },90000);
 it('serialises two acknowledgements of the same plan on its row: exactly one lands',async()=>{
  const {ctx,plan}=await closedPlan();
  const results=await Promise.allSettled([1,2].map(()=>perf.acknowledgeOnehrPlan(ctx,plan.id,plan.revision)));
  expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
  const refused=results.filter((result):result is PromiseRejectedResult=>result.status==='rejected').map(result=>sqlState(result.reason));
  expect(refused.filter(code=>code==='55P03'||code==='40P01')).toEqual([]);
  expect(await acknowledgements(plan.id)).toHaveLength(1);
  const [after]=await owner.db.select({revision:schema.onehrPlan.revision}).from(schema.onehrPlan).where(eq(schema.onehrPlan.id,plan.id));
  expect(after.revision).toBe(plan.revision+1);
 },90000);
 it('still waits behind an access editor',async()=>{
  const {ctx,plan}=await closedPlan();
  const held=barrier(),release=barrier();
  const editor=raw.begin(async tx=>{await tx.unsafe(`select pg_advisory_xact_lock(${lockKey(b.tenantId)})`);held.resolve();await release.promise;});
  await held.promise;
  const acknowledgement=perf.acknowledgeOnehrPlan(ctx,plan.id,plan.revision);
  expect(await settled(acknowledgement,600)).toBe('timeout');
  release.resolve();await editor;
  await expect(acknowledgement).resolves.toBeUndefined();
 },90000);
});
