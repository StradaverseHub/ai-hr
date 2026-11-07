/** Sole hosted attribution only. No installed profile, throughput PASS or JIT policy change. */
import {readFileSync,writeFileSync,mkdirSync,realpathSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {cpus,totalmem} from 'node:os';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {saveNotificationEmailPolicy,saveNotificationEmailPreferences} from '../core/notification-email';
import {notificationWorkerLifecycle} from '../lib/notification-worker/lifecycle';
import {notificationWorkerProjection,notificationWorkerAssessmentContract} from '../lib/notification-worker/projection';
import {adminCtx,createAppUser,owner,resetDb,seedBase,setModule,type Base} from './harness';
import {notificationWorkerFixtureOwner} from './fixtures/notification-worker/owner-fixture';
import {notificationPlanLogging} from './fixtures/notification-worker/plan-logging';
import {notificationAutoExplainMessages} from './fixtures/notification-worker/auto-explain';
import {reviewedAdmissionExpression,notificationAdmissionSummary,notificationHelperContractScans} from './fixtures/notification-worker/admission-plan-summary';
import {notificationDiagnosticOwnership} from './fixtures/notification-worker/diagnostic-ownership';
import {admitSingletonTest} from './helpers/ci-singleton-admission';
import {capturePostgresEvidence,postgresProfileFromEnv,validatePostgresEvidence} from '../.github/ci/postgres-evidence.mjs';
const filename='test/notification-worker-native-plan-diagnostic.test.ts';
const diagnosticAdmission=admitSingletonTest(filename);
if(process.env.CI!=='true')throw Error('Actual hosted CI notification diagnostic required');
describe.sequential('paired exact-freshness native query shapes',()=>{
const fixture=notificationWorkerFixtureOwner(),ownership=notificationDiagnosticOwnership();
const beforeGuardCounts=new Map<string,number>();
beforeAll(()=>fixture.setup(),300000);
afterAll(async()=>{await ownership.drain();await fixture.close();});
for(const queryShapeVariant of ['baseline','candidate']as const)describe.sequential('fresh native guard '+queryShapeVariant,()=>{
const names=queryShapeVariant==='baseline'?['lifecycle','projection','assessment','process','query-shape']:['lifecycle','projection','assessment','process','query-shape','exact-source'],sources=names.map(name=>readFileSync('test/fixtures/notification-worker/'+name+'.sql','utf8'));
const expectedAdmission=reviewedAdmissionExpression(readFileSync('test/fixtures/notification-worker/'+(queryShapeVariant==='baseline'?'query-shape':'exact-source')+'.sql','utf8'));
const admissionSummary=(entries:ReturnType<typeof notificationAutoExplainMessages>)=>notificationAdmissionSummary(entries,expectedAdmission);
const nativeSourceHashes=Object.fromEntries(names.map((name,index)=>[name,createHash('sha256').update(sources[index]).digest('hex')]));
let b:Base,employment:string,recipient:string,output='';
beforeAll(async()=>{
 ownership.beforeCase();await fixture.install(sources,3,notificationWorkerAssessmentContract);
 const temporary=realpathSync(process.env.RUNNER_TEMP!),directory=diagnosticAdmission.evidenceDirectory;
 expect(directory).toBe(join(temporary,diagnosticAdmission.mode==='full-ci-singleton'?'aihr-ci':'aihr-focused'));expect(realpathSync(directory)).toBe(directory);expect(lstatSync(directory).uid).toBe(process.getuid!());
 output=join(directory,'notification-native-plans-'+queryShapeVariant);mkdirSync(output,{mode:0o700});
},300000);
beforeEach(async()=>{
 ownership.beforeCase(); // BEFORE truncate/reset/fixture writes; aborted work cannot be overtaken.
 await owner.client`truncate notification_worker_private.run cascade`;await owner.client`update notification_worker_private.authority set active_run=NULL,enabled=true,max_run_batches=10`;
 await resetDb();b=await seedBase();await setModule(b.tenantId,'notifications','active');
 const email=randomUUID()+'@example.invalid',employee=await hireEmployee(adminCtx(b),{person:{fullName:'Fictional native plan employee',primaryEmail:email},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2024-01-01'});employment=employee.employmentId;
 recipient=await createAppUser(b.tenantId,employee.personId,'employee');const issuer='https://notification-plan.example.invalid/identity',subject=randomUUID();
 await owner.db.insert(schema.appExternalIdentity).values({issuer,subject,appUserId:recipient});await saveNotificationEmailPolicy(adminCtx(b),['leave']);
 await saveNotificationEmailPreferences({...adminCtx(b),userId:recipient,personId:employee.personId,roles:['employee']},employment,['leave'],'en',{issuer,subject,email,emailVerified:true});
 await owner.client`update public.notification_event_processing set disposition='legacy-cursor',processed_at=now()`;
});
afterEach(async()=>{await ownership.drain();try{await fixture.finishCase();}catch(error){ownership.poison(error instanceof Error?error:Error('Native fixture teardown refused'));throw error;}});
afterAll(async()=>{await ownership.drain();try{await fixture.assertProcessProfileIfInstalled();await fixture.clearStage();}catch(error){ownership.poison(error instanceof Error?error:Error('Native variant restoration refused'));throw error;}});
const fingerprint=(text:string)=>createHash('sha256').update(text.trim().replace(/;$/,'').replace(/\s+/g,' ')).digest('hex');
function statementSummary(entries:ReturnType<typeof notificationAutoExplainMessages>){
 const groups=new Map<string,{fingerprint:string;context:string[];calls:number;inclusiveTotalMs:number;maximumMs:number;jitDocuments:number;maximumJit:unknown}>();
 for(const entry of entries){const hash=fingerprint(entry.query),frames=entry.context.split('\n').filter(line=>line.includes('function ')).slice(0,5),key=hash+'|'+frames.join('|'),group=groups.get(key)??{fingerprint:hash,context:frames,calls:0,inclusiveTotalMs:0,maximumMs:0,jitDocuments:0,maximumJit:null};group.calls++;group.inclusiveTotalMs+=entry.durationMs;if(entry.durationMs>=group.maximumMs){group.maximumMs=entry.durationMs;group.maximumJit=entry.document.JIT??null;}if(entry.document.JIT!==undefined)group.jitDocuments++;groups.set(key,group);}
 expect(groups.size).toBeLessThanOrEqual(1024);return{statements:entries.length,groups:Array.from(groups.values()).sort((a,b)=>b.inclusiveTotalMs-a.inclusiveTotalMs)};
}
async function guard(){
 await owner.client`select notification_worker_private.assert_process_profile()`;
 return Array.from(await owner.client`select p.oid::regprocedure::text as signature,md5(p.prosrc)as body,to_jsonb(p)-'prosrc'as metadata from pg_proc p where p.pronamespace in('notification_worker'::regnamespace,'notification_worker_private'::regnamespace)order by p.oid`);
}
function container(){const profile=postgresProfileFromEnv(process.env),actual=capturePostgresEvidence(process.env.AIHR_CI_UNIT??'db-1',profile);validatePostgresEvidence(actual,{postgres:profile});return actual;}
describe.sequential('real native notification nested SQL attribution',()=>{
 it.for(['open','empty','twenty']as const)('captures %s without changing native guards, budgets or JIT',{timeout:30000},(mode,context)=>ownership.run(context,async()=>{
  const report:Record<string,unknown>={kind:'NATIVE_NOTIFICATION_SQL_ATTRIBUTION_NOT_RELEASE',releaseAuthorized:false,complete:false,mode,queryShapeVariant,nativeSourceHashes,comparison:'same frozen candidate; baseline native SQL and worker bytes unchanged from7a; not a relabeled historical run',source:process.env.AIHR_CI_HEAD,controller:process.env.AIHR_CI_CONTROL_HEAD,run:process.env.GITHUB_RUN_ID,attempt:process.env.GITHUB_RUN_ATTEMPT,database:fixture.binding.database,
   baseline:{source:'5869b4e6168263404ed054da0433fa2e94a36e94',run:'42407886480',passed:50,failed:1},caseBudgetMs:30000,statementTimeoutMs:20000,lockTimeoutMs:300,
   host:{logicalCpus:cpus().length,ramBytes:totalmem(),node:process.version},
   instrumentation:'Plan-only auto_explain; nested/analyze/buffers/settings, parameters and per-node timing off. Inclusive nested durations must not be summed across nesting. Not a throughput comparison.'};
  const path=join(output,mode+'.json'),save=()=>{const bytes=JSON.stringify(report,null,2)+'\n';if(Buffer.byteLength(bytes)>4*1024*1024){writeFileSync(path,JSON.stringify({kind:report.kind,source:report.source,run:report.run,mode,complete:false,truncated:true,reason:'report-byte-bound'})+'\n',{mode:0o600});throw Error('Bounded native diagnostic report exceeded');}writeFileSync(path,bytes,{mode:0o600});};save();
  if(mode==='twenty'){
   const events=await owner.db.insert(schema.domainEvent).values(Array.from({length:20},()=>({tenantId:b.tenantId,aggregateType:'fixture',aggregateId:randomUUID(),eventType:'leave-request.approved',actorType:'system'as const,subjectEmploymentId:employment,payload:{}}))).returning({id:schema.domainEvent.id});
   report.expectedEvents=events.map(row=>row.id);
  }
  const original=await guard();report.guardsBefore=original;
  report.helperContract=await owner.client`select count(*)::int as rows,sum(octet_length(p.prosrc))::text as canonical_bytes,max(octet_length(p.prosrc))::int as maximum_body_bytes from notification_worker_private.helper_contract c join pg_proc p on p.oid=c.signature`;
  if(queryShapeVariant==='candidate'){const [actual]=await owner.client`select count(*)::int as rows,count(*)filter(where(c.body_source collate "C")is distinct from(p.prosrc collate "C")or md5(c.body_source)<>c.body_md5)::int as drift,sum(octet_length(c.body_source))::text as source_bytes from notification_worker_private.helper_contract c left join pg_proc p on p.oid=c.signature`;expect(actual.rows).toBe(2300);expect(actual.drift).toBe(0);report.exactSourceContract=actual;}
  expect(original.find(row=>row.signature==='notification_worker_private.admit_login()')?.body,'actual sealed native admission body matches reviewed query owner').toBe(expectedAdmission.bodyMd5);report.containerBefore=container();save();
  const logging=await notificationPlanLogging(fixture.binding);
  let connection:ReturnType<typeof fixture.connect>;
  try{report.logging={settings:logging.settings,beforeSha256:logging.beforeSha256,instrumentedSha256:logging.instrumentedSha256};save();connection=fixture.connect();}catch(error){try{await logging.restore();}catch(restore){ownership.poison(restore instanceof Error?restore:Error('Native logging restoration refused'));}throw error;}
  const api=notificationWorkerLifecycle(connection),projection=notificationWorkerProjection(connection),startedAt=new Date().toISOString();
  let stopping:Promise<void>|undefined;
  const abort=()=>{stopping=connection.end({timeout:0}).catch(()=>{});};context.signal.addEventListener('abort',abort,{once:true});if(context.signal.aborted)abort();
  let run='',pid=0,failed:unknown,phaseStarted=false,actualAdmissionCalls:number|undefined;
  try{
   context.signal.throwIfAborted();const openedAt=performance.now();run=await api.openRun(); // FIRST native query proves actual dedicated LOGIN authority.
   report.openWallMs=performance.now()-openedAt;
   const [identity]=await owner.client`select r.backend_pid as pid,r.backend_started_at::text as started,a.backend_start=r.backend_started_at as exact_start,a.usename as role from notification_worker_private.run r join pg_stat_activity a on a.pid=r.backend_pid where r.run_id=${run}::uuid`;
   expect(identity).toMatchObject({exact_start:true,role:'ai_hr_notification_worker'});pid=identity.pid;report.identity=identity;report.nativeRun=run;save();
   expect((await owner.client`select count(*)::int as n from pg_stat_activity where usename='ai_hr_notification_worker'`)[0].n).toBe(1);
   // Static, source-owned literal boundaries appear in real native Query Text.
   // Open has no pre-authority marker: all PID-bound log entries before this END
   // must terminate in the actual open_run invocation.
   await connection.unsafe("select 'notification-native-open-end'::text");
   const [settings]=await connection`select session_user,current_user,pg_backend_pid()as pid,current_setting('transaction_isolation')as isolation,current_setting('transaction_read_only')as readonly,
    current_setting('statement_timeout')as statement,current_setting('lock_timeout')as lock,current_setting('jit')as jit,current_setting('work_mem')as work_mem,
    current_setting('jit_above_cost')as jit_above_cost,current_setting('jit_inline_above_cost')as jit_inline_above_cost,current_setting('jit_optimize_above_cost')as jit_optimize_above_cost,
    current_setting('auto_explain.log_min_duration')as duration,current_setting('auto_explain.log_parameter_max_length')as parameters,current_setting('auto_explain.log_nested_statements')as nested,
    current_setting('auto_explain.log_analyze')as analyze,current_setting('auto_explain.log_buffers')as buffers,current_setting('auto_explain.log_settings')as settings,current_setting('auto_explain.log_format')as format,current_setting('auto_explain.log_timing')as timing`;
   report.session=settings;save();expect(settings).toMatchObject({session_user:'ai_hr_notification_worker',current_user:'ai_hr_notification_worker',pid,isolation:'read committed',readonly:'off',statement:'20s',lock:'300ms',jit:'on',duration:'0',parameters:'0',nested:'on',analyze:'on',buffers:'on',settings:'on',format:'json',timing:'off'});
   if(mode!=='open'){
    const scopes=await api.scopePage(run);expect(scopes.map(row=>row.tenant_id)).toEqual([b.tenantId]);
    await connection.unsafe("select 'notification-native-batch-begin'::text");phaseStarted=true;const batchAt=performance.now();
    const result=mode==='empty'?await api.finishEmptyBatch(run,b.tenantId,20):await projection.projectBatch(run,b.tenantId,20);
    report.batchWallMs=performance.now()-batchAt;report.result=result;save();
    expect(result).toEqual({processed:mode==='empty'?0:20,created:mode==='empty'?0:20});
    await connection.unsafe("select 'notification-native-batch-end'::text");
   }
   await api.failRun(run,'interrupted');
   const truth=Array.from(await owner.client`select r.state,r.committed_batches,r.processed_events,r.created_notifications,j.outcome,j.error,
    (select count(*)::int from notification_worker_private.committed_event e join notification_worker_private.committed_batch c on c.batch_id=e.batch_id where c.run_id=r.run_id)as committed_receipts,
    (select count(*)::int from public.notification n where n.tenant_id=${b.tenantId}::uuid)as notices,
    (select count(*)::int from public.notification_delivery d where d.tenant_id=${b.tenantId}::uuid and d.recipient_user_id=${recipient}::uuid and d.category='leave'and d.status='pending')as deliveries
    from notification_worker_private.run r join public.job_run j on j.id=r.run_id where r.run_id=${run}::uuid`);report.truth=truth;save();
   expect(truth[0]).toMatchObject({state:'failed',outcome:'failed',error:'interrupted',committed_batches:mode==='open'?0:1,processed_events:mode==='twenty'?'20':'0',created_notifications:mode==='twenty'?'20':'0',committed_receipts:mode==='twenty'?20:0,notices:mode==='twenty'?20:0,deliveries:mode==='twenty'?20:0});
  }catch(error){failed=error;report.failure=error instanceof Error?{name:error.name,message:error.message}:'Native diagnostic refused';save();}
  finally{
   context.signal.removeEventListener('abort',abort);
   try{await stopping;await connection.end({timeout:0});}catch(error){failed??=error;report.closeFailure=error instanceof Error?error.message:'Native close refused';ownership.poison(error instanceof Error?error:Error('Native close refused'));save();}
   try{
    report.afterDisconnect=Array.from(await owner.client`select r.run_id,r.state,r.backend_pid,r.backend_started_at::text as backend_start,r.committed_batches,r.processed_events,r.created_notifications,j.outcome,j.error,
     exists(select 1 from pg_stat_activity a where a.pid=r.backend_pid and a.backend_start=r.backend_started_at)as exact_backend_present
     from notification_worker_private.run r join public.job_run j on j.id=r.run_id order by r.started_at limit 2`);save();
    // Exact job-owned PG container and PID; raw native logs retained BEFORE any
    // plan assertions, including partial/timeout failures. No docker shell/SQL.
    const target=container(),logs=spawnSync('docker',['logs','--since',startedAt,target.name],{encoding:'utf8',timeout:20000,maxBuffer:64*1024*1024});
    const raw=(logs.stdout??'')+(logs.stderr??'');report.nativeLog={bytes:Buffer.byteLength(raw),sha256:createHash('sha256').update(raw).digest('hex'),pid,container:target.name,startedAt,truncated:!!logs.error||logs.status!==0};
    writeFileSync(join(output,mode+'-native.log'),raw,{flag:'wx',mode:0o600});save();
    if(logs.error||logs.status!==0||Buffer.byteLength(raw)>64*1024*1024)throw Error('Bounded native plan capture incomplete');
    if(pid){
     const messages=notificationAutoExplainMessages(raw,pid);report.actualPlanCount=messages.length;report.actualPlansFile=mode+'-native.log';report.admissionSummary=admissionSummary(messages);report.helperContractScanProof=notificationHelperContractScans(messages,expectedAdmission);actualAdmissionCalls=admissionSummary(messages).calls;save();expect(actualAdmissionCalls,'retained actual open2/empty10/twenty132 fresh admissions').toBe(mode==='twenty'?132:mode==='empty'?10:2);
     if(queryShapeVariant==='candidate'){const expected=beforeGuardCounts.get(mode);expect(expected,'complete same-job baseline call count').toBeTypeOf('number');expect(admissionSummary(messages).calls,'every original fresh native admission remains').toBe(expected);}
     expect(messages.length).toBeLessThanOrEqual(10000);
     expect(messages.length).toBeGreaterThan(0);
     const openEnd=messages.findIndex(entry=>entry.query.includes("'notification-native-open-end'"));expect(openEnd).toBeGreaterThan(0);
     const open=messages.slice(0,openEnd);expect(open.some(entry=>/select\s+notification_worker\.open_run\(\)/i.test(entry.query))).toBe(true);expect(open.some(entry=>/notification_worker_private\.admit_login\(\)/.test(entry.context))).toBe(true);
     report.openPhaseSummary=statementSummary(open);save();
     if(phaseStarted){
      const begin=messages.findIndex(entry=>entry.query.includes("'notification-native-batch-begin'")),end=messages.findIndex(entry=>entry.query.includes("'notification-native-batch-end'"));
      report.batchPhaseComplete=begin>=0&&end>begin;save();expect(begin).toBeGreaterThan(openEnd);expect(end).toBeGreaterThan(begin);
      const batch=messages.slice(begin+1,end);expect(batch.some(entry=>/notification_worker_private\.admit_batch\(/.test(entry.context))).toBe(true);expect(batch.some(entry=>/notification_worker_private\.assert_process_profile\(/.test(entry.context))).toBe(true);
      report.batchPhaseSummary=statementSummary(batch);save();
     }
    }else throw Error('No native admitted backend PID to bind partial plans');
   }catch(error){failed??=error;report.captureFailure=error instanceof Error?error.message:'Native capture refused';save();}
   finally{
    try{await logging.restore();report.loggingRestored=true;expect(await guard()).toEqual(original);report.guardsRestored=true;report.containerAfter=container();}
    catch(error){failed??=error;report.restoreFailure=error instanceof Error?error.message:'Native restoration refused';ownership.poison(error instanceof Error?error:Error('Native restoration refused'));}
    report.caseAborted=context.signal.aborted;report.ownerPoisoned=ownership.poisoned;report.complete=!failed&&!context.signal.aborted&&!ownership.poisoned;save();
   }
  }
  if(failed)throw failed;
  context.signal.throwIfAborted();
  if(queryShapeVariant==='baseline'){if(actualAdmissionCalls===undefined)throw Error('Complete native baseline admission count required');beforeGuardCounts.set(mode,actualAdmissionCalls);}
 }));
});

});

});
