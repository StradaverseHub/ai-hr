/** Whole-project compiler measurement only; no cached PASS or release authority. */
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,openSync,closeSync,lstatSync,rmSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
function lstatExists(path){try{lstatSync(path);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024}).trim();
export function validateCompilerPhase({code,signal,timedOut},text,expectedErrorPath=null){
 assert(!timedOut&&signal===null,'Compiler timeout/signal is never an expected type error');
 const errors=[...text.matchAll(/^([^\r\n]+)\(\d+,\d+\): error TS(\d+):[^\r\n]*$/gm)];
 assert.equal([...text.matchAll(/\berror TS\d+:/g)].length,errors.length,'Unexpected global or unparsed compiler diagnostic');
 if(expectedErrorPath){
  assert([1,2].includes(code),'Expected compiler error did not produce a diagnostic exit');
  assert.equal(errors.length,1,'Expected exactly one owned negative-control diagnostic');
  assert.equal(errors[0][1],expectedErrorPath);assert.equal(errors[0][2],'2322');
 }else{assert.equal(code,0,'Whole-project compiler failed');assert.equal(errors.length,0);}
 const files=Number(text.match(/^Files:\s+(\d+)\s*$/m)?.[1]);
 assert(Number.isSafeInteger(files)&&files>0,'Missing complete compiler file count');
 return {files,expectedError:expectedErrorPath!==null,processExitCode:code};
}
/** Retain actual exits, and bound termination of only the newly owned process group. */
export async function measuredCommand(command,args,{cwd,env,log,timeoutMs=600000,graceMs=10000}){
 const fd=openSync(log,'wx',0o600);let child,timer,timedOut=false,killDone=Promise.resolve();
 const start=Date.now();
 try{
  child=spawn(command,args,{cwd,env,stdio:['ignore',fd,fd],detached:true});
  timer=setTimeout(()=>{
   timedOut=true;if(child.pid)try{process.kill(-child.pid,'SIGTERM');}catch{}
   killDone=new Promise(done=>setTimeout(()=>{if(child.pid)try{process.kill(-child.pid,'SIGKILL');}catch{}done();},graceMs));
  },timeoutMs);
  const exit=await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>done({code,signal}));});
  await killDone;
  return {...exit,timedOut,elapsedMs:Date.now()-start};
 }finally{clearTimeout(timer);await killDone;closeSync(fd);}
}
export async function compilerBenchmark(){
 assert(process.platform==='linux'&&process.env.GITHUB_ACTIONS==='true'&&process.env.RUNNER_ENVIRONMENT==='github-hosted'
  &&process.env.CI==='true'&&process.env.GITHUB_REPOSITORY==='StradaverseHub/ai-hr','Managed company runner required');
 const cwd=realpathSync(process.cwd()),sha=git(cwd,'rev-parse','HEAD');
 assert.equal(sha,process.env.AIHR_CI_HEAD);assert.equal(git(cwd,'status','--porcelain'),'');
 const controller=fileURLToPath(new URL('../../../',import.meta.url));
 assert.equal(git(controller,'rev-parse','HEAD'),process.env.AIHR_CI_CONTROL_HEAD);
 assert.equal(git(controller,'status','--porcelain'),'');
 assert.equal(JSON.parse(readFileSync(join(cwd,'tsconfig.json'),'utf8')).compilerOptions.incremental,true);
 const out=join(realpathSync(process.env.RUNNER_TEMP),'diagnostic-compiler-incremental');mkdirSync(out,{mode:0o700});
 const cache=join(out,'whole-project.tsbuildinfo'),fixture='aihr-compiler-probe-'+randomUUID(),fixturePath=join(cwd,fixture);
 const report={kind:'WHOLE_PROJECT_INCREMENTAL_DIAGNOSTIC_NOT_RELEASE_EVIDENCE',source:sha,controller:process.env.AIHR_CI_CONTROL_HEAD,
  runId:process.env.GITHUB_RUN_ID,attempt:process.env.GITHUB_RUN_ATTEMPT,runtime:{node:process.versions.node,platform:process.platform,arch:process.arch,
  typescript:JSON.parse(readFileSync(join(cwd,'node_modules/typescript/package.json'),'utf8')).version},
  tsconfigSha256:hash(readFileSync(join(cwd,'tsconfig.json'))),lockSha256:hash(readFileSync(join(cwd,'pnpm-lock.yaml'))),
  releaseAuthorized:false,startedAt:new Date().toISOString(),cacheWasAbsent:true,phases:[],exitCode:1,
  orderCaveat:'Warm follows cold on one VM; this measures compiler state plus normal OS/dependency warming. It does not prove cross-run cache restore speed or complete release timing.'};
 const args=['-v',process.execPath,join(cwd,'node_modules/typescript/lib/tsc.js'),'--noEmit','--pretty','false','--extendedDiagnostics','--tsBuildInfoFile',cache];
 const env={...process.env,NODE_OPTIONS:'--max-old-space-size=8192'};
 let createdFixture=false;
 const phase=async(name,expectedErrorPath=null)=>{
  const row={name,startedAt:new Date().toISOString(),expectedErrorPath,processExitCode:null};report.phases.push(row);
  const log=join(out,name+'.log');const result=await measuredCommand('/usr/bin/time',args,{cwd,env,log});
  Object.assign(row,result,{processExitCode:result.code,endedAt:new Date().toISOString()});
  const st=lstatSync(log);assert(st.isFile()&&!st.isSymbolicLink()&&st.size<=16*1024*1024,'Compiler log exceeds bound');
  Object.assign(row,validateCompilerPhase(result,readFileSync(log,'utf8'),expectedErrorPath));
  const state=lstatSync(cache);assert(state.isFile()&&!state.isSymbolicLink()&&state.size>0&&state.size<=64*1024*1024,'Invalid compiler cache');
  row.cache={bytes:state.size,sha256:hash(readFileSync(cache))};return row;
 };
 try{
  const cold=await phase('cold'),warm=await phase('warm');assert.equal(cold.files,warm.files,'Warm compiler omitted files');
  assert.equal(git(cwd,'status','--porcelain'),'');
  mkdirSync(fixturePath,{mode:0o700});createdFixture=true;
  const contract=join(fixturePath,'contract.ts'),consumer=join(fixturePath,'consumer.ts');
  const valid='export const value: string = "fixture";\n',consumerBytes='import {value} from "./contract";\nexport const consumed: string = value;\n';
  writeFileSync(contract,valid,{flag:'wx'});writeFileSync(consumer,consumerBytes,{flag:'wx'});
  const added=await phase('added-valid-dependency');assert.equal(added.files,cold.files+2,'New roots were not included');
  writeFileSync(contract,'export const value: number = 1;\n');
  assert.equal(readFileSync(consumer,'utf8'),consumerBytes,'Consumer changed instead of dependency');
  const transitive=await phase('changed-dependency-refused',fixture+'/consumer.ts');assert.equal(transitive.files,added.files);
  writeFileSync(contract,valid);writeFileSync(join(fixturePath,'new-root.ts'),'export const invalid: string = 1;\n',{flag:'wx'});
  const newRoot=await phase('new-root-error-refused',fixture+'/new-root.ts');assert.equal(newRoot.files,cold.files+3);
  rmSync(fixturePath,{recursive:true});createdFixture=false;
  const recovered=await phase('restored-source');assert.equal(recovered.files,cold.files,'Deleted diagnostic roots remained included');
  assert.equal(git(cwd,'rev-parse','HEAD'),sha);assert.equal(git(cwd,'status','--porcelain'),'');
  assert.equal(git(controller,'rev-parse','HEAD'),process.env.AIHR_CI_CONTROL_HEAD);assert.equal(git(controller,'status','--porcelain'),'');
  report.exitCode=0;
 }catch(error){report.error=String(error);throw error;}
 finally{
  if(createdFixture)rmSync(fixturePath,{recursive:true});
  report.ownedFixtureRemoved=!createdFixture||!lstatExists(fixturePath);
  report.sourceRestored=git(cwd,'rev-parse','HEAD')===sha&&git(cwd,'status','--porcelain')==='';
  if(!report.sourceRestored)report.exitCode=1;
  // Compiler state is measurement data, not a cached PASS or a deployable artifact.
  report.cacheRemoved=false;
  try{rmSync(cache);report.cacheRemoved=true;}catch(error){if(error.code==='ENOENT')report.cacheRemoved=true;else report.cleanupError=String(error);}
  if(!report.cacheRemoved)report.exitCode=1;
  report.endedAt=new Date().toISOString();writeFileSync(join(out,'comparison.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
 }
 assert.equal(report.exitCode,0);return report;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))compilerBenchmark().then(v=>console.log(JSON.stringify(v))).catch(error=>{console.error(error);process.exitCode=1;});
