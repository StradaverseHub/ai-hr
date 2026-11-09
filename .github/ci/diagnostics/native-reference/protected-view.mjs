/** A fixed synthetic Linux transport preflight. This module never invokes Next or TypeScript. */
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {constants,existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,readlinkSync,realpathSync,renameSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {createConnection,createServer} from 'node:net';
import {cpus,totalmem} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';

const self=fileURLToPath(import.meta.url);
const bwrap='/usr/bin/bwrap';
const library='/usr/lib/x86_64-linux-gnu';
const loader='/lib64/ld-linux-x86-64.so.2';
const roles=['mnt','net','pid','user','ipc','uts'];
const insideEnv={LANG:'C',LC_ALL:'C',TZ:'UTC',HOME:'/view/home',TMPDIR:'/view/tmp',XDG_CACHE_HOME:'/view/cache'};
const mountTargets=['/','/proc','/dev/null','/dev/urandom',library,loader,'/runtime/node','/preflight/probe.mjs','/preflight/plan.json','/preflight/channels.json','/view','/view/source','/view/node_modules'];
const reportKind='NATIVE_REFERENCE_PROTECTED_VIEW_PREFLIGHT';
const budgetMs=120000;

const hash=(bytes,algorithm='sha256')=>createHash(algorithm).update(bytes).digest('hex');
const save=(path,value)=>writeFileSync(path,JSON.stringify(value)+'\n',{flag:'wx',mode:0o600});
const publish=(path,value)=>{save(path+'.pending',value);renameSync(path+'.pending',path);};
const ns=(pid='self')=>Object.fromEntries(roles.map(kind=>{
 const value=readlinkSync('/proc/'+pid+'/ns/'+kind);
 assert(new RegExp('^'+kind+':\\[[1-9][0-9]*\\]$').test(value));
 return [kind,value];
}));
const inode=path=>{const row=statSync(path,{bigint:true});return{device:String(row.dev),inode:String(row.ino)};};
const seal=path=>({...inode(path),sha256:hash(readFileSync(path))});
function packet(path){
 const info=lstatSync(path);
 assert(info.isFile()&&info.nlink===1&&info.uid===process.getuid()&&(info.mode&0o777)===0o600&&info.size>0&&info.size<=16384);
 return JSON.parse(readFileSync(path,'utf8'));
}
function ownedDirectory(path){mkdirSync(path,{mode:0o700});assert.equal(realpathSync(path),path);}
function distroBinary(){
 const info=lstatSync(bwrap);
 assert(info.isFile()&&info.uid===0&&(info.mode&0o6022)===0&&(info.mode&0o111)!==0&&info.size>0&&info.size<=4*1024**2);
 assert.equal(realpathSync(bwrap),bwrap);
 const distroFile=(path,cap)=>{
  const row=lstatSync(path);
  assert(row.isFile()&&row.uid===0&&(row.mode&0o022)===0&&row.size>0&&row.size<=cap&&realpathSync(path)===path);
  return readFileSync(path,'utf8');
 };
 const status=distroFile('/var/lib/dpkg/status',32*1024**2).split('\n\n')
  .filter(block=>block.startsWith('Package: bubblewrap\n'));
 assert.equal(status.length,1);
 assert.match(status[0],/^Status: install ok installed$/m);
 assert.match(status[0],/^Architecture: amd64$/m);
 const version=/^Version: ([A-Za-z0-9.+:~_-]+)$/m.exec(status[0])?.[1];
 assert(version);
 const sums=distroFile('/var/lib/dpkg/info/bubblewrap.md5sums',65536);
 const expected=/^([0-9a-f]{32})  usr\/bin\/bwrap$/m.exec(sums)?.[1];
 const bytes=readFileSync(bwrap);
 assert.equal(bytes.length,info.size);
 assert(bytes.subarray(0,4).equals(Buffer.from([0x7f,0x45,0x4c,0x46])));
 assert.equal(hash(bytes,'md5'),expected);
 return {version,...inode(bwrap),sha256:hash(bytes)};
}
function mounts(text){
 const points=new Map();
 for(const line of text.trimEnd().split('\n')){
  const [before,after]=line.split(' - ');
  assert(after,'Mountinfo separator absent');
  const fields=before.split(' '),superblock=after.split(' ');
  const target=fields[4],options=fields[5].split(',');
  assert(!points.has(target),'Repeated protected mount');
  assert(!fields.slice(6).some(field=>field.startsWith('shared:')||field.startsWith('master:')),'Mount propagation is not private');
  points.set(target,{options,type:superblock[0]});
 }
 for(const [target,{options,type}]of points){
  assert(mountTargets.includes(target)||target.startsWith('/proc/'),'Unexpected protected mount');
  assert(options.includes(target==='/view'?'rw':'ro'),'Protected mount access differs');
  if(target==='/proc')assert.equal(type,'proc');
 }
 for(const target of mountTargets)assert(points.has(target),'Required protected mount absent');
 return {readOnly:mountTargets.filter(target=>target!=='/view'),writable:['/view'],privatePropagation:true};
}
function descriptors(pid='self'){
 return [0,1,2].map(fd=>readlinkSync('/proc/'+pid+'/fd/'+fd));
}
function launcherChannels(){
 const channels=descriptors();
 assert.equal(channels[0],'/dev/null');
 assert.notEqual(channels[1],channels[2]);
 const unix=readFileSync('/proc/net/unix','utf8').trimEnd().split('\n').slice(1).map(line=>line.trim().split(/\s+/));
 for(const value of channels.slice(1)){
  if(/^pipe:\[[1-9][0-9]*\]$/.test(value))continue;
  const number=/^socket:\[([1-9][0-9]*)\]$/.exec(value)?.[1];
  assert(number,'Unexpected fixed output descriptor');
  const [socket,...other]=unix.filter(row=>row[6]===number);
  assert(socket&&other.length===0&&socket.length===7&&socket[4]==='0001'&&socket[5]==='03','Output must be an unnamed connected Unix stream');
 }
 return channels;
}
function kernelControls(plan,channels){
 assert.deepEqual(Object.fromEntries(Object.entries(process.env).sort()),Object.fromEntries(Object.entries(insideEnv).sort()));
 const namespace=ns();
 for(const role of roles)assert.notEqual(namespace[role],plan.namespace[role]);
 const mountProof=mounts(readFileSync('/proc/self/mountinfo','utf8'));
 const status=readFileSync('/proc/self/status','utf8');
 for(const capability of ['CapInh','CapPrm','CapEff','CapBnd','CapAmb'])assert.match(status,new RegExp('^'+capability+':\\s+0{16}$','m'));
 assert.match(status,/^NoNewPrivs:\s+1$/m);
 const interfaces=readFileSync('/proc/net/dev','utf8').trimEnd().split('\n').slice(2).map(row=>row.split(':')[0].trim());
 assert.deepEqual(interfaces,['lo']);
 const ipv4=readFileSync('/proc/net/route','utf8').trimEnd().split('\n').slice(1).map(line=>line.trim().split(/\s+/)[0]);
 assert.deepEqual(ipv4,[]);
 if(existsSync('/proc/net/ipv6_route')){
  const rows=readFileSync('/proc/net/ipv6_route','utf8').trim().split('\n').filter(Boolean);
  assert(rows.every(line=>line.trim().split(/\s+/).at(-1)==='lo'));
 }
 assert.deepEqual(descriptors(),channels);
 for(const name of readdirSync('/proc/self/fd').filter(name=>Number(name)>2)){
  let target;
  try{target=readlinkSync('/proc/self/fd/'+name);}catch(error){if(error.code==='ENOENT')continue;throw error;}
  assert(/^pipe:\[[1-9][0-9]*\]$|^anon_inode:\[[a-z_]+\]$|^\/dev\/(null|urandom)$/.test(target),'Unexpected inherited descriptor');
 }
 for(const path of [plan.hostOnly,'/home','/run','/sys','/tmp','/view/.git'])assert(!existsSync(path),'Host path exposed in protected view');
 assert(readdirSync('/proc').filter(name=>/^[1-9][0-9]*$/.test(name)).every(name=>Number(name)===1||Number(name)===process.pid));
 return {namespace,mountProof,capabilitiesDropped:true,noNewPrivs:true,interfaces,ipv4Routes:ipv4.length,noForeignDescriptors:true};
}
async function deniedLoopback(port){
 assert(Number.isSafeInteger(port)&&port>1023&&port<65536);
 return new Promise((resolve,reject)=>{
  const socket=createConnection({host:'127.0.0.1',port,timeout:1500});
  socket.once('connect',()=>{socket.destroy();reject(Error('Host listener reachable from protected view'));});
  socket.once('timeout',()=>{socket.destroy();reject(Error('Protected loopback negative timed out'));});
  socket.once('error',error=>['ECONNREFUSED','ENETUNREACH','EHOSTUNREACH','EADDRNOTAVAIL'].includes(error.code)?resolve(error.code):reject(error));
 });
}
async function entry(){
 assert.deepEqual(process.argv,['/runtime/node','/preflight/probe.mjs','entry']);
 const plan=packet('/preflight/plan.json');
 const {channels}=packet('/preflight/channels.json');
 const kernel=kernelControls(plan,channels);
 const mutationRefusals=[];
 for(const [role,path]of [['source','/view/source'],['dependency','/view/node_modules']]){
  const file=join(path,'canary');
  assert.deepEqual(seal(file),plan[role]);
  for(const attempt of [()=>writeFileSync(file,'forbidden',{flag:constants.O_WRONLY}),()=>writeFileSync(join(path,'new'),'forbidden',{flag:'wx'})]){
   assert.throws(attempt,{code:'EROFS'});
   mutationRefusals.push({role,code:'EROFS'});
  }
  assert.deepEqual(seal(file),plan[role]);
 }
 assert.throws(()=>writeFileSync('/new','forbidden',{flag:'wx'}),{code:'EROFS'});
 for(const path of ['/view/home','/view/tmp','/view/cache','/view/generated']){
  writeFileSync(join(path,'owned'),'private output\n',{flag:'wx',mode:0o600});
 }
 const loopbackRefusal=await deniedLoopback(plan.port);
 publish('/view/ready.json',{token:plan.token,innerPid:process.pid,...kernel,mutationRefusals,loopbackRefusal});
 const until=performance.now()+10000;
 while(!existsSync('/view/grant.json')){
  assert(performance.now()<until,'Outer protected view proof absent');
  await delay(20);
 }
 assert.deepEqual(packet('/view/grant.json'),{token:plan.token});
}

function launch(root){
 assert.deepEqual(process.argv,[process.execPath,self,'launch',root]);
 assert.equal(process.platform,'linux');
 assert.equal(realpathSync(root),root);
 const plan=packet(join(root,'plan.json'));
 assert.deepEqual(distroBinary(),plan.transport);
 assert.equal(process.ppid,plan.owner);
 assert.deepEqual(ns(),plan.namespace);
 const executable=realpathSync(process.execPath);
 assert.deepEqual(inode(executable),plan.node);
 save(join(root,'channels.json'),{channels:launcherChannels()});
 const args=[bwrap,'--unshare-user','--disable-userns','--assert-userns-disabled','--unshare-pid','--unshare-net',
  '--unshare-ipc','--unshare-uts','--cap-drop','ALL','--die-with-parent','--clearenv',
  '--proc','/proc','--remount-ro','/proc','--dir','/dev','--dir','/runtime','--dir','/preflight',
  '--ro-bind','/dev/null','/dev/null','--ro-bind','/dev/urandom','/dev/urandom',
  '--ro-bind',library,library,'--symlink','usr/lib','/lib','--dir','/lib64',
  '--ro-bind',realpathSync(loader),loader,'--ro-bind',executable,'/runtime/node',
  '--ro-bind',self,'/preflight/probe.mjs','--ro-bind',join(root,'plan.json'),'/preflight/plan.json',
  '--ro-bind',join(root,'channels.json'),'/preflight/channels.json',
  '--bind',join(root,'view'),'/view','--ro-bind',join(root,'source'),'/view/source',
  '--ro-bind',join(root,'dependencies'),'/view/node_modules','--remount-ro','/','--chdir','/view',
  ...Object.entries(insideEnv).flatMap(([key,value])=>['--setenv',key,value]),
  '--','/runtime/node','--max-old-space-size=12288','/preflight/probe.mjs','entry'];
 assert.equal(typeof process.execve,'function');
 process.execve(bwrap,args,{LANG:'C',LC_ALL:'C',TZ:'UTC'});
 throw Error('Fixed sandbox exec returned');
}

function outerProcess(ready,plan,channels,readIdentity,monitor){
 const visited=new Set();
 const matching=[];
 function traverse(pid,depth){
  assert(depth<=8&&visited.size<32&&!visited.has(pid),'Unexpected protected descendant topology');
  visited.add(pid);
  const row=readIdentity(pid);
  assert.equal(row.session,monitor.pid);
  assert.equal(row.group,monitor.pid);
  const children=readFileSync('/proc/'+pid+'/task/'+pid+'/children','utf8').trim().split(/\s+/).filter(Boolean).map(Number);
  const status=readFileSync('/proc/'+pid+'/status','utf8');
  const inner=/^NSpid:\s+(.+)$/m.exec(status)?.[1].trim().split(/\s+/).map(Number);
  assert(inner?.[0]===pid);
  if(inner.length>1&&inner.at(-1)===ready.innerPid){
   assert.deepEqual(ns(pid),ready.namespace);
   assert.deepEqual(inode('/proc/'+pid+'/exe'),plan.node);
   assert.deepEqual(descriptors(pid),channels);
   const after=readIdentity(pid);
   for(const key of ['pid','parent','group','session','start'])assert.equal(after[key],row[key]);
   matching.push({pid,start:row.start,group:row.group,session:row.session,innerPid:ready.innerPid});
  }
  for(const child of children){assert.equal(readIdentity(child).parent,pid);traverse(child,depth+1);}
 }
 traverse(process.pid,0);
 assert.equal(matching.length,1,'Exact protected Node descendant absent');
 return matching[0];
}

export async function protectedViewPreflight(){
 const {admitCompilerReference,compilerProcIdentity,readCompilerReferenceClock}=await import('./admission.mjs');
 const {nativeReferenceProcess,requireNativeSuccess}=await import('./process.mjs');
 const proof=admitCompilerReference('fixture'),clock=readCompilerReferenceClock(proof);
 assert.equal(proof.sourceHead,proof.controllerHead);
 assert.equal(process.arch,'x64');
 assert.equal(cpus().length,4);
 assert(totalmem()>=14*1024**3&&totalmem()<=18*1024**3);
 assert.equal(proof.sourceHashes['.github/ci/diagnostics/native-reference/protected-view.mjs'],hash(readFileSync(self)));
 const deadline=performance.now()+Math.min(budgetMs,720000-Number(process.hrtime.bigint()-BigInt(clock.startNs))/1e6);
 const output=join(proof.destination,'compiler-protected-view');
 ownedDirectory(output);
 const root=join(output,'scratch');
 ownedDirectory(root);
 const abort=new AbortController();
 const stop=()=>abort.abort(Error('Protected view owner interrupted'));
 process.on('SIGTERM',stop);process.on('SIGINT',stop);
 const report={kind:reportKind,source:proof.sourceHead,controller:proof.controllerHead,run:proof.run,attempt:proof.attempt,
  ordinaryCompilerQualified:false,applicationInventoryComplete:false,releaseAuthorized:false,stockNextInvoked:false,strictCompilerInvoked:false,
  scope:'synthetic transport only',budgetMs,transportQualified:false,processSettlementRequired:true};
 let server,native,primary;
 try{
  const distro=readFileSync('/etc/os-release','utf8');
  assert.match(distro,/^ID=ubuntu$/m);
  assert.match(distro,/^VERSION_ID="24\.04"$/m);
  report.host={arch:process.arch,logicalCpus:cpus().length,totalMemoryBytes:totalmem(),distro:'ubuntu-24.04'};
  const transport=distroBinary();
  report.transport=transport;
  for(const name of ['source','dependencies','host-only','view'])ownedDirectory(join(root,name));
  for(const name of ['source','node_modules','home','tmp','cache','generated'])ownedDirectory(join(root,'view',name));
  for(const role of ['source','dependencies','host-only'])writeFileSync(join(root,role,'canary'),randomBytes(32),{flag:'wx',mode:0o600});
  let accepted=0;
  server=createServer(socket=>{accepted++;socket.destroy();});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen({host:'127.0.0.1',port:0,exclusive:true},resolve);});
  const port=server.address().port;
  await new Promise((resolve,reject)=>{
   const socket=createConnection({host:'127.0.0.1',port,timeout:1500});
   socket.once('error',reject);
   socket.once('timeout',()=>socket.destroy(Error('Owned loopback positive control timed out')));
   socket.once('close',resolve);
  });
  assert.equal(accepted,1,'Owned loopback listener positive control failed');
  report.ownedLoopbackPositive=true;
  const plan={token:randomBytes(32).toString('hex'),namespace:ns(),owner:process.pid,node:inode(process.execPath),transport,port,
   hostOnly:join(root,'host-only','canary'),source:seal(join(root,'source','canary')),dependency:seal(join(root,'dependencies','canary'))};
  save(join(root,'plan.json'),plan);
  const log=join(output,'transport.log');
  native=nativeReferenceProcess([self,'launch',root],{cwd:proof.source,env:{LANG:'C',LC_ALL:'C',TZ:'UTC'},deadline,log,signal:abort.signal});
  const completed=native.then(result=>({result}));
  while(!existsSync(join(root,'view','ready.json'))){
   abort.signal.throwIfAborted();
   assert(performance.now()<deadline-2000,'Protected view handshake budget exhausted');
   const outcome=await Promise.race([completed,delay(20)]);
   if(outcome){report.nativeResult=outcome.result;throw Error('Transport exited before physical proof');}
  }
  const ready=packet(join(root,'view','ready.json'));
  assert.equal(ready.token,plan.token);
  const {channels}=packet(join(root,'channels.json'));
  report.descendant=outerProcess(ready,plan,channels,compilerProcIdentity,proof.monitor);
  for(const role of roles)assert.notEqual(ready.namespace[role],plan.namespace[role]);
  assert.equal(accepted,1,'Protected view reached the owned host listener');
  assert.deepEqual(seal(join(root,'source','canary')),plan.source);
  assert.deepEqual(seal(join(root,'dependencies','canary')),plan.dependency);
  for(const [directory,expected]of [['source',['canary']],['dependencies',['canary']],['host-only',['canary']]]){
   assert.deepEqual(readdirSync(join(root,directory)),expected);
  }
  for(const path of ['home','tmp','cache','generated'])assert.equal(readFileSync(join(root,'view',path,'owned'),'utf8'),'private output\n');
  assert.deepEqual(ready.mutationRefusals,[{role:'source',code:'EROFS'},{role:'source',code:'EROFS'},
   {role:'dependency',code:'EROFS'},{role:'dependency',code:'EROFS'}]);
  const {token,...observed}=ready;
  report.observed=observed;
  publish(join(root,'view','grant.json'),{token});
  report.nativeResult=await native;
  requireNativeSuccess(report.nativeResult);
  assert.deepEqual(readCompilerReferenceClock(admitCompilerReference('fixture')),clock);
  report.transportQualified=true;
 }catch(error){
  primary=error;
  report.refusal={name:error.name,code:error.code??null,message:error.message};
 }finally{
  abort.abort(Error('Protected view settlement required'));
  try{
   if(native)report.nativeResult=await native;
   if(server?.listening)await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
   rmSync(root,{recursive:true});
   report.privateScratchRemoved=!existsSync(root);
  }catch(error){
   report.transportQualified=false;
   report.settlementRefusal={name:error.name,code:error.code??null,message:error.message};
   primary=primary?new AggregateError([primary,error],'Protected view and direct cleanup both refused'):error;
  }finally{
   process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);
   save(join(output,'report.json'),report);
  }
 }
 if(primary)throw primary;
 assert(report.transportQualified&&report.privateScratchRemoved);
}

if(process.argv[1]===self&&process.argv[2]==='launch')launch(process.argv[3]);
if(self==='/preflight/probe.mjs')await entry();
