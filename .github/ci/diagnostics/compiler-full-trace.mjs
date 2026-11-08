/** Fixed stock full-project trace evidence. Never an ordinary gate or execution broker. */
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {openSync,closeSync,fstatSync,lstatSync,readSync,readFileSync,writeSync,writeFileSync,
 mkdirSync,readdirSync,opendirSync,realpathSync,statfsSync,unlinkSync,renameSync,appendFileSync,constants} from 'node:fs';
import {join,resolve,relative,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {cpus,totalmem} from 'node:os';

export const LIMITS=Object.freeze({jobMs:1800000,reserveMs:180000,typegenMs:120000,showMs:30000,
 inventoryMs:120000,checkMs:720000,killMs:10000,collectMs:20000,fileBytes:512*1024**2,
 totalBytes:1024**3,logBytes:16*1024**2,metadataBytes:16*1024**2,reportBytes:1024**2,
 monitorRows:1000,freeBefore:20*1024**3,freeDuring:2*1024**3});
const BASE='0f50e869e9e74f012803e8aafe1f3350e8792605';
const GUARD='test/types/database-client-native-contract.ts';
const PAIR_PATH=fileURLToPath(new URL('./compiler-full-trace-pair.json',import.meta.url));
const HASH=/^[a-f0-9]{64}$/,COMMIT=/^[a-f0-9]{40}$/,positive=/^[1-9][0-9]{0,15}$/;
const hash=b=>createHash('sha256').update(b).digest('hex');
const exact=(o,keys)=>assert.deepEqual(Object.keys(o).sort(),keys.slice().sort(),'Unexpected closed record keys');
const exists=p=>{try{lstatSync(p);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
const free=p=>{const s=statfsSync(p);return s.bavail*s.bsize;};
const now=()=>process.hrtime.bigint();
const INPUT_DEFAULTS=Object.freeze({qualify_restricted_port_prerequisites:false,profile_database:false,
 duration_order:false,run_native_typecheck:false,run_native_swift_models:false,run_native_bundle:false,
 run_build:false,model_eval:'',eval_budget_usd:'20',eval_allowed_providers:''});
const REQUIRED=['candidate_ref','expected_sha','selected_tests','compiler_full_trace','run_typecheck'];
const COMMON_FILES=['tsconfig.json','pnpm-lock.yaml','package.json'];
const COMPILER_FILES=['node_modules/typescript/package.json','node_modules/typescript/lib/tsc.js',
 'node_modules/typescript/lib/_tsc.js','node_modules/typescript/lib/typescript.js'];
const EXPORTS=Object.freeze(['report.json','inputs.json','resources.json','compiler.log','monitor.jsonl',
 'typegen.json','swap-cleanup.json','trace/trace.json','trace/types.json']);
const RAW=Object.freeze([...EXPORTS.filter(p=>p!=='swap-cleanup.json'),'show-config.json','list-files.txt',
 'whole-project.tsbuildinfo']);
function pin(p){exact(p,['path','bytes','sha256']);assert(typeof p.path==='string'&&Number.isSafeInteger(p.bytes)&&p.bytes>0&&HASH.test(p.sha256));}
export function validatePairData(pair){
 exact(pair,['version','kind','base','guard','control','candidate','common','trackedInputCount','trackedInputPathsSha256']);
 assert.equal(pair.version,1);assert.equal(pair.kind,'FIXED_TWO_SOURCE_STOCK_FULL_TRACE_PAIR');assert.equal(pair.base,BASE);
 pin(pair.guard);assert.equal(pair.guard.path,GUARD);
 for(const cell of [pair.control,pair.candidate]){
  exact(cell,['source','parent','branch','dbClient']);assert(COMMIT.test(cell.source)&&COMMIT.test(cell.parent));
  assert(/^codex\/[A-Za-z0-9_./-]+$/.test(cell.branch)&&!cell.branch.split('/').some(x=>!x||x==='.'||x==='..'));
  pin(cell.dbClient);assert.equal(cell.dbClient.path,'db/client.ts');
 }
 assert.equal(pair.control.parent,BASE);assert.equal(pair.candidate.parent,pair.control.source);
 assert.notEqual(pair.control.source,pair.candidate.source);
 assert(Array.isArray(pair.common)&&pair.common.length===7);
 assert.deepEqual(pair.common.map(p=>p.path).sort(),[...COMMON_FILES,...COMPILER_FILES].sort());pair.common.forEach(pin);
 assert(Number.isSafeInteger(pair.trackedInputCount)&&pair.trackedInputCount>0&&HASH.test(pair.trackedInputPathsSha256));
 return pair;
}
export function validateTraceInputs(value,pair){
 validatePairData(pair);assert(value&&typeof value==='object'&&!Array.isArray(value));
 for(const k of Object.keys(value))assert([...REQUIRED,...Object.keys(INPUT_DEFAULTS)].includes(k),'Unknown trace input');
 for(const k of REQUIRED)assert(Object.hasOwn(value,k),'Required trace input missing');
 assert.equal(value.compiler_full_trace,true);assert.equal(value.run_typecheck,true);assert.equal(value.selected_tests,'[]');
 for(const [k,v]of Object.entries(INPUT_DEFAULTS))assert.equal(value[k]===undefined?v:value[k],v,'Mixed operation/default');
 const cell=[pair.control,pair.candidate].find(c=>c.source===value.expected_sha);assert(cell,'Unfrozen trace source');
 assert.equal(value.candidate_ref,cell.branch);return cell;
}
export function stageBudget(anchor,at,workMs){
 assert(typeof anchor==='bigint'&&typeof at==='bigint'&&anchor>0n&&at>=anchor,'Invalid native clock');
 assert([LIMITS.typegenMs,LIMITS.showMs,LIMITS.inventoryMs,LIMITS.checkMs,LIMITS.collectMs].includes(workMs));
 const elapsedMs=Number((at-anchor)/1000000n);
 assert(Number.isSafeInteger(elapsedMs)&&elapsedMs>=0);
 const collector=workMs===LIMITS.collectMs,reserveMs=collector?0:LIMITS.reserveMs,killMs=collector?0:LIMITS.killMs;
 assert(LIMITS.jobMs-elapsedMs-reserveMs>=workMs+killMs,'Complete diagnostic stage no longer fits');
 return {elapsedMs,workMs,killMs,reserveMs};
}
export function stockCommand(stage,source,out,nodePath){
 assert(['typegen','show','inventory','check'].includes(stage));
 assert(resolve(source)===source&&resolve(out)===out&&resolve(nodePath)===nodePath);
 const duration={typegen:120,show:30,inventory:120,check:720}[stage];
 const front=['--verbose','--signal=TERM','--kill-after=10s',duration+'s','/usr/bin/time','-v',
  '/usr/bin/prlimit','--core=0','--fsize='+LIMITS.fileBytes,'--'];
 if(stage==='typegen')return {command:'/usr/bin/timeout',args:[...front,'pnpm','exec','next','typegen']};
 const flags=['--noEmit','--pretty','false','--tsBuildInfoFile',join(out,'whole-project.tsbuildinfo')];
 if(stage==='show')flags.push('--showConfig');
 else if(stage==='inventory')flags.push('--listFilesOnly');
 else flags.push('--extendedDiagnostics','--generateTrace',join(out,'trace'));
 return {command:'/usr/bin/timeout',args:[...front,nodePath,join(source,'node_modules/typescript/lib/tsc.js'),...flags]};
}
export function compilerOutcome(result,text){
 const files=Number(text.match(/^Files:\s+([0-9]+)\s*$/m)?.[1]);
 const diagnostics=[...text.matchAll(/\berror TS[0-9]+:/g)].length;
 return {...result,files:Number.isSafeInteger(files)&&files>0?files:null,diagnosticsObserved:diagnostics,
  v8HeapFailure:/FATAL ERROR:.*(?:heap|Allocation failed)/i.test(text),
  compilerCompleted:result.closed===true&&result.code===0&&result.signal===null&&!result.stoppedBecause&&!result.error&&!result.stopError
   &&Number.isSafeInteger(files)&&files>0&&diagnostics===0,
  wrapperSignalIsNotAssumedNativeCompilerSignal:true};
}
export function sameStat(a,b){return a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;}
function directory(p){
 assert.equal(realpathSync(p),resolve(p));const s=lstatSync(p);
 assert(s.isDirectory()&&!s.isSymbolicLink()&&s.uid===process.getuid()&&(s.mode&0o077)===0,'Private directory custody');return s;
}
export function readHeld(path,maximum,privateFile=false){
 const before=lstatSync(path);assert(before.isFile()&&!before.isSymbolicLink()&&before.size<=maximum,'Bounded regular file required');
 if(privateFile)assert(before.nlink===1&&before.uid===process.getuid()&&(before.mode&0o077)===0,'Private file custody');
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{assert(sameStat(before,fstatSync(fd)),'Replaced input');const b=Buffer.alloc(before.size);let offset=0;
  while(offset<b.length){const n=readSync(fd,b,offset,b.length-offset,offset);assert(n>0,'Truncated input');offset+=n;}
  assert.equal(readSync(fd,Buffer.alloc(1),0,1,offset),0,'Grown input');assert(sameStat(before,fstatSync(fd))&&sameStat(before,lstatSync(path)),'Unstable or replaced named input');
  return {bytes:b,stat:before,sha256:hash(b)};
 }finally{closeSync(fd);}
}
function fileHash(path,maximum=LIMITS.fileBytes,privateFile=false){
 const before=lstatSync(path);assert(before.isFile()&&!before.isSymbolicLink()&&before.size<=maximum);
 if(privateFile)assert(before.nlink===1&&before.uid===process.getuid()&&(before.mode&0o077)===0);
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK),h=createHash('sha256'),buffer=Buffer.alloc(65536);
 try{assert(sameStat(before,fstatSync(fd)));let offset=0;
  while(offset<before.size){const n=readSync(fd,buffer,0,Math.min(buffer.length,before.size-offset),offset);assert(n>0);h.update(buffer.subarray(0,n));offset+=n;}
  assert.equal(readSync(fd,buffer,0,1,offset),0);assert(sameStat(before,fstatSync(fd))&&sameStat(before,lstatSync(path)));
  return {bytes:before.size,sha256:h.digest('hex')};
 }finally{closeSync(fd);}
}
function json(path,value,maximum=LIMITS.reportBytes){
 const b=Buffer.from(JSON.stringify(value,null,2)+'\n');assert(b.length<=maximum);
 writeFileSync(path,b,{flag:'wx',mode:0o600});return hash(b);
}
function git(cwd,...args){return execFileSync('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',...args],
 {cwd,env:childEnvironment(),encoding:'utf8',timeout:10000,maxBuffer:16*1024**2}).trim();}
function childEnvironment(compiler=true){
 const e={...process.env};
 if(compiler)e.NODE_OPTIONS='--max-old-space-size=12288';
 else assert(e.NODE_OPTIONS===undefined,'Trace typegen retains ordinary unset Node heap options');
 for(const k of Object.keys(e))if(['GH_TOKEN','GITHUB_TOKEN','NODE_COMPILE_CACHE','GITHUB_OUTPUT','GITHUB_ENV',
  'GITHUB_STATE','GITHUB_STEP_SUMMARY'].includes(k)||k.startsWith('ACTIONS_'))delete e[k];
 return e;
}
function pair(){return validatePairData(JSON.parse(readHeld(PAIR_PATH,LIMITS.reportBytes).bytes.toString('utf8')));}
function anchorIdentity(source){
 const e=process.env;return {source,controller:e.AIHR_CI_CONTROL_HEAD,runId:e.GITHUB_RUN_ID,attempt:e.GITHUB_RUN_ATTEMPT,job:e.GITHUB_JOB};
}
export function validateAnchorData(a,identity,at){
 exact(a,['version','kind','source','controller','runId','attempt','job','monotonicNs']);
 assert.equal(a.version,1);assert.equal(a.kind,'NATIVE_FIRST_STEP_CLOCK_NOT_GITHUB_JOB_START');
 for(const[k,v]of Object.entries(identity))assert.equal(a[k],v,'Foreign clock');
 assert(/^[1-9][0-9]{0,24}$/.test(a.monotonicNs));assert(typeof at==='bigint'&&at>=BigInt(a.monotonicNs));
 return BigInt(a.monotonicNs);
}
function anchor(source,temp){
 const path=join(temp,'compiler-full-trace-clock','anchor.json');directory(dirname(path));
 const h=readHeld(path,4096,true),a=JSON.parse(h.bytes.toString('utf8'));
 return {value:a,sha256:h.sha256,nativeNs:validateAnchorData(a,anchorIdentity(source),now()),path};
}
function cleanSource(source,sha){assert.equal(git(source,'rev-parse','HEAD'),sha);assert.equal(git(source,'status','--porcelain'),'');}
function context(){
 const e=process.env;assert.equal(process.platform,'linux');assert.equal(e.CI,'true');assert.equal(e.GITHUB_ACTIONS,'true');
 assert.equal(e.RUNNER_ENVIRONMENT,'github-hosted');assert.equal(e.RUNNER_OS,'Linux');
 assert.equal(e.GITHUB_REPOSITORY,'StradaverseHub/ai-hr');assert.equal(e.GITHUB_REPOSITORY_ID,'1333414856');
 assert.equal(e.GITHUB_EVENT_NAME,'workflow_dispatch');assert.equal(e.GITHUB_RUN_ATTEMPT,'1');assert(positive.test(e.GITHUB_RUN_ID??''));
 assert.equal(e.GITHUB_WORKFLOW,'alpha-focused-checks');assert.equal(e.GITHUB_JOB,'typecheck');
 assert.equal(e.GITHUB_WORKFLOW_REF,'StradaverseHub/ai-hr/.github/workflows/alpha-focused-checks.yml@refs/heads/main');
 assert.equal(e.AIHR_CI_CONTROL_HEAD,e.GITHUB_SHA);assert(COMMIT.test(e.GITHUB_SHA??''));
 assert.equal(process.versions.node,'22.23.3');
 assert.equal(process.arch,'x64');assert.equal(cpus().length,4);
 assert(totalmem()>=14*1024**3&&totalmem()<=18*1024**3,'Actual standard 4CPU/16GiB runner required');
 const workspace=realpathSync(e.GITHUB_WORKSPACE),source=join(workspace,'source'),automation=join(workspace,'automation'),temp=realpathSync(e.RUNNER_TEMP);
 assert.equal(realpathSync(source),source);assert.equal(realpathSync(automation),automation);assert.equal(realpathSync(process.cwd()),source);
 assert.equal(realpathSync(fileURLToPath(new URL('../../../',import.meta.url))),automation);
 const p=pair(),cell=validateTraceInputs(JSON.parse(e.AIHR_COMPILER_TRACE_INPUTS),p);
 assert.equal(e.AIHR_CI_HEAD,cell.source);cleanSource(source,cell.source);cleanSource(automation,e.AIHR_CI_CONTROL_HEAD);
 const event=JSON.parse(readHeld(realpathSync(e.GITHUB_EVENT_PATH),LIMITS.reportBytes).bytes.toString('utf8'));
 assert.equal(event.repository.id,1333414856);assert.equal(event.repository.full_name,'StradaverseHub/ai-hr');
 assert.equal(event.inputs?.expected_sha,cell.source);assert.equal(event.inputs?.candidate_ref,cell.branch);
 assert.equal(git(source,'rev-parse',p.control.source+'^'),p.base);
 assert.equal(git(source,'rev-parse',p.candidate.source+'^'),p.control.source);
 const controlPaths=git(source,'diff-tree','--no-commit-id','--name-only','-r',p.control.source).split('\n').sort();
 const candidatePaths=git(source,'diff-tree','--no-commit-id','--name-only','-r',p.candidate.source).split('\n').sort();
 const adr='docs/adr/2026-11-08-native-compiler-reference-boundaries.md',record='docs/qualification/compiler-native-database-interface-source-20261109.json';
 assert.deepEqual(controlPaths,[adr,record,GUARD].sort());assert.deepEqual(candidatePaths,['db/client.ts',adr,record].sort());
 assert.equal(git(source,'rev-parse',p.base+':db/client.ts'),git(source,'rev-parse',p.control.source+':db/client.ts'));
 assert.equal(git(source,'rev-parse',p.control.source+':'+GUARD),git(source,'rev-parse',p.candidate.source+':'+GUARD));
 for(const row of [p.guard,cell.dbClient,...p.common]){
  const actual=realpathSync(join(source,row.path));assert(actual.startsWith(source+'/'));
  assert.deepEqual(fileHash(actual),{bytes:row.bytes,sha256:row.sha256},'Source/compiler bytes differ: '+row.path);
 }
 assert.equal(JSON.parse(readHeld(realpathSync(join(source,'node_modules/typescript/package.json')),LIMITS.reportBytes).bytes).version,'5.9.3');
 const tracked=git(source,'ls-files','-z').split('\0').filter(p=>/\.(ts|tsx|mts)$/.test(p)&&!p.startsWith('mobile/')&&!p.startsWith('node_modules/')).sort();
 assert.equal(tracked.length,p.trackedInputCount);assert.equal(hash(tracked.join('\n')+'\n'),p.trackedInputPathsSha256);
 const nodePath=realpathSync(process.execPath);assert.equal(realpathSync('/proc/self/exe'),nodePath);
 return {source,automation,temp,pair:p,cell,clock:anchor(cell.source,temp),out:join(temp,'diagnostic-compiler-full-trace'),
  identity:anchorIdentity(cell.source),nodePath,tracked};
}
function recordContext(c){return {...c.identity,kind:'STOCK_FULL_TRACE_DIAGNOSTIC_ONLY',version:1,
 cell:c.cell===c.pair.control?'CONTROL':'CANDIDATE',clock:c.clock.value,clockSha256:c.clock.sha256,
 controllerSourceRestored:false,sourceRestored:false,releaseAuthorized:false,ordinaryCompilerGatePass:false,
 cacheScope:'Fresh checker process and absent private buildinfo; prior setup/typegen/stock inventories can warm OS files and stock Node code caches on each cell. Stock tsc.js enables the Node compile cache when available. No restored TypeScript semantic state or zero-OS/code-cache claim.'};}
function rawFiles(root){
 directory(root);const out=[];
 for(const name of readdirSync(root)){
  const path=join(root,name),s=lstatSync(path);
  if(name==='trace'){directory(path);for(const child of readdirSync(path)){assert(['trace.json','types.json'].includes(child),'Unknown trace output');const q=join(path,child),t=lstatSync(q);assert(t.isFile()&&!t.isSymbolicLink());out.push({name:'trace/'+child,bytes:t.size});}}
  else{assert(RAW.includes(name),'Unknown diagnostic output');assert(s.isFile()&&!s.isSymbolicLink());out.push({name,bytes:s.size});}
 }
 return out;
}
function logRange(path,start){const h=readHeld(path,LIMITS.logBytes,true);return h.bytes.subarray(start).toString('utf8');}
async function stage(c,name,stdoutPath=null){
 const work={typegen:LIMITS.typegenMs,show:LIMITS.showMs,inventory:LIMITS.inventoryMs,check:LIMITS.checkMs}[name];
 const budget=stageBudget(c.clock.nativeNs,now(),work),cmd=stockCommand(name,c.source,c.out,c.nodePath);
 const log=join(c.out,'compiler.log'),monitor=join(c.out,'monitor.jsonl');
 const logFd=openSync(log,constants.O_WRONLY|constants.O_CREAT|constants.O_APPEND|constants.O_NOFOLLOW,0o600);
 let monitorFd,outputFd,rows=0,start;
 try{
  monitorFd=openSync(monitor,constants.O_WRONLY|constants.O_CREAT|constants.O_APPEND|constants.O_NOFOLLOW,0o600);
  for(const fd of [logFd,monitorFd]){const s=fstatSync(fd);assert(s.nlink===1&&s.uid===process.getuid()&&(s.mode&0o077)===0);}
  start=fstatSync(logFd).size;rows=readHeld(monitor,LIMITS.metadataBytes,true).bytes.toString('utf8').split('\n').filter(Boolean).length;
  outputFd=stdoutPath?openSync(stdoutPath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600):logFd;
 }catch(e){if(outputFd!==undefined&&outputFd!==logFd)closeSync(outputFd);if(monitorFd!==undefined)closeSync(monitorFd);closeSync(logFd);throw e;}
 const row={name,command:cmd.command,args:cmd.args,budget,startedMonotonicNs:now().toString(),code:null,signal:null,stoppedBecause:null};
 let child,timer,closed=false;const stop=reason=>{
  row.stoppedBecause??=reason;if(child?.pid&&!closed)try{process.kill(child.pid,'SIGTERM');}catch(e){if(e.code!=='ESRCH')row.stopError=String(e);}
 };
 const interrupted=()=>stop('controller-interrupted');
 const sample=()=>{
  try{assert(rows<LIMITS.monitorRows,'Monitor row cap');const files=rawFiles(c.out),total=files.reduce((n,r)=>n+r.bytes,0),available=free(c.out);
   writeSync(monitorFd,JSON.stringify({stage:name,monotonicNs:now().toString(),outputBytes:total,freeBytes:available})+'\n');rows++;
   if(files.some(r=>r.bytes>LIMITS.fileBytes))stop('per-file-output-cap');
   else if((files.find(r=>r.name==='compiler.log')?.bytes??0)>LIMITS.logBytes)stop('log-output-cap');
   else if(total>LIMITS.totalBytes)stop('observed-output-cap');else if(available<LIMITS.freeDuring)stop('free-space-floor');
  }catch(e){row.monitorError=String(e);stop('monitor-failure');}
 };
 try{
  child=spawn(cmd.command,cmd.args,{cwd:c.source,env:childEnvironment(name!=='typegen'),stdio:['ignore',outputFd,logFd]});
  process.once('SIGTERM',interrupted);process.once('SIGINT',interrupted);
  timer=setInterval(sample,1000);sample();
  const outcome=await new Promise((done,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>{closed=true;done({code,signal});});});
  Object.assign(row,outcome);
 }catch(e){row.error=String(e);}
 finally{
  clearInterval(timer);process.removeListener('SIGTERM',interrupted);process.removeListener('SIGINT',interrupted);
  // Stock GNU timeout owns its one fixed native chain. Unknown close is never success.
  row.closed=closed;row.endedMonotonicNs=now().toString();row.elapsedMs=Number((BigInt(row.endedMonotonicNs)-BigInt(row.startedMonotonicNs))/1000000n);
  if(outputFd!==logFd)closeSync(outputFd);closeSync(monitorFd);closeSync(logFd);
 }
 let text='',end=null;try{text=logRange(log,start);end=lstatSync(log).size;}catch(e){row.error??=String(e);}
 return {...row,logStartByte:start,logEndByte:end,
  ...(name==='check'?compilerOutcome(row,text):{completed:row.closed&&row.code===0&&row.signal===null&&!row.stoppedBecause&&!row.error&&!row.stopError})};
}
export function validateProducerFragment(fragment,expected){
 assert.equal(fragment.version,1);assert.equal(fragment.kind,'STOCK_FULL_TRACE_DIAGNOSTIC_ONLY');
 for(const[k,v]of Object.entries(expected.identity))assert.equal(fragment[k],v,'Foreign producer fragment');
 assert.equal(fragment.clockSha256,expected.clockSha256);assert.deepEqual(fragment.clock,expected.clock);
 assert.equal(fragment.cell,expected.cell);assert.equal(fragment.root.dev,expected.root.dev);assert.equal(fragment.root.ino,expected.root.ino);
}
export function validateTypegenSuccess(fragment){
 assert(fragment.complete===true&&fragment.sourceRestored===true&&fragment.controllerSourceRestored===true);
 assert(Array.isArray(fragment.phases)&&fragment.phases.length===1);
 const phase=fragment.phases[0];assert.equal(phase.name,'typegen');
 assert(phase.completed===true&&phase.closed===true&&phase.code===0&&phase.signal===null&&phase.stoppedBecause===null
  &&!Object.hasOwn(phase,'error')&&!Object.hasOwn(phase,'stopError'));
 assert(Array.isArray(fragment.generated)&&fragment.generated.length>0);
}
export function cleanupReceiptRequired(typegen,observed){
 exact(observed,['report','inputs','trace','cache']);for(const value of Object.values(observed))assert.equal(typeof value,'boolean');
 return !(typegen.complete===false&&Object.values(observed).every(value=>value===false));
}
function heldIdentity(c,fragment){
 const st=directory(c.out);validateProducerFragment(fragment,{identity:c.identity,clockSha256:c.clock.sha256,
  clock:c.clock.value,cell:c.cell===c.pair.control?'CONTROL':'CANDIDATE',root:{dev:st.dev,ino:st.ino}});
}
function generated(c){
 const result=[];let visited=0;
 const append=row=>{assert(result.length+1<40000,'Generated Next input bound');result.push(row);};
 for(const sub of ['.next/types','.next/dev/types']){
  const root=join(c.source,sub);if(!exists(root))continue;
  const visit=(path)=>{assert(++visited<40000,'Generated Next traversal bound');
   assert.equal(realpathSync(path),path);const s=lstatSync(path);assert(!s.isSymbolicLink());
   if(s.isDirectory()){const dir=opendirSync(path);try{let entry;while((entry=dir.readSync())!==null)visit(join(path,entry.name));}finally{dir.closeSync();}}
   else{assert(s.isFile());if(path.endsWith('.ts'))append({path:relative(c.source,path),...fileHash(path)});}
  };visit(root);
 }
 const nextEnv=join(c.source,'next-env.d.ts');
 if(exists(nextEnv)){assert.equal(realpathSync(nextEnv),nextEnv);append({path:'next-env.d.ts',...fileHash(nextEnv)});}
 assert(result.length>0&&result.length<40000,'Generated Next inputs absent/unbounded');return result.sort((a,b)=>a.path.localeCompare(b.path));
}
async function typegen(){
 const c=context();assert(free(c.temp)>=LIMITS.freeBefore);mkdirSync(c.out,{mode:0o700});const root=directory(c.out);
 json(join(c.out,'resources.json'),{...recordContext(c),node:process.versions.node,nodePath:c.nodePath,nodeBytes:fileHash(c.nodePath),
  typescript:'5.9.3',cpuCount:cpus().length,totalMemoryBytes:totalmem(),freeBytesBefore:free(c.temp),
  limits:LIMITS,compilerNodeOptions:'--max-old-space-size=12288',typegenNodeOptions:'ordinary-unset',
  caveat:'Native first-step clock is not server job start; time-v/GC logs provide native command resource facts.'});
 const report={...recordContext(c),root:{dev:root.dev,ino:root.ino},complete:false,phases:[]};
 try{report.phases.push(await stage(c,'typegen'));assert(report.phases[0].completed,'Next typegen failed');report.generated=generated(c);report.complete=true;}
 catch(e){report.error=String(e);throw e;}
 finally{try{report.sourceRestored=git(c.source,'status','--porcelain')==='';}catch(e){report.sourceCaptureError=String(e);}
  try{report.controllerSourceRestored=git(c.automation,'status','--porcelain')==='';}catch(e){report.controllerCaptureError=String(e);}
  json(join(c.out,'typegen.json'),report);}
 assert(report.sourceRestored&&report.controllerSourceRestored);
}
function captureInputs(c){
 const config=JSON.parse(readHeld(join(c.out,'show-config.json'),LIMITS.metadataBytes,true).bytes.toString('utf8'));
 assert(Array.isArray(config.files)&&config.files.length>0&&config.files.length<40000,'Resolved stock roots missing/unbounded');
 const rootPaths=config.files.map(p=>relative(c.source,resolve(c.source,p)));
 assert(rootPaths.every(p=>p!==''&&!p.startsWith('../')&&p!=='..'),'Resolved root outside candidate');
 assert(rootPaths.includes(GUARD),'Guard absent from actual stock config roots');
 const lines=readHeld(join(c.out,'list-files.txt'),LIMITS.metadataBytes,true).bytes.toString('utf8').trim().split('\n');
 assert(lines.length>0&&lines.length<40000&&new Set(lines).size===lines.length);
 const files=lines.map(p=>{assert(p.startsWith(c.source+'/'),'Resolved file outside candidate');return {path:relative(c.source,p),realPath:relative(c.source,realpathSync(p)),...fileHash(realpathSync(p))};});
 const data={...recordContext(c),kind:'STOCK_CONFIG_ROOTS_AND_LIST_ONLY_FILES_NOT_CHECKER_PROGRAM_CENSUS',
  config,rootPaths,rootPathsSha256:hash(rootPaths.join('\n')+'\n'),orderedFiles:files,
  orderedFilesSha256:hash(JSON.stringify(files)),generated:generated(c),trackedInputs:c.tracked,
  compilerInputPins:c.pair.common,guard:c.pair.guard};
 json(join(c.out,'inputs.json'),data,LIMITS.metadataBytes);return data;
}
export function verifyFileManifest(source,rows,deadline){
 assert(resolve(source)===source&&Array.isArray(rows)&&rows.length>0&&rows.length<40000);
 for(const row of rows){
  assert(now()<deadline,'Complete input postimage verification exceeded frontier');
  assert(typeof row.path==='string'&&!row.path.startsWith('/')&&!row.path.split('/').some(p=>p===''||p==='.'||p==='..'));
  const path=realpathSync(join(source,row.path));assert(path.startsWith(source+'/'));
  assert.equal(relative(source,path),row.realPath);
  assert.deepEqual(fileHash(path),{bytes:row.bytes,sha256:row.sha256},'Compiler input changed: '+row.path);
 }
 return rows.length;
}
async function run(){
 const c=context();directory(c.out);const preceding=JSON.parse(readHeld(join(c.out,'typegen.json'),LIMITS.reportBytes,true).bytes.toString('utf8'));
 heldIdentity(c,preceding);validateTypegenSuccess(preceding);
 assert.deepEqual(preceding.generated,generated(c),'Generated inputs changed after actual typegen');
 assert(!exists(join(c.out,'whole-project.tsbuildinfo')),'Cold private buildinfo must be absent');
 const root=directory(c.out),report={...recordContext(c),root:{dev:root.dev,ino:root.ino},complete:false,
  typegenSha256:fileHash(join(c.out,'typegen.json'),LIMITS.reportBytes,true).sha256,phases:[],compilerSucceeded:false};
 try{
  for(const name of ['show','inventory']){const p=join(c.out,name==='show'?'show-config.json':'list-files.txt');
   const result=await stage(c,name,p);report.phases.push(result);assert(result.completed,'Stock input observation failed');}
  const inputs=captureInputs(c);assert(!exists(join(c.out,'whole-project.tsbuildinfo')),'Input observation produced unexpected compiler state');
  const result=await stage(c,'check');report.phases.push(result);
  if(result.compilerCompleted)assert.equal(result.files,inputs.orderedFiles.length,'Checker file count differs from held list-only inputs');
  // This is a held-file corroboration, never an interception of the checker's reads.
  stageBudget(c.clock.nativeNs,now(),LIMITS.showMs);
  const postStarted=now(),deadline=postStarted+BigInt(LIMITS.collectMs)*1000000n;
  report.inputFilesReverified=verifyFileManifest(c.source,inputs.orderedFiles,deadline);
  for(const row of c.pair.common){
   assert(now()<deadline,'Compiler postimage verification exceeded frontier');
   assert.deepEqual(fileHash(realpathSync(join(c.source,row.path))),{bytes:row.bytes,sha256:row.sha256},'Compiler/config input changed');
  }
  assert.deepEqual(generated(c),inputs.generated,'Next declarations changed during checking');
  report.inputPostimageMs=Number(now()-postStarted)/1000000;
  report.complete=true;report.compilerAndConfigPostimagesVerified=true;
  report.compilerSucceeded=result.compilerCompleted;
 }catch(e){report.error=String(e);throw e;}
 finally{
  report.cleanupComplete=false;
  try{if(exists(join(c.out,'whole-project.tsbuildinfo'))){fileHash(join(c.out,'whole-project.tsbuildinfo'),LIMITS.fileBytes,true);unlinkSync(join(c.out,'whole-project.tsbuildinfo'));}report.cleanupComplete=true;}
  catch(e){report.cacheCleanupError=String(e);}
  try{report.sourceRestored=git(c.source,'status','--porcelain')==='';}catch(e){report.sourceCaptureError=String(e);}
  try{report.controllerSourceRestored=git(c.automation,'status','--porcelain')==='';}catch(e){report.controllerCaptureError=String(e);}
  report.freeBytesAfter=free(c.out);json(join(c.out,'report.json'),report);
 }
 assert(report.complete&&report.compilerSucceeded&&report.cleanupComplete&&report.sourceRestored&&report.controllerSourceRestored,'Diagnostic failed; retained actual outcome');
}
export function validateExportEntries(entries){
 assert(Array.isArray(entries)&&entries.length<=EXPORTS.length);const seen=new Set();let total=0;
 for(const r of entries){assert(EXPORTS.includes(r.path)&&!seen.has(r.path));seen.add(r.path);
  const max=r.path==='compiler.log'?LIMITS.logBytes:r.path==='report.json'||r.path==='typegen.json'||r.path==='swap-cleanup.json'?LIMITS.reportBytes:
   r.path==='inputs.json'||r.path==='resources.json'||r.path==='monitor.jsonl'?LIMITS.metadataBytes:LIMITS.fileBytes;
  assert(Number.isSafeInteger(r.bytes)&&r.bytes>=0&&r.bytes<=max);assert(HASH.test(r.sha256));total+=r.bytes;
 }assert(total+LIMITS.reportBytes<=LIMITS.totalBytes,'Aggregate export cap including bounded manifest');return total;
}
export function copyHeld(source,destination,maximum){
 const before=lstatSync(source);assert(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1&&before.uid===process.getuid()&&(before.mode&0o077)===0);
 assert(before.size<=maximum);const input=openSync(source,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 let output;const buffer=Buffer.alloc(65536),h=createHash('sha256');
 try{output=openSync(destination,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  assert(sameStat(before,fstatSync(input)));let pos=0;
  while(pos<before.size){const n=readSync(input,buffer,0,Math.min(buffer.length,before.size-pos),pos);assert(n>0);h.update(buffer.subarray(0,n));let written=0;
   while(written<n){const count=writeSync(output,buffer,written,n-written);assert(count>0);written+=count;}pos+=n;}
  assert.equal(readSync(input,buffer,0,1,pos),0);assert(sameStat(before,fstatSync(input))&&sameStat(before,lstatSync(source)));
  return {bytes:before.size,sha256:h.digest('hex')};
 }finally{if(output!==undefined)closeSync(output);closeSync(input);}
}
export function traceState(path){
 if(!exists(path))return {present:false,endsWithClosingBracket:false,jsonArrayValidity:'UNKNOWN_NOT_PARSED'};
 const before=lstatSync(path);assert(before.isFile()&&!before.isSymbolicLink()&&before.size<=LIMITS.fileBytes);
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK),b=Buffer.alloc(Math.min(4096,before.size));
 try{assert(sameStat(before,fstatSync(fd)));assert.equal(readSync(fd,b,0,b.length,Math.max(0,before.size-b.length)),b.length);
  assert(sameStat(before,fstatSync(fd))&&sameStat(before,lstatSync(path)));
  return {present:true,endsWithClosingBracket:b.toString('utf8').trimEnd().endsWith(']'),jsonArrayValidity:'UNKNOWN_NOT_PARSED'};
 }finally{closeSync(fd);}
}
function collect(){
 const started=now(),temp=realpathSync(process.env.RUNNER_TEMP),exportRoot=join(temp,'compiler-full-trace-export'),
  pending=join(temp,'compiler-full-trace-export-pending');
 assert(!exists(exportRoot),'Preexisting export is never uploaded or overwritten');
 mkdirSync(pending,{mode:0o700});directory(pending);
 const receipt={version:1,kind:'BOUNDED_STOCK_TRACE_EXPORT_NOT_ORDINARY_GATE',source:process.env.AIHR_CI_HEAD??null,
  controller:process.env.AIHR_CI_CONTROL_HEAD??null,runId:process.env.GITHUB_RUN_ID??null,attempt:process.env.GITHUB_RUN_ATTEMPT??null,
  releaseAuthorized:false,ordinaryCompilerGatePass:false,files:[],omitted:[],complete:false,refused:false};
 let c;
 try{
  c=context();Object.assign(receipt,recordContext(c));receipt.kind='BOUNDED_STOCK_TRACE_EXPORT_NOT_ORDINARY_GATE';
  receipt.sourceRestored=true;receipt.controllerSourceRestored=true;
  stageBudget(c.clock.nativeNs,started,LIMITS.collectMs);directory(c.out);
  const typegenRecord=readHeld(join(c.out,'typegen.json'),LIMITS.reportBytes,true);
  const typegen=JSON.parse(typegenRecord.bytes.toString('utf8'));heldIdentity(c,typegen);
  if(exists(join(c.out,'report.json'))){
   const report=JSON.parse(readHeld(join(c.out,'report.json'),LIMITS.reportBytes,true).bytes.toString('utf8'));
   heldIdentity(c,report);assert.equal(report.typegenSha256,typegenRecord.sha256,'Wrong prior typegen generation');
  }
  rawFiles(c.out);
  const cleanup=join(c.temp,'compiler-transport-swap-cleanup.json');
  if(exists(cleanup)){
   const h=readHeld(cleanup,LIMITS.reportBytes,true),v=JSON.parse(h.bytes.toString('utf8'));
   assert.equal(v.runId,c.identity.runId);assert.equal(v.attempt,c.identity.attempt);assert.equal(v.mode,'--full-trace');
   assert(v.swapAbsent===true&&v.fileAbsent===true&&v.cleanupExit===0,'Owned swap cleanup failed');
   writeFileSync(join(c.out,'swap-cleanup.json'),h.bytes,{flag:'wx',mode:0o600});
  }else{
   const required=cleanupReceiptRequired(typegen,{report:exists(join(c.out,'report.json')),inputs:exists(join(c.out,'inputs.json')),
    trace:exists(join(c.out,'trace/trace.json')),cache:exists(join(c.out,'whole-project.tsbuildinfo'))});
   assert(!required,'Structured owned-swap cleanup outcome missing');
   receipt.swapCleanup='ABSENT_AFTER_FAILED_TYPEGEN; no check artifacts. Provider step authentication must confirm wrapper skipped; no cleanup PASS claimed.';
  }
  const entries=EXPORTS.filter(p=>exists(join(c.out,p))).map(path=>({path,...fileHash(join(c.out,path),LIMITS.fileBytes,true)}));
  validateExportEntries(entries);
  for(const r of entries){assert(Number(now()-started)/1000000<LIMITS.collectMs,'Collection deadline');
   if(r.path.startsWith('trace/')&&!exists(join(pending,'trace')))mkdirSync(join(pending,'trace'),{mode:0o700});
   const copied=copyHeld(join(c.out,r.path),join(pending,r.path),r.bytes);assert.deepEqual(copied,{bytes:r.bytes,sha256:r.sha256});receipt.files.push(r);}
  receipt.trace=traceState(join(c.out,'trace/trace.json'));receipt.typesPresent=exists(join(c.out,'trace/types.json'));
  receipt.complete=true;
 }catch(e){
  receipt.refused=true;receipt.error=String(e);
  // Pending partial raw copies stay private and OUTSIDE the upload root.
  receipt.omitted=receipt.files.map(r=>({path:r.path,bytes:r.bytes,reason:'Raw export refused as one whole capture'}));
  receipt.files=[];
 }finally{
  receipt.endedMonotonicNs=now().toString();receipt.collectionMs=Number(now()-started)/1000000;
  if(receipt.refused){mkdirSync(exportRoot,{mode:0o700});directory(exportRoot);json(join(exportRoot,'export-manifest.json'),receipt);}
  else{json(join(pending,'export-manifest.json'),receipt);assert(!exists(exportRoot));renameSync(pending,exportRoot);directory(exportRoot);}
  // The upload step requires this actual collector-created root, including a refusal-only manifest.
  assert(process.env.GITHUB_OUTPUT);appendFileSync(process.env.GITHUB_OUTPUT,'export_ready=true\n');
 }
 assert(!receipt.refused&&receipt.complete,'Bounded trace export refused');
}
async function main(){
 process.umask(0o077);assert(process.argv.length<=3,'No extra diagnostic arguments');
 if(process.argv[2]==='--selection'){validateTraceInputs(JSON.parse(process.env.AIHR_COMPILER_TRACE_INPUTS),pair());return;}
 if(process.argv[2]==='--typegen'){await typegen();return;}
 if(process.argv[2]==='--collect'){collect();return;}
 assert(process.argv.length===2,'Unknown closed diagnostic role');await run();
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e);process.exitCode=1;});
