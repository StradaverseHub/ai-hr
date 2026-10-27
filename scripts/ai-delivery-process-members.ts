/** Import-safe process ownership inspection. No signaling, resources, database or service effects. */
import {spawnSync} from 'node:child_process';
const refused=():never=>{throw Error('Owned process group inspection could not be confirmed.');};
export type AiDeliveryProcessScan=Readonly<{pid?:number;status:number|null;signal:string|null;error?:unknown;stdout:unknown}>;
/** Exclude exactly the actual inspector, never a command name or all short-lived processes. */
export function parseAiDeliveryProcessMembers(scan:AiDeliveryProcessScan,workerPid:number):number[]{
 if(!Number.isSafeInteger(workerPid)||workerPid<=1||typeof scan.pid!=='number'||!Number.isSafeInteger(scan.pid)||scan.pid<=1||scan.pid===workerPid||scan.error||scan.status!==0||scan.signal!==null||typeof scan.stdout!=='string'||!scan.stdout.trim())return refused();
 const rows=new Map<number,{group:number;state:string}>();
 for(const line of scan.stdout.trim().split('\n')){
  const match=/^\s*(\d+)\s+(\d+)\s+([A-Za-z+<>-]+)\s*$/.exec(line);if(!match)return refused();
  const pid=Number(match[1]),group=Number(match[2]);if(!Number.isSafeInteger(pid)||!Number.isSafeInteger(group)||rows.has(pid))return refused();
  rows.set(pid,{group,state:match[3]});
 }
 if(rows.get(workerPid)?.group!==workerPid||rows.get(scan.pid!)?.group!==workerPid)return refused();
 return [...rows].filter(([pid,row])=>row.group===workerPid&&pid!==workerPid&&pid!==scan.pid&&!row.state.startsWith('Z')).map(([pid])=>pid).sort((a,b)=>a-b);
}
export function ownedAiDeliveryProcessMembers(workerPid:number):number[]{
 const scan=spawnSync('ps',['-Ao','pid=,pgid=,stat='],{encoding:'utf8',timeout:5000,maxBuffer:8*1024*1024});
 return parseAiDeliveryProcessMembers(scan,workerPid);
}
