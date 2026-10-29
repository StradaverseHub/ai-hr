/** Source-entry GHA diagnostic only: 1000 real continuous saves in a fictional 100001-row catalog.
 * This is neither sealed-packet acceptance nor a 100001-save throughput/readiness claim.
 */
import {afterAll,describe,expect,it} from 'vitest';
import {spawn,execFileSync,type ChildProcess} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {readFileSync,realpathSync,statSync} from 'node:fs';
import {once} from 'node:events';
import {availableParallelism,cpus,totalmem} from 'node:os';
import {resolve} from 'node:path';
import postgres from 'postgres';
import {client as appClient} from '../db/client';
import {commitEmployeeImport} from '../core/import';
import {createBankImportJob,uploadBankImportChunk,bankImportCommand,getBankImportJob} from '../core/bank-import-job';
import {BANK_IMPORT_BATCH_ROWS,BANK_IMPORT_CHUNK_BYTES} from '../lib/bank-import-job';
import {parseCsvRecords} from '../lib/csv';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from './harness';

const CATALOG=100001,SAVES=1000,HINT='app.bank_import_point_read';
const POLICY_SHA='42df3f7cd2dd81b90edce1643b87c1fa2ae42e0a2482b2a8761e5ebcdf006597';
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const ident=(value:string)=>'"'+value.replaceAll('"','""')+'"';
const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
type Target={ordinal:number;employment_id:string;person_id:string;statutory_id:string;employee_code:string};
type Progress={state:string;total:number;validated:number;valid:number;invalid:number;unchanged:number;processed:number;saved:number;failed:number;attempt_id:string|null;updated_ms:number;server_ms:number};
describe.skipIf(process.env.GITHUB_ACTIONS!=='true')('continuous native Bank worker diagnostic',()=>{
 afterAll(closeAll);
 it('commits exactly 1000 canonical changes and retains every non-target fact',async()=>{
  const started=performance.now(),deadline=started+780000;
  expect(process.env.GITHUB_ACTIONS).toBe('true');expect(process.env.CI).toBe('true');expect(process.platform).toBe('linux');
  const uid=process.getuid!(),gid=process.getgid!();expect(uid,'The source-entry worker must remain the nonroot Actions user').toBeGreaterThan(0);
  const root=realpathSync(resolve('.')),node=realpathSync(process.execPath),argv=[node,'--import','tsx','scripts/bank-import-runner.ts'];
  const source=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',timeout:5000}).trim();expect(source).toMatch(/^[a-f0-9]{40}$/);
  expect(process.env.AIHR_CI_HEAD,'Focused controller must provide the frozen source SHA').toMatch(/^[a-f0-9]{40}$/);
  const frozen=()=>{
   expect(execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',timeout:5000}).trim()).toBe(process.env.AIHR_CI_HEAD);
   expect(execFileSync('git',['status','--porcelain','--untracked-files=all'],{cwd:root,encoding:'utf8',timeout:5000}),'Frozen source must have no tracked or untracked changes; normal ignored runtime files are allowed').toBe('');
  };
  expect(source).toBe(process.env.AIHR_CI_HEAD);frozen();
  const policy=readFileSync(resolve(root,'test/fixtures/bank-import-point-read-profile.sql'));expect(hash(policy)).toBe(POLICY_SHA);
  const appUrl=new URL(process.env.TEST_DATABASE_URL!),ownerUrl=new URL(process.env.TEST_MIGRATION_DATABASE_URL!);
  for(const url of [appUrl,ownerUrl]){
   expect(['127.0.0.1','localhost','[::1]'].includes(url.hostname),'Disposable local DB only').toBe(true);
   expect(url.pathname).toMatch(/^\/ai_hr_test(?:_[a-z0-9_]+)?$/);
  }
  expect(appUrl.host).toBe(ownerUrl.host);expect(appUrl.pathname).toBe(ownerUrl.pathname);
  const witness=postgres(ownerUrl.toString(),{max:1,onnotice:()=>{},connection:{statement_timeout:'60000',lock_timeout:'5000'}});
  const remaining=()=>{const ms=deadline-performance.now();expect(ms,'13-minute work budget; cleanup reserved within 15-minute test').toBeGreaterThan(0);return ms;};
  const q=async(text:string,params:unknown[]=[])=>{remaining();const rows=await witness.unsafe(text,params as never[]);remaining();return rows;};
  const mutate=async(text:string,applied:()=>void)=>{remaining();await witness.unsafe(text).simple();applied();remaining();};
  const queueRole='ci_bank_cont_'+process.pid+'_'+randomBytes(5).toString('hex');
  let roleCreated=false,queueTransferred=false,policyTouched=false,child:ChildProcess|undefined,exit:Promise<[number|null,NodeJS.Signals|null]>|undefined;
  let originalOwner='',originalPolicies:unknown,originalFences:unknown,originalFunction:unknown,originalLedger:unknown;
  let childStart='',peakRssKiB=0,stdout='',stderr='',stdoutBytes=0,stderrBytes=0,primary:unknown;
  let childEnv:NodeJS.ProcessEnv={},expired=false;
  const measurements:Record<string,unknown>={};
  const samples:{elapsedMs:number;queryMs:number;state:string;saved:number;processed:number;validated:number;attemptPresent:boolean;serverMs:number}[]=[];
  let queryMs=0,probeCount=0;
  const catalog=async()=>[...await witness`select n.nspname,c.relname,c.relowner,c.relrowsecurity,c.relforcerowsecurity,c.relacl::text as acl
   from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and n.nspname in ('public','app') order by n.nspname,c.relname`];
  const policies=async()=>[...await witness`select schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check from pg_policies order by schemaname,tablename,policyname`];
  const functionSnapshot=async()=>[...await witness`select pg_get_functiondef(p.oid) as definition,to_jsonb(p) as catalog from pg_proc p where p.oid='app.visible_employment_ids()'::regprocedure`];
  const ledger=async()=>[...await witness`select id,hash,created_at::text from drizzle.__drizzle_migrations order by id`];
  const processFacts=()=>{
   expect(Boolean(child?.pid)&&child!.exitCode===null&&child!.signalCode===null,'Exact child must still be alive').toBe(true);
   const dir='/proc/'+child!.pid;
   const raw=readFileSync(dir+'/stat','utf8'),fields=raw.slice(raw.lastIndexOf(')')+2).trim().split(/\s+/);
   expect(Number(fields[1])).toBe(process.pid);
   if(childStart)expect(fields[19]).toBe(childStart);else childStart=fields[19];
   expect(statSync(dir).uid).toBe(uid);expect(realpathSync(dir+'/exe')).toBe(node);expect(realpathSync(dir+'/cwd')).toBe(root);
   expect(readFileSync(dir+'/cmdline').toString().split('\0').slice(0,-1)).toEqual(argv);
   const status=readFileSync(dir+'/status','utf8');
   for(const [key,value] of [['Uid',uid],['Gid',gid]] as const)expect(status.match(new RegExp('^'+key+':\\s+(.+)$','m'))?.[1].trim().split(/\s+/)).toEqual(Array(4).fill(String(value)));
   const environment=new Map(readFileSync(dir+'/environ').toString().split('\0').filter(Boolean).map(part=>{const at=part.indexOf('=');return [part.slice(0,at),part.slice(at+1)] as const;}));
   expect(Object.entries(childEnv).every(([key,value])=>environment.get(key)===value),'Exact child environment must retain pinned DB identities').toBe(true);
   for(const key of ['NODE_OPTIONS','NODE_PATH','LD_PRELOAD','LD_LIBRARY_PATH','AUDIT_HASH_CHAIN_ENABLED'])expect(environment.has(key)).toBe(false);
   peakRssKiB=Math.max(peakRssKiB,Number(status.match(/^VmHWM:\s+(\d+) kB$/m)?.[1]??0));
   return {userTicks:Number(fields[11]),systemTicks:Number(fields[12]),peakRssKiB};
  };
  const awaitExit=async(ms:number)=>{
   let timeout:ReturnType<typeof setTimeout>|undefined;
   try{return await Promise.race([exit!.then(()=>true),new Promise<boolean>(resolve=>{timeout=setTimeout(()=>resolve(false),ms);})]);}
   finally{if(timeout)clearTimeout(timeout);}
  };
  const stopChild=async()=>{
   if(!child||child.exitCode!==null||child.signalCode!==null)return;
   processFacts();child.kill('SIGTERM');
   const normal=await awaitExit(15000);
   if(!normal){processFacts();child.kill('SIGKILL');if(!await awaitExit(5000))throw Error('Exact child did not exit after cleanup kill');throw Error('Native child required forced cleanup; diagnostic failed');}
  };
  const timer=setTimeout(()=>{expired=true;try{if(child&&child.exitCode===null&&child.signalCode===null){processFacts();child.kill('SIGTERM');}}catch{/* finally retains the primary budget failure and retries only proven ownership. */}},Math.max(1,deadline-performance.now()));
  timer.unref();
  try{
   await migrateTestDb();await resetDb();const base=await seedBase(),context=adminCtx(base);
   const records=parseCsvRecords('full_name,email,department,hired_on,ic_number,basic_salary,employee_code\nContinuous Exemplar,continuous-exemplar@example.test,Finance,2026-01-05,900101105555,5000,CONT-EXEMPLAR').records;
   expect((await commitEmployeeImport(context,{companyId:base.companyId,records})).imported).toBe(1);
   const [exemplar]=await q("select e.person_id from employment e join employee_statutory_my s on s.person_id=e.person_id where e.tenant_id=$1::uuid and e.employee_code='CONT-EXEMPLAR'",[base.tenantId]);
   await witness.begin(async tx=>{
    await tx`set local session_replication_role='replica'`;
    await tx`with people as(insert into person(tenant_id,full_name,primary_email)
     select ${base.tenantId}::uuid,'Continuous '||n,'continuous-'||n||'@example.test' from generate_series(1,${CATALOG}) n returning id,full_name)
     insert into employment(tenant_id,person_id,company_id,employee_code,hired_on)
     select ${base.tenantId}::uuid,id,${base.companyId}::uuid,'CONT'||substring(full_name from 12),'2026-01-05'::date from people`;
    await tx`insert into employee_statutory_my select replacement.* from employment e cross join lateral jsonb_populate_record(null::employee_statutory_my,
     (select to_jsonb(s) from employee_statutory_my s where s.person_id=${exemplar.person_id}::uuid)||jsonb_build_object('id',gen_random_uuid(),'person_id',e.person_id,'ic_number',null,'tax_number','TBASE')) replacement
     where e.tenant_id=${base.tenantId}::uuid and e.employee_code ~ '^CONT[0-9]+$'`;
   });
   for(const table of ['person','employment','employee_statutory_my'])await q(`ANALYZE public.${ident(table)}`);
   const [size]=await q("select count(*)::int as rows,count(distinct e.id)::int as employments,count(distinct e.person_id)::int as people,count(distinct e.company_id)::int as companies from employment e join employee_statutory_my s on s.person_id=e.person_id where e.tenant_id=$1::uuid and e.employee_code ~ '^CONT[0-9]+$' and s.tax_number='TBASE'",[base.tenantId]);
   expect({...size}).toEqual({rows:CATALOG,employments:CATALOG,people:CATALOG,companies:1});
   const targets=[...await q("select substring(e.employee_code from 5)::int as ordinal,e.id as employment_id,e.person_id,s.id as statutory_id,e.employee_code from employment e join employee_statutory_my s on s.person_id=e.person_id where e.tenant_id=$1::uuid and e.employee_code ~ '^CONT[0-9]+$' and substring(e.employee_code from 5)::int between 1 and $2 order by ordinal",[base.tenantId,SAVES])] as unknown as Target[];
   expect(targets.length).toBe(SAVES);for(const key of ['ordinal','employment_id','person_id','statutory_id','employee_code'] as const)expect(new Set(targets.map(t=>t[key])).size).toBe(SAVES);
   targets.forEach((t,i)=>{expect(t.ordinal).toBe(i+1);expect(t.employee_code).toBe('CONT'+(i+1));});
   const targetJson=JSON.stringify(targets),targetIds=JSON.stringify(targets.map(t=>t.statutory_id));
   const mapping=async()=>{
    const [r]=await q("select count(*)::int as rows,encode(sha256(convert_to(coalesce(string_agg(e.id::text||':'||e.person_id::text||':'||coalesce(e.employee_code,'')||':'||coalesce(s.id::text,''),'|' order by e.id),''),'UTF8')),'hex') as hash from employment e left join employee_statutory_my s on s.person_id=e.person_id where e.tenant_id=$1::uuid",[base.tenantId]);return {...r};
   };
   const fingerprints=async()=>{
    const facts:Record<string,unknown>={};
    for(const table of ['person','employment','assignment','compensation','employee_statutory_my']){
     const expression=table==='employee_statutory_my'?"case when t.id in(select value::uuid from jsonb_array_elements_text($1::jsonb)) then to_jsonb(t)-'tax_number'-'updated_at' else to_jsonb(t) end":'to_jsonb(t)';
     const params=table==='employee_statutory_my'?[targetIds]:[];
     const [row]=await q(`select count(*)::int as rows,encode(sha256(convert_to(coalesce(string_agg(encode(sha256(convert_to((${expression})::text,'UTF8')),'hex'),'' order by t.id),''),'UTF8')),'hex') as hash from public.${ident(table)} t`,params);facts[table]={...row};
    }
    // Complete statutory rows for 99001 non-target subjects AND the canonical exemplar.
    const [noncohort]=await q("select count(*)::int as rows,encode(sha256(convert_to(coalesce(string_agg(encode(sha256(convert_to(to_jsonb(s)::text,'UTF8')),'hex'),'' order by s.id),''),'UTF8')),'hex') as hash from employee_statutory_my s where s.id not in(select value::uuid from jsonb_array_elements_text($1::jsonb))",[targetIds]);
    expect(Number(noncohort.rows)).toBe(CATALOG-SAVES+1);facts.noncohort={...noncohort};return facts;
   };
   const beforeMapping=await mapping(),beforeFacts=await fingerprints();expect(beforeMapping.rows).toBe(CATALOG+1);
   originalPolicies=await policies();originalFunction=await functionSnapshot();originalFences=await catalog();originalLedger=await ledger();
   const baseline=(originalPolicies as {tablename:string;schemaname:string;policyname:string;qual:string}[]).find(p=>p.schemaname==='public'&&p.tablename==='employment'&&p.policyname==='employment_rls')!;
   expect(Boolean(baseline)).toBe(true);
   // Exact fixture already reviewed; both ELSE arms must still be the actual current qual.
   // pg_get_expr inserts this output-column alias; strip only that known deparser
   // spelling in addition to formatting. The actual SQL fixture bytes stay unchanged.
   const compact=(text:string)=>text.replace(/\bAS\s+visible_employment_ids\b/gi,'').replace(/\s+/g,'').replace(/"/g,'');
   expect(compact(policy.toString()).split(compact(baseline.qual)).length).toBe(3);
   await mutate(policy.toString(),()=>{policyTouched=true;});
   const installed=await policies();
   expect(installed.map(p=>p.schemaname+'.'+p.tablename+'.'+p.policyname)).toEqual((originalPolicies as typeof installed).map(p=>p.schemaname+'.'+p.tablename+'.'+p.policyname));
   installed.forEach((p,i)=>expect(p.tablename==='employment'&&p.policyname==='employment_rls'?{...p,qual:(originalPolicies as typeof installed)[i].qual}:p).toEqual((originalPolicies as typeof installed)[i]));
   const [physical]=await q("select r.rolname from pg_class c join pg_roles r on r.oid=c.relowner where c.oid='public.bank_import_job'::regclass");originalOwner=String(physical.rolname);
   const password=randomBytes(24).toString('hex');
   await mutate(`CREATE ROLE ${ident(queueRole)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD '${password}'`,()=>{roleCreated=true;});
   await q(`GRANT CONNECT ON DATABASE ${ident(appUrl.pathname.slice(1))} TO ${ident(queueRole)}`);
   await q(`GRANT USAGE ON SCHEMA public,app TO ${ident(queueRole)}`);
   await mutate(`ALTER TABLE public.bank_import_job OWNER TO ${ident(queueRole)}`,()=>{queueTransferred=true;});
   const roles=[...await q("select r.rolname,r.rolsuper,r.rolbypassrls,c.relowner=r.oid as queue_owner from pg_roles r cross join pg_class c where r.rolname in ('ai_hr_app',$1) and c.oid='public.bank_import_job'::regclass order by r.rolname",[queueRole])];
   expect(roles.map(r=>[r.rolname,r.rolsuper,r.rolbypassrls,r.queue_owner])).toEqual([['ai_hr_app',false,false,false],[queueRole,false,false,true]].sort((a,z)=>String(a[0]).localeCompare(String(z[0]))));
   // A reserved APP backend proves LOCAL restoration after BOTH transaction outcomes.
   // This is deliberately not presented as proof about a different arbitrary pooled connection.
   const reserved=await appClient.reserve();
   try{
    const [initial]=await reserved`select pg_backend_pid() as backend,current_user as role,nullif(current_setting(${HINT},true),'') as hint`;expect(initial.role).toBe('ai_hr_app');
    for(const end of ['COMMIT','ROLLBACK']){
     await reserved.unsafe('BEGIN');let open=true;
     try{await reserved`select set_config(${HINT},'on',true)`;const [inside]=await reserved`select pg_backend_pid() as backend,current_setting(${HINT},true) as hint`;expect({...inside}).toEqual({backend:initial.backend,hint:'on'});await reserved.unsafe(end);open=false;}
     finally{if(open)await reserved.unsafe('ROLLBACK');}
     const [after]=await reserved`select pg_backend_pid() as backend,current_user as role,nullif(current_setting(${HINT},true),'') as hint`;expect({...after}).toEqual({...initial});
    }
   }finally{reserved.release();}
   const queueUrl=new URL(ownerUrl);queueUrl.username=queueRole;queueUrl.password=password;
   childEnv={PATH:process.env.PATH!,HOME:process.env.HOME!,TMPDIR:process.env.TMPDIR??'/tmp',LANG:'C.UTF-8',TZ:'Asia/Kuala_Lumpur',NODE_ENV:'test',CI:'true',GITHUB_ACTIONS:'true',DATABASE_URL:appUrl.toString(),TEST_DATABASE_URL:appUrl.toString(),MIGRATION_DATABASE_URL:queueUrl.toString(),TEST_MIGRATION_DATABASE_URL:queueUrl.toString()};
   measurements.fixtureSetupMs=performance.now()-started;
   const startup=performance.now();
   child=spawn(node,argv.slice(1),{cwd:root,env:childEnv,uid,gid,stdio:['ignore','pipe','pipe']});
   exit=new Promise<[number|null,NodeJS.Signals|null]>((resolve,reject)=>{child!.once('error',reject);child!.once('close',(code,signal)=>resolve([code,signal]));});
   void exit.catch(()=>{});
   child.stdout!.on('data',(value:Buffer)=>{stdoutBytes+=value.length;stdout=(stdout+value.toString()).slice(-8192);});
   child.stderr!.on('data',(value:Buffer)=>{stderrBytes+=value.length;stderr=(stderr+value.toString()).slice(-8192);});
   await once(child,'spawn');processFacts();
   while(true){remaining();processFacts();const [ready]=await q('select exists(select 1 from pg_stat_activity where usename=$1 and datname=current_database()) as ready',[queueRole]);if(ready.ready)break;await sleep(100);}
   measurements.startupToQueueConnectionObservedMs=performance.now()-startup;
   const idleStart=performance.now(),idleBefore=processFacts();await sleep(2100);const idleAfter=processFacts();
   const [empty]=await q('select count(*)::int as jobs from bank_import_job');expect(empty.jobs).toBe(0);
   measurements.emptyQueueIdleObservation={wallMs:performance.now()-idleStart,userTicks:idleAfter.userTicks-idleBefore.userTicks,systemTicks:idleAfter.systemTicks-idleBefore.systemTicks,knownSourceSleepMs:1000,precisePollCountMeasured:false};
   const admissionStarted=performance.now(),bytes=Buffer.from('employee_code,tax_number\n'+targets.map(t=>t.employee_code+',TCONT'+t.ordinal+'\n').join(''));
   const jobId=(await createBankImportJob(context,{name:'continuous.csv',bytes:bytes.length,hash:hash(bytes)})).job.id;
   let parts=0;for(let offset=0;offset<bytes.length;offset+=BANK_IMPORT_CHUNK_BYTES)await uploadBankImportChunk(context,jobId,parts++,bytes.subarray(offset,offset+BANK_IMPORT_CHUNK_BYTES));
   measurements.admissionAndChunksMs=performance.now()-admissionStarted;measurements.transport={sourceBytes:bytes.length,parts,multipartRequired:false};
   const progress=async()=>{
    remaining();expect(expired).toBe(false);processFacts();const at=performance.now();
    const [row]=await q('select state,total,validated,valid,invalid,unchanged,processed,saved,failed,attempt_id,extract(epoch from updated_at)*1000 as updated_ms,extract(epoch from clock_timestamp())*1000 as server_ms from bank_import_job where id=$1::uuid',[jobId]);
    const p=row as unknown as Progress;const cost=performance.now()-at;queryMs+=cost;probeCount++;
    expect(p.state==='failed','Native job must not fail').toBe(false);expect(p.failed).toBe(0);expect(p.invalid).toBe(0);
    expect(p.processed<=SAVES&&p.saved<=p.processed&&p.validated<=SAVES).toBe(true);
    if(samples.length)expect(p.saved>=samples.at(-1)!.saved&&p.processed>=samples.at(-1)!.processed&&p.validated>=samples.at(-1)!.validated).toBe(true);
    samples.push({elapsedMs:performance.now()-started,queryMs:cost,state:p.state,saved:p.saved,processed:p.processed,validated:p.validated,attemptPresent:Boolean(p.attempt_id),serverMs:Number(p.server_ms)});
    expect(samples.length).toBeLessThan(4000);return p;
   };
   const until=async(predicate:(p:Progress)=>boolean)=>{while(true){const p=await progress();if(predicate(p))return p;await sleep(Math.min(250,remaining()));}};
   const validation=performance.now();await bankImportCommand(context,jobId,'validate');await until(p=>p.state==='ready');measurements.validationToReadyObservedMs=performance.now()-validation;
   expect((await getBankImportJob(context,jobId)).job).toMatchObject({state:'ready',total:SAVES,valid:SAVES,invalid:0,unchanged:0,saved:0});
   const confirmStarted=performance.now(),confirmation=await bankImportCommand(context,jobId,'confirm');measurements.confirmRequestMs=performance.now()-confirmStarted;
   const withAttempt=await until(p=>Boolean(p.attempt_id));measurements.confirmToAttemptObservedMs=performance.now()-confirmStarted;
   measurements.savedAtFirstAttemptObservation=withAttempt.saved;
   const complete=await until(p=>p.state==='completed');const completionObserved=performance.now();measurements.confirmToCompletedObservedMs=completionObserved-confirmStarted;
   expect(complete).toMatchObject({state:'completed',total:SAVES,validated:SAVES,valid:SAVES,invalid:0,unchanged:0,processed:SAVES,saved:SAVES,failed:0});
   const finalProcess=processFacts();await stopChild();const [code,signal]=await exit!;expect(code).toBe(0);expect(signal).toBeNull();expect(stdoutBytes).toBe(0);expect(stderrBytes).toBe(0);
   const wrapup=performance.now();
   const [audit]=await q(`select count(*)::int as rows,count(distinct a.ordinal)::int as ordinals,count(distinct a.employment_id)::int as employments,
    count(*) filter(where a.status='applied' and a.item_key='row-'||a.ordinal and a.employment_id=t.employment_id and a.before->'fields'->>'tax_number'='TBASE' and a.after->'fields'->>'tax_number'='TCONT'||a.ordinal)::int as correct,
    extract(epoch from min(a.created_at))*1000 as first_ms,extract(epoch from max(a.created_at))*1000 as last_ms
    from import_attempt_item a left join jsonb_to_recordset($2::jsonb) t(ordinal int,employment_id uuid) on t.ordinal=a.ordinal where a.attempt_id=$1::uuid`,[complete.attempt_id,targetJson]);
   for(const key of ['rows','ordinals','employments','correct'])expect(audit[key]).toBe(SAVES);
   const [nativeAudit]=await q(`select count(*)::int as rows,count(distinct d.aggregate_id)::int as subjects,count(distinct d.subject_employment_id)::int as employments,
    count(*) filter(where d.tenant_id=$2::uuid and d.actor_type='user' and d.actor_id=$3::uuid and d.subject_employment_id=t.employment_id and d.payload->'before'->>'taxNumber'='TBASE' and d.payload->'after'->>'taxNumber'='TCONT'||t.ordinal)::int as correct
    from domain_event d join jsonb_to_recordset($1::jsonb) t(ordinal int,statutory_id uuid,employment_id uuid) on t.statutory_id=d.aggregate_id
    where d.event_type='employee.tax.updated'`,[targetJson,base.tenantId,context.userId]);
   for(const key of ['rows','subjects','employments','correct'])expect(nativeAudit[key]).toBe(SAVES);
   const [values]=await q("select count(*)::int as rows,count(distinct s.tax_number)::int as unique_values,count(*) filter(where e.id=t.employment_id and e.person_id=t.person_id and e.employee_code=t.employee_code and s.person_id=t.person_id and s.tax_number='TCONT'||t.ordinal)::int as correct from jsonb_to_recordset($1::jsonb) t(ordinal int,employment_id uuid,person_id uuid,statutory_id uuid,employee_code text) join employment e on e.id=t.employment_id join employee_statutory_my s on s.id=t.statutory_id",[targetJson]);
   expect({...values}).toEqual({rows:SAVES,unique_values:SAVES,correct:SAVES});
   const [queue]=await q("select count(*)::int as rows,count(distinct ordinal)::int as ordinals,count(*) filter(where state='applied')::int as applied from bank_import_row where job_id=$1::uuid",[jobId]);expect({...queue}).toEqual({rows:SAVES,ordinals:SAVES,applied:SAVES});
   const [tail]=await q("select (select count(*)::int from import_attempt where tenant_id=$1::uuid and source_hash=$2) as attempts,(select count(*)::int from import_attempt_event where attempt_id=$3::uuid and kind='confirmed') as confirmations,(select count(*)::int from bank_import_chunk where job_id=$4::uuid) as chunks",[base.tenantId,hash(bytes),complete.attempt_id,jobId]);expect({...tail}).toEqual({attempts:1,confirmations:1,chunks:0});
   const [attempt]=await q('select extract(epoch from created_at)*1000 as created_ms from import_attempt where id=$1::uuid',[complete.attempt_id]);
   const boundaries=[...await q('select ordinal,extract(epoch from created_at)*1000 as started_ms from import_attempt_item where attempt_id=$1::uuid and (ordinal-1)%100=0 order by ordinal',[complete.attempt_id])];
   expect(BANK_IMPORT_BATCH_ROWS).toBe(100);expect(boundaries.length).toBe(10);
   const boundaryTimes=boundaries.map(r=>Number(r.started_ms)).concat(Number(complete.updated_ms));
   const intervals=boundaries.map((r,i)=>({firstOrdinal:Number(r.ordinal),rows:100,transactionStartIntervalMs:boundaryTimes[i+1]-boundaryTimes[i]}));expect(intervals.every(r=>r.transactionStartIntervalMs>=0)).toBe(true);
   const nativeSaveMs=Number(complete.updated_ms)-Number(audit.first_ms);expect(nativeSaveMs).toBeGreaterThan(0);
   // Each start belongs to the actual canonical audit transaction, not a guessed
   // per-row setter duration. LEAD closes the final interval at completion start.
   const [distribution]=await q(`with starts as (
    select extract(epoch from created_at)*1000 as started_ms,
     lead(extract(epoch from created_at)*1000,1,$2::numeric) over(order by ordinal) as next_ms
    from import_attempt_item where attempt_id=$1::uuid
   ), intervals as(select next_ms-started_ms as ms from starts)
   select count(*)::int as count,count(*) filter(where ms>=0)::int as nonnegative,
    min(ms) as min_ms,avg(ms) as mean_ms,
    percentile_cont(0.50) within group(order by ms::double precision) as p50_ms,
    percentile_cont(0.95) within group(order by ms::double precision) as p95_ms,
    percentile_cont(0.99) within group(order by ms::double precision) as p99_ms,
    max(ms) as max_ms,sum(ms) as sum_ms from intervals`,[complete.attempt_id,complete.updated_ms]);
   const rowIntervalDistribution=Object.fromEntries(Object.entries(distribution).map(([key,value])=>[key,Number(value)]));
   expect(rowIntervalDistribution.count).toBe(SAVES);expect(rowIntervalDistribution.nonnegative).toBe(SAVES);
   expect(Object.values(rowIntervalDistribution).every(Number.isFinite)).toBe(true);
   expect(Math.abs(rowIntervalDistribution.sum_ms-nativeSaveMs),'All row intervals must telescope to the native-save interval within 1ms numeric/JS conversion tolerance').toBeLessThanOrEqual(1);
   measurements.canonicalRowTransactionStartIntervalDistribution={...rowIntervalDistribution,units:'milliseconds',sumAlignmentToleranceMs:1,semantics:'1000 ordinal-ordered canonical audit transaction-start intervals, last ending at completion transaction start. Includes row commits/checkpoints and between-tick work; NOT exact native-call latency. No per-row values are emitted.'};
   expect(await mapping()).toEqual(beforeMapping);expect(await fingerprints()).toEqual(beforeFacts);
   expect(await functionSnapshot()).toEqual(originalFunction);expect(await ledger()).toEqual(originalLedger);
   const finalRoles=[...await q("select r.rolname,r.rolsuper,r.rolbypassrls,c.relowner=r.oid as queue_owner from pg_roles r cross join pg_class c where r.rolname in ('ai_hr_app',$1) and c.oid='public.bank_import_job'::regclass order by r.rolname",[queueRole])];expect(finalRoles).toEqual(roles);
   measurements.finalAssertionsMs=performance.now()-wrapup;
   measurements.databaseTransactionBoundaries={confirmationStartToAttemptStartMs:Number(attempt.created_ms)-Date.parse(confirmation.updatedAt),attemptStartToFirstRowStartMs:Number(audit.first_ms)-Number(attempt.created_ms),continuous1000RowCommitIntervalMs:nativeSaveMs,rowsPerSecond:SAVES/(nativeSaveMs/1000),lastRowStartToCompletionStartMs:Number(complete.updated_ms)-Number(audit.last_ms),completionStartToObservedCompletedUpperBoundMs:Number(complete.server_ms)-Number(complete.updated_ms),intervals,semantics:'Audit created_at is transaction-start time. Interval spans first applied-row transaction start to completion transaction start, includes row commits and between-batch work, excludes completion transaction body/commit. These are not directly instrumented worker tick timings.'};
   frozen();
   console.info('[bank-worker-continuous-measurement]',JSON.stringify({kind:'SOURCE_ENTRY_CONTINUOUS_1000_OF_100001_NOT_ACCEPTANCE',source,policySha256:POLICY_SHA,migrationLedger:{rows:(originalLedger as unknown[]).length,sha256:hash(JSON.stringify(originalLedger))},visibleFunctionMetadataSha256:hash(JSON.stringify(originalFunction)),catalogRows:CATALOG,changedRows:SAVES,targetMappingSha256:hash(targetJson),fullCatalogMapping:beforeMapping,noncohortRows:CATALOG-SAVES+1,measurements,probeCount,progressQueryMs:queryMs,progressSamples:samples,worker:{pid:child.pid,uid,gid,...finalProcess},runId:process.env.GITHUB_RUN_ID,runAttempt:process.env.GITHUB_RUN_ATTEMPT,runner:{environment:process.env.RUNNER_ENVIRONMENT,os:process.env.RUNNER_OS,cpus:availableParallelism(),cpuModel:cpus()[0]?.model,totalMemoryBytes:totalmem(),node:process.version},nativeValuesAndAuditsVerified:true,noncohortFactsUnchanged:true,sourceChunksReleased:true,preciseTickInstrumentation:false,noRestartInTimedWindow:true,sealedPacketAccepted:false,full100001ThroughputAccepted:false,releaseAuthorized:false}));
  }catch(error){primary=error;throw error;}finally{
   clearTimeout(timer);
   const failures:unknown[]=[];
   try{await stopChild();}catch(error){failures.push(error);}
   // Every restoration is attempted independently. Never terminate a backend or foreign process.
   if(queueTransferred)try{await witness.unsafe(`ALTER TABLE public.bank_import_job OWNER TO ${ident(originalOwner)}`);}catch(error){failures.push(error);}
   if(policyTouched)try{
    const original=(originalPolicies as {schemaname:string;tablename:string;policyname:string;qual:string}[]).find(p=>p.schemaname==='public'&&p.tablename==='employment'&&p.policyname==='employment_rls')!;
    await witness.unsafe(`ALTER POLICY employment_rls ON public.employment USING (${original.qual})`);
   }catch(error){failures.push(error);}
   if(roleCreated){
    // Remove only this fixture's explicit ACLs in this disposable database before dropping its unique role.
    for(const text of [`REVOKE USAGE ON SCHEMA public,app FROM ${ident(queueRole)}`,`REVOKE CONNECT ON DATABASE ${ident(appUrl.pathname.slice(1))} FROM ${ident(queueRole)}`,`DROP ROLE ${ident(queueRole)}`])try{await witness.unsafe(text);}catch(error){failures.push(error);}
   }
   for(const check of [async()=>{if(originalPolicies)expect(await policies()).toEqual(originalPolicies);},async()=>{if(originalFunction)expect(await functionSnapshot()).toEqual(originalFunction);},async()=>{if(originalFences)expect(await catalog()).toEqual(originalFences);},async()=>{if(originalLedger)expect(await ledger()).toEqual(originalLedger);}])try{await check();}catch(error){failures.push(error);}
   try{await witness.end({timeout:5});}catch(error){failures.push(error);}
   try{frozen();}catch(error){failures.push(error);}
   if(primary!==undefined){console.info('[bank-worker-continuous-failed]',JSON.stringify({elapsedMs:performance.now()-started,expired,measurements,probeCount,progressQueryMs:queryMs,progressSamples:samples,stdoutBytes,stderrBytes,stdoutSha256:hash(stdout),stderrSha256:hash(stderr)}));for(const error of failures)console.error('Continuous diagnostic cleanup after original failure:',error);}
   else if(failures.length)throw failures[0];
  }
  console.info('[bank-worker-continuous-restored]',JSON.stringify({originalPoliciesAndFunctionRestored:true,originalOwnershipAndRlsRestored:true,temporaryQueueRoleRemoved:true,ledgerUnchanged:true,elapsedMs:performance.now()-started,releaseAuthorized:false}));
 },900000);
});
