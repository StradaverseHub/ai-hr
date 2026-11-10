/** Read immutable Git source bytes; JSON self-declared hashes are never authority. */
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {closeSync,constants,fstatSync,lstatSync,openSync,readSync,realpathSync,type BigIntStats} from 'node:fs';
import {join} from 'node:path';
import {NAVIGATION_HARNESS_ROOTS,NAVIGATION_SCENARIO_FILE,validateNavigationScenarioPlan} from './navigation-protocol';
const git=(root:string,...args:string[])=>execFileSync('git',args,{cwd:root,maxBuffer:32*1024*1024});
export const navigationSha256=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');

// Exact startup replay data, matching the protected history reader's four
// whole Git objects. Other versions still use the ordinary source bounds.
const startupHistory=[
 {path:'deploy/admission/next_bootstrap_session_inverse.json',size:3545489,
  blob:'49f83e06f4569bf92d4c8892710f21f1811a91ee',sha256:'e5cc5b26fc5ef0d0d645fb52b108b411acad37767762761c66c8ddd4bb34389f'},
 {path:'deploy/admission/next_controller_admit_terminal_inverse.json',size:24562318,
  blob:'695731da0bdc99b71bc31c2c5155cf18cfdfae58',sha256:'eef1df2cdf4524df269773cc8cda3ca53cb4149c9430ffc349ac9c045cad8357'},
 {path:'deploy/admission/next_controller_admit_timing_inverse.json',size:8971484,
  blob:'1f5992d8d6399263e77ddc5aa7a17b81c99de6a5',sha256:'5dee72ab0c5ae1d7827dee99f7da92023fc82d8129bee3d4dd8457912a64879b'},
 {path:'deploy/admission/next_host_history_controller_inverse.json',size:39474867,
  blob:'4e64a7924aff4438fa4d2a3e4e6e5ac3c4c0c787',sha256:'7657c27da9d577e3c2d49db285439b37e6970a517250691af70f0f495c08cbe6'},
] as const;
const identityKeys=['dev','ino','mode','uid','gid','nlink','size','mtimeNs','ctimeNs'] as const;
const sameHistoryFile=(left:BigIntStats,right:BigIntStats)=>identityKeys.every(key=>left[key]===right[key]);

function hashStartupHistory(root:string,pin:(typeof startupHistory)[number]){
 const file=join(realpathSync(root),pin.path);
 if(realpathSync(file)!==file)throw Error('Fixed navigation history link refused');
 const named=lstatSync(file,{bigint:true});
 if(!named.isFile()||named.nlink!==BigInt(1)||named.size!==BigInt(pin.size)
  ||!(named.mode&BigInt(0o400))||named.mode&BigInt(0o7133))
  throw Error('Fixed navigation history checkout metadata differs');
 const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const before=fstatSync(fd,{bigint:true});
  if(!sameHistoryFile(before,named))throw Error('Fixed navigation history checkout metadata differs');
  const raw=createHash('sha256'),blob=createHash('sha1').update('blob '+pin.size+'\0');
  const buffer=Buffer.alloc(256*1024);
  let remaining=pin.size;
  while(remaining>0){
   const count=readSync(fd,buffer,0,Math.min(remaining,buffer.length),null);
   if(!count)throw Error('Fixed navigation history truncated');
   const bytes=buffer.subarray(0,count);raw.update(bytes);blob.update(bytes);remaining-=count;
  }
  if(readSync(fd,buffer,0,1,null)!==0||!sameHistoryFile(before,fstatSync(fd,{bigint:true}))
   ||!sameHistoryFile(before,lstatSync(file,{bigint:true}))||realpathSync(file)!==file)
   throw Error('Fixed navigation history checkout changed');
  const digest=raw.digest('hex');
  if(digest!==pin.sha256||blob.digest('hex')!==pin.blob)throw Error('Fixed navigation history bytes differ');
  return digest;
 }finally{closeSync(fd);}
}

export function navigationCleanHead(root:string):string{
 const sha=git(root,'rev-parse','HEAD').toString().trim();
 if(!/^[a-f0-9]{40}$/.test(sha)||git(root,'status','--porcelain').toString().trim())throw Error('Navigation evidence needs an exact clean source tree');
 if(git(root,'remote','get-url','origin').toString().trim().toLowerCase()!=='https://github.com/stradaversehub/ai-hr.git')throw Error('Navigation source repository differs');
 return sha;
}
export function navigationSourceIdentity(root:string,sha:string){
 if(!/^[a-f0-9]{40}$/.test(sha))throw Error('Invalid navigation source revision');
 const records=git(root,'ls-tree','-r','-l','-z','--full-tree',sha,'--',...NAVIGATION_HARNESS_ROOTS).toString().split('\0').filter(Boolean);
 if(!records.length||records.length>2048)throw Error('Navigation harness inventory exceeds bounds');
 let total=0;
 const files=records.map(record=>{
  const match=record.match(/^(100644|100755) blob ([a-f0-9]{40}) +(0|[1-9][0-9]*)\t([^\0]+)$/);
  if(!match)throw Error('Navigation harness must contain regular source files');
  const [,mode,oid,length,path]=match,size=Number(length);
  const fixed=startupHistory.find(pin=>pin.path===path&&pin.blob===oid);
  if(fixed){
   if(mode!=='100644'||size!==fixed.size)throw Error('Fixed navigation history Git metadata differs');
   return {path,mode,sha256:hashStartupHistory(root,fixed)};
  }
  total+=size;
  if(!Number.isSafeInteger(size)||size>2*1024*1024||total>32*1024*1024)throw Error('Navigation harness source exceeds bounds');
  const bytes=git(root,'show',sha+':'+path);
  if(bytes.length!==size)throw Error('Navigation harness source size differs from Git');
  return {path,mode,sha256:navigationSha256(bytes)};
 }).sort((a,b)=>a.path.localeCompare(b.path,'en'));
 if(!files.some(file=>file.path===NAVIGATION_SCENARIO_FILE)||!files.some(file=>file.path==='scripts/performance/navigation-browser-capture.ts'))throw Error('Trusted navigation capture harness is incomplete');
 const scenarioBytes=git(root,'show',sha+':'+NAVIGATION_SCENARIO_FILE);
 return {harnessSha256:navigationSha256(JSON.stringify(files)),scenarioSha256:navigationSha256(scenarioBytes),files,
  plan:validateNavigationScenarioPlan(JSON.parse(scenarioBytes.toString()))};
}
