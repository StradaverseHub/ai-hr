/** Fixed read-only GitHub/archive owner. Actual API/ZIP facts are supplied to the
 * pure verifier; neither JSON booleans nor caller-selected URLs confer trust. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,mkdirSync,realpathSync,lstatSync,openSync,fstatSync,readSync,closeSync,constants} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {employeeLifecycleUnit} from './employee-lifecycle-profile.mjs';
import {EMPLOYEE_LIFECYCLE_CONTROLLER_PATHS} from './employee-lifecycle-sources.mjs';
import {readEmployeeLifecycleMembers} from './employee-lifecycle-evidence.mjs';
import {employeeLifecycleNativeSql} from './employee-lifecycle-native.mjs';
import {nativePreparationEnvironment} from './candidate-environment.mjs';
const REPOSITORY='StradaverseHub/ai-hr',REPOSITORY_ID=1333414856,WORKFLOW_ID=395777276,WORKFLOW_PATH='.github/workflows/alpha-staging.yml';
const root=realpathSync(fileURLToPath(new URL('../../',import.meta.url)));
const controllerFactOwners=new WeakSet();
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const repository=value=>value?.id===REPOSITORY_ID&&value.full_name===REPOSITORY;
const stamp=value=>{assert(typeof value==='string');const time=Date.parse(value);assert(Number.isFinite(time));return time;};
export function validateEmployeeLifecycleTransport({run,job,artifact,pullRequest},plan,unit,runId){
 assert(employeeLifecycleUnit(unit));assert(Number.isSafeInteger(runId)&&runId>0);assert.equal(run.id,runId);assert.equal(run.run_attempt,1);assert(repository(run.repository)&&run.head_repository?.id===REPOSITORY_ID);assert.equal(run.workflow_id,WORKFLOW_ID);assert.equal(run.path,WORKFLOW_PATH);
 if(run.event==='pull_request'){
  assert(pullRequest&&repository(pullRequest.head?.repo)&&repository(pullRequest.base?.repo)&&pullRequest.base.ref==='alpha');assert.equal(pullRequest.head.sha,plan.sha);assert.equal(pullRequest.merge_commit_sha,plan.controller);assert.equal(run.head_sha,plan.sha);assert.equal(run.pull_requests?.length,1);assert.equal(run.pull_requests[0].number,pullRequest.number);assert.equal(run.pull_requests[0].head?.sha,plan.sha);
 }else{assert(run.event==='workflow_dispatch'||run.event==='push'&&run.head_branch==='alpha'&&plan.sha===plan.controller);assert.equal(run.head_sha,plan.controller);assert(typeof run.head_branch==='string'&&/^(?:main|alpha|codex\/[A-Za-z0-9_/-]+)$/.test(run.head_branch));}
 assert.equal(job.name,`test (${unit.id})`);assert.equal(job.run_id,runId);assert.equal(job.run_attempt,1);assert.equal(job.head_sha,run.head_sha);assert.equal(job.status,'completed');assert(['success','failure','cancelled','timed_out'].includes(job.conclusion));assert(Number.isSafeInteger(job.id)&&job.id>0);
 assert(stamp(job.completed_at)>=stamp(job.started_at));
 const commissioning=typeof run.display_title==='string'&&run.display_title.startsWith('Singleton commissioning only');assert.equal(artifact.name,(commissioning?'commission-unit-':'unit-')+unit.id);assert(Number.isSafeInteger(artifact.id)&&artifact.id>0);assert.equal(artifact.expired,false);assert(Number.isSafeInteger(artifact.size_in_bytes)&&artifact.size_in_bytes>0&&artifact.size_in_bytes<=67108864);assert(/^sha256:[a-f0-9]{64}$/.test(artifact.digest));
 assert.equal(artifact.workflow_run?.id,runId);assert.equal(artifact.workflow_run?.repository_id,REPOSITORY_ID);assert.equal(artifact.workflow_run?.head_repository_id,REPOSITORY_ID);assert.equal(artifact.workflow_run?.head_sha,run.head_sha);assert.equal(artifact.workflow_run?.head_branch,run.head_branch);assert(stamp(artifact.created_at)>=stamp(job.started_at)&&stamp(artifact.created_at)<=stamp(job.completed_at));
 return{run,job,artifact};
}
/** Pure Git blob framing, used after actual descriptor identity checks. */
export function employeeLifecycleControllerBlob(bytes,expected){
 assert(Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=1048576&&typeof expected==='string'&&/^[a-f0-9]{40}$/.test(expected));
 const blob=createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');assert.equal(blob,expected);return sha(bytes);
}
/** Exact clean controller checkout plus actual commit/tree/blob identity. This
 * reads ONLY the fixed complete CI-owner closure, never candidate-provided paths.
 * API run/controller binding is independently checked by the transport owner. */
export function readEmployeeLifecycleControllerFacts(controller){
 assert(typeof controller==='string'&&/^[a-f0-9]{40}$/.test(controller));
 const metadataEnvironment=Object.fromEntries(Object.entries(nativePreparationEnvironment(process.env)).filter(([name])=>!name.startsWith('GIT_')));Object.assign(metadataEnvironment,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_ATTR_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'});
 const git=(...args)=>execFileSync('git',['--no-replace-objects','-c','safe.directory='+root,'-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-C',root,...args],{env:metadataEnvironment,encoding:'utf8',timeout:10000,killSignal:'SIGTERM',maxBuffer:1048576}).trim();
 const clean=()=>{assert.equal(git('rev-parse','HEAD'),controller);assert.equal(git('status','--porcelain'),'');};clean();
 const tree=execFileSync('git',['--no-replace-objects','-C',root,'ls-tree','-r','-z',controller,'--',...EMPLOYEE_LIFECYCLE_CONTROLLER_PATHS],{env:metadataEnvironment,timeout:10000,killSignal:'SIGTERM',maxBuffer:1048576});
 const rows=tree.toString('utf8').split('\0');assert.equal(rows.pop(),'');const blobs=new Map();
 for(const row of rows){const match=/^(100644|100755) blob ([a-f0-9]{40})\t([^\0]+)$/.exec(row);assert(match&&EMPLOYEE_LIFECYCLE_CONTROLLER_PATHS.includes(match[3])&&!blobs.has(match[3]));blobs.set(match[3],{mode:match[1],id:match[2]});}
 assert.equal(blobs.size,EMPLOYEE_LIFECYCLE_CONTROLLER_PATHS.length);const sourceHashes={},gitBlobs={};
 for(const file of EMPLOYEE_LIFECYCLE_CONTROLLER_PATHS){
  const path=join(root,file);assert.equal(realpathSync(path),path);const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{const before=fstatSync(fd);assert(before.isFile()&&before.nlink===1&&before.uid===process.getuid()&&before.size>0&&before.size<=1048576);assert.equal(Boolean(before.mode&0o111),blobs.get(file).mode==='100755');const bytes=Buffer.alloc(before.size);let offset=0;while(offset<bytes.length){const n=readSync(fd,bytes,offset,bytes.length-offset,null);assert(n>0);offset+=n;}assert.equal(readSync(fd,Buffer.alloc(1),0,1,null),0);const after=fstatSync(fd),current=lstatSync(path);for(const key of ['dev','ino','size','mode','uid','mtimeMs','ctimeMs'])assert(before[key]===after[key]&&before[key]===current[key]);
   sourceHashes[file]=employeeLifecycleControllerBlob(bytes,blobs.get(file).id);gitBlobs[file]=blobs.get(file).id;
  }finally{closeSync(fd);}
 }
 clean();const value=Object.freeze({controller,closureSha256:sha(JSON.stringify(EMPLOYEE_LIFECYCLE_CONTROLLER_PATHS)),sourceHashes:Object.freeze(sourceHashes),gitBlobs:Object.freeze(gitBlobs)});controllerFactOwners.add(value);return value;
}
/** Caller already authenticated this exact API inventory/ZIP; the receiver
 * independently rehashes that digest before descriptor-only extraction. */
export function readEmployeeLifecycleArchive({plan,unit,run,job,artifact,pullRequest,archivePath,destination,sourceRoot,controllerFacts}){
 validateEmployeeLifecycleTransport({run,job,artifact,pullRequest},plan,unit,run.id);
 if(controllerFacts===undefined)controllerFacts=readEmployeeLifecycleControllerFacts(plan.controller);assert(controllerFactOwners.has(controllerFacts),'Controller facts must originate from the fixed clean-checkout owner');assert.equal(controllerFacts.controller,plan.controller);
 let receiver;try{receiver=JSON.parse(execFileSync('/usr/bin/python3',['-I','-B',join(root,'.github/ci/employee-lifecycle-extract.py'),archivePath,destination,unit.id,unit.files[0],artifact.digest],{env:nativePreparationEnvironment(process.env),encoding:'utf8',timeout:30000,maxBuffer:262144,stdio:['ignore','pipe','ignore']}));}catch{throw Error('Employee archive byte receiver refused');}
 assert.equal(receiver.kind,'CLOSED_EMPLOYEE_ARCHIVE_BYTES_NOT_AUTHORITY');assert.equal(receiver.unit,unit.id);assert.equal(receiver.file,unit.files[0]);assert.equal(receiver.archiveDigest,artifact.digest);assert.equal(receiver.releaseAuthorized,false);
 const members=readEmployeeLifecycleMembers(destination,unit),actual=[...members].map(([name,bytes])=>({name,bytes:bytes.length,sha256:sha(bytes)})).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);assert.deepEqual(receiver.members,actual,'Full archive member list differs from actual retained byte map');
 const sqlFile=employeeLifecycleNativeSql(unit.files[0]);let sourceSql;
 if(sqlFile){const path=join(realpathSync(sourceRoot),sqlFile);assert.equal(realpathSync(path),path);assert(lstatSync(path).isFile()&&lstatSync(path).size<=4194304);sourceSql=readFileSync(path);assert.equal(sha(sourceSql),plan.singletonSources[unit.id][sqlFile]);}
 return Object.freeze({run,job,artifact,members,sourceSql,controllerFacts});
}
const api=path=>JSON.parse(execFileSync('gh',['api',`repos/${REPOSITORY}/${path}`],{encoding:'utf8',timeout:30000,maxBuffer:16777216}));
function inventory(path,key){const all=[];for(let page=1;page<=10;page++){const value=api(path+(path.includes('?')?'&':'?')+'per_page=100&page='+page);assert(Array.isArray(value[key]));all.push(...value[key]);if(value[key].length<100)return all;}throw Error('Bounded employee API inventory exceeded');}
export async function collectEmployeeLifecycleWitness(plan,units,sourceRoot=process.cwd()){
 const selected=units.filter(unit=>employeeLifecycleUnit(unit));if(!selected.length)return new Map();
 assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');assert.equal(process.env.GITHUB_REPOSITORY,REPOSITORY);assert.equal(process.env.GITHUB_RUN_ATTEMPT,'1');assert(['verify','commission-summary'].includes(process.env.GITHUB_JOB));assert.equal(process.env.AIHR_CI_HEAD,plan.sha);assert.equal(process.env.AIHR_CI_CONTROL_HEAD,plan.controller);
 const runId=Number(process.env.GITHUB_RUN_ID);assert(Number.isSafeInteger(runId)&&runId>0);const run=api(`actions/runs/${runId}`),jobs=inventory(`actions/runs/${runId}/jobs?filter=all`,'jobs'),artifacts=inventory(`actions/runs/${runId}/artifacts`,'artifacts');
 let pullRequest;if(run.event==='pull_request'){assert.equal(run.pull_requests?.length,1);const number=run.pull_requests[0].number;assert(Number.isSafeInteger(number)&&number>0);pullRequest=api('pulls/'+number);}
 const commissioning=typeof run.display_title==='string'&&run.display_title.startsWith('Singleton commissioning only');assert.equal(process.env.GITHUB_JOB==='commission-summary',commissioning);
 const controllerFacts=readEmployeeLifecycleControllerFacts(plan.controller);
 const cases=selected.map(unit=>{const matches=jobs.filter(job=>job.name===`test (${unit.id})`),archives=artifacts.filter(artifact=>artifact.name===(commissioning?'commission-unit-':'unit-')+unit.id);assert.equal(matches.length,1);assert.equal(archives.length,1);const job=matches[0],artifact=archives[0];validateEmployeeLifecycleTransport({run,job,artifact,pullRequest},plan,unit,runId);return{unit,job,artifact};});
 const temporary=realpathSync(process.env.RUNNER_TEMP),directory=join(temporary,'employee-api-evidence-'+randomUUID());mkdirSync(directory,{mode:0o700});
 // Dynamic FIXED import avoids the existing release-policy/commission-summary
 // ESM cycle; it is never a caller-selected module or application loader.
 const {downloadCiArchives,readCiArchive}=await import('./archive-downloads.mjs');await downloadCiArchives(cases.map(value=>value.artifact),directory,{concurrency:2,timeoutMs:120000});
 const result=new Map();for(const {unit,job,artifact}of cases){const archivePath=join(directory,artifact.name+'.zip');readCiArchive(artifact,archivePath);result.set(unit.id,readEmployeeLifecycleArchive({plan,unit,run,job,artifact,pullRequest,archivePath,destination:join(directory,unit.id),sourceRoot,controllerFacts}));}
 return result;
}
