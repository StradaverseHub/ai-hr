/** Host custody for one synthetic, daemon-owned container and its package-free image. */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {constants,copyFileSync,existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,readlinkSync,realpathSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {createConnection,createServer} from 'node:net';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {admitCompilerReference,compilerProcIdentity,readCompilerReferenceClock} from './admission.mjs';
import {developmentDockerContext} from '../../../../scripts/performance/driver-shutdown.mjs';
import {canarySeal,fileBirth,namespaceIds} from './protected-docker-entry.mjs';
import {protectedDigest,protectedHash,protectedLimits,protectedOwnerLabel,protectedRuntimeEnv,sealedScratchImage} from './protected-docker-image.mjs';

import {generatedNames,generatedSeals,protectedAppSource,protectedAppTree,protectedLock} from './protected-next-typegen.mjs';

export const protectedDockerRef='refs/heads/codex/compiler-protected-next-typegen-a139-20261109';
const ownModule='.github/ci/diagnostics/native-reference/protected-docker-canary.mjs';
const entryName='.github/ci/diagnostics/native-reference/protected-docker-entry.mjs';
const typegenName='.github/ci/diagnostics/native-reference/protected-next-typegen.mjs';
const projectName='.github/ci/diagnostics/native-reference/project-protected-next.py';
const manifest='docs/qualification/compiler-reference-owned-source-20261108.json';
const socket='/run/docker.sock';
const cli='/usr/bin/docker';
const commandHash='6435ff9214bf8e0931078fb0980809728cac0a54a526d4f28a26d3e48132b58d';
const runtimeHash='1248fee8f9a0dc5382f888990d669e2bd225045869b9246f848a1681161abc96';
const idPattern=/^[a-f0-9]{64}$/;
const sourcePattern=/^[a-f0-9]{40}$/;
const missing=result=>!result.error&&!result.signal&&result.status===1&&/No such (?:image|object|container)(?::|\b)/i.test(result.stderr);
const reportPath='compiler-protected-docker';
const write=(path,value)=>writeFileSync(path,JSON.stringify(value)+'\n',{flag:'wx',mode:0o600});
const publish=(path,value)=>{write(path+'.pending',value);renameSync(path+'.pending',path);};
const exists=path=>{try{lstatSync(path);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};
const config=(path)=>{const row=lstatSync(path);assert(row.isFile()&&row.uid===process.getuid()&&row.nlink===1&&(row.mode&0o777)===0o600&&row.size>0&&row.size<=16384);return JSON.parse(readFileSync(path,'utf8'));};
const ownDirectory=path=>{const row=lstatSync(path);assert(row.isDirectory()&&row.uid===process.getuid()&&(row.mode&0o777)===0o700&&realpathSync(path)===path);};
const makeDirectory=path=>{mkdirSync(path,{mode:0o700});ownDirectory(path);};
const identityEnv=()=>{
 const {AIHR_CI_HEAD:source,AIHR_CI_CONTROL_HEAD:controller,GITHUB_RUN_ID:run,GITHUB_RUN_ATTEMPT:attempt}=process.env;
 assert(sourcePattern.test(source??'')&&controller===source&&/^[1-9][0-9]{0,19}$/.test(run??'')&&attempt==='1');
 assert(process.platform==='linux'&&process.arch==='x64'&&process.getuid()>0&&process.getgid()>0&&process.versions.node==='22.23.3');
 assert(process.env.GITHUB_REPOSITORY==='StradaverseHub/ai-hr'&&process.env.RUNNER_ENVIRONMENT==='github-hosted'&&
  process.env.GITHUB_JOB==='selected-tests'&&process.env.GITHUB_EVENT_NAME==='workflow_dispatch');
 return {source,controller,run,attempt};
};
const tempRoot=context=>join(realpathSync(process.env.RUNNER_TEMP),'aihr-protected-docker-'+context.run+'-'+context.attempt);
const containerName=context=>'aihr-protected-compiler-'+context.run+'-'+context.attempt;
const cgroupPath=id=>'/system.slice/docker-'+id+'.scope';
const cgroupDir=id=>'/sys/fs/cgroup'+cgroupPath(id);

function trustedFile(path,digest){
 const row=lstatSync(path);
 assert(row.isFile()&&row.uid===0&&(row.mode&0o6022)===0&&realpathSync(path)===path);
 assert(row.size>0&&row.size<=128*1024**2&&protectedHash(readFileSync(path))===digest);
 const after=lstatSync(path);
 for(const key of ['dev','ino','size','mtimeMs','ctimeMs'])assert.equal(after[key],row[key]);
}
function engine(root,deadline){
 trustedFile(cli,commandHash);trustedFile('/usr/bin/runc',runtimeHash);
 const row=lstatSync(socket);assert(row.isSocket()&&row.uid===0&&(row.mode&0o002)===0&&realpathSync('/var/run/docker.sock')===socket);
 const socketBirth=fileBirth(socket);
 const {args,env}=developmentDockerContext(root);
 const invoke=(arguments_)=>{
  const remaining=deadline-performance.now();assert(remaining>1000,'Docker owner deadline exhausted');
  assert.deepEqual(fileBirth(socket),socketBirth);
  const result=spawnSync(cli,[...args,...arguments_],{env,stdio:['ignore','pipe','pipe'],encoding:'utf8',
   timeout:Math.min(arguments_[0]==='container'&&arguments_[1]==='wait'?18500:7000,remaining-500),killSignal:'SIGKILL',maxBuffer:131072});
  assert.deepEqual(fileBirth(socket),socketBirth);
  return result;
 };
 const required=arguments_=>{
  const result=invoke(arguments_);
  assert(!result.error&&!result.signal&&result.status===0,'Docker command refused: '+arguments_.slice(0,2).join(' '));
  return result.stdout.trim();
 };
 const info=JSON.parse(required(['info','--format','{"v":{{json .ServerVersion}},"cg":{{json .CgroupDriver}},"cv":{{json .CgroupVersion}},"r":{{json .DefaultRuntime}},"s":{{json .SecurityOptions}}}']));
 assert.deepEqual([info.v,info.cg,String(info.cv),info.r],['28.0.4','systemd','2','runc']);
 assert(['name=apparmor','name=seccomp,profile=builtin','name=cgroupns'].every(value=>info.s.includes(value))&&
  !info.s.some(value=>/^name=(rootless|userns)(,|$)/.test(value)));
 return {invoke,required};
}
const rows=(raw)=>{const ids=raw?raw.split('\n'):[];assert(ids.length<=1&&ids.every(value=>idPattern.test(value)));return ids;};
const byName=(client,name)=>rows(client.required(['container','ls','-aq','--no-trunc','--filter','name=^/'+name+'$']))[0];
function inspectContainer(client,id,owner){
 assert(idPattern.test(id));
 const row=JSON.parse(client.required(['container','inspect','--format','{{json .}}',id]));
 assert(row.Id===id&&row.Name==='/'+owner.name&&row.Image===owner.imageId&&row.Config.Labels[protectedOwnerLabel]===owner.nonce,
  'Container ownership differs');
 return row;
}
function inspectImage(client,owner){
 const result=client.invoke(['image','inspect','--format','{{json .}}',owner.imageId]);
 if(missing(result))return false;
 assert(!result.error&&!result.signal&&result.status===0,'Image inspection refused');
 const row=JSON.parse(result.stdout);
 assert(row.Id===owner.imageId&&row.Os==='linux'&&row.Architecture==='amd64'&&row.Config.Labels[protectedOwnerLabel]===owner.nonce);
 assert((row.RepoTags??[]).length===0&&(row.RepoDigests??[]).length===0&&row.RootFS.Layers.length===1&&row.RootFS.Layers[0]===owner.diffId);
 for(const key of ['Entrypoint','Env','Cmd','Volumes','Healthcheck'])assert(row.Config[key]==null,'Unexpected scratch image payload');
 return true;
}
function liveBirth(pid,id){
 const row=compilerProcIdentity(pid);
 assert.equal(readFileSync('/proc/'+pid+'/cgroup','utf8'),'0::'+cgroupPath(id)+'\n');
 const directory=fileBirth(cgroupDir(id));
 assert.equal(compilerProcIdentity(pid).start,row.start);
 assert.deepEqual(fileBirth(cgroupDir(id)),directory);
 return {pid,start:row.start,cgroup:directory};
}
function resourceFacts(id,pid){
 const read=name=>readFileSync(join(cgroupDir(id),name),'utf8').trim();
 assert.equal(read('cgroup.procs'),String(pid));
 assert.equal(read('memory.max'),String(protectedLimits.memory));assert.equal(read('memory.swap.max'),'0');
 assert.equal(read('pids.max'),String(protectedLimits.pids));assert.equal(read('cpu.max'),'100000 100000');
 const events=Object.fromEntries(read('memory.events').split('\n').map(line=>line.split(' ')));
 assert(events.oom==='0'&&events.oom_kill==='0');
 return {memoryBytes:protectedLimits.memory,swapBytes:0,pids:protectedLimits.pids,cpuQuota:'100000 100000',oomKills:0};
}
function loadIntent(root,context){
 const owner=config(join(root,'intent.json'));
 assert.deepEqual([owner.source,owner.controller,owner.run,owner.attempt],[context.source,context.controller,context.run,context.attempt]);
 assert(owner.name===containerName(context)&&idPattern.test(owner.nonce)&&protectedDigest.test(owner.imageId));
 const sealed=sealedScratchImage(owner.nonce);
 assert.deepEqual([owner.imageId,owner.diffId,owner.archiveSha256],[sealed.id,sealed.diffId,sealed.sha256]);
 return owner;
}
function closeOwned(root,context,deadline,{retainIdentity=false}={}){
 if(!exists(root))return {containerAbsent:true,processAbsent:true,cgroupAbsent:true,imageAbsent:true,privateScratchRemoved:true};
 ownDirectory(root);
 if(!exists(join(root,'intent.json'))){
  rmSync(root,{recursive:true});
  return {containerAbsent:true,processAbsent:true,cgroupAbsent:true,imageAbsent:true,privateScratchRemoved:true,noCreateIntent:true};
 }
 const owner=loadIntent(root,context),client=engine(root,deadline),id=byName(client,owner.name);
 const containerFile=join(root,'container.json'),birthFile=join(root,'birth.json');
 const recordedId=exists(containerFile)?config(containerFile).id:undefined;
 const heldBirth=exists(birthFile)?config(birthFile):undefined;
 assert(!recordedId||idPattern.test(recordedId));
 assert(!id||!recordedId||recordedId===id);
 const knownId=id??recordedId;
 let birth=heldBirth?.birth;
 if(heldBirth)assert(heldBirth.id===knownId);
 if(id){
  const row=inspectContainer(client,id,owner);
  if(row.State.Running){
   const actual=liveBirth(row.State.Pid,id);
   if(birth)assert.deepEqual(birth,actual);else birth=actual;
  }
  client.required(['container','rm','--force',id]);
 }
 assert.equal(byName(client,owner.name),undefined);
 if(knownId){
  const result=client.invoke(['container','inspect','--format','{{json .Id}}',knownId]);
  assert(missing(result),'Exact container remains');
  const until=Math.min(deadline-1000,performance.now()+1000);
  while(exists(cgroupDir(knownId))&&performance.now()<until)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);
  assert(!exists(cgroupDir(knownId)),'Exact daemon cgroup remains');
 }
 if(birth){
  try{assert.notEqual(compilerProcIdentity(birth.pid).start,birth.start,'Exact workload process remains');}
  catch(error){if(!['ENOENT','ESRCH'].includes(error.code))throw error;}
 }
 if(inspectImage(client,owner))client.required(['image','rm','--no-prune',owner.imageId]);
 assert(!inspectImage(client,owner));
 assert.deepEqual(readdirSync(join(root,'docker-config')),[]);
 const result={containerAbsent:true,processAbsent:true,cgroupAbsent:true,imageAbsent:true};
 if(retainIdentity){
  for(const name of ['scratch-image.tar','input','dependency','host-only','empty-etc','plan.json','work','project','next-output','next-env-output']){
   rmSync(join(root,name),{recursive:true,force:true});
  }
  assert(readdirSync(root).every(name=>['intent.json','container.json','birth.json','docker-config'].includes(name)));
  return {...result,privatePayloadRemoved:true,identityRetainedForSettlement:true};
 }
 rmSync(root,{recursive:true});
 return {...result,privateScratchRemoved:!exists(root)};
}
function bindArgs(mounts){
 return mounts.flatMap(({source,dest,readonly})=>{
  assert(realpathSync(source)===source&&!source.includes(',')&&!dest.includes(','));
  return ['--mount','type=bind,source='+source+',destination='+dest+',bind-propagation=rprivate,bind-recursive=disabled'+(readonly?',readonly':'')];
 });
}
function verifyContainer(row,owner,mounts,uid,gid){
 const host=row.HostConfig,c=row.Config;
 assert.deepEqual([host.NetworkMode,host.ReadonlyRootfs,host.Privileged,host.IpcMode,host.CgroupnsMode,host.Runtime,host.PidMode,
  host.PidMode==='host',host.RestartPolicy.Name,host.LogConfig.Type],['none',true,false,'none','private','runc','',false,'no','none']);
 assert.deepEqual(host.CapDrop,['ALL']);assert((host.CapAdd??[]).length===0);
 assert.deepEqual(host.SecurityOpt,['no-new-privileges=true']);
 assert.equal(host.Memory,protectedLimits.memory);assert.equal(host.MemorySwap,protectedLimits.memory);
 assert.equal(host.PidsLimit,protectedLimits.pids);assert.equal(host.NanoCpus,protectedLimits.cpuNano);
 assert(!host.PublishAllPorts&&Object.keys(host.PortBindings??{}).length===0&&(host.Devices??[]).length===0&&(host.GroupAdd??[]).length===0);
 assert(c.User===uid+':'+gid&&c.WorkingDir==='/work'&&!c.OpenStdin&&!c.Tty);
 assert.deepEqual(c.Entrypoint,['/runtime/node']);assert.deepEqual(c.Cmd,['--max-old-space-size=12288','/probe/entry.mjs']);
 assert.deepEqual((c.Env??[]).sort(),Object.entries(protectedRuntimeEnv).map(([key,value])=>key+'='+value).sort());
 assert.equal(c.Healthcheck.Test[0],'NONE');assert(Object.keys(c.Volumes??{}).length===0);
 assert.deepEqual(row.Mounts.map(mount=>[mount.Type,mount.Source,mount.Destination,mount.RW,mount.Propagation]).sort(),
  mounts.map(mount=>['bind',mount.source,mount.dest,!mount.readonly,'rprivate']).sort());
 assert.equal(row.Image,owner.imageId);
}
export async function protectedDockerCanary(){
 const proof=admitCompilerReference('fixture'),clock=readCompilerReferenceClock(proof),context=identityEnv();
 assert.equal(proof.sourceHead,context.source);assert.equal(proof.controllerHead,context.controller);
 assert.equal(proof.sourceHashes[ownModule],protectedHash(readFileSync(fileURLToPath(import.meta.url))));
 const out=join(proof.destination,reportPath),root=tempRoot(context);
 makeDirectory(out);makeDirectory(root);
 const report={kind:'PROTECTED_NEXT_TYPEGEN_A139',...context,productSource:protectedAppSource,productTree:protectedAppTree,transportQualified:false,productInputsMounted:false,
  stockNextInvoked:false,strictCompilerInvoked:false,ordinaryCompilerQualified:false,releaseAuthorized:false};
 const end=performance.now()+Math.min(120000,720000-Number(process.hrtime.bigint()-BigInt(clock.startNs))/1e6-3000);
 const workEnd=end-26000;
 const abort=new AbortController(),stop=()=>abort.abort(Error('Docker canary interrupted'));
 process.on('SIGTERM',stop);process.on('SIGINT',stop);
 let server,primary,phase='prepare';
 try{
  for(const name of ['docker-config','input','dependency','work','host-only'])makeDirectory(join(root,name));
  for(const name of ['home','tmp','cache','generated'])makeDirectory(join(root,'work',name));
  for(const name of ['input','dependency','host-only'])writeFileSync(join(root,name,'canary'),randomBytes(32),{flag:'wx',mode:0o600});
  writeFileSync(join(root,'empty-etc'),Buffer.alloc(0),{flag:'wx',mode:0o444});
  const nonce=randomBytes(32).toString('hex'),image=sealedScratchImage(nonce),owner={...context,name:containerName(context),nonce,
   imageId:image.id,diffId:image.diffId,archiveSha256:image.sha256};
  const client=engine(root,workEnd);
  assert(!byName(client,owner.name)&&!inspectImage(client,owner),'Owned scratch name/image already exists');
  const archive=join(root,'scratch-image.tar');writeFileSync(archive,image.archive,{flag:'wx',mode:0o400});
  assert.equal(protectedHash(readFileSync(archive)),image.sha256);
  const node=realpathSync(process.execPath),entry=join(proof.source,entryName),uid=process.getuid(),gid=process.getgid();
  assert.equal(protectedHash(readFileSync(entry)),proof.sourceHashes[entryName]);
  const projected=join(root,'project'),nextOutput=join(root,'next-output'),nextEnv=join(root,'next-env-output');
  const generator=join(proof.source,projectName),typegen=join(proof.source,typegenName),dependencies=join(proof.source,'node_modules');
  for(const [name,path]of [[projectName,generator],[typegenName,typegen]])assert.equal(protectedHash(readFileSync(path)),proof.sourceHashes[name]);
  assert.equal(realpathSync(dependencies),dependencies);
  assert.equal(protectedHash(readFileSync(join(proof.source,'pnpm-lock.yaml'))),protectedLock);
  for(const name of ['.next','next-env.d.ts'])assert(!exists(join(proof.source,name)));
  const projectedResult=spawnSync('/usr/bin/python3',['-I','-B',generator,proof.source,projected],{
   env:{PATH:'/usr/bin:/bin',HOME:'/nonexistent',LANG:'C',LC_ALL:'C'},encoding:'utf8',stdio:['ignore','pipe','pipe'],
   timeout:28000,killSignal:'SIGKILL',maxBuffer:8192});
  assert(!projectedResult.error&&!projectedResult.signal&&projectedResult.status===0,'Exact app projection refused');
  const projectedProof=JSON.parse(projectedResult.stdout);
  assert.deepEqual([projectedProof.source,projectedProof.tree,projectedProof.files,projectedProof.bytes],
   [protectedAppSource,protectedAppTree,12962,334836843]);
  report.productProjection=projectedProof;
  makeDirectory(nextOutput);
  writeFileSync(nextEnv,Buffer.alloc(0),{flag:'wx',mode:0o600});
  const productPaths=['package.json','pnpm-lock.yaml','next.config.ts','tsconfig.build.json','app/payroll/transactions/tp1/[year]/page.tsx',
   'lib/hr-date.ts','lib/calendar-date.ts','lib/date-time-formatter.ts'];
  const productSeals=()=>Object.fromEntries(productPaths.map(name=>[name,canarySeal(join(projected,name))]));
  const productBefore=productSeals();
  assert.equal(productBefore['pnpm-lock.yaml'].sha256,protectedLock);
  const ro=(source,dest)=>({source,dest,readonly:true});
  const mounts=[ro(node,'/runtime/node'),ro('/usr/lib/x86_64-linux-gnu','/lib/x86_64-linux-gnu'),
   ro(realpathSync('/lib64/ld-linux-x86-64.so.2'),'/lib64/ld-linux-x86-64.so.2'),ro(entry,'/probe/entry.mjs'),
   ro(join(root,'plan.json'),'/probe/plan.json'),ro(join(root,'input'),'/input'),ro(join(root,'dependency'),'/dependency'),
   ...['hostname','hosts','resolv.conf'].map(name=>ro(join(root,'empty-etc'),'/etc/'+name)),{source:join(root,'work'),dest:'/work',readonly:false},
   ro(projected,'/project'),ro(dependencies,'/project/node_modules'),ro(typegen,'/probe/next.mjs'),
   {source:nextOutput,dest:'/project/.next',readonly:false},{source:nextEnv,dest:'/project/next-env.d.ts',readonly:false}];
  let accepted=0;
  server=createServer(connection=>{accepted++;connection.destroy();});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen({host:'127.0.0.1',port:0,exclusive:true},resolve);});
  const port=server.address().port;
  await new Promise((resolve,reject)=>{
   const socket=createConnection({host:'127.0.0.1',port,timeout:1500});
   socket.once('error',reject);socket.once('timeout',()=>socket.destroy(Error('Host listener positive timed out')));
   socket.once('close',resolve);
  });
  assert.equal(accepted,1);
  const plan={nonce,uid,gid,port,node:fileBirth(node),hostNamespaces:namespaceIds(),hostUserNamespace:readlinkSync('/proc/self/ns/user'),
   env:protectedRuntimeEnv,hiddenPath:join(root,'host-only','canary'),input:canarySeal(join(root,'input','canary')),
   dependency:canarySeal(join(root,'dependency','canary'))};
  write(join(root,'plan.json'),plan);
  publish(join(root,'intent.json'),owner);
  phase='load';
  abort.signal.throwIfAborted();
  client.required(['image','load','--quiet','--input',archive]);
  assert(inspectImage(client,owner));
  phase='create';
  abort.signal.throwIfAborted();
  const id=client.required(['container','create','--pull=never','--name',owner.name,'--label',protectedOwnerLabel+'='+nonce,
   '--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges=true','--ipc=none','--cgroupns=private',
   '--runtime=runc','--restart=no','--no-healthcheck','--log-driver=none','--pids-limit=64','--memory=1g','--memory-swap=1g',
   '--cpus=1','--hostname',protectedRuntimeEnv.HOSTNAME,'--user',uid+':'+gid,'--workdir','/work','--entrypoint','/runtime/node',
   ...Object.entries(protectedRuntimeEnv).flatMap(([key,value])=>['--env',key+'='+value]),...bindArgs(mounts),
   image.id,'--max-old-space-size=12288','/probe/entry.mjs']);
  assert(idPattern.test(id));publish(join(root,'container.json'),{id});
  assert.equal(byName(client,owner.name),id);verifyContainer(inspectContainer(client,id,owner),owner,mounts,uid,gid);
  phase='start';
  abort.signal.throwIfAborted();
  client.required(['container','start',id]);
  report.productInputsMounted=true;
  const readyPath=join(root,'work','ready.json'),refusedPath=join(root,'work','refused.json');
  while(!exists(readyPath)){
   abort.signal.throwIfAborted();assert(performance.now()<workEnd-2000,'Protected kernel canary timed out');
   if(exists(refusedPath)){report.innerRefusal=config(refusedPath);throw Error('Protected kernel canary refused');}
   await delay(30);
  }
  phase='observe';
  const ready=config(readyPath),live=inspectContainer(client,id,owner),pid=live.State.Pid;
  verifyContainer(live,owner,mounts,uid,gid);
  assert(live.State.Running&&live.AppArmorProfile==='docker-default'&&!live.State.OOMKilled&&Number.isSafeInteger(pid)&&pid>1);
  const birth=liveBirth(pid,id);publish(join(root,'birth.json'),{id,birth});
  assert.equal(ready.nonce,nonce);assert.equal(ready.sourceMutationRefusals,4);
  for(const key of ['seccomp','apparmor','noNewPrivs','zeroCapabilities'])assert.equal(ready[key],true);
  assert.deepEqual(namespaceIds(pid),ready.ns);
  for(const [key,value]of Object.entries(ready.ns))assert.notEqual(value,plan.hostNamespaces[key]);
  assert.deepEqual(fileBirth('/proc/'+pid+'/exe'),plan.node);
   assert.deepEqual(liveBirth(pid,id),birth);
  assert.equal(accepted,1);
  for(const role of ['input','dependency']){
   assert.deepEqual(readdirSync(join(root,role)),['canary']);
   assert.deepEqual(canarySeal(join(root,role,'canary')),plan[role]);
  }
  for(const name of ['home','tmp','cache','generated'])assert.equal(readFileSync(join(root,'work',name,'canary'),'utf8'),'private output\n');
  const {nonce:_,...observed}=ready;
  report.observed={...observed,pidBirth:{pid,start:birth.start},cgroupBirth:birth.cgroup,resourceLimits:resourceFacts(id,pid),hostLoopbackPositive:true,
   imageId:image.id,archiveSha256:image.sha256,layerDiffId:image.diffId};
  publish(join(root,'work','grant.json'),{nonce});
  phase='wait';
  const waited=client.required(['container','wait',id]),executionPath=join(root,'work','typegen-execution.json');
  if(exists(executionPath)){report.typegenExecution=config(executionPath);report.stockNextInvoked=report.typegenExecution.exit!==null||report.typegenExecution.signal!==null;}
  if(exists(refusedPath))report.innerRefusal=config(refusedPath);
  assert.equal(waited,'0');
  const exited=inspectContainer(client,id,owner);
  assert(!exited.State.Running&&!exited.State.OOMKilled&&exited.State.ExitCode===0&&exited.State.Pid===0);
  assert(report.stockNextInvoked&&report.typegenExecution.exit===0);
  const result=config(join(root,'work','typegen-result.json'));
  assert.deepEqual([result.kind,result.source,result.tree,result.routeSemanticCoverage,result.releaseEligible],
   ['PROTECTED_STOCK_NEXT_TYPEGEN',protectedAppSource,protectedAppTree,false,false]);
  assert(result.dependencies.gnuElfLoaded&&result.dependencies.swcVersion==='16.4.1');
  assert.deepEqual(generatedSeals(projected,nextOutput,nextEnv),result.generated);
  assert.deepEqual(productSeals(),productBefore);
  for(const name of ['.next','next-env.d.ts'])assert(!exists(join(proof.source,name)));
  assert.deepEqual(readdirSync(join(projected,'.next')),[]);
  assert.equal(lstatSync(join(projected,'next-env.d.ts')).size,0);
  const retained=join(out,'generated');
  makeDirectory(retained);makeDirectory(join(retained,'types'));
  copyFileSync(nextEnv,join(retained,'next-env.d.ts'),constants.COPYFILE_EXCL);
  for(const name of generatedNames)copyFileSync(join(nextOutput,'types',name),join(retained,'types',name),constants.COPYFILE_EXCL);
  // The evidence tree uses a visible types directory so the standard uploader retains it.
  for(const [name,value]of Object.entries(result.generated)){
   const relativeName=name.startsWith('.next/')?name.slice(6):name;
   const path=join(retained,relativeName);
   assert.equal(lstatSync(path).size,value.bytes);
   assert.equal(protectedHash(readFileSync(path)),value.sha256);
  }
  assert.deepEqual(readCompilerReferenceClock(admitCompilerReference('fixture')),clock);
  report.typegen=result;report.transportQualified=true;
 }catch(error){
  primary=error;report.refusal={phase,code:typeof error.code==='string'?error.code:null};
 }finally{
  try{
   try{
    const launch=join(root,'work','typegen-launch.json'),execution=join(root,'work','typegen-execution.json');
    if(exists(launch))report.typegenLaunchIntent=config(launch);
    if(exists(execution)){
     report.typegenExecution=config(execution);
     report.stockNextInvoked=report.typegenExecution.exit!==null||report.typegenExecution.signal!==null;
    }
    if(server?.listening)await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
   }finally{
    report.settlement=closeOwned(root,context,end,{retainIdentity:true});
   }
  }catch(error){
   report.transportQualified=false;report.settlementRefused=true;
   primary=primary?new AggregateError([primary,error],'Docker canary and host settlement refused'):error;
  }finally{
   process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);
   write(join(out,'report.json'),report);
  }
 }
 if(primary)throw primary;
 assert(report.transportQualified&&report.settlement.privatePayloadRemoved&&report.settlement.identityRetainedForSettlement);
}
export function settleProtectedDockerCanary(destination){
 const context=identityEnv();
 assert.equal(process.env.GITHUB_REF,protectedDockerRef);
 const temp=realpathSync(process.env.RUNNER_TEMP),workspace=realpathSync(process.env.GITHUB_WORKSPACE),automation=join(workspace,'automation');
 assert.equal(destination,join(temp,'aihr-focused'));
 const controller=JSON.parse(readFileSync(join(automation,manifest),'utf8')),source=JSON.parse(readFileSync(join(workspace,'source',manifest),'utf8'));
 assert.deepEqual(source,controller);
 assert.equal(controller.sourceRef,protectedDockerRef.slice(11));
 const members=[ownModule,entryName,'.github/ci/diagnostics/native-reference/protected-docker-image.mjs',
  typegenName,projectName,'.github/ci/focused-checks.mjs','scripts/performance/driver-shutdown.mjs'];
 for(const member of members){
  assert.equal(controller.componentSources[member],protectedHash(readFileSync(join(automation,member))));
  assert.equal(source.componentSources[member],protectedHash(readFileSync(join(workspace,'source',member))));
 }
 const settlement=closeOwned(tempRoot(context),context,performance.now()+35000);
 write(join(destination,'protected-docker-settlement.json'),{kind:'SYNTHETIC_PROTECTED_DOCKER_INDEPENDENT_SETTLEMENT',...context,
  ...settlement,releaseAuthorized:false});
}
