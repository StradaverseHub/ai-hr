/** Disposable GHA fixture only. The Python controller owns actual sealed-worker processes. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const ROWS=100001,APP='postgres://ai_hr_app@127.0.0.1:5433/ai_hr_test';
const OWNER='postgres://ai_hr_owner@127.0.0.1:5433/ai_hr_test';
const WITNESS='postgres://postgres@127.0.0.1:5433/ai_hr_test';
async function main(){
 const [phase,packetArg,sourceArg,statePath]=process.argv.slice(2);
 assert(process.env.GITHUB_ACTIONS==='true'&&process.env.CI==='true'&&process.platform==='linux','Disposable Linux GHA only');
 assert.equal(process.env.DATABASE_URL,APP);assert.equal(process.env.MIGRATION_DATABASE_URL,OWNER);
 assert.equal(process.env.TEST_DATABASE_URL,APP);assert.equal(process.env.TEST_MIGRATION_DATABASE_URL,OWNER);
 assert.equal(process.env.AUDIT_HASH_CHAIN_ENABLED,undefined,'Use unchanged unset audit semantics without the explicit-false warning');
 const packet=resolve(packetArg),source=resolve(sourceArg);
 assert(packet!==source&&!packet.startsWith(source+'/')&&!source.startsWith(packet+'/'));
 const load=async(path:string)=>{const m=await import(pathToFileURL(path).href);return {...(m.default??{}),...m};};
 const postgres=createRequire(join(packet,'package.json'))('postgres');
 const owner=postgres(OWNER,{max:1,onnotice:()=>{}}),witness=postgres(WITNESS,{max:1,onnotice:()=>{}});
 let app:any,harness:any,primaryError:unknown;
 const save=(value:unknown)=>writeFileSync(statePath,JSON.stringify(value)+'\n',{mode:0o600});
 // Private witness-owned IDs are captured once, before any measured native worker runs.
 // The application has no schema/table grants and cannot expand the masking cohort.
 const targetMapping=async()=>{
  const [access]=await witness`select has_schema_privilege('ai_hr_app','ci_import_cohort','USAGE') as app_access,has_table_privilege('ai_hr_owner','ci_import_cohort.target','INSERT,UPDATE,DELETE,TRUNCATE') as owner_write`;
  assert.equal(access.app_access,false,'Application must not access captured target IDs');
  // Fixture seeding can still use the temporary setup owner; Python demotes it before native work.
  if(phase!=='setup')assert.equal(access.owner_write,false,'Native-phase owner must only read captured target IDs');
  const rows=await witness`select ordinal,employee_code,person_id,employment_id,statutory_id from ci_import_cohort.target order by ordinal`;
  assert.equal(rows.length,ROWS);
  for(const key of ['ordinal','employee_code','person_id','employment_id','statutory_id'])assert.equal(new Set(rows.map((r:any)=>r[key])).size,ROWS,'Nonunique captured target '+key);
  rows.forEach((r:any,i:number)=>{assert.equal(r.ordinal,i+1);assert.equal(r.employee_code,'LOAD'+(i+1));});
  const [live]=await witness`select count(*)::int as rows from ci_import_cohort.target t join employment e on e.id=t.employment_id and e.person_id=t.person_id and e.employee_code=t.employee_code join employee_statutory_my s on s.id=t.statutory_id and s.person_id=t.person_id`;
  assert.equal(live.rows,ROWS,'Captured subject mapping changed');
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
 };
 const systemRows=async(tx:any)=>{
  const tenantRows=await tx`select to_jsonb(t)::text as row from tenant t where id='00000000-0000-0000-0000-000000000000'::uuid`;
  const out:Record<string,unknown>={tenant:Array.from(tenantRows,(row:any)=>row.row)};
  const tables=await tx`select n.nspname,c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid and a.attname='tenant_id' and a.atttypid='uuid'::regtype and not a.attisdropped where n.nspname in ('public','app') and c.relkind in ('r','p') order by n.nspname,c.relname`;
  for(const table of tables){
   const qualified=[table.nspname,table.relname].map((name:string)=>'"'+name.replaceAll('"','""')+'"').join('.');
   const [row]=await tx.unsafe(`select count(*)::int as rows,md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by to_jsonb(t)::text),'')) as hash from ${qualified} t where tenant_id='00000000-0000-0000-0000-000000000000'::uuid`);
   out[qualified]=row;
  }
  return out;
 };
 const systemSnapshot=async()=>witness.begin(async(tx:any)=>{await tx`set transaction read only`;return systemRows(tx);});
 const fingerprints=async()=>witness.begin(async(tx:any)=>{
  await tx`set transaction read only`;
  const out:Record<string,unknown>={};
  for(const table of ['person','employment','assignment','compensation','employee_statutory_my']){
   const expression=table==='employee_statutory_my'?"case when exists(select 1 from ci_import_cohort.target c where c.person_id=t.person_id and c.statutory_id=t.id) then to_jsonb(t)-'tax_number'-'updated_at' else to_jsonb(t) end":'to_jsonb(t)';
   const [row]=await tx.unsafe(`select count(*)::int as rows,md5(coalesce(string_agg(md5((${expression})::text),'' order by t.id),'')) as hash from public."${table}" t`);
   out[table]=row;
  }
  out.systemRows=await systemRows(tx);return out;
 });
 const roles=async()=>{
  const rows=await owner`select r.rolname,r.rolsuper,r.rolbypassrls,c.relowner=r.oid as queue_owner from pg_roles r cross join pg_class c where r.rolname in ('ai_hr_app','ai_hr_owner') and c.oid='public.bank_import_job'::regclass order by r.rolname`;
  assert.deepEqual(rows.map((r:any)=>[r.rolname,r.rolsuper,r.rolbypassrls,r.queue_owner]),[['ai_hr_app',false,false,false],['ai_hr_owner',false,false,true]]);
  return rows;
 };
 try{
  if(phase==='setup'){
   const tenants=await witness`select id,workos_org_id,name from tenant order by id`;
   assert.deepEqual(tenants.map((row:any)=>({...row})),[{id:'00000000-0000-0000-0000-000000000000',workos_org_id:'org_system_auth_audit',name:'System (auth audit)'}],'Only the exact migration-owned auth system tenant may precede the fictional fixture');
   const [empty]=await witness`select count(*)::int as jobs from bank_import_job`;
   assert.equal(empty.jobs,0,'Fresh disposable database required; never reuse an installation');
   const systemBaseline=await systemSnapshot();
   harness=await load(join(source,'test/harness.ts'));
   const b=await harness.seedBase(),ctx=harness.adminCtx(b);
   app=(await load(join(packet,'db/client.ts'))).client;
   const importer=await load(join(packet,'core/import.ts')),csv=await load(join(packet,'lib/csv.ts'));
   const records=csv.parseCsvRecords('full_name,email,department,hired_on,ic_number,basic_salary,employee_code\nCI Throughput Exemplar,throughput-exemplar@example.test,Finance,2026-01-05,900101105555,5000,LOAD-EXEMPLAR').records;
   const result=await importer.commitEmployeeImport(ctx,{companyId:b.companyId,records});
   assert.equal(result.imported,1);assert.equal(result.failed.length,0);
   const [exemplar]=await owner`select e.person_id from employment e join employee_statutory_my s on s.person_id=e.person_id where e.tenant_id=${b.tenantId}::uuid and e.employee_code='LOAD-EXEMPLAR'`;
   assert(exemplar);
   // Fixture construction only. All measured validation and HR writes retain ordinary triggers/RLS.
   // Reuse the canonical exemplar; do not replay unrelated new-employment workflows 100001 times.
   await witness.begin(async(tx:any)=>{
    await tx`set local session_replication_role='replica'`;
    await tx`with people as (
     insert into person(tenant_id,full_name,primary_email)
     select ${b.tenantId}::uuid,'Throughput '||n,'throughput-'||n||'@example.test' from generate_series(1,${ROWS}) n returning id,full_name
    ) insert into employment(tenant_id,person_id,company_id,employee_code,hired_on)
     select ${b.tenantId}::uuid,id,${b.companyId}::uuid,'LOAD'||substring(full_name from 12),'2026-01-05'::date from people`;
    await tx`insert into employee_statutory_my
     select replacement.* from employment e cross join lateral jsonb_populate_record(null::employee_statutory_my,
      (select to_jsonb(s) from employee_statutory_my s where s.person_id=${exemplar.person_id}::uuid)
      ||jsonb_build_object('id',gen_random_uuid(),'person_id',e.person_id,'ic_number',null,'tax_number','TBASE')) replacement
     where e.tenant_id=${b.tenantId}::uuid and e.employee_code ~ '^LOAD[0-9]+$'`;
   });
   for(const table of ['person','employment','employee_statutory_my'])await witness.unsafe(`analyze public."${table}"`);
   const [count]=await witness`select count(*)::int as rows from employment e join employee_statutory_my s on s.person_id=e.person_id where e.tenant_id=${b.tenantId}::uuid and e.employee_code ~ '^LOAD[0-9]+$' and s.tax_number='TBASE'`;
   assert.equal(count.rows,ROWS);
   await witness.unsafe('CREATE SCHEMA ci_import_cohort');
   await witness.unsafe('REVOKE ALL ON SCHEMA ci_import_cohort FROM PUBLIC,ai_hr_app,ai_hr_owner');
   await witness.unsafe('CREATE TABLE ci_import_cohort.target (ordinal integer PRIMARY KEY,employee_code text UNIQUE NOT NULL,person_id uuid UNIQUE NOT NULL,employment_id uuid UNIQUE NOT NULL,statutory_id uuid UNIQUE NOT NULL)');
   await witness`insert into ci_import_cohort.target select substring(e.employee_code from 5)::int,e.employee_code,e.person_id,e.id,s.id from employment e join employee_statutory_my s on s.person_id=e.person_id where e.tenant_id=${b.tenantId}::uuid and e.employee_code ~ '^LOAD[0-9]+$'`;
   await witness.unsafe('REVOKE ALL ON ci_import_cohort.target FROM PUBLIC,ai_hr_app,ai_hr_owner');
   await witness.unsafe('GRANT USAGE ON SCHEMA ci_import_cohort TO ai_hr_owner');
   await witness.unsafe('GRANT SELECT ON ci_import_cohort.target TO ai_hr_owner');
   const targetMappingSha256=await targetMapping();
   assert.deepEqual(await systemSnapshot(),systemBaseline,'Fictional setup changed migration-owned system rows');
   save({ctx,tenantId:b.tenantId,rows:ROWS,targetMappingSha256,fingerprints:await fingerprints()});
   console.log(JSON.stringify({phase,syntheticOnly:true,rows:ROWS,targetMappingSha256}));return;
  }
  const state=JSON.parse(readFileSync(statePath,'utf8'));assert.equal(state.rows,ROWS);
  assert.equal(await targetMapping(),state.targetMappingSha256,'Immutable captured target IDs changed');
  await roles();app=(await load(join(packet,'db/client.ts'))).client;
  const api=await load(join(packet,'core/bank-import-job.ts'));
  const transport=await load(join(packet,'lib/bank-import-job.ts'));
  const bytes=()=>Buffer.from('employee_code,tax_number\n'+Array.from({length:ROWS},(_,i)=>`LOAD${i+1},TLOAD${i+1}\n`).join(''));
  const duplicate=async()=>{
   const file=bytes(),hash=createHash('sha256').update(file).digest('hex');assert.equal(hash,state.sourceHash);
   const joined=await Promise.all([1,2].map(i=>api.createBankImportJob(state.ctx,{name:`renamed-${i}.csv`,bytes:file.length,hash})));
   assert(joined.every(r=>r.existing===true&&r.job.id===state.jobId),'Same bytes must join the original active job');
   const [row]=await owner`select count(*)::int as rows from bank_import_job where tenant_id=${state.tenantId}::uuid and source_hash=${hash}`;
   assert.equal(row.rows,1);return {sameJob:true,attempts:2};
  };
  if(phase==='admit'){
   const file=bytes(),hash=createHash('sha256').update(file).digest('hex');
   const admitted=await Promise.all([1,2].map(i=>api.createBankImportJob(state.ctx,{name:`throughput-${i}.csv`,bytes:file.length,hash})));
   assert.equal(new Set(admitted.map(r=>r.job.id)).size,1);assert.equal(admitted.filter(r=>r.existing).length,1);
   const id=admitted[0].job.id;save({...state,jobId:id,sourceHash:hash,sourceBytes:file.length});
   let parts=0;
   for(let offset=0;offset<file.length;offset+=transport.BANK_IMPORT_CHUNK_BYTES){
    const chunk=file.subarray(offset,offset+transport.BANK_IMPORT_CHUNK_BYTES);
    await api.uploadBankImportChunk(state.ctx,id,parts,chunk);await api.uploadBankImportChunk(state.ctx,id,parts,chunk);
    const {job}=await api.getBankImportJob(state.ctx,id);assert.equal(job.uploadedBytes,Math.min(file.length,offset+chunk.length));parts++;
   }
   assert(parts>=2,'Must exercise real multi-part upload');
   await api.bankImportCommand(state.ctx,id,'validate');
   console.log(JSON.stringify({phase,jobId:id,rows:ROWS,sourceBytes:file.length,parts,retriedEveryPart:true,concurrentAdmissionJoined:true}));return;
  }
  if(phase==='duplicate'){
   const result=await duplicate(),{job}=await api.getBankImportJob(state.ctx,state.jobId);
   assert(['queued','validating','ready','importing'].includes(job.state));
   console.log(JSON.stringify({phase,...result,state:job.state,validated:job.validated,processed:job.processed,saved:job.saved}));return;
  }
  if(phase==='ready-confirm'){
   const {job,rows}=await api.getBankImportJob(state.ctx,state.jobId),last=await api.getBankImportJob(state.ctx,state.jobId,1000);
   assert.equal(job.state,'ready');assert.equal(job.total,ROWS);assert.equal(job.validated,ROWS);assert.equal(job.valid,ROWS);assert.equal(job.invalid,0);assert.equal(job.unchanged,0);assert.equal(job.saved,0);
   assert.equal(rows.length,100);assert.equal(rows[0].ordinal,1);assert.equal(last.rows.length,1);assert.equal(last.rows[0].ordinal,ROWS);
   const [unchanged]=await owner`select count(*)::int as rows from ci_import_cohort.target t join employee_statutory_my s on s.id=t.statutory_id and s.person_id=t.person_id where s.tax_number='TBASE'`;
   assert.equal(unchanged.rows,ROWS);assert.deepEqual(await fingerprints(),state.fingerprints);
   await duplicate();await api.bankImportCommand(state.ctx,state.jobId,'confirm');await api.bankImportCommand(state.ctx,state.jobId,'confirm');
   console.log(JSON.stringify({phase,total:ROWS,valid:ROWS,previewHrUnchanged:true,paginationVerified:true,duplicateConfirmIdempotent:true}));return;
  }
  if(phase==='arm-pause'){
   const {job}=await api.getBankImportJob(state.ctx,state.jobId);
   assert.equal(job.state,'importing');assert(job.saved>0&&job.saved%100===0);
   const ordinal=job.saved+101;assert(ordinal<ROWS);assert(/^[a-f0-9-]{36}$/.test(state.jobId));
   // A test-only latch observes the real transaction after HR/audit work, before its checkpoint.
   // Existing production triggers and native writers remain enabled and unchanged.
   await witness.unsafe('CREATE SCHEMA ci_import_throughput');
   await witness.unsafe(`CREATE FUNCTION ci_import_throughput.pause_checkpoint() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $body$
    BEGIN IF NEW.job_id='${state.jobId}'::uuid AND NEW.ordinal=${ordinal} AND OLD.state='valid' AND NEW.state='applied'
     THEN PERFORM pg_advisory_xact_lock(2147483000,100001); END IF; RETURN NEW; END $body$`);
   await witness.unsafe('CREATE TRIGGER ci_throughput_pause BEFORE UPDATE ON public.bank_import_row FOR EACH ROW EXECUTE FUNCTION ci_import_throughput.pause_checkpoint()');
   save({...state,pauseOrdinal:ordinal,pauseBaseline:job.saved});
   console.log(JSON.stringify({phase,ordinal,baselineSaved:job.saved,latch:[2147483000,100001]}));return;
  }
  if(phase==='hold-pause'){
   const connection=await witness.reserve();
   try{
    await connection`select pg_advisory_lock(2147483000,100001)`;
    console.log(JSON.stringify({phase,held:true,ordinal:state.pauseOrdinal}));
    await new Promise<void>(resolve=>{process.stdin.once('end',resolve);process.stdin.resume();});
    await connection`select pg_advisory_unlock(2147483000,100001)`;
   }finally{await connection.release();}
   return;
  }
  if(phase==='assert-paused'||phase==='assert-rollback'){
   assert(Number.isSafeInteger(state.pauseOrdinal));
   const [subject]=await witness`select s.tax_number from ci_import_cohort.target t join employee_statutory_my s on s.id=t.statutory_id and s.person_id=t.person_id where t.ordinal=${state.pauseOrdinal}`;
   const [row]=await witness`select r.state,j.saved,j.processed,j.attempt_id from bank_import_row r join bank_import_job j on j.id=r.job_id where r.job_id=${state.jobId}::uuid and r.ordinal=${state.pauseOrdinal}`;
   const [audit]=await witness`select count(*)::int as rows from import_attempt_item where attempt_id=${row.attempt_id}::uuid and ordinal=${state.pauseOrdinal}`;
   assert.equal(subject.tax_number,'TBASE');assert.equal(row.state,'valid');assert.equal(audit.rows,0);
   assert.equal(row.saved,state.pauseBaseline+100);assert.equal(row.processed,row.saved);
   console.log(JSON.stringify({phase,ordinal:state.pauseOrdinal,saved:row.saved,targetStillBaseline:true,noAuditOrCheckpointLeak:true}));return;
  }
  if(phase==='disarm-pause'){
   await witness.unsafe('DROP TRIGGER ci_throughput_pause ON public.bank_import_row');
   await witness.unsafe('DROP FUNCTION ci_import_throughput.pause_checkpoint()');
   await witness.unsafe('DROP SCHEMA ci_import_throughput');
   console.log(JSON.stringify({phase,removed:true}));return;
  }
  assert(['checkpoint','complete'].includes(phase),'Unknown phase');
  // Orchestrator calls this only after the worker process exits and its transactions/locks release.
  const proof=await owner.begin(async(tx:any)=>{
   await tx`set transaction isolation level repeatable read read only`;
   const [job]=await tx`select id,state,total,validated,valid,invalid,unchanged,processed,saved,failed,attempt_id from bank_import_job where id=${state.jobId}::uuid`;
   assert(job?.attempt_id);assert.equal(job.failed,0);assert.equal(job.invalid,0);assert.equal(job.valid,ROWS);
   const [queue]=await tx`select count(*)::int as total,count(*) filter(where state='applied')::int as applied,count(*) filter(where state='valid')::int as remaining,min(ordinal)::int as first,max(ordinal)::int as last,count(distinct ordinal)::int as distinct_ordinals from bank_import_row where job_id=${state.jobId}::uuid`;
   const [audit]=await tx`select count(*)::int as rows,count(distinct a.ordinal)::int as ordinals,count(distinct a.employment_id)::int as employees,count(*) filter(where a.status='applied' and a.item_key='row-'||a.ordinal and a.before->'fields'->>'tax_number'='TBASE' and a.after->'fields'->>'tax_number'='TLOAD'||a.ordinal and t.employment_id=a.employment_id)::int as correct from import_attempt_item a left join ci_import_cohort.target t on t.ordinal=a.ordinal where a.attempt_id=${job.attempt_id}::uuid`;
   const [values]=await tx`select count(*)::int as total,count(*) filter(where s.tax_number='TLOAD'||t.ordinal)::int as changed,count(*) filter(where s.tax_number='TBASE')::int as baseline,count(distinct s.tax_number) filter(where s.tax_number='TLOAD'||t.ordinal)::int as unique_changed from ci_import_cohort.target t join employee_statutory_my s on s.id=t.statutory_id and s.person_id=t.person_id`;
   assert.equal(job.processed,job.saved);assert(job.saved>0&&job.saved<=ROWS);
   assert.deepEqual({...queue},{total:ROWS,applied:job.saved,remaining:ROWS-job.saved,first:1,last:ROWS,distinct_ordinals:ROWS});
   for(const key of ['rows','ordinals','employees','correct'])assert.equal(audit[key],job.saved,'Audit/checkpoint mismatch: '+key);
   assert.deepEqual({...values},{total:ROWS,changed:job.saved,baseline:ROWS-job.saved,unique_changed:job.saved});
   return {job:{...job},queue:{...queue},audit:{...audit},values:{...values}};
  });
  if(phase==='complete'){
   assert.equal(proof.job.state,'completed');assert.equal(proof.job.total,ROWS);assert.equal(proof.job.validated,ROWS);assert.equal(proof.job.saved,ROWS);
   const [events]=await owner`select count(*) filter(where kind='confirmed')::int as confirmations from import_attempt_event where attempt_id=${proof.job.attempt_id}::uuid`;
   const [attempts]=await owner`select count(*)::int as rows from import_attempt where tenant_id=${state.tenantId}::uuid and kind='bank_statutory' and source_hash=${state.sourceHash}`;
   const [chunks]=await owner`select count(*)::int as rows from bank_import_chunk where job_id=${state.jobId}::uuid`;
   assert.equal(events.confirmations,1);assert.equal(attempts.rows,1);assert.equal(chunks.rows,0);
   assert.equal(await targetMapping(),state.targetMappingSha256,'Immutable captured target IDs changed');
   assert.deepEqual(await fingerprints(),state.fingerprints,'Unrelated HR facts, including complete noncohort statutory rows, changed');
   console.log(JSON.stringify({phase,...proof,confirmedEvents:1,attempts:1,sourceChunksReleased:true,unrelatedFactsUnchanged:true,targetMappingSha256:state.targetMappingSha256,targetMappingUnchanged:true}));
  }else console.log(JSON.stringify({phase,...proof,atomicCheckpointVerified:true}));
 }catch(error){primaryError=error;throw error;}finally{
  const results=await Promise.allSettled([owner.end({timeout:5}),witness.end({timeout:5}),...(app?[app.end({timeout:5})]:[]),...(harness?[harness.closeAll()]:[])]);
  for(const result of results)if(result.status==='rejected'){
   if(primaryError!==undefined)console.error('Fixture cleanup failed after original error:',result.reason);
   else throw result.reason;
  }
 }
}
main().catch(error=>{console.error('Disposable fictional throughput fixture failed:',error);process.exitCode=1;});
