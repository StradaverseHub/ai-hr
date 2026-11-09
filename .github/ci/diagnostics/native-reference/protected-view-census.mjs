/** Read-only hosted transport inventory. No sandbox or workload is started. */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstatSync,mkdirSync,readFileSync,readlinkSync,realpathSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {cpus,totalmem} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {admitCompilerReference,readCompilerReferenceClock} from './admission.mjs';

const tools=['/usr/bin/bwrap','/usr/bin/docker','/usr/bin/podman','/usr/bin/runc','/usr/sbin/runc',
 '/usr/bin/crun','/usr/bin/unshare','/usr/bin/nsjail','/usr/bin/newuidmap','/usr/bin/newgidmap','/usr/bin/systemd-run'];
const images=['node:22.23.3-bookworm-slim','node:22.23.3-bookworm','ubuntu:24.04','debian:bookworm-slim'];
const namespaceKinds=['mnt','net','pid','user','ipc','uts','cgroup'];
const versionToken=/^[A-Za-z0-9.+:_-]{1,100}$/;
const imageId=/^sha256:[0-9a-f]{64}$/;
const infoFormat='{"version":{{json .ServerVersion}},"kernel":{{json .KernelVersion}},"os":{{json .OSType}},"arch":{{json .Architecture}},"cgroupDriver":{{json .CgroupDriver}},"cgroupVersion":{{json .CgroupVersion}},"security":{{json .SecurityOptions}},"runtime":{{json .DefaultRuntime}}}';
const imageFormat='{"id":{{json .Id}},"os":{{json .Os}},"arch":{{json .Architecture}},"digests":{{json .RepoDigests}},"hasVolumes":{{if .Config.Volumes}}true{{else}}false{{end}},"hasHealthcheck":{{if .Config.Healthcheck}}true{{else}}false{{end}}}';
const identity=row=>[row.dev,row.ino,row.uid,row.mode,row.size,row.mtimeMs,row.ctimeMs];
const sha=raw=>createHash('sha256').update(raw).digest('hex');
const resultCode=error=>['ENOENT','EACCES','EPERM','ENOTDIR'].includes(error?.code)?error.code:'rejected';

function utility(path){
 try{
  const named=lstatSync(path),resolved=realpathSync(path),row=lstatSync(resolved);
  assert.equal(named.uid,0);
  assert(resolved.startsWith('/usr/')&&row.isFile()&&row.uid===0&&(row.mode&0o022)===0&&(row.mode&0o111)!==0);
  assert(row.size>0&&row.size<=128*1024**2);
  for(let directory=dirname(resolved);directory!=='/';directory=dirname(directory)){
   const parent=lstatSync(directory);
   assert(parent.isDirectory()&&parent.uid===0&&(parent.mode&0o022)===0);
  }
  const bytes=readFileSync(resolved);
  assert.equal(bytes.length,row.size);
  assert(bytes.subarray(0,4).equals(Buffer.from([0x7f,0x45,0x4c,0x46])));
  assert.deepEqual(identity(lstatSync(resolved)),identity(row));
  assert.equal(realpathSync(path),resolved);
  return {path,resolved,status:'present',mode:(row.mode&0o7777).toString(8),sha256:sha(bytes)};
 }catch(error){return {path,status:resultCode(error)};}
}
function kernelInteger(path){
 try{
  const value=readFileSync(path,'utf8').trim();
  assert(/^(0|[1-9][0-9]{0,9})$/.test(value));
  return Number(value);
 }catch(error){return resultCode(error);}
}
function imageFacts(tag,row){
 assert(imageId.test(row.id)&&row.os==='linux'&&row.arch==='amd64');
 assert(typeof row.hasVolumes==='boolean'&&typeof row.hasHealthcheck==='boolean');
 const repository=tag.split(':')[0];
 const digests=(row.digests??[]).filter(value=>typeof value==='string'&&new RegExp(
  '^(?:(?:docker\\.io/)?library/)?'+repository+'@sha256:[0-9a-f]{64}$').test(value));
 return {tag,status:'locally-present',id:row.id,officialNamedDigests:[...new Set(digests)].sort(),
  hasVolumes:row.hasVolumes,hasHealthcheck:row.hasHealthcheck};
}
function serverFacts(row){
 for(const name of ['version','kernel','os','arch','cgroupDriver','cgroupVersion','runtime'])assert(versionToken.test(String(row[name])));
 assert(row.os==='linux'&&['x86_64','amd64'].includes(row.arch));
 assert(Array.isArray(row.security)&&row.security.length<=20&&row.security.every(value=>typeof value==='string'&&value.length<=150));
 const option=name=>row.security.some(value=>value===`name=${name}`||value.startsWith(`name=${name},`));
 const {security,...facts}=row;
 return {...facts,rootless:option('rootless'),seccomp:option('seccomp'),apparmor:option('apparmor'),
  selinux:option('selinux'),privateCgroupNamespacesSupported:option('cgroupns'),userNamespacesConfigured:option('userns'),
  defaultSeccompReported:security.includes('name=seccomp,profile=builtin')};
}
function dockerCensus(kind,socket,config,deadline){
 let socketId;
 try{
  const canonical=kind==='system'?'/run/docker.sock':socket;
  assert.equal(realpathSync(socket),canonical);
  const row=lstatSync(canonical);
  assert(row.isSocket()&&(row.mode&0o002)===0&&row.uid===(kind==='system'?0:process.getuid()));
  socketId=identity(row);
  const host='unix://'+socket;
  const env={PATH:'/usr/bin:/bin',HOME:config,LANG:'C',LC_ALL:'C',DOCKER_CONFIG:config,DOCKER_HOST:host};
  const invoke=arguments_=>{
   const remaining=deadline-performance.now();
   assert(remaining>1000,'Census frontier closed');
   assert.equal(realpathSync(socket),canonical);
   assert.deepEqual(identity(lstatSync(canonical)),socketId);
   const result=spawnSync('/usr/bin/docker',['--config',config,'--host',host,...arguments_],{
    env,stdio:['ignore','pipe','pipe'],encoding:'utf8',timeout:Math.min(2500,remaining-500),killSignal:'SIGKILL',maxBuffer:32768});
   assert.equal(realpathSync(socket),canonical);
   assert.deepEqual(identity(lstatSync(canonical)),socketId);
   return result;
  };
  const info=invoke(['info','--format',infoFormat]);
  if(info.error||info.signal||info.status!==0)return {kind,status:'daemon-not-admitted'};
  const server=serverFacts(JSON.parse(info.stdout));
  assert(kind!=='user'||server.rootless,'User socket did not prove rootless server');
  const existingImages=images.map(tag=>{
   const result=invoke(['image','inspect','--format',imageFormat,tag]);
   if(!result.error&&!result.signal&&result.status===0)return imageFacts(tag,JSON.parse(result.stdout));
   const missing=result.status===1&&!result.error&&!result.signal&&/No such (?:image|object)(?::|\b)/i.test(result.stderr);
   return {tag,status:missing?'not-cached':'not-admitted'};
  });
  return {kind,status:'available-read-only',server,existingImages};
 }catch(error){return {kind,status:resultCode(error)};}
}

export async function protectedViewCensus(){
 const proof=admitCompilerReference('fixture'),clock=readCompilerReferenceClock(proof);
 assert.equal(proof.sourceHead,proof.controllerHead);
 assert.equal(process.arch,'x64');
 assert.equal(cpus().length,4);
 assert(totalmem()>=14*1024**3&&totalmem()<=18*1024**3);
 assert.equal(proof.sourceHashes['.github/ci/diagnostics/native-reference/protected-view-census.mjs'],sha(readFileSync(fileURLToPath(import.meta.url))));
 const remaining=720000-Number(process.hrtime.bigint()-BigInt(clock.startNs))/1e6;
 const deadline=performance.now()+Math.min(28000,remaining-2000);
 assert(deadline-performance.now()>4000);
 const output=join(proof.destination,'compiler-protected-view-census'),config=join(output,'empty-docker-config');
 mkdirSync(output,{mode:0o700});mkdirSync(config,{mode:0o700});
 const report={kind:'NATIVE_REFERENCE_PROTECTED_VIEW_CAPABILITY_CENSUS',source:proof.sourceHead,controller:proof.controllerHead,
  run:proof.run,attempt:proof.attempt,censusComplete:false,transportQualified:false,stockNextInvoked:false,strictCompilerInvoked:false,
  ordinaryCompilerQualified:false,releaseAuthorized:false,containersCreated:0,imagesAcquired:0,hostPolicyChanges:0};
 try{
  const distro=readFileSync('/etc/os-release','utf8');
  assert.match(distro,/^ID=ubuntu$/m);assert.match(distro,/^VERSION_ID="24\.04"$/m);
  const namespaces=Object.fromEntries(namespaceKinds.map(kind=>{
   const value=readlinkSync('/proc/self/ns/'+kind);
   assert(new RegExp('^'+kind+':\\[[1-9][0-9]*\\]$').test(value));
   return [kind,value];
  }));
  const controllers=readFileSync('/sys/fs/cgroup/cgroup.controllers','utf8').trim().split(/\s+/);
  assert(controllers.every(value=>/^[a-z_]+$/.test(value)));
  report.host={distro:'ubuntu-24.04',arch:process.arch,logicalCpus:cpus().length,totalMemoryBytes:totalmem(),namespaces,controllers,
   apparmorUnprivilegedUserns:kernelInteger('/proc/sys/kernel/apparmor_restrict_unprivileged_userns'),
   unprivilegedUsernsClone:kernelInteger('/proc/sys/kernel/unprivileged_userns_clone'),
   maxUserNamespaces:kernelInteger('/proc/sys/user/max_user_namespaces')};
  report.utilities=tools.map(path=>{assert(performance.now()<deadline-1000);return utility(path);});
  const docker=report.utilities.find(row=>row.path==='/usr/bin/docker');
  report.docker=docker.status==='present'&&docker.resolved==='/usr/bin/docker'&&(Number.parseInt(docker.mode,8)&0o6000)===0?
   [dockerCensus('system','/var/run/docker.sock',config,deadline),
    dockerCensus('user','/run/user/'+process.getuid()+'/docker.sock',config,deadline)]:[];
  assert.deepEqual(readCompilerReferenceClock(admitCompilerReference('fixture')),clock);
  assert(performance.now()<deadline);
  report.censusComplete=true;
 }catch(error){
  report.refusal=resultCode(error);
  throw error;
 }finally{
  try{
   assert.deepEqual(readdirSync(config),[],'Read-only CLI changed its private config directory');
  }catch(error){
   report.censusComplete=false;
   report.refusal=resultCode(error);
   throw error;
  }finally{
   rmSync(config,{recursive:true});
   writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
  }
 }
}
