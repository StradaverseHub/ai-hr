/** Hosted disposable builder only. It never provisions roles or runs against an installation. */
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {randomInt,randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import postgres from 'postgres';
import {drizzle} from 'drizzle-orm/postgres-js';
import {migrate} from 'drizzle-orm/postgres-js/migrator';
import {seedCatalogs} from '../../scripts/seed-catalogs';
import {assertDraftDiscardRehearsalContext,isDraftDiscardFixtureDatabasePath,readDraftDiscardRoleCatalog,assertDraftDiscardRoleCatalog} from './personnel-draft-discard-ci-role-fixture';
import {PROJECT_INSTALLED_OWNERSHIP} from './installed-owner-projection';

export type RestrictedPostingRuntimeReceipt={version:1;sessionUser:'ai_hr_owner';currentUser:'ai_hr_owner';superuser:false;bypassRls:false;postingStatus:'approved';applicationState:'applied';preservedPayslips:number;queueBackendMatchesReceipt:true};
const RESULT='CONTRACT_RESTRICTED_OWNER_RESULT ';
const REFUSAL='Restricted Contract runtime requires the existing admitted hosted disposable fixture.';
const packet=['6001_contract_posting_protected_job_foundation','6002_contract_posting_recorded_replay_frames','6003_contract_posting_prepared_target_source','6004_contract_posting_bound_target_completion','6005_contract_posting_finish_and_commit_guard','6006_contract_posting_first_producer_readiness','6007_contract_posting_admission_and_status_ports','6008_contract_posting_application_metadata','6009_contract_posting_reconciliation_and_authority'];
function connectionAt(base:string,database:string,user:string){
 const url=new URL(base);url.pathname='/'+database;url.username=user;url.password='';return url.toString();
}
async function child(phase:'prepare'|'apply',database:string,nonce:string,folder:string,base:string){
 const env:NodeJS.ProcessEnv={...process.env,NODE_ENV:'test',WORKER_DB:'0',TEST_DB_NAMESPACE:'aifocus',
  CONTRACT_POSTING_OWNER_RUNTIME_PHASE:phase,CONTRACT_POSTING_OWNER_RUNTIME_DATABASE:database,CONTRACT_POSTING_OWNER_RUNTIME_NONCE:nonce,
  CONTRACT_POSTING_OWNER_RUNTIME_FOLDER:folder,
  TEST_DATABASE_URL:connectionAt(base,database,'ai_hr_app'),DATABASE_URL:connectionAt(base,database,'ai_hr_app'),
  TEST_MIGRATION_DATABASE_URL:connectionAt(base,database,phase==='apply'?'ai_hr_owner':'postgres'),
  MIGRATION_DATABASE_URL:connectionAt(base,database,phase==='apply'?'ai_hr_owner':'postgres')};
 delete env.VITEST_POOL_ID;delete env.VITEST_WORKER_ID;
 const output=await new Promise<string>((resolveChild,reject)=>{
  const processChild=spawn(process.execPath,['--conditions=react-server','--import','tsx','test/helpers/contract-posting-restricted-owner-runtime-child.ts'],{cwd:process.cwd(),env,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';const timer=setTimeout(()=>{processChild.kill('SIGKILL');reject(Error('Restricted Contract runtime child exceeded its bounded fixture budget.'));},300_000);
  processChild.stdout.on('data',chunk=>{stdout+=String(chunk);if(stdout.length>8*1024*1024)processChild.kill('SIGKILL');});
  processChild.stderr.on('data',chunk=>{stderr+=String(chunk);if(stderr.length>8*1024*1024)processChild.kill('SIGKILL');});
  processChild.once('error',error=>{clearTimeout(timer);reject(error);});
  processChild.once('exit',(code,signal)=>{clearTimeout(timer);if(code!==0||signal){
   // Keep the full safe fixture timeline available in hosted test logs even when the error tail is bounded.
   for(const line of stderr.split('\n'))if(line.startsWith('CONTRACT_POSTING_TEMPORAL_DIAGNOSTICS '))console.error(line);
   reject(Error(`Restricted Contract ${phase} fixture failed: ${stderr.slice(-8000)}`));
  }else resolveChild(stdout);});
 });
 const lines=output.split('\n').filter(line=>line.startsWith(RESULT));assert.equal(lines.length,1,'exactly one child outcome');
 return JSON.parse(lines[0].slice(RESULT.length)) as RestrictedPostingRuntimeReceipt|{prepared:true};
}

/** The canonical role-admission owner validates CI/controller/source/cluster before any connection. */
export async function runRestrictedContractPostingRuntime():Promise<RestrictedPostingRuntimeReceipt>{
 const migration=process.env.TEST_MIGRATION_DATABASE_URL;if(!migration)throw Error(REFUSAL);
 const base=new URL(migration);base.pathname='/postgres';
 assertDraftDiscardRehearsalContext(base.toString());
 if(base.hostname!=='127.0.0.1'||base.port!=='5433'||base.username!=='postgres'||base.password||base.search||base.hash)throw Error(REFUSAL);
 const journal=JSON.parse(readFileSync('db/migrations/meta/_journal.json','utf8')) as {entries:{tag:string;when:number}[]};
 const shared=journal.entries.findIndex(entry=>/^6000_/.test(entry.tag));
 if(shared<0||packet.some((tag,index)=>journal.entries[shared+index+1]?.tag!==tag))throw Error('The complete reviewed6000–6009 packet must be registered in the normal journal before this fixture runs.');
 const candidate=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
 if(candidate!==process.env.AIHR_CI_HEAD)throw Error(REFUSAL);
 const temp=process.env.RUNNER_TEMP;if(!temp||realpathSync(temp)!==resolve(temp))throw Error(REFUSAL);
 const folder=mkdtempSync(join(temp,'aihr-contract-owner-runtime-'));
 const database='ai_hr_test_w_aifocus'+Date.now()+String(randomInt(1_000_000)).padStart(6,'0');
 if(!isDraftDiscardFixtureDatabasePath('/'+database)||!/^ai_hr_test_w_aifocus[1-9][0-9]*$/.test(database))throw Error(REFUSAL);
 const nonce=randomUUID(),marker='aihr-contract-owner-runtime:'+nonce;
 const admin=postgres(base.toString(),{max:1,onnotice:()=>{}});let created=false;let builder:postgres.Sql|undefined;
 try{
  const[identity]=await admin<{session:string;current:string;super:boolean;version:number}[]>`select session_user::text as session,current_user::text as current,(select rolsuper from pg_roles where rolname=current_user) as super,current_setting('server_version_num')::int as version`;
  assert.equal(identity.session,'postgres');assert.equal(identity.current,'postgres');assert.equal(identity.super,true);assert.ok(identity.version>=160000);
  assertDraftDiscardRoleCatalog(await readDraftDiscardRoleCatalog(admin));
  // No IF NOT EXISTS, no role creation/alteration, and no pre-existing database can be replaced.
  await admin.unsafe(`CREATE DATABASE "${database}"`);created=true;
  await admin.unsafe(`COMMENT ON DATABASE "${database}" IS '${marker}'`);
  builder=postgres(connectionAt(base.toString(),database,'postgres'),{max:1,onnotice:()=>{}});
  await builder.unsafe(`GRANT USAGE ON SCHEMA public TO ai_hr_app;
   ALTER DEFAULT PRIVILEGES FOR ROLE ai_hr_owner IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO ai_hr_app;
   ALTER DEFAULT PRIVILEGES FOR ROLE ai_hr_owner IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO ai_hr_app;
   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO ai_hr_app;
   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO ai_hr_app;
   DO $platform$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ai_hr_platform') THEN GRANT USAGE ON SCHEMA public TO ai_hr_platform;END IF;END $platform$;`);
  await migrate(drizzle(builder),{migrationsFolder:'db/migrations'});
  await seedCatalogs(drizzle(builder));
  await builder.unsafe(`CREATE TABLE app._test_contract_posting_owner_runtime_binding(nonce uuid PRIMARY KEY,candidate text NOT NULL,database_name text NOT NULL);
   REVOKE ALL ON app._test_contract_posting_owner_runtime_binding FROM PUBLIC,ai_hr_app;`);
  await builder`insert into app._test_contract_posting_owner_runtime_binding(nonce,candidate,database_name) values(${nonce}::uuid,${candidate},${database})`;
  await admin.unsafe(`GRANT CONNECT ON DATABASE "${database}" TO ai_hr_app,ai_hr_owner`);
  writeFileSync(join(folder,'binding.json'),JSON.stringify({version:1,database,nonce,candidate,runId:process.env.GITHUB_RUN_ID,attempt:process.env.GITHUB_RUN_ATTEMPT}),{mode:0o600,flag:'wx'});
  assert.deepEqual(await child('prepare',database,nonce,folder,base.toString()),{prepared:true});
  // The exact existing ownership fixture, not new runtime grants or a SET ROLE impersonation.
  await admin.unsafe(`ALTER DATABASE "${database}" OWNER TO ai_hr_owner`);
  await builder.unsafe(PROJECT_INSTALLED_OWNERSHIP);
  await builder.unsafe(readFileSync('deploy/runner-control/rewards-deletion-role-prerequisite.sql','utf8'));
  const[owned]=await builder<{database_owner:string;schema_owner:string;posting_owner:string}[]>`select (select pg_get_userbyid(datdba) from pg_database where datname=current_database()) as database_owner,(select pg_get_userbyid(nspowner) from pg_namespace where nspname='app') as schema_owner,(select pg_get_userbyid(proowner) from pg_proc where oid='app.contract_posting_job_finish(uuid,uuid,boolean)'::regprocedure) as posting_owner`;
  assert.deepEqual({...owned},{database_owner:'ai_hr_owner',schema_owner:'ai_hr_owner',posting_owner:'ai_hr_owner'});
  await builder.end({timeout:5});builder=undefined;
  const result=await child('apply',database,nonce,folder,base.toString());
  assert.ok('sessionUser' in result);assert.equal(result.sessionUser,'ai_hr_owner');assert.equal(result.currentUser,'ai_hr_owner');assert.equal(result.superuser,false);assert.equal(result.bypassRls,false);
  return result;
 }finally{
  if(builder)await builder.end({timeout:5});
  try{if(created){
   const[row]=await admin<{marker:string|null}[]>`select shobj_description(oid,'pg_database') as marker from pg_database where datname=${database}`;
   if(row?.marker!==marker)throw Error('Disposable runtime database ownership marker changed; refusing cleanup.');
   await admin.unsafe(`DROP DATABASE "${database}" WITH (FORCE)`);
  }}finally{await admin.end({timeout:5});rmSync(folder,{recursive:true,force:true});}
 }
}
