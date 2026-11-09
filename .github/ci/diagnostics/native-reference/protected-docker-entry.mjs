/** Fixed synthetic Node PID 1. No Docker client or product module is available here. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {constants,existsSync,readFileSync,readdirSync,readlinkSync,renameSync,statSync,writeFileSync} from 'node:fs';
import {createConnection} from 'node:net';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

const roles=['mnt','net','pid','ipc','uts','cgroup'];
const readOnly=['/','/input','/dependency','/probe/entry.mjs','/probe/plan.json','/runtime/node','/lib/x86_64-linux-gnu',
 '/lib64/ld-linux-x86-64.so.2','/etc/hostname','/etc/hosts','/etc/resolv.conf'];
const pseudo=['/proc','/proc/acpi','/proc/asound','/proc/bus','/proc/fs','/proc/interrupts','/proc/irq','/proc/kcore',
 '/proc/keys','/proc/latency_stats','/proc/scsi','/proc/sched_debug','/proc/sys','/proc/sysrq-trigger','/proc/timer_list',
 '/proc/timer_stats','/dev','/dev/pts','/dev/mqueue','/sys','/sys/firmware','/sys/fs/cgroup','/sys/devices/virtual/powercap'];

export const namespaceIds=(pid='self')=>Object.fromEntries(roles.map(kind=>{
 const value=readlinkSync('/proc/'+pid+'/ns/'+kind);
 assert(new RegExp('^'+kind+':\\[[1-9][0-9]*\\]$').test(value));
 return [kind,value];
}));
export function fileBirth(path){
 const value=statSync(path,{bigint:true});
 return {device:String(value.dev),inode:String(value.ino)};
}
export function canarySeal(path){
 return {...fileBirth(path),sha256:createHash('sha256').update(readFileSync(path)).digest('hex')};
}
export function assertDockerMounts(text){
 const observed=new Map();
 for(const line of text.trimEnd().split('\n')){
  const [left,right]=line.split(' - '),fields=left.split(' ');
  assert(right&&fields.length>=6);
  const point=fields[4],flags=fields[5].split(','),type=right.split(' ')[0];
  assert(!observed.has(point)&&[...readOnly,...pseudo,'/work'].includes(point),'Unknown or repeated container mount');
  assert(!fields.slice(6).some(value=>/^(shared|master|propagate_from):/.test(value)),'Container mount propagation refused');
  observed.set(point,{flags,type});
 }
 for(const point of readOnly)assert(observed.get(point)?.flags.includes('ro'),'Required read-only mount missing');
 assert(observed.get('/work')?.flags.includes('rw'),'Private output mount missing');
 assert.equal(observed.get('/proc')?.type,'proc');
 assert.equal(observed.get('/dev')?.type,'tmpfs');
 for(const point of ['/proc/sys','/sys','/sys/fs/cgroup'])assert(observed.get(point)?.flags.includes('ro'),'Required protected kernel mount missing');
 return {readOnly,privateWritable:['/work'],pseudoMounts:[...observed.keys()].filter(path=>pseudo.includes(path)).sort()};
}
const publish=(path,value)=>{
 writeFileSync(path+'.pending',JSON.stringify(value)+'\n',{flag:'wx',mode:0o600});
 renameSync(path+'.pending',path);
};
async function assertNoEgress(port){
 assert(Number.isSafeInteger(port)&&port>1023&&port<65536);
 return new Promise((resolve,reject)=>{
  const socket=createConnection({host:'127.0.0.1',port,timeout:1500});
  socket.once('connect',()=>{socket.destroy();reject(Error('Host listener reachable'));});
  socket.once('timeout',()=>{socket.destroy();reject(Error('Loopback isolation control timed out'));});
  socket.once('error',error=>['ECONNREFUSED','ENETUNREACH','EHOSTUNREACH','EADDRNOTAVAIL'].includes(error.code)?resolve(error.code):reject(error));
 });
}
async function run(){
 let phase='identity';
 try{
  assert.equal(process.pid,1);
  assert.equal(process.versions.node,'22.23.3');
  assert.deepEqual(process.argv,['/runtime/node','/probe/entry.mjs']);
  const plan=JSON.parse(readFileSync('/probe/plan.json','utf8'));
  assert.equal(process.getuid(),plan.uid);assert.equal(process.getgid(),plan.gid);assert(process.getuid()>0&&process.getgid()>0);
  assert.deepEqual(Object.fromEntries(Object.entries(process.env).sort()),Object.fromEntries(Object.entries(plan.env).sort()));
  const ns=namespaceIds();
  for(const role of roles)assert.notEqual(ns[role],plan.hostNamespaces[role]);
  assert.equal(readlinkSync('/proc/self/ns/user'),plan.hostUserNamespace);
  assert.deepEqual(fileBirth('/proc/self/exe'),plan.node);
  assert.equal(readFileSync('/proc/self/attr/current','utf8').trim(),'docker-default (enforce)');
  const status=readFileSync('/proc/self/status','utf8');
  for(const cap of ['CapInh','CapPrm','CapEff','CapBnd','CapAmb'])assert.match(status,new RegExp('^'+cap+':\\s+0{16}$','m'));
  assert.match(status,/^NoNewPrivs:\s+1$/m);
  assert.match(status,/^Seccomp:\s+2$/m);
  phase='mounts';
  const mounts=assertDockerMounts(readFileSync('/proc/self/mountinfo','utf8'));
  for(const path of ['/etc/hostname','/etc/hosts','/etc/resolv.conf'])assert.equal(readFileSync(path,'utf8'),'');
  for(const path of [plan.hiddenPath,'/run/docker.sock','/var/run/docker.sock','/run/containerd/containerd.sock','/input/.git'])
   assert(!existsSync(path),'Forbidden host name exposed');
  for(const fd of readdirSync('/proc/self/fd')){
   try{
    const target=readlinkSync('/proc/self/fd/'+fd);
    assert(/^pipe:\[[1-9][0-9]*\]$|^anon_inode:\[[a-z_]+\]$|^\/dev\/(null|urandom)$/.test(target),'Foreign process descriptor');
   }catch(error){if(error.code!=='ENOENT')throw error;}
  }
  for(const role of ['input','dependency']){
   const path='/'+role,canary=join(path,'canary');
   assert.deepEqual(canarySeal(canary),plan[role]);
   assert.throws(()=>writeFileSync(canary,'blocked',{flag:constants.O_WRONLY}),{code:'EROFS'});
   assert.throws(()=>writeFileSync(join(path,'new'),'blocked',{flag:'wx'}),{code:'EROFS'});
   assert.deepEqual(canarySeal(canary),plan[role]);
  }
  for(const name of ['home','tmp','cache','generated'])writeFileSync('/work/'+name+'/canary','private output\n',{flag:'wx',mode:0o600});
  phase='network';
  const interfaces=readFileSync('/proc/net/dev','utf8').trimEnd().split('\n').slice(2).map(row=>row.split(':')[0].trim());
  assert.deepEqual(interfaces,['lo']);
  const ipv4=readFileSync('/proc/net/route','utf8').trimEnd().split('\n').slice(1);
  assert.deepEqual(ipv4,[]);
  if(existsSync('/proc/net/ipv6_route')){
   const rows=readFileSync('/proc/net/ipv6_route','utf8').trim().split('\n').filter(Boolean);
   assert(rows.every(line=>line.trim().split(/\s+/).at(-1)==='lo'));
  }
  const loopbackRefusal=await assertNoEgress(plan.port);
  publish('/work/ready.json',{nonce:plan.nonce,ns,mounts,loopbackRefusal,sourceMutationRefusals:4,
   seccomp:true,apparmor:true,noNewPrivs:true,zeroCapabilities:true});
  phase='host-grant';
  const until=performance.now()+15000;
  while(!existsSync('/work/grant.json')){assert(performance.now()<until);await delay(20);}
  assert.deepEqual(JSON.parse(readFileSync('/work/grant.json','utf8')),{nonce:plan.nonce});
 }catch(error){
  publish('/work/refused.json',{phase,code:typeof error.code==='string'?error.code:null});
  throw error;
 }
}
if(process.argv[1]==='/probe/entry.mjs'){
 const watchdog=setTimeout(()=>process.exit(88),30000);
 try{await run();}finally{clearTimeout(watchdog);}
}
