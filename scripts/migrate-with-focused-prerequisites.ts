/** Candidate package entry only; no immutable controller change. Ordinary migration never imports
 * test provisioning code. Focused migration reuses the already reviewed strict disposable fixture. */
import {createHash} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {platform} from 'node:os';
import {hasFocusedMigrationIntent,hasFullCiRoleIntent,runCandidateMigration,FULL_CI_PLAN_OBSERVER,FULL_CI_ROLE_MODE,fullCiRoleReceiptBasename} from './lib/discard-premigration';

export async function migrateWithFocusedPrerequisites():Promise<number>{
 // Ordinary/focused migrations never load this native controller observation.
 const native=process.env.GITHUB_JOB==='native-test'&&hasFullCiRoleIntent(process.env)
  ?await import('../.github/ci/native-next-installation.mjs'):null;
 const closedEnvironment=process.env.GITHUB_JOB==='native-test'&&hasFullCiRoleIntent(process.env)
  ?await import('../.github/ci/candidate-environment.mjs'):null;
 const nativeSubprocessEnvironment=()=>{
  if(!closedEnvironment)throw Error('Native preparation environment unavailable.');
  // The sanitizer retains NODE_ENV. Name it explicitly for the subprocess type.
  return {...closedEnvironment.nativePreparationEnvironment(process.env),NODE_ENV:process.env.NODE_ENV};
 };
 return runCandidateMigration({focused:hasFocusedMigrationIntent(process.env),environment:process.env,migrationTarget:process.env.MIGRATION_DATABASE_URL,testMigrationTarget:process.env.TEST_MIGRATION_DATABASE_URL,arguments:process.argv.slice(2)},{
  fullCiHost:{platform:platform(),cwd:process.cwd(),realpath:path=>realpathSync(path),read:path=>readFileSync(path,'utf8'),
   git:(cwd,args)=>execFileSync('git',['-c','safe.directory='+cwd,'-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null',...args],{cwd,env:closedEnvironment?nativeSubprocessEnvironment():process.env,encoding:'utf8',maxBuffer:16*1024*1024}),
   ...(native?{nativeBootstrap:()=>native.readProtectedBootstrap(process.env)}:{}),
   observePlan:cwd=>{
    if(native){const bootstrap=native.readProtectedBootstrap(process.env);return JSON.parse(execFileSync(bootstrap.protectedNodePath,
     [join(bootstrap.automation,'.github/ci/native-controller-owner.mjs'),'role-plan'],{cwd,env:nativeSubprocessEnvironment(),encoding:'utf8',timeout:120000,maxBuffer:16*1024*1024}));}
    return JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',FULL_CI_PLAN_OBSERVER],{cwd,env:process.env,encoding:'utf8',maxBuffer:16*1024*1024}));
   },},
  loadFocusedRoleOwner:()=>import('../test/helpers/personnel-draft-discard-ci-role-fixture'),
  prepareCatalogueReplay:async admission=>{
   const owner=await import('../test/fixtures/notification-worker/final-catalogue-replay-prerequisite');
   return owner.prepareNotificationCatalogueReplay(admission);
  },
  fingerprint:path=>createHash('sha256').update(readFileSync(path)).digest('hex'),
  recordPrerequisites:(metadata,full)=>{
   if(metadata.mode===FULL_CI_ROLE_MODE){
    if(!full||metadata.unit!==full.binding.unit||metadata.offset!==full.binding.offset||metadata.planFingerprint!==full.binding.planFingerprint
     ||realpathSync(full.evidenceDirectory)!==full.evidenceDirectory)throw Error('Full CI prerequisite receipt binding unavailable.');
    writeFileSync(join(full.evidenceDirectory,fullCiRoleReceiptBasename(full.binding.unit,full.binding.offset)),JSON.stringify(metadata,null,2)+'\n',{flag:'wx'});return;
   }
   // The SAME strict helper already validated this exact evidence directory under RUNNER_TEMP.
   const evidence=process.env.AIHR_FOCUSED_EVIDENCE_DIR;if(!evidence)throw Error('Focused prerequisite evidence directory unavailable.');
   writeFileSync(join(evidence,'personnel-draft-discard-premigration-role-prerequisites.json'),JSON.stringify({
    ...metadata,candidate:process.env.AIHR_CI_HEAD,controller:process.env.AIHR_CI_CONTROL_HEAD,
    runId:process.env.GITHUB_RUN_ID,attempt:process.env.GITHUB_RUN_ATTEMPT,
    wrapperSha256:createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
    orchestrationSha256:createHash('sha256').update(readFileSync('scripts/lib/discard-premigration.ts')).digest('hex'),
   },null,2)+'\n',{flag:'wx'});
  },
  migrate:args=>{
   // No recursion through db:migrate, no shell, no env/config rewriting and no alternate SQL runner.
   const result=spawnSync('pnpm',['exec','drizzle-kit','migrate',...args],{stdio:'inherit',env:process.env});
   if(result.error||result.signal||result.status===null)throw Error('Existing migration engine did not complete normally.');
   return result.status;
  },
 });
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 migrateWithFocusedPrerequisites().then(status=>{process.exitCode=status;}).catch(error=>{
  console.error(error instanceof Error?error.message:'Candidate migration failed.');process.exitCode=1;
 });
}
