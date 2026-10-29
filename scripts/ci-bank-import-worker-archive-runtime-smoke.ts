/** CI-only fictional fixture orchestration. Native worker execution is owned by the Python gate. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
async function main(){
const [phase,packetArg,sourceArg,statePath]=process.argv.slice(2);
assert(process.env.GITHUB_ACTIONS==='true'&&process.env.CI==='true'&&process.platform==='linux','Disposable GHA only');
const packet=resolve(packetArg),source=resolve(sourceArg);
const sourcePin=process.env.AIHR_ARCHIVE_SOURCE_SHA;
assert(/^[a-f0-9]{40}$/.test(sourcePin??''),'Required explicit immutable application source pin');
assert.equal(execFileSync('/usr/bin/git',['-C',source,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),sourcePin);
assert.equal(execFileSync('/usr/bin/git',['-C',source,'status','--porcelain','--untracked-files=all'],{encoding:'utf8'}),'','Clean frozen source required');
assert(!packet.startsWith(source+'/')&&!source.startsWith(packet+'/'),'Actual extracted packet must be separate');
const load=async(path:string)=>{const m=await import(pathToFileURL(path).href);return {...(m.default??{}),...m};};
const requirePacket=createRequire(join(packet,'package.json'));
const postgres=requirePacket('postgres');
const owner=postgres(process.env.MIGRATION_DATABASE_URL!,{max:1,onnotice:()=>{}});
let app:any,sourceHarness:any;
const save=(data:unknown)=>writeFileSync(statePath,JSON.stringify(data)+'\n',{mode:0o600});
try {
 if(phase==='setup'){
  app=(await load(join(packet,'db/client.ts'))).client;
  // Reuse the actual canonical minimal fixture, never production seed/demo data.
  const h=sourceHarness=await load(join(source,'test/harness.ts'));
  const b=await h.seedBase(),ctx=h.adminCtx(b);
  const importer=await load(join(packet,'core/import.ts'));
  const csv=await load(join(packet,'lib/csv.ts'));
  const records=csv.parseCsvRecords('full_name,email,department,hired_on,ic_number,basic_salary,employee_code\nCI Worker Synthetic,worker-archive@example.test,Finance,2026-01-05,900101105555,5000,ARCHIVE001').records;
  const result=await importer.commitEmployeeImport(ctx,{companyId:b.companyId,records});
  assert.equal(result.imported,1,'Canonical fictional employee setup failed');assert.equal(result.failed.length,0);
  const [employee]=await owner`select e.id,e.person_id,s.tax_number from employment e join employee_statutory_my s on s.person_id=e.person_id where e.tenant_id=${b.tenantId}::uuid and e.employee_code='ARCHIVE001'`;
  assert(employee);assert.notEqual(employee.tax_number,'TARCHIVE');
  const facts:Record<string,unknown>={};
  for(const table of ['person','employment','assignment','compensation'])facts[table]=await owner.unsafe(`select to_jsonb(t) as row from public."${table}" t order by to_jsonb(t)::text`);
  const statutory=await owner`select to_jsonb(s) as row from employee_statutory_my s order by person_id`;
  save({ctx,personId:employee.person_id,employmentId:employee.id,originalTax:employee.tax_number,facts,statutory});
  console.log(JSON.stringify({fixture:'canonical-seedBase-and-employee-import',syntheticOnly:true,employees:1}));
 }else if(phase==='snapshot'){
  const roleProof=await owner`select r.rolname,r.rolsuper,r.rolbypassrls,c.relowner=r.oid as queue_owner from pg_roles r cross join pg_class c where r.rolname in ('ai_hr_app','ai_hr_owner') and c.oid='public.bank_import_job'::regclass order by r.rolname`;
  assert.equal(roleProof.length,2);
  assert.deepEqual(roleProof.map((r:any)=>[r.rolname,r.rolsuper,r.rolbypassrls,r.queue_owner]),[['ai_hr_app',false,false,false],['ai_hr_owner',false,false,true]]);
  // Drizzle inserts in journal-array order. Qualify the numeric input: ORDER BY id would bind id::text's output alias.
  const ledger=await owner`select m.id::text as migration_id,m.hash,m.created_at::text as created_at from drizzle.__drizzle_migrations m order by m.id`;
  let priorId=0n;
  for(const row of ledger){assert(/^[1-9][0-9]*$/.test(row.migration_id)&&BigInt(row.migration_id)>priorId,'Actual ledger IDs must be positive and numerically increasing');priorId=BigInt(row.migration_id);}
  // This is a FRESH ordinary-journal DB: hash exact current SQL bytes, never staging's two historical identities.
  const journalBytes=readFileSync(join(source,'db/migrations/meta/_journal.json'));
  const journal=JSON.parse(journalBytes.toString('utf8'));
  assert(Array.isArray(journal.entries)&&journal.entries.length>0,'Nonempty ordinary source journal required');
  const tags=new Set(),indices=new Set();
  const expected=journal.entries.map((row:any)=>{assert(/^[A-Za-z0-9_-]+$/.test(row.tag)&&Number.isSafeInteger(row.when)&&row.when>0&&Number.isSafeInteger(row.idx)&&row.idx>=0&&!tags.has(row.tag)&&!indices.has(row.idx));tags.add(row.tag);indices.add(row.idx);return {hash:createHash('sha256').update(readFileSync(join(source,'db/migrations',row.tag+'.sql'))).digest('hex'),created_at:String(row.when)};});
  assert.equal(ledger.length,expected.length,'Complete fresh ordinary source migration ledger required');
  const semantic=ledger.map(({hash,created_at}:any)=>({hash,created_at}));
  assert.deepEqual(semantic,expected.map(({hash,created_at}:any)=>({hash,created_at})),'Exact ordered source SQL hashes/timestamps differ');
  // Stable JSON keys in alphabetical order, UTF-8, no whitespace or trailing newline; no IDs/timestamps from this gate.
  const semanticBytes='['+semantic.map((r:any)=>'{"created_at":'+JSON.stringify(r.created_at)+',"hash":'+JSON.stringify(r.hash)+'}').join(',')+']';
  const content=[];
  // Independent read-only witness sees FORCE-RLS tables too. This credential never reaches the worker CLI.
  const witness=postgres('postgres://postgres@127.0.0.1:5433/ai_hr_test',{max:1,onnotice:()=>{}});
  try{await witness.begin(async(tx:any)=>{
   await tx`set transaction read only`;
   const tables=await tx`select tablename from pg_tables where schemaname='public' order by tablename`;
   for(const {tablename}of tables){assert(/^[a-z_][a-z0-9_]*$/.test(tablename));const [r]=await tx.unsafe(`select count(*)::int as rows,md5(coalesce(string_agg(to_jsonb(t)::text,E'\\n' order by to_jsonb(t)::text),'')) as hash from public."${tablename}" t`);content.push({table:tablename,...r});}
  });}finally{await witness.end({timeout:5});}
  const [queue]=await owner`select count(*)::int as rows from bank_import_job`;
  console.log(JSON.stringify({roleProof,migrationLedger:{kind:'FRESH_ORDINARY_SOURCE_JOURNAL_NOT_STAGING_LEDGER',rows:ledger.length,sha256:createHash('sha256').update(semanticBytes).digest('hex'),journalSha256:createHash('sha256').update(journalBytes).digest('hex')},queueRows:queue.rows,publicTables:content}));
 }else {
  const state=JSON.parse(readFileSync(statePath,'utf8'));
  app=(await load(join(packet,'db/client.ts'))).client;
  const jobApi=await load(join(packet,'core/bank-import-job.ts'));
  if(phase==='admit'){
   const bytes=Buffer.from('employee_code,tax_number\nARCHIVE001,TARCHIVE\nMISSING-CI-SUBJECT,TINVALID');
   const admitted=await jobApi.createBankImportJob(state.ctx,{name:'fictional-archive.csv',bytes:bytes.length,hash:createHash('sha256').update(bytes).digest('hex')});
   await jobApi.uploadBankImportChunk(state.ctx,admitted.job.id,0,bytes);await jobApi.bankImportCommand(state.ctx,admitted.job.id,'validate');
   save({...state,jobId:admitted.job.id});console.log(JSON.stringify({state:'queued',rows:2}));
  }else {
   const {job}=await jobApi.getBankImportJob(state.ctx,state.jobId);
   const [subject]=await owner`select tax_number from employee_statutory_my where person_id=${state.personId}::uuid`;
   if(phase==='preview'){
    assert.equal(job.state,'ready');assert.equal(job.total,2);assert.equal(job.valid,1);assert.equal(job.invalid,1);assert.equal(job.saved,0);
    assert.equal(subject.tax_number,state.originalTax,'Preview must not mutate HR facts');
    await jobApi.bankImportCommand(state.ctx,state.jobId,'confirm');console.log(JSON.stringify({previewVerified:true,valid:1,invalid:1,hrUnchanged:true,confirmed:true}));
   }else if(phase==='assert-completed'){
    assert.equal(job.state,'completed');assert.equal(job.total,2);assert.equal(job.processed,2);assert.equal(job.saved,1);assert.equal(job.failed,0);assert.equal(job.invalid,1);
    assert.equal(subject.tax_number,'TARCHIVE');assert(job.attemptId);
    const [audit]=await owner`select count(*)::int as rows from import_attempt_item where attempt_id=${job.attemptId}::uuid`;
    assert.equal(audit.rows,1,'Exactly one native canonical HR-save audit item required');
    const auditOrdinals=await owner`select ordinal,status,employment_id from import_attempt_item where attempt_id=${job.attemptId}::uuid order by ordinal`;
    assert.equal(auditOrdinals.length,1);assert.equal(auditOrdinals[0].ordinal,1);assert.equal(auditOrdinals[0].status,'applied');assert.equal(auditOrdinals[0].employment_id,state.employmentId);
    const checkpoints=await owner`select ordinal,state from bank_import_row where job_id=${state.jobId}::uuid order by ordinal`;
    assert.deepEqual(checkpoints.map((row:any)=>({ordinal:row.ordinal,state:row.state})),[{ordinal:1,state:'applied'},{ordinal:2,state:'invalid'}],'Native row checkpoint must match actual audit and invalid row');
    const [chunks]=await owner`select count(*)::int as rows from bank_import_chunk where job_id=${state.jobId}::uuid`;assert.equal(chunks.rows,0);
    for(const table of ['person','employment','assignment','compensation'])assert.deepEqual(JSON.parse(JSON.stringify(await owner.unsafe(`select to_jsonb(t) as row from public."${table}" t order by to_jsonb(t)::text`))),state.facts[table],'Unrelated HR facts changed: '+table);
    const statutory=await owner`select to_jsonb(s) as row from employee_statutory_my s order by person_id`;
    const normalized=(rows:any[])=>rows.map(({row})=>{const copy={...row};delete copy.updated_at;if(copy.person_id===state.personId)copy.tax_number='EXPECTED-TARGET';return copy;});
    assert.deepEqual(normalized(statutory),normalized(state.statutory),'Unexpected statutory subject/field changed');
    console.log(JSON.stringify({completed:true,total:2,processed:2,saved:1,invalid:1,failed:0,nativeAuditItems:1,nativeAuditOrdinals:[1],nativeCheckpoint:checkpoints.map((row:any)=>({ordinal:row.ordinal,state:row.state})),sourceChunksReleased:true}));
   }else throw Error('Unknown CI fixture phase');
  }
 }
}finally{
 const closers=[owner.end({timeout:5}),...(app?[app.end({timeout:5})]:[]),...(sourceHarness?[sourceHarness.closeAll()]:[])];
 const closed=await Promise.allSettled(closers);
 const failed=closed.find(result=>result.status==='rejected');
 if(failed?.status==='rejected')throw failed.reason;
}
}
main().catch(error=>{console.error('CI-only fictional archived worker fixture failed:',error);process.exitCode=1;});
