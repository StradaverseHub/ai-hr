import {writeFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {cpus,totalmem} from 'node:os';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {
 analyticsDashboard,UNKNOWN_BUCKET,analyticsManagerSelection,carryForwardReportPage,changeJobTransactionsPage,headcountSummary,
 masterDataCount,masterDataExport,newHires,newHiresPage,terminationsPage,
} from '../core/analytics';
import {parsePageQuery} from '../lib/pagination';
import {closeAll,migrateTestDb} from './harness';
import {seedPersonnelNativeFixture} from './performance/personnel-native-fixture';
import {observeNativeRead} from './helpers/native-read-observer';

// Structural statement shapes from the actual canonical read bodies. This labels
// observations, never chooses a query/permission or infers a slow business report.
const analyticsStatementClassifierVersion='analytics-statement-shapes/v1';
function classifyAnalyticsStatement(text:string):string{
 const query=text.toLowerCase().replace(/\s+/g,' ');
 if(query.includes('public.app_user u'))return 'principal';
 for(const [marker,label]of [
  ['analytics_headcount','headcount'],['analytics_newhires_page','hires-page'],
  ['analytics_terminations_page','terminations-page'],['analytics_changejobtransactions_page','change-jobs-page'],
  ['analytics_master_count','master-count'],
 ]as const)if(query.includes(marker))return label;
 if(query.startsWith('declare analytics_carry_identities '))return 'carry-identities-declare';
 if(query.startsWith('fetch forward 512 from analytics_carry_identities'))return 'carry-identities-fetch';
 if(query.startsWith('close analytics_carry_identities'))return 'carry-identities-close';
 if(query.includes('analytics_carry_population'))return 'carry-population';
 if(query.includes('"gender"')&&query.includes('"date_of_birth"'))return 'demographic-dimensions';
 if(query.startsWith('select distinct ')&&query.includes('"epf_citizenship"'))return 'nationality';
 if(/^select count\(\*\) from "employment" where /.test(query))return 'turnover-count';
 if(query.includes('from "leave_ledger"')&&query.includes("'in_lieu_accrual'"))return 'leave-utilisation';
 if(query.startsWith('select "leave_type"."name", coalesce(sum(')&&query.includes('from "leave_ledger"'))return 'leave-balance';
 if(query.includes('to_char("employment"."hired_on"'))return 'movement-hires';
 if(query.includes('to_char("employment"."terminated_on"'))return 'movement-leavers';
 if(query.includes('from "leave_type"'))return 'leave-type-support';
 if(query.includes('from "leave_ledger"'))return 'leave-ledger-support';
 if(query.includes('from "entitlement_template'))return 'entitlement-template-support';
 return 'unclassified';
}

beforeAll(migrateTestDb);afterAll(closeAll);
it('measures actual native 50k Analytics reads and complete-export baselines on the same runner',async()=>{
 const report:Record<string,unknown>={kind:'NATIVE_ANALYTICS_COMPONENT_ONLY',releaseEligible:false,employees:50000,
  machine:{logicalCpus:cpus().length,cpu:cpus()[0]?.model,totalMemoryBytes:totalmem()},timings:{},pageRows:{}};
 const save=()=>{if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'analytics-native-50k.json'),JSON.stringify(report,null,2));};
 const timed=async<T>(name:string,read:()=>Promise<T>)=>{
  report.phase=name;save();const start=performance.now();
  try{const result=await read();(report.timings as Record<string,number>)[name]=performance.now()-start;save();return result;}
  catch(error){report.failedPhase=name;report.failure=error instanceof Error?error.message:'Unknown failure';save();throw error;}
 };
 const {b,ctx,expectedLast}=await seedPersonnelNativeFixture(50000,report,()=>{},save);
 const page=parsePageQuery(),hired={from:'2020-01-01',to:'2020-12-31'},ended={from:'2024-01-01',to:'2024-12-31'};
 const manager=await timed('selectedManagerMs',()=>analyticsManagerSelection(ctx,[b.companyId],expectedLast.at(-1)));
 expect(manager).toEqual({employmentId:expectedLast.at(-1),name:'Fictional retained Personnel 000050000'});
 const hires=await timed('newHiresPageMs',()=>newHiresPage(ctx,[b.companyId],{...hired,page}));
 expect(hires.state.total).toBe(50000);expect(hires.rows).toHaveLength(25);
 expect(hires.rows.map(row=>row.name)).toEqual(Array.from({length:25},(_,i)=>'Fictional retained Personnel '+String(i+1).padStart(9,'0')));
 const deep=await timed('deepNewHiresPageMs',()=>newHiresPage(ctx,[b.companyId],{...hired,page:parsePageQuery({page:'1999'})}));
 expect(deep.state.total).toBe(50000);expect(deep.rows.at(-1)?.name).toBe('Fictional retained Personnel 000050000');
 const terms=await timed('terminationsPageMs',()=>terminationsPage(ctx,[b.companyId],{...ended,page}));
 expect(terms.state.total).toBe(10000);expect(terms.rows).toHaveLength(25);
 const changes=await timed('changeJobsPageMs',()=>changeJobTransactionsPage(ctx,[b.companyId],{...hired,page}));
 expect(changes.state.total).toBe(0);expect(changes.rows).toEqual([]);
 const carry=await timed('carryForwardPageMs',()=>carryForwardReportPage(ctx,[b.companyId],{year:2020,page}));
 expect(carry.state.total).toBe(50000);expect(carry.rows).toHaveLength(25);expect(carry.rows.every(row=>row.carried===0&&row.forfeitedAtOpen===0&&row.forfeitedAtExpiry===0)).toBe(true);
 const headcount=await timed('headcountAggregateMs',()=>headcountSummary(ctx,[b.companyId],{asOf:'2026-01-01'}));
 expect(headcount).toEqual({total:40000,byCompany:[{name:'Acme Sdn Bhd',count:40000}],byDepartment:[{name:'Finance',count:40000}],byPosition:[{name:'—',count:40000}]});
 const count=await timed('masterDataCountMs',()=>masterDataCount(ctx,[b.companyId]));expect(count).toBe(40000);
 const baseline=await timed('completeMasterExportThenCountMs',()=>masterDataExport(ctx,[b.companyId]));expect(baseline).toHaveLength(40000);
 const fullHires=await timed('completeNewHiresMs',()=>newHires(ctx,[b.companyId],hired));expect(fullHires).toHaveLength(50000);
 report.transportBytes={fullNewHires:Buffer.byteLength(JSON.stringify(fullHires)),pagedNewHires:Buffer.byteLength(JSON.stringify(hires)),
  fullMaster:Buffer.byteLength(JSON.stringify(baseline)),masterCount:Buffer.byteLength(JSON.stringify(count))};
 report.pageRows={hires:hires.rows.length,deep:deep.rows.length,terms:terms.rows.length,changes:changes.rows.length,carry:carry.rows.length};
 // Measure the actual shared dashboard course, retaining every standalone read
 // and full export above. Its independent fixture facts are not a timing target.
 const dashboard=await timed('dashboardSnapshotMs',()=>analyticsDashboard(ctx,[b.companyId],{
  from:'2020-01-01',to:'2026-01-01',year:2020,filters:{},
  pages:{hires:page,terms:page,changeJobs:page,carryForward:page},
 }));
 expect(dashboard.hc).toEqual({total:40000,byCompany:[{name:'Acme Sdn Bhd',count:40000}],byDepartment:[{name:'Finance',count:40000}],byPosition:[{name:'—',count:40000}]});
 expect(dashboard.masterCount).toBe(40000);expect(dashboard.demographics.total).toBe(40000);
 expect(dashboard.demographics.byGender).toEqual([{name:UNKNOWN_BUCKET,count:40000}]);
 expect(dashboard.demographics.byAgeBand).toEqual([{name:UNKNOWN_BUCKET,count:40000}]);
 expect(dashboard.nationality).toEqual([{name:UNKNOWN_BUCKET,count:40000}]);
 expect(dashboard.hires.state.total).toBe(50000);expect(dashboard.hires.rows).toHaveLength(25);
 expect(dashboard.hires.rows.map(row=>row.name)).toEqual(Array.from({length:25},(_,i)=>'Fictional retained Personnel '+String(i+1).padStart(9,'0')));
 expect(dashboard.terms.state.total).toBe(10000);expect(dashboard.terms.rows).toHaveLength(25);
 expect(dashboard.terms.rows.map(row=>row.name)).toEqual(Array.from({length:25},(_,i)=>'Fictional retained Personnel '+String((i+1)*5).padStart(9,'0')));
 expect(dashboard.changeJobs.state.total).toBe(0);expect(dashboard.changeJobs.rows).toEqual([]);
 expect(dashboard.carryForward.state.total).toBe(50000);expect(dashboard.carryForward.rows).toHaveLength(25);
 expect(dashboard.carryForward.rows.map(row=>row.employeeName)).toEqual(Array.from({length:25},(_,i)=>'Fictional retained Personnel '+String(i+1).padStart(9,'0')));
 expect(dashboard.carryForward.rows.every(row=>row.carried===0&&row.forfeitedAtOpen===0&&row.forfeitedAtExpiry===0)).toBe(true);
 expect(dashboard.turnover).toEqual({leavers:10000,headcountStart:50000,headcountEnd:40000,avgHeadcount:45000,turnoverPct:22.2});
 expect(dashboard.movement).toEqual([{month:'2020-01',hires:50000,leavers:0,netChange:50000},{month:'2024-01',hires:0,leavers:10000,netChange:-10000}]);
 expect(dashboard.leaveUtil).toEqual([]);expect(dashboard.leaveBalances).toEqual([]);expect(dashboard.sickTrend).toEqual({configured:false,series:[]});
 report.dashboardSnapshot={reports:13,headcount:dashboard.hc.total,masterCount:dashboard.masterCount,demographics:dashboard.demographics.total,
  hires:{total:dashboard.hires.state.total,rows:dashboard.hires.rows.length},terms:{total:dashboard.terms.state.total,rows:dashboard.terms.rows.length},
  changes:{total:dashboard.changeJobs.state.total,rows:dashboard.changeJobs.rows.length},carry:{total:dashboard.carryForward.state.total,rows:dashboard.carryForward.rows.length},
  transportBytes:Buffer.byteLength(JSON.stringify(dashboard)),independentNativeFixtureFacts:true};
 // A second, explicitly instrumented course follows the untouched unobserved
 // timing and independent facts. Instrumentation/warmth prevents a speedup claim.
 const probe=observeNativeRead({captureQueries:false,classify:classifyAnalyticsStatement});
 let instrumented:Awaited<ReturnType<typeof analyticsDashboard>>;
 try{
  instrumented=await timed('dashboardSnapshotInstrumentedMs',()=>analyticsDashboard(ctx,[b.companyId],{
   from:'2020-01-01',to:'2026-01-01',year:2020,filters:{},
   pages:{hires:page,terms:page,changeJobs:page,carryForward:page},
  }));
 }finally{probe.restore();report.dashboardQueryTelemetry={...probe.telemetry(),complete:false};save();}
 expect(instrumented!).toEqual(dashboard);
 expect(probe.properties).toHaveLength(1);
 expect(probe.properties[0]).toMatchObject({role:'ai_hr_app',isolation:'repeatable read',readOnly:true});
 expect(probe.state).toEqual({active:0,maxActive:1});expect(probe.queries).toEqual([]);
 const telemetry=probe.telemetry();
 expect(telemetry.detailComplete).toBe(true);expect(telemetry.totals.statements).toBeGreaterThan(0);
 expect(telemetry.totals.failed).toBe(0);expect(telemetry.totals.unknownRowCounts).toBe(0);
 expect(telemetry.summaries.reduce((sum,row)=>sum+row.count,0)).toBe(telemetry.totals.statements);
 expect(telemetry.summaries.reduce((sum,row)=>sum+row.returnedRows,0)).toBe(telemetry.totals.returnedRows);
 for(const row of telemetry.samples){
  expect(row.digest).toMatch(/^[a-f0-9]{64}$/);expect(row.succeeded).toBe(true);
  expect(Number.isFinite(row.elapsedMs)&&row.elapsedMs>=0).toBe(true);
  expect(Number.isSafeInteger(row.returnedRows)&&(row.returnedRows??-1)>=0).toBe(true);
 }
 const instrumentedElapsedMs=(report.timings as Record<string,number>).dashboardSnapshotInstrumentedMs;
 expect(telemetry.totals.elapsedMs).toBeLessThanOrEqual(instrumentedElapsedMs);
 report.dashboardQueryTelemetry={...telemetry,complete:true,classifierVersion:analyticsStatementClassifierVersion,
  classifierSourceSha256:createHash('sha256').update(readFileSync(new URL('./analytics-native-scale.test.ts',import.meta.url))).digest('hex'),
  observerSourceSha256:createHash('sha256').update(readFileSync(new URL('./helpers/native-read-observer.ts',import.meta.url))).digest('hex'),
  instrumentedElapsedMs,nonQueryObservedMs:instrumentedElapsedMs-telemetry.totals.elapsedMs,
  actualTransactions:probe.properties.length,role:probe.properties[0].role,isolation:probe.properties[0].isolation,readOnly:probe.properties[0].readOnly,
  sameCompleteDto:true,limitations:'Second observed call; includes observer overhead and warmed data. Statement awaits exclude after-query callbacks; nonquery remainder includes admission, test identity probe and client aggregation.'};
 report.exactNativePopulationAndResults=true;report.complete=true;save();
},300000);
