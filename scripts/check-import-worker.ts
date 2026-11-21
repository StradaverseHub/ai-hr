/** Deploy-time readiness of the protected import worker (aihr-bank-import.service): every bulk-job kind this build can
 * enqueue (bulk_job_kind) must be served by a worker whose heartbeat is current. Reads only the owner-side heartbeat table.
 *   node --env-file=.env.production --import tsx scripts/check-import-worker.ts [--wait SECONDS]
 * Exit 0: ready. Exit 2: a kind has no live worker (its jobs would stay queued). Exit 1: the check itself failed. */
import postgres from 'postgres';

const waitArg=process.argv.indexOf('--wait');
const waitSeconds=waitArg>0?Math.min(Math.max(Number(process.argv[waitArg+1])||0,0),600):0;
const url=process.env.MIGRATION_DATABASE_URL;
async function main(){
 if(!url){console.error('Import worker check: MIGRATION_DATABASE_URL is not set.');return 1;}
 const db=postgres(url,{max:1,onnotice:()=>{},connect_timeout:10});
 try{
  const deadline=Date.now()+waitSeconds*1000;
  for(;;){
   // Every kind the installed schema knows (bulk_job_kind) must be served by a live worker.
   const rows=await db<{kind:string;beat_at:Date|null;live:boolean}[]>`select k.kind,max(w.beat_at) as beat_at,coalesce(bool_or(w.beat_at>now()-interval '90 seconds'),false) as live
    from bulk_job_kind k left join bulk_job_worker w on k.kind=any(w.kinds) group by k.kind order by k.kind`;
   const stale=rows.filter(r=>!r.live);
   if(!stale.length){console.log(`Import worker ready for: ${rows.map(r=>r.kind).join(', ')}.`);return 0;}
   if(Date.now()>=deadline){
    for(const r of stale)console.error(`Import worker missing for "${r.kind}": ${r.beat_at?`last heartbeat ${new Date(r.beat_at).toISOString()}`:'no heartbeat recorded'}.`);
    console.error('Background imports of these kinds stay queued until aihr-bank-import.service runs this release (deploy/systemd/BANK-IMPORT.md).');
    return 2;
   }
   await new Promise(resolve=>setTimeout(resolve,3000));
  }
 }finally{await db.end({timeout:5});}
}
main().then(code=>{process.exitCode=code;},()=>{console.error('Import worker check could not read the worker heartbeat. Check the database migration and credentials.');process.exitCode=1;});
