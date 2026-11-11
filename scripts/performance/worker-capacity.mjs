/** Advisory arithmetic over read-only resource evidence. Never changes configuration or starts workers. */
import {readFileSync,statSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const MiB=1024**2;
function number(value,name,min=0){
 if(typeof value!=='number'||!Number.isFinite(value)||value<min)throw Error('Invalid '+name);
 return value;
}
function integer(value,name,min=0){number(value,name,min);if(!Number.isSafeInteger(value))throw Error('Invalid '+name);return value;}
function bytes(value,name){
 if(value===undefined||value===null||value==='max'||value==='infinity')return Infinity;
 if(typeof value==='string'&&/^[0-9]+$/.test(value)&&Number.isSafeInteger(Number(value)))return Number(value);
 throw Error('Invalid '+name);
}
function cpuQuota(value){
 if(value===undefined||value===null||value==='infinity')return Infinity;
 if(/^[0-9]+$/.test(value))return Number(value)/1e6;
 const seconds=/^([0-9]+(?:\.[0-9]+)?)s$/.exec(value);
 if(seconds)return Number(seconds[1]);
 throw Error('Invalid service CPU quota');
}
function cgroupCpu(value){
 if(value===undefined||value===null)return Infinity;
 const match=/^(max|[0-9]+) ([1-9][0-9]*)$/.exec(value);
 if(!match)throw Error('Invalid cgroup CPU quota');
 return match[1]==='max'?Infinity:Number(match[1])/Number(match[2]);
}

export function estimateWorkerCapacity({app,postgresMaxConnections,totalWebConnections,nonWebConnectionReserve,
 minimumPoolPerWorker,workerRssMiB,rssBasis,reservedCpus,hostReserveMiB,serviceReserveMiB,headroomPercent}){
 integer(postgresMaxConnections,'PostgreSQL connection ceiling',1);integer(totalWebConnections,'web connection budget',1);
 integer(nonWebConnectionReserve,'non-web/reserved connection budget',1);integer(minimumPoolPerWorker,'minimum per-worker pool',1);
 number(workerRssMiB,'whole-process RSS budget',1);number(reservedCpus,'CPU reservation');
 number(hostReserveMiB,'host memory reservation');number(serviceReserveMiB,'service overhead');
 number(headroomPercent,'memory headroom');if(headroomPercent>=100)throw Error('Invalid memory headroom');
 if(!['assumed','measured'].includes(rssBasis))throw Error('RSS basis must be explicit');
 if(totalWebConnections+nonWebConnectionReserve>postgresMaxConnections)throw Error('Web pools exceed the reserved PostgreSQL budget');
 const memory=/^([0-9]+) kB$/.exec(app.memory?.MemTotal??'');
 if(!memory)throw Error('Missing physical memory evidence');
 const hostMiB=Number(memory[1])/1024;
 const cpu=Math.min(number(app.cpus,'CPU evidence',1),number(app.affinityCpus,'affinity evidence',1),
  app.processAffinityCpus===undefined?Infinity:number(app.processAffinityCpus,'process affinity',1),
  cpuQuota(app.service?.CPUQuotaPerSecUSec),cgroupCpu(app.cgroup?.['cpu.max']),
  ...(app.ancestorLimits??[]).map(limit=>cgroupCpu(limit['cpu.max'])));
 const hardMiB=Math.max(0,Math.min(hostMiB-hostReserveMiB,bytes(app.service?.MemoryMax,'service memory maximum')/MiB,
  bytes(app.cgroup?.['memory.max'],'cgroup memory maximum')/MiB,
  ...(app.ancestorLimits??[]).map(limit=>bytes(limit['memory.max'],'ancestor memory maximum')/MiB)));
 // MemoryHigh is a pressure/throttling boundary, not an OOM limit. This planning
 // policy stays below it rather than presenting all physical RAM as available.
 const operatingMiB=Math.min(hardMiB,bytes(app.service?.MemoryHigh,'service memory high')/MiB,
  bytes(app.cgroup?.['memory.high'],'cgroup memory high')/MiB,
  ...(app.ancestorLimits??[]).map(limit=>bytes(limit['memory.high'],'ancestor memory high')/MiB));
 const usableMiB=Math.max(0,operatingMiB-serviceReserveMiB)*(1-headroomPercent/100);
 const limits={cpuStartingWorkers:Math.max(0,Math.floor(cpu-reservedCpus)),
  memoryBudgetWorkers:Math.max(0,Math.floor(usableMiB/workerRssMiB)),
  databasePoolWorkers:Math.floor(totalWebConnections/minimumPoolPerWorker)};
 const planningCeiling=Math.min(...Object.values(limits),64);
 const choices=[1,2,4,6,8,12,16,24,32,48,64].filter(count=>count<=planningCeiling);
 const suggestedStartingWorkers=choices.at(-1)??0;
 return {kind:'APPLICATION_WORKER_CAPACITY_ADVISORY',releaseEligible:false,configurationChanged:false,
  effectiveCpus:cpu,physicalMemoryMiB:hostMiB,serviceHardMemoryMiB:hardMiB,operatingMemoryMiB:operatingMiB,
  usableWorkerMemoryMiB:usableMiB,limits,planningCeiling,suggestedStartingWorkers,
  plannedPoolMax:suggestedStartingWorkers?Math.floor(totalWebConnections/suggestedStartingWorkers):0,
  assumptions:{workerRssMiB,rssBasis,reservedCpus,hostReserveMiB,serviceReserveMiB,headroomPercent,totalWebConnections,
   nonWebConnectionReserve,minimumPoolPerWorker,ancestorLimitsVerified:Array.isArray(app.ancestorLimits)&&app.ancestorLimits.length>0},
  qualification:'Starting configuration only. Real peak RSS, cold starts, latency, database contention and sustained workload outcomes must pass before activation.'};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const keys=new Set(['app-resources','postgres-max-connections','web-connections','nonweb-reserve','min-pool','rss-budget-mib','rss-basis','reserve-cpus','host-reserve-mib','service-reserve-mib','headroom-percent']);
 const values=new Map();
 for(let i=2;i<process.argv.length;i+=2){
  if(!process.argv[i].startsWith('--'))throw Error('Named capacity arguments required');
  const key=process.argv[i]?.replace(/^--/,''),value=process.argv[i+1];
  if(!keys.has(key)||values.has(key)||value===undefined)throw Error('Explicit unique capacity arguments required');values.set(key,value);
 }
 if(values.size!==keys.size)throw Error('All capacity assumptions must be provided');
 const path=values.get('app-resources');if(statSync(path).size>1024**2)throw Error('Resource evidence exceeds bound');
 const app=JSON.parse(readFileSync(path,'utf8'));
 const numeric=key=>{const raw=values.get(key);if(!/^[0-9]+(?:\.[0-9]+)?$/.test(raw))throw Error('Invalid '+key);return Number(raw);};
 const report=estimateWorkerCapacity({app,postgresMaxConnections:numeric('postgres-max-connections'),totalWebConnections:numeric('web-connections'),
  nonWebConnectionReserve:numeric('nonweb-reserve'),minimumPoolPerWorker:numeric('min-pool'),workerRssMiB:numeric('rss-budget-mib'),
  rssBasis:values.get('rss-basis'),reservedCpus:numeric('reserve-cpus'),hostReserveMiB:numeric('host-reserve-mib'),
  serviceReserveMiB:numeric('service-reserve-mib'),headroomPercent:numeric('headroom-percent')});
 process.stdout.write(JSON.stringify(report,null,2)+'\n');
}
