/** Short-lived server-only report output, scoped to exact actor/definition/scope and freshly authorised
 * on reuse. Losing a process or expiring a token asks for a new preview; it never fabricates continuity.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { SessionContext } from '../db/client';
import { authorizeEmployeeMasterRun, type MasterRun } from './employee-master-reports';
import { MasterReportAccessError } from './employee-master-access';
const snapshots=new Map<string,{actor:string;scope:string;expires:number;bytes:number;run:MasterRun}>();
const TTL=120_000,MAX_BYTES=32_000_000,MAX_ENTRIES=8;
const actor=(ctx:SessionContext)=>ctx.tenantId+':'+ctx.userId;
const scope=(ids:readonly string[])=>[...ids].sort().join(',');
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([,entry])=>entry!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([key,entry])=>[key,canonical(entry)])):value;
export const masterDefinitionDigest=(value:unknown)=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export function rememberMasterSnapshot(ctx:SessionContext,scopeIds:readonly string[],run:MasterRun):string|null{
 const now=Date.now();for(const [key,entry]of snapshots)if(entry.expires<=now)snapshots.delete(key);
 const bytes=Buffer.byteLength(JSON.stringify(run));if(bytes>MAX_BYTES)return null;
 while(snapshots.size>=MAX_ENTRIES||[...snapshots.values()].reduce((sum,item)=>sum+item.bytes,0)+bytes>MAX_BYTES){const key=snapshots.keys().next().value;if(!key)break;snapshots.delete(key);}
 const token=randomUUID();snapshots.set(token,{actor:actor(ctx),scope:scope(scopeIds),expires:now+TTL,bytes,run});return token;
}
export async function employeeMasterSnapshot(ctx:SessionContext,scopeIds:readonly string[],token:string,expected:{id?:string;spec?:unknown}):Promise<MasterRun>{
 const entry=snapshots.get(token);if(!entry||entry.expires<=Date.now()||entry.actor!==actor(ctx)||entry.scope!==scope(scopeIds))throw new MasterReportAccessError();
 if((expected.id??null)!==entry.run.reportId||expected.spec&&masterDefinitionDigest(expected.spec)!==masterDefinitionDigest(entry.run.spec))throw new MasterReportAccessError();
 await authorizeEmployeeMasterRun(ctx,scopeIds,entry.run);return entry.run;
}
