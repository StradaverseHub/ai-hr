/** Import-safe Linux lifecycle proof helpers. No processes, filesystem, timers or DB at import. */
import {internalReportDispatchMarker,type InternalReportDispatchMarker} from '../lib/employee-master-dispatch';
export type AcceptanceProcessPin={pid:number;startTicks:string};
export type AcceptanceProcessStat=AcceptanceProcessPin&{group:number;session:number};
export function acceptanceProcessStat(text:string):AcceptanceProcessStat{
 const end=text.lastIndexOf(') '),pid=Number(text.slice(0,text.indexOf(' '))),parts=text.slice(end+2).trim().split(/\s+/);
 if(end<0||!Number.isSafeInteger(pid)||pid<1||!/^\d+$/.test(parts[19]??'')||!/^\d+$/.test(parts[2]??'')||!/^\d+$/.test(parts[3]??''))throw new Error('Unknown owned child identity.');
 return {pid,startTicks:parts[19],group:Number(parts[2]),session:Number(parts[3])};
}
export function captureAcceptanceGroup(text:string,pid:number):AcceptanceProcessPin{
 const stat=acceptanceProcessStat(text);if(pid<2||stat.pid!==pid||stat.group!==pid||stat.session!==pid)throw new Error('Child is not its detached group/session leader.');return {pid,startTicks:stat.startTicks};
}
export function acceptanceGroupMembers(pin:AcceptanceProcessPin,stats:readonly AcceptanceProcessStat[]):AcceptanceProcessPin[]{
 if(stats.length>10000)throw new Error('Process inventory exceeds bound.');
 const leader=stats.find(stat=>stat.pid===pin.pid);if(leader&&leader.startTicks!==pin.startTicks)throw new Error('Owned group leader identity changed.');
 return stats.filter(stat=>stat.group===pin.pid).map(stat=>{if(stat.session!==pin.pid||BigInt(stat.startTicks)<BigInt(pin.startTicks))throw new Error('Owned process group identity changed.');return {pid:stat.pid,startTicks:stat.startTicks};});
}
export type AcceptanceGroupIo={members():Promise<readonly AcceptanceProcessPin[]>;signal(signal:'SIGTERM'|'SIGKILL'):void;now():number;delay(ms:number):Promise<void>};
/** Only ESRCH is a benign signal race; even then require an independent absent inventory. */
export async function stopOwnedAcceptanceGroup(io:AcceptanceGroupIo):Promise<void>{
 if(!(await io.members()).length)return;
 const signal=(value:'SIGTERM'|'SIGKILL')=>{try{io.signal(value);}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}};
 const absent=async(timeout:number)=>{const until=io.now()+timeout;while((await io.members()).length){if(io.now()>=until)return false;await io.delay(50);}return true;};
 signal('SIGTERM');if(await absent(2000))return;signal('SIGKILL');if(!await absent(5000))throw new Error('Owned child group remains after SIGKILL.');
}
export type AcceptanceActivationBinding={marker:Omit<InternalReportDispatchMarker,'state'|'installationId'>;inventorySha256:string;node20Path:string;node20Sha256:string};
/** This is ownership discovery only. The canonical rollback revalidates its full receipt and files. */
export function bindAcceptanceActivationReceipt(raw:unknown,id:string,expected:AcceptanceActivationBinding):InternalReportDispatchMarker{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('Unknown partial activation receipt.');const receipt=raw as Record<string,unknown>;
 if(JSON.stringify(Object.keys(receipt).sort())!==JSON.stringify(['version','installationId','inventorySha256','legacyUser','legacyUid','node20Sha256','node20Path','marker','beforeMarker','beforeCron'].sort())||receipt.version!==1||receipt.installationId!==id||receipt.inventorySha256!==expected.inventorySha256||receipt.legacyUser!==expected.marker.runnerUser||receipt.legacyUid!==expected.marker.runnerUid||receipt.node20Sha256!==expected.node20Sha256||receipt.node20Path!==expected.node20Path||receipt.beforeMarker!==null||receipt.beforeCron!==null)throw new Error('Partial activation receipt is not owned by this attempt.');
 const marker=internalReportDispatchMarker.parse(receipt.marker),wanted={...expected.marker,state:'paused',installationId:id};
 if(JSON.stringify(marker)!==JSON.stringify(internalReportDispatchMarker.parse(wanted)))throw new Error('Partial activation source/runtime/instance differs.');return marker;
}
export function bindAcceptanceActivationMarker(raw:unknown,receiptMarker:InternalReportDispatchMarker):InternalReportDispatchMarker{
 const current=internalReportDispatchMarker.parse(raw);if(JSON.stringify({...current,state:'paused'})!==JSON.stringify(receiptMarker))throw new Error('Partial activation marker changed.');return current;
}
