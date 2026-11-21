import {expect,it} from 'vitest';
import {estimateWorkerCapacity} from '../scripts/performance/worker-capacity.mjs';
const GiB=1024**3;
const fixture=()=>({app:{cpus:16,affinityCpus:16,memory:{MemTotal:'67108864 kB'},
 service:{CPUQuotaPerSecUSec:'infinity',MemoryHigh:String(10*GiB),MemoryMax:String(12*GiB)},
 cgroup:{'cpu.max':'max 100000','memory.high':String(10*GiB),'memory.max':String(12*GiB)}},
 postgresMaxConnections:100,totalWebConnections:16,nonWebConnectionReserve:20,minimumPoolPerWorker:2,
 workerRssMiB:1536,rssBasis:'assumed',reservedCpus:2,hostReserveMiB:4096,serviceReserveMiB:512,headroomPercent:20});

it('uses the service pressure limit and whole-process memory rather than all host RAM',()=>{
 const result=estimateWorkerCapacity(fixture());
 expect(result).toMatchObject({configurationChanged:false,releaseEligible:false,effectiveCpus:16,
  serviceHardMemoryMiB:12288,operatingMemoryMiB:10240,limits:{cpuStartingWorkers:14,memoryBudgetWorkers:5,databasePoolWorkers:8},
  planningCeiling:5,suggestedStartingWorkers:4,plannedPoolMax:4});
 expect(result.usableWorkerMemoryMiB).toBeCloseTo(7782.4);expect(result.assumptions.rssBasis).toBe('assumed');
});

it('permits more than four when explicit memory and database budgets support the CPU starting policy',()=>{
 const options=fixture();options.app.service.MemoryHigh=String(32*GiB);options.app.service.MemoryMax=String(40*GiB);
 options.app.cgroup['memory.high']=String(32*GiB);options.app.cgroup['memory.max']=String(40*GiB);options.totalWebConnections=48;
 const result=estimateWorkerCapacity(options);
 expect(result).toMatchObject({limits:{cpuStartingWorkers:14,memoryBudgetWorkers:16,databasePoolWorkers:24},planningCeiling:14,suggestedStartingWorkers:12,plannedPoolMax:4});
});

it('honours fractional quotas, process affinity and stricter ancestor limits',()=>{
 const options={...fixture(),reservedCpus:0,app:{...fixture().app,processAffinityCpus:4,
  ancestorLimits:[{'cpu.max':'150000 100000','memory.max':String(4*GiB),'memory.high':'max'}]}};
 const result=estimateWorkerCapacity(options);
 expect(result).toMatchObject({effectiveCpus:1.5,serviceHardMemoryMiB:4096,limits:{cpuStartingWorkers:1,memoryBudgetWorkers:1},suggestedStartingWorkers:1});
 expect(result.assumptions.ancestorLimitsVerified).toBe(true);
});

it('refuses oversubscribed PostgreSQL and malformed evidence without changing configuration',()=>{
 expect(()=>estimateWorkerCapacity({...fixture(),totalWebConnections:90})).toThrow(/PostgreSQL/);
 expect(()=>estimateWorkerCapacity({...fixture(),rssBasis:'unknown'})).toThrow(/RSS/);
 expect(()=>estimateWorkerCapacity({...fixture(),app:{...fixture().app,cgroup:{'cpu.max':'invalid'}}})).toThrow(/CPU/);
 expect(()=>estimateWorkerCapacity({...fixture(),headroomPercent:100})).toThrow(/headroom/);
});
