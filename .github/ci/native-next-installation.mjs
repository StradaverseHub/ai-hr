/** Read-only trusted-install capture. Call before classifier/migration/test children.
 * Package-manager installation is an explicit preceding trusted boundary. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {openSync,closeSync,fstatSync,readFileSync,realpathSync,lstatSync,constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,posix} from 'node:path';
import {nativePreparationEnvironment} from './candidate-environment.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const BOOTSTRAP_CONTEXT=new Set(('GITHUB_ACTIONS GITHUB_JOB GITHUB_REPOSITORY GITHUB_REPOSITORY_ID GITHUB_WORKFLOW GITHUB_WORKFLOW_REF GITHUB_WORKFLOW_SHA GITHUB_RUN_ID GITHUB_RUN_ATTEMPT GITHUB_RUN_NUMBER GITHUB_SHA GITHUB_REF GITHUB_REF_NAME GITHUB_REF_TYPE GITHUB_HEAD_REF GITHUB_BASE_REF GITHUB_EVENT_NAME GITHUB_WORKSPACE GITHUB_SERVER_URL GITHUB_API_URL GITHUB_GRAPHQL_URL RUNNER_ENVIRONMENT RUNNER_OS RUNNER_ARCH RUNNER_TEMP RUNNER_TOOL_CACHE RUNNER_NAME CI AIHR_CI_HEAD AIHR_CI_CONTROL_HEAD AIHR_CI_MIGRATION_BASE AIHR_CI_PG_PROFILE AIHR_CI_PG_CONFIGURED_CAP_BYTES AIHR_CI_PG_PEAK_BUDGET_BYTES AIHR_CI_PG_JIT').split(' '));
function stableBytes(path,maximum,uid){
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const before=fstatSync(fd);assert(before.isFile()&&[0,uid].includes(before.uid)&&(before.mode&0o022)===0&&before.size>0&&before.size<=maximum);
  assert.equal(realpathSync('/proc/self/fd/'+fd),realpathSync(path));
  const bytes=readFileSync(fd),after=fstatSync(fd),named=lstatSync(path);assert.equal(bytes.length,before.size);
  for(const key of ['dev','ino','size','mode','uid','mtimeMs','ctimeMs'])assert(before[key]===after[key]&&before[key]===named[key],'Installation input changed while reading');
  return bytes;
 }finally{closeSync(fd);}
}
export function installationShape(value){
 assert(value&&typeof value==='object'&&!Array.isArray(value));
 assert.deepEqual(Object.keys(value).sort(),['dependencies','kind','lockSha256','node','packageSha256','version']);
 assert.equal(value.version,1);assert.equal(value.kind,'LOCKED_HOSTED_INSTALL_BEFORE_CANDIDATE_VERIFICATION');
 for(const key of ['lockSha256','packageSha256'])assert(/^[a-f0-9]{64}$/.test(value[key]));
 assert.deepEqual(Object.keys(value.node).sort(),['bytes','path','sha256']);
 assert(typeof value.node.path==='string'&&value.node.path.startsWith('/')&&value.node.path.length<=4096
  &&posix.normalize(value.node.path)===value.node.path&&!value.node.path.split('/').some(part=>part==='.'||part==='..')&&!/[\x00-\x1f\x7f]/.test(value.node.path));
 assert(/^[a-f0-9]{64}$/.test(value.node.sha256)&&Number.isSafeInteger(value.node.bytes)&&value.node.bytes>0&&value.node.bytes<=256*1024**2);
 assert.deepEqual(Object.keys(value.dependencies).sort(),['bytes','entries','normalization','sha256']);
 const d=value.dependencies;assert.equal(d.normalization,'ROOT_COPY_DEPENDENCIES_V2');assert(/^[a-f0-9]{64}$/.test(d.sha256));
 assert(Number.isSafeInteger(d.entries)&&d.entries>0&&d.entries<=500000&&Number.isSafeInteger(d.bytes)&&d.bytes>0&&d.bytes<=4*1024**3);
 return value;
}
export function readProtectedBootstrap(env=process.env){
 assert(/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID??'')&&/^[a-f0-9]{40}$/.test(env.AIHR_CI_HEAD??'')&&/^[a-f0-9]{40}$/.test(env.AIHR_CI_CONTROL_HEAD??''));
 const root='/var/lib/aihr-native-controller/'+env.GITHUB_RUN_ID,path=root+'/bootstrap.json';
 let ancestor='';for(const part of root.split('/').filter(Boolean)){
  ancestor+='/'+part;const st=lstatSync(ancestor);assert(st.isDirectory()&&!st.isSymbolicLink()&&st.uid===0&&(st.mode&0o022)===0,'Protected bootstrap ancestor differs');
 }
 const st=lstatSync(path);assert(st.uid===0&&st.nlink===1&&(st.mode&0o777)===0o444,'Protected public bootstrap receipt differs');
 const value=JSON.parse(stableBytes(path,128*1024,0));
 assert.deepEqual(Object.keys(value).sort(),['automation','candidate','context','controller','controllerBytes','controllerEntries','controllerTreeSha256','eventSha256','kind','node','protectedNodePath','runId','runnerGid','runnerUid','toolBins','version','workspace']);
 assert.equal(value.version,1);assert.equal(value.kind,'PROTECTED_NATIVE_CONTROLLER_BEFORE_PACKAGE_INVOCATION');
 assert.equal(value.candidate,env.AIHR_CI_HEAD);assert.equal(value.controller,env.AIHR_CI_CONTROL_HEAD);assert.equal(value.runId,env.GITHUB_RUN_ID);
 assert.equal(value.workspace,realpathSync(env.GITHUB_WORKSPACE));assert.equal(value.protectedNodePath,root+'/node');
 assert.equal(value.automation,root+'/automation');
 const node=lstatSync(value.protectedNodePath);assert(node.isFile()&&!node.isSymbolicLink()&&node.uid===0&&node.nlink===1&&(node.mode&0o777)===0o555);
 assert.equal(value.runnerUid,process.getuid());assert.equal(value.runnerGid,process.getgid());
 assert(value.context&&typeof value.context==='object'&&!Array.isArray(value.context));
 for(const[key,text]of Object.entries(value.context))assert(BOOTSTRAP_CONTEXT.has(key)&&typeof text==='string'&&Buffer.byteLength(text)<=8192&&!text.includes('\0'));
 for(const[key,text]of Object.entries({GITHUB_ACTIONS:'true',CI:'true',GITHUB_JOB:'native-test',GITHUB_REPOSITORY:'StradaverseHub/ai-hr',GITHUB_REPOSITORY_ID:'1333414856',RUNNER_ENVIRONMENT:'github-hosted',RUNNER_OS:'Linux',GITHUB_RUN_ATTEMPT:'1',
  GITHUB_RUN_ID:value.runId,AIHR_CI_HEAD:value.candidate,AIHR_CI_CONTROL_HEAD:value.controller,GITHUB_SHA:value.controller,GITHUB_WORKSPACE:value.workspace,RUNNER_TEMP:'/home/runner/work/_temp'})){
  assert.equal(value.context[key],text);assert.equal(env[key],text);
 }
 assert(Array.isArray(value.toolBins)&&value.toolBins.length>0&&value.toolBins.length<=2&&new Set(value.toolBins).size===value.toolBins.length);
 for(const directory of value.toolBins)assert(typeof directory==='string'&&directory.length<=4096&&(directory.startsWith('/home/runner/')||directory.startsWith('/opt/hostedtoolcache/'))&&realpathSync(directory)===directory&&lstatSync(directory).isDirectory());
 assert(/^[a-f0-9]{64}$/.test(value.eventSha256));
 assert(/^[a-f0-9]{64}$/.test(value.controllerTreeSha256)&&Number.isSafeInteger(value.controllerEntries)&&value.controllerEntries>0
  &&value.controllerEntries<=200000&&Number.isSafeInteger(value.controllerBytes)&&value.controllerBytes>0&&value.controllerBytes<=4*1024**3);
 // Validate the shared node record with the same closed schema as the final
 // seal. Dependency values here are placeholders for schema validation only;
 // actual dependencies are captured independently after the locked install.
 installationShape({version:1,kind:'LOCKED_HOSTED_INSTALL_BEFORE_CANDIDATE_VERIFICATION',node:value.node,
  dependencies:{normalization:'ROOT_COPY_DEPENDENCIES_V2',sha256:'0'.repeat(64),entries:1,bytes:1},lockSha256:'0'.repeat(64),packageSha256:'0'.repeat(64)});
 return value;
}
export function readProtectedNativeEvent(env=process.env,bootstrap=readProtectedBootstrap(env)){
 const path='/var/lib/aihr-native-controller/'+env.GITHUB_RUN_ID+'/event.json';assert.equal(env.GITHUB_EVENT_PATH,path);
 const st=lstatSync(path);assert(st.isFile()&&!st.isSymbolicLink()&&st.uid===0&&st.nlink===1&&(st.mode&0o777)===0o444);
 const bytes=stableBytes(path,1024**2,0);assert.equal(sha(bytes),bootstrap.eventSha256);return bytes;
}
// This fixed program imports no checkout/dependency module. Both stdlib helper
// bodies are already cached and verified against source/controller Git blobs.
const INVENTORY_PROGRAM=String.raw`
import base64,json,os,pathlib,sys,types
def need(ok,message):
 if not ok: raise ValueError(message)
raw=sys.stdin.buffer.read(3*1024**2+1)
need(0<len(raw)<=3*1024**2,'Bounded installation request required')
r=json.loads(raw)
need(set(r)=={'source','uid','inventory','package'},'Closed installation request required')
def module(name,encoded):
 m=types.ModuleType(name);sys.modules[name]=m
 exec(compile(base64.b64decode(encoded,validate=True),'<protected-'+name+'>','exec'),m.__dict__)
 return m
I=module('native_install_inventory',r['inventory'])
P=module('native_install_package',r['package'])
print(json.dumps(P.semantic_dependency_inventory(pathlib.Path(r['source']),I,r['uid'],need)))
`;
export function captureInstallation({source,helpers,bootstrap},env=process.env){
 assert(process.platform==='linux'&&process.versions.node==='22.23.3'&&process.getuid()>0);
 assert.equal(env.GITHUB_JOB,'native-test');assert.equal(env.RUNNER_ENVIRONMENT,'github-hosted');
 assert.equal(realpathSync(source),source);const uid=process.getuid();
 // The bootstrap receipt is independently root-owned and made BEFORE install
 // hooks. The owner runs its protected executable, never a post-hook PATH Node.
 assert.equal(bootstrap.candidate,env.AIHR_CI_HEAD);assert.equal(bootstrap.controller,env.AIHR_CI_CONTROL_HEAD);
 assert.equal(bootstrap.runId,env.GITHUB_RUN_ID);
 const actual=realpathSync('/proc/self/exe');assert.equal(actual,bootstrap.protectedNodePath);
 const executable=stableBytes(actual,256*1024**2,uid),original=stableBytes(bootstrap.node.path,256*1024**2,uid);
 assert.equal(sha(executable),bootstrap.node.sha256);assert.equal(executable.length,bootstrap.node.bytes);
 assert.equal(sha(original),bootstrap.node.sha256);assert.equal(original.length,bootstrap.node.bytes);
 const lockBytes=stableBytes(join(source,'pnpm-lock.yaml'),16*1024**2,uid),packageBytes=stableBytes(join(source,'package.json'),1024**2,uid);
 const dependencies=JSON.parse(execFileSync('/usr/bin/python3',['-I','-B','-c',INVENTORY_PROGRAM],{
  env:nativePreparationEnvironment(env),input:JSON.stringify({source,uid,inventory:helpers['runtime_inventory.py'].base64,package:helpers['next_native_package.py'].base64}),
  encoding:'utf8',timeout:120000,maxBuffer:65536,stdio:['pipe','pipe','pipe']}));
 const installation=installationShape({version:1,kind:'LOCKED_HOSTED_INSTALL_BEFORE_CANDIDATE_VERIFICATION',node:{...bootstrap.node},dependencies,
  lockSha256:sha(lockBytes),packageSha256:sha(packageBytes)});
 return{installation,lockBytes,packageBytes};
}
