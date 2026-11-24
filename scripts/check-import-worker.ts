/** Deploy-time readiness of the protected import worker (aihr-bank-import.service): every bulk-job kind this build can
 * enqueue (bulk_job_kind) must be served by a worker whose heartbeat is current. Reads only the owner-side heartbeat table.
 * Lane coverage (ADR 0181 J1, core/bulk-job-lanes.ts): a live worker that advertises a lane marker serves that whole
 * lane, so every kind of the lane must be among its kinds (otherwise it runs an older release and admission refuses
 * the missing kind); and every dedicated lane declared in AIHR_WORKER_LANES must have a live worker.
 *   node --env-file=.env.production --import tsx scripts/check-import-worker.ts [--wait SECONDS]
 * Exit 0: ready. Exit 2: a kind or lane has no live worker (its jobs would stay queued or be refused). Exit 1: the
 * check itself failed. */
import postgres from 'postgres';
import {WORKER_LANES,isLaneKind,laneCoverageProblems,laneMarker,type WorkerLane} from '../core/bulk-job-lanes';

const waitArg=process.argv.indexOf('--wait');
const waitSeconds=waitArg>0?Math.min(Math.max(Number(process.argv[waitArg+1])||0,0),600):0;
const url=process.env.MIGRATION_DATABASE_URL;
const declared=(process.env.AIHR_WORKER_LANES??'').split(',').map(lane=>lane.trim()).filter(Boolean);

const lanesOf=(live:readonly (readonly string[])[])=>WORKER_LANES.filter((lane:WorkerLane)=>live.some(kinds=>kinds.includes(laneMarker(lane))));

async function main(){
 if(!url){console.error('Import worker check: MIGRATION_DATABASE_URL is not set.');return 1;}
 const db=postgres(url,{max:1,onnotice:()=>{},connect_timeout:10});
 try{
  const deadline=Date.now()+waitSeconds*1000;
  for(;;){
   // Every kind the installed schema knows (bulk_job_kind) must be served by a live worker.
   const rows=await db<{kind:string;beat_at:Date|null;live:boolean}[]>`select k.kind,max(w.beat_at) as beat_at,coalesce(bool_or(w.beat_at>now()-interval '90 seconds'),false) as live
    from bulk_job_kind k left join bulk_job_worker w on k.kind=any(w.kinds) group by k.kind order by k.kind`;
   const workers=await db<{kinds:string[]}[]>`select kinds from bulk_job_worker where beat_at>now()-interval '90 seconds' order by id`;
   const live=workers.map(w=>w.kinds);
   const stale=rows.filter(r=>!r.live);
   const lanes=laneCoverageProblems(rows.map(r=>r.kind),live,declared);
   if(!stale.length&&!lanes.length){
    const served=lanesOf(live);
    console.log(`Import worker ready for: ${rows.map(r=>r.kind).join(', ')}.`);
    if(served.length)console.log(`Worker lanes live: ${served.join(', ')}.`);
    const unplaced=rows.map(r=>r.kind).filter(kind=>!isLaneKind(kind));
    if(unplaced.length)console.log(`Kinds outside the lane catalogue (served by the default lane): ${unplaced.join(', ')}.`);
    return 0;
   }
   if(Date.now()>=deadline){
    for(const r of stale)console.error(`Import worker missing for "${r.kind}": ${r.beat_at?`last heartbeat ${new Date(r.beat_at).toISOString()}`:'no heartbeat recorded'}.`);
    for(const problem of lanes)console.error(problem);
    console.error('Background imports of these kinds stay queued until aihr-bank-import.service runs this release (deploy/systemd/BANK-IMPORT.md).');
    return 2;
   }
   await new Promise(resolve=>setTimeout(resolve,3000));
  }
 }finally{await db.end({timeout:5});}
}
main().then(code=>{process.exitCode=code;},()=>{console.error('Import worker check could not read the worker heartbeat. Check the database migration and credentials.');process.exitCode=1;});
