/** Controlled development prototype. Full singleton registration/admission remains a separate gate. */
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,realpathSync,lstatSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {employeeChoiceBenchmarkLifetime,employeeChoiceBenchmarkBounds,adoptEmployeeChoiceBenchmarkResource} from './performance/employee-choice-benchmark-lifetime';
import {employeeChoiceNativeLogCollector} from './performance/employee-choice-native-log-collector';
import {employeeChoiceNativePlanPhases,employeeChoiceNativeLogRecords} from './performance/employee-choice-native-log-stream';
import {employeeChoiceBenchmarkEvidence} from './performance/employee-choice-benchmark-evidence';
import {cpus,totalmem} from 'node:os';
import {inArray,sql} from 'drizzle-orm';
import {PgDialect} from 'drizzle-orm/pg-core';
import {afterAll,beforeAll,expect,it,vi,type TestContext} from 'vitest';
import * as database from '../db/client';
import * as current from '../core/employee-choice';
import * as baseline from './performance/employee-choice-native-current-baseline';
import * as prototype from './performance/employee-choice-native-purpose-reader';
import {assignment,businessUnit} from '../db/schema';
import {assertAiPresentationPrincipalTx} from '../core/ai-principal';
import {installEmployeeChoiceNativePrototype} from './performance/employee-choice-native-purpose-owner';
import {employeeChoicePurposeSession,preserveDiagnosticFailure} from './performance/employee-choice-native-purpose-session';
import {employeeChoicePlanLogging} from './performance/employee-choice-auto-explain';
import {employeeChoiceNativeBody,employeeChoiceSqlFingerprint,employeeChoiceNativeInvocations,type PlanMarker,type NativeCallExpectation} from './performance/employee-choice-auto-explain-parser';
import {employeeChoiceActualCardinalities,employeeChoiceAuthorizedPopulationFacts,employeeChoicePlanWork} from './performance/employee-choice-plan-work';
import {employeeChoicePlannerSnapshot} from './performance/employee-choice-planner-snapshot';
import {createAssignmentAuthorityFixture,assertAssignmentAuthority} from './performance/employee-choice-assignment-authority';
import {seedPersonnelNativeFixture} from './performance/personnel-native-fixture';
import {closeAll,migrateTestDb,owner} from './harness';
import {capturePostgresEvidence,postgresProfileFromEnv,validatePostgresEvidence} from '../.github/ci/postgres-evidence.mjs';

const file='test/employee-choice-native-purpose-plan.test.ts';
const selection:unknown=JSON.parse(process.env.AIHR_FOCUSED_TESTS??'[]');
// This temporary focused experimental route is not a normal-CI profile witness.
// Accepted integration must register the complete file and call admitSingletonTest.
const requested=process.env.GITHUB_ACTIONS==='true'&&Array.isArray(selection)&&selection.length===1&&selection[0]===file;
beforeAll(async()=>{initializeEvidence();lifetime.start();await lifetime.run('migration',migrateTestDb);});
type Variant='current'|'native';const variants:readonly Variant[]=['current','native'];
type Page=Awaited<ReturnType<typeof current.readEmployeeChoices>>;
type Input=Parameters<typeof current.readEmployeeChoices>[1];
const stable=({contextId:_contextId,...page}:Page)=>page;
let blocked:Error|undefined,failedCase=false;
let evidenceWriter:ReturnType<typeof employeeChoiceBenchmarkEvidence>|undefined;
let capturePlans:((phase:string)=>Promise<void>)|undefined;
let planLog:ReturnType<typeof employeeChoiceNativeLogCollector>|undefined;
let installation:Awaited<ReturnType<typeof installEmployeeChoiceNativePrototype>>|undefined;
let timing:Awaited<ReturnType<typeof employeeChoicePurposeSession>>|undefined,plansSession:Awaited<ReturnType<typeof employeeChoicePurposeSession>>|undefined;
let logging:Awaited<ReturnType<typeof employeeChoicePlanLogging>>|undefined;
let fixture:Awaited<ReturnType<typeof seedPersonnelNativeFixture>>|undefined,representedBu='',emptyBu='',output='';
let completeFixtureIds:string[]=[];
let cardinalities:Awaited<ReturnType<typeof employeeChoiceActualCardinalities>>;
const report:Record<string,unknown>={kind:'NATIVE_EMPLOYEE_CHOICE_PAGE_ASSIGNMENT_HYDRATION_V5',releaseEligible:false,productionPolicyApproved:false,migrationAllocated:false,
 complete:false,employees:50000,variants,wholePortsPerVariant:18,caseBudgetMs:300000,statementTimeoutMs:20000,lockTimeoutMs:300,targetMs:1000,
 fileBudget:employeeChoiceBenchmarkBounds,retainedCancelledRun:{run:42414058820,source:'3e9ebeafc0cd41326790c3435b009090db9b0dac',conclusion:'cancelled',annotation:'The job has exceeded the maximum execution time of 20m0s',executionLogsAvailable:false,artifactsAvailable:false,benchmarkOrCleanupAcceptance:false},
 control:{commit:'f1515376df082438ca025fb65d01a8a3330a8796',sourceSha256:'ce1e3559addbffa4b4e780594ebcc5fcf917ddffde79a6155cc7fbcecdbcfbd5'},
 topology:'Timing variants share one actual app backend; plan-only variants share a second actual app backend. PIDs are distinct and never relabeled.',
 registration:'TEMPORARY_SOLE_FOCUSED_DEVELOPMENT_ONLY; complete normal-CI singleton admission remains pending',
 supplementalPlanPortsPerVariant:2,expectedActualPlanPhases:44,expectedActualNativeCallPairs:27,
 retainedSignalStatusProof:{source:'4c7a5fef03e185b1d0024e0dc994272c0c12bf88',run:42424586841,actualPlanPhases:42,actualNativeCallPairs:25,correctnessAndCleanupPassed:true,allUnderTarget:false,broadSearchMs:1001.312,deepBroadSearchMs:1077.001},
 assignmentProjectionProof:'No organization filter: preserve identity matching/count/order, then hydrate Assignment only for independently selected native page keys; actual1/25/2000 current Assignment probes and zero full-source work required.',
 retainedOriginalProof:{source:'9f51857dbc439f21a9ed6f4a0fc4b6aec4c5500c',run:42405537839,actualPlanPhases:34,allUnderTarget:false},
 retainedMinimalSearchProof:{source:'124274a3fa96769d7b593a26be160a9fcc8aafed',run:42409116168,actualPlanPhases:38,actualNativeCallPairs:23,allUnderTarget:false,
  broadSearchMs:7543.329861999955,deepBroadSearchMs:7972.917247000034,deepMs:1126.5117709999904,
  nativeLogSha256:'2dd23c7623840eb9a832368b1e29ea2f5d97e235d680e73305de6d078c16cff3'},
 retainedProjectionSetProof:{source:'6e563cb1228b4d88769dbb06dff804d1e5910bfa',ordinaryRun:42411156822,planRun:42411157207,actualPlanPhases:38,actualNativeCallPairs:23,allUnderTarget:false,
  broadSearchMs:995.9308960000053,deepBroadSearchMs:1214.2186469999724,deepMs:903.4817730000068,nativeLogSha256:'6dd1e6b2034fcca1a31cee9c302b4427024c1c34b3a03adbc9d909bfa056f10c'},
 paginationProof:'Same counted authorized population; nearer-end native tuple pagination; actual unused branch source/sort/limit loops0 and active top-N memory sort required for first/deep/broad/full-server-All2000 controls.',
 serverPopulationProof:'All50000 independently enumerated fixture IDs supplied in reverse order, unclipped, then exact All2000 last page plus complete50000 IDs; native materialized unnest/hash membership bound per call.',
 projectionExpressionCostProof:'Every actual project must materialize its complete independently expected1/50000-ID set once and use its exact hashed subplan in the employment filter; linear parameter ScalarArray membership refuses independently of row-work counts.',
 nativeCallAccounting:'Each minimal-candidate and bounded-projection body/invocation/row count is bound separately; every native statement is inspected and distinct main-body work/buffers are additionally combined per phase.',
 instrumentation:'Normal timings have no auto_explain. Plan-only auto_explain has analyze/buffers/settings/nested enabled and per-node timing/parameter values disabled. Instrumented duration is never a latency claim.',
 limitations:'Fixed current-root-first ordering, warm fixture/statistics and few samples are not p95/capacity or whole-browser proof. No index, RLS, grant, JIT threshold, work_mem or global setting changes. Only the fixed native function scopes jit=off.',
 host:{node:process.version,logicalCpus:cpus().length,ramBytes:totalmem(),cpuModels:[...new Set(cpus().map(cpu=>cpu.model))]}};
const save=()=>{if(output){const payload=JSON.stringify(report,null,2)+'\n';if(Buffer.byteLength(payload)>64*1024*1024)throw Error('Native report exceeds existing64MiB member bound');writeFileSync(join(output,'employee-choice-native-purpose-plan.json'),payload,{mode:0o600});}};
const progress=(event:Record<string,unknown>):void=>{evidenceWriter?.append({...event,elapsedMs:lifetime.snapshot().elapsedMs,timingPid:timing?.defaults.pid??null,planPid:plansSession?.defaults.pid??null});};
const lifetime=employeeChoiceBenchmarkLifetime(async()=>{
 const outcomes=await Promise.allSettled([timing?.close(),plansSession?.close(),planLog?.close()]);
 const failures=outcomes.filter(row=>row.status==='rejected');if(failures.length)throw new AggregateError(failures,'Owned application sessions did not close');
},event=>{report.lifetimeEvent=event;progress(event);save();});
const signal=lifetime.signal;
const active=()=>{if(blocked)throw blocked;lifetime.active();signal.throwIfAborted();};
const poison=(error:Error)=>{blocked=error;lifetime.stop('owner-uncertain');};
function initializeEvidence(){
 const base=resolve(process.env.AIHR_FOCUSED_EVIDENCE_DIR!);expect(realpathSync(base)).toBe(base);expect(lstatSync(base).uid).toBe(process.getuid!());
 output=join(base,'employee-choice-native-purpose');mkdirSync(output,{mode:0o700});
 evidenceWriter=employeeChoiceBenchmarkEvidence(output,{source:process.env.AIHR_CI_HEAD!,controller:process.env.AIHR_CI_CONTROL_HEAD!,run:process.env.GITHUB_RUN_ID!,attempt:process.env.GITHUB_RUN_ATTEMPT!});save();
}
async function bounded(context:TestContext,name:string,work:()=>Promise<void>,setup=false){
 const abort=()=>{blocked=new Error('Native purpose case aborted; all later work refused',{cause:context.signal.reason});lifetime.stop('case-aborted');};
 context.signal.addEventListener('abort',abort,{once:true});if(context.signal.aborted)abort();
 context.onTestFinished(async()=>{
  try{await lifetime.drain();}finally{context.signal.removeEventListener('abort',abort);if(signal.aborted)await finishOwned();}
 });
 try{await lifetime.run(name,work);}
 catch(error){failedCase=true;if(setup){blocked=error instanceof Error?error:new Error('Native purpose preparation failed');lifetime.stop('setup-failed');}throw error;}
}

function evidence(){
 active();const profile=postgresProfileFromEnv(process.env);
 // The genuine temporary focused provisioner owns db-1; normal registered units
 // must supply their actual hashed unit identity during accepted integration.
 const unit=process.env.AIHR_CI_UNIT??'db-1',value=capturePostgresEvidence(unit,profile);validatePostgresEvidence(value,{postgres:profile});return value;
}
function resources(){const value=evidence(),text=execFileSync('docker',['exec',value.name,'cat','/sys/fs/cgroup/cpu.stat'],{encoding:'utf8',timeout:10000,maxBuffer:65536});
 return {database:value,cpu:Object.fromEntries(text.trim().split('\n').map(line=>{const [key,count]=line.split(/\s+/);return[key,Number(count)];})),scope:'Owned-container counters outside timed port calls; cumulative peak, not per-request memory'};}
const pageReader=(variant:Variant)=>variant==='current'?baseline.readEmployeeChoices:prototype.readEmployeeChoices;
const idsReader=(variant:Variant)=>variant==='current'?baseline.readEmployeeChoiceIdsTx:prototype.readEmployeeChoiceIdsTx;
const pages=new Map<string,Omit<Page,'contextId'>>();
type Case={name:string;input:Input;total:number;ids:string[];repeat:number;selected:string|null};
function cases():Case[]{
 const {b,expectedFirst,expectedLast,organisationTagSample}=fixture!,last=expectedLast.at(-1)!,scope={companyIds:[b.companyId],selectedId:last};
 const activeIds=organisationTagSample.filter((_,index)=>(index+1)%5!==0);
 return [
  {name:'initial',input:scope,total:50000,ids:expectedFirst,repeat:2,selected:last},
  {name:'deep',input:{...scope,offset:49975},total:50000,ids:expectedLast,repeat:1,selected:last},
  {name:'search',input:{...scope,query:'PERF000050000'},total:1,ids:[last],repeat:1,selected:last},
  {name:'department-active',input:{...scope,departmentId:b.deptA,status:'active'},total:40000,ids:activeIds.slice(0,25),repeat:2,selected:last},
  {name:'department-and-unit',input:{...scope,departmentId:b.deptA,businessUnitId:representedBu,status:'active'},total:400,ids:activeIds.slice(0,25),repeat:1,selected:last},
  {name:'unit-active',input:{...scope,businessUnitId:representedBu,status:'active'},total:400,ids:activeIds.slice(0,25),repeat:1,selected:last},
  {name:'organisation-deep',input:{...scope,departmentId:b.deptA,businessUnitId:representedBu,status:'active',offset:375},total:400,ids:activeIds.slice(375),repeat:1,selected:last},
  {name:'organisation-search',input:{...scope,departmentId:b.deptA,businessUnitId:representedBu,query:'PERF000000001'},total:1,ids:[organisationTagSample[0]],repeat:1,selected:last},
  {name:'empty-unit',input:{...scope,departmentId:b.deptA,businessUnitId:emptyBu},total:0,ids:[],repeat:1,selected:last},
  {name:'missing-search',input:{...scope,query:'no fictional organisation employee matches'},total:0,ids:[],repeat:1,selected:last},
  {name:'broad-search',input:{...scope,query:'fictional retained'},total:50000,ids:expectedFirst,repeat:1,selected:last},
  {name:'deep-broad-search',input:{...scope,query:'fictional retained',offset:49975},total:50000,ids:expectedLast,repeat:1,selected:last},
  {name:'foreign-company',input:{companyIds:[fixture!.foreign.companyId],selectedId:last},total:0,ids:[],repeat:1,selected:null},
 ];
}

// Independent retained-fixture expectations: every retained name is non-ASCII,
// so exact JS search must inspect every conservatively admitted matching identity.
const expectedNativeRows=(name:string)=>{
 const candidates:Record<string,number>={initial:25,deep:25,search:50000,'department-active':25,'department-and-unit':25,
  'unit-active':25,'organisation-deep':25,'organisation-search':500,'empty-unit':0,'missing-search':50000,'broad-search':50000,'deep-broad-search':50000};
 if(name==='foreign-company')return 1; // Count only; no authorized population/selection/catalogue.
 if(name==='complete-ids')return 400;
 if(name==='full-server-population')return 2005;
 if(name==='full-server-search-population')return 50005;
 if(name==='full-server-ids')return 50000;
 if(name==='sparse-server-population')return 7; // Three identities + count/company/department/unit; no selected row.
 if(name==='held-access'||name==='held-history')return 30;
 if(!Object.hasOwn(candidates,name))throw Error('Missing independent native stream fixture');
 return 5+candidates[name]; // Count + company + department + unit + independently selected identity.
};
const expectedNativeCalls=(name:string):NativeCallExpectation[]=>{
 const first:NativeCallExpectation={port:name==='complete-ids'||name==='full-server-ids'?'ids':'page',rows:expectedNativeRows(name)};
 if(name==='initial'||name==='deep')first.pagination={total:50000,offset:name==='deep'?49975:0,limit:25};
 if(name==='full-server-population')return[{...first,serverScopeIds:50000,pagination:{total:50000,offset:48000,limit:2000}}];
 if(name==='full-server-search-population')return[{...first,serverScopeIds:50000},{port:'project',rows:2001,matchedIds:50000,serverScopeIds:50000,assignmentPageRows:2000,pagination:{total:50000,offset:48000,limit:2000}}];
 if(name==='full-server-ids')return[{...first,serverScopeIds:50000}];
 if(name==='search')return[first,{port:'project',rows:2,matchedIds:1,assignmentPageRows:1}];
 if(name==='organisation-search')return[first,{port:'project',rows:2,matchedIds:1}];
 if(name==='broad-search'||name==='deep-broad-search')return[first,{port:'project',rows:26,matchedIds:50000,assignmentPageRows:25,pagination:{total:50000,offset:name==='deep-broad-search'?49975:0,limit:25}}];
 return[first];
};

function assertPage(page:Page,c:Case){
 expect(page.total).toBe(c.total);expect(page.rows.map(row=>row.employmentId)).toEqual(c.ids);expect(page.rows.length).toBeLessThanOrEqual(25);expect(page.selected?.employmentId??null).toBe(c.selected);
 expect(page.companyOptions.map(row=>row.id)).toEqual(c.name==='foreign-company'?[]:[fixture!.b.companyId]);
 expect(page.departmentOptions.map(row=>row.id)).toEqual(c.name==='foreign-company'?[]:[fixture!.b.deptA]);expect(page.allDepartmentOptions.map(row=>row.id)).toEqual(c.name==='foreign-company'?[]:[fixture!.b.deptA]);
 expect(page.businessUnitOptions).toEqual(c.name==='foreign-company'?[]:[{id:representedBu,name:'Fictional organisation subset'}]);
}
const dialect=new PgDialect();
function marker(label:string,edge:'begin'|'end'){
 const name='aihr_ecp_'+createHash('sha256').update(label).digest('hex').slice(0,24)+'_'+edge;
 return sql`select 1 as ${sql.identifier(name)}`;
}
async function matrix(variant:Variant,session:Awaited<ReturnType<typeof employeeChoicePurposeSession>>,phase:'timing'|'plans',markers:PlanMarker[]=[]){
 const {b,ctx,organisationTagSample}=fixture!,read=pageReader(variant),ports=(report.ports??={})as Record<string,{samples?:number[];ms?:number}>;
 const markerCall=async(label:string,edge:'begin'|'end')=>{session.assertIdle();await session.single.db.execute(marker(label,edge));};
 const call=async<T>(name:string,sample:number,read:()=>Promise<T>):Promise<T>=>{
  active();const label=variant+':'+name+':'+sample;report.phase=phase+':'+label;progress({kind:'port-started',phase,label});save();
  try{
   if(phase==='plans'){markers.push({label,begin:dialect.sqlToQuery(marker(label,'begin')).sql,end:dialect.sqlToQuery(marker(label,'end')).sql,native:variant==='native',expectedNativeCalls:variant==='native'?expectedNativeCalls(name):undefined});await markerCall(label,'begin');if(!planLog)throw Error('Native follower unavailable');await planLog.wait(dialect.sqlToQuery(marker(label,'begin')).sql);}
   const value=await read();if(phase==='plans'){await markerCall(label,'end');if(!capturePlans)throw Error('Actual native capture owner unavailable');await capturePlans(label);}
   progress({kind:'port-returned',phase,label,oracleAcceptance:false});save();return value;
  }catch(error){progress({kind:'port-failed',phase,label});save();
   if(phase==='plans')try{await capturePlans?.('partial:'+label);}catch{progress({kind:'partial-capture-incomplete',phase,label});}
   throw error;
  }
 };
 for(const c of cases()){
  active();report.phase=phase+':'+variant+':'+c.name;progress({kind:'port-prerequisites',phase:report.phase});save();
  const facts=await database.withTenant(ctx,async tx=>{await assertAiPresentationPrincipalTx(tx,ctx);return employeeChoiceAuthorizedPopulationFacts(tx,ctx.tenantId,c.input.companyIds);},{readOnlySnapshot:true});
  const populations=(report.authorizedServerPopulationFacts??={})as Record<string,unknown>;populations[phase+':'+variant+':'+c.name]=facts;
  const before=phase==='timing'?resources():undefined,samples:number[]=[];
  for(let repeat=0;repeat<c.repeat;repeat++){
   let elapsed=0;const page=await call(c.name,repeat,async()=>{const start=performance.now(),page=await read(ctx,c.input,signal);elapsed=performance.now()-start;return page;});
   assertPage(page,c);samples.push(elapsed);
   if(phase==='timing'&&variant==='current')pages.set(c.name,stable(page));else expect(stable(page)).toEqual(pages.get(c.name));
  }
  if(phase==='timing'){ports[variant+':'+c.name]={samples};const telemetry=(report.resourcePhases??=[])as unknown[];telemetry.push({variant,case:c.name,before,after:resources()});save();}
 }
 const expected=organisationTagSample.filter((_,index)=>(index+1)%5!==0);
 let elapsed=0;
 const ids=await call('complete-ids',0,async()=>{const start=performance.now(),value=await database.withTenant(ctx,tx=>idsReader(variant)(tx,ctx,{companyIds:[b.companyId],departmentId:b.deptA,businessUnitId:representedBu,status:'active'},signal),{readOnlySnapshot:true});elapsed=performance.now()-start;return value;});
 expect(ids).toEqual(expected);if(phase==='timing')ports[variant+':complete-ids']={ms:elapsed};
 for(const barrier of ['access','history']as const){
  let release!:()=>void,entered!:()=>void,writerPid=0;const ready=new Promise<void>(resolve=>{entered=resolve;}),done=new Promise<void>(resolve=>{release=resolve;});
  const writer=owner.client.begin(async tx=>{if(barrier==='access')await tx`select pg_advisory_xact_lock(hashtextextended(${'access-configuration:'+b.tenantId},0))`;else await tx`select pg_advisory_xact_lock(hashtext(${'audit-chain:'+b.tenantId}))`;
   const [row]=await tx`select pg_backend_pid() as pid`;writerPid=row.pid;entered();await done;});
  const abort=()=>release();signal?.addEventListener('abort',abort,{once:true});
  try{
   await Promise.race([ready,writer.then(()=>{throw Error('Controlled writer ended before admission');})]);active();
   const page=await call('held-'+barrier,0,async()=>{const start=performance.now(),page=await read(ctx,{companyIds:[b.companyId],selectedId:fixture!.expectedLast.at(-1),departmentId:b.deptA,businessUnitId:representedBu,status:'active'},signal);elapsed=performance.now()-start;return page;});
   expect(stable(page)).toEqual(pages.get('department-and-unit'));
   expect((await owner.client`select exists(select 1 from pg_locks where pid=${writerPid} and granted and locktype='advisory') as held`)[0].held).toBe(true);
   if(phase==='timing')ports[variant+':held-'+barrier]={ms:elapsed};
  }finally{release();signal?.removeEventListener('abort',abort);await writer;}
 }
 // A legitimate large SERVER population is not a browser filter. Keep all IDs
 // and deliberately scramble order; its scope gate must not become50000x50000
 // scalar comparisons. Expected identity order comes from independent seed codes.
 const fullInput={companyIds:[b.companyId],employmentIds:completeFixtureIds.slice().reverse(),selectedId:fixture!.expectedLast.at(-1),offset:48000,limit:2000};
 const fullBefore=phase==='timing'?resources():undefined;
 const full=await call('full-server-population',0,async()=>{const start=performance.now(),page=await database.withTenant(ctx,tx=>variant==='current'
  ?baseline.readEmployeeChoicesTx(tx,ctx,fullInput,signal):prototype.readEmployeeChoicesTx(tx,ctx,fullInput,signal),{readOnlySnapshot:true});elapsed=performance.now()-start;return page;});
 expect(full.total).toBe(50000);expect(full.rows.map(row=>row.employmentId)).toEqual(completeFixtureIds.slice(48000));expect(full.selected?.employmentId).toBe(completeFixtureIds.at(-1));
 expect(full.companyOptions.map(row=>row.id)).toEqual([b.companyId]);expect(full.departmentOptions.map(row=>row.id)).toEqual([b.deptA]);expect(full.businessUnitOptions.map(row=>row.id)).toEqual([representedBu]);
 if(phase==='timing'){
  ports[variant+':full-server-population']={ms:elapsed};const telemetry=(report.resourcePhases??=[])as unknown[];telemetry.push({variant,case:'full-server-population',before:fullBefore,after:resources()});
  if(variant==='current')pages.set('full-server-population',stable(full));else expect(stable(full)).toEqual(pages.get('full-server-population'));
 }else{
  expect(stable(full)).toEqual(pages.get('full-server-population'));
  const ids=await call('full-server-ids',0,()=>database.withTenant(ctx,tx=>idsReader(variant)(tx,ctx,{companyIds:[b.companyId],employmentIds:fullInput.employmentIds},signal),{readOnlySnapshot:true}));
  expect(ids).toEqual(completeFixtureIds);expect(new Set(ids).size).toBe(50000);
 }
 // Cover the new projection path at the actual All2000 limit as well as25.
 // Both implementations receive the same complete authorized server population;
 // seed IDs, count, metadata and stable output are independently checked.
 const fullSearchInput={...fullInput,query:'fictional retained'};
 const fullSearchBefore=phase==='timing'?resources():undefined;
 const fullSearch=await call('full-server-search-population',0,async()=>{const start=performance.now(),page=await database.withTenant(ctx,tx=>variant==='current'
  ?baseline.readEmployeeChoicesTx(tx,ctx,fullSearchInput,signal):prototype.readEmployeeChoicesTx(tx,ctx,fullSearchInput,signal),{readOnlySnapshot:true});elapsed=performance.now()-start;return page;});
 expect(fullSearch.total).toBe(50000);expect(fullSearch.rows.map(row=>row.employmentId)).toEqual(completeFixtureIds.slice(48000));
 expect(fullSearch.selected?.employmentId).toBe(completeFixtureIds.at(-1));expect(stable(fullSearch)).toEqual(stable(full));
 if(phase==='timing'){
  ports[variant+':full-server-search-population']={ms:elapsed};const telemetry=(report.resourcePhases??=[])as unknown[];telemetry.push({variant,case:'full-server-search-population',before:fullSearchBefore,after:resources()});
  if(variant==='current')pages.set('full-server-search-population',stable(fullSearch));else expect(stable(fullSearch)).toEqual(pages.get('full-server-search-population'));
 }else expect(stable(fullSearch)).toEqual(pages.get('full-server-search-population'));
 if(phase==='plans'){
  const employmentIds=organisationTagSample.slice(0,3),input={companyIds:[b.companyId],employmentIds,selectedId:fixture!.expectedLast.at(-1)};
  const sparse=await call('sparse-server-population',0,()=>database.withTenant(ctx,tx=>variant==='current'
   ?baseline.readEmployeeChoicesTx(tx,ctx,input,signal):prototype.readEmployeeChoicesTx(tx,ctx,input,signal),{readOnlySnapshot:true}));
  expect(sparse.total).toBe(3);expect(sparse.rows.map(row=>row.employmentId)).toEqual(employmentIds);expect(sparse.selected).toBeNull();
  expect(sparse.companyOptions.map(row=>row.id)).toEqual([b.companyId]);expect(sparse.departmentOptions.map(row=>row.id)).toEqual([b.deptA]);
  expect(sparse.businessUnitOptions.map(row=>row.id)).toEqual([representedBu]);
  if(variant==='current')pages.set('sparse-server-population',stable(sparse));else expect(stable(sparse)).toEqual(pages.get('sparse-server-population'));
 }
 save();
}

it.skipIf(!requested)('prepares exactly50k fictional current-root facts and a guarded unnumbered function',{timeout:300000},context=>bounded(context,'prepare',async()=>{
 expect(process.env.RUNNER_ENVIRONMENT).toBe('github-hosted');active();
 installation=await installEmployeeChoiceNativePrototype();active();report.function={signature:installation.installed.definition,sourceSha256:installation.sourceSha256,security:installation.security};
 fixture=await seedPersonnelNativeFixture(50000,report,phase=>{active();report.phase=phase;progress({kind:'fixture-progress',phase});save();},save,'Fictional retained Personnel 人員 ');
 active();representedBu=randomUUID();emptyBu=randomUUID();await owner.db.insert(businessUnit).values([
  {id:representedBu,tenantId:fixture.b.tenantId,companyId:fixture.b.companyId,code:'ORG-SUBSET',name:'Fictional organisation subset'},
  {id:emptyBu,tenantId:fixture.b.tenantId,companyId:fixture.b.companyId,code:'ORG-EMPTY',name:'Fictional unrepresented unit'}]);
 await owner.db.update(assignment).set({businessUnitId:representedBu}).where(inArray(assignment.employmentId,fixture.organisationTagSample));await owner.client`analyze assignment`;await owner.client`analyze business_unit`;
 const independent=await owner.client<{id:string;code:string}[]>`select id,employee_code as code from employment where tenant_id=${fixture.b.tenantId}::uuid order by employee_code`;
 expect(independent).toHaveLength(50000);independent.forEach((row,index)=>expect(row.code).toBe('PERF'+String(index+1).padStart(9,'0')));
 completeFixtureIds=independent.map(row=>row.id);expect(new Set(completeFixtureIds).size).toBe(50000);
 expect(completeFixtureIds.slice(0,25)).toEqual(fixture.expectedFirst);expect(completeFixtureIds.slice(-25)).toEqual(fixture.expectedLast);
 report.completeServerScope={identities:completeFixtureIds.length,source:'Independent exact seed employee_code1..50000',inputOrder:'reverse',clipped:false};
 cardinalities=await employeeChoiceActualCardinalities(owner.db);report.exactWholeFixtureCardinalities=cardinalities;report.initialResources=resources();
 const identities=(report.identities??=[])as unknown[];timing=await adoptEmployeeChoiceBenchmarkResource(()=>employeeChoicePurposeSession('timing',active,value=>identities.push(value),poison),signal,value=>{timing=value;});active();
 const [instrumentation]=await timing.single.client`select current_setting('auto_explain.log_min_duration',true) as duration`;
 expect(instrumentation.duration===null||instrumentation.duration===''||instrumentation.duration==='-1').toBe(true);
 report.timingBackend=timing.defaults;report.preparationComplete=true;await installation.unchanged();save();
},true));

it.skipIf(!requested).for(variants)('measures all18 actual whole ports with %s implementation',{timeout:300000},(variant,context)=>bounded(context,'timing:'+variant,async()=>{
 expect(timing).toBeTruthy();const spy=timing!.install();
 await preserveDiagnosticFailure(async()=>{const stats=(report.plannerStatistics??={})as Record<string,unknown>;stats['timing:'+variant]=await employeeChoicePlannerSnapshot();
  await matrix(variant,timing!,'timing');const complete=(report.performanceVariants??=[])as string[];complete.push(variant);save();
 },async()=>{spy.mockRestore();await timing!.verify('variant-complete');await installation!.unchanged();});
}));

it.skipIf(!requested)('captures real nested native plans on a separate bound app PID with exact owned-DB config restoration',{timeout:300000},context=>bounded(context,'plans',async()=>{
 let restoreSpy=()=>{},verifyLatestPlans:(()=>void)|undefined;
 await preserveDiagnosticFailure(async()=>{
 logging=await employeeChoicePlanLogging(installation!.database);report.instrumentationConfig={beforeSha256:logging.beforeSha256,instrumentedSha256:logging.instrumentedSha256,settings:logging.settings};
 const identities=(report.identities??=[])as unknown[];plansSession=await adoptEmployeeChoiceBenchmarkResource(()=>employeeChoicePurposeSession('plans',active,value=>identities.push(value),poison),signal,value=>{plansSession=value;});active();expect(plansSession.defaults.pid).not.toBe(timing!.defaults.pid);
 report.planBackend=plansSession.defaults;
 // session_preload_libraries is privileged inspection even for a genuine app
 // LOGIN. The owner verified its exact database setting before this NEW backend
 // opened; registered module settings below and actual PID-bound nested plans
 // prove the module loaded. Never grant pg_read_all_settings to inspect it.
 const [configuration]=await plansSession.single.client`select current_setting('auto_explain.log_min_duration') as duration,current_setting('auto_explain.log_parameter_max_length') as parameters,current_setting('auto_explain.log_nested_statements') as nested,
  current_setting('auto_explain.log_analyze') as analyze,current_setting('auto_explain.log_buffers') as buffers,current_setting('auto_explain.log_settings') as settings,current_setting('auto_explain.log_format') as format,current_setting('auto_explain.log_timing') as timing`;
 expect(configuration).toEqual({duration:'0',parameters:'0',nested:'on',analyze:'on',buffers:'on',settings:'on',format:'json',timing:'off'});
 report.planBackendSettings=configuration;report.preloadLibraryProof='Exact owner-verified database settings before new app backend plus actual same-PID nested plans; no application privilege added';save();
 const markers:PlanMarker[]=[],startedAt=new Date().toISOString(),spy=plansSession.install();restoreSpy=()=>spy.mockRestore();
 const container=evidence(),pid=plansSession.defaults.pid,source=readFileSync('test/fixtures/employee-choice-native-purpose.sql','utf8'),body=employeeChoiceNativeBody(source);
 const actualContainer=execFileSync('docker',['inspect','--format','{{.Id}} {{.Name}}',container.name],{encoding:'utf8',timeout:10000,maxBuffer:4096}).trim().split(' ');
 if(actualContainer.length!==2||!/^[a-f0-9]{64}$/.test(actualContainer[0])||actualContainer[1]!=='/'+container.name)throw Error('Exact owned native log container required');
 const containerId=actualContainer[0];
 planLog=employeeChoiceNativeLogCollector(output,{source:process.env.AIHR_CI_HEAD!,controller:process.env.AIHR_CI_CONTROL_HEAD!,run:process.env.GITHUB_RUN_ID!,attempt:process.env.GITHUB_RUN_ATTEMPT!,pid,container:container.name,containerId,startedAt},signal,poison);
 capturePlans=async phase=>{
  const boundary=markers.find(marker=>marker.label===phase);
  if(boundary)await planLog!.wait(boundary.end);
  const retained=planLog!.checkpoint(phase);report.nativeProgressIndex={...retained,fullMatrixVerified:false};save();
 };
  for(const variant of variants)await matrix(variant,plansSession!,'plans',markers);
  await capturePlans('matrix-complete');await plansSession.close();await planLog.close();
  verifyLatestPlans=()=>{
  if(!planLog)throw Error('No retained native follower owner');
  const retained=planLog.store.verifyIndex(),channel=planLog.nativeChannel(),other=channel==='stdout'?'stderr':'stdout';
  // Both raw channels are retained. Native PID records split between them have
  // no trustworthy total ordering and therefore cannot qualify.
  for(const record of employeeChoiceNativeLogRecords(planLog.store.read(other)))if(record.pid===pid)throw Error('Native PID records appeared on both raw channels');
  report.nativeLog={...retained,pid,container:container.name,containerId,startedAt,channel,format:'lossless-indexed-gzip-parts'};
  const actual:unknown[]=[],failures:unknown[]=[];let phases=0,callPairs=0;
  for(const {label,entries}of employeeChoiceNativePlanPhases(planLog.store.read(channel),pid,markers,body)){
   phases++;
   const bodies=entries.filter(entry=>employeeChoiceSqlFingerprint(entry.query)===employeeChoiceSqlFingerprint(body));
   if(label.startsWith('native:')){
    const expected=markers.find(marker=>marker.label===label)?.expectedNativeCalls;
    if(expected===undefined)throw Error('Independent actual native stream expectation required');
    try{const invocations=employeeChoiceNativeInvocations(entries,body,expected);callPairs+=invocations.length;actual.push({label,invocations});}
    catch(error){failures.push({label,kind:'actual-native-invocation',details:error instanceof Error?error.message:'Unknown native invocation failure'});}
   }
   if(label.startsWith('native:'))for(const entry of entries){
    const plan=entry.document.Plan;if(!plan||typeof plan!=='object'||Array.isArray(plan))throw Error('Native body plan required');
    const work=employeeChoicePlanWork(plan as Record<string,unknown>,cardinalities);actual.push({label,querySha256:createHash('sha256').update(entry.query).digest('hex'),durationMs:entry.durationMs,work,mainBody:bodies.includes(entry),rawDocument:'Exact original document retained in nativeLog indexed parts'});
    if(work.rejectionReasons.length)failures.push({label,kind:'work',details:work.rejectionReasons});
    if(bodies.includes(entry)){const settings=entry.document.Settings;if(!settings||typeof settings!=='object'||!('jit'in settings)||settings.jit!=='off'||entry.document.JIT!==undefined)failures.push({label,kind:'native-function-jit-scope'});}
   }
   if(label.startsWith('native:')){
    const disjoint=bodies.map(entry=>employeeChoicePlanWork(entry.document.Plan as Record<string,unknown>,cardinalities));
    const combinedRootSharedBlocks=disjoint.reduce((sum,work)=>sum+work.rootSharedBlocks,0),combinedMaxNodeWork=disjoint.reduce((sum,work)=>sum+work.maximumNodeWork,0);
    const limits=disjoint[0]?.limits;if(!limits)throw Error('Every native phase requires real body work');
    if(combinedRootSharedBlocks>limits.maxRootSharedBlocks||combinedMaxNodeWork>limits.maxNodeWork)failures.push({label,kind:'combined-native-calls-work'});
    actual.push({label,combinedDistinctBodies:{calls:bodies.length,combinedRootSharedBlocks,combinedMaxNodeWork,limits},overlapPolicy:'Only distinct native main bodies combined; nested and outer copies never summed.'});
   }
   actual.push({label,statements:entries.map(entry=>({querySha256:createHash('sha256').update(entry.query).digest('hex'),durationMs:entry.durationMs})),rawDocuments:'Every original statement and context retained losslessly in nativeLog indexed parts'});
  }
  report.markers=markers;report.actualPlans=actual;report.planVerificationFailures=failures;report.actualPlanCases=phases;report.actualNativeCallPairs=callPairs;save();
  expect(phases).toBe(44);expect(callPairs).toBe(27);expect(failures).toEqual([]);report.actualPlansComplete=true;save();
  };verifyLatestPlans();
 },async()=>{
  restoreSpy();const failures:unknown[]=[],previouslyComplete=report.actualPlansComplete===true;report.actualPlansComplete=false;save();
  try{await plansSession?.close();}catch(error){failures.push(error);}
  try{await planLog?.close();if(planLog)report.retainedFinalRaw=planLog.store.verifyIndex();if(previouslyComplete&&verifyLatestPlans)verifyLatestPlans();}catch(error){report.partialCaptureIncomplete=true;failures.push(error);}
  capturePlans=undefined;
  try{await logging?.restore();if(logging)report.instrumentationRestored=true;}catch(error){failures.push(error);}
  try{await installation!.unchanged();}catch(error){failures.push(error);}
  if(failures.length)report.actualPlansComplete=false;save();if(failures.length)throw new AggregateError(failures,'Native plan final capture or exact restoration failed');
 });
}));

let authorityFixture:Awaited<ReturnType<typeof createAssignmentAuthorityFixture>>|undefined,expectedAuthority:Awaited<ReturnType<typeof assertAssignmentAuthority>>|undefined;
it.skipIf(!requested).for(variants)('preserves actual current-root native authority/history with %s implementation',{timeout:300000},(variant,context)=>bounded(context,'authority:'+variant,async()=>{
 authorityFixture??=await createAssignmentAuthorityFixture();const spy=timing!.install(),port=vi.spyOn(current,'readEmployeeChoices').mockImplementation(pageReader(variant));
 await preserveDiagnosticFailure(async()=>{const value=await assertAssignmentAuthority(authorityFixture!);if(variant==='current')expectedAuthority=value;else expect(value).toEqual(expectedAuthority);
  const authority=(report.authority??={})as Record<string,unknown>;authority[variant]=value;report.authorityComplete=variants.every(name=>Object.hasOwn(authority,name));save();
 },async()=>{port.mockRestore();spy.mockRestore();await timing!.verify('authority-complete');await installation!.unchanged();});
}));

async function cleanupOwned(){
 const failures:unknown[]=[];const finish=async(name:string,work:()=>Promise<unknown>)=>{try{await work();}catch(error){failures.push(error);const errors=(report.cleanupFailures??=[])as string[];errors.push(name);}};
 await finish('plan-client',async()=>plansSession?.close());await finish('native-follower',async()=>planLog?.close());await finish('plan-config',async()=>logging?.restore());await finish('timing-client',async()=>timing?.close());
 await finish('prototype-function',async()=>installation?.remove());await finish('pools',closeAll);
 report.cleanupComplete=failures.length===0;
 report.failedCase=failedCase;report.sessionPoisoned=blocked!==undefined;
 report.complete=!failedCase&&!blocked&&report.preparationComplete===true&&report.actualPlansComplete===true&&report.instrumentationRestored===true&&report.authorityComplete===true&&report.cleanupComplete===true
  &&variants.every(variant=>(report.performanceVariants as string[]|undefined)?.includes(variant));
 report.wholePortTargets=Object.fromEntries(variants.map(variant=>{const ports=Object.entries((report.ports??{})as Record<string,{samples?:number[];ms?:number}>).filter(([key])=>key.startsWith(variant+':'));
  return [variant,{targetMs:1000,measuredPorts:ports.length,allUnderTarget:report.complete===true?ports.length===18&&ports.every(([,port])=>port.samples?.length?port.samples.every(ms=>ms<1000):typeof port.ms==='number'&&port.ms<1000):null}];}));
 report.phase=report.complete?'complete':'incomplete';save();if(failures.length)throw new AggregateError(failures,'Owned prototype cleanup failed');
}
async function finishOwned(){
 try{await lifetime.finish(cleanupOwned);}finally{
  report.lifetime=lifetime.snapshot();if(lifetime.snapshot().stopped||lifetime.snapshot().uncertain||lifetime.snapshot().elapsedMs>employeeChoiceBenchmarkBounds.totalMs)report.complete=false;
  if(report.complete!==true){report.phase='incomplete';const targets=report.wholePortTargets as Record<string,{allUnderTarget:boolean|null}>|undefined;if(targets)for(const row of Object.values(targets))row.allUnderTarget=null;}save();
 }
}
afterAll(finishOwned);
