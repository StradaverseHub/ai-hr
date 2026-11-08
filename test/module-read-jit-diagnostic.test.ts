/** Three complete hosted cases. Off arms are diagnostics, never normal acceptance. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {cpus,totalmem} from 'node:os';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import * as database from '../db/client';
import {attendanceMonthSummaryPage} from '../packs/attendance/service';
import {analyticsDashboard,UNKNOWN_BUCKET} from '../core/analytics';
import {withModulePresentationRead} from '../core/module-presentation-read';
import {parsePageQuery} from '../lib/pagination';
import {closeAll,migrateTestDb,owner,setModule} from './harness';
import {admitSingletonTest} from './helpers/ci-singleton-admission';
import {seedPersonnelNativeFixture} from './performance/personnel-native-fixture';
import {actualDriverPins,createModuleReadJitProbe,digest,nativeModuleFingerprint,type CapturedStatement,type JitMode} from './performance/module-read-jit-probe';

const admission=admitSingletonTest('test/module-read-jit-diagnostic.test.ts');
const report:Record<string,unknown>={kind:'SHARED_MODULE_READ_JIT_DIAGNOSTIC_ONLY',releaseEligible:false,complete:false,cleanupComplete:false,
 host:{cpus:cpus().length,cpuModels:[...new Set(cpus().map(cpu=>cpu.model))],memoryBytes:totalmem()},
 limits:{cases:3,caseMs:300000,defaultHookMs:30000,focusedOuterMs:1200000,fullSingletonOuterMs:7200000,profileVersion:2,configuredPgCapBytes:2113929216,pgPeakBudgetBytes:2147483648,normalProfileJit:'on'},
 warmth:'Fixture creation/ANALYZE warm buffers and functions. Every arm discards plans; no storage-cold claim or paired production speed acceptance.',
 planCoverage:'Five actual captured SELECT objects, twenty plans. Cursor DECLARE/FETCH/CLOSE remains in whole read census and is not EXPLAIN-rewritten.'};
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

it('prepares one fictional50000 fixture and proves actual unprepared driver, exclusive owner and commit/rollback JIT restoration',async()=>{
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
 report.ownedOverlapRefused=true;report.ownedCommitAndRollbackRestored=true;report.phase='prepared';prepared=true;save();
},300000);

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

it('pairs the unchanged actual Attendance snapshot on/off/off/on and explains exact count/window objects under the same native purpose',async()=>{
 const {fixture,probe}=requireFixture();report.phase='attendance';save();
 let baseline:Awaited<ReturnType<typeof attendanceMonthSummaryPage>>|undefined,statements:CapturedStatement[]|undefined;
 for(const [sample,mode]of (['on','off','off','on']as JitMode[]).entries()){
  const result=await probe.run('attendance-whole-'+(sample+1),mode,()=>attendanceMonthSummaryPage(fixture.ctx,{month:'2026-05',today:'2026-05-01',companyIds:[fixture.b.companyId],page:parsePageQuery()}));
  assertAttendance(result.value);expect(result.receipt).toMatchObject({complete:true,census:{statements:31,rows:208,unknownRows:0,failed:0},defaultsRestoredSamePid:true,transactionCalls:1});
  const attendance=result.queries.filter(q=>q.text.includes('from "attendance"'));expect(attendance.map(q=>q.rows)).toEqual([25,25]);
  if(baseline){expect(result.value).toEqual(baseline);expect(probe.sameQueries(statements!,result.queries)).toBe(true);}else{baseline=result.value;statements=result.queries;}
  result.receipt.completeDtoAndQueryParameterParity=true;result.receipt.independentKnownFacts=true;save();
 }
 assert(statements);const count=statements[3],window=statements[4];
 expect(count.text).toContain('attendance_month_population');expect(count.rows).toBe(1);
 expect(window.text).toContain('order by "person"."full_name"');expect(window.rows).toBe(25);
 expect(count.digest).toBe('6c9988ac779e1d6a9007d3a9ae8ebc5b116214ba5487b1c0a61fcbbf0cafb570');
 expect(window.digest).toBe('fb1f610d92182838828d3bd4b38b3d171b610d7f5ed671679978c9afdbca0571');
 await planMatrix('attendance',[count,window]);expect(digest(await nativeModuleFingerprint())).toBe(digest(fingerprint));
 attendanceComplete=true;report.attendanceComplete=true;save();
},300000);

it('pairs the unchanged actual thirteen-report Analytics snapshot and native nationality/demographic/master plans with complete DTO parity',async()=>{
 const {fixture,probe}=requireFixture();report.phase='analytics';save();
 let baseline:Awaited<ReturnType<typeof analyticsDashboard>>|undefined,statements:CapturedStatement[]|undefined;
 for(const [sample,mode]of (['on','off','off','on']as JitMode[]).entries()){
  const page=parsePageQuery();const result=await probe.run('analytics-whole-'+(sample+1),mode,()=>analyticsDashboard(fixture.ctx,[fixture.b.companyId],{
   from:'2020-01-01',to:'2026-01-01',year:2020,filters:{},pages:{hires:page,terms:page,changeJobs:page,carryForward:page}}));
  assertDashboard(result.value);expect(result.receipt).toMatchObject({complete:true,census:{statements:124,rows:90091,unknownRows:0,failed:0},defaultsRestoredSamePid:true,transactionCalls:1});
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
