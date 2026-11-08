/** Actual hosted test admission. No caller context/factory can manufacture it.
 * GitHub API authentication remains the independent release verifier's duty. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,realpathSync,lstatSync,openSync,fstatSync,closeSync,constants} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {singletonProfile,singletonKind,singletonSources,singletonSourceMaximum,validateSingletonBinding,validateSingletonHost,validateSingletonDatabaseUrls} from '../../.github/ci/singleton-protocol.mjs';
import {workerDb} from '../db-names';
import {readProtectedBootstrap} from '../../.github/ci/native-next-installation.mjs';
import {nativePreparationEnvironment} from '../../.github/ci/candidate-environment.mjs';
const git=(cwd:string,...args:string[])=>execFileSync('git',['-c','safe.directory='+cwd,'-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-C',cwd,...args],{env:nativePreparationEnvironment(process.env),encoding:'utf8'}).trim();
function regular(path:string,maximum:number,privateFile=false){
 assert.equal(realpathSync(path),resolve(path));const before=lstatSync(path);assert(before.isFile()&&!before.isSymbolicLink()&&before.size<=maximum&&before.nlink===1);
 if(privateFile){assert.equal(before.uid,process.getuid!());assert.equal(before.mode&0o077,0);}
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const actual=fstatSync(fd);assert.equal(actual.dev,before.dev);assert.equal(actual.ino,before.ino);assert.equal(actual.size,before.size);return readFileSync(fd);}
 finally{closeSync(fd);}
}
export function admitSingletonTest(file:string){
 const profile=singletonProfile(file);assert(profile,'Unregistered singleton test');
 const env=process.env;assert.equal(process.platform,'linux');assert.equal(env.GITHUB_ACTIONS,'true');assert.equal(env.RUNNER_ENVIRONMENT,'github-hosted');assert.equal(env.GITHUB_REPOSITORY,'StradaverseHub/ai-hr');
 const source=realpathSync(process.cwd()),temp=realpathSync(env.RUNNER_TEMP!),candidate=git(source,'rev-parse','HEAD');assert.equal(candidate,env.AIHR_CI_HEAD);assert.equal(git(source,'status','--porcelain'),'');
 if(singletonKind(profile)==='db'){
  const pool=env.VITEST_POOL_ID??env.VITEST_WORKER_ID;assert(pool&&/^[1-9][0-9]*$/.test(pool));assert.notEqual(env.WORKER_DB,'0');validateSingletonDatabaseUrls(env,workerDb(pool));
 }
 const hints=Object.keys(env).filter(key=>key.startsWith('AIHR_CI_SINGLETON_'));
 if(hints.length){
  assert.deepEqual(hints,['AIHR_CI_SINGLETON_BINDING']);assert(!Object.keys(env).some(key=>key.startsWith('AIHR_FOCUSED_')),'Mixed singleton/focused intent');
  assert.equal(env.VITEST_MAX_WORKERS,'1');assert.equal(env.VITEST_MAX_WORKERS_NODB,'1');
  const bootstrap=profile==='linux-next-postgres-v1'?readProtectedBootstrap(env):null;
  const workspace=realpathSync(env.GITHUB_WORKSPACE!),automation=realpathSync(bootstrap?.automation??join(workspace,'automation')),directory=join(temp,'aihr-ci');
  assert.equal(source,join(workspace,'source'));assert.equal(automation,bootstrap?.automation??join(workspace,'automation'));
  const bindingPath=env.AIHR_CI_SINGLETON_BINDING!;assert.equal(resolve(bindingPath),bindingPath);assert.equal(realpathSync(directory),directory);assert.equal(join(directory,resolve(bindingPath).split('/').at(-1)!),bindingPath);
  const binding=JSON.parse(regular(bindingPath,1048576,true).toString('utf8'));
  assert.equal(bindingPath,join(directory,`${binding.unit}-singleton.json`));assert.equal(binding.file,file);assert.equal(binding.evidenceDirectory,directory);
  // Reconstruct the actual controller-owned complete plan; a supplied JSON plan,
  // focused flag or claimed fingerprint is never the source of membership.
  const script=join(automation,'.github/ci/plan.mjs');regular(script,1048576);
  const execution={cwd:source,encoding:'utf8' as const,timeout:120000,maxBuffer:16*1024*1024};
  const bytes=bootstrap?execFileSync(bootstrap.protectedNodePath,[join(automation,'.github/ci/native-controller-owner.mjs'),'plan'],execution)
   :execFileSync(process.execPath,[script],execution);
  const plan=JSON.parse(bytes);
  const unit=plan.units.find((row:{id:string})=>row.id===binding.unit);assert(unit);assert.equal(unit.files[0],file);
  const layout={workspace,temp,source,automation,cwd:source,evidence:directory,platform:process.platform,sourceHead:candidate,controllerHead:git(automation,'rev-parse','HEAD'),sourceClean:true,controllerClean:git(automation,'status','--porcelain')===''};
  validateSingletonHost({env,event:JSON.parse(regular(env.GITHUB_EVENT_PATH!,1048576).toString('utf8')),layout,plan,unit});
  validateSingletonBinding(binding,plan,unit,{runId:env.GITHUB_RUN_ID,attempt:env.GITHUB_RUN_ATTEMPT});
  for(const path of singletonSources(unit))assert.equal(createHash('sha256').update(regular(join(source,path),singletonSourceMaximum(path))).digest('hex'),binding.sourceHashes[path]);
  if(typeof unit.id!=='string')throw Error('Actual singleton unit ID must be a string');
  return {mode:'full-ci-singleton' as const,evidenceDirectory:directory,databaseUnit:unit.id};
 }
 assert.equal(env.GITHUB_WORKFLOW,'alpha-focused-checks');assert.equal(env.GITHUB_JOB,'selected-tests');assert.equal(env.GITHUB_RUN_ATTEMPT,'1');assert.equal(env.AIHR_FOCUSED_SUITE_CAPACITY,'true');
 assert.deepEqual(JSON.parse(env.AIHR_FOCUSED_TESTS??'null'),[file],'A real exact sole-file focused invocation is required');
 const directory=join(temp,'aihr-focused');assert.equal(env.AIHR_FOCUSED_EVIDENCE_DIR,directory);assert.equal(realpathSync(directory),directory);
 return {mode:'focused-diagnostic' as const,evidenceDirectory:directory,databaseUnit:'db-1'};
}
