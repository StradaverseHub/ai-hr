/** Fixed product-policy courses and separate native counterfactual shape diagnostics. */
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {cpus,totalmem} from 'node:os';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import * as database from '../db/client';
import {assertAiPresentationPrincipalTx} from '../core/ai-principal';
import {attendanceMonthSummaryPage} from '../packs/attendance/service';
import {analyticsDashboard,UNKNOWN_BUCKET} from '../core/analytics';
import {withModulePresentationRead} from '../core/module-presentation-read';
import {parsePageQuery} from '../lib/pagination';
import {closeAll,migrateTestDb,owner,setModule} from './harness';
import {admitSingletonTest} from './helpers/ci-singleton-admission';
import {seedPersonnelNativeFixture} from './performance/personnel-native-fixture';
import {observeNativeRead} from './helpers/native-read-observer';
import {actualDriverPins,createModuleReadJitProbe,digest,maintainModuleReadFixture,moduleJitDiagnosticSettingsSql,nativeModuleFingerprint,type CapturedStatement,type JitMode} from './performance/module-read-jit-probe';

const admission=admitSingletonTest('test/module-read-jit-diagnostic.test.ts');
const report:Record<string,unknown>={kind:'MEASURED_PRESENTATION_JIT_POLICY_AND_COUNTERFACTUAL_SHAPES',releaseEligible:false,complete:false,cleanupComplete:false,
 host:{cpus:cpus().length,cpuModels:[...new Set(cpus().map(cpu=>cpu.model))],memoryBytes:totalmem()},
 limits:{cases:3,caseMs:300000,defaultHookMs:30000,focusedOuterMs:1200000,fullSingletonOuterMs:7200000,profileVersion:2,configuredPgCapBytes:2113929216,pgPeakBudgetBytes:2147483648,normalProfileJit:'on'},
 fingerprintDriftMeaning:'STABILITY_REFUSAL_CAUSE_UNCLASSIFIED; background maintenance is possible, and drift alone does not prove an application mutation.',
 warmth:'Fixture creation/ANALYZE warm buffers and functions. Every course discards plans; no storage-cold or production latency acceptance.',
 wholeCourseMeaning:'Requested parent ON/OFF/OFF/ON; both actual product entries must enforce effectiveOFF. These are not balanced whole-read ON/OFF speed samples.',
 planCoverage:'Five actual captured SELECT objects, twenty direct-native counterfactual ON/OFF plans, not product whole-read ON arms. Cursor DECLARE/FETCH/CLOSE remains in whole read census.'};
let probe:Awaited<ReturnType<typeof createModuleReadJitProbe>>|undefined;
let fixture:Awaited<ReturnType<typeof seedPersonnelNativeFixture>>|undefined;
let fingerprint:Awaited<ReturnType<typeof nativeModuleFingerprint>>|undefined;
let prepared=false,attendanceComplete=false,analyticsComplete=false;
const save=()=>{
 if(probe)report.owner=probe.snapshot();
 writeFileSync(join(admission.evidenceDirectory,'module-read-jit-diagnostic.json'),JSON.stringify(report,null,2));
};
beforeAll(migrateTestDb);
afterAll(async()=>{
 const failures:unknown[]=[];
 try{if(probe)await probe.close();report.appOwnerClosed=true;}catch(error){failures.push(error);report.appOwnerClosed=false;}
 try{if(fingerprint){report.finalFingerprint=await nativeModuleFingerprint();report.nativeContentUnchanged=digest(report.finalFingerprint)===digest(fingerprint);assert.equal(report.nativeContentUnchanged,true);}}catch(error){failures.push(error);}
 try{await closeAll();report.fixturePoolsClosed=true;}catch(error){failures.push(error);report.fixturePoolsClosed=false;}
 report.cleanupComplete=failures.length===0;report.complete=prepared&&attendanceComplete&&analyticsComplete&&failures.length===0;
 try{save();}catch(error){failures.push(error);}
 if(failures.length)throw new AggregateError(failures,'Shared module diagnostic cleanup failed');
});

it('prepares one fictional50000 fixture and proves native policy admission, rollback, cancellation, isolated carriers and default restoration',async context=>{
 report.phase='fixture';report.drivers=actualDriverPins();save();const start=performance.now();
 fixture=await seedPersonnelNativeFixture(50000,report,phase=>{report.phase=phase;save();},save);
 await setModule(fixture.b.tenantId,'attendance','active');
 await owner.client`insert into attendance(tenant_id,employment_id,attendance_date,status,day_type,worked_minutes,ot_minutes)
  select tenant_id,id,'2026-05-01'::date,'present','workday',480,60 from employment where tenant_id=${fixture.b.tenantId}::uuid and terminated_on is null`;
 await owner.client`analyze attendance`;
 const [facts]=await owner.client`select
  (select count(*)::int from employment where tenant_id=${fixture.b.tenantId}::uuid)as employees,
  (select count(*)::int from employment where tenant_id=${fixture.b.tenantId}::uuid and terminated_on is null)as current,
  (select count(*)::int from employment where tenant_id=${fixture.b.tenantId}::uuid and terminated_on='2024-01-01')as ended,
  (select count(*)::int from assignment where tenant_id=${fixture.b.tenantId}::uuid)as assignments,
  (select count(*)::int from attendance where tenant_id=${fixture.b.tenantId}::uuid)as attendance,
  (select sum(worked_minutes)::bigint::text from attendance where tenant_id=${fixture.b.tenantId}::uuid)as worked,
  (select count(*)::int from leave_ledger where tenant_id=${fixture.b.tenantId}::uuid)as ledger`;
 expect(facts).toEqual({employees:50000,current:40000,ended:10000,assignments:50000,attendance:40000,worked:'19200000',ledger:0});
 report.fixtureFacts=facts;report.fixturePool={ownerMax:owner.client.options.max,ordinaryAppMax:database.client.options.max,ordinaryAppClosedBeforeMeasurements:true};
 const reads=[
  {module:'attendance',read:(ctx:database.SessionContext)=>attendanceMonthSummaryPage(ctx,{month:'2026-05',today:'2026-05-01',companyIds:[fixture!.b.companyId],page:parsePageQuery()})},
  {module:'analytics',read:(ctx:database.SessionContext)=>{const page=parsePageQuery();return analyticsDashboard(ctx,[fixture!.b.companyId],{from:'2020-01-01',to:'2026-01-01',year:2020,filters:{},pages:{hires:page,terms:page,changeJobs:page,carryForward:page}});}},
 ];
 // These real admission failures occur before the immutable measurement fingerprint.
 const refused=observeNativeRead();let refusals=0;
 try{
  for(const entry of reads)for(const changed of [{...fixture.ctx,personId:randomUUID()},{...fixture.ctx,entitlementsExempt:'platform' as const},{...fixture.ctx,statutoryOverride:'Fictional JIT policy refusal'}]){
   await expect(entry.read(changed)).rejects.toThrow('calling authority');refusals++;
  }
  await setModule(fixture.b.tenantId,'attendance','disabled');
  try{await expect(reads[0].read(fixture.ctx)).rejects.toThrow();refusals++;}
  finally{await setModule(fixture.b.tenantId,'attendance','active');}
  expect(refused.queries.filter(query=>query.sql==='set local jit=off')).toHaveLength(0);
 }finally{refused.restore();}
 report.nativeAdmissionRefusals={complete:true,cases:refusals,policyCommands:0};save();
 await maintainModuleReadFixture(report,save);
 expect(report.fixtureMaintenance).toMatchObject({complete:true,status:'completed',defaultsRestoredSamePid:true,released:true,newPools:0,reservedOwnerConnections:1,retries:0});
 fingerprint=await nativeModuleFingerprint();report.initialFingerprint=fingerprint;
 probe=await createModuleReadJitProbe(fixture.ctx,save);report.fixtureAndOwnerPreparationMs=performance.now()-start;save();
 // Real held native snapshot demonstrates refusal of a second owner; no fake Tx.
 let entered=()=>{},release=()=>{};const ready=new Promise<void>(r=>{entered=r;}),hold=new Promise<void>(r=>{release=r;});
 const held=probe.run('owned-commit-and-overlap','on',()=>withModulePresentationRead(fixture!.ctx,'attendance',async tx=>{
  const [row]=await tx.execute<{one:number}>(sql`select 1 as one`);expect(row.one).toBe(1);entered();await hold;return true;
 }));void held.catch(()=>{});
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  await Promise.race([ready,held.then(()=>{throw Error('Owned snapshot exited before held entry');}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Owned snapshot failed to enter')),5000);})]);
  await expect(probe.run('refused-overlap','off',()=>Promise.resolve(false))).rejects.toThrow('Diagnostic owner is busy, poisoned or closed');
 }finally{clearTimeout(timer);release();await held;}
 const sentinel=Error('Fictional owned rollback');
 await expect(probe.run('owned-off-rollback','off',()=>database.withTenant(fixture!.ctx,async()=>{throw sentinel;},{readOnlySnapshot:true}))).rejects.toBe(sentinel);
 expect(probe.receipts.at(-1)).toMatchObject({failed:true,complete:false,defaultsRestoredSamePid:true,transactionCalls:1});
 probe.receipts.at(-1)!.expectedRollback=true;
 expect(probe.defaults).toMatchObject({role:'ai_hr_app',login:'ai_hr_app',jit:'on',available:true,rls:'on'});
 for(const entry of reads){
  const work:()=>Promise<unknown>=()=>entry.read(fixture!.ctx);
  await expect(probe.run(entry.module+'-policy-native-rollback','on',work,tx=>tx.execute(sql`select 1/0`).then(()=>{}))).rejects.toSatisfy(error=>pgState(error)==='22012');
  expect(probe.receipts.at(-1)).toMatchObject({failed:true,complete:false,requestedJit:'on',policyCommandCount:1,effectiveJitAfterProductPolicy:'off',defaultsRestoredSamePid:true});
  probe.receipts.at(-1)!.expectedRollbackKind='native-division-by-zero';save();
  await expect(probe.run(entry.module+'-policy-native-cancellation','on',work,async(tx,native)=>{
   await cancelOwnedRead(tx,native.pid,probe!.applicationName,context.signal);
  })).rejects.toSatisfy(error=>pgState(error)==='57014');
  expect(probe.receipts.at(-1)).toMatchObject({failed:true,complete:false,policyCommandCount:1,effectiveJitAfterProductPolicy:'off',defaultsRestoredSamePid:true});
  probe.receipts.at(-1)!.expectedRollbackKind='native-owned-cancellation';save();
 }
 const isolation:Record<string,unknown>={complete:false,temporaryMaxAppConnections:2,measurementMaxAppConnections:1,extraCarrierMax:1,extraCarrierClosed:false,courses:[]};
 report.preparationIsolation=isolation;save();
 const url=new URL(process.env.TEST_DATABASE_URL!);url.searchParams.set('application_name','module_jit_isolation_'+randomUUID().replaceAll('-',''));
 const extra=database.createDb(url.toString(),{max:1});expect(extra.client.options.max).toBe(1);
 const inspectExtra=async()=>{const [row]=await extra.client.unsafe(moduleJitDiagnosticSettingsSql,[],{prepare:false});return row;};
 try{
  const extraDefaults=await inspectExtra();expect(extraDefaults).toMatchObject({role:'ai_hr_app',login:'ai_hr_app',jit:'on',available:true});
  for(const entry of reads){
   const work:()=>Promise<unknown>=()=>entry.read(fixture!.ctx);
   const completed=await probe.run(entry.module+'-policy-concurrent-isolation','on',work,async(_tx,native)=>{
    await extra.withTenant(fixture!.ctx,async tx=>{
     await assertAiPresentationPrincipalTx(tx,fixture!.ctx);
     const [other]=await tx.execute<{pid:number;role:string;login:string;jit:string;available:boolean}>(sql.raw(moduleJitDiagnosticSettingsSql));
     expect(other).toEqual(extraDefaults);expect(other.pid).not.toBe(native.pid);
     const [held]=await owner.client`select count(*)::int as carriers from pg_stat_activity where pid in(${native.pid},${other.pid}) and usename='ai_hr_app' and datname=current_database() and state='idle in transaction'`;
     expect(held.carriers).toBe(2);
     (isolation.courses as unknown[]).push({module:entry.module,productPid:native.pid,ordinaryPid:other.pid,productEffectiveJit:'off',ordinaryEffectiveJit:'on',simultaneousNativeCarriers:held.carriers});
    },{readOnlySnapshot:true});
   });
   expect(completed.receipt).toMatchObject({complete:true,policyCommandCount:1,effectiveJitAfterProductPolicy:'off',effectiveJitAtCompletion:'off',defaultsRestoredSamePid:true});
   expect(await inspectExtra()).toEqual(extraDefaults);save();
  }
  isolation.complete=true;
 }finally{await extra.client.end({timeout:5});isolation.extraCarrierClosed=true;save();}
 expect(isolation).toMatchObject({complete:true,extraCarrierClosed:true});
 report.ownedOverlapRefused=true;report.ownedCommitAndRollbackRestored=true;report.phase='prepared';prepared=true;save();
},300000);

function pgState(error:unknown):string|null{
 for(let depth=0;error&&typeof error==='object'&&depth<8;depth++){
  const item=error as {code?:unknown;cause?:unknown};if(typeof item.code==='string')return item.code;error=item.cause;
 }return null;
}
async function cancelOwnedRead(tx:database.Tx,pid:number,applicationName:string,signal:AbortSignal){
 const sleeping=Promise.resolve(tx.execute(sql`select pg_sleep(10)`));let settled=false;
 void sleeping.finally(()=>{settled=true;}).catch(()=>{});
 const cancel=()=>owner.client`select pg_cancel_backend(pid)as cancelled from pg_stat_activity where pid=${pid} and datname=current_database() and usename='ai_hr_app' and application_name=${applicationName} and wait_event='PgSleep'`;
 try{
  let ready=false;const deadline=performance.now()+2000;
  for(let attempt=0;attempt<40&&performance.now()<deadline;attempt++){
   signal.throwIfAborted();const [row]=await owner.client`select wait_event='PgSleep' as ready from pg_stat_activity where pid=${pid} and datname=current_database() and usename='ai_hr_app' and application_name=${applicationName}`;
   if(row?.ready){ready=true;break;}if(settled)break;await new Promise(resolve=>setTimeout(resolve,25));
  }
  expect(ready).toBe(true);expect([...await cancel()]).toEqual([{cancelled:true}]);await sleeping;
  throw Error('Owned native sleep did not report cancellation');
 }finally{try{if(!settled)await cancel();}finally{await Promise.allSettled([sleeping]);}}
}

function requireFixture(){assert(prepared&&fixture&&probe,'Required shared fixture/owner preparation did not complete');return {fixture,probe};}
function assertAttendance(value:Awaited<ReturnType<typeof attendanceMonthSummaryPage>>){
 expect(value.state).toMatchObject({total:40000,limit:25,from:1,to:25,hasNext:true,truncated:false});expect(value.rows).toHaveLength(25);
 const expected=Array.from({length:32},(_,i)=>i+1).filter(n=>n%5!==0).slice(0,25);
 expect(value.rows.map(row=>row.name)).toEqual(expected.map(n=>'Fictional retained Personnel '+String(n).padStart(9,'0')));
 for(const row of value.rows)expect(row).toMatchObject({present:1,late:0,halfDay:0,absent:0,leaveDays:0,workedMinutes:480,otWorkday:60,otRestDay:0,otHoliday:0,otCapExceeded:false,over45hWeek:false,
  overtimeSummary:{knownMinutes:{unit:'minutes',numerator:'60',denominator:'1'},complete:true},overtimeCapState:'within'});
}
function assertDashboard(value:Awaited<ReturnType<typeof analyticsDashboard>>){
 expect(value.hc).toEqual({total:40000,byCompany:[{name:'Acme Sdn Bhd',count:40000}],byDepartment:[{name:'Finance',count:40000}],byPosition:[{name:'—',count:40000}]});
 expect(value.masterCount).toBe(40000);expect(value.demographics.total).toBe(40000);
 expect(value.demographics.byGender).toEqual([{name:UNKNOWN_BUCKET,count:40000}]);expect(value.demographics.byAgeBand).toEqual([{name:UNKNOWN_BUCKET,count:40000}]);
 expect(value.nationality).toEqual([{name:UNKNOWN_BUCKET,count:40000}]);
 expect(value.hires.state.total).toBe(50000);expect(value.hires.rows).toHaveLength(25);
 expect(value.hires.rows.map(row=>row.name)).toEqual(Array.from({length:25},(_,i)=>'Fictional retained Personnel '+String(i+1).padStart(9,'0')));
 expect(value.terms.state.total).toBe(10000);expect(value.terms.rows).toHaveLength(25);
 expect(value.terms.rows.map(row=>row.name)).toEqual(Array.from({length:25},(_,i)=>'Fictional retained Personnel '+String((i+1)*5).padStart(9,'0')));
 expect(value.changeJobs.state.total).toBe(0);expect(value.changeJobs.rows).toEqual([]);
 expect(value.carryForward.state.total).toBe(50000);expect(value.carryForward.rows).toHaveLength(25);
 expect(value.carryForward.rows.map(row=>row.employeeName)).toEqual(Array.from({length:25},(_,i)=>'Fictional retained Personnel '+String(i+1).padStart(9,'0')));
 expect(value.carryForward.rows.every(row=>row.carried===0&&row.forfeitedAtOpen===0&&row.forfeitedAtExpiry===0)).toBe(true);
 expect(value.turnover).toEqual({leavers:10000,headcountStart:50000,headcountEnd:40000,avgHeadcount:45000,turnoverPct:22.2});
 expect(value.movement).toEqual([{month:'2020-01',hires:50000,leavers:0,netChange:50000},{month:'2024-01',hires:0,leavers:10000,netChange:-10000}]);
 expect(value.leaveUtil).toEqual([]);expect(value.leaveBalances).toEqual([]);expect(value.sickTrend).toEqual({configured:false,series:[]});
}
async function planMatrix(module:'attendance'|'analytics',shapes:CapturedStatement[]){
 const {probe}=requireFixture();let order=0;
 for(const shape of shapes)for(const mode of ['on','off','off','on']as const){await probe.explain(module,mode,shape,++order);save();}
}

it('enforces effectiveOFF Attendance under each requested parent mode and explains exact native counterfactual count/window shapes',async()=>{
 const {fixture,probe}=requireFixture();report.phase='attendance';save();
 let baseline:Awaited<ReturnType<typeof attendanceMonthSummaryPage>>|undefined,statements:CapturedStatement[]|undefined;
 for(const [sample,mode]of (['on','off','off','on']as JitMode[]).entries()){
  const result=await probe.run('attendance-whole-'+(sample+1),mode,()=>attendanceMonthSummaryPage(fixture.ctx,{month:'2026-05',today:'2026-05-01',companyIds:[fixture.b.companyId],page:parsePageQuery()}));
  assertAttendance(result.value);expect(result.receipt).toMatchObject({complete:true,requestedJit:mode,effectiveJitAfterProductPolicy:'off',effectiveJitAtCompletion:'off',policyCommandCount:1,census:{statements:32,rows:208,unknownRows:0,failed:0},defaultsRestoredSamePid:true,transactionCalls:1});
  const policy=result.queries.filter(query=>query.text==='set local jit=off');expect(policy).toHaveLength(1);expect(policy[0]).toMatchObject({params:[],rows:0,ordinal:4});
  const attendance=result.queries.filter(q=>q.text.includes('from "attendance"'));expect(attendance.map(q=>q.rows)).toEqual([25,25]);
  if(baseline){expect(result.value).toEqual(baseline);expect(probe.sameQueries(statements!,result.queries)).toBe(true);}else{baseline=result.value;statements=result.queries;}
  result.receipt.completeDtoAndQueryParameterParity=true;result.receipt.independentKnownFacts=true;save();
 }
 assert(statements);const count=statements[4],window=statements[5];
 expect(count.text).toContain('attendance_month_population');expect(count.rows).toBe(1);
 expect(window.text).toContain('order by "person"."full_name"');expect(window.rows).toBe(25);
 expect(count.digest).toBe('6c9988ac779e1d6a9007d3a9ae8ebc5b116214ba5487b1c0a61fcbbf0cafb570');
 expect(window.digest).toBe('fb1f610d92182838828d3bd4b38b3d171b610d7f5ed671679978c9afdbca0571');
 await planMatrix('attendance',[count,window]);expect(digest(await nativeModuleFingerprint())).toBe(digest(fingerprint));
 attendanceComplete=true;report.attendanceComplete=true;save();
},300000);

it('enforces effectiveOFF thirteen-report Analytics under each parent mode and preserves all native counterfactual shapes and DTO parity',async()=>{
 const {fixture,probe}=requireFixture();report.phase='analytics';save();
 let baseline:Awaited<ReturnType<typeof analyticsDashboard>>|undefined,statements:CapturedStatement[]|undefined;
 for(const [sample,mode]of (['on','off','off','on']as JitMode[]).entries()){
  const page=parsePageQuery();const result=await probe.run('analytics-whole-'+(sample+1),mode,()=>analyticsDashboard(fixture.ctx,[fixture.b.companyId],{
   from:'2020-01-01',to:'2026-01-01',year:2020,filters:{},pages:{hires:page,terms:page,changeJobs:page,carryForward:page}}));
  assertDashboard(result.value);expect(result.receipt).toMatchObject({complete:true,requestedJit:mode,effectiveJitAfterProductPolicy:'off',effectiveJitAtCompletion:'off',policyCommandCount:1,census:{statements:125,rows:90091,unknownRows:0,failed:0},defaultsRestoredSamePid:true,transactionCalls:1});
  const policy=result.queries.filter(query=>query.text==='set local jit=off');expect(policy).toHaveLength(1);expect(policy[0]).toMatchObject({params:[],rows:0,ordinal:2});
  const nationality=result.queries.filter(q=>q.classification==='nationality');expect(nationality).toHaveLength(1);expect(nationality[0].rows).toBe(1);
  if(baseline){expect(result.value).toEqual(baseline);expect(probe.sameQueries(statements!,result.queries)).toBe(true);}else{baseline=result.value;statements=result.queries;}
  result.receipt.completeDtoAndQueryParameterParity=true;result.receipt.independentKnownFacts=true;save();
 }
 assert(statements);const expectedDigests={nationality:'1e056a14bef2f1ec68b8556dc5bc2463ee87ebd29426dba2176c59085b6a97fe',
  'demographic-dimensions':'185cde653c89db22339422934d86773e3748c8a76141988bcbd208b474f83771',
  'master-count':'d6f279c1c028da663622ab8e5cb2408530b268e765d2bb7a1eff7740a00dd45b'};
 const shapes=(['nationality','demographic-dimensions','master-count']as const).map(label=>{
  const found=statements!.filter(q=>q.classification===label);expect(found).toHaveLength(1);expect(found[0].digest).toBe(expectedDigests[label]);return found[0];
 });
 await planMatrix('analytics',shapes);expect(probe.plans).toHaveLength(20);expect(digest(await nativeModuleFingerprint())).toBe(digest(fingerprint));
 report.sourcePins={entrySha256:createHash('sha256').update(readFileSync(new URL('./module-read-jit-diagnostic.test.ts',import.meta.url))).digest('hex'),
  probeSha256:createHash('sha256').update(readFileSync(new URL('./performance/module-read-jit-probe.ts',import.meta.url))).digest('hex')};
 analyticsComplete=true;report.analyticsComplete=true;report.phase='read-courses-complete';save();
},300000);
