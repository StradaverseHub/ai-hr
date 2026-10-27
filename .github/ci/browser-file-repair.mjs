/** A single failed browser file, never a complete-unit or release pass. */
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {isAbsolute,join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createPlan} from './plan.mjs';
import {hostHealth} from './host-health.mjs';
export const REPAIR_FILE='test/atelier-mobile-navigation.browser.test.tsx';
export const ORIGINAL_FAILED_RUN=40469625375;
export function verifyBrowserFileRepair(result,cwd){
 assert(result?.success===true&&result.numFailedTests===0&&result.numFailedTestSuites===0,'Browser repair failed');
 assert(result.numTotalTests===5&&result.numPassedTests===5&&result.numPendingTests===0&&result.numTodoTests===0,'All five actual cases must execute');
 assert(Array.isArray(result.testResults)&&result.testResults.length===1,'Only the failed file may execute');
 const suite=result.testResults[0],file=isAbsolute(suite.name??'')?relative(cwd,suite.name):suite.name;
 assert(file===REPAIR_FILE&&suite.status==='passed'&&suite.assertionResults?.length===5,'Exact failed file coverage required');
 assert(suite.assertionResults.every(test=>test.status==='passed'),'Skipped or failed assertion');
 return 5;
}
export function repairBrowserConfig(engine){
 assert(['chromium','firefox','webkit'].includes(engine),'Unknown browser engine');
 return `import base from '../vitest.browser.config';\nexport default {...base,test:{...base.test,browser:{...base.test.browser,instances:[{browser:${JSON.stringify(engine)}}]}}};\n`;
}
export function runBrowserFileRepair(destination){
 assert(process.platform==='linux'&&process.env.GITHUB_ACTIONS==='true'&&process.env.CI==='true'
  &&process.env.RUNNER_ENVIRONMENT==='github-hosted'&&process.env.GITHUB_REPOSITORY==='StradaverseHub/ai-hr'
  &&process.env.GITHUB_REPOSITORY_ID==='1333414856','Disposable standard GitHub runner only');
 const cwd=process.cwd(),git=(...args)=>execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
 const candidate=process.env.AIHR_CI_HEAD,controller=process.env.AIHR_CI_CONTROL_HEAD,engine=process.env.ENGINE;
 assert(/^\d+$/.test(process.env.GITHUB_RUN_ID??'')&&process.env.GITHUB_RUN_ATTEMPT==='1','Exact first-attempt Actions run required');
 assert(/^[a-f0-9]{40}$/.test(candidate??'')&&/^[a-f0-9]{40}$/.test(controller??'')&&git('rev-parse','HEAD')===candidate&&!git('status','--porcelain'),'Clean exact candidate required');
 const configText=repairBrowserConfig(engine),temp=realpathSync(process.env.RUNNER_TEMP),dir=resolve(destination),inside=relative(temp,dir);
 assert(inside&&!inside.startsWith('../')&&!isAbsolute(inside),'Owned runner evidence directory required');
 const plan=createPlan(),unit=plan.units.find(unit=>unit.kind==='browser'&&unit.engine===engine);
 assert(/^[a-f0-9]{40}$/.test(plan.migrationBase??''),'Exact migration baseline required');
 assert(unit?.files.includes(REPAIR_FILE),'Failed file must belong to actual source browser inventory');
 assert(/^100644 blob [a-f0-9]{40}\t/.test(git('ls-tree','HEAD','--',REPAIR_FILE)),'Tracked regular failed file required');
 mkdirSync(dir,{recursive:true,mode:0o700});
 const report={kind:'FOCUSED_BROWSER_FILE_REPAIR_NOT_RELEASE',format:1,releaseAuthorized:false,releaseEligible:false,
  candidate,controller,baseline:plan.migrationBase,fingerprint:plan.fingerprint,engine,originalFailedRun:ORIGINAL_FAILED_RUN,
  files:[REPAIR_FILE],sourceTree:git('rev-parse','HEAD^{tree}'),testBlob:git('rev-parse','HEAD:'+REPAIR_FILE),
  configBlob:git('rev-parse','HEAD:vitest.browser.config.ts'),runId:process.env.GITHUB_RUN_ID,attempt:process.env.GITHUB_RUN_ATTEMPT,
  runtime:{node:process.versions.node,platform:process.platform,arch:process.arch},startedAt:new Date().toISOString(),exitCode:1};
 try{
  report.healthBefore=hostHealth();assert(report.healthBefore.ok,'Runner headroom refused');
  mkdirSync('.vitest-attachments',{recursive:true});
  const config='.vitest-attachments/ci-browser-repair-'+engine+'.config.mts';writeFileSync(config,configText);
  const raw=join(dir,'browser.vitest.json'),closed='postgres://nobody:nothing@127.0.0.1:1/no_database';
  const env={...process.env,VITEST_MAX_WORKERS:String(plan.execution.workers),VITEST_MAX_WORKERS_NODB:String(plan.execution.workers),AIHR_BROWSER_ENGINE:engine,AIHR_TEST_DURATION_ORDER:'false'};
  for(const key of ['DATABASE_URL','MIGRATION_DATABASE_URL','TEST_DATABASE_URL','TEST_MIGRATION_DATABASE_URL'])env[key]=closed;
  const args=['exec','vitest','run','--config',config,REPAIR_FILE,'--reporter=default','--reporter=json','--outputFile.json='+raw];
  report.command={file:'pnpm',args};
  const child=spawnSync('pnpm',args,{stdio:'inherit',env});report.processExitCode=child.status;report.signal=child.signal;
  if(child.error)report.processError=child.error.message;
  assert(!child.error&&child.status===0&&!child.signal,'Browser repair process failed');
  report.assertions=verifyBrowserFileRepair(JSON.parse(readFileSync(raw,'utf8')),cwd);
  assert(createPlan().fingerprint===plan.fingerprint,'Source changed during repair');
  report.exitCode=0;
 }catch(error){report.error=String(error.message);}
 finally{
  report.healthAfter=hostHealth();if(!report.healthAfter.ok)report.exitCode=1;
  report.endedAt=new Date().toISOString();writeFileSync(join(dir,'browser-repair.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
 }
 return report.exitCode;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 assert(process.argv.length===3,'Exact evidence directory argument required');process.exitCode=runBrowserFileRepair(process.argv[2]);
}
