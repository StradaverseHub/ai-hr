/** Fixed public font prerequisite on a disposable runner; never a test/release PASS. */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync,realpathSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const commandSeconds=120,cleanupSeconds=5,transportMs=128000;
const packages=Object.freeze(['fonts-noto-core','fonts-noto-cjk']);
const aptOptions=Object.freeze(['-o','Acquire::Retries=0','-o','Acquire::http::Timeout=20',
 '-o','Acquire::https::Timeout=20','-o','DPkg::Lock::Timeout=15','-o','APT::Update::Error-Mode=any']);
const command=operation=>['-n','timeout','--signal=TERM',`--kill-after=${cleanupSeconds}s`,`${commandSeconds}s`,
 'env','DEBIAN_FRONTEND=noninteractive','apt-get',...aptOptions,...(operation==='install'
 ?['install','-y','--no-install-recommends',...packages]:['update','-qq'])];
const execute=(file,args,timeout)=>{
 const start=Date.now(),r=spawnSync(file,args,{encoding:'utf8',timeout,killSignal:'SIGKILL',maxBuffer:1024**2});
 return {status:r.status,errorCode:r.error?.code??null,signal:r.signal??null,
  stdout:r.stdout??'',stderr:r.stderr??'',elapsedMs:Date.now()-start};
};
/** Injected command boundary is for pure controls only, never a caller-selected package or duration. */
export function bootstrapFixedNoto({run=execute,onStep=()=>{}}={}){
 const steps=[],start=Date.now();
 const invoke=phase=>{
  const operation=phase==='refresh-indexes'?'update':'install',args=command(operation);
  const r=run('sudo',args,transportMs);
  assert(r&&typeof r==='object','Font prerequisite command result object required');
  const row={phase,file:'sudo',args,status:r.status,errorCode:r.errorCode??null,signal:r.signal??null,
   elapsedMs:r.elapsedMs??0,stdout:String(r.stdout??'').slice(-8192),stderr:String(r.stderr??'').slice(-8192)};
  steps.push(row);onStep(row);
  assert(Number.isInteger(row.status)&&row.status>=0&&row.status<=255,'Completed font prerequisite exit status required');
  // An outer transport/timeout/forced-kill result cannot establish clean package-manager completion.
  // Refuse rather than start another privileged APT process against uncertain state.
  assert(!row.errorCode&&!row.signal&&[0,100].includes(row.status),'Known completed APT success/error required; wrapper or cleanup outcome is uncertain');
  return row.status===0;
 };
 try{
  const initialInstalled=invoke('install-existing-indexes');
  let refreshed=false;
  if(!initialInstalled){
   assert(invoke('refresh-indexes'),'Required font index refresh failed');refreshed=true;
   assert(invoke('install-after-refresh'),'Required font installation retry failed');
  }
  return {kind:'FIXED_NOTO_BOOTSTRAP_NOT_TEST_OR_RELEASE_PASS',packages:[...packages],steps,indexesRefreshed:refreshed,
   commandBudgetSeconds:commandSeconds,maxCommands:3,aggregateCommandBudgetSeconds:360,
   perCommandCleanupSeconds:cleanupSeconds,elapsedMs:Date.now()-start,releaseAuthorized:false};
 }catch(error){error.fontSetupSteps=steps;throw error;}
}
export function assertFixedNotoRunner(e,platform){
 assert(platform==='linux'&&e.GITHUB_ACTIONS==='true'&&e.CI==='true'&&e.RUNNER_ENVIRONMENT==='github-hosted'
  &&e.GITHUB_REPOSITORY==='StradaverseHub/ai-hr'&&e.GITHUB_REPOSITORY_ID==='1333414856','Disposable repository runner only');
 assert(/^[a-f0-9]{40}$/.test(e.AIHR_CI_HEAD??'')&&/^[a-f0-9]{40}$/.test(e.AIHR_CI_CONTROL_HEAD??''),'Exact font prerequisite source/controller required');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 assertFixedNotoRunner(process.env,process.platform);
 assert(process.argv.length===3,'One fixed font evidence output required');
 const temp=realpathSync(process.env.RUNNER_TEMP),output=resolve(process.argv[2]);
 assert([join(temp,'aihr-focused/noto-font-setup.json'),join(temp,'aihr-ci/noto-font-setup.json')].includes(output),'Fixed owned font evidence path required');
 mkdirSync(dirname(output),{recursive:true});assert(realpathSync(dirname(output))===dirname(output),'Font evidence symlink refused');
 const binding={candidate:process.env.AIHR_CI_HEAD,controller:process.env.AIHR_CI_CONTROL_HEAD};
 try{
  const result=bootstrapFixedNoto({onStep:row=>console.log('NOTO_BOOTSTRAP_PHASE '+JSON.stringify(row))});
  writeFileSync(output,JSON.stringify({...result,...binding},null,2)+'\n',{flag:'wx',mode:0o600});
 }catch(error){
  writeFileSync(output,JSON.stringify({kind:'FAILED_FIXED_NOTO_BOOTSTRAP_NOT_TEST_PASS',...binding,
   error:String(error),steps:error.fontSetupSteps??[],releaseAuthorized:false},null,2)+'\n',{flag:'wx',mode:0o600});throw error;
 }
}
