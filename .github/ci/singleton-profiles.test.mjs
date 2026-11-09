import test from 'node:test';
import {realpathSync} from 'node:fs';
import assert from 'node:assert/strict';
import {readFileSync,lstatSync,readdirSync,mkdtempSync,mkdirSync,writeFileSync,rmSync,rmdirSync,unlinkSync,symlinkSync,copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPlan} from './plan.mjs';
import {createHash} from 'node:crypto';
import {spawnSync,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildUnits,requiredEvidence,CI_EXECUTION} from './manifest.mjs';
import {verifyReports,verifyUnitReport} from './verify-shards.mjs';
import {readUnitReportDirectories,readWorkloadDatabaseArtifact} from './unit-report-directories.mjs';
import {selectCommissioning,summarizeCommissioning} from './singleton-commissioning.mjs';
import {SINGLETON_FILES,assertNativeBuildMatches,nativeNextUnit,singletonJobName,singletonDescriptor,singletonKind,singletonSources,singletonSourceMaximum,protocolHash,assertSingletonSourceHashes,validateSingletonBinding,validateSingletonHost,validateSingletonDatabaseUrls,assertNoSingletonHints,assertSingletonCoverage,assertSingletonSelection} from './singleton-protocol.mjs';
import {NATIVE_WORKLOAD_DATABASE_CASE,NATIVE_WORKLOAD_DATABASE_FILE,NATIVE_WORKLOAD_DATABASE_HBA,NATIVE_WORKLOAD_DATABASE_MEMBER,NATIVE_WORKLOAD_DATABASE_SETTINGS,NATIVE_WORKLOAD_OBSERVER,
 NATIVE_WORKLOAD_OBSERVER_URL,nativeWorkloadDatabaseUnit,validateNativeWorkloadDatabaseUrls,validateNativeWorkloadObserverUrl} from './singleton-protocol.mjs';
import {prepareNativeWorkloadPostgres} from './native-workload-postgres.mjs';
import {requiredHostedSingletons} from '../../scripts/gate-singleton-scope.mjs';
const candidateRoot=realpathSync(fileURLToPath(new URL('../../',import.meta.url)));
const journalPath='db/migrations/meta/_journal.json';
const journalHash=createHash('sha256').update(readFileSync(new URL('../../'+journalPath,import.meta.url))).digest('hex');
const browser=['test/fictional.browser.test.tsx'];
function fixture(file='test/runtime-ready-admission-native.test.ts'){
 const kind=singletonKind(singletonDescriptor(file).profile),units=buildUnits([file],{db:kind==='db'?[file]:[],nodb:kind==='nodb'?[file]:[]},browser),unit=units[0];
 const body={schemaVersion:2,policyVersion:'aihr-staging-ci/v21',sha:'a'.repeat(40),controller:'b'.repeat(40),migrationBase:'d'.repeat(40),runtime:{node:'22.23.3',platform:'linux',arch:'x64'},execution:CI_EXECUTION,suite:[file],units,
  singletonSources:{[unit.id]:Object.fromEntries(singletonSources(unit,candidateRoot).map(path=>[path,path===journalPath?journalHash:'c'.repeat(64)]))}};
 const plan={...body,fingerprint:protocolHash(body)},witness={runId:123,attempt:1};
 const prerequisites=kind==='db'?{kind:'fresh-job-postgres-cluster',workers:1,database:{schemaVersion:2,profileVersion:2,configuredCapBytes:2113929216,peakBudgetBytes:2147483648,errors:{},memoryLimit:2113929216,memorySwap:2113929216,memoryMax:2113929216,memorySwapMax:0,memoryPeak:1500000000,memoryEvents:{max:0,oom:0,oom_kill:0},state:{Running:true,OOMKilled:false,Dead:false},settings:{jit:'on',jitAvailable:true,serverVersionNum:'160015'},name:`aihr-ci-123-1-${unit.id}`}}:
  {kind:'actual-job-systemd-nginx',platform:'linux',pid1:'systemd',sudoUid:'0',nginxPath:'/usr/sbin/nginx',nginxSha256:'e'.repeat(64),nginxVersion:'nginx version: nginx/1.24.0',systemdVersion:'systemd 255'};
 const binding={schemaVersion:1,mode:'full-ci-singleton',candidate:plan.sha,controller:plan.controller,runId:'123',attempt:'1',unit:unit.id,fingerprint:plan.fingerprint,file,profile:unit.singleton.profile,sourceHashes:plan.singletonSources[unit.id],evidenceDirectory:'/tmp/fixture/aihr-ci',prerequisites};
 if(nativeNextUnit(unit))binding.prerequisites={kind:'fresh-job-next-systemd-nginx-postgres',workers:1,database:prerequisites.database,
  host:{kind:'actual-job-systemd-nginx',platform:'linux',pid1:'systemd',sudoUid:'0',nginxPath:'/usr/sbin/nginx',nginxSha256:'e'.repeat(64),nginxVersion:'nginx version: nginx/1.24.0',systemdVersion:'systemd 255'},
  build:{kind:'same-run-canonical-next-build',source:plan.sha,controller:plan.controller,runId:'123',attempt:'1',artifactId:'456',producerJobId:'789',artifactDigest:'sha256:'+'a'.repeat(64),archiveSha256:'b'.repeat(64),manifestSha256:'c'.repeat(64),provenanceSha256:'d'.repeat(64),nextBuildId:'same-build'}};
 const env={GITHUB_ACTIONS:'true',CI:'true',RUNNER_ENVIRONMENT:'github-hosted',RUNNER_OS:'Linux',GITHUB_REPOSITORY:'StradaverseHub/ai-hr',GITHUB_REPOSITORY_ID:'1333414856',GITHUB_WORKFLOW:'alpha-staging-ci',GITHUB_JOB:nativeNextUnit(unit)?'native-test':'test',GITHUB_RUN_ATTEMPT:'1',GITHUB_RUN_ID:'123',AIHR_CI_HEAD:plan.sha,AIHR_CI_CONTROL_HEAD:plan.controller,GITHUB_SHA:plan.controller,GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_WORKFLOW_REF:'StradaverseHub/ai-hr/.github/workflows/alpha-staging.yml@refs/heads/main'};
 const event={repository:{full_name:'StradaverseHub/ai-hr',id:1333414856},inputs:{expected_sha:plan.sha}};
 const layout={platform:'linux',workspace:'/fixture',temp:'/tmp/fixture',source:'/fixture/source',automation:nativeNextUnit(unit)?'/var/lib/aihr-native-controller/123/automation':'/fixture/automation',cwd:'/fixture/source',evidence:'/tmp/fixture/aihr-ci',sourceHead:plan.sha,controllerHead:plan.controller,sourceClean:true,controllerClean:true};
 return {plan,unit,witness,binding,env,event,layout};
}
test('every registered infrastructure file remains exactly once in its native class and a dedicated bounded job',()=>{
 const native=Object.keys(SINGLETON_FILES),ordinary=['test/ordinary-db.test.ts','test/ordinary-nodb.test.ts'];
 const db=native.filter(f=>singletonKind(singletonDescriptor(f).profile)==='db').concat(ordinary[0]),nodb=native.filter(f=>!db.includes(f)).concat(ordinary[1]),suite=[...db,...nodb].sort();
 const units=buildUnits(suite,{db,nodb},browser),special=units.filter(u=>u.singleton);
 assert.equal(special.length,31);assert.deepEqual(units.filter(u=>u.kind!=='browser').flatMap(u=>u.files).sort(),suite);
 assert(special.every(u=>u.files.length===1&&u.singleton.workers===1));assert.equal(requiredEvidence({suite,units}).units.length,units.length);
 for(const unit of special){const changed=structuredClone(units);changed.find(u=>u.id===unit.id).singleton.workers=2;assert.throws(()=>requiredEvidence({suite,units:changed}));}
 assert.throws(()=>buildUnits([native[0]],{db:[],nodb:[native[0]]},browser));
 assert.deepEqual(requiredHostedSingletons(suite).sort(),native.sort());
 // Data-only source fixtures do not claim to authenticate a hosted owner.
 const databaseFixture=fixture('test/notification-worker-lifecycle.test.ts'),hostFixture=fixture(),all=singletonSources(databaseFixture.unit,candidateRoot);
 const common=['.github/ci/candidate-environment.mjs','.github/ci/db-scheduling.mjs','.github/ci/employee-lifecycle-profile.mjs','.github/ci/employee-lifecycle-sources.mjs','.github/ci/native-next-helper-sources.mjs','.github/ci/native-next-installation.mjs','.github/ci/policy-version.mjs','.github/ci/postgres-evidence.mjs','.github/ci/rewards-native-sources.mjs','.github/ci/singleton-protocol.mjs','scripts/test-duration-order.mjs','scripts/test-duration-sequencer.mjs','test/db-names.ts','test/helpers/ci-singleton-admission.ts','test/env.ts','vitest.config.ts','vitest.nodb.config.ts','.github/ci/employee-lifecycle-profile.json','.github/ci/db-duration-hints.json','package.json','pnpm-lock.yaml','tsconfig.json'];
 const database=['.github/ci/notification-catalogue-replay.mjs','db/schema.ts','drizzle.config.ts','lib/personnel-choice-vocabulary.ts','lib/profile-routing-policy.ts','packs/catalog.ts','scripts/lib/discard-premigration.ts','scripts/migrate-with-focused-prerequisites.ts','scripts/seed-catalogs.ts','test/global-setup.ts','test/helpers/personnel-draft-discard-ci-role-fixture.ts','test/profile.ts'];
 assert.equal(common.length,22);assert.equal(database.length,12);
 for(const file of [...common,...database])assert(all.includes(file),file);
 const journal=JSON.parse(readFileSync(join(candidateRoot,journalPath),'utf8'));
 const journalSql=journal.entries.map(row=>'db/migrations/'+row.tag+'.sql');
 const sql=readdirSync(join(candidateRoot,'db/migrations')).filter(file=>file.endsWith('.sql')).map(file=>'db/migrations/'+file).sort();
 assert(journalSql.includes('db/migrations/3900_individual_transaction_calculation_method.sql'));
 assert.deepEqual(sql,journalSql.sort());assert.deepEqual(all.filter(file=>file.startsWith('db/migrations/')).sort(),[journalPath,...sql].sort());
 const archives=['test/fixtures/historical-migrations/2301_attendance_workflow_submission_shared_lock.sql','test/fixtures/historical-migrations/3103_access_editor_presentation.sql'];for(const file of archives)assert(all.includes(file));
 assert.throws(()=>singletonSources(databaseFixture.unit));assert.throws(()=>validateSingletonBinding(databaseFixture.binding,databaseFixture.plan,databaseFixture.unit,databaseFixture.witness));
 const directory=realpathSync(mkdtempSync(join(tmpdir(),'shared-database-model-')));
 const write=(file,bytes)=>{mkdirSync(join(directory,file,'..'),{recursive:true});writeFileSync(join(directory,file),bytes);};
 try{
  // NoDB/ordinary/missing context cannot read any journal, even in an empty root.
  const pure=singletonSources(hostFixture.unit,directory);for(const file of common)assert(pure.includes(file));
  for(const file of [...database,journalPath,...sql,...archives])assert(!pure.includes(file),file);
  validateSingletonBinding(hostFixture.binding,hostFixture.plan,hostFixture.unit,hostFixture.witness);
  write(journalPath,readFileSync(join(candidateRoot,journalPath)));for(const file of [...sql,...archives])write(file,'-- fictional source membership input\n');
  assert.deepEqual(singletonSources(databaseFixture.unit,directory),all);
  validateSingletonBinding(databaseFixture.binding,databaseFixture.plan,databaseFixture.unit,databaseFixture.witness,directory);
  const raw=readFileSync(join(directory,journalPath));
  write(journalPath,JSON.stringify({...journal,entries:[...journal.entries].reverse()}));
  assert.deepEqual(singletonSources(databaseFixture.unit,directory),all);assert.throws(()=>validateSingletonBinding(databaseFixture.binding,databaseFixture.plan,databaseFixture.unit,databaseFixture.witness,directory),/Canonical journal bytes differ/);
  write(journalPath,raw);const appended={...journal,entries:[...journal.entries,{...journal.entries.at(-1),idx:journal.entries.length,tag:'9999_shared_prerequisite_model'}]},added='db/migrations/9999_shared_prerequisite_model.sql';
  write(journalPath,JSON.stringify(appended));write(added,'-- fictional append\n');assert(singletonSources(databaseFixture.unit,directory).includes(added));
  assert.throws(()=>validateSingletonBinding(databaseFixture.binding,databaseFixture.plan,databaseFixture.unit,databaseFixture.witness,directory));unlinkSync(join(directory,added));write(journalPath,raw);
  for(const entries of [[],[journal.entries[0],journal.entries[0]],[{tag:'../foreign'}],[{tag:'nested/tag'}],[{tag:'trailing\n'}],[{tag:1}],null]){
   write(journalPath,JSON.stringify({...journal,entries}));assert.throws(()=>singletonSources(databaseFixture.unit,directory));
  }
  write(journalPath,'{');assert.throws(()=>singletonSources(databaseFixture.unit,directory));write(journalPath,raw);
  const first=sql[0];unlinkSync(join(directory,first));assert.throws(()=>singletonSources(databaseFixture.unit,directory));write(first,'-- restored\n');
  write('db/migrations/unexpected.sql','-- unexpected\n');assert.throws(()=>singletonSources(databaseFixture.unit,directory));unlinkSync(join(directory,'db/migrations/unexpected.sql'));
  unlinkSync(join(directory,first));symlinkSync(join(directory,sql[1]),join(directory,first));assert.throws(()=>singletonSources(databaseFixture.unit,directory));unlinkSync(join(directory,first));mkdirSync(join(directory,first));assert.throws(()=>singletonSources(databaseFixture.unit,directory));rmdirSync(join(directory,first));write(first,'-- restored\n');
  for(const archive of archives){
   unlinkSync(join(directory,archive));assert.throws(()=>singletonSources(databaseFixture.unit,directory));
   symlinkSync(join(directory,first),join(directory,archive));assert.throws(()=>singletonSources(databaseFixture.unit,directory));unlinkSync(join(directory,archive));
   mkdirSync(join(directory,archive));assert.throws(()=>singletonSources(databaseFixture.unit,directory));rmdirSync(join(directory,archive));
   write(archive,Buffer.alloc(4*1024*1024+1,32));assert.throws(()=>singletonSources(databaseFixture.unit,directory));write(archive,'-- restored historical source\n');
  }
  write(journalPath,Buffer.alloc(4*1024*1024+1,32));assert.throws(()=>singletonSources(databaseFixture.unit,directory));write(journalPath,raw);
  unlinkSync(join(directory,journalPath));symlinkSync(join(candidateRoot,journalPath),join(directory,journalPath));assert.throws(()=>singletonSources(databaseFixture.unit,directory));unlinkSync(join(directory,journalPath));write(journalPath,raw);
 }finally{rmSync(directory,{recursive:true,force:true});}
 // Exercise the ACTUAL planner and index owner. Matching physical/journal SQL
 // ignored by Git remains clean but must fail at the tracked-source gate.
 const repository=realpathSync(mkdtempSync(join(tmpdir(),'shared-database-index-model-')));
 const keys=['AIHR_CI_HEAD','AIHR_CI_CLASSIFIER_RUNTIME'],saved=new Map(keys.map(key=>[key,process.env[key]]));
 const git=(...args)=>execFileSync('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',...args],{cwd:repository,encoding:'utf8',timeout:10000});
 const copy=file=>{mkdirSync(join(repository,file,'..'),{recursive:true});copyFileSync(join(candidateRoot,file),join(repository,file));};
 try{
  for(const file of [...all,'scripts/gate-db-classify.ts','test/payslip-pdf.test.ts','test/r379-pcb2ii-pdf.test.ts','lib/borang-8a-pdf.ts','lib/borang-8b-pdf.ts','lib/cp21-fields.ts','lib/cp22a-fields.ts','lib/payslip-pdf.ts','lib/payslip-pdf-strings.ts','test/fixtures/payslip-pdf-fixture.ts','core/payslip-information.ts','lib/pcb2ii-pdf.ts','lib/payslip-pdf-fonts.ts','lib/pcb2ii-form.ts','test/tailwind-width-order.browser.test.tsx'])copy(file);
  const added='db/migrations/9999_shared_index_model.sql';
  writeFileSync(join(repository,journalPath),JSON.stringify({...journal,entries:[...journal.entries,{...journal.entries.at(-1),idx:journal.entries.length,tag:'9999_shared_index_model'}]}));
  writeFileSync(join(repository,added),'-- ignored fictional SQL source\n');writeFileSync(join(repository,'.gitignore'),added+'\n');
  git('init','--quiet');git('add','.');git('-c','user.name=Fictional CI','-c','user.email=ci@example.invalid','commit','--quiet','-m','Canonical index model');
  delete process.env.AIHR_CI_HEAD;process.env.AIHR_CI_CLASSIFIER_RUNTIME='native';
  assert.equal(git('status','--porcelain').trim(),'');assert(singletonSources(databaseFixture.unit,repository).includes(added));
  assert.throws(()=>createPlan(repository),new RegExp('Canonical database source must be tracked as a regular file: '+added));
  git('add','--force',added);git('-c','user.name=Fictional CI','-c','user.email=ci@example.invalid','commit','--quiet','-m','Track matching canonical SQL');
  const actual=createPlan(repository),selected=actual.units.find(unit=>unit.files.includes(databaseFixture.unit.files[0]));
  assert(selected?.singleton);assert.equal(actual.sha,git('rev-parse','HEAD').trim());assert.equal(actual.singletonSources[selected.id][added],createHash('sha256').update(readFileSync(join(repository,added))).digest('hex'));
  for(const archive of archives){
   git('rm','--cached',archive);writeFileSync(join(repository,'.gitignore'),added+'\n'+archive+'\n');git('add','.gitignore');git('-c','user.name=Fictional CI','-c','user.email=ci@example.invalid','commit','--quiet','-m','Ignore an existing required historical payload');
   assert.equal(git('status','--porcelain').trim(),'');assert(singletonSources(databaseFixture.unit,repository).includes(archive));
   assert.throws(()=>createPlan(repository),{message:'Canonical database source must be tracked as a regular file: '+archive});
   git('add','--force',archive);git('-c','user.name=Fictional CI','-c','user.email=ci@example.invalid','commit','--quiet','-m','Track required historical payload');
   const tracked=createPlan(repository);assert.equal(tracked.singletonSources[selected.id][archive],createHash('sha256').update(readFileSync(join(repository,archive))).digest('hex'));
  }
  writeFileSync(join(repository,journalPath),readFileSync(join(repository,journalPath),'utf8')+'\n');git('add',journalPath);git('-c','user.name=Fictional CI','-c','user.email=ci@example.invalid','commit','--quiet','-m','Change raw journal bytes only');const changed=createPlan(repository);assert.deepEqual(Object.keys(changed.singletonSources[selected.id]),Object.keys(actual.singletonSources[selected.id]));assert.notEqual(changed.singletonSources[selected.id][journalPath],actual.singletonSources[selected.id][journalPath]);assert.notEqual(changed.fingerprint,actual.fingerprint);
  process.env.AIHR_CI_HEAD='f'.repeat(40);assert.throws(()=>createPlan(repository),/checkout does not match requested HEAD/);
 }finally{for(const[key,value]of saved){if(value===undefined)delete process.env[key];else process.env[key]=value;}rmSync(repository,{recursive:true,force:true});}
});
test('actual full-CI host context, complete plan and closed native prerequisites admit',()=>{
 for(const file of ['test/runtime-ready-admission-native.test.ts','test/notification-worker-lifecycle.test.ts','test/analytics-termination-lateral.test.ts','test/runtime-next-admission-native.test.ts','test/access-editor-native-owner-presentation.test.ts','test/notification-worker-native-plan-diagnostic.test.ts']){
  const f=fixture(file);validateSingletonHost(f);validateSingletonBinding(f.binding,f.plan,f.unit,f.witness,candidateRoot);
 }
});
test('native workload DB custody refuses focused intent, foreign role URLs and incomplete durable custody',()=>{
 const f=fixture(NATIVE_WORKLOAD_DATABASE_FILE),boot=fixture('test/runtime-next-admission-native.test.ts');
 assert(nativeWorkloadDatabaseUnit(f.unit)&&nativeNextUnit(f.unit));
 assert(!nativeWorkloadDatabaseUnit(boot.unit));
 assert.throws(()=>prepareNativeWorkloadPostgres(boot.plan,boot.unit,'/unused'),/fixed native workload DB unit/);
 assert.throws(()=>assertSingletonSelection([NATIVE_WORKLOAD_DATABASE_FILE]),/protected full-CI unit/);
 assert(singletonSources(f.unit,candidateRoot).includes('.github/ci/native-workload-postgres.mjs'));
 assert(!singletonSources(boot.unit,candidateRoot).includes('.github/ci/native-workload-postgres.mjs'));
 validateSingletonHost(f);
 assert.throws(()=>validateSingletonHost({...f,env:{...f.env,GITHUB_JOB:'selected-tests'}}));
 assert.throws(()=>validateSingletonBinding(f.binding,f.plan,f.unit,f.witness,candidateRoot));
 f.binding.prerequisites.workloadDatabase={kind:'OWNED_SCRAM_WORKLOAD_DATABASE_COMPONENT',containerIdentitySha256:'e'.repeat(64),
  systemIdentifierSha256:'d'.repeat(64),hbaSha256:createHash('sha256').update(NATIVE_WORKLOAD_DATABASE_HBA).digest('hex'),
  settings:{...NATIVE_WORKLOAD_DATABASE_SETTINGS}};
 validateSingletonBinding(f.binding,f.plan,f.unit,f.witness,candidateRoot);
 for(const mutate of [p=>p.hbaSha256='0'.repeat(64),p=>p.settings.fsync='off',p=>p.settings.deadlock_timeout='5s',p=>p.settings.log_lock_waits='off',p=>p.ownerUrl='unused']){
  const invalid=structuredClone(f.binding);mutate(invalid.prerequisites.workloadDatabase);
  assert.throws(()=>validateSingletonBinding(invalid,f.plan,f.unit,f.witness,candidateRoot));
 }
 const url=(user,key,db)=>`postgres://${user}:${key.repeat(64)}@127.0.0.1:5433/${db}`;
 const app=url('ai_hr_app','a','ai_hr_test_w1'),owner=url('postgres','b','ai_hr_test_w1'),observer=url(NATIVE_WORKLOAD_OBSERVER,'c','ai_hr_test_w1');
 const worker={DATABASE_URL:app,TEST_DATABASE_URL:app,MIGRATION_DATABASE_URL:owner,TEST_MIGRATION_DATABASE_URL:owner,[NATIVE_WORKLOAD_OBSERVER_URL]:observer};
 assert.equal(validateNativeWorkloadDatabaseUrls(worker,'ai_hr_test_w1'),url('postgres','b','postgres'));
 assert.equal(validateNativeWorkloadObserverUrl(worker),observer);
 const migration={DATABASE_URL:url('ai_hr_app','a','ai_hr_dev'),TEST_DATABASE_URL:url('ai_hr_app','a','ai_hr_test'),
  MIGRATION_DATABASE_URL:url('postgres','b','ai_hr_dev'),TEST_MIGRATION_DATABASE_URL:url('postgres','b','ai_hr_test')};
 assert.equal(validateNativeWorkloadDatabaseUrls(migration,null),url('postgres','b','postgres'));
 for(const value of [app.replace('127.0.0.1','example.invalid'),app.replace('5433','5432'),app+'?sslmode=require',app+'#x',
  app.replace(':'+ 'a'.repeat(64),''),app.replace('a'.repeat(64),'b'.repeat(64)),url('postgres','a','ai_hr_test_w1')]){
  assert.throws(()=>validateNativeWorkloadDatabaseUrls({...worker,DATABASE_URL:value},'ai_hr_test_w1'),error=>!String(error).includes(value));
 }
 assert.throws(()=>validateNativeWorkloadDatabaseUrls(worker,'ai_hr_test_w2'));
 assert.throws(()=>validateNativeWorkloadDatabaseUrls(migration,'ai_hr_test_w1'));
 assert.throws(()=>validateNativeWorkloadObserverUrl({...worker,[NATIVE_WORKLOAD_OBSERVER_URL]:url(NATIVE_WORKLOAD_OBSERVER,'b','ai_hr_test_w1')}));
 verifyWorkloadArtifactControls(f);
});
function verifyWorkloadArtifactControls({plan,unit,binding,witness}){
 const {database,build,workloadDatabase}=binding.prerequisites;
 const {containerIdentitySha256,systemIdentifierSha256}=workloadDatabase;
 const close={kind:'NATIVE_WORKLOAD_DATABASE_SETTLEMENT',containerIdentitySha256,systemIdentifierSha256,
  containerAbsent:true,processAbsent:true,cgroupAbsent:true,privateFilesRemoved:true,complete:true};
 const report={schemaVersion:1,sha:plan.sha,fingerprint:plan.fingerprint,id:unit.id,cwd:'/fixture/source',files:unit.files,exitCode:0,
  singleton:binding,databaseTerminalEvidence:database,workloadDatabaseClose:close,batches:[{exitCode:0,databaseEvidence:database,
   result:{success:true,numFailedTests:0,numFailedTestSuites:0,numTotalTests:1,numPassedTests:1,
    testResults:[{name:'/fixture/source/'+unit.files[0],status:'passed',assertionResults:[{title:NATIVE_WORKLOAD_DATABASE_CASE,status:'passed'}]}]}}]};
 const member={kind:'NATIVE_WORKLOAD_DATABASE_CUSTODY_COMPONENT_ONLY',source:plan.sha,controller:plan.controller,runId:'123',attempt:'1',
  fingerprint:plan.fingerprint,unit:unit.id,buildArtifactId:build.artifactId,buildProducerJobId:build.producerJobId,buildArchiveSha256:build.archiveSha256,
  systemIdentifierSha256,containerIdentitySha256,authenticatedRoles:3,connectionRefusals:8,privilegeRefusals:5,clientClosures:3,releaseEligible:false};
 const serialize=value=>Buffer.from(JSON.stringify(value)+'\n'),raw=serialize(member),sha=createHash('sha256').update(raw).digest('hex');
 const root=realpathSync(mkdtempSync(join(tmpdir(),'workload-database-artifact-')));
 try{
  const artifact=join(root,'unit-'+unit.id),file=join(artifact,NATIVE_WORKLOAD_DATABASE_MEMBER);
  mkdirSync(artifact);writeFileSync(join(artifact,`unit-${unit.id}.json`),serialize(report));writeFileSync(file,raw);
  const [entry]=[...readUnitReportDirectories(root,[unit],{mode:'full'})],replay=readWorkloadDatabaseArtifact(artifact,unit);
  assert.deepEqual(entry,replay);assert.deepEqual(replay.workloadDatabaseBytes,raw);
  const verify=(r,bytes)=>verifyUnitReport(plan,r,{...witness,workloadDatabases:new Map([[unit.id,bytes]])},candidateRoot);
  assert.equal(verify(entry.report,entry.workloadDatabaseBytes).workloadDatabaseSha256,sha);
  const browserReports=plan.units.filter(candidate=>candidate.kind==='browser').map(browserUnit=>({
   schemaVersion:1,sha:plan.sha,fingerprint:plan.fingerprint,id:browserUnit.id,cwd:report.cwd,files:browserUnit.files,exitCode:0,
   batches:[{exitCode:0,result:{...report.batches[0].result,testResults:[{
    name:report.cwd+'/'+browserUnit.files[0],status:'passed',assertionResults:[{title:'fictional browser witness',status:'passed'}],
   }]}}],
  }));
  const reports=[report,...browserReports];
  assert.equal(verifyReports(plan,reports,{...witness,workloadDatabases:new Map([[unit.id,raw]])},candidateRoot)
   .reports.find(row=>row.id===unit.id).workloadDatabaseSha256,sha);
  assert.throws(()=>verifyReports(plan,reports,witness,candidateRoot),/member or settlement refused/);
  const selection=selectCommissioning(plan,[unit.id]);
  const commissioningRoot=join(root,'commissioning');mkdirSync(commissioningRoot);
  const commissioningArtifact=join(commissioningRoot,'commission-unit-'+unit.id);mkdirSync(commissioningArtifact);
  const commissioningMember=join(commissioningArtifact,NATIVE_WORKLOAD_DATABASE_MEMBER);
  writeFileSync(join(commissioningArtifact,`unit-${unit.id}.json`),serialize(report));writeFileSync(commissioningMember,raw);
  const summary=()=>summarizeCommissioning(plan,selection,readUnitReportDirectories(commissioningRoot,[unit],{mode:'commissioning'}),witness,candidateRoot);
  assert.equal(summary().outcomes[0].workloadDatabaseSha256,sha);
  unlinkSync(commissioningMember);assert.equal(summary().outcomes[0].outcome,'refused');
  for(const changed of [undefined,Buffer.from([255]),Buffer.from('{'),Buffer.from(raw.toString().replace('{','{"source":"'+plan.sha+'",')),
   ...Object.keys(member).map(key=>serialize({...member,[key]:null})),serialize({...member,unexpected:true})]){
   assert.throws(()=>verify(report,changed),/member or settlement refused/);
  }
  for(const mutate of [r=>delete r.workloadDatabaseClose,r=>r.workloadDatabaseSettlementRefused=true,
   ...Object.keys(close).map(key=>r=>r.workloadDatabaseClose[key]=null),r=>r.workloadDatabaseClose.extra=true,
   r=>r.batches[0].result.testResults[0].assertionResults[0].title='substitute',
   r=>r.databaseTerminalEvidence={...database,name:'foreign'},r=>r.batches[0].databaseEvidence={...database,name:'foreign'}]){
   const changed=structuredClone(report);mutate(changed);assert.throws(()=>verify(changed,raw),/member or settlement refused/);
  }
  const refused=()=>assert.throws(()=>readWorkloadDatabaseArtifact(artifact,unit),/report-directory custody refused/);
  for(const invalid of [Buffer.alloc(4097),Buffer.alloc(0)]){writeFileSync(file,invalid);refused();}
  unlinkSync(file);symlinkSync(join(artifact,`unit-${unit.id}.json`),file);refused();unlinkSync(file);
  writeFileSync(file,raw);const nested=join(artifact,'nested');mkdirSync(nested);writeFileSync(join(nested,NATIVE_WORKLOAD_DATABASE_MEMBER),raw);refused();
 }finally{rmSync(root,{recursive:true,force:true});}
}
for(const [name,mutate]of [
 ['foreign source',f=>f.binding.candidate='f'.repeat(40)],['foreign controller',f=>f.binding.controller='f'.repeat(40)],
 ['wrong unit',f=>f.binding.unit='other'],['wrong file',f=>f.binding.file='test/ordinary.test.ts'],['wrong profile',f=>f.binding.profile='unknown'],
 ['claimed focused mode',f=>f.binding.mode='focused'],['second attempt',f=>f.binding.attempt='2'],['wrong producing run',f=>f.binding.runId='456'],
 ['missing source proof',f=>delete f.binding.sourceHashes],['source byte drift',f=>f.binding.sourceHashes={...f.binding.sourceHashes,[f.unit.files[0]]:'f'.repeat(64)}],
 ['wrong plan fingerprint',f=>f.binding.fingerprint='f'.repeat(64)],['expanded workers',f=>f.unit.singleton.workers=2],['batched file',f=>f.unit.files.push('test/ordinary.test.ts')],
 ['not systemd',f=>f.binding.prerequisites.pid1='init'],['sudo not root',f=>f.binding.prerequisites.sudoUid='1000'],['missing nginx',f=>delete f.binding.prerequisites.nginxVersion],
 ['changed nginx bytes',f=>f.binding.prerequisites.nginxSha256='claimed'],['unknown proof key',f=>f.binding.accepted=true],
 ['absent authenticated witness',f=>f.witness=undefined],
])test('refuses singleton proof: '+name,()=>{const f=fixture();mutate(f);assert.throws(()=>validateSingletonBinding(f.binding,f.plan,f.unit,f.witness,candidateRoot));});
for(const [name,mutate]of [
 ['forged focused selection',f=>f.env.AIHR_FOCUSED_TESTS='[]'],['empty focused hint',f=>f.env.AIHR_FOCUSED_SUITE_CAPACITY=''],
 ['foreign repository',f=>f.env.GITHUB_REPOSITORY='other/repo'],['other workflow',f=>f.env.GITHUB_WORKFLOW='alpha-focused-checks'],
 ['not hosted',f=>f.env.RUNNER_ENVIRONMENT='self-hosted'],['wrong job',f=>f.env.GITHUB_JOB='selected-tests'],['rerun',f=>f.env.GITHUB_RUN_ATTEMPT='2'],
 ['dirty candidate',f=>f.layout.sourceClean=false],['dirty controller',f=>f.layout.controllerClean=false],['symlinked source layout',f=>f.layout.source='/elsewhere/source'],
 ['foreign evidence path',f=>f.layout.evidence='/tmp/unowned'],['wrong actual source',f=>f.layout.sourceHead='f'.repeat(40)],
 ['wrong event source',f=>f.event.inputs.expected_sha='f'.repeat(40)],['foreign event repository',f=>f.event.repository.id=1],['unsupported event',f=>f.env.GITHUB_EVENT_NAME='schedule'],
])test('refuses singleton host: '+name,()=>{const f=fixture();mutate(f);assert.throws(()=>validateSingletonHost(f));});
test('cluster receipt is bound to the physical job/run/attempt/unit, not a worker database namespace',()=>{
 const f=fixture('test/notification-worker-lifecycle.test.ts');f.binding.prerequisites.database.name='aihr-ci-123-1-db-other';assert.throws(()=>validateSingletonBinding(f.binding,f.plan,f.unit,f.witness,candidateRoot));
 assertNoSingletonHints({});for(const env of [{AIHR_CI_SINGLETON_BINDING:'/tmp/forged'},{AIHR_CI_SINGLETON_UNKNOWN:''}])assert.throws(()=>assertNoSingletonHints(env));
});
test('database tests bind every actual URL to the canonical owned loopback worker before their bodies run',()=>{
 const names={DATABASE_URL:'ai_hr_app',TEST_DATABASE_URL:'ai_hr_app',MIGRATION_DATABASE_URL:'postgres',TEST_MIGRATION_DATABASE_URL:'postgres'},env=Object.fromEntries(Object.entries(names).map(([key,user])=>[key,`postgres://${user}@127.0.0.1:5433/ai_hr_test_w1`]));
 validateSingletonDatabaseUrls(env,'ai_hr_test_w1');
 for(const key of Object.keys(names))for(const value of ['postgres://postgres@production:5433/ai_hr_test_w1','postgres://postgres@127.0.0.1:5432/ai_hr_test_w1','postgres://postgres@127.0.0.1:5433/ai_hr_dev','postgres://postgres@127.0.0.1:5433/ai_hr_test_w1?options=unsafe'])assert.throws(()=>validateSingletonDatabaseUrls({...env,[key]:value},'ai_hr_test_w1'));
});
test('strict unit verifier requires the complete source-bound singleton invocation and refuses skipped/missing proof',()=>{
 const f=fixture(),report={schemaVersion:1,sha:f.plan.sha,fingerprint:f.plan.fingerprint,id:f.unit.id,cwd:'/fixture/source',files:f.unit.files,exitCode:0,singleton:f.binding,batches:[{exitCode:0,result:{success:true,numFailedTests:0,numFailedTestSuites:0,numPendingTests:0,numPendingTestSuites:0,numTodoTests:0,numTotalTests:1,numPassedTests:1,testResults:[{name:'/fixture/source/'+f.unit.files[0],status:'passed',assertionResults:[{status:'passed'}]}]}}]};
 assert.equal(verifyUnitReport(f.plan,report,f.witness,candidateRoot).tests,1);
 for(const mutate of [r=>delete r.singleton,r=>r.batches.push(r.batches[0]),r=>r.batches[0].result.numPendingTests=1,r=>r.batches[0].result.testResults[0].assertionResults[0].status='skipped']){const changed=structuredClone(report);mutate(changed);assert.throws(()=>verifyUnitReport(f.plan,changed,f.witness,candidateRoot));}
 assert.throws(()=>verifyUnitReport(f.plan,report));
});
test('source admissions and full workflow never manufacture focused variables or omit controlled cases',()=>{
 const run=readFileSync(new URL('./run-unit.mjs',import.meta.url),'utf8'),admission=readFileSync(new URL('../../test/helpers/ci-singleton-admission.ts',import.meta.url),'utf8');
 assert(run.includes('env.AIHR_CI_SINGLETON_BINDING=singleton.path'));assert(!/env\.AIHR_FOCUSED_[A-Z_]+\s*=/.test(run));assert(admission.includes('execFileSync(process.execPath,[script]'));
 const root=fileURLToPath(new URL('../../',import.meta.url)),tracked=new Set(execFileSync('git',['ls-files','test'],{cwd:root,encoding:'utf8'}).trim().split('\n'));
 for(const [file,profile]of Object.entries(SINGLETON_FILES))if(profile==='controlled-database-v1'&&tracked.has(file)){
  const text=readFileSync(new URL('../../'+file,import.meta.url),'utf8');assertSingletonCoverage([file],path=>readFileSync(new URL('../../'+path,import.meta.url),'utf8'));assert(!text.includes('.skipIf('));assert(!text.includes('AIHR_FOCUSED_EVIDENCE_DIR'));
 }
});
test('discovered future focused-only guards fail planning until their actual full admission is implemented',()=>{
 const future='test/employee-choice-unified-plan.test.ts',legacy="const requested=JSON.parse(process.env.AIHR_FOCUSED_TESTS);it.skipIf(!requested)('required',()=>{});";
 assert.throws(()=>assertSingletonCoverage([future],()=>legacy));assert.throws(()=>assertSingletonCoverage(['test/analytics-termination-lateral.test.ts'],()=>legacy));
 assert.throws(()=>assertSingletonCoverage(['test/analytics-termination-lateral.test.ts'],()=>"it('required',()=>{});"));
 // The formerly future fixed-LOGIN file now exists. A dedicated descriptor alone
 // must not let it execute without validating the real invocation capability.
 const notification='test/notification-worker-lifecycle.test.ts';
 assert.throws(()=>assertSingletonCoverage([notification],()=>"it('required',()=>{});"));
 assertSingletonCoverage([notification],()=>"beforeAll(()=>admitSingletonTest('test/notification-worker-lifecycle.test.ts')); ");
 const root=fileURLToPath(new URL('../../',import.meta.url)),files=execFileSync('git',['ls-files','test'],{cwd:root,encoding:'utf8'}).trim().split('\n').filter(f=>/\.test\.ts$|\.dom\.test\.tsx$/.test(f));
 assertSingletonCoverage(files,file=>readFileSync(new URL('../../'+file,import.meta.url),'utf8'));
 assertSingletonSelection(['test/runtime-ready-admission-native.test.ts']);assertSingletonSelection(['test/ordinary-a.test.ts','test/ordinary-b.test.ts']);
 for(const file of Object.keys(SINGLETON_FILES))assert.throws(()=>assertSingletonSelection([file,'test/ordinary.test.ts']));
});
test('the real local scope guard refuses a complete native inventory rather than executing a narrowed gate',()=>{
 const script=fileURLToPath(new URL('../../scripts/gate-singleton-scope.mjs',import.meta.url));
 const ordinary=spawnSync(process.execPath,[script],{encoding:'utf8',input:'test/ordinary.test.ts\n'});assert.equal(ordinary.status,0);
 const native=spawnSync(process.execPath,[script],{encoding:'utf8',input:'test/ordinary.test.ts\ntest/runtime-ready-admission-native.test.ts\n'});assert.equal(native.status,2);assert(native.stderr.includes('authenticated hosted singleton units'));assert(native.stderr.includes('test/runtime-ready-admission-native.test.ts'));
 const scriptSource=readFileSync(new URL('../../scripts/gate-chunked.sh',import.meta.url),'utf8');assert(scriptSource.indexOf('node scripts/gate-singleton-scope.mjs')<scriptSource.indexOf('node --import tsx scripts/gate-db-classify.ts'));
});

test('hybrid capability binds the conjunction of actual host, owned database and identical same-run build',()=>{
 const f=fixture('test/runtime-next-admission-native.test.ts');
 assert.equal(f.unit.kind,'db');assert.equal(f.unit.singleton.isolation,'job-host-and-postgres-cluster');
 assert.equal(singletonJobName(f.unit),`native-test (${f.unit.id})`);
 assert(singletonSources(f.unit,candidateRoot).includes('deploy/admission/next_profile.py'));
 assert(singletonSources(f.unit,candidateRoot).includes('.github/ci/native-next-build-packet.mjs'));
 validateSingletonHost(f);validateSingletonBinding(f.binding,f.plan,f.unit,f.witness,candidateRoot);
 for(const mutate of [p=>delete p.host,p=>delete p.database,p=>delete p.build,p=>p.build.source='f'.repeat(40),
  p=>p.build.controller='f'.repeat(40),p=>p.build.runId='456',p=>p.build.attempt='2',p=>p.build.artifactDigest='claimed',
  p=>p.build.producerJobId='0',p=>p.build.nextBuildId='',p=>p.build.extra=true,p=>p.host.pid1='init',
  p=>p.kind='fresh-job-postgres-cluster']){
  const changed=structuredClone(f.binding);mutate(changed.prerequisites);assert.throws(()=>validateSingletonBinding(changed,f.plan,f.unit,f.witness,candidateRoot));
 }
 const wrong=structuredClone(f);wrong.env.GITHUB_JOB='test';assert.throws(()=>validateSingletonHost(wrong));
 const ordinary=fixture();ordinary.env.GITHUB_JOB='native-test';assert.throws(()=>validateSingletonHost(ordinary));
});

test('final independent build verification refuses a native unit that exercised different compiled bytes',()=>{
 const f=fixture('test/runtime-next-admission-native.test.ts'),p=f.binding.prerequisites.build;
 const packet={kind:'AUTHENTICATED_CI_BUILD_PACKET_NOT_DEPLOYMENT',canonicalCandidateInputsVerified:true,source:f.plan.sha,controller:f.plan.controller,runId:123,
  ...Object.fromEntries(['nextBuildId','archiveSha256','manifestSha256','provenanceSha256'].map(k=>[k,p[k]]))};
 const artifact={name:'production-build-v1',id:Number(p.artifactId),digest:p.artifactDigest},reports=[{id:f.unit.id,singleton:f.binding}];
 assertNativeBuildMatches(f.plan,reports,packet,artifact,Number(p.producerJobId));
 for(const mutate of [q=>q.nextBuildId='other',q=>q.archiveSha256='f'.repeat(64),q=>q.manifestSha256='f'.repeat(64),q=>q.provenanceSha256='f'.repeat(64),q=>q.runId=124,q=>q.kind='VERIFIED_NATIVE_NEXT_PACKET_NOT_RELEASE',q=>q.canonicalCandidateInputsVerified=false]){
  const changed=structuredClone(packet);mutate(changed);assert.throws(()=>assertNativeBuildMatches(f.plan,reports,changed,artifact,Number(p.producerJobId)));
 }
 assert.throws(()=>assertNativeBuildMatches(f.plan,[],packet,artifact,Number(p.producerJobId)));
 assert.throws(()=>assertNativeBuildMatches(f.plan,reports,packet,{...artifact,id:999},Number(p.producerJobId)));
 assert.throws(()=>assertNativeBuildMatches(f.plan,reports,packet,artifact,999));
});

test('Access native-owner and paired notification diagnostics retain isolated authenticated jobs and their exact owned source closure',()=>{
 const cases=[['test/access-editor-native-owner-presentation.test.ts','controlled-database-v1',[
  'db/migrations/3211_access_editor_native_owner_presentation.sql','test/fixtures/access-editor-native-owner.ts','test/fixtures/historical-migrations/source-path.ts','test/fixtures/access-editor-cleanup-lifetime.ts','test/fixtures/access-editor-catalogue-diagnostic.ts','test/fixtures/access-editor-owner-dependencies.ts','test/fixtures/access-editor-owned-work.ts','test/fixtures/access-editor-original739-journal.json','test/fixtures/access-editor-locked-baseline.ts',
 ]],['test/notification-worker-native-plan-diagnostic.test.ts','notification-cluster-v1',[
  'test/harness.ts','lib/notification-worker/lifecycle.ts','lib/notification-worker/projection.ts','lib/assessment-reminder-mail.ts','test/fixtures/notification-worker/owner-fixture.ts','test/fixtures/notification-worker/database.ts','test/fixtures/notification-worker/diagnostic-ownership.ts','test/fixtures/notification-worker/plan-logging.ts','test/fixtures/notification-worker/auto-explain.ts','test/fixtures/notification-worker/admission-plan-summary.ts','test/fixtures/notification-worker/lifecycle.sql','test/fixtures/notification-worker/projection.sql','test/fixtures/notification-worker/assessment.sql','test/fixtures/notification-worker/process.sql','test/fixtures/notification-worker/query-shape.sql','test/fixtures/notification-worker/exact-source.sql',
 ]]];
 for(const[file,profile,owned]of cases){
  const f=fixture(file);assert.deepEqual(f.unit.singleton,{version:1,profile,workers:1,isolation:'job-postgres-cluster'});assert.equal(f.unit.kind,'db');assert.deepEqual(f.unit.files,[file]);
  validateSingletonHost(f);validateSingletonBinding(f.binding,f.plan,f.unit,f.witness,candidateRoot);const actual=singletonSources(f.unit,candidateRoot);assert.equal(new Set(actual).size,actual.length);
  for(const source of owned){
   assert(actual.includes(source));assert(readFileSync(new URL('../../'+source,import.meta.url)).length>0);
   // Even a self-consistent plan/binding cannot omit a reviewed closure owner.
   const changed=structuredClone(f);delete changed.plan.singletonSources[changed.unit.id][source];delete changed.binding.sourceHashes[source];
   const{fingerprint:_fingerprint,...body}=changed.plan;changed.plan.fingerprint=protocolHash(body);changed.binding.fingerprint=changed.plan.fingerprint;
   assert.throws(()=>validateSingletonBinding(changed.binding,changed.plan,changed.unit,changed.witness,candidateRoot));
  }
  assert.throws(()=>assertSingletonSelection([file,'test/ordinary.test.ts']));assert.throws(()=>assertSingletonCoverage([file],()=>"it('unadmitted',()=>{});"));
 }
 const diagnostic=readFileSync(new URL('../../test/notification-worker-native-plan-diagnostic.test.ts',import.meta.url),'utf8');
 assert(diagnostic.includes('admitSingletonTest(filename)'));assert(diagnostic.includes('diagnosticAdmission.evidenceDirectory'));assert(!diagnostic.includes('process.env.AIHR_FOCUSED_'));assert(!/\.(?:skipIf|runIf)\s*\(/.test(diagnostic));
 const access=readFileSync(new URL('../../test/fixtures/access-editor-native-owner.ts',import.meta.url),'utf8');assert(access.includes("readFileSync('test/fixtures/access-editor-original739-journal.json'"));assert(!access.includes("readFileSync('db/migrations/meta/_journal.json'"));
});

test('Attendance owned child and pidfd proof cannot share a job or omit its actual Python/SQL/source owners',()=>{
 const file='test/attendance-shared-submission-bridge.test.ts',f=fixture(file);
 assert.deepEqual(f.unit.singleton,{version:1,profile:'controlled-database-v1',workers:1,isolation:'job-postgres-cluster'});
 assert.equal(f.unit.kind,'db');assert.deepEqual(f.unit.files,[file]);validateSingletonHost(f);validateSingletonBinding(f.binding,f.plan,f.unit,f.witness,candidateRoot);
 const owners=[
  'db/migrations/0592_attendance_workflow_v4.sql','db/migrations/3101_attendance_shared_workflow.sql',
  'db/migrations/3110_attendance_workflow_owner_rls.sql','db/migrations/3210_attendance_shared_workflow_submission_lock.sql',
  'test/harness.ts','db/client.ts','db/schema.ts','core/attendance-workflow.ts','core/attendance.ts','core/org.ts','lib/hr-date.ts',
  'test/helpers/attendance-bridge-fixture.ts','test/helpers/attendance-bridge-owned-phase.ts',
  'test/helpers/attendance-bridge-owner-catalogue.ts','test/helpers/attendance-bridge-owner-process.ts',
  'test/helpers/attendance-bridge-owner-proof.ts','test/helpers/attendance-bridge-owner-protocol.ts',
  'test/helpers/attendance-bridge-owner-worker.ts','test/helpers/attendance-bridge-pidfd.py','test/helpers/attendance-bridge-pidfd.ts',
 ];
 const sources=singletonSources(f.unit,candidateRoot);assert.equal(new Set(sources).size,sources.length);
 for(const source of owners){
  assert(sources.includes(source));assert(readFileSync(new URL('../../'+source,import.meta.url)).length>0);
  const changed=structuredClone(f);delete changed.plan.singletonSources[changed.unit.id][source];delete changed.binding.sourceHashes[source];
  const{fingerprint:_fingerprint,...body}=changed.plan;changed.plan.fingerprint=protocolHash(body);changed.binding.fingerprint=changed.plan.fingerprint;
  assert.throws(()=>validateSingletonBinding(changed.binding,changed.plan,changed.unit,changed.witness,candidateRoot));
 }
 assert.throws(()=>assertSingletonSelection([file,'test/ordinary.test.ts']));
 assert.throws(()=>assertSingletonCoverage([file],()=>"it('unadmitted',()=>{});"));
 const text=readFileSync(new URL('../../'+file,import.meta.url),'utf8');
 assert(text.indexOf("admitSingletonTest('"+file+"')")<text.indexOf('beforeAll(async()=>'));
 assert(!/\.(?:skipIf|runIf)\s*\(/.test(text));
});


test('singleton source limits grant only the exact Tamil member a bounded 8 MiB read',()=>{
 const ordinary=4*1024*1024,tamil=8*1024*1024;
 assert.equal(singletonSourceMaximum('messages/ta.json'),tamil);
 for(const file of ['messages/en.json','unknown/source.json','messages/ta.json/child','messages/ta.json.backup',
  'messages/TA.json','./messages/ta.json','/messages/ta.json','messages/../messages/ta.json',
  'messages//ta.json','messages\\ta.json','messages/ta.json?approved=true','messages/ta.json\0']){
  assert.equal(singletonSourceMaximum(file),ordinary,file);
  assert(ordinary<=singletonSourceMaximum(file));assert(!(ordinary+1<=singletonSourceMaximum(file)));
 }
 assert(tamil<=singletonSourceMaximum('messages/ta.json'));
 assert(!(tamil+1<=singletonSourceMaximum('messages/ta.json')));
 assert.equal(SINGLETON_FILES['messages/ta.json'],undefined); // A size bound is not test/profile admission.
 const planner=readFileSync(new URL('./plan.mjs',import.meta.url),'utf8');
 const admission=readFileSync(new URL('../../test/helpers/ci-singleton-admission.ts',import.meta.url),'utf8');
 assert(planner.includes('lstatSync(path).size>singletonSourceMaximum(file)'));
 assert(admission.includes('regular(join(source,path),singletonSourceMaximum(path))'));
 assert(!planner.includes('size>4194304'));assert(!admission.includes('regular(join(source,path),4194304)'));
});
test('both Rewards jobs retain and hash the complete large Tamil dependency without a generic limit increase',()=>{
 const root=fileURLToPath(new URL('../../',import.meta.url)),file='messages/ta.json';
 const raw=readFileSync(new URL('../../'+file,import.meta.url)),info=lstatSync(new URL('../../'+file,import.meta.url));
 assert(info.isFile()&&!info.isSymbolicLink());assert.equal(raw.length,info.size);
 assert(raw.length>4*1024*1024&&raw.length<=singletonSourceMaximum(file));
 const committed=execFileSync('git',['show','HEAD:'+file],{cwd:root,maxBuffer:8*1024*1024});
 assert(raw.equals(committed));assert.equal(createHash('sha256').update(raw).digest('hex'),createHash('sha256').update(committed).digest('hex'));
 for(const selected of ['test/rewards-audit-policy-native.test.ts','test/rewards-audited-read-prototype.test.ts']){
  const sources=singletonSources(fixture(selected).unit,candidateRoot);assert.equal(sources.filter(path=>path===file).length,1);
  const large=sources.filter(path=>lstatSync(new URL('../../'+path,import.meta.url)).size>4*1024*1024);
  assert.deepEqual(large,[file]);
  for(const path of sources)assert(lstatSync(new URL('../../'+path,import.meta.url)).size<=singletonSourceMaximum(path),path);
 }
});
test('Rewards native policy and original read family retain complete isolated source-bound jobs',()=>{
 const files=['test/rewards-audit-policy-native.test.ts','test/rewards-audited-read-prototype.test.ts'];
 const critical=[
  '.github/ci/rewards-native-sources.mjs','test/prototypes/rewards-audit-policy-native-cases.ts',
  'test/prototypes/rewards-audit-policy-owner.ts','test/prototypes/rewards-audit-policy-controller.ts',
  'test/prototypes/rewards-audit-policy-lifetime.ts','test/prototypes/rewards-audit-policy-controlled-wait.ts',
  'test/prototypes/rewards-audit-policy-contract.ts','test/prototypes/rewards-audit-policy.sql',
  'test/prototypes/rewards-audit-policy-predecessors.json','test/prototypes/rewards-audit-policy-reader-process.ts',
  'test/prototypes/rewards-audit-policy-reader-child.ts','test/prototypes/rewards-audit-startup.ts',
  'test/prototypes/rewards-audited-read-family.ts','test/prototypes/rewards-audited-read-owner-factory.ts',
  'test/prototypes/rewards-audited-read-owner.ts','test/prototypes/rewards-audited-read-ownership.ts',
  'test/prototypes/rewards-audited-read-port.ts','test/prototypes/rewards-audited-read.sql',
  'test/prototypes/rewards-audited-read-predecessors.json','test/prototypes/rewards-audit-projection-race.ts',
  'test/prototypes/rewards-audit-projector-process.ts','test/prototypes/rewards-audit-projector-child.ts',
  'test/harness.ts','test/rewards-setup-fixture.ts','db/client.ts','db/schema.ts','db/events.ts',
  'core/org.ts','core/comp.ts','core/admin.ts','core/audit-chain.ts','core/audit-chain-arming.ts',
  'core/ai-centre-control.ts','core/module-presentation-read.ts','lib/ai/centre-activity.ts',
  'core/assistant-actions/bank-maintenance-review-store.ts','core/assistant-actions/position-archive-review-store.ts',
  'packs/rewards/setup-query-owner.ts','packs/rewards/setup-legacy-query-port.ts',
  'localization/registry.ts','lib/hr-date.ts','db/migrations/meta/_journal.json',
  'db/migrations/0863_assistant_bank_effect_closure.sql','db/migrations/0864_assistant_catalogue_effect_closure.sql',
  'db/migrations/3210_attendance_shared_workflow_submission_lock.sql','db/migrations/3211_access_editor_native_owner_presentation.sql',
  'test/fixtures/historical-migrations/2301_attendance_workflow_submission_shared_lock.sql','test/fixtures/historical-migrations/3103_access_editor_presentation.sql',
  'db/migrations/3200_ai_centre_controls.sql','db/migrations/3201_ai_centre_function_coverage.sql',
  'db/migrations/3500_ai_centre_architecture_compatibility.sql','db/migrations/3501_ai_centre_mandate_write_order.sql',
  "lib/maybank-payment-settings.ts",
  "localization/my/maybank-v74-file.ts",
  "lib/attendance-formula-allocation.ts",
  "lib/system-label-assignment.ts",
  "packs/attendance/formula-sources.ts",
  "lib/attendance-formula-catalog.ts",
  "lib/attendance-formula-overtime.ts",
  "core/attendance-formula-leave.ts",
  "core/attendance-formula-measurements.ts",
  "core/attendance-formulas.ts",
  "lib/attendance-formula-model.ts",
  "lib/attendance-formula-language.ts",
  "lib/attendance-formula-periods.ts",
  "lib/pay-component-company.ts",
  "core/attendance-formula-ai.ts",
  "lib/attendance-formula-ai.ts",
  "lib/attendance-formula-bindings.ts",
  "lib/attendance-formula-posting.ts",
  "core/pay-component-company.ts",
  "core/system-label-selection.ts",
  "lib/authz.ts",
  "lib/session.ts",
  "lib/identity/config.ts",
  "lib/auth-errors.ts",
  "lib/demo-mode.ts",
  "lib/mobile-api/jwt.ts",
  "lib/internal-auth/web-session.ts",
  "lib/entra/sessions.ts",
  "lib/session-policy-server.ts",
  "lib/session-policy.ts",
  "lib/entra/model.ts",
  "lib/entra/store.ts",
  "lib/internal-auth/service.ts",
  "lib/internal-auth/account-expiry.ts",
  "lib/internal-auth/remembered-mfa.ts",
  "lib/remembered-mfa-policy.ts",
  "lib/internal-auth/login-lockout.ts",
  "lib/identity/session.ts",
  "lib/identity/cookie.ts",
  "lib/identity/seal.ts",
  "lib/identity/oidc.ts",
  "lib/workos.ts",
  "core/payroll-audit/reader-grant.ts",
  "packs/payroll/individual-calculation.ts",
  "packs/rewards/preparation-model.ts",
  "packs/rewards/dashboard-model.ts",
  "test/fixtures/notification-worker/final-catalogue-replay-prerequisite.ts",
  "test/fixtures/notification-worker/canonical-inventory.ts",
  "test/fixtures/notification-worker/replay-prefix-ownership.ts",
 ];
 const journal=JSON.parse(readFileSync(new URL('../../db/migrations/meta/_journal.json',import.meta.url)));
 const journalSql=journal.entries.map(row=>'db/migrations/'+row.tag+'.sql');
 const physicalSql=readdirSync(new URL('../../db/migrations/',import.meta.url)).filter(name=>name.endsWith('.sql')).sort().map(name=>'db/migrations/'+name);
 assert.deepEqual(physicalSql,[...journalSql].sort());
 for(const file of files){
  const f=fixture(file),sources=singletonSources(f.unit,candidateRoot);
  assert.deepEqual(f.unit.singleton,{version:1,profile:'controlled-database-v1',workers:1,isolation:'job-postgres-cluster'});
  assert.equal(f.unit.kind,'db');assert.deepEqual(f.unit.files,[file]);assert.equal(new Set(sources).size,sources.length);
  validateSingletonHost(f);validateSingletonBinding(f.binding,f.plan,f.unit,f.witness,candidateRoot);
  for(const entry of journal.entries)assert(sources.includes('db/migrations/'+entry.tag+'.sql'));
  for(const path of physicalSql)assert(sources.includes(path),'Actual Rewards SQL/fingerprint input omitted: '+path);
  for(const source of critical){
   assert(sources.includes(source),source);assert(readFileSync(new URL('../../'+source,import.meta.url)).length>0);
   const changed=structuredClone(f);delete changed.plan.singletonSources[changed.unit.id][source];delete changed.binding.sourceHashes[source];
   const{fingerprint:_fingerprint,...body}=changed.plan;changed.plan.fingerprint=protocolHash(body);changed.binding.fingerprint=changed.plan.fingerprint;
   assert.throws(()=>validateSingletonBinding(changed.binding,changed.plan,changed.unit,changed.witness,candidateRoot));
  }
  assert.throws(()=>assertSingletonSelection([file,'test/ordinary.test.ts']));
  assert.throws(()=>assertSingletonCoverage([file],()=>"it('unadmitted',()=>{});"));
  const text=readFileSync(new URL('../../'+file,import.meta.url),'utf8');
  assert(text.includes("admitSingletonTest('"+file+"')"));assert(!/AIHR_FOCUSED_|\.(?:skipIf|runIf)\s*\(/.test(text));
 }
 const wrapper=readFileSync(new URL('../../test/rewards-audit-policy-native.test.ts',import.meta.url),'utf8');
 assert(wrapper.indexOf("admitSingletonTest('")<wrapper.indexOf('registerRewardsAuditPolicyNativeCases();'));
 const existing=readFileSync(new URL('../../test/rewards-audited-read-prototype.test.ts',import.meta.url),'utf8');
 assert(existing.indexOf("admitSingletonTest('")<existing.indexOf('beforeAll(async()=>'));
});

test('only the exact five delegated entries may use the shared FIRST actual singleton admission owner',async()=>{
 const {EMPLOYEE_LIFECYCLE_PROFILE}=await import('./employee-lifecycle-profile.mjs');
 const helper='test/performance/employee-choice-lifecycle-admission.ts',read=path=>readFileSync(new URL('../../'+path,import.meta.url),'utf8');
 for(const {file}of EMPLOYEE_LIFECYCLE_PROFILE.files){
  assertSingletonCoverage([file],read);
  const delegates={'test/employee-choice-native-purpose-plan.test.ts':'classic','test/employee-choice-exact-ascii-plan.test.ts':'exact-ascii'};
  const refuse=(target,change)=>assert.throws(()=>assertSingletonCoverage([file],path=>path===target?change(read(path)):read(path)));
  if(Object.hasOwn(delegates,file)){
   const purpose=delegates[file],shared='test/performance/employee-choice-benchmark-harness.ts',contract='test/performance/employee-choice-benchmark-contract.ts';
   for(const change of [text=>text.replace("registerEmployeeChoiceBenchmark('"+purpose+"')","registerEmployeeChoiceBenchmark('foreign')"),text=>text.replace("registerEmployeeChoiceBenchmark('"+purpose+"')","registerEmployeeChoiceBenchmark('"+(purpose==='classic'?'exact-ascii':'classic')+"')"),text=>text.replace('employee-choice-benchmark-harness','foreign-owner'),text=>text+"\nbeforeAll(()=>{});",text=>text+"\nit.skipIf(true)('skipped',()=>{});"])refuse(file,change);
   for(const change of [text=>text.replace('const lifecycle=admitEmployeeChoiceLifecycle(file);',''),text=>text.replace('const lifecycle=admitEmployeeChoiceLifecycle(file);\nbeforeAll','beforeAll\nconst lifecycle=admitEmployeeChoiceLifecycle(file);'),text=>text.replace("from './employee-choice-lifecycle-admission'","from './foreign'"),text=>text.replace('const file=contract.file;',"const file='test/foreign.test.ts';"),text=>text+"\nit.skipIf(true)('skipped',()=>{});",text=>text+'\n'])refuse(shared,change);
   for(const change of [text=>text.replace("file:'"+file+"'","file:'test/foreign.test.ts'"),text=>text.replace("if(!Object.hasOwn(contracts,purpose))throw Error('Unknown closed employee benchmark purpose');",''),text=>text+'\n'])refuse(contract,change);
  }else{
   for(const change of [text=>text.replace(/admitEmployeeChoiceLifecycle\((?:file|'[^']+')\)/g,'unadmitted()'),text=>text.replace("from './performance/employee-choice-lifecycle-admission'","from './performance/foreign'"),text=>text.replaceAll(file,'test/employee-choice-foreign.test.ts'),text=>"import {registerEmployeeChoiceBenchmark} from './performance/employee-choice-benchmark-harness';\nregisterEmployeeChoiceBenchmark('classic');\n"])refuse(file,change);
  }
  assert.throws(()=>assertSingletonCoverage([file],path=>path===helper?read(path).replace('const admission=admitSingletonTest(file);','const admission=JSON.parse("{}");'):read(path)));
  assert.throws(()=>assertSingletonCoverage([file],path=>path===helper?read(path).replace('const admission=admitSingletonTest(file);','const caller=true;const admission=admitSingletonTest(file);'):read(path)));
 }
 assert.throws(()=>assertSingletonCoverage(['test/analytics-termination-lateral.test.ts'],()=>"admitEmployeeChoiceLifecycle('test/analytics-termination-lateral.test.ts');"));
});


test('shared module JIT diagnostic owns one unchanged controlled database and cannot omit any actual imported source',()=>{
 const file='test/module-read-jit-diagnostic.test.ts',f=fixture(file),sources=singletonSources(f.unit,candidateRoot);
 assert.deepEqual(f.unit.singleton,{version:1,profile:'controlled-database-v1',workers:1,isolation:'job-postgres-cluster'});
 assert.equal(f.unit.kind,'db');assert.deepEqual(f.unit.files,[file]);assert.equal(new Set(sources).size,sources.length);
 assert.equal(sources.length,1586);assert.equal(createHash('sha256').update(JSON.stringify(sources)).digest('hex'),'489ea9de464aab73508c8ce48e445df4e43be58a8a72ae48bb64039d135a2056');
 assert(sources.includes('packs/payroll/individual-calculation.ts'),'Actual Payroll calculation owner omitted');
 for(const required of ["core/ai-centre-control.ts", "db/migrations/3200_ai_centre_controls.sql", "db/migrations/3201_ai_centre_function_coverage.sql", "db/migrations/3500_ai_centre_architecture_compatibility.sql", "db/migrations/3501_ai_centre_mandate_write_order.sql", "lib/ai/centre-activity.ts", "test/helpers/native-read-observer.ts","lib/maybank-payment-settings.ts","localization/my/maybank-v74-file.ts","lib/attendance-formula-allocation.ts","lib/system-label-assignment.ts","packs/attendance/formula-sources.ts","lib/attendance-formula-catalog.ts","lib/attendance-formula-overtime.ts","core/attendance-formula-leave.ts","core/attendance-formula-measurements.ts","core/attendance-formulas.ts","lib/attendance-formula-model.ts","lib/attendance-formula-language.ts","lib/attendance-formula-periods.ts","lib/pay-component-company.ts","core/attendance-formula-ai.ts","lib/attendance-formula-ai.ts","lib/attendance-formula-bindings.ts","lib/attendance-formula-posting.ts","core/pay-component-company.ts","core/system-label-selection.ts"])assert(sources.includes(required),'Actual JIT read owner omitted: '+required);
 const journalBytes=readFileSync(new URL('../../'+journalPath,import.meta.url)),journal=JSON.parse(journalBytes.toString('utf8'));
 const inputs=Object.freeze({sources:Object.freeze(sources),journalSha256:createHash('sha256').update(journalBytes).digest('hex')});
 const journalSql=journal.entries.map(row=>'db/migrations/'+row.tag+'.sql');
 const physicalSql=readdirSync(new URL('../../db/migrations/',import.meta.url)).filter(name=>name.endsWith('.sql')).sort().map(name=>'db/migrations/'+name);
 for(const path of [...journalSql,...physicalSql])assert(sources.includes(path),'Actual canonical SQL/fingerprint input omitted: '+path);
 assert.deepEqual(physicalSql,[...journalSql].sort());
 validateSingletonHost(f);validateSingletonBinding(f.binding,f.plan,f.unit,f.witness,candidateRoot);
 const omissionHashes={...f.binding.sourceHashes};
 for(const source of sources){
  const bytes=readFileSync(new URL('../../'+source,import.meta.url));assert(bytes.length>0&&bytes.length<=singletonSourceMaximum(source),source);
  assert(Object.hasOwn(omissionHashes,source),source);
  const digest=omissionHashes[source];delete omissionHashes[source];
  try{assert.throws(()=>assertSingletonSourceHashes(omissionHashes,inputs),/Singleton source membership differs/,source);}
  finally{omissionHashes[source]=digest;}
 }
 assert.deepEqual(omissionHashes,f.binding.sourceHashes);
 assertSingletonSourceHashes(omissionHashes,inputs);

 const dependency='test/helpers/native-read-observer.ts',canonicalSql='db/migrations/3500_ai_centre_architecture_compatibility.sql';
 const foreign='test/foreign.test.ts',membership=/Singleton source membership differs/;
 assert(!sources.includes(foreign));
 for(const [label,mutate,reason] of [
  ['registered entry',hashes=>delete hashes[file],membership],
  ['non-SQL dependency',hashes=>delete hashes[dependency],membership],
  ['canonical SQL',hashes=>delete hashes[canonicalSql],membership],
  ['same-size foreign substitution',hashes=>{hashes[foreign]=hashes[dependency];delete hashes[dependency];},membership],
  ['journal bytes',hashes=>{hashes[journalPath]='0'.repeat(64);},/Canonical journal bytes differ/],
  ['invalid digest',hashes=>{hashes[dependency]='invalid';},/Invalid singleton source hash/],
 ]){
  const changed=structuredClone(f),hashes=changed.plan.singletonSources[changed.unit.id];
  mutate(hashes);changed.binding.sourceHashes=hashes;
  const {fingerprint:_fingerprint,...body}=changed.plan;changed.plan.fingerprint=protocolHash(body);changed.binding.fingerprint=changed.plan.fingerprint;
  assert.throws(()=>validateSingletonBinding(changed.binding,changed.plan,changed.unit,changed.witness,candidateRoot),reason,label);
 }
 assert.throws(()=>assertSingletonSelection([file,'test/ordinary.test.ts']));assert.throws(()=>assertSingletonCoverage([file],()=>"it('unadmitted',()=>{});"));
 const text=readFileSync(new URL('../../'+file,import.meta.url),'utf8');
 assert(text.indexOf("admitSingletonTest('"+file+"')")<text.indexOf('beforeAll(migrateTestDb)'));
 assert(!/AIHR_FOCUSED_|\.(?:skipIf|runIf)\s*\(/.test(text));
 assertSingletonCoverage([file],path=>readFileSync(new URL('../../'+path,import.meta.url),'utf8'));
});


test('both selected-prefix AI upgrades require sole authenticated controlled jobs and every actual source owner',()=>{
 const files=['test/ai-centre-architecture-compatibility-upgrade.test.ts','test/ai-centre-mandate-write-order-upgrade.test.ts'];
 const owned=[
  ".github/ci/candidate-environment.mjs",
  ".github/ci/employee-lifecycle-profile.mjs",
  ".github/ci/employee-lifecycle-sources.mjs",
  ".github/ci/historical-migrations/0180_profile_option.sql",
  ".github/ci/historical-migrations/0212_dashboard_card_config.sql",
  ".github/ci/native-next-helper-sources.mjs",
  ".github/ci/native-next-installation.mjs",
  ".github/ci/policy-version.mjs",
  ".github/ci/postgres-evidence.mjs",
  ".github/ci/rewards-native-sources.mjs",
  ".github/ci/singleton-protocol.mjs",
  "core/audit-chain-arming.ts",
  "core/entitlement-types.ts",
  "db/admission.ts",
  "db/background-read-admission.ts",
  "db/capacity.ts",
  "db/client.ts",
  "db/tenant-write-admission.ts",
  "db/workload.ts",
  "test/db-names.ts",
  "test/fixtures/historical-migrations/2301_attendance_workflow_submission_shared_lock.sql",
  "test/fixtures/historical-migrations/3103_access_editor_presentation.sql",
  "test/helpers/ai-centre-compatibility-owner-constructor.ts",
  "test/helpers/ci-singleton-admission.ts",
 "test/fixtures/notification-worker/final-catalogue-replay-prerequisite.ts",
 "test/fixtures/notification-worker/canonical-inventory.ts",
 "test/fixtures/notification-worker/replay-prefix-ownership.ts"
];
 for(const file of files){
  const f=fixture(file),sources=singletonSources(f.unit,candidateRoot);
  assert.deepEqual(f.unit.files,[file]);assert.equal(f.unit.kind,'db');
  assert.deepEqual(f.unit.singleton,{version:1,profile:'controlled-database-v1',workers:1,isolation:'job-postgres-cluster'});
  validateSingletonHost(f);validateSingletonBinding(f.binding,f.plan,f.unit,f.witness,candidateRoot);
  assert.equal(new Set(sources).size,sources.length);
  for(const source of [file,...owned]){
   assert(sources.includes(source),source);assert(readFileSync(new URL('../../'+source,import.meta.url)).length>0);
   const changed=structuredClone(f);delete changed.plan.singletonSources[changed.unit.id][source];delete changed.binding.sourceHashes[source];
   const{fingerprint:_fingerprint,...body}=changed.plan;changed.plan.fingerprint=protocolHash(body);changed.binding.fingerprint=changed.plan.fingerprint;
   assert.throws(()=>validateSingletonBinding(changed.binding,changed.plan,changed.unit,changed.witness,candidateRoot),source);
  }
  assert.throws(()=>assertSingletonSelection([file,'test/ordinary.test.ts']));
  assert.throws(()=>assertSingletonCoverage([file],()=>"it('unadmitted',()=>{});"));
  for(const mutate of [v=>{v.unit.singleton.workers=2;},v=>{v.unit.singleton.profile='notification-cluster-v1';},v=>{v.binding.prerequisites.workers=2;},v=>{v.binding.prerequisites.kind='shared-cluster';},v=>{v.env.AIHR_FOCUSED_SUITE_CAPACITY='true';},v=>{v.env.GITHUB_RUN_ATTEMPT='2';}]){const changed=structuredClone(f);mutate(changed);assert.throws(()=>{validateSingletonHost(changed);validateSingletonBinding(changed.binding,changed.plan,changed.unit,changed.witness,candidateRoot);});}
  const text=readFileSync(new URL('../../'+file,import.meta.url),'utf8');
  assert(text.indexOf("admitSingletonTest('"+file+"')")<text.indexOf("it('"));
  assert(text.includes('writeFileSync(join(admission.evidenceDirectory,'));assert(text.includes('context.signal,caseStartedAt)'));
  assert(!/process\.env\.AIHR_FOCUSED_|\.(?:skipIf|runIf)\s*\(/.test(text));
 }
});

test('host cache conformance owns a distinct complete host-only source-bound singleton',()=>{
 const file='test/runtime-next-host-view-native.test.ts',f=fixture(file);
 assert.equal(f.unit.kind,'nodb');assert.deepEqual(f.unit.files,[file]);
 assert.deepEqual(f.unit.singleton,{version:1,profile:'linux-systemd-nginx-v1',workers:1,isolation:'job-host'});
 assert.equal(nativeNextUnit(f.unit),false);assert.equal(singletonJobName(f.unit),`test (${f.unit.id})`);
 validateSingletonHost(f);validateSingletonBinding(f.binding,f.plan,f.unit,f.witness);
 const required=['deploy/admission/test_next_host_view_native.py','deploy/admission/next_fixture_poststart.py','deploy/admission/test_next_native.py','deploy/admission/next_profile.py','.github/ci/runtime_inventory.py','deploy/admission/controller.py',
  '.github/ci/singleton-profiles.mjs','.github/ci/run-unit.mjs','.github/ci/plan.mjs','.github/ci/manifest.mjs',
  '.github/ci/candidate-environment.mjs','.github/actions/setup-alpha/action.yml','.github/workflows/alpha-staging.yml','scripts/gate-db-classify.ts'];
 for(const source of required){
  assert(singletonSources(f.unit).includes(source));
  const changed=structuredClone(f.binding);delete changed.sourceHashes[source];
  assert.throws(()=>validateSingletonBinding(changed,f.plan,f.unit,f.witness));
  const tampered=structuredClone(f.binding);tampered.sourceHashes[source]='0'.repeat(64);
  assert.throws(()=>validateSingletonBinding(tampered,f.plan,f.unit,f.witness));
 }
 const borrowed=fixture();assert.notEqual(f.unit.id,borrowed.unit.id);
 assert.throws(()=>validateSingletonBinding(borrowed.binding,f.plan,f.unit,f.witness));
 assert.throws(()=>validateSingletonBinding({...f.binding,prerequisites:{kind:'fresh-job-postgres-cluster',workers:1,database:{}}},f.plan,f.unit,f.witness));
 const source=readFileSync(new URL('../../'+file,import.meta.url),'utf8');
 assert(source.includes("admitSingletonTest('"+file+"')"));assert(source.includes('timeout:30000'));assert(source.includes('},35000)'));
 assert(!source.includes('240000'));assert(source.includes("'next_preparation.py','deploy/admission/test_next_native.py'"));assert(!source.includes('.skipIf('));
});
