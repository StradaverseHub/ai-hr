import {performanceRoleFixtureProfile,performanceMigrationAdmin} from './performance-role-fixture';
import {createHash} from 'node:crypto';
import {isAbsolute,join,resolve} from 'node:path';
/** Pure orchestration: no driver, helper import, connection, filesystem or process side effects.
 * The CLI supplies the actual environment and dynamically loads the strict disposable owner only
 * after focused intent. Tests inject these owners without importing provisioning code. */
export const ROLE_FIXTURE_INPUT='test/helpers/personnel-draft-discard-ci-role-fixture.ts';
export type FocusedIntentEnvironment=Readonly<Record<string,string|undefined>>;
export function hasFocusedMigrationIntent(env:FocusedIntentEnvironment):boolean{
 return env.GITHUB_WORKFLOW==='alpha-focused-checks'||env.AIHR_FOCUSED_SUITE_CAPACITY!==undefined
  ||env.TEST_DB_NAMESPACE==='aifocus'||env.TEST_DB_NAMESPACE==='_aifocus'||env.AIHR_FOCUSED_TESTS!==undefined;
}
export type FocusedRoleOwner={
 DRAFT_DISCARD_ROLE_FIXTURE_FINGERPRINT_INPUT:string;
 assertDisposableDraftDiscardFixture(admin:string,full?:FullCiRoleBinding):void;
 prepareDisposableDraftDiscardRoles(admin:string,full?:FullCiRoleBinding):Promise<unknown>;
};
export type MigrationDependencies={
 fullCiHost?:FullCiRoleHost;
 loadFocusedRoleOwner():Promise<FocusedRoleOwner>;
 fingerprint(path:string):string;
 recordPrerequisites(metadata:Readonly<Record<string,unknown>>,full?:FullCiRoleAdmission):void;
 migrate(args:readonly string[]):number;
};
export function focusedMigrationAdmin(target:string|undefined,testTarget:string|undefined):string{
 let url:URL;try{if(!target)throw Error();url=new URL(target);}catch{throw Error('Focused migration target is not the canonical disposable development database.');}
 if(!['postgres:','postgresql:'].includes(url.protocol)||url.hostname!=='127.0.0.1'||url.port!=='5433'
  ||url.username!=='postgres'||url.password!==''||url.pathname!=='/ai_hr_dev'||url.search!==''||url.hash!=='')
  throw Error('Focused migration target is not the canonical disposable development database.');
 let test:URL;try{if(!testTarget)throw Error();test=new URL(testTarget);}catch{throw Error('Focused test migration target is unavailable.');}
 if(!['postgres:','postgresql:'].includes(test.protocol)||test.username!=='postgres'||test.password!==''||test.search!==''||test.hash!==''
  ||!/^\/ai_hr_test(?:_tpl_aifocus|_w_aifocus[1-9][0-9]*)?$/.test(test.pathname))throw Error('Focused test migration target is not canonical.');
 url.pathname='/postgres';test.pathname='/postgres';if(url.href!==test.href)throw Error('Focused migration and test clusters differ.');
 return url.toString();
}
export async function runCandidateMigration(input:{focused:boolean;environment?:FocusedIntentEnvironment;migrationTarget?:string;testMigrationTarget?:string;arguments?:readonly string[]},owners:MigrationDependencies):Promise<number>{
 const args=input.arguments??[];
 const environment=input.environment??{};
 if(hasFullCiRoleIntent(environment)){
  if(input.focused||hasFocusedMigrationIntent(environment)||Object.keys(environment).some(key=>key.startsWith('AIHR_FOCUSED_')&&environment[key]!==undefined)||args.length)throw Error('Full CI exclusive prerequisite intent refused.');
  // All identity/URL/path/actual-plan/source checks precede the dynamic database owner import.
  fullHints(environment);if(input.migrationTarget!==environment.MIGRATION_DATABASE_URL||input.testMigrationTarget!==environment.TEST_MIGRATION_DATABASE_URL)throw Error('Full CI target arguments changed.');if(!owners.fullCiHost)throw Error('Full CI observation owner unavailable.');
  const admission=inspectFullCiRoleAdmission(environment,owners.fullCiHost),owner=await owners.loadFocusedRoleOwner();
  owner.assertDisposableDraftDiscardFixture(admission.admin,admission.binding);
  if(owner.DRAFT_DISCARD_ROLE_FIXTURE_FINGERPRINT_INPUT!==ROLE_FIXTURE_INPUT)throw Error('Unexpected full CI role fixture source.');
  if(owners.fingerprint(ROLE_FIXTURE_INPUT)!==admission.sourceDigests.helper)throw Error('Full CI role fixture source changed.');
  const fixture=await owner.prepareDisposableDraftDiscardRoles(admission.admin,admission.binding);
  if(!fixture||typeof fixture!=='object'||!('mode' in fixture)||fixture.mode!==FULL_CI_ROLE_MODE)throw Error('Full CI disposable prerequisites unavailable.');
  owners.recordPrerequisites({...admission.binding,schemaVersion:1,kind:FULL_CI_ROLE_KIND,phase:'before_initial_candidate_migration',scope:FULL_CI_ROLE_SCOPE,helperSha256:admission.sourceDigests.helper,wrapperSha256:admission.sourceDigests.wrapper,orchestrationSha256:admission.sourceDigests.orchestration,fixture},admission);
  return owners.migrate(args);
 }
 if(input.focused){
  if(args.length)throw Error('Focused migration does not accept alternate CLI arguments.');
  const performance=performanceRoleFixtureProfile(environment);
  const admin=performance?.system?performanceMigrationAdmin(input.migrationTarget,input.testMigrationTarget):focusedMigrationAdmin(input.migrationTarget,input.testMigrationTarget);
  const owner=await owners.loadFocusedRoleOwner();
  // Reuse the FULL existing guard, never a new relaxed or read-only provisioning fallback.
  owner.assertDisposableDraftDiscardFixture(admin);
  if(owner.DRAFT_DISCARD_ROLE_FIXTURE_FINGERPRINT_INPUT!==ROLE_FIXTURE_INPUT)throw Error('Unexpected focused role fixture source.');
  const helperSha256=owners.fingerprint(ROLE_FIXTURE_INPUT);
  if(!/^[0-9a-f]{64}$/.test(helperSha256))throw Error('Focused role fixture fingerprint unavailable.');
  const fixture=await owner.prepareDisposableDraftDiscardRoles(admin);
  if(!fixture||typeof fixture!=='object'||!('mode' in fixture)||fixture.mode!=='focused_disposable')throw Error('Focused role fixture did not establish disposable prerequisites.');
  owners.recordPrerequisites({kind:'PERSONNEL_DRAFT_DISCARD_PREMIGRATION_ROLE_PREREQUISITES',phase:'before_initial_candidate_migration',helperSha256,fixture,
   scope:'job-owned disposable focused cluster only; no installation or native proof attestation'});
 }
 // Ordinary migrations keep their existing engine. There is no helper load/provision outside focus.
 return owners.migrate(args);
}

// Explicit full-CI setup is separate from both ordinary migration and focused intent.
export const FULL_CI_ROLE_ENV={mode:'AIHR_CI_DISPOSABLE_ROLE_MODE',unit:'AIHR_CI_ROLE_UNIT',offset:'AIHR_CI_ROLE_BATCH_OFFSET',evidence:'AIHR_CI_ROLE_EVIDENCE_DIR',plan:'AIHR_CI_ROLE_PLAN_FINGERPRINT'} as const;
export const FULL_CI_ROLE_MODE='full_ci_disposable' as const;
export const FULL_CI_ROLE_KIND='PERSONNEL_DRAFT_DISCARD_FULL_CI_ROLE_PREREQUISITES' as const;
export const FULL_CI_ROLE_SCOPE='disposable CI setup only; no native, installation or release attestation' as const;
export const FULL_CI_ROLE_URLS={DATABASE_URL:'postgres://ai_hr_app@127.0.0.1:5433/ai_hr_dev',MIGRATION_DATABASE_URL:'postgres://postgres@127.0.0.1:5433/ai_hr_dev',TEST_DATABASE_URL:'postgres://ai_hr_app@127.0.0.1:5433/ai_hr_test',TEST_MIGRATION_DATABASE_URL:'postgres://postgres@127.0.0.1:5433/ai_hr_test'} as const;
export const FULL_CI_ROLE_SOURCE={helper:ROLE_FIXTURE_INPUT,wrapper:'scripts/migrate-with-focused-prerequisites.ts',orchestration:'scripts/lib/discard-premigration.ts'} as const;
export const FULL_CI_PLAN_OBSERVER="import{pathToFileURL}from'node:url';import{resolve}from'node:path';const{createPlan}=await import(pathToFileURL(resolve('../automation/.github/ci/plan.mjs')).href);const{DB_BATCH_FILES}=await import(pathToFileURL(resolve('../automation/.github/ci/manifest.mjs')).href);process.stdout.write(JSON.stringify({plan:createPlan(),dbBatchFiles:DB_BATCH_FILES}));";
export type FullCiRoleBinding=Readonly<{mode:typeof FULL_CI_ROLE_MODE;candidate:string;controller:string;runId:string;attempt:string;unit:string;offset:number;planFingerprint:string;batchSize:number;batchFiles:readonly string[]}>;
export type FullCiRoleReceipt=FullCiRoleBinding&Readonly<{schemaVersion:1;kind:typeof FULL_CI_ROLE_KIND;phase:'before_initial_candidate_migration';scope:typeof FULL_CI_ROLE_SCOPE;helperSha256:string;wrapperSha256:string;orchestrationSha256:string;fixture:Readonly<{mode:typeof FULL_CI_ROLE_MODE;roles:readonly unknown[];edges:readonly unknown[];postgres:Readonly<{versionNumber:number;versionText:string;session:string;current:string}>}>}>;
export type FullCiRoleAdmission=Readonly<{binding:FullCiRoleBinding;admin:string;evidenceDirectory:string;sourceDigests:Readonly<{helper:string;wrapper:string;orchestration:string}>}>;
/** Injected observations keep this module driver/IO-free. Runtime adapters use only fixed argv. */
export type FullCiRoleHost=Readonly<{platform:string;cwd:string;realpath(path:string):string;read(path:string):string;git(cwd:string,args:readonly string[]):string;observePlan(cwd:string):unknown}>;
const fullFail=(reason:string):never=>{throw Error('Full CI disposable role prerequisites refused: '+reason);};
const fullNeed=(value:unknown,reason:string):void=>{if(!value)fullFail(reason);};
const fullSha=(value:unknown,length=40)=>typeof value==='string'&&new RegExp('^[a-f0-9]{'+length+'}$').test(value);
const fullRecord=(value:unknown):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value))return fullFail('object shape');return value as Record<string,unknown>;};
const fullText=(value:unknown)=>typeof value==='string'?value:fullFail('text shape');
const fullHash=(text:string)=>createHash('sha256').update(text).digest('hex');
export function hasFullCiRoleIntent(env:FocusedIntentEnvironment){return Object.keys(env).some(key=>(key.startsWith('AIHR_CI_ROLE_')||key.startsWith('AIHR_CI_DISPOSABLE_ROLE_'))&&env[key]!==undefined);}
export function fullCiRoleReceiptBasename(unit:string,offset:number){return `personnel-dd-full-role-${unit}-offset-${offset}.json`;}
function fullHints(env:FocusedIntentEnvironment){
 fullNeed(hasFullCiRoleIntent(env)&&!hasFocusedMigrationIntent(env)&&!Object.keys(env).some(key=>key.startsWith('AIHR_FOCUSED_')&&env[key]!==undefined),'exclusive mode');
 fullNeed(Object.keys(env).filter(key=>(key.startsWith('AIHR_CI_ROLE_')||key.startsWith('AIHR_CI_DISPOSABLE_ROLE_'))&&env[key]!==undefined).every(key=>(Object.values(FULL_CI_ROLE_ENV) as readonly string[]).includes(key)),'unknown full hints');
 fullNeed(Object.values(FULL_CI_ROLE_ENV).every(key=>typeof env[key]==='string'&&env[key]!==''),'partial hints');
 fullNeed(env[FULL_CI_ROLE_ENV.mode]===FULL_CI_ROLE_MODE,'mode');
 const unit=env[FULL_CI_ROLE_ENV.unit]!,offsetText=env[FULL_CI_ROLE_ENV.offset]!;
 fullNeed(/^db-[a-f0-9]{16}$/.test(unit)&&/^(0|[1-9][0-9]*)$/.test(offsetText),'unit/offset');
 const offset=Number(offsetText);fullNeed(Number.isSafeInteger(offset),'offset range');
 fullNeed(fullSha(env[FULL_CI_ROLE_ENV.plan],64),'plan fingerprint');
 return{unit,offset,planFingerprint:env[FULL_CI_ROLE_ENV.plan]!,evidence:env[FULL_CI_ROLE_ENV.evidence]!};
}
/** Bootstrap requires all five hints. Read-only rehearsal deliberately requires NONE of them. */
export function inspectFullCiRoleAdmission(env:FocusedIntentEnvironment,host:FullCiRoleHost,readonlyRehearsal=false):FullCiRoleAdmission{
 const hints=readonlyRehearsal?(fullNeed(!hasFullCiRoleIntent(env)&&!hasFocusedMigrationIntent(env)&&!Object.keys(env).some(key=>key.startsWith('AIHR_FOCUSED_')&&env[key]!==undefined),'readonly hints'),null):fullHints(env);
 fullNeed(env.GITHUB_ACTIONS==='true'&&env.CI==='true'&&env.RUNNER_ENVIRONMENT==='github-hosted'&&env.RUNNER_OS==='Linux'&&host.platform==='linux','hosted Linux');
 fullNeed(env.GITHUB_REPOSITORY==='StradaverseHub/ai-hr'&&env.GITHUB_REPOSITORY_ID==='1333414856'&&env.GITHUB_WORKFLOW==='alpha-staging-ci'&&env.GITHUB_JOB==='test','workflow identity');
 fullNeed(/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID??'')&&/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT??''),'run identity');
 fullNeed(fullSha(env.AIHR_CI_HEAD)&&fullSha(env.AIHR_CI_CONTROL_HEAD)&&fullSha(env.AIHR_CI_MIGRATION_BASE),'source identity');
 fullNeed(env.GITHUB_SHA===env.AIHR_CI_CONTROL_HEAD,'controller is workflow SHA, not candidate');
 fullNeed(env.TEST_DB_NAMESPACE===undefined||env.TEST_DB_NAMESPACE==='','full namespace');
 fullNeed(!env.GIT_DIR&&!env.GIT_WORK_TREE&&!env.GIT_INDEX_FILE,'alternate Git context');
 const workspace=env.GITHUB_WORKSPACE,temp=env.RUNNER_TEMP,eventPath=env.GITHUB_EVENT_PATH;
 fullNeed(workspace&&temp&&eventPath&&isAbsolute(workspace)&&isAbsolute(temp)&&isAbsolute(eventPath),'absolute paths');
 const workspaceReal=host.realpath(workspace!),tempReal=host.realpath(temp!);
 fullNeed(workspaceReal===resolve(workspace!)&&tempReal===resolve(temp!),'workspace/temp symlink');
 const source=join(workspaceReal,'source'),controller=join(workspaceReal,'automation');
 fullNeed(host.realpath(source)===source&&host.realpath(controller)===controller&&host.realpath(host.cwd)===source&&resolve(host.cwd)===source,'fixed checkouts');
 for(const [path,sha] of [[source,env.AIHR_CI_HEAD],[controller,env.AIHR_CI_CONTROL_HEAD]] as const){
  fullNeed(host.git(path,['rev-parse','--show-toplevel']).trim()===path&&host.git(path,['rev-parse','HEAD']).trim()===sha,'actual checkout HEAD');
  fullNeed(host.git(path,['status','--porcelain','--untracked-files=no']).trim()==='','dirty tracked checkout');
 }
 const evidence=join(tempReal,'aihr-ci');
 fullNeed((hints?.evidence??evidence)===evidence&&host.realpath(evidence)===evidence,'direct evidence directory');
 fullNeed(host.realpath(eventPath!)===resolve(eventPath!)&&resolve(eventPath!).startsWith(tempReal+'/')&&resolve(eventPath!).endsWith('/event.json'),'actual event path');
 const rawEvent=host.read(eventPath!);fullNeed(rawEvent.length<=4*1024*1024,'event bound');
 let parsedEvent:unknown;try{parsedEvent=JSON.parse(rawEvent);}catch{fullFail('event JSON');}
 const event=fullRecord(parsedEvent),repo=fullRecord(event.repository);
 fullNeed(repo.full_name==='StradaverseHub/ai-hr'&&repo.id===1333414856,'event repository');
 const workflowPrefix='StradaverseHub/ai-hr/.github/workflows/alpha-staging.yml@',ref=env.GITHUB_WORKFLOW_REF??'';
 fullNeed(ref.startsWith(workflowPrefix),'workflow path');
 if(env.GITHUB_EVENT_NAME==='workflow_dispatch'){
  fullNeed(/^refs\/heads\/[A-Za-z0-9_./-]+$/.test(env.GITHUB_REF??'')&&ref===workflowPrefix+env.GITHUB_REF,'dispatch controller ref');
  const inputs=fullRecord(event.inputs);fullNeed(inputs.expected_sha===env.AIHR_CI_HEAD,'resolved dispatch candidate');
  fullNeed(['build_only','diagnostics_only','controller_only'].every(key=>inputs[key]===undefined||inputs[key]===false||inputs[key]==='false'),'full test invocation');
 }else if(env.GITHUB_EVENT_NAME==='push'){
  fullNeed(env.GITHUB_REF==='refs/heads/alpha'&&ref===workflowPrefix+'refs/heads/alpha'&&event.ref==='refs/heads/alpha'&&event.after===env.AIHR_CI_HEAD&&env.AIHR_CI_HEAD===env.AIHR_CI_CONTROL_HEAD,'alpha push envelope');
 }else if(env.GITHUB_EVENT_NAME==='pull_request'){
  const pr=fullRecord(event.pull_request),head=fullRecord(pr.head),base=fullRecord(pr.base),headRepo=fullRecord(head.repo),baseRepo=fullRecord(base.repo);
  fullNeed(Number.isSafeInteger(event.number)&&Number(event.number)>0&&['opened','reopened','synchronize','ready_for_review'].includes(fullText(event.action)),'PR event');
  fullNeed(pr.draft===false&&base.ref==='alpha'&&env.GITHUB_BASE_REF==='alpha'&&head.ref===env.GITHUB_HEAD_REF,'ready alpha PR');
  fullNeed(headRepo.id===1333414856&&headRepo.full_name==='StradaverseHub/ai-hr'&&baseRepo.id===1333414856&&baseRepo.full_name==='StradaverseHub/ai-hr','same repo PR');
  fullNeed(head.sha===env.AIHR_CI_HEAD&&pr.merge_commit_sha===env.AIHR_CI_CONTROL_HEAD&&env.GITHUB_REF===`refs/pull/${event.number}/merge`&&ref===workflowPrefix+env.GITHUB_REF,'head versus merge/controller PR SHA');
 }else fullFail('event kind');
 let admin:string;
 if(!readonlyRehearsal){
  for(const [key,value] of Object.entries(FULL_CI_ROLE_URLS))fullNeed(env[key]===value,'canonical disposable URLs');
  admin='postgres://postgres@127.0.0.1:5433/postgres';
 }else{
  let migration:URL,app:URL;try{migration=new URL(env.TEST_MIGRATION_DATABASE_URL??'');app=new URL(env.TEST_DATABASE_URL??'');}catch{return fullFail('readonly URL shape');}
  fullNeed(migration.protocol==='postgres:'&&migration.hostname==='127.0.0.1'&&migration.port==='5433'&&migration.username==='postgres'&&migration.password===''&&migration.search===''&&migration.hash===''&&/^\/ai_hr_test(?:_w[1-9][0-9]*)?$/.test(migration.pathname),'readonly worker cluster');
  fullNeed(app.protocol==='postgres:'&&app.hostname===migration.hostname&&app.port===migration.port&&app.username==='ai_hr_app'&&app.password===''&&app.search===''&&app.hash===''&&app.pathname===migration.pathname,'readonly app worker');
  fullNeed(env.MIGRATION_DATABASE_URL===migration.href&&env.DATABASE_URL===app.href,'readonly worker aliases');
  migration.pathname='/postgres';admin=migration.href;
 }
 const observed=fullRecord(host.observePlan(source)),plan=fullRecord(observed.plan),batchSize=observed.dbBatchFiles;
 fullNeed(Number.isSafeInteger(batchSize)&&Number(batchSize)>0,'actual DB_BATCH_FILES');
 fullNeed(plan.sha===env.AIHR_CI_HEAD&&plan.controller===env.AIHR_CI_CONTROL_HEAD&&plan.migrationBase===env.AIHR_CI_MIGRATION_BASE&&fullSha(plan.fingerprint,64),'reconstructed plan identity');
 const unitId=hints?.unit??env.UNIT;fullNeed(typeof unitId==='string'&&/^db-[a-f0-9]{16}$/.test(unitId),'DB unit');
 fullNeed(Array.isArray(plan.units),'actual plan units');const units=(plan.units as unknown[]).map(fullRecord),matching=units.filter(unit=>unit.id===unitId);
 fullNeed(matching.length===1&&matching[0].kind==='db'&&Array.isArray(matching[0].files),'actual plan DB membership');
 const files=(matching[0].files as unknown[]).map(fullText);fullNeed(files.length>0&&new Set(files).size===files.length,'unit files');
 const rehearsalFile='test/personnel-draft-discard-role-transfer.test.ts',fileIndex=files.indexOf(rehearsalFile);
 if(readonlyRehearsal)fullNeed(fileIndex>=0,'actual rehearsal file membership');
 const offset=hints?.offset??Math.floor(fileIndex/Number(batchSize))*Number(batchSize);
 fullNeed(Number.isSafeInteger(offset)&&offset>=0&&offset<files.length&&offset%Number(batchSize)===0,'actual plan batch offset');
 if(hints)fullNeed(hints.planFingerprint===plan.fingerprint,'declared plan fingerprint');
 const sourceDigests={helper:'',wrapper:'',orchestration:''};
 for(const key of ['helper','wrapper','orchestration'] as const){const path=FULL_CI_ROLE_SOURCE[key],actual=host.read(join(source,path)),committed=host.git(source,['show',`HEAD:${path}`]);fullNeed(fullHash(actual)===fullHash(committed),'source digest versus exact candidate');sourceDigests[key]=fullHash(actual);}
 const binding:FullCiRoleBinding=Object.freeze({mode:FULL_CI_ROLE_MODE,candidate:env.AIHR_CI_HEAD!,controller:env.AIHR_CI_CONTROL_HEAD!,runId:env.GITHUB_RUN_ID!,attempt:env.GITHUB_RUN_ATTEMPT!,unit:unitId!,offset,planFingerprint:fullText(plan.fingerprint),batchSize:Number(batchSize),batchFiles:Object.freeze(files.slice(offset,offset+Number(batchSize)))});
 return Object.freeze({binding,admin,evidenceDirectory:evidence,sourceDigests:Object.freeze(sourceDigests)});
}
export function sameFullCiRoleBinding(left:FullCiRoleBinding,right:FullCiRoleBinding){return ['mode','candidate','controller','runId','attempt','unit','offset','planFingerprint','batchSize'].every(key=>left[key as keyof FullCiRoleBinding]===right[key as keyof FullCiRoleBinding])&&JSON.stringify(left.batchFiles)===JSON.stringify(right.batchFiles);}
