/** Observations ONLY. Nothing here admits a launch or changes runtime state. */
import {createHash} from 'node:crypto';
import {constants,openSync,readSync,closeSync,fstatSync} from 'node:fs';
import {basename} from 'node:path';
const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const category=(value:string)=>value==='node'?'node-condition':value==='development'?'development-condition':value==='production'?'production-condition':value==='4096'?'heap4096':value==='6144'?'heap6144':basename(value)==='suppress-warnings.cjs'?'vitest-preload-basename-only':'redacted';
type Token=Readonly<{index:number;kind:'node-flag'|'unknown-flag'|'value';name:string|null;form:'bare'|'equals'|'value';category:string;sha256:string}>;
type Shape=Readonly<{status:'bounded';count:number;utf8Bytes:number;sha256:string;tokens:readonly Token[]}>|Readonly<{status:'refused';reason:'argument-bound'|'argument-type'|'observation-output-bound'}>;
/** Pure diagnostic model seam. Even a matching basename is never qualification. */
export function exactAsciiLaunchObservationShape(input:readonly string[]):Shape{
 if(!Array.isArray(input)||input.length>64)return Object.freeze({status:'refused',reason:'argument-bound'});
 const args:string[]=[];let bytes=0;
 for(let index=0;index<input.length;index++){
  const descriptor=Object.getOwnPropertyDescriptor(input,String(index)),value=descriptor?.value;
  if(!descriptor||!Object.hasOwn(descriptor,'value')||typeof value!=='string'||value.includes('\0'))return Object.freeze({status:'refused',reason:'argument-type'});
  const size=Buffer.byteLength(value);if(size>4096||(bytes+=size)>65536)return Object.freeze({status:'refused',reason:'argument-bound'});args.push(value);
 }
 const tokens=args.map((value,index):Token=>{
  if(value.startsWith('-')){
   const at=value.indexOf('='),name=at<0?value:value.slice(0,at),known=/^--?[a-z0-9][a-z0-9_-]{0,79}$/.test(name)&&process.allowedNodeEnvironmentFlags.has(name);
   return Object.freeze({index,kind:known?'node-flag':'unknown-flag',name:known?name:null,form:at<0?'bare':'equals',category:at<0?'no-inline-value':category(value.slice(at+1)),sha256:sha(value)});
  }
  return Object.freeze({index,kind:'value',name:null,form:'value',category:category(value),sha256:sha(value)});
 });
 const value={status:'bounded' as const,count:args.length,utf8Bytes:bytes,sha256:sha(JSON.stringify(args)),tokens:Object.freeze(tokens)};
 return Buffer.byteLength(JSON.stringify(value))<=8192?Object.freeze(value):Object.freeze({status:'refused',reason:'observation-output-bound'});
}
/** Fixed current-process kernel source; no environment/path/argument values escape. */
export function observeExactAsciiLaunch(){
 const execArgv=exactAsciiLaunchObservationShape(process.execArgv);
 let descriptor:number|undefined;
 try{
  descriptor=openSync('/proc/self/cmdline',constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  const stat=fstatSync(descriptor);if(!stat.isFile()||stat.uid!==process.getuid!())throw Error('closed native shape');
  const buffer=Buffer.alloc(262145);let size=0;
  try{
   while(size<buffer.length){const n=readSync(descriptor,buffer,size,buffer.length-size,null);if(!n)break;size+=n;}
   if(size===buffer.length||size===0||buffer[size-1]!==0)throw Error('closed native shape');
   const raw=buffer.subarray(0,size),args=raw.subarray(0,-1).toString('utf8').split('\0');
   const expected=[process.execPath,...process.execArgv,process.argv[1]];
   return Object.freeze({kind:'ACTUAL_CURRENT_LAUNCH_SHAPE_NOT_ELIGIBILITY',observedAt:'owned-cleanup-before-runtime-close',execArgv,
    nativeCmdline:Object.freeze({status:'observed',count:args.length,sha256:sha(raw),matchesRuntimeExpectedArgv:args.length===expected.length&&args.every((value,index)=>value===expected[index]),executableMatches:args[0]===process.execPath,entryCategory:basename(args.at(-1)??'')==='forks.js'?'vitest-forks-basename-only':'redacted'}),releaseAuthorized:false});
  }finally{buffer.fill(0);}
 }catch{
  return Object.freeze({kind:'ACTUAL_CURRENT_LAUNCH_SHAPE_NOT_ELIGIBILITY',observedAt:'owned-cleanup-before-runtime-close',execArgv,nativeCmdline:Object.freeze({status:'unavailable'}),releaseAuthorized:false});
 }finally{if(descriptor!==undefined)closeSync(descriptor);}
}
