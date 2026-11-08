/** Cooperative actual-CI process admission, not an OS/security/release sandbox.
 * This owner starts NO process and cannot authorize a CLI argument or profile. */
import assert from 'node:assert/strict';
import {openSync,readSync,closeSync,lstatSync,fstatSync,realpathSync,readlinkSync,writeFileSync,linkSync,unlinkSync,mkdirSync,readdirSync,constants} from 'node:fs';
import {join,resolve,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
const selector='test/compiler-native-reference-fixture.test.ts';
const names={adapter:'.github/ci/compiler-reference-supervisor.py',kernel:'.github/ci/owned-process.py',
 owner:'.github/ci/focused-checks.mjs',fixture:'.github/ci/diagnostics/native-reference/fixture.mjs',
 manifest:'docs/qualification/compiler-reference-owned-source-20261108.json'};
const referencePurpose=Object.freeze({selector,names,stage:'compiler-reference',kind:'COMPILER_REFERENCE_OWNED_PROCESS_SOURCE_NOT_QUALIFICATION',preflight:'compiler-reference-preflight.json',preflightKind:'OWNED_COMPILER_REFERENCE_PREFLIGHT_NOT_RELEASE',clock:'compiler-reference-clock',clockKind:'OWNED_COMPILER_REFERENCE_720_CLOCK'});
const applicationPurpose=Object.freeze({selector:'test/compiler-native-application-inventory.test.ts',names:{...names,fixture:'.github/ci/diagnostics/native-reference/application-inventory.mjs',manifest:'docs/qualification/compiler-native-application-inventory-source-20261108.json'},stage:'compiler-application-inventory',kind:'COMPILER_NATIVE_APPLICATION_INVENTORY_SOURCE_NOT_QUALIFICATION',preflight:'compiler-application-inventory-preflight.json',preflightKind:'OWNED_COMPILER_APPLICATION_INVENTORY_PREFLIGHT_NOT_RELEASE',clock:'compiler-application-inventory-clock',clockKind:'OWNED_COMPILER_APPLICATION_INVENTORY_720_CLOCK'});
const applicationProofs=new WeakSet();
const sha=value=>createHash('sha256').update(value).digest('hex');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const positive=value=>typeof value==='string'&&/^[1-9][0-9]{0,19}(?![\s\S])/.test(value);
const sourceSha=value=>typeof value==='string'&&/^[a-f0-9]{40}(?![\s\S])/.test(value);
export function boundedCompilerBytes(path,maximum,{proc=false}={}){
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const before=fstatSync(fd);assert(before.isFile()&&before.nlink===1&&before.uid===process.getuid());
  if(!proc)assert(before.uid===process.getuid()&&(before.mode&0o022)===0&&before.size>0&&before.size<=maximum);
  const output=Buffer.alloc(maximum+1);let count=0;
  while(count<output.length){const n=readSync(fd,output,count,output.length-count,null);if(!n)break;count+=n;}
  assert(count<=maximum);if(!proc){const after=fstatSync(fd),named=lstatSync(path);for(const key of ['dev','ino','size','mode','uid','mtimeMs','ctimeMs'])assert(before[key]===after[key]&&before[key]===named[key]);assert(count===before.size);}
  return output.subarray(0,count);
 }finally{closeSync(fd);}
}
export function compilerProcIdentity(pid){
 assert(Number.isSafeInteger(pid)&&pid>1);const value=boundedCompilerBytes('/proc/'+pid+'/stat',65536,{proc:true}).toString('utf8');
 const first=value.indexOf(' ('),last=value.lastIndexOf(') ');assert(first>0&&last>first&&Number(value.slice(0,first))===pid);
 const fields=value.slice(last+2).trim().split(/\s+/);assert(fields.length>=20);
 const row={pid,parent:Number(fields[1]),group:Number(fields[2]),session:Number(fields[3]),start:Number(fields[19]),state:fields[0]};
 assert([row.parent,row.group,row.session,row.start].every(Number.isSafeInteger));assert(!['Z','X'].includes(row.state));return row;
}
const stable=(a,b)=>['pid','parent','group','session','start'].every(key=>a[key]===b[key]);
const argv=pid=>{const value=boundedCompilerBytes('/proc/'+pid+'/cmdline',65536,{proc:true});assert(value.at(-1)===0);return value.subarray(0,-1).toString('utf8').split('\0');};
function regular(path){assert(isAbsolute(path)&&realpathSync(path)===path);return boundedCompilerBytes(path,4*1024*1024);}
export function admitCompilerReference(role='wrapper'){return admitCompilerPurpose(role,referencePurpose);}
export function admitCompilerApplicationInventory(role='wrapper'){const proof=admitCompilerPurpose(role,applicationPurpose);applicationProofs.add(proof);return proof;}
function admitCompilerPurpose(role,purpose){
 assert(purpose===referencePurpose||purpose===applicationPurpose);const {selector,names}=purpose;
 assert(['wrapper','fixture',...(purpose===applicationPurpose?['inventory-worker']:[])].includes(role));assert(process.platform==='linux'&&process.getuid()>0&&process.versions.node==='22.23.3');
 for(const [key,value]of Object.entries({GITHUB_ACTIONS:'true',CI:'true',RUNNER_ENVIRONMENT:'github-hosted',RUNNER_OS:'Linux',GITHUB_REPOSITORY:'StradaverseHub/ai-hr',GITHUB_WORKFLOW:'alpha-focused-checks',GITHUB_JOB:'selected-tests',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_RUN_ATTEMPT:'1'}))assert(process.env[key]===value);
 assert(positive(process.env.GITHUB_RUN_ID)&&sourceSha(process.env.AIHR_CI_HEAD)&&sourceSha(process.env.AIHR_CI_CONTROL_HEAD));assert(same(JSON.parse(process.env.AIHR_FOCUSED_TESTS??'null'),[selector]));
 const workspace=realpathSync(process.env.GITHUB_WORKSPACE),source=join(workspace,'source'),controller=join(workspace,'automation'),temp=realpathSync(process.env.RUNNER_TEMP),destination=join(temp,'aihr-focused');
 assert(realpathSync(source)===source&&realpathSync(controller)===controller&&realpathSync(process.cwd())===source);
 assert(realpathSync(destination)===destination&&process.env.AIHR_FOCUSED_EVIDENCE_DIR===destination);
 const self=compilerProcIdentity(process.pid),monitor=compilerProcIdentity(self.session);assert(self.group===monitor.pid&&self.session===monitor.pid&&self.pid!==monitor.pid);
 assert(monitor.group===monitor.pid&&monitor.session===monitor.pid&&monitor.parent>1);
 const parent=compilerProcIdentity(monitor.parent),nodeOwner=compilerProcIdentity(parent.parent);
 assert(realpathSync('/proc/'+parent.pid+'/exe')===realpathSync('/usr/bin/python3')&&realpathSync('/proc/'+monitor.pid+'/exe')===realpathSync('/usr/bin/python3'));
 const pythonArgv=argv(parent.pid);assert(pythonArgv.length===5&&same(pythonArgv.slice(0,3),['/usr/bin/python3','-I','-B'])&&pythonArgv[3]===join(controller,names.adapter));
 assert(same(argv(monitor.pid),pythonArgv));const request=JSON.parse(pythonArgv[4]);
 const expected={stage:purpose.stage,node:process.execPath,controller,destination};assert(same(request,expected)&&pythonArgv[4]===JSON.stringify(expected));
 const node=realpathSync(process.execPath);assert(realpathSync('/proc/self/exe')===node&&realpathSync('/proc/'+nodeOwner.pid+'/exe')===node);
 const ownerArgv=argv(nodeOwner.pid),ownerCwd=readlinkSync('/proc/'+nodeOwner.pid+'/cwd');
 assert(ownerArgv.length===4&&resolve(ownerCwd,ownerArgv[1])===join(controller,names.owner)&&same(ownerArgv.slice(2),['run',destination])&&ownerCwd===source);
 const children=boundedCompilerBytes('/proc/'+parent.pid+'/task/'+parent.pid+'/children',65536,{proc:true}).toString('utf8').trim().split(/\s+/).filter(Boolean).map(Number);assert(same(children,[monitor.pid]));
 const ancestors=[];let current=self;
 for(let depth=0;depth<32;depth++){
  assert(!ancestors.some(row=>row.pid===current.pid));ancestors.push(current);if(current.pid===monitor.pid)break;
  assert(current.group===monitor.pid&&current.session===monitor.pid);current=compilerProcIdentity(current.parent);
 }
 assert(ancestors.at(-1).pid===monitor.pid);
 const preflight=JSON.parse(regular(join(destination,purpose.preflight)));
 assert(same(Object.keys(preflight).sort(),['actor','attempt','controller','kind','run','source','sourceHashes','version']));
 assert(preflight.version===1&&preflight.kind===purpose.preflightKind&&preflight.source===process.env.AIHR_CI_HEAD&&preflight.controller===process.env.AIHR_CI_CONTROL_HEAD&&preflight.run===process.env.GITHUB_RUN_ID&&preflight.attempt==='1');
 assert(same(preflight.actor,{pid:nodeOwner.pid,start:nodeOwner.start}));
 const manifest=regular(join(source,names.manifest));assert(manifest.equals(regular(join(controller,names.manifest))));
 const declaration=JSON.parse(manifest);assert(declaration.kind===purpose.kind);
 assert(same(preflight.sourceHashes,declaration.componentSources));
 for(const [path,wanted]of Object.entries(declaration.componentSources)){assert((/^\.github\/|^test\/|^scripts\/|^docs\/qualification\/|^vitest[.]/.test(path)||['package.json','pnpm-lock.yaml','tsconfig.json','tsconfig.build.json','next.config.ts','.env.example','mobile/package.json','mobile/package-lock.json'].includes(path))&&!path.split('/').includes('..'));assert(typeof wanted==='string'&&/^[a-f0-9]{64}(?![\s\S])/.test(wanted));assert(sha(regular(join(source,path)))===wanted&&sha(regular(join(controller,path)))===wanted);}
 assert(declaration.componentSources[names.adapter]&&declaration.componentSources[names.kernel]&&declaration.componentSources[names.owner]&&declaration.componentSources[names.fixture]);
 if(purpose===applicationPurpose)for(const path of [selector,'.github/ci/diagnostics/native-reference/application-worker.mjs','.github/ci/diagnostics/native-reference/application-inputs.mjs','.github/ci/diagnostics/native-reference/application-protocol.mjs','tsconfig.json','tsconfig.build.json','next.config.ts'])assert(declaration.componentSources[path],'Complete closed application inventory source owner required');
 if(role==='inventory-worker'){const actual=argv(process.pid);assert(same(actual,[process.execPath,'--max-old-space-size=12288',join(source,'.github/ci/diagnostics/native-reference/application-worker.mjs')]));}
 else if(role==='fixture'){assert(same(argv(process.pid),[process.execPath,'--max-old-space-size=12288',join(source,names.fixture)]));}
 else{const worker=realpathSync(join(source,'node_modules/vitest/dist/workers/forks.js'));assert(realpathSync(process.argv[1])===worker&&realpathSync(argv(process.pid).at(-1))===worker);}
 for(const row of [self,monitor,parent,nodeOwner,...ancestors])assert(stable(row,compilerProcIdentity(row.pid)));
 return{source,controller,destination,monitor:{pid:monitor.pid,start:monitor.start},self:{pid:self.pid,start:self.start},nodeOwner:{pid:nodeOwner.pid,start:nodeOwner.start},ancestors,run:preflight.run,attempt:preflight.attempt,sourceHead:preflight.source,controllerHead:preflight.controller,sourceHashes:preflight.sourceHashes};
}
/** Atomic mkdir readiness is published ONLY after link/unlink reaches nlink1.
 * Missing readiness is pending, never a reason to weaken the bounded reader. */
export function readPublishedCompilerBytes(path,maximum){
 const ready=path+'.ready';let descriptor;
 try{descriptor=openSync(ready,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK|constants.O_DIRECTORY);}
 catch(error){if(error.code==='ENOENT')return undefined;throw error;}
 try{
  const before=fstatSync(descriptor);assert(before.isDirectory()&&before.uid===process.getuid()&&(before.mode&0o7777)===0o700);
  assert(realpathSync(ready)===ready&&readdirSync(ready).length===0);
  const value=boundedCompilerBytes(path,maximum),after=fstatSync(descriptor),named=lstatSync(ready);
  for(const key of ['dev','ino','mode','uid','mtimeMs','ctimeMs'])assert(before[key]===after[key]&&before[key]===named[key]);
  return value;
 }finally{closeSync(descriptor);}
}
const clockPath=(proof,purpose)=>join(proof.destination,purpose.clock+'.json');
export function publishCompilerReferenceClock(proof,signal,started){return publishCompilerClock(proof,signal,started,referencePurpose);}
export function publishCompilerApplicationInventoryClock(proof,signal,started){assert(applicationProofs.has(proof),'Actual application inventory admission required');return publishCompilerClock(proof,signal,started,applicationPurpose);}
async function publishCompilerClock(proof,signal,started,purpose){
 signal?.throwIfAborted();const now=process.hrtime.bigint();assert(typeof started==='bigint'&&started<=now&&now-started<=BigInt(3000000000));
 const startNs=String(started),clock={version:1,kind:purpose.clockKind,run:proof.run,attempt:proof.attempt,source:proof.sourceHead,controller:proof.controllerHead,monitor:proof.monitor,wrapper:proof.self,startNs};
 const file=clockPath(proof,purpose),pending=file+'.pending';writeFileSync(pending,JSON.stringify(clock),{flag:'wx',mode:0o600});linkSync(pending,file);unlinkSync(pending);mkdirSync(file+'.ready',{mode:0o700});
 const ack=join(proof.destination,purpose.clock+'-ack.json'),until=process.hrtime.bigint()+BigInt(3000000000);
 for(;;){signal?.throwIfAborted();const raw=readPublishedCompilerBytes(ack,4*1024*1024);if(raw!==undefined){assert((lstatSync(ack).mode&0o077)===0&&same(JSON.parse(raw),clock));return clock;}assert(process.hrtime.bigint()<until,'Compiler external clock ACK absent');await new Promise(resolve=>setTimeout(resolve,20));}
}
export function readCompilerReferenceClock(proof){return readCompilerClock(proof,referencePurpose);}
export function readCompilerApplicationInventoryClock(proof){assert(applicationProofs.has(proof),'Actual application inventory admission required');return readCompilerClock(proof,applicationPurpose);}
function readCompilerClock(proof,purpose){
 const raw=readPublishedCompilerBytes(clockPath(proof,purpose),4*1024*1024);assert(raw!==undefined&&(lstatSync(clockPath(proof,purpose)).mode&0o077)===0);const clock=JSON.parse(raw);assert(clock.version===1&&clock.kind===purpose.clockKind&&positive(clock.startNs));
 assert(clock.source===proof.sourceHead&&clock.controller===proof.controllerHead&&clock.run===proof.run&&clock.attempt===proof.attempt&&same(clock.monitor,proof.monitor));
 const wrapper=compilerProcIdentity(clock.wrapper.pid);assert(wrapper.start===clock.wrapper.start&&wrapper.group===proof.monitor.pid&&wrapper.session===proof.monitor.pid&&proof.ancestors.some(row=>row.pid===wrapper.pid&&row.start===wrapper.start));
 const ack=readPublishedCompilerBytes(join(proof.destination,purpose.clock+'-ack.json'),4*1024*1024);assert(ack!==undefined&&same(JSON.parse(ack),clock));return clock;
}
