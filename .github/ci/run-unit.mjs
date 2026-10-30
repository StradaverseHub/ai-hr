/** One exact CI partition; every DB batch gets a fresh, job-owned PostgreSQL container. */
import {spawnSync,execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync, lstatSync, openSync, fstatSync, closeSync, constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const postgres = fileURLToPath(new URL('./postgres.sh', import.meta.url));
import {capturePostgresEvidence,validatePostgresEvidence,postgresProfileFromEnv} from './postgres-evidence.mjs';
import {hostHealth} from './host-health.mjs';
import {createPlan,hash} from './plan.mjs';
import {DB_BATCH_FILES} from './manifest.mjs';
import {validatePdfSetupProof} from './pdf-tools.mjs';

// Frozen full-CI handshake v1. Diagnostic setup receipt only; never installation/release authority.
export const FULL_CI_ROLE_HINTS=Object.freeze(['AIHR_CI_DISPOSABLE_ROLE_MODE','AIHR_CI_ROLE_UNIT','AIHR_CI_ROLE_BATCH_OFFSET','AIHR_CI_ROLE_EVIDENCE_DIR','AIHR_CI_ROLE_PLAN_FINGERPRINT']);
const fullRoleMode='full_ci_disposable',fullRoleKind='PERSONNEL_DRAFT_DISCARD_FULL_CI_ROLE_PREREQUISITES';
const fullRoleScope='disposable CI setup only; no native, installation or release attestation';
const fullRoleSources=Object.freeze({helperSha256:'test/helpers/personnel-draft-discard-ci-role-fixture.ts',wrapperSha256:'scripts/migrate-with-focused-prerequisites.ts',orchestrationSha256:'scripts/lib/discard-premigration.ts'});
export const FULL_CI_ROLE_URLS=Object.freeze({DATABASE_URL:'postgres://ai_hr_app@127.0.0.1:5433/ai_hr_dev',MIGRATION_DATABASE_URL:'postgres://postgres@127.0.0.1:5433/ai_hr_dev',TEST_DATABASE_URL:'postgres://ai_hr_app@127.0.0.1:5433/ai_hr_test',TEST_MIGRATION_DATABASE_URL:'postgres://postgres@127.0.0.1:5433/ai_hr_test'});
const exactKeys=(value,keys)=>{assert(value&&typeof value==='object'&&!Array.isArray(value));assert.deepEqual(Object.keys(value).sort(),[...keys].sort());};
const fullSha=value=>typeof value==='string'&&/^[0-9a-f]{40}$/.test(value);
const sourceSha=value=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value);
const positiveId=value=>typeof value==='string'&&/^[1-9][0-9]*$/.test(value);
export function assertNoFullCiRoleHints(env){
 assert(!Object.keys(env).some(key=>key==='AIHR_CI_DISPOSABLE_ROLE_MODE'||key.startsWith('AIHR_CI_ROLE_')),'Inherited disposable-role hints are forbidden');
}
export function fullCiRoleBinding({plan,unit,offset,batchSize,files,env,resetStatus,event,layout,sourceHashes}){
 assertNoFullCiRoleHints(env);
 assert.equal(resetStatus,0,'Role setup requires a successful owned DB reset');
 assert.equal(unit.kind,'db');assert.equal(batchSize,DB_BATCH_FILES);
 assert(Number.isSafeInteger(offset)&&offset>=0&&offset<unit.files.length&&offset%DB_BATCH_FILES===0);
 assert.equal(plan.units.filter(row=>row.id===unit.id).length,1);assert.deepEqual(plan.units.find(row=>row.id===unit.id),unit);
 assert.deepEqual(files,unit.files.slice(offset,offset+DB_BATCH_FILES));assert(files.length>0);
 const {fingerprint,...body}=plan;assert.equal(hash(body),fingerprint,'Reconstructed actual plan fingerprint differs');
 assert(fullSha(plan.sha)&&fullSha(plan.controller));
 assert.equal(env.GITHUB_ACTIONS,'true');assert.equal(env.CI,'true');assert.equal(env.RUNNER_ENVIRONMENT,'github-hosted');assert.equal(env.RUNNER_OS,'Linux');
 assert.equal(env.GITHUB_REPOSITORY,'StradaverseHub/ai-hr');assert.equal(env.GITHUB_REPOSITORY_ID,'1333414856');assert.equal(env.GITHUB_WORKFLOW,'alpha-staging-ci');assert.equal(env.GITHUB_JOB,'test');
 assert(positiveId(env.GITHUB_RUN_ID)&&positiveId(env.GITHUB_RUN_ATTEMPT));assert.equal(env.AIHR_CI_HEAD,plan.sha);assert.equal(env.AIHR_CI_CONTROL_HEAD,plan.controller);assert.equal(env.GITHUB_SHA,plan.controller);
 assert.equal(layout.platform,'linux');assert.equal(layout.sourceHead,plan.sha);assert.equal(layout.controllerHead,plan.controller);assert.equal(layout.sourceClean,true);assert.equal(layout.controllerClean,true);
 assert.equal(layout.source,join(layout.workspace,'source'));assert.equal(layout.automation,join(layout.workspace,'automation'));assert.equal(layout.cwd,layout.source);
 assert.equal(layout.evidence,join(layout.temp,'aihr-ci'));assert.equal(layout.controllerScript,join(layout.automation,'.github/ci/run-unit.mjs'));
 assert.equal(event?.repository?.full_name,'StradaverseHub/ai-hr');assert.equal(String(event.repository.id),'1333414856');
 const workflow='StradaverseHub/ai-hr/.github/workflows/alpha-staging.yml@';assert(typeof env.GITHUB_WORKFLOW_REF==='string'&&env.GITHUB_WORKFLOW_REF.startsWith(workflow));
 const workflowRef=env.GITHUB_WORKFLOW_REF.slice(workflow.length);
 if(env.GITHUB_EVENT_NAME==='workflow_dispatch'){
  assert(/^refs\/heads\/[A-Za-z0-9_./-]+$/.test(workflowRef));
  if(event.inputs?.expected_sha)assert.equal(event.inputs.expected_sha,plan.sha);
 }else if(env.GITHUB_EVENT_NAME==='push'){
  assert.equal(event.ref,'refs/heads/alpha');assert.equal(workflowRef,'refs/heads/alpha');assert.equal(event.after,plan.sha);assert.equal(plan.sha,plan.controller);
 }else if(env.GITHUB_EVENT_NAME==='pull_request'){
  const pr=event.pull_request;assert(pr&&pr.draft===false);assert.equal(pr.base?.ref,'alpha');assert.equal(pr.head?.repo?.full_name,'StradaverseHub/ai-hr');assert.equal(String(pr.head.repo.id),'1333414856');assert.equal(pr.head.sha,plan.sha);assert.equal(pr.merge_commit_sha,plan.controller);assert(positiveId(String(event.number)));assert.equal(workflowRef,`refs/pull/${event.number}/merge`);
 }else assert.fail('Unsupported full-CI event');
 assert(!('AIHR_FOCUSED_SUITE_CAPACITY'in env)&&!('AIHR_FOCUSED_TESTS'in env)&&(env.TEST_DB_NAMESPACE===undefined||env.TEST_DB_NAMESPACE===''),'Mixed focused/full role setup');
 exactKeys(sourceHashes,Object.keys(fullRoleSources));for(const digest of Object.values(sourceHashes))assert(sourceSha(digest));
 return Object.freeze({mode:fullRoleMode,candidate:plan.sha,controller:plan.controller,runId:env.GITHUB_RUN_ID,attempt:env.GITHUB_RUN_ATTEMPT,unit:unit.id,offset,planFingerprint:fingerprint,batchSize,batchFiles:Object.freeze([...files])});
}
export function fullCiRoleMigrationEnvironment(env,binding,evidence){
 assertNoFullCiRoleHints(env);assert.equal(binding.mode,fullRoleMode);
 return {...env,...FULL_CI_ROLE_URLS,AIHR_CI_DISPOSABLE_ROLE_MODE:fullRoleMode,AIHR_CI_ROLE_UNIT:binding.unit,AIHR_CI_ROLE_BATCH_OFFSET:String(binding.offset),AIHR_CI_ROLE_EVIDENCE_DIR:evidence,AIHR_CI_ROLE_PLAN_FINGERPRINT:binding.planFingerprint};
}
export function validateFullCiRoleReceipt(receipt,binding,sourceHashes){
 exactKeys(receipt,[...Object.keys(binding),'schemaVersion','kind','phase','scope',...Object.keys(fullRoleSources),'fixture']);
 for(const [key,value]of Object.entries(binding))assert.deepEqual(receipt[key],value,`Role prerequisite binding differs: ${key}`);
 assert.equal(receipt.schemaVersion,1);assert.equal(receipt.kind,fullRoleKind);assert.equal(receipt.phase,'before_initial_candidate_migration');assert.equal(receipt.scope,fullRoleScope);
 for(const [key,value]of Object.entries(sourceHashes))assert.equal(receipt[key],value);
 const fixture=receipt.fixture;exactKeys(fixture,['mode','roles','edges','postgres']);assert.equal(fixture.mode,fullRoleMode);
 assert(Array.isArray(fixture.roles)&&fixture.roles.length===3);assert(Array.isArray(fixture.edges)&&fixture.edges.length===2);
 const names=['ai_hr_app','ai_hr_draft_discard_port','ai_hr_owner'];assert.deepEqual(fixture.roles.map(role=>role.name),names);
 const oids=new Set();for(const role of fixture.roles){
  exactKeys(role,['oid','name','login','inherit','super','createDb','createRole','replication','bypassRls','connectionLimit','validUntil']);
  assert(Number.isSafeInteger(role.oid)&&role.oid>0&&!oids.has(role.oid));oids.add(role.oid);
  assert.equal(role.login,role.name!=='ai_hr_draft_discard_port');assert.equal(role.inherit,true);
  for(const key of ['super','createDb','createRole','replication','bypassRls'])assert.equal(role[key],false);
  assert.equal(role.connectionLimit,-1);assert.equal(role.validUntil,null);
 }
 assert.deepEqual(fixture.edges,[{role:'ai_hr_app',member:'ai_hr_draft_discard_port',grantor:'postgres',inherit:true,set:false,admin:false},{role:'ai_hr_draft_discard_port',member:'ai_hr_owner',grantor:'postgres',inherit:false,set:true,admin:false}]);
 exactKeys(fixture.postgres,['versionNumber','versionText','session','current']);
 assert(Number.isSafeInteger(fixture.postgres.versionNumber)&&fixture.postgres.versionNumber>=160000&&fixture.postgres.versionNumber<170000);assert(typeof fixture.postgres.versionText==='string');assert(/^PostgreSQL 16\./.test(fixture.postgres.versionText));assert.equal(fixture.postgres.session,'postgres');assert.equal(fixture.postgres.current,'postgres');
 return {kind:receipt.kind,mode:receipt.mode,unit:receipt.unit,offset:receipt.offset,planFingerprint:receipt.planFingerprint,batchSize:receipt.batchSize,batchFiles:receipt.batchFiles,...sourceHashes,postgresVersionNumber:fixture.postgres.versionNumber,roles:names,scope:receipt.scope};
}
const ownedRegularBytes=(path,maximum)=>{
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{assert.equal(realpathSync(`/proc/self/fd/${fd}`),resolve(path),'Role evidence descriptor escaped its canonical path');const stat=fstatSync(fd);assert(stat.isFile()&&stat.uid===process.getuid()&&stat.nlink===1&&stat.size>0&&stat.size<=maximum,'Expected bounded owned regular role evidence');const bytes=readFileSync(fd);assert.equal(bytes.length,stat.size);return bytes;}finally{closeSync(fd);}
};
export function readFullCiRoleReceipt(dir,binding,sourceHashes,temp){
 assert.equal(resolve(dir),realpathSync(dir));assert.equal(dir,join(realpathSync(temp),'aihr-ci'));
 const stat=lstatSync(dir);assert(stat.isDirectory()&&!stat.isSymbolicLink()&&stat.uid===process.getuid());
 const basename=`personnel-dd-full-role-${binding.unit}-offset-${binding.offset}.json`;
 assert(/^personnel-dd-full-role-db-(?:[1-4]|[0-9a-f]{16})-offset-[0-9]+\.json$/.test(basename));
 const bytes=ownedRegularBytes(join(dir,basename),32768),receipt=JSON.parse(bytes.toString('utf8'));
 return {...validateFullCiRoleReceipt(receipt,binding,sourceHashes),basename,sha256:createHash('sha256').update(bytes).digest('hex')};
}

// Applicability is inspected before DB reset or full-context/source-hash reads. No environment skip.
export function inspectFullCiRoleApplicability(read,present){
 const pkg=JSON.parse(read('package.json')),journal=JSON.parse(read('db/migrations/meta/_journal.json'));
 assert(pkg&&typeof pkg==='object'&&!Array.isArray(pkg)&&pkg.scripts&&typeof pkg.scripts['db:migrate']==='string');
 assert(journal&&typeof journal==='object'&&Array.isArray(journal.entries)&&journal.entries.length>0);
 assert(journal.entries.every(row=>row&&typeof row==='object'&&typeof row.tag==='string'&&Number.isSafeInteger(row.idx)&&Number.isSafeInteger(row.when)),'Malformed migration profile');
 assert.equal(new Set(journal.entries.map(row=>row.tag)).size,journal.entries.length,'Duplicate migration profile');
 const tag='0859_assistant_employee_draft_discard_custody',migration=`db/migrations/${tag}.sql`;
 const required=journal.entries.filter(row=>row.tag.includes('employee_draft_discard_custody'));
 const sources=Object.values(fullRoleSources);
 if(required.length===0){
  assert(!present(migration)&&sources.every(path=>!present(path)),'Partial disposable-role source profile');
  assert.equal(pkg.scripts['db:migrate'],'drizzle-kit migrate','Unsupported ordinary migration profile');
  return 'ordinary';
 }
 assert.equal(required.length,1,'Ambiguous required role migration');
 assert.deepEqual(required[0],{idx:745,version:'7',when:1793330000259,tag,breakpoints:true},'Unsupported required role journal profile');
 assert(present(migration)&&sources.every(present),'Incomplete required role source profile');
 assert.equal(pkg.scripts['db:migrate'],'node --import tsx scripts/migrate-with-focused-prerequisites.ts','Required role migration lacks its owner wrapper');
 // Existing frozen handshake constants identify this version. They are recognition, not role authority;
 // the strict context, actual source hashes and independent receipt checks remain mandatory afterwards.
 const orchestration=read(fullRoleSources.orchestrationSha256),wrapper=read(fullRoleSources.wrapperSha256),helper=read(fullRoleSources.helperSha256);
 for(const literal of ["export const FULL_CI_ROLE_MODE='full_ci_disposable' as const;","export const FULL_CI_ROLE_KIND='PERSONNEL_DRAFT_DISCARD_FULL_CI_ROLE_PREREQUISITES' as const;","export function inspectFullCiRoleAdmission(","export function fullCiRoleReceiptBasename("])assert(orchestration.includes(literal),'Unsupported full role handshake');
 for(const literal of ['environment:process.env','fullCiHost:','FULL_CI_ROLE_MODE','fullCiRoleReceiptBasename'])assert(wrapper.includes(literal),'Unsupported role wrapper profile');
 for(const literal of ['full?:FullCiRoleBinding','inspectFullCiRoleAdmission','prepareDisposableDraftDiscardRoles'])assert(helper.includes(literal),'Unsupported role helper profile');
 return fullRoleMode;
}
function actualFullCiRoleApplicability(){
 const root=process.cwd();
 return inspectFullCiRoleApplicability(file=>{const path=join(root,file);assert.equal(path,realpathSync(path));return ownedRegularBytes(path,1048576).toString('utf8');},file=>{const path=join(root,file);if(!existsSync(path))return false;assert.equal(path,realpathSync(path));assert(lstatSync(path).isFile(),'Unexpected role-profile source shape');return true;});
}
function actualFullCiRoleContext(plan,unit,offset,batchSize,files,dir,resetStatus){
 const env=process.env,workspace=realpathSync(env.GITHUB_WORKSPACE),source=realpathSync(join(workspace,'source')),automation=realpathSync(join(workspace,'automation')),temp=realpathSync(env.RUNNER_TEMP);
 assert.equal(resolve(join(workspace,'source')),source);assert.equal(resolve(join(workspace,'automation')),automation);assert.equal(resolve(dir),realpathSync(dir));
 const git=(cwd,...args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8'}).trim();
 const sourceHashes=Object.fromEntries(Object.entries(fullRoleSources).map(([key,file])=>{const path=join(source,file);assert.equal(path,realpathSync(path));return[key,createHash('sha256').update(ownedRegularBytes(path,262144)).digest('hex')];}));
 const event=JSON.parse(ownedRegularBytes(env.GITHUB_EVENT_PATH,1048576).toString('utf8'));
 const layout={platform:process.platform,workspace,source,automation,temp,evidence:realpathSync(dir),cwd:realpathSync(process.cwd()),controllerScript:realpathSync(fileURLToPath(import.meta.url)),sourceHead:git(source,'rev-parse','HEAD'),controllerHead:git(automation,'rev-parse','HEAD'),sourceClean:git(source,'status','--porcelain')==='',controllerClean:git(automation,'status','--porcelain')===''};
 const binding=fullCiRoleBinding({plan,unit,offset,batchSize,files,env,resetStatus,event,layout,sourceHashes});
 return {binding,sourceHashes,env:fullCiRoleMigrationEnvironment(env,binding,dir)};
}

export function main(){
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.CI !== 'true' || process.platform !== 'linux') throw Error('GitHub runners only; never the shared developer cluster');
assertNoFullCiRoleHints(process.env);
const [id, destination] = process.argv.slice(2), plan = createPlan(), unit = plan.units.find(u => u.id === id);
if (!unit || !destination) throw Error('Unknown CI unit or missing evidence directory');
const dir = resolve(destination); mkdirSync(dir, {recursive: true});
const report = {healthBefore: null, schemaVersion: 1, sha: plan.sha, fingerprint: plan.fingerprint, id, cwd: process.cwd(), files: unit.files, batches: [], exitCode: 1};
const closed = 'postgres://nobody:nothing@127.0.0.1:1/no_database';
let failure = false;
try {
  if(unit.kind!=='browser'){report.pdfToolSetup=JSON.parse(readFileSync(join(process.env.RUNNER_TEMP,'pdf-tools-setup.json'),'utf8'));validatePdfSetupProof(plan,unit,report.pdfToolSetup);}
  report.healthBefore = hostHealth();
  writeFileSync(join(dir, `health-before-${id}.json`), JSON.stringify(report.healthBefore,null,2)+'\n', {flag:'wx'});
  if (!report.healthBefore.ok) throw Error('Runner disk headroom too low: '+JSON.stringify(report.healthBefore));
  if(unit.kind==='db')assert.deepEqual(postgresProfileFromEnv(process.env),plan.execution.postgres,'Full CI requires the exact versioned PostgreSQL execution profile');
  const batchSize = unit.kind === 'db' ? DB_BATCH_FILES : Math.max(1, unit.files.length);
  for (let offset = 0; offset < unit.files.length; offset += batchSize) {
    const files = unit.files.slice(offset, offset + batchSize), path = join(dir, `${id}-batch-${offset}.json`);
    let rolePrerequisites=null;
    const roleProfile=unit.kind==='db'?actualFullCiRoleApplicability():null;
    if (unit.kind === 'db') {
      if (!hostHealth().ok) throw Error('Runner disk headroom too low before DB batch');
      const reset = spawnSync('bash', [postgres, 'reset'], {stdio: 'inherit', env: {...process.env, AIHR_CI_UNIT: id}});
      if (reset.status !== 0) throw Error('Owned CI PostgreSQL reset failed');
      const roleContext=roleProfile===fullRoleMode?actualFullCiRoleContext(plan,unit,offset,batchSize,files,dir,reset.status):null;
      const migrate = roleContext?spawnSync('pnpm', ['db:migrate'], {stdio: 'inherit',env:roleContext.env}):spawnSync('pnpm', ['db:migrate'], {stdio: 'inherit'});
      if(migrate.status !== 0)throw Error('CI migration failed');
      if(roleContext)rolePrerequisites=readFullCiRoleReceipt(dir,roleContext.binding,roleContext.sourceHashes,process.env.RUNNER_TEMP);
    }
    const args = ['exec', 'vitest', 'run'];
    if (unit.kind === 'nodb') args.push('--config', 'vitest.nodb.config.ts');
    if (unit.kind === 'browser') {
      // A runner-owned ignored config selects the actual engine without changing the candidate.
      mkdirSync('.vitest-attachments', {recursive:true});
      const config = '.vitest-attachments/ci-browser.config.mts';
      writeFileSync(config, `import base from '../vitest.browser.config';\nexport default {...base,test:{...base.test,browser:{...base.test.browser,instances:[{browser:${JSON.stringify(unit.engine)}}]}}};\n`);
      args.push('--config', config);
    }
    args.push(...files, '--reporter=default', '--reporter=json', '--outputFile.json=' + path);
    const env = {...process.env, VITEST_MAX_WORKERS: String(plan.execution.workers), VITEST_MAX_WORKERS_NODB: String(plan.execution.workers), AIHR_BROWSER_ENGINE: unit.engine ?? '', AIHR_TEST_DURATION_ORDER: unit.kind==='db'?'true':'false'};
    if (unit.kind !== 'db') for (const key of ['DATABASE_URL', 'MIGRATION_DATABASE_URL', 'TEST_DATABASE_URL', 'TEST_MIGRATION_DATABASE_URL']) env[key] = closed;
    const child = spawnSync('pnpm', args, {stdio: 'inherit', env});
    const exitCode = child.status ?? 1;
    const stats = unit.kind === 'db' ? spawnSync('bash', [postgres, 'stats'], {encoding:'utf8', env:{...process.env, AIHR_CI_UNIT:id}}) : null;
    const databaseEvidence=unit.kind==='db'?capturePostgresEvidence(id,plan.execution.postgres):null;
    report.batches.push({exitCode,databaseEvidence,...(rolePrerequisites?{rolePrerequisites}:{}), databaseResourceSnapshot: stats?.status === 0 ? JSON.parse(stats.stdout) : null, result: JSON.parse(readFileSync(path, 'utf8'))});
    if(databaseEvidence)validatePostgresEvidence(databaseEvidence,plan.execution);
    failure ||= exitCode !== 0;
  }
  if(createPlan().fingerprint!==plan.fingerprint)throw Error('Candidate changed during CI execution');
  report.exitCode = failure ? 1 : 0;
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error);
  throw error;
} finally {
  report.healthAfter = hostHealth();
  if (unit.kind === 'db') {
    try{report.databaseTerminalEvidence=capturePostgresEvidence(id,plan.execution.postgres);validatePostgresEvidence(report.databaseTerminalEvidence,plan.execution);}catch(error){report.databaseTelemetryError=String(error);report.exitCode=1;}
    const cleanup = spawnSync('bash', [postgres, 'stop'], {stdio: 'inherit', env: {...process.env, AIHR_CI_UNIT: id}});
    if (cleanup.status !== 0) report.exitCode = 1;
  }
  writeFileSync(join(dir, `unit-${id}.json`), JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
}
process.exitCode = report.exitCode;

}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main();
