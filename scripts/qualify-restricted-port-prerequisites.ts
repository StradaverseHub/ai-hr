/** Fixed disposable-only pre/post-migration qualifier. NEVER imported by production or normal setup.
 * Executes reviewed SQL files verbatim. Populated direct-owner fixture is NOT crypto/native proof. */
import {createHash} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {isAbsolute,join,relative,resolve} from 'node:path';
import postgres from 'postgres';
import {drizzle} from 'drizzle-orm/postgres-js';
import {migrate} from 'drizzle-orm/postgres-js/migrator';
import {assertQualificationEnvironment,assertPrefix,assertAppliedLedger,FIXTURE_DIRECTORY,type LedgerRow} from './lib/restricted-port-qualification';
import {appliedMigrationExecution} from '../.github/ci/restricted-port-history.mjs';
const digest=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex');
const fail=(s:string):never=>{throw Error(s);};
async function main(){
const root=realpathSync(process.cwd()),fixture=join(root,FIXTURE_DIRECTORY),env=process.env;
const mode=process.argv[2];if(process.argv.length!==4||!['before','after'].includes(mode))fail('Fixed qualifier before|after evidence-directory only');
const evidence=resolve(process.argv[3]),temp=realpathSync(env.RUNNER_TEMP??'');
if(!isAbsolute(evidence)||evidence!==realpathSync(evidence)||relative(temp,evidence)!=='aihr-focused')fail('Owned qualification evidence directory required');
assertQualificationEnvironment(env,execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),process.platform);
const manifests=JSON.parse(readFileSync(join(fixture,'qualification-source-manifest.json'),'utf8')) as {files:Record<string,string>;v4ManifestSha256:string;baselineSha256:string};
if(digest(readFileSync(join(fixture,'operator-v4-manifest.json')))!==manifests.v4ManifestSha256)fail('OperatorV4 bytes differ');
if(manifests.v4ManifestSha256!=='1ccb3cec76a769043595fd4e4725616937a9d765c3eb76695903cc573ffb4e2b')fail('Unreviewed operatorV4 manifest');
function verifyFiles(){
 for(const [path,expected]of Object.entries(manifests.files)){
  if(!/^[a-zA-Z0-9_./-]+$/.test(path)||path.split('/').some(p=>!p||p==='..'||p==='.')||!(/^scripts\//.test(path)||['.github/ci/restricted-port-history.mjs','.github/ci/migration-history.mjs','.github/ci/historical-migrations/0180_profile_option.sql','.github/ci/historical-migrations/0212_dashboard_card_config.sql'].includes(path)))fail('Invalid fixed source manifest path');
  const target=join(root,path);if(realpathSync(target)!==target)fail('Symlinked qualification source');
  const tracked=execFileSync('git',['ls-files','--stage','--',path],{encoding:'utf8'}).trim();
  if(!/^(100644|100755) [0-9a-f]{40} 0\t/.test(tracked)||digest(readFileSync(target))!==expected)fail('Qualification source hash/tracking mismatch');
 }
}
verifyFiles();
const expected=JSON.parse(readFileSync(join(fixture,'installed-ledger-581.json'),'utf8')) as LedgerRow[];
if(digest(readFileSync(join(fixture,'installed-ledger-581.json')))!==manifests.baselineSha256)fail('Unreviewed baseline artifact');
const container=`aihr-ci-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}-db-1`;
const inspect=JSON.parse(execFileSync('docker',['inspect',container],{encoding:'utf8'}))[0];
if(inspect.Config.Labels?.['aihr-owner']!==container||inspect.HostConfig.Memory!==2113929216||inspect.HostConfig.MemorySwap!==2113929216||inspect.HostConfig.NetworkMode!=='host'
 ||inspect.Config.Image!=='postgres:16@sha256:9e2cf6287f25c3151f4c9421ccce2b17f3e60061c111a29165e0d2cdd9ff0a97')fail('Wrong owned standard-capacity cluster');
const connection=postgres('postgres://postgres@127.0.0.1:5433/ai_hr_dev',{max:1,connect_timeout:5,onnotice:()=>{}});
const log:string[]=[];const stages:Record<string,unknown>[]=[];
function psql(file:string,user:'postgres'|'ai_hr_owner'|'ai_hr_app'='postgres',vars:Record<string,string>={}){
 verifyFiles();if(!Object.hasOwn(manifests.files,FIXTURE_DIRECTORY+'/'+file))fail('Unpinned qualification SQL');
 const args=['exec',container,'psql','-X','-q','-A','-t','-F','\t','-h','127.0.0.1','-p','5433','-U',user,'-d','ai_hr_dev','-v','ON_ERROR_STOP=1'];
 // Exact original files include local siblings: supply a read-only candidate directory to psql stdin
 // via docker exec -i is insufficient for \ir. Copy exact pinned fixtures into owned container /tmp.
 for(const [key,value]of Object.entries(vars)){if(!/^(expected_catalog_sha|receipt_child_created)$/.test(key)||!(/^[a-f0-9]{64}$/.test(value)||key==='receipt_child_created'&&value==='true'))fail('Invalid psql literal');args.push('-v',key+'='+value);}
 args.push('-f','/tmp/aihr-operator-v4/'+file);
 const r=spawnSync('docker',args,{encoding:'utf8',maxBuffer:8*1024*1024,timeout:120000});
 log.push(`FILE ${file} LOGIN ${user}\n${r.stdout??''}${r.stderr??''}`);
 if(r.error||r.signal||r.status!==0)fail('Pinned qualification SQL failed: '+file);
 return r.stdout;
}
async function catalog(){const text=psql('snapshot.sql'),line=text.split('\n').find(x=>/^[a-f0-9]{64}\t/.test(x));if(!line)fail('Missing actual catalog receipt');const split=line!.indexOf('\t');return{sha:line!.slice(0,split),catalog:JSON.parse(line!.slice(split+1))};}
async function assertChildAbsent(){const rows=await connection`select 1 from pg_roles where rolname='ai_hr_draft_discard_port'`;if(rows.length)fail('Child must genuinely be absent');}
async function ledger(){return Array.from(await connection<LedgerRow[]>`select id::text,hash,created_at::text from drizzle.__drizzle_migrations order by id`);}
async function fixtureData(){const [r]=await connection`select jsonb_build_object(
 'draft',(select to_jsonb(d) from employee_draft d where d.id='8a000000-0000-4000-8000-000000000006'),
 'review',(select to_jsonb(r) from app.assistant_own_leave_review r where r.id='8a000000-0000-4000-8000-000000000007'),
 'body',(select to_jsonb(c) from app.assistant_own_leave_review_content c where c.action_id='8a000000-0000-4000-8000-000000000007')) as value`;if(!r.value?.draft||!r.value?.review||!r.value?.body)fail('Nonempty populated fixture required');return r.value;}
async function ownership(){const [r]=await connection`select jsonb_build_object('schema',(select jsonb_build_array(nspowner,nspacl) from pg_namespace where nspname='app'),'tables',(select jsonb_agg(jsonb_build_array(c.oid,c.relowner,c.relacl,c.relrowsecurity,c.relforcerowsecurity) order by c.oid) from pg_class c where c.oid in('employee_draft'::regclass,'app.assistant_own_leave_review'::regclass,'app.assistant_own_leave_review_content'::regclass)),'columns',(select jsonb_agg(jsonb_build_array(a.attrelid,a.attnum,a.attacl) order by a.attrelid,a.attnum) from pg_attribute a where a.attrelid in('employee_draft'::regclass,'app.assistant_own_leave_review'::regclass,'app.assistant_own_leave_review_content'::regclass) and a.attnum>0 and not a.attisdropped)) value`;return r.value;}
const canonical=(v:unknown):unknown=>v&&typeof v==='object'?Array.isArray(v)?v.map(canonical):Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical((v as Record<string,unknown>)[k])])):v;
const same=(a:unknown,b:unknown,message:string)=>{if(JSON.stringify(a)!==JSON.stringify(b))fail(message);};
async function installContainerFiles(){
 // Fixed tracked fixture directory only; no external executable or arbitrary path option.
 const r=spawnSync('docker',['cp',fixture+'/.',container+':/tmp/aihr-operator-v4'],{encoding:'utf8',timeout:30000});if(r.status!==0||r.error)fail('Could not stage pinned SQL in owned container');
 // Verify copied bytes inside container independently of candidate filesystem hashes.
 for(const [path,hash]of Object.entries(manifests.files).filter(([p])=>p.startsWith(FIXTURE_DIRECTORY+'/')&&p.endsWith('.sql'))){const name=path.slice(FIXTURE_DIRECTORY.length+1);const got=execFileSync('docker',['exec',container,'sha256sum','/tmp/aihr-operator-v4/'+name],{encoding:'utf8'}).split(/\s/)[0];if(got!==hash)fail('Container SQL bytes differ');}
}
try{
 await installContainerFiles();
 if(mode==='before'){
  await assertChildAbsent();const [empty]=await connection`select to_regclass('drizzle.__drizzle_migrations') is null as clear`;if(!empty.clear)fail('Initial development DB is not fresh');
  const roles=await connection`select rolname from pg_roles where rolname='ai_hr_owner'`;if(roles.length)fail('Restricted fixture owner already exists');
  const journal=JSON.parse(readFileSync('db/migrations/meta/_journal.json','utf8'));const prefix=journal.entries.slice(0,581);
  if(prefix.length!==581)fail('Missing canonical prefix');
  const executionPrefix=prefix.map((e:{tag:string;when:number})=>appliedMigrationExecution(e.tag,e.when,readFileSync('db/migrations/'+e.tag+'.sql')));
  const sourcePrefix=prefix.map((e:{tag:string;when:number},i:number)=>({hash:executionPrefix[i].identity.hash,created_at:String(e.when)}));assertPrefix(expected,expected);assertAppliedLedger(sourcePrefix,expected);
  const directory=mkdtempSync(join(temp,'aihr-port-prefix-'));mkdirSync(join(directory,'meta'));
  for(const [i,e]of prefix.entries())writeFileSync(join(directory,e.tag+'.sql'),executionPrefix[i].sql);
  writeFileSync(join(directory,'meta/_journal.json'),JSON.stringify({...journal,entries:prefix}));
  await migrate(drizzle(connection),{migrationsFolder:directory});assertPrefix(expected,await ledger());
  const native=readFileSync('db/migrations/0859_assistant_employee_draft_discard_custody.sql','utf8');const original=JSON.parse(readFileSync(join(fixture,'source-hashes.json'),'utf8'));
  for(const [label,key]of [['preflight','preflightSHA256'],['transfer','transferSHA256']] as const){const marker='$'+label+'$';const begin=native.indexOf('DO '+marker),end=native.indexOf('END '+marker+';',begin);if(begin<0||end<0||digest(native.slice(begin,end+('END '+marker+';').length))!==original[key])fail('Reviewed domain transfer/preflight source drift');}
  psql('populate-baseline.sql');const populated=await fixtureData();
  const originalOwner=await ownership();
  const [ownerCheck]=await connection`select (select nspowner from pg_namespace where nspname='app')=(select oid from pg_roles where rolname='postgres') and not exists(select 1 from pg_class where oid in('employee_draft'::regclass,'app.assistant_own_leave_review'::regclass,'app.assistant_own_leave_review_content'::regclass) and relowner<>(select oid from pg_roles where rolname='postgres')) as allowed`;if(!ownerCheck.allowed)fail('Unexpected baseline ownership; do not reassign');
  await connection.unsafe('CREATE ROLE ai_hr_owner LOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION');
  let projected=false;
  try{
   await connection.begin(async tx=>{await tx.unsafe('ALTER SCHEMA app OWNER TO ai_hr_owner');for(const table of ['public.employee_draft','app.assistant_own_leave_review','app.assistant_own_leave_review_content'])await tx.unsafe('ALTER TABLE '+table+' OWNER TO ai_hr_owner');});projected=true;
   const initial=await catalog();psql('prepare-rehearse.sql','postgres',{expected_catalog_sha:initial.sha});await assertChildAbsent();same(initial,await catalog(),'Rehearsal changed full catalog');same(populated,await fixtureData(),'Rehearsal changed populated data');stages.push({name:'fresh_child_rehearsal',passed:true,catalog:initial});
   const creationOutput=psql('prepare-commit.sql','postgres',{expected_catalog_sha:initial.sha});if(!creationOutput.split('\n').includes('true'))fail('Missing actual created-child receipt');
   const prepared=await catalog();const reusedOutput=psql('prepare-commit.sql','postgres',{expected_catalog_sha:prepared.sha});if(!reusedOutput.split('\n').includes('false'))fail('Missing actual reused-child receipt');same(prepared,await catalog(),'Second preparation not idempotent');stages.push({name:'created_child_and_exact_idempotent_reuse',passed:true});
   psql('hosted-column-acl-fixtures.sql');stages.push({name:'actual_hostile_acl_attribute_and_idempotence_fixtures',passed:true});same(prepared,await catalog(),'Hostile rollback changed catalog');same(populated,await fixtureData(),'Hostile rollback changed data');
   psql('restricted-owner-rehearsal.sql','ai_hr_owner');same(prepared,await catalog(),'Restricted rehearsal changed full catalog');same(populated,await fixtureData(),'Restricted rehearsal changed data');
   psql('app-before.sql','ai_hr_app');stages.push({name:'actual_restricted_and_app_logins',passed:true,catalog:prepared,scope:'preflight/transfer mechanics; no native or crypto proof'});
   psql('rollback-preparation.sql','postgres',{expected_catalog_sha:prepared.sha,receipt_child_created:'true'});await assertChildAbsent();same(initial,await catalog(),'Exact preparation rollback changed original catalog');
   psql('prepare-commit.sql','postgres',{expected_catalog_sha:initial.sha});stages.push({name:'rollback_and_fresh_reprepare',passed:true,catalog:await catalog()});
  }finally{
   if(projected){await connection.begin(async tx=>{for(const table of ['public.employee_draft','app.assistant_own_leave_review','app.assistant_own_leave_review_content'])await tx.unsafe('ALTER TABLE '+table+' OWNER TO postgres');await tx.unsafe('ALTER SCHEMA app OWNER TO postgres');});same(originalOwner,await ownership(),'Bounded ownership projection not exactly restored');}
  }
  assertPrefix(expected,await ledger());same(populated,await fixtureData(),'Qualification changed populated581 data');
  writeFileSync(join(evidence,'restricted-port-before.json'),JSON.stringify({kind:'DISPOSABLE_PREMIGRATION_ROLE_QUALIFICATION',candidate:env.AIHR_CI_HEAD,controller:env.AIHR_CI_CONTROL_HEAD,runId:env.GITHUB_RUN_ID,attempt:env.GITHUB_RUN_ATTEMPT,container,baseline:expected,disposableBaseline:await ledger(),ledgerComparison:'exact ordered authenticated hash/timestamp; positive increasing physical IDs validated independently, never rewritten',historicalAppliedVersions:executionPrefix.map((entry:ReturnType<typeof appliedMigrationExecution>,i:number)=>({tag:prefix[i].tag,...entry.identity})).filter((entry:{historicalAppliedVersion?:unknown})=>entry.historicalAppliedVersion),stages,ownershipProjection:'three protected relations and app schema; restored before tail',fixtureDataHash:digest(JSON.stringify(canonical(populated))),fixtureColumns:Object.fromEntries(Object.entries(populated).map(([key,value])=>[key,Object.keys(value as object)])),nativeProof:false,cryptoProof:false,sourceManifestSha256:digest(readFileSync(join(fixture,'qualification-source-manifest.json')))},null,2)+'\n',{flag:'wx'});
 }else{
  const previous=JSON.parse(readFileSync(join(evidence,'restricted-port-before.json'),'utf8'));if(previous.candidate!==env.AIHR_CI_HEAD||previous.controller!==env.AIHR_CI_CONTROL_HEAD||previous.runId!==env.GITHUB_RUN_ID||previous.attempt!==env.GITHUB_RUN_ATTEMPT||previous.container!==container)fail('Pre-migration receipt identity mismatch');
  const actual=await ledger();assertPrefix(expected,actual.slice(0,581));if(actual.length<=581)fail('No actual candidate tail installed');
  const allJournal=JSON.parse(readFileSync('db/migrations/meta/_journal.json','utf8'));const fullExpected=allJournal.entries.map((e:{tag:string;when:number})=>({hash:appliedMigrationExecution(e.tag,e.when,readFileSync('db/migrations/'+e.tag+'.sql')).identity.hash,created_at:String(e.when)}));assertAppliedLedger(fullExpected,actual);
  const[installed]=await connection`select exists(select 1 from app.assistant_action_kind where id='employees.draft.discard') and (select count(*)=2 from pg_proc where oid in(to_regprocedure('app._draft_discard_source_snapshot(uuid,uuid)'),to_regprocedure('app.native_employee_draft_discard_delete(uuid)')) and proowner=(select oid from pg_roles where rolname='ai_hr_draft_discard_port')) as ok`;if(!installed.ok)fail('Actual0859 registration/function ownership missing');
  psql('app-after.sql','ai_hr_app');const currentData=await fixtureData();const retained=Object.fromEntries(Object.entries(previous.fixtureColumns as Record<string,string[]>).map(([key,keys])=>[key,Object.fromEntries(keys.map(field=>[field,currentData[key][field]]))]));if(digest(JSON.stringify(canonical(retained)))!==previous.fixtureDataHash)fail('Populated baseline values changed during candidate tail');
  writeFileSync(join(evidence,'restricted-port-after.json'),JSON.stringify({kind:'ACTUAL_INSTALLED_PRIVATE_APP_DENIAL',candidate:env.AIHR_CI_HEAD,controller:env.AIHR_CI_CONTROL_HEAD,passed:true,actualCandidateLedger:actual,expectedAppliedIdentities:fullExpected.map(({hash,created_at}:{hash:string;created_at:string})=>({hash,created_at})),scope:'actual app login private42501 and SET denial only; no native business call'},null,2)+'\n',{flag:'wx'});
 }
}finally{
 writeFileSync(join(evidence,'restricted-port-'+mode+'.psql.log'),log.join('\n'),{flag:'wx'});await connection.end({timeout:5});
}
}
void main().catch((error:unknown)=>{console.error(error);process.exitCode=1;});
