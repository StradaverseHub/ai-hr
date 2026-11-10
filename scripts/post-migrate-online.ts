/**
 * Online work that must not run inside the single Drizzle migration transaction. Migrations record
 * what they could not do on a populated table; deploy/deploy.sh runs this immediately after
 * `pnpm db:migrate`, before the service restart, as the migration owner:
 *
 *   node --env-file=.env.production --import tsx scripts/post-migrate-online.ts
 *
 * It is idempotent and resumable: re-run it after any failure. The previous build keeps serving
 * throughout, so a failure stops the release before activation without leaving the app down.
 *
 *  1. Builds every index recorded in app.online_deferred_index with CREATE INDEX CONCURRENTLY,
 *     replacing any INVALID leftover from an interrupted build.
 *  2. Writes notification_event_processing receipts for existing domain_event history in small
 *     physical-range transactions (app.notification_receipt_backfill_batch), then proves nothing was missed.
 */
import postgres from 'postgres';

const pageRange=Number(process.env.AIHR_ONLINE_BACKFILL_PAGES??150);
const pauseMs=Number(process.env.AIHR_ONLINE_BACKFILL_PAUSE_MS??10);
const RETRYABLE=new Set(['55P03','57014','40001','40P01']);
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const log=(message:string)=>console.log(`[post-migrate-online] ${message}`);

async function withRetry<T>(label:string,run:()=>Promise<T>,attempts=8):Promise<T>{
 for(let attempt=1;;attempt++){
  try{return await run();}
  catch(error){
   const code=(error as {code?:string}).code;
   if(!code||!RETRYABLE.has(code)||attempt>=attempts)throw error;
   log(`${label}: ${code}, retry ${attempt}/${attempts-1}`);
   await sleep(Math.min(200*2**attempt,10000));
  }
 }
}

async function buildDeferredIndexes(sql:postgres.Sql){
 const pending=await sql<{index_name:string;table_name:string;definition:string;analyze_after:boolean}[]>`
  select index_name,table_name::text as table_name,definition,analyze_after from app.online_deferred_index where built_at is null order by index_name`;
 log(`${pending.length} deferred index(es) to build`);
 // A CONCURRENTLY build never blocks reads or writes, so it may wait for older transactions.
 await sql.unsafe(`SET lock_timeout=0`);await sql.unsafe(`SET statement_timeout='2h'`);
 for(const row of pending){
  const started=Date.now();
  const [leftover]=await sql<{schema:string;valid:boolean}[]>`
   select n.nspname as schema,i.indisvalid as valid from pg_index i join pg_class c on c.oid=i.indexrelid join pg_namespace n on n.oid=c.relnamespace
   where c.relname=${row.index_name} and i.indrelid=${row.table_name}::regclass`;
  if(leftover&&!leftover.valid){
   log(`${row.index_name}: dropping INVALID leftover`);
   await sql.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS ${quoted(leftover.schema,row.index_name)}`);
  }
  await sql.unsafe(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${quoteIdent(row.index_name)} ${row.definition}`);
  if(row.analyze_after)await sql.unsafe(`ANALYZE ${row.table_name}`);
  await sql`update app.online_deferred_index set built_at=now() where index_name=${row.index_name}`;
  log(`${row.index_name}: built in ${Date.now()-started} ms`);
 }
}

function quoteIdent(value:string){return `"${value.replace(/"/g,'""')}"`;}
function quoted(schema:string,name:string){return `${quoteIdent(schema)}.${quoteIdent(name)}`;}

async function backfillReceipts(sql:postgres.Sql){
 const [step]=await sql<{completed_at:Date|null}[]>`select completed_at from app.online_migration_step where step='notification-receipts'`;
 if(!step)throw new Error('notification-receipts step missing; run db:migrate first');
 if(!step.completed_at){
  await sql.unsafe(`SET lock_timeout='5s'`);await sql.unsafe(`SET statement_timeout='60s'`);
  let scanned=0,inserted=0,pages=0,maxPageMs=0;const started=Date.now();
  for(;;){
   const pageStart=Date.now();
   const [page]=await withRetry('receipt page',()=>sql<{scanned:number;inserted:number;done:boolean}[]>`select * from app.notification_receipt_backfill_batch(${pageRange})`);
   maxPageMs=Math.max(maxPageMs,Date.now()-pageStart);
   scanned+=page.scanned;inserted+=page.inserted;pages++;
   if(pages%100===0)log(`receipts: ${scanned} events scanned, ${inserted} receipts written`);
   if(page.done)break;
   if(pauseMs>0)await sleep(pauseMs);
  }
  log(`receipts: done. ${scanned} events scanned, ${inserted} receipts written in ${pages} pages, ${Date.now()-started} ms (slowest page ${maxPageMs} ms)`);
 }else log('receipts: already complete');
 await sql.unsafe(`SET statement_timeout=0`);
 const [missing]=await sql<{notifications:number;assessment:number}[]>`
  select
   (select count(*)::int from domain_event e where not exists(select 1 from notification_event_processing r where r.event_id=e.id and r.consumer='notifications')) as notifications,
   (select count(*)::int from domain_event e where e.event_type='assessment.reminder-queued'
     and not exists(select 1 from notification_event_processing r where r.event_id=e.id and r.consumer='assessment-reminders')) as assessment`;
 if(missing.notifications||missing.assessment)throw new Error(`Receipt backfill incomplete: ${missing.notifications} notifications, ${missing.assessment} assessment reminders missing`);
 log('receipts: every event has its processing receipts');
}

async function main(){
 const url=process.env.MIGRATION_DATABASE_URL;
 if(!url)throw new Error('MIGRATION_DATABASE_URL is not set');
 const sql=postgres(url,{max:1,onnotice:()=>{},idle_timeout:0});
 try{await buildDeferredIndexes(sql);await backfillReceipts(sql);}
 finally{await sql.end({timeout:5});}
}

main().catch(error=>{console.error('[post-migrate-online] FAILED:',error instanceof Error?error.message:error);process.exitCode=1;});
