/**
 * Settle the Payroll Process run groups that the worker left open (November 2026).
 *
 * NOT PART OF THE DEPLOY. Deployment applies migrations, not scripts. Running this on an installation needs its own
 * authorization, and the change is finished only when it has run and its report has been read.
 *
 * REPORT-ONLY BY DEFAULT: it lists every open run group whose jobs have all finished and writes nothing. `--apply`
 * settles them through the same code path as the worker (core/payroll-run-group-store.ts settleRunGroupsForJob),
 * one transaction per job on the queue-owner connection, exactly as the store documents for "a repair".
 *
 *   cd /opt/ai-hr && set -a && . <the worker's environment file> && set +a \
 *     && node --import tsx scripts/repair-payroll-run-group-settlement.ts
 *   …same, with --apply, to write.
 *
 * Why the groups are open: settleRunGroupsForJobTx found its groups with `outcomes @> ${JSON.stringify(...)}::jsonb`
 * on the worker's plain postgres.js client, which encodes that parameter a second time into a JSON string, so no group
 * ever matched and every job's settle still recorded success. Those jobs already carry settled_at, so the fixed worker
 * never visits them again; only this repair closes their groups. The result screen did not depend on it (it derives
 * the outcome from the jobs); the group's stored result and, for a run, its `payroll-run-group.completed` audit event
 * did.
 *
 * Idempotent: a settled group is skipped under its row lock, and a second run finds nothing left.
 */
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import type postgres from 'postgres';
import {openImportWorkerOwner} from '../db/worker-connection';
import {settleRunGroupsForJob} from '../core/payroll-run-group-store';

type Open={group_id:string;tenant_id:string;created_by:string;kind:string;pay_period:string;started_at:Date;job_ids:string[];unfinished:number};
export type RunGroupRepairReport={open:number;ready:number;settled:number;withEvent:number;stillOpen:number};

/** Open, sealed groups and how many of their waited jobs (outcomes still 'processing') have not finished. */
async function openGroups(owner:postgres.Sql):Promise<Open[]>{
 return owner<Open[]>`
  select g.id as group_id,g.tenant_id,g.created_by,g.kind,g.pay_period,g.started_at,
   coalesce(array_agg(j.id order by j.id) filter (where j.id is not null),'{}') as job_ids,
   count(*) filter (where j.id is null or j.state not in ('completed','failed','cancelled'))::int as unfinished
  from payroll_run_group g
  cross join lateral jsonb_array_elements(g.outcomes) o(value)
  left join bulk_job j on j.id=case when o.value->>'jobId' ~ '^[0-9a-fA-F-]{36}$' then (o.value->>'jobId')::uuid end
   and j.tenant_id=g.tenant_id and j.kind='payroll_process'
  where g.ended_at is null and g.sealed_at is not null and o.value->>'status'='processing'
  group by g.id
  order by g.started_at`;
}
const isReady=(g:Open)=>g.unfinished===0&&g.job_ids.length>0;

/** Report (and with `apply`, settle) every open group whose jobs have all finished. `owner` is the worker's plain
 * queue-owner client, the same one the fixed settle runs on. */
export async function repairPayrollRunGroupSettlement(owner:postgres.Sql,{apply,log=console.log}:{apply:boolean;log?:(line:string)=>void}):Promise<RunGroupRepairReport>{
 const groups=await openGroups(owner);
 const ready=groups.filter(isReady);
 log(`${apply?'APPLY':'REPORT ONLY'}: ${groups.length} open run group(s) waiting for jobs; ${ready.length} have every job finished.`);
 for(const g of groups)log(`  ${g.group_id} ${g.kind} ${g.pay_period} started ${new Date(g.started_at).toISOString()} jobs ${g.job_ids.length} unfinished ${g.unfinished}`);
 if(!apply){log('Nothing written. Re-run with --apply to settle the ready groups.');return{open:groups.length,ready:ready.length,settled:0,withEvent:0,stillOpen:ready.length};}
 const jobs=new Map<string,{id:string;tenant_id:string;created_by:string}>();
 for(const g of ready)for(const id of g.job_ids)jobs.set(id,{id,tenant_id:g.tenant_id,created_by:g.created_by});
 for(const job of jobs.values()){
  const reserved=await owner.reserve();
  try{await settleRunGroupsForJob(reserved,job);}finally{reserved.release();}
 }
 const readyIds=ready.map(g=>g.group_id);
 const [after]=await owner<{settled:number;with_event:number}[]>`select count(*) filter (where ended_at is not null)::int as settled,
  count(*) filter (where event_id is not null)::int as with_event from payroll_run_group where id=any(${readyIds}::uuid[])`;
 const report={open:groups.length,ready:ready.length,settled:after.settled,withEvent:after.with_event,stillOpen:ready.length-after.settled};
 log(`Settled ${report.settled} of ${report.ready} ready group(s); ${report.withEvent} carry an audit event (runs only, not resumes); ${report.stillOpen} still open.`);
 return report;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const url=process.env.MIGRATION_DATABASE_URL;
 if(!url)throw new Error('MIGRATION_DATABASE_URL is required (the worker queue-owner connection).');
 const owner=openImportWorkerOwner(url);
 repairPayrollRunGroupSettlement(owner,{apply:process.argv.includes('--apply')})
  .then(report=>{if(report.stillOpen&&process.argv.includes('--apply'))process.exitCode=1;})
  .catch(error=>{console.error(error);process.exitCode=1;})
  .finally(()=>owner.end({timeout:5}));
}
