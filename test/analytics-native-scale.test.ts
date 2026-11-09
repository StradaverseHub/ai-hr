import {writeFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {cpus,totalmem} from 'node:os';
import {sql,type SQL} from 'drizzle-orm';
import {PgDialect} from 'drizzle-orm/pg-core';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import {
 analyticsDashboard,UNKNOWN_BUCKET,analyticsManagerSelection,carryForwardReportPage,changeJobTransactionsPage,headcountSummary,
 masterDataCount,masterDataExport,newHires,newHiresPage,terminationsPage,
} from '../core/analytics';
import {parsePageQuery} from '../lib/pagination';
import {closeAll,migrateTestDb,owner} from './harness';
import {seedPersonnelNativeFixture} from './performance/personnel-native-fixture';
import {observeNativeRead} from './helpers/native-read-observer';
import {originalEmploymentAggregatesTx} from './helpers/analytics-employment-aggregates-original';

// Structural statement shapes from the actual canonical read bodies. This labels
// observations, never chooses a query/permission or infers a slow business report.
const analyticsStatementClassifierVersion='analytics-statement-shapes/v5';
function classifyAnalyticsStatement(text:string):string{
 const query=text.toLowerCase().replace(/\s+/g,' ');
 if(text==='set local jit=off')return 'presentation-jit-policy';
 if(query.includes('public.app_user u'))return 'principal';
 for(const [marker,label]of [
  ['analytics_headcount','headcount'],['analytics_newhires_page','hires-page'],
  ['analytics_terminations_page','terminations-page'],['analytics_changejobtransactions_page','change-jobs-page'],
  ['analytics_master_count','master-count'],
 ]as const)if(query.includes(marker))return label;
 if(query.startsWith('declare analytics_carry_identities '))return 'carry-identities-declare';
 if(query.startsWith('fetch forward 512 from analytics_carry_identities')||query.startsWith('fetch forward 4096 from analytics_carry_identities'))return 'carry-identities-fetch';
 if(query.startsWith('close analytics_carry_identities'))return 'carry-identities-close';
 if(query.includes('analytics_carry_population'))return 'carry-population';
 if(query.includes('analytics_turnover_leavers'))return 'turnover-aggregate';
 if(query.includes('analytics_movement_event'))return 'movement-aggregate';
 if(query.includes('"gender"')&&query.includes('"date_of_birth"'))return 'demographic-dimensions';
 if(query.startsWith('select "employee_statutory_my"."epf_citizenship", count(distinct "person"."id")')
  &&query.endsWith('group by "employee_statutory_my"."epf_citizenship"'))return 'nationality';
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

type CapturedSelect={statement:SQL;text:string;digest:string};
/** Capture actual public builder SQL objects; never reconstruct SQL/parameters
 * from a string or introduce a product hook. Objects stay in test memory only. */
function captureSelects(tx:Tx,captured:CapturedSelect[]):Tx{
 const dialect=new PgDialect();
 const wrap=(query:object):object=>new Proxy(query,{get(target,key,receiver){
  const value=Reflect.get(target,key,receiver);
  if(key==='then'&&typeof value==='function')return (resolve:(rows:unknown)=>unknown,reject:(error:unknown)=>unknown)=>{
   expect(captured.length).toBeLessThan(128);
   const builder=target as {getSQL:()=>SQL;toSQL:()=>{sql:string}};
   const text=builder.toSQL().sql;captured.push({statement:builder.getSQL(),text,digest:createHash('sha256').update(text).digest('hex')});
   return Reflect.apply(value,target,[resolve,reject]);
  };
  return typeof value==='function'?(...args:unknown[])=>{const result=Reflect.apply(value,target,args);return result&&typeof result==='object'&&'then'in result?wrap(result):result;}:value;
 }});
 return new Proxy(tx,{get(target,key,receiver){
  if(key==='select'||key==='selectDistinct')return (...args:unknown[])=>wrap(Reflect.apply(target[key],target,args));
  // One fixed product CTE now uses public execute. Capture that actual SQL
  // object only, not arbitrary control/identity/cursor statements.
  if(key==='execute')return (statement:SQL)=>{
   const text=dialect.sqlToQuery(statement).sql;
   if(/^\s*with analytics_changeJobTransactions_page as materialized \(/.test(text)){
    expect(captured.length).toBeLessThan(128);captured.push({statement,text,digest:createHash('sha256').update(text).digest('hex')});
   }
   return target.execute(statement);
  };
  const value=Reflect.get(target,key,receiver);return typeof value==='function'?value.bind(target):value;
 }});
}
/** Bounded, content-free EXPLAIN detail. Filters, SQL, parameters, outputs and
 * native error content never enter the receipt. Any detail overflow refuses. */
function aggregateNativePlan(raw:unknown){
 expect(Array.isArray(raw)).toBe(true);const plans=raw as Record<string,unknown>[];expect(plans).toHaveLength(1);
 const root=plans[0],nodes:Record<string,unknown>[]=[];
 const visit=(value:unknown,parent:number|null)=>{
  expect(value&&typeof value==='object').toBeTruthy();expect(nodes.length).toBeLessThan(256);
  const node=value as Record<string,unknown>,ordinal=nodes.length,item:Record<string,unknown>={ordinal,parent};nodes.push(item);
  expect(typeof node['Node Type']).toBe('string');expect(String(node['Node Type'])).toMatch(/^[A-Za-z0-9 _-]{1,96}$/);item.type=node['Node Type'];
  for(const key of ['Actual Rows','Actual Loops','Actual Startup Time','Actual Total Time','Plan Rows','Total Cost','Rows Removed by Filter','Rows Removed by Join Filter','Shared Hit Blocks','Shared Read Blocks','Temp Read Blocks','Temp Written Blocks']){
   const value=node[key];if(value!==undefined){expect(typeof value).toBe('number');expect(Number.isFinite(value)).toBe(true);item[key]=value;}
  }
  const children=node.Plans??[];expect(Array.isArray(children)).toBe(true);for(const child of children as unknown[])visit(child,ordinal);
 };
 visit(root.Plan,null);expect(root.JIT).toBeUndefined();
 for(const key of ['Planning Time','Execution Time']){expect(typeof root[key]).toBe('number');expect(Number.isFinite(root[key])).toBe(true);}
 return {rawPlanSha256:createHash('sha256').update(JSON.stringify(raw)).digest('hex'),planningMs:root['Planning Time'],executionMs:root['Execution Time'],jit:null,nodes,maximumNodes:256,detailComplete:true};
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
 const {b,ctx,expectedFirst,expectedLast}=await seedPersonnelNativeFixture(50000,report,()=>{},save);
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
 // Same thirteen reports/cursor and one fixed JIT command; only the two
 // employment aggregates replace their original five SELECTs.
 // The empty change-job page now returns its one count envelope instead
 // of an empty page SELECT followed by a separate count SELECT.
 // Nationality retains its single independently expected Unknown bucket.
 // Fixed4096 carry batches retain all50,000 identities. The demographics
 // fixture has one raw value per dimension plus the overall total.
 expect(telemetry.totals.statements).toBe(36);
 expect(telemetry.totals.returnedRows).toBe(50097);
 const demographicCounts=telemetry.summaries.filter(row=>row.classification==='demographic-dimensions');
 expect(demographicCounts).toHaveLength(1);
 expect(demographicCounts[0]).toMatchObject({count:1,returnedRows:8,unknownRowCounts:0,failed:0});
 const carryFetch=telemetry.summaries.filter(row=>row.classification==='carry-identities-fetch');
 expect(carryFetch).toHaveLength(1);expect(carryFetch[0]).toMatchObject({count:13,returnedRows:50000,unknownRowCounts:0,failed:0});
 const changeJobSummary=telemetry.summaries.filter(row=>row.classification==='change-jobs-page');
 expect(changeJobSummary).toHaveLength(1);expect(changeJobSummary[0]).toMatchObject({count:1,returnedRows:1,failed:0});
 const employmentAggregates=telemetry.summaries.filter(row=>row.classification==='turnover-aggregate'||row.classification==='movement-aggregate');
 expect(employmentAggregates.map(row=>({classification:row.classification,count:row.count,rows:row.returnedRows}))).toEqual([
  {classification:'turnover-aggregate',count:1,rows:1},{classification:'movement-aggregate',count:1,rows:2},
 ]);
 expect(telemetry.summaries.filter(row=>['turnover-count','movement-hires','movement-leavers'].includes(row.classification))).toEqual([]);
 const policy=telemetry.summaries.filter(row=>row.classification==='presentation-jit-policy');
 expect(policy).toHaveLength(1);expect(policy[0]).toMatchObject({count:1,returnedRows:0,unknownRowCounts:0,failed:0});
 const principalOrdinal=telemetry.samples.find(row=>row.classification==='principal')!.ordinal;
 expect(policy[0].firstOrdinal).toBeGreaterThan(principalOrdinal);
 expect(policy[0].firstOrdinal).toBeLessThan(telemetry.samples.find(row=>row.classification==='headcount')!.ordinal);
 const nationality=telemetry.summaries.filter(row=>row.classification==='nationality');
 expect(nationality).toHaveLength(1);expect(nationality[0].count).toBe(1);
 expect(nationality[0].returnedRows).toBe(1);expect(nationality[0].returnedRows).toBeLessThanOrEqual(4);
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
 // A separate experiment follows BOTH unchanged whole-dashboard timings. The
 // real product callback completes before its same admitted RR/RO Tx executes
 // the frozen source, balanced native replays and seven plans. This extended
 // callback is not a whole-dashboard speed measurement or a cold course.
 const aggregateExperiment:Record<string,unknown>={kind:'TARGET_NATIVE_STATEMENTS_ONLY',complete:false,callbackComplete:false,transactionSettled:false,
  includesSqlParametersResultsOrErrors:false,newPools:0,warmth:'Fixture and all prior report courses warm buffers; ordinary plan reuse, no cold claim',
  limits:{capturedSelects:128,arms:4,plans:7,planNodesEach:256,unchangedCaseMs:300000},arms:[],plans:[]};
 report.employmentAggregateExperiment=aggregateExperiment;save();
 const actualWithTenant=database.withTenant;let experimentTransactions=0;
 const experimentSpy=vi.spyOn(database,'withTenant').mockImplementation(<T>(supplied:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>actualWithTenant(supplied,async tx=>{
  experimentTransactions++;expect(experimentTransactions).toBe(1);expect(options).toEqual({readOnlySnapshot:true});
  const current:CapturedSelect[]=[],value=await read(captureSelects(tx,current));expect(value).toEqual(dashboard);
  const [identity]=await tx.execute<{pid:number;role:string;login:string;isolation:string;readOnly:boolean;jit:string;rls:string}>(sql`select pg_backend_pid()as pid,current_user as role,session_user as login,current_setting('transaction_isolation')as isolation,current_setting('transaction_read_only')='on'as "readOnly",current_setting('jit')as jit,current_setting('row_security')as rls`);
  expect(identity).toMatchObject({role:'ai_hr_app',login:'ai_hr_app',isolation:'repeatable read',readOnly:true,jit:'off',rls:'on'});aggregateExperiment.identity=identity;save();
  const old:CapturedSelect[]=[],original=await originalEmploymentAggregatesTx(captureSelects(tx,old),[b.companyId],{from:'2020-01-01',to:'2026-01-01',filters:{}});
  expect(original).toEqual({turnover:dashboard.turnover,movement:dashboard.movement});expect(old).toHaveLength(5);
  const candidate=current.filter(query=>query.text.includes('analytics_turnover_leavers')||query.text.includes('analytics_movement_event'));expect(candidate).toHaveLength(2);
  expect(old.slice(0,3).every(query=>classifyAnalyticsStatement(query.text)==='turnover-count')).toBe(true);
  expect(old.slice(3).map(query=>classifyAnalyticsStatement(query.text))).toEqual(['movement-hires','movement-leavers']);
  aggregateExperiment.sourceStatements={original:5,candidate:2,originalDigests:old.map(q=>q.digest),candidateDigests:candidate.map(q=>q.digest)};save();
  const sets={old,new:candidate};let originalFacts:unknown,candidateFacts:unknown;
  for(const [ordinal,label]of (['old','new','new','old']as const).entries()){
   const receipt:Record<string,unknown>={ordinal:ordinal+1,source:label,started:true,complete:false,statements:[],samePid:false};
   (aggregateExperiment.arms as unknown[]).push(receipt);save();const started=performance.now(),results:unknown[][]=[];
   try{
    for(const query of sets[label]){
     const start=performance.now(),rows=await tx.execute<Record<string,unknown>>(query.statement);results.push([...rows]);
     (receipt.statements as unknown[]).push({digest:query.digest,rows:rows.length,elapsedMs:performance.now()-start});save();
    }
    if(label==='old'){
     const counts=results.slice(0,3)as Record<string,unknown>[][];expect(counts.map(rows=>Number(rows[0].count))).toEqual([10000,50000,40000]);
     const months=results.slice(3)as Record<string,unknown>[][];expect(months.map(rows=>rows.map(row=>({month:row.to_char,count:Number(row.count)})))).toEqual([[{month:'2020-01',count:50000}],[{month:'2024-01',count:10000}]]);
     const facts={counts:counts.map(rows=>Number(rows[0].count)),months:months.map(rows=>rows.map(row=>({month:String(row.to_char),count:Number(row.count)})).sort((a,b)=>a.month.localeCompare(b.month)))};
     if(originalFacts)expect(facts).toEqual(originalFacts);else originalFacts=facts;
    }else{
     const counts=(results[0]as Record<string,unknown>[])[0];expect([Number(counts.analytics_turnover_leavers),Number(counts.analytics_turnover_start),Number(counts.analytics_turnover_end)]).toEqual([10000,50000,40000]);
     const months=(results[1]as Record<string,unknown>[]).map(row=>({month:String(row.to_char),hires:Number(row.analytics_movement_hires),leavers:Number(row.analytics_movement_leavers)})).sort((a,b)=>a.month.localeCompare(b.month));
     expect(months).toEqual([{month:'2020-01',hires:50000,leavers:0},{month:'2024-01',hires:0,leavers:10000}]);
     const facts={counts:[Number(counts.analytics_turnover_leavers),Number(counts.analytics_turnover_start),Number(counts.analytics_turnover_end)],months};
     if(candidateFacts)expect(facts).toEqual(candidateFacts);else candidateFacts=facts;
    }
    const [after]=await tx.execute<{pid:number;jit:string}>(sql`select pg_backend_pid()as pid,current_setting('jit')as jit`);expect(after).toEqual({pid:identity.pid,jit:'off'});
    receipt.samePid=true;receipt.independentNativeFacts=true;receipt.complete=true;
   }finally{receipt.wallMs=performance.now()-started;save();}
  }
  for(const [ordinal,query]of [...old,...candidate].entries()){
   expect(/^select\b/i.test(query.text)).toBe(true);const receipt:Record<string,unknown>={ordinal:ordinal+1,source:ordinal<5?'old':'new',digest:query.digest,started:true,complete:false};
   (aggregateExperiment.plans as unknown[]).push(receipt);save();
   const rows=await tx.execute<Record<string,unknown>>(sql`explain(analyze,buffers,timing on,settings,format json) ${query.statement}`);
   Object.assign(receipt,aggregateNativePlan(rows[0]?.['QUERY PLAN']),{complete:true});save();
  }
  const [settled]=await tx.execute<{pid:number;role:string;login:string;isolation:string;readOnly:boolean;jit:string;rls:string}>(sql`select pg_backend_pid()as pid,current_user as role,session_user as login,current_setting('transaction_isolation')as isolation,current_setting('transaction_read_only')='on'as "readOnly",current_setting('jit')as jit,current_setting('row_security')as rls`);
  expect(settled).toEqual(identity);aggregateExperiment.sameNativeIdentityAtCompletion=true;aggregateExperiment.callbackComplete=true;save();return value;
 },options));
 try{
  await timed('employmentAggregateNativeExperimentMs',()=>analyticsDashboard(ctx,[b.companyId],{from:'2020-01-01',to:'2026-01-01',year:2020,filters:{},pages:{hires:page,terms:page,changeJobs:page,carryForward:page}}));
  expect(aggregateExperiment.callbackComplete).toBe(true);aggregateExperiment.transactionSettled=true;aggregateExperiment.complete=true;
 }
 finally{experimentSpy.mockRestore();aggregateExperiment.transactions=experimentTransactions;save();}
 expect(aggregateExperiment.complete).toBe(true);expect(aggregateExperiment.arms).toHaveLength(4);expect(aggregateExperiment.plans).toHaveLength(7);
 // Only after every original 50k timing, arm, plan and assertion has settled,
 // diagnose the actual envelope in two explicitly separate fixture populations.
 const envelopeExperiment:Record<string,unknown>={kind:'CHANGE_JOB_ENVELOPE_NATIVE_PLANS_ONLY',complete:false,
  includesSqlParametersResultsOrErrors:false,newPools:0,limits:{courses:2,plans:2,planNodesEach:256,unchangedCaseMs:300000},
  populationPhases:['original-50000-empty','same-50000-two-owned-histories'],courses:[],ownedFixtureRestored:false,
  limitations:'Warm separate diagnosis after original courses; not whole-dashboard speed or JIT ON/OFF evidence'};
 report.changeJobEnvelopeExperiment=envelopeExperiment;save();
 const envelopeCourse=async(kind:'empty'|'populated')=>{
  const receipt:Record<string,unknown>={population:kind==='empty'?'original-50000-empty':'same-50000-two-owned-histories',
   started:true,callbackComplete:false,transactionSettled:false,complete:false};
  (envelopeExperiment.courses as unknown[]).push(receipt);save();let transactions=0;
  const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(supplied:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>actualWithTenant(supplied,async tx=>{
   transactions++;expect(transactions).toBe(1);expect(options).toEqual({readOnlySnapshot:true});
   const current:CapturedSelect[]=[],value=await read(captureSelects(tx,current));
   const facts=value as Awaited<ReturnType<typeof analyticsDashboard>>;
   expect(facts.hc.total).toBe(40000);expect(facts.masterCount).toBe(40000);expect(Object.keys(facts)).toHaveLength(13);
   if(kind==='empty')expect(facts).toEqual(dashboard);
   else{
    expect(facts.changeJobs.state.total).toBe(2);expect(facts.changeJobs.rows).toEqual([1,2].map(n=>({
     name:'Fictional retained Personnel '+String(n).padStart(9,'0'),company:'Acme Sdn Bhd',fromDepartment:'Finance',toDepartment:'Operations',fromPosition:null,toPosition:null,effectiveOn:'2021-05-01',
    })));
   }
   const [identity]=await tx.execute<{pid:number;role:string;login:string;isolation:string;readOnly:boolean;jit:string;rls:string}>(sql`select pg_backend_pid()as pid,current_user as role,session_user as login,current_setting('transaction_isolation')as isolation,current_setting('transaction_read_only')='on'as "readOnly",current_setting('jit')as jit,current_setting('row_security')as rls`);
   expect(identity).toMatchObject({role:'ai_hr_app',login:'ai_hr_app',isolation:'repeatable read',readOnly:true,jit:'off',rls:'on'});receipt.identity=identity;
   const statements=current.filter(query=>/^\s*with analytics_changeJobTransactions_page as materialized \(/.test(query.text));expect(statements).toHaveLength(1);
   const query=statements[0];receipt.productEnvelopeStatements=statements.length;receipt.businessTotal=facts.changeJobs.state.total;
   receipt.businessRows=facts.changeJobs.rows.length;receipt.expectedTransportRows=kind==='empty'?1:2;
   const rows=await tx.execute<Record<string,unknown>>(query.statement);expect(rows).toHaveLength(kind==='empty'?1:2);
   expect(rows.every(row=>Number(row.total)===(kind==='empty'?0:2))).toBe(true);
   if(kind==='empty')expect(rows[0]).toMatchObject({assignmentId:null,name:null,company:null,fromDepartment:null,toDepartment:null,fromPosition:null,toPosition:null,effectiveOn:null});
   else expect(rows.every(row=>typeof row.assignmentId==='string'&&row.assignmentId.length===36)).toBe(true);
   receipt.actualTransportRows=rows.length;save();
   const planRows=await tx.execute<Record<string,unknown>>(sql`explain(analyze,buffers,timing on,settings,format json) ${query.statement}`);
   const raw=planRows[0]?.['QUERY PLAN'];let producers=0,consumers=0;
   const inspect=(node:Record<string,unknown>)=>{
    if(node['Subplan Name']==='CTE analytics_changejobtransactions_page')producers++;
    if(node['CTE Name']==='analytics_changejobtransactions_page')consumers++;
    for(const child of (node.Plans??[])as Record<string,unknown>[])inspect(child);
   };
   const sanitized=aggregateNativePlan(raw);inspect((raw as Record<string,unknown>[])[0].Plan as Record<string,unknown>);
   expect(producers).toBe(1);expect(consumers).toBe(2);
   receipt.plan={digest:query.digest,...sanitized,materializedProducerNodes:producers,consumerNodes:consumers,complete:true};
   const [after]=await tx.execute<typeof identity>(sql`select pg_backend_pid()as pid,current_user as role,session_user as login,current_setting('transaction_isolation')as isolation,current_setting('transaction_read_only')='on'as "readOnly",current_setting('jit')as jit,current_setting('row_security')as rls`);
   expect(after).toEqual(identity);receipt.sameNativeIdentityAtCompletion=true;receipt.callbackComplete=true;save();return value;
  },options));
  try{
   await timed('changeJobEnvelope'+(kind==='empty'?'Empty':'Populated')+'NativePlanMs',()=>analyticsDashboard(ctx,[b.companyId],{from:'2020-01-01',to:'2026-01-01',year:2020,filters:{},pages:{hires:page,terms:page,changeJobs:page,carryForward:page}}));
   expect(receipt.callbackComplete).toBe(true);receipt.transactionSettled=true;receipt.complete=true;
  }finally{spy.mockRestore();receipt.transactions=transactions;save();}
 };
 await envelopeCourse('empty');
 const subjects=await owner.client`select a.id,a.employment_id from assignment a where a.tenant_id=${b.tenantId}::uuid and a.employment_id in(${expectedFirst[0]}::uuid,${expectedFirst[1]}::uuid) and a.valid_from='2020-01-01' and a.valid_to is null and a.superseded_at is null order by a.employment_id`;
 expect(subjects).toHaveLength(2);let insertedIds:string[]=[];
 try{
  insertedIds=await owner.client.begin(async writer=>{
   const closed=await writer`update assignment set valid_to='2021-05-01' where tenant_id=${b.tenantId}::uuid and id in(${subjects[0].id}::uuid,${subjects[1].id}::uuid) and valid_to is null returning id`;
   expect(closed).toHaveLength(2);
   const inserted=await writer`insert into assignment(tenant_id,employment_id,company_id,department_id,employment_type,valid_from)
    values(${b.tenantId}::uuid,${expectedFirst[0]}::uuid,${b.companyId}::uuid,${b.deptB}::uuid,'full_time','2021-05-01'),
     (${b.tenantId}::uuid,${expectedFirst[1]}::uuid,${b.companyId}::uuid,${b.deptB}::uuid,'full_time','2021-05-01') returning id`;
   expect(inserted).toHaveLength(2);return inserted.map(row=>String(row.id));
  });
  const [population]=await owner.client`select count(*)::int as employees,(select count(*)::int from assignment where tenant_id=${b.tenantId}::uuid)as assignments from employment where tenant_id=${b.tenantId}::uuid`;
  expect(population).toEqual({employees:50000,assignments:50002});envelopeExperiment.populatedFixtureFacts=population;save();
  await envelopeCourse('populated');
 }finally{
  if(insertedIds.length){
   await owner.client.begin(async writer=>{
    const removed=await writer`delete from assignment where tenant_id=${b.tenantId}::uuid and id in(${insertedIds[0]}::uuid,${insertedIds[1]}::uuid) returning id`;expect(removed).toHaveLength(2);
    const reopened=await writer`update assignment set valid_to=null where tenant_id=${b.tenantId}::uuid and id in(${subjects[0].id}::uuid,${subjects[1].id}::uuid) and valid_to='2021-05-01' returning id`;expect(reopened).toHaveLength(2);
   });
  }
  const [restored]=await owner.client`select (select count(*)::int from employment where tenant_id=${b.tenantId}::uuid)as employees,(select count(*)::int from assignment where tenant_id=${b.tenantId}::uuid)as assignments,(select count(*)::int from assignment where tenant_id=${b.tenantId}::uuid and valid_to is not null)as closed`;
  expect(restored).toEqual({employees:50000,assignments:50000,closed:0});envelopeExperiment.restoredFixtureFacts=restored;envelopeExperiment.ownedFixtureRestored=true;save();
 }
 expect(envelopeExperiment.courses).toHaveLength(2);envelopeExperiment.complete=true;save();
 report.exactNativePopulationAndResults=true;report.complete=true;save();
},300000);
