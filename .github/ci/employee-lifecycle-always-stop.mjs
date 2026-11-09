/** Cleanup-only native recovery. Never an alternate test admission path. */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,realpathSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createPlan} from './plan.mjs';
import {actualSingletonHost} from './singleton-profiles.mjs';
import {employeeLifecycleFile,EMPLOYEE_LIFECYCLE_PROFILE_SHA256} from './employee-lifecycle-profile.mjs';
import {employeeLifecycleRead,employeeLifecycleHash,employeeLifecycleProcess,assertEmployeeLifecycleAnchor,EMPLOYEE_LIFECYCLE_CONTROLLER_SOURCES} from './employee-lifecycle-context.mjs';

const root=realpathSync(fileURLToPath(new URL('../../',import.meta.url)));
const keys=(value,expected)=>assert.deepEqual(Object.keys(value).sort(),[...expected].sort());
const read=(path,maximum=65536)=>JSON.parse(employeeLifecycleRead(path,maximum));
const member=(directory,filename,maximum=65536)=>({filename,sha256:employeeLifecycleHash(employeeLifecycleRead(join(directory,filename),maximum))});

export function employeeLifecycleAlwaysStop(){
 assert.equal(process.argv.length,4);
 const [unitId,directory]=process.argv.slice(2);
 assert(/^db-[0-9a-f]{16}(?![\s\S])/.test(unitId));
 assert.equal(directory,join(realpathSync(process.env.RUNNER_TEMP),'aihr-ci'));
 assert.equal(realpathSync(directory),directory);
 assert.equal(process.env.AIHR_CI_UNIT,unitId);
 assert.equal(process.argv[1],join(root,'.github/ci/employee-lifecycle-always-stop.mjs'));
 assert(!Object.keys(process.env).some(key=>key.startsWith('AIHR_FOCUSED_')||key.startsWith('AIHR_EMPLOYEE_RECOVERY_')||key.startsWith('AIHR_EMPLOYEE_LIFECYCLE_')));
 const plan=createPlan(),unit=plan.units.find(row=>row.id===unitId);
 assert(unit&&unit.kind==='db'&&unit.files.length===1&&employeeLifecycleFile(unit.files[0]));
 const layout=actualSingletonHost(plan,unit,directory);
 assert.equal(layout.automation,root);
 const preparationPath=join(directory,`${unitId}-employee-preparation.json`);
 const resourceContext=join(realpathSync(process.env.RUNNER_TEMP),'aihr-employee-private',unitId,'resource.json');
 // The database owner can run only after preparation exists. If that frontier
 // was never reached, this recovery path owns no resource and deletes nothing.
 if(!existsSync(preparationPath)){
  assert(!existsSync(resourceContext),'Partial preparation remains unqualified');
  return {kind:'EMPLOYEE_LIFECYCLE_NOT_PREPARED_NO_RESOURCE_ACTION',complete:false,releaseAuthorized:false};
 }
 const preparationBytes=employeeLifecycleRead(preparationPath,65536),preparation=JSON.parse(preparationBytes);
 for(const [key,value] of Object.entries({version:1,mode:'full-ci-singleton',unit:unitId,file:unit.files[0],
  source:plan.sha,controller:plan.controller,fingerprint:plan.fingerprint,registrySha256:EMPLOYEE_LIFECYCLE_PROFILE_SHA256,
  sourceRoot:layout.source,automation:root,evidenceDirectory:directory,releaseAuthorized:false}))assert.equal(preparation[key],value);
 assert.equal(preparation.run,process.env.GITHUB_RUN_ID);
 assert.equal(preparation.attempt,process.env.GITHUB_RUN_ATTEMPT);
 keys(preparation.controllerSources,EMPLOYEE_LIFECYCLE_CONTROLLER_SOURCES);
 for(const [path,sha] of Object.entries(preparation.controllerSources))assert.equal(employeeLifecycleHash(employeeLifecycleRead(join(root,path),1048576,false)),sha);
 assert.equal(employeeLifecycleHash(employeeLifecycleRead(resourceContext,65536)),preparation.resourceContextSha256);
 const anchorPath=join(directory,`${unitId}-employee-job-anchor.json`);
 assert.equal(preparation.anchorPath,anchorPath);
 assert.equal(process.env.AIHR_EMPLOYEE_JOB_ANCHOR,anchorPath);
 const anchor=read(anchorPath,16384);
 const elapsed=assertEmployeeLifecycleAnchor(anchor,preparation,process.hrtime.bigint(),readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim());
 const budgetSeconds=Math.min(9,1770-elapsed-6);
 assert(budgetSeconds>0,'No independent recovery settlement reserve remains');
 const nativeParent=employeeLifecycleProcess(process.pid),node=realpathSync(process.execPath);
 assert.equal(nativeParent.exe,node);
 assert.deepEqual(nativeParent.argv,[node,join(root,'.github/ci/employee-lifecycle-always-stop.mjs'),unitId,directory]);
 const recovery={version:1,mode:'cleanup-only',...Object.fromEntries(['source','controller','run','attempt','unit','file','fingerprint','registrySha256'].map(key=>[key,preparation[key]])),
  preparationSha256:employeeLifecycleHash(preparationBytes),resourceContextSha256:preparation.resourceContextSha256,nativeParent,releaseAuthorized:false};
 const recoveryPath=join(directory,`${unitId}-employee-recovery.json`);
 writeFileSync(recoveryPath,JSON.stringify(recovery)+'\n',{flag:'wx',mode:0o600});
 const request={stage:'stop',file:unit.files[0],node,controller:root,destination:directory,preparation:preparationPath,testContext:null,sequence:99};
 const result=spawnSync('/usr/bin/python3',['-I','-B',join(root,'.github/ci/employee-lifecycle-supervisor.py'),JSON.stringify(request)],
  {cwd:layout.source,env:{...process.env,AIHR_EMPLOYEE_RESOURCE_CONTEXT:resourceContext,AIHR_EMPLOYEE_RECOVERY_CONTEXT:recoveryPath},
   encoding:'utf8',maxBuffer:1048576,timeout:Math.ceil((budgetSeconds+6)*1000),killSignal:'SIGTERM'});
 // A timeout/exit cannot attest native cleanup. Require actual kernel and
 // exact Docker custody proofs produced by the reviewed, source-bound owner.
 assert(!result.error&&!result.signal&&result.status===0);
 const stageName=`${unitId}-employee-recovery-stage.json`,stage=read(join(directory,stageName),16384);
 keys(stage.result,['reason','commandExit','admitted','reaped','groupQuiescent','escapedSession','releaseAuthorized']);
 assert.deepEqual(stage.result,{reason:'complete',commandExit:0,admitted:true,reaped:true,groupQuiescent:true,escapedSession:false,releaseAuthorized:false});
 for(const key of ['source','controller','run','attempt','unit','file','fingerprint'])assert.equal(stage[key],preparation[key]);
 assert.equal(stage.mode,'full-ci-singleton');assert.equal(stage.releaseAuthorized,false);assert.equal(stage.stage,'stop');assert.equal(stage.sequence,99);
 const stoppedName=`${unitId}-employee-container-stopped.json`,stopped=read(join(directory,stoppedName),16384);
 for(const key of ['source','controller','run','attempt','unit','file','fingerprint','registrySha256','resourceContextSha256','resourceNonceSha256'])assert.equal(stopped[key],preparation[key]);
 assert.equal(stopped.version,1);assert.equal(stopped.mode,'full-ci-singleton');assert.equal(stopped.releaseAuthorized,false);
 assert.equal(stopped.complete,true);assert.equal(stopped.containerAbsent,true);assert.equal(stopped.nameAbsent,true);assert.equal(stopped.volumeAbsent,true);
 const value={version:1,kind:'ACTUAL_EMPLOYEE_CLEANUP_ONLY_NOT_TEST_ACCEPTANCE',...Object.fromEntries(['source','controller','run','attempt','unit','file','fingerprint'].map(key=>[key,preparation[key]])),
  recovery:member(directory,`${unitId}-employee-recovery.json`),stage:member(directory,stageName,16384),
  supervisor:member(directory,`${unitId}-employee-recovery-supervisor.jsonl`,131072),resource:member(directory,stoppedName,16384),complete:true,testAccepted:false,releaseAuthorized:false};
 writeFileSync(join(directory,`${unitId}-employee-always-stop.json`),JSON.stringify(value)+'\n',{flag:'wx',mode:0o600});
 return value;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{employeeLifecycleAlwaysStop();}
 catch{process.stderr.write('Employee lifecycle independent cleanup remains unqualified\n');process.exitCode=1;}
}
