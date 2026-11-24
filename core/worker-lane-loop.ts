/** One pass of the background worker loop (scripts/bank-import-runner.ts), for one process serving `lanes`
 * (core/bulk-job-lanes.ts, ADR 0181 J1). The singleton ticks run only where the default lane is served; the bulk-job
 * tick claims only this process's kinds and advertises its lane markers. The ticks are passed in, so the kernel test
 * can run several lane processes over one queue with the real claim and count every singleton tick. */
import type postgres from 'postgres';
import type {createDb} from '../db/client';
import {lanesRunSingletonTicks,type WorkerLane} from './bulk-job-lanes';
import {runBulkJobTick,type BulkJobWorkerOptions} from './bulk-job-worker';

export type WorkerSingletonTicks={
 bank(owner:postgres.Sql):Promise<boolean>;
 individual(owner:postgres.Sql):Promise<boolean>;
 rewardPlans(owner:postgres.Sql):Promise<boolean>;
 probation(owner:postgres.Sql,probationOwner:ReturnType<typeof createDb>):Promise<boolean>;
};
export type WorkerLaneProcess={
 owner:postgres.Sql;
 /** The default lane's probation owner pool; null in a dedicated lane process, which never opens it. */
 probationOwner:ReturnType<typeof createDb>|null;
 lanes:readonly WorkerLane[];
 handlers:BulkJobWorkerOptions['handlers'];
 workerId?:string;
 ticks:WorkerSingletonTicks;
 /** The stall watchdog's phase marker (lib/import-worker-watchdog.ts). */
 enter?(phase:string):void;
};
export type WorkerLaneIteration={bank:boolean;individual:boolean;bulk:boolean;rewardPlans:boolean;probation:boolean};

export async function runWorkerLaneIteration(p:WorkerLaneProcess):Promise<WorkerLaneIteration>{
 const enter=p.enter??(()=>undefined);
 const singletons=lanesRunSingletonTicks(p.lanes)&&p.probationOwner!==null;
 const out:WorkerLaneIteration={bank:false,individual:false,bulk:false,rewardPlans:false,probation:false};
 if(singletons){
  enter('bank');out.bank=await p.ticks.bank(p.owner);
  enter('individual');out.individual=await p.ticks.individual(p.owner);
 }
 enter('bulk');out.bulk=await runBulkJobTick(p.owner,{handlers:p.handlers,lanes:p.lanes,workerId:p.workerId});
 if(singletons){
  enter('reward-plan-companies');out.rewardPlans=await p.ticks.rewardPlans(p.owner);
  enter('probation-personnel');out.probation=await p.ticks.probation(p.owner,p.probationOwner!);
 }
 return out;
}
