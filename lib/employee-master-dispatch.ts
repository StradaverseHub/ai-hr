/** Root-installed scheduling admission only. No Auth key, DB/session import or business queue. */
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat,open,realpath} from 'node:fs/promises';
import {dirname} from 'node:path';
import {userInfo} from 'node:os';
import {z} from 'zod';
export const INTERNAL_REPORT_DISPATCH_MARKER='/etc/aihr-internal-report-dispatch.json';
export const INTERNAL_REPORT_DISPATCH_CRON='/etc/cron.d/aihr-internal-reports';
export const INTERNAL_REPORT_DISPATCH_ROOT='/opt/ai-hr';
export const INTERNAL_REPORT_DISPATCH_RUNTIME='/usr/local/lib/aihr-identity-email/internal-node';
export const INTERNAL_REPORT_DISPATCH_LAUNCHER='/usr/local/lib/aihr-identity-email/internal-report-tick';
export const INTERNAL_REPORT_DISPATCH_CRON_SOURCE='# AIHR owned internal Employee Master dispatch v1\n* * * * * root '+INTERNAL_REPORT_DISPATCH_LAUNCHER+'\n';
export const INTERNAL_REPORT_DISPATCH_LEGACY_LINE='* * * * * cd /opt/ai-hr && deploy/cron-alert.sh provision /home/ubuntu/aihr-cron-logs/provision.log /opt/node20/bin/node --env-file=.env.production --import tsx scripts/provision-runner.ts';
export const INTERNAL_REPORT_DISPATCH_SOURCE_FILES=['lib/employee-master-dispatch.ts','scripts/provision-runner.ts'] as const;
const hash=z.string().regex(/^[a-f0-9]{64}$/);
export const internalReportDispatchMarker=z.object({version:z.literal(1),purpose:z.literal('aihr-internal-report-dispatch'),
 state:z.enum(['paused','active']),installationId:z.uuid(),runnerUser:z.string().max(64).regex(/^[-a-zA-Z0-9_.]+$/),runnerGroup:z.string().max(64).regex(/^[-a-zA-Z0-9_.]+$/),runnerUid:z.number().int().positive().max(2147483647),runnerGid:z.number().int().positive().max(2147483647),candidateRoot:z.literal(INTERNAL_REPORT_DISPATCH_ROOT),
 sourcePins:z.object({'lib/employee-master-dispatch.ts':hash,'scripts/provision-runner.ts':hash}).strict(),
 runtimeSha256:hash,instanceSha256:hash,cronSha256:hash}).strict();
export type InternalReportDispatchMarker=z.infer<typeof internalReportDispatchMarker>;
export const dispatchSha256=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
export function reportDispatchInstance(provider:string|undefined,database:string|undefined){
 if(provider!=='internal'||!database)throw new Error('Installed report dispatch instance mismatch.');
 const url=new URL(database);if(!['postgres:','postgresql:'].includes(url.protocol)||decodeURIComponent(url.username)!=='ai_hr_app'||!/^\/[a-zA-Z0-9_-]+$/.test(url.pathname)||url.hash)throw new Error('Installed report dispatch database mismatch.');
 return dispatchSha256(JSON.stringify({root:INTERNAL_REPORT_DISPATCH_ROOT,provider,host:url.hostname,port:url.port||'5432',database:url.pathname}));
}
export function validateReportDispatchMarker(raw:unknown,expected:{sourcePins:InternalReportDispatchMarker['sourcePins'];instanceSha256:string}){
 const value=internalReportDispatchMarker.parse(raw);
 if(value.cronSha256!==dispatchSha256(INTERNAL_REPORT_DISPATCH_CRON_SOURCE)||value.instanceSha256!==expected.instanceSha256||INTERNAL_REPORT_DISPATCH_SOURCE_FILES.some(file=>value.sourcePins[file]!==expected.sourcePins[file]))throw new Error('Installed report dispatch source or instance changed.');
 return value;
}
export async function assertDispatchRootParents(path:string){
 let parent=dirname(path);while(true){const stat=await lstat(parent);if(!stat.isDirectory()||stat.uid!==0||(stat.mode&0o022)!==0)throw new Error('Untrusted installed dispatch parent.');if(parent==='/')break;parent=dirname(parent);}
}
export async function readTrustedDispatchFile(path:string,maxBytes:number,mode:number):Promise<Buffer>{
 await assertDispatchRootParents(path);const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const before=await handle.stat({bigint:true});if(!before.isFile()||before.uid!==BigInt(0)||before.nlink!==BigInt(1)||(before.mode&BigInt(0o777))!==BigInt(mode)||before.size<BigInt(1)||before.size>BigInt(maxBytes))throw new Error('Untrusted installed dispatch file.');
  const buffer=Buffer.alloc(Number(before.size)+1);let count=0;while(count<buffer.length){const {bytesRead}=await handle.read(buffer,count,buffer.length-count,count);if(!bytesRead)break;count+=bytesRead;}
  const after=await handle.stat({bigint:true});if(count!==Number(before.size)||['dev','ino','uid','mode','nlink','size','mtimeNs','ctimeNs'].some(key=>before[key as keyof typeof before]!==after[key as keyof typeof after]))throw new Error('Installed dispatch file changed while reading.');return buffer.subarray(0,count);
 }finally{await handle.close();}
}
export async function readDispatchSourcePins():Promise<InternalReportDispatchMarker['sourcePins']>{
 const pins={} as InternalReportDispatchMarker['sourcePins'];
 for(const file of INTERNAL_REPORT_DISPATCH_SOURCE_FILES){const path=INTERNAL_REPORT_DISPATCH_ROOT+'/'+file;if(await realpath(path)!==path)throw new Error('Installed dispatch source is symlinked.');const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const before=await handle.stat({bigint:true});if(!before.isFile()||(before.mode&BigInt(0o022))!==BigInt(0)||before.nlink!==BigInt(1)||before.size<BigInt(1)||before.size>BigInt(1024*1024))throw new Error('Unsafe installed dispatch source.');const buffer=Buffer.alloc(Number(before.size)+1);let count=0;while(count<buffer.length){const {bytesRead}=await handle.read(buffer,count,buffer.length-count,count);if(!bytesRead)break;count+=bytesRead;}const bytes=buffer.subarray(0,count);const after=await handle.stat({bigint:true});if(BigInt(bytes.length)!==before.size||before.ino!==after.ino||before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs)throw new Error('Installed dispatch source changed.');pins[file]=dispatchSha256(bytes);
  }finally{await handle.close();}
 }
 return pins;
}
export function supportedInternalReportRuntime(version:string){const match=version.match(/^(?:v)?(\d+)\.(\d+)\./);return Boolean(match&&(Number(match[1])===22&&Number(match[2])>=13||Number(match[1])===24));}
/** Dedicated validation happens before any application import. Default reads immediately before
 * report stage; a bad installed marker cannot restore legacy reports or interrupt other jobs. */
export async function installedReportDispatch(mode:'default'|'dedicated',env:Readonly<Record<string,string|undefined>>=process.env):Promise<'legacy'|'suppressed'|'dedicated'>{
 let bytes:Buffer;try{await lstat(INTERNAL_REPORT_DISPATCH_MARKER);bytes=await readTrustedDispatchFile(INTERNAL_REPORT_DISPATCH_MARKER,4096,0o644);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'&&mode==='default')return 'legacy';throw new Error('Installed report scheduling admission refused.');}
 if(await realpath(process.cwd())!==INTERNAL_REPORT_DISPATCH_ROOT)throw new Error('Installed report candidate differs.');
 const value=validateReportDispatchMarker(JSON.parse(bytes.toString('utf8')),{sourcePins:await readDispatchSourcePins(),instanceSha256:reportDispatchInstance(env.AUTH_PROVIDER,env.DATABASE_URL)});
 if(mode==='default')return 'suppressed';
 if(value.state!=='active'||process.getuid?.()!==value.runnerUid||process.getgid?.()!==value.runnerGid||process.getgroups?.().some(gid=>gid!==value.runnerGid)||userInfo().username!==value.runnerUser||!supportedInternalReportRuntime(process.version)||await realpath(process.execPath)!==INTERNAL_REPORT_DISPATCH_RUNTIME)throw new Error('Dedicated report tick is not active on its reviewed runtime.');
 const cron=await readTrustedDispatchFile(INTERNAL_REPORT_DISPATCH_CRON,4096,0o644);if(cron.toString('utf8')!==INTERNAL_REPORT_DISPATCH_CRON_SOURCE)throw new Error('Dedicated report cron differs from planned source.');
 // Runtime bytes are root-owned/no-writable, checked without loading an unbounded executable Buffer.
 await assertDispatchRootParents(INTERNAL_REPORT_DISPATCH_RUNTIME);const runtime=await open(INTERNAL_REPORT_DISPATCH_RUNTIME,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const before=await runtime.stat({bigint:true});if(!before.isFile()||before.uid!==BigInt(0)||before.nlink!==BigInt(1)||(before.mode&BigInt(0o022))!==BigInt(0)||before.size<BigInt(1)||before.size>BigInt(256*1024*1024))throw new Error('Unsafe internal report runtime.');const digest=createHash('sha256'),chunk=Buffer.alloc(65536);let position=0;while(true){const {bytesRead}=await runtime.read(chunk,0,chunk.length,position);if(!bytesRead)break;position+=bytesRead;if(position>256*1024*1024)throw new Error('Runtime grew.');digest.update(chunk.subarray(0,bytesRead));}const after=await runtime.stat({bigint:true});if(BigInt(position)!==before.size||before.ino!==after.ino||before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs||digest.digest('hex')!==value.runtimeSha256)throw new Error('Internal report runtime pin changed.');
 }finally{await runtime.close();}
 return 'dedicated';
}
