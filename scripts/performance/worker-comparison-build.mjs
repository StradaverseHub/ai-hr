/** Dormant same-job .next custody. The caller owns build success and runtime settlement. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {closeSync,constants as flags,fchmodSync,fstatSync,lstatSync,mkdirSync,opendirSync,openSync,readlinkSync,readSync,symlinkSync,writeSync} from 'node:fs';
import {isAbsolute,normalize} from 'node:path';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';

const buildName='.next',privateName='aihr-worker-comparison-next',seedName='seed',aliasesDirectory='node_modules';
const aliasVerifier=fileURLToPath(new URL('../../.github/ci/worker-comparison-build-aliases.py',import.meta.url));
const aliasEnvironment=Object.freeze({PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'});
// One upstream job builds and seals; each parallel cell job installs that sealed transport.
const parallelJobs=new Set(['worker-build','worker-cell']),parallelCourses=new Set(['parallel-2-4-8','parallel-smoke','parallel-control','parallel-control-50','parallel-control-100']);
const maxEntries=100000,maxBytes=3*1024**3,maxWorkMs=180000;
const readFlags=flags.O_RDONLY|flags.O_NOFOLLOW|flags.O_NONBLOCK;
const fdPath=fd=>`/proc/self/fd/${fd}`;
const child=(fd,name)=>`${fdPath(fd)}/${name}`;
const stats=path=>lstatSync(path,{bigint:true});
const held=fd=>fstatSync(fd,{bigint:true});
const sameInode=(left,right)=>left.dev===right.dev&&left.ino===right.ino;
const sameDirectoryIdentity=(left,right)=>sameInode(left,right)&&['mode','uid','gid'].every(key=>left[key]===right[key]);
const unchanged=(left,right)=>sameDirectoryIdentity(left,right)&&['size','nlink','mtimeNs','ctimeNs']
 .every(key=>left[key]===right[key]);

function missing(path){
 try{stats(path);return false;}catch(error){if(error.code==='ENOENT')return true;throw error;}
}

function openDirectory(path,matches=unchanged){
 const before=stats(path);
 assert(before.isDirectory(),'Worker build directory or ancestor is a link or unsupported');
 const fd=openSync(path,readFlags|flags.O_DIRECTORY);
 try{
  assert(matches(before,held(fd))&&matches(before,stats(path)),'Worker build directory changed during open');
  return fd;
 }catch(error){closeSync(fd);throw error;}
}

function openAbsoluteDirectory(path){
 assert(typeof path==='string'&&path.length<=4096&&path!=='/'&&isAbsolute(path)&&normalize(path)===path
  &&!path.endsWith('/')&&!/[\\\u0000-\u001f\u007f]/.test(path),'Worker build root path refused');
 // Shared path ancestors can gain unrelated siblings while we walk them.
 // Only held build trees require unchanged content metadata across an open.
 let fd=openDirectory('/',sameDirectoryIdentity);
 try{
  for(const name of path.slice(1).split('/')){
   const previous=fd;fd=openDirectory(child(previous,name),sameDirectoryIdentity);
   closeSync(previous);
  }
  return fd;
 }catch(error){closeSync(fd);throw error;}
}

function requireNamedRoot(path,fd){
 const named=openAbsoluteDirectory(path);
 try{assert(sameInode(held(named),held(fd)),'Worker build root name changed');}
 finally{closeSync(named);}
}

function ownedDirectory(parent,name){
 const path=child(parent,name);
 // A fresh name is a reservation. Never rename over an existing directory or link.
 mkdirSync(path,{mode:0o700});
 const fd=openDirectory(path);
 try{
  const row=held(fd);
  assert(row.dev===held(parent).dev&&row.uid===BigInt(process.getuid())&&(row.mode&0o7777n)===0o700n,
   'Worker build fresh directory ownership refused');
  return fd;
 }catch(error){closeSync(fd);throw error;}
}

function requireEntry(row,owner,device,canRestrictMode=false){
 const forbiddenMode=canRestrictMode?0o7000n:0o7022n;
 assert(row.dev===device&&row.uid===owner&&(row.mode&forbiddenMode)===0n
  &&(row.isDirectory()||row.isFile()&&row.nlink===1n),'Worker build contains an unsupported link, owner, mode or file kind');
}

// A descriptor chmod changes ctime. Every other birth/content field must agree,
// and the descriptor and pathname must still denote the same new snapshot.
function restrictMode(fd,path,before,permissions){
 assert(unchanged(before,held(fd))&&unchanged(before,stats(path)),'Worker build entry changed before mode restriction');
 if((before.mode&0o777n)===permissions)return before;
 fchmodSync(fd,Number(permissions));
 const after=held(fd);
 assert(sameInode(before,after)&&after.mode===((before.mode&~0o777n)|permissions)
  &&['uid','gid','nlink','size','mtimeNs'].every(key=>after[key]===before[key])
  &&unchanged(after,stats(path)),'Worker build entry changed during mode restriction');
 return after;
}

function namesIn(fd,takeEntry,check){
 const dir=opendirSync(fdPath(fd));
 const names=[];
 try{
  while(true){
   check();
   const entry=dir.readSync();
   if(entry===null)break;
   takeEntry();
   const {name}=entry;
   assert(name.length>0&&name!=='.'&&name!=='..'&&Buffer.byteLength(name)<=255
    &&!/[\/\\\u0000-\u001f\u007f\ufffd]/.test(name),'Worker build member name refused');
   names.push(name);
  }
 }finally{dir.closeSync();}
 return names.sort();
}

function readAlias(path,before,owner,device){
 assert(before.isSymbolicLink()&&before.uid===owner&&before.dev===device&&before.nlink===1n,
  'Worker build alias is not an owned link');
 const raw=readlinkSync(path,{encoding:'buffer'});
 const target=new TextDecoder('utf-8',{fatal:true}).decode(raw);
 assert(raw.length>0&&raw.length<=4096&&Buffer.from(target).equals(raw)&&!/[\\\u0000-\u001f\u007f]/.test(target)
  &&unchanged(before,stats(path)),'Worker build alias changed while reading');
 return target;
}

function readAliasInventory(build,owner,device,check){
 const directoryPath=child(build,aliasesDirectory),directory=openDirectory(directoryPath);
 try{
  const before=held(directory);
  requireEntry(before,owner,device,true);
  const restricted=restrictMode(directory,directoryPath,before,before.mode&0o755n);
  const births=new Map();
  let count=0;
  const links=namesIn(directory,()=>assert(++count<=2,'Worker build runtime alias inventory exceeds bound'),check).map(name=>{
   const path=child(directory,name),relative=aliasesDirectory+'/'+name,before=stats(path);
   const target=readAlias(path,before,owner,device);
   births.set(relative,before);
   return {path:relative,target};
  });
  assert(unchanged(restricted,held(directory))&&unchanged(restricted,stats(directoryPath)),
   'Worker build runtime alias directory changed during inventory');
  return {links,births};
 }finally{closeSync(directory);}
}

function proveAliasPackages(source,temporary,links,timeout){
 try{
  const proof=JSON.parse(execFileSync('/usr/bin/python3',['-I','-B',aliasVerifier],{
   cwd:temporary,env:aliasEnvironment,input:JSON.stringify({source,aliases:links}),encoding:'utf8',
   timeout,killSignal:'SIGKILL',maxBuffer:4096,stdio:['pipe','pipe','pipe'],
  }));
  assert(Array.isArray(proof)&&proof.length===links.length&&proof.length===2);
  return new Map(proof.map((row,index)=>{
   const link=links[index];
   assert(Object.keys(row).length===5&&row.path===link.path&&typeof row.package==='string'&&typeof row.version==='string'
    &&[row.packageJsonSha256,row.packageTreeSha256].every(value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)));
   return [link.path,{...row,target:link.target}];
  }));
 }catch{throw Error('Worker build runtime aliases or package identity refused');}
}

/** Stream whole bytes into fresh files when copying, and seal the actual source in the same pass. */
function inspectTree(source,destination,owner,device,aliases,births,check,copyBirths,canRestrictMode=false){
 const tree=createHash('sha256'),buffer=Buffer.alloc(256*1024),directories=new Set(),seenAliases=new Set();
 let entries=1,bytes=0,buildId;
 const takeEntry=()=>{assert(++entries<=maxEntries,'Worker build member ceiling exceeded');};
 const row=(...data)=>tree.update(JSON.stringify(data)+'\n');
 function file(sourcePath,destinationPath,relative,before){
  assert(before.size<=BigInt(maxBytes-bytes),'Worker build byte ceiling exceeded');
  const size=Number(before.size);
  bytes+=size;
  if(relative==='BUILD_ID')assert(size>0&&size<=128,'Worker build ID size refused');
  const idBytes=relative==='BUILD_ID'?Buffer.alloc(size):null;
  const input=openSync(sourcePath,readFlags);
  try{
   if(canRestrictMode)before=restrictMode(input,sourcePath,before,before.mode&0o755n);
   else assert(unchanged(before,held(input))&&unchanged(before,stats(sourcePath)),'Worker build file changed during open');
   check();
   const output=destinationPath===null?null:openSync(destinationPath,flags.O_WRONLY|flags.O_CREAT|flags.O_EXCL|flags.O_NOFOLLOW,0o600);
   try{
    const digest=createHash('sha256');
    let remaining=size;
    while(remaining){
     check();
     const count=readSync(input,buffer,0,Math.min(remaining,buffer.length),null);
     assert(count>0,'Worker build file truncated');
     if(idBytes)buffer.copy(idBytes,size-remaining,0,count);
     digest.update(buffer.subarray(0,count));
     if(output!==null){
      for(let sent=0;sent<count;){
       check();const written=writeSync(output,buffer,sent,count-sent,null);
       assert(written>0,'Worker build copy write incomplete');sent+=written;
      }
     }
     remaining-=count;
    }
    assert(readSync(input,buffer,0,1,null)===0&&unchanged(before,held(input))&&unchanged(before,stats(sourcePath)),
     'Worker build file changed during observation');
    if(idBytes)buildId=idBytes.toString('latin1');
    if(output!==null){
     const copied=held(output);
     assert(copied.isFile()&&copied.uid===owner&&copied.dev===device&&copied.nlink===1n&&copied.size===before.size
      &&!sameInode(before,copied)&&unchanged(copied,stats(destinationPath)),'Worker build copy inode refused');
     fchmodSync(output,Number(before.mode&0o777n));
    }
    row('file',relative,Number(before.mode&0o777n),size,digest.digest('hex'));
   }finally{if(output!==null)closeSync(output);}
  }finally{closeSync(input);}
 }
 function directory(fd,output,path,depth){
  check();assert(depth<=48,'Worker build tree depth exceeded');
  const before=held(fd);requireEntry(before,owner,device);
  const inode=String(before.ino);
  assert(!directories.has(inode),'Worker build repeats a directory inode');directories.add(inode);
  row('directory',path,Number(before.mode&0o777n));
  for(const name of namesIn(fd,takeEntry,check)){
   check();
   const relative=path?path+'/'+name:name;
   assert(Buffer.byteLength(relative)<=1024,'Worker build relative path bound exceeded');
   const sourcePath=child(fd,name),destinationPath=output===null?null:child(output,name),entry=stats(sourcePath);
   const alias=aliases.get(relative);
   if(alias){
    assert(births.has(relative)&&unchanged(entry,births.get(relative))
     &&readAlias(sourcePath,entry,owner,device)===alias.target,'Worker build runtime alias birth or target changed');
    bytes+=Buffer.byteLength(alias.target);
    assert(bytes<=maxBytes,'Worker build byte ceiling exceeded');
    if(destinationPath!==null){
     symlinkSync(alias.target,destinationPath,'dir');
     const copied=stats(destinationPath);
     assert(!sameInode(entry,copied)&&readAlias(destinationPath,copied,owner,device)===alias.target,
      'Worker build copy runtime alias changed');
     copyBirths.set(relative,copied);
    }
    seenAliases.add(relative);
    row('alias',relative,alias.target,alias.package,alias.version,alias.packageJsonSha256,alias.packageTreeSha256);
    assert(unchanged(entry,stats(sourcePath)),'Worker build runtime alias birth changed');
    continue;
   }
   assert(path!==aliasesDirectory,'Worker build unexpected runtime dependency entry');
   requireEntry(entry,owner,device,canRestrictMode);
   if(entry.isFile())file(sourcePath,destinationPath,relative,entry);
   else{
    const next=openDirectory(sourcePath);
    try{
     assert(unchanged(entry,held(next)),'Worker build directory changed before traversal');
     check();
     const expected=canRestrictMode?restrictMode(next,sourcePath,entry,entry.mode&0o755n):entry;
     const copy=output===null?null:ownedDirectory(output,name);
     try{directory(next,copy,relative,depth+1);}finally{if(copy!==null)closeSync(copy);}
     assert(unchanged(expected,stats(sourcePath)),'Worker build directory name changed during traversal');
    }finally{closeSync(next);}
   }
  }
  assert(unchanged(before,held(fd)),'Worker build directory changed during traversal');
  if(output!==null)fchmodSync(output,Number(before.mode&0o777n));
 }
 directory(source,destination,'',0);
 assert(seenAliases.size===aliases.size,'Worker build runtime alias disappeared');
 check();
 assert(typeof buildId==='string'&&/^[A-Za-z0-9_-]{1,128}(?![\s\S])/.test(buildId),'Worker build ID refused');
 return Object.freeze({buildId,entries,bytes,sha256:tree.digest('hex')});
}

function identityOf(env){
 const candidateSha=env.AIHR_CI_HEAD,runId=env.GITHUB_RUN_ID;
 assert(process.platform==='linux'&&process.arch==='x64'&&env.GITHUB_ACTIONS==='true'&&env.CI==='true'
  &&env.RUNNER_ENVIRONMENT==='github-hosted'&&env.RUNNER_OS==='Linux'&&env.RUNNER_ARCH==='X64'
  &&env.GITHUB_REPOSITORY==='StradaverseHub/ai-hr'&&env.GITHUB_REPOSITORY_ID==='1333414856'&&env.GITHUB_EVENT_NAME==='workflow_dispatch'
  &&env.GITHUB_WORKFLOW==='alpha-focused-checks'&&env.GITHUB_RUN_ATTEMPT==='1'
  &&(env.GITHUB_JOB==='selected-tests'||parallelJobs.has(env.GITHUB_JOB)&&parallelCourses.has(env.AIHR_MEASURED_BROWSER_COURSE))
  &&typeof candidateSha==='string'&&/^[a-f0-9]{40}(?![\s\S])/.test(candidateSha)
  &&['GITHUB_SHA','GITHUB_WORKFLOW_SHA','AIHR_CI_CONTROL_HEAD'].every(name=>env[name]===candidateSha)
  &&typeof runId==='string'&&/^[1-9][0-9]{0,15}(?![\s\S])/.test(runId)&&Number.isSafeInteger(Number(runId)),
 'Worker build hosted source identity refused');
 return Object.freeze({candidateSha,controllerSha:candidateSha,runId:Number(runId),runAttempt:1});
}

/** Open before canonical build. Fixed names only. This function grants no course or build authority. */
export function holdDevelopmentBuildSnapshot(env){
 const acquisitionStarted=performance.now(),identity=identityOf(env);
 assert(typeof env.GITHUB_WORKSPACE==='string','Worker build workspace missing');
 const sourcePath=env.GITHUB_WORKSPACE+'/source',tempPath=env.RUNNER_TEMP,owner=BigInt(process.getuid());
 assert(typeof tempPath==='string'&&tempPath!==sourcePath&&!tempPath.startsWith(sourcePath+'/')
  &&!sourcePath.startsWith(tempPath+'/'),'Worker build workspace overlaps temporary custody');
 const descriptors=[];
 const keep=fd=>{descriptors.push(fd);return fd;};
 const close=()=>{
  let failure;
  for(const fd of descriptors.splice(0).reverse())try{closeSync(fd);}catch(error){failure??=error;}
  if(failure)throw failure;
 };
 try{
  const source=keep(openAbsoluteDirectory(sourcePath)),temp=keep(openAbsoluteDirectory(tempPath)),device=held(source).dev;
  assert(held(source).uid===owner&&held(temp).uid===owner&&device===held(temp).dev,'Worker build root ownership or device refused');
  assert(missing(child(source,buildName)),'Worker build requires an absent pre-build .next');
  assert(performance.now()-acquisitionStarted<maxWorkMs,'Worker build snapshot work budget exhausted');
  const privateRoot=keep(ownedDirectory(temp,privateName));
  const seedAliasBirths=new Map();
  let state='waiting',seed,seal,links,aliases,installs=0,workMs=performance.now()-acquisitionStarted;
  assert(workMs<maxWorkMs,'Worker build snapshot work budget exhausted');
  function namedRoots(){
   requireNamedRoot(sourcePath,source);requireNamedRoot(tempPath,temp);
   assert(sameInode(held(privateRoot),stats(child(temp,privateName))),'Worker build private directory name changed');
  }
  function operation(work,deadlineMs){
   assert(state!=='failed'&&state!=='closed','Worker build snapshot unavailable');
   assert(deadlineMs===undefined||Number.isSafeInteger(deadlineMs)&&deadlineMs>0,'Worker build snapshot absolute deadline refused');
   const started=performance.now(),stop=started+maxWorkMs-workMs;
   const remaining=()=>{
    const relative=Math.floor(stop-performance.now());
    const absolute=deadlineMs===undefined?relative:deadlineMs-Number(process.hrtime.bigint()/1_000_000n);
    const timeout=Math.min(relative,absolute);
    assert(timeout>0,'Worker build snapshot work budget exhausted');
    return timeout;
   };
   try{remaining();namedRoots();const result=work(remaining);namedRoots();remaining();return result;}
   catch(error){state='failed';throw error;}
   finally{workMs+=performance.now()-started;}
  }
  function checkPackages(remaining){
   assert.deepEqual(proveAliasPackages(sourcePath,tempPath,links,remaining()),aliases,'Worker build runtime package bytes changed');
  }
  function checkSeed(check){
   assert(state==='captured'&&sameInode(held(seed),stats(child(privateRoot,seedName))),'Worker build seed name changed or missing');
   assert.deepEqual(inspectTree(seed,null,owner,device,aliases,seedAliasBirths,check),seal,'Worker build seed bytes changed');
   assert(sameInode(held(seed),stats(child(privateRoot,seedName))),'Worker build seed name changed during verification');
  }
  function view(fd){
   const {dev,ino}=held(fd);
   return Object.freeze({identity,seal,directory:Object.freeze({device:String(dev),inode:String(ino)})});
  }
  return Object.freeze({
   capture(deadlineMs){return operation(check=>{
    assert(state==='waiting','Worker build snapshot may capture only once');
    const path=child(source,buildName),built=openDirectory(path);
    try{
     check();
     const root=held(built);
     requireEntry(root,owner,device,true);
     assert((root.mode&0o700n)===0o700n,'Worker build root lacks owner access');
     const restrictedRoot=restrictMode(built,path,root,0o700n);
     const inventory=readAliasInventory(built,owner,device,check);
     links=inventory.links;
     aliases=proveAliasPackages(sourcePath,tempPath,links,check());
     seed=keep(ownedDirectory(privateRoot,seedName));
     seal=inspectTree(built,seed,owner,device,aliases,inventory.births,check,seedAliasBirths,true);
     assert(unchanged(restrictedRoot,held(built))&&unchanged(restrictedRoot,stats(path))
      &&!sameInode(restrictedRoot,held(seed)),'Worker build origin or copy inode refused');
     state='captured';checkSeed(check);
     assert.deepEqual(inspectTree(built,null,owner,device,aliases,inventory.births,check),seal,'Worker build origin changed after capture');
     checkPackages(check);
     assert(unchanged(restrictedRoot,held(built))&&unchanged(restrictedRoot,stats(path)),'Worker build origin name changed during verification');
     return view(built);
    }finally{closeSync(built);}
   },deadlineMs);},
   install(deadlineMs){return operation(check=>{
    assert(state==='captured'&&installs<2,'Worker build copy course exhausted');
    assert(missing(child(source,buildName)),'Worker build target is occupied');
    checkSeed(check);checkPackages(check);
    const target=ownedDirectory(source,buildName);
    try{
     assert(!sameInode(held(seed),held(target)),'Worker build install is not an independent directory');
     const targetAliasBirths=new Map();
     assert.deepEqual(inspectTree(seed,target,owner,device,aliases,seedAliasBirths,check,targetAliasBirths),seal,'Worker build seed changed during copy');
     assert.deepEqual(inspectTree(target,null,owner,device,aliases,targetAliasBirths,check),seal,'Worker build copy bytes differ');
     checkPackages(check);
     assert(sameInode(held(target),stats(child(source,buildName)))&&sameInode(held(seed),stats(child(privateRoot,seedName))),
      'Worker build copy or seed name changed');
     installs++;return view(target);
    }finally{closeSync(target);}
   },deadlineMs);},
   verify(deadlineMs){return operation(check=>{checkPackages(check);checkSeed(check);checkPackages(check);return seal;},deadlineMs);},
   close(){if(state!=='closed'){state='closed';close();}},
  });
 }catch(error){try{close();}catch{}throw error;}
}
