/** UNINSTALLED experiment only. Eligibility has NO caller-supplied inputs. */
import {createHash} from 'node:crypto';
import {constants,closeSync,fstatSync,openSync,readSync,realpathSync,statSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
import {asciiObservation,asciiProofSourceBytes,asciiProofSha,asciiProofRuntime,nodeScalarCorpus,readAsciiCaseContract,sigmaContextVectors} from '../fixtures/employee-choice-ascii-observation';
import {exactAsciiForbiddenEnvironment,exactAsciiHeapOnly,exactAsciiKernel,exactAsciiLaunchShape,exactAsciiFileIdentityEqual,exactAsciiBinaryMatch,exactAsciiIntrinsicIdentity} from './employee-choice-exact-ascii-runtime-contract';
type Report=Readonly<{kind:'UNINSTALLED_ASCII_PROCESS_QUALIFICATION_NOT_RELEASE';status:'uninitialized'|'qualified'|'fallback'|'closed';reason:string;coldMs:number;binaryBytes:number;scalarCount:number;scalarSha256:string|null;contexts:number;binarySha256:string|null;versions:Readonly<Record<string,string|undefined>>;startupProfile:string|null;releaseAuthorized:false}>;
type FileIdentity=ReturnType<typeof identity>;
const intrinsics=Object.freeze({lower:String.prototype.toLowerCase,trim:String.prototype.trim,includes:String.prototype.includes,fromCodePoint:String.fromCodePoint});
const proofSources=Object.freeze({'test/fixtures/employee-choice-ascii-observation.ts':'a6b0a1cc58224abbdf29e0e0613977b4cc4f18534dbb7ee3ec65bb2d2a5fb6cd','test/fixtures/unicode-17.0.0/UnicodeData.txt':'2e1efc1dcb59c575eedf5ccae60f95229f706ee6d031835247d843c11d96470c','test/fixtures/unicode-17.0.0/SpecialCasing.txt':'efc25faf19de21b92c1194c111c932e03d2a5eaf18194e33f1156e96de4c9588'});
let report:Report=Object.freeze({kind:'UNINSTALLED_ASCII_PROCESS_QUALIFICATION_NOT_RELEASE',status:'uninitialized',reason:'not-requested',coldMs:0,binaryBytes:0,scalarCount:0,scalarSha256:null,contexts:0,binarySha256:null,versions:Object.freeze({...process.versions}),startupProfile:null,releaseAuthorized:false});
let fd:number|undefined,kernel:FileIdentity|undefined,started=0;
const safeReasons=new Set(['runtime-file-shape', 'qualification-work-limit', 'startup-facts-bound', 'startup-override', 'startup-options', 'current-override', 'unknown-launch-profile', 'launch-package-version', 'unreviewed-preload', 'preload-source', 'unreviewed-entry', 'startup-argv-mismatch', 'proof-source', 'runtime-identity-drift', 'runtime-intrinsic-drift', 'runtime-version', 'runtime-version-drift', 'runtime-argv-drift', 'runtime-environment-drift', 'runtime-source-drift', 'runtime-binary-truncated', 'runtime-scalar-proof', 'runtime-context-proof', 'runtime-context-shape']);
let snapshot:{pid:number;argv:readonly string[];execArgv:readonly string[];env:Readonly<Record<string,string|undefined>>;files:ReadonlyMap<string,FileIdentity>}|undefined;
function identity(file:number|string){const s=typeof file==='number'?fstatSync(file,{bigint:true}):statSync(file,{bigint:true});if(!s.isFile())throw Error('runtime-file-shape');return{device:s.dev,inode:s.ino,bytes:s.size,mtime:s.mtimeNs,ctime:s.ctimeNs};}
const equal=exactAsciiFileIdentityEqual;
function check(signal?:AbortSignal){signal?.throwIfAborted();if(performance.now()-started>5000)throw Error('qualification-work-limit');}
function boundedProc(path:'/proc/self/cmdline'|'/proc/self/environ'){
 const input=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const buffer=Buffer.alloc(256*1024+1);let size=0;while(size<buffer.length){const n=readSync(input,buffer,size,buffer.length-size,null);if(!n)break;size+=n;}if(size===buffer.length)throw Error('startup-facts-bound');return buffer.subarray(0,size);}finally{closeSync(input);}
}
function relevantEnvironment(){return Object.fromEntries([...exactAsciiForbiddenEnvironment,'NODE_OPTIONS'].map(key=>[key,process.env[key]]));}
function startup(){
 const bytes=boundedProc('/proc/self/environ');try{for(const field of bytes.toString('utf8').split('\0')){const at=field.indexOf('=');if(at<0)continue;const key=field.slice(0,at),value=field.slice(at+1);if(exactAsciiForbiddenEnvironment.some(name=>name===key))throw Error('startup-override');if(key==='NODE_OPTIONS'&&!exactAsciiHeapOnly(value))throw Error('startup-options');}}finally{bytes.fill(0);}
 const env=relevantEnvironment();if(exactAsciiForbiddenEnvironment.some(key=>env[key]!==undefined)||!exactAsciiHeapOnly(env.NODE_OPTIONS??''))throw Error('current-override');
 const shape=exactAsciiLaunchShape(process.execArgv);if(!shape)throw Error('unknown-launch-profile');
 const require=createRequire(import.meta.url),packagePath=realpathSync(require.resolve('vitest/package.json')),root=dirname(packagePath);
 const packageBytes=asciiProofSourceBytes(packagePath,exactAsciiKernel.packageBytes);
 if(packageBytes.length!==exactAsciiKernel.packageBytes||asciiProofSha(packageBytes)!==exactAsciiKernel.packageSha256||JSON.parse(packageBytes.toString('utf8')).version!=='4.1.8')throw Error('launch-package-version');
 const preload=realpathSync(shape.preload),expected=realpathSync(join(root,'suppress-warnings.cjs'));
 if(preload!==expected)throw Error('unreviewed-preload');const bytesPreload=asciiProofSourceBytes(preload,exactAsciiKernel.preloadBytes);
 if(bytesPreload.length!==exactAsciiKernel.preloadBytes||asciiProofSha(bytesPreload)!==exactAsciiKernel.preloadSha256)throw Error('preload-source');
 const entry=realpathSync(join(root,'dist/workers/forks.js')),entryBytes=asciiProofSourceBytes(entry,exactAsciiKernel.entryBytes);
 if(entryBytes.length!==exactAsciiKernel.entryBytes||asciiProofSha(entryBytes)!==exactAsciiKernel.entrySha256||process.argv.length!==2||realpathSync(process.argv[1])!==entry)throw Error('unreviewed-entry');
 const cmdBytes=boundedProc('/proc/self/cmdline');try{const actual=cmdBytes.toString('utf8').split('\0');if(actual.at(-1)==='')actual.pop();const expectedArgs=[process.execPath,...process.execArgv,process.argv[1]];if(actual.length!==expectedArgs.length||actual.some((value,index)=>value!==expectedArgs[index]))throw Error('startup-argv-mismatch');}finally{cmdBytes.fill(0);}
 const files=new Map<string,FileIdentity>([[preload,identity(preload)],[packagePath,identity(packagePath)],[entry,identity(entry)]]);
 for(const [path,hash]of Object.entries(proofSources)){if(asciiProofSha(asciiProofSourceBytes(path))!==hash)throw Error('proof-source');files.set(path,identity(path));}
 for(const path of ['test/performance/employee-choice-exact-ascii-runtime.ts','test/performance/employee-choice-exact-ascii-runtime-contract.ts','test/performance/employee-choice-exact-ascii-reader.ts','test/performance/employee-choice-exact-ascii-owner.ts','test/fixtures/employee-choice-exact-ascii-purpose.sql'])files.set(path,identity(path));
 return{pid:process.pid,argv:Object.freeze([...process.argv]),execArgv:Object.freeze([...process.execArgv]),env:Object.freeze(env),files};
}
function stable(){
 const current=snapshot;
 if(!current||fd===undefined||!kernel||!equal(identity(fd),kernel)||!equal(identity(process.execPath),kernel)||process.pid!==current.pid)throw Error('runtime-identity-drift');
 if(!exactAsciiIntrinsicIdentity({lower:String.prototype.toLowerCase,trim:String.prototype.trim,includes:String.prototype.includes,fromCodePoint:String.fromCodePoint},intrinsics))throw Error('runtime-intrinsic-drift');
 if(!asciiProofRuntime(process.versions))throw Error('runtime-version');
 if(Object.keys(process.versions).length!==Object.keys(report.versions).length||Object.entries(report.versions).some(([key,value])=>process.versions[key]!==value))throw Error('runtime-version-drift');
 if(process.argv.length!==current.argv.length||process.argv.some((value,index)=>value!==current.argv[index])||process.execArgv.length!==current.execArgv.length||process.execArgv.some((value,index)=>value!==current.execArgv[index]))throw Error('runtime-argv-drift');
 for(const [key,value]of Object.entries(current.env))if(process.env[key]!==value)throw Error('runtime-environment-drift');
 for(const [path,observed]of current.files)if(!equal(identity(path),observed))throw Error('runtime-source-drift');
}
function fallback(reason:string){if(fd!==undefined){try{closeSync(fd);fd=undefined;}catch{reason='qualification-fd-close-refused';}}report=Object.freeze({...report,status:'fallback',reason,coldMs:report.status==='uninitialized'?performance.now()-started:report.coldMs});return false;}
export function exactAsciiPrototypeRuntime(signal?:AbortSignal):boolean{
 if(report.status==='fallback'||report.status==='closed')return false;
 try{
  if(report.status==='uninitialized')started=performance.now();
  if(signal!==undefined&&!(signal instanceof AbortSignal))return fallback('unsupported-signal');
  if(report.status==='qualified'){stable();signal?.throwIfAborted();return true;}
  started=performance.now();if(process.platform!=='linux'||process.arch!=='x64')return fallback('unsupported-platform');
  if(!asciiProofRuntime(process.versions))return fallback('runtime-version');
  snapshot=startup();check(signal);
  // /proc/self/exe is intentionally the kernel-owned executable symlink, not
  // a caller-selected filesystem path; verify its resolved FD against execPath.
  fd=openSync('/proc/self/exe',constants.O_RDONLY|constants.O_NONBLOCK);kernel=identity(fd);if(kernel.bytes!==BigInt(exactAsciiKernel.bytes)||!equal(identity(process.execPath),kernel))return fallback('runtime-binary-shape');
  const hash=createHash('sha256'),block=Buffer.alloc(65536);let bytes=0;
  while(bytes<exactAsciiKernel.bytes){check(signal);const n=readSync(fd,block,0,Math.min(block.length,exactAsciiKernel.bytes-bytes),bytes);if(!n)throw Error('runtime-binary-truncated');hash.update(block.subarray(0,n));bytes+=n;}
  const binarySha256=hash.digest('hex');report=Object.freeze({...report,binaryBytes:bytes,binarySha256});
  if(readSync(fd,block,0,1,bytes)!==0||!exactAsciiBinaryMatch(bytes,binarySha256)||!equal(identity(fd),kernel))return fallback('runtime-binary');
  const contract=readAsciiCaseContract(),scalars=nodeScalarCorpus(contract,()=>check(signal));if(scalars.sha256!==exactAsciiKernel.scalarSha256)throw Error('runtime-scalar-proof');
  const source=sigmaContextVectors();for(const row of source){if(row.text.toLowerCase().includes('ς')!==row.final)throw Error('runtime-context-proof');}
  const vectors=[...source.map(row=>row.text),'İA','KA','ßſﬀ','😀A\u0307B'];
  for(const text of vectors){let expected='';for(const scalar of text){const cp=scalar.codePointAt(0);if(cp===undefined)throw Error('runtime-context-shape');expected+=String.fromCodePoint(...(contract.lower.get(cp)??[cp]));}if(asciiObservation(text.toLowerCase())!==asciiObservation(expected))throw Error('runtime-context-proof');}
  stable();check(signal);report=Object.freeze({...report,status:'qualified',reason:'exact-binary-and-behavior',coldMs:performance.now()-started,binaryBytes:bytes,scalarCount:scalars.count,scalarSha256:scalars.sha256,contexts:vectors.length,startupProfile:'locked-vitest4.1.8-fixed-preload'});return true;
 }catch(error){return fallback(signal?.aborted?'qualification-aborted':error instanceof Error&&safeReasons.has(error.message)?error.message:'qualification-refused');}
}
/** Observations only. A copied/forged report cannot activate the reader. */
export function exactAsciiPrototypeRuntimeEvidence():Report{return report;}
export function closeExactAsciiPrototypeRuntime(){if(fd!==undefined){closeSync(fd);fd=undefined;}report=Object.freeze({...report,status:'closed',reason:'owner-closed'});}
