/**
 * The movement import Revert (ADR-0155) as a background job on the shared bulk-job kernel (draft 9913,
 * docs/adr/2026-11-10-movement-import-job.md). All or nothing, with the same refusals, rows, audit events and Import
 * History event as the synchronous revert (revertImport with movementRevertHandler), which stays the fallback.
 *
 * - **Review**, once, on a read-only snapshot with no lock (planImportRevert): blockers and the reviewed hash.
 * - **Plan**, one employee per step, in a savepoint of its chunk that always rolls back: the very compensation the
 *   synchronous revert applies (applyMovementRevertTx, the Movement owner's rollback), for that employee's items with
 *   the revert's reason, under the revert's own locks. What it wrote is captured: the before-image and after-image of
 *   every row of the employee's own movement records it changed (employment, assignment, compensation, reporting lines
 *   as subordinate), the audit events it appended in order, and the database's own
 *   per-table write counts. Anything it wrote outside those rows, or any write it cannot account for, marks the revert
 *   for the fallback. Nothing is visible.
 * - **Release**, one short transaction under the same locks: the attempt, its items and confirmation unchanged; the
 *   initiator's authority, principal and maintain access per employment; the same day; and every planned employee's
 *   records exactly as the plan saw them (row digests, ledger position, payroll closure). Then the captured writes are
 *   applied set-based (each table's updates and inserts in single statements, the events in the rollback's order), the
 *   result is compared with the plan's after-images and write counts, and the Import History event is written.
 * - **Fallback**: if any check fails or any image differs, the release rolls back whole and the synchronous revert runs
 *   instead, exactly as before. The outcome is never partial and never differs.
 */
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {BULK_JOB_ALREADY_RUNNING,BulkJobError,bulkJobTx,enqueueBulkJobTx,listBulkJobsTx,type BulkJobRow} from './bulk-job';
import {isTransientBulkJobError,type BulkJobHandler,type BulkJobUnit} from './bulk-job-worker';
import {lockAccessConfigurationWriteTx} from './access-configuration-lock';
import {ImportHistoryError,importAttemptEventsTx,importAttemptItemsTx,lockImportAttemptTx,planImportRevert,recordImportEventTx,recordImportFailure,revertImport,type ImportAttemptItemRow,type ImportRevertBlocker} from './import-history';
import {applyMovementRevertTx,movementRevertEmployments,movementRevertHandler,movementRevertReviewWritesTx} from './movement-import-history';
import {lockLeaveDependencyConfigurationTx} from './leave-dependency-lock';
import {workforceEmploymentSetPredicate} from './workforce-access';
import {normalizeImportRevertReason} from '../lib/import-history';
import {todayInKualaLumpur} from '../lib/hr-date';
import {publicErrorMessage} from '../lib/public-error';
import type {ImportRevertJobProgress} from '../lib/import-revert-job';

export const MOVEMENT_REVERT_KIND='movement_import_revert';
type RevertInput={attemptId:string;previewHash:string;reason:string};
type Row=Record<string,unknown>;
/** One row write of the rehearsed compensation, in its order (draft 9914): the row's images before and after it. */
type RowWrite={table:string;op:'INSERT'|'UPDATE'|'DELETE';id:string;old:Row|null;new:Row|null};
/** What one employee's rehearsed compensation wrote, and what the release must find unchanged. */
export type MovementRevertCapture={employmentId:string;day:string;
 /** Per scoped table: the digest of the employee's rows before the compensation (the release's fence). */
 digests:Record<string,string>;marker:string;payroll:string;
 writes:RowWrite[];events:Row[];
 /** The database's own write counts during the compensation, per table. */
 counts:Record<string,[number,number,number]>;
 /** The plan transaction's start and the end of the compensation: timestamps the rollback wrote between them are the
  * moment of the revert and are stamped with the release's time. */
 window:[string,string];
 /** The company each employment returns to, when the compensation moves it (the release re-asks is_admin_for). */
 companies:string[]};
type StepResult={capture?:MovementRevertCapture;fallback?:string};
type RevertPlan={attemptId:string;confirmedEventId?:string;itemIds?:string[];detail?:Record<string,unknown>;
 /** Why the synchronous revert decides this one (set at prepare or by a step); absent means the release may run. */
 fallback?:string;
 /** Set in the release's own transaction, so a repeated finalize never writes twice. */
 released?:{restored:number;path:'release'|'reference'}};
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const inputOf=(job:BulkJobRow)=>job.input as RevertInput;
const planOf=(job:BulkJobRow)=>(job.plan??{}) as RevertPlan;
const BLOCKED='This import cannot be reverted because some records changed after it.';
const REFUSALS={changed:'What this revert would restore has changed. Review it again before confirming.',maintain:'Reverting this import needs maintain permission for every company in it.',access:'Access changed. Sign in again before continuing.'};
const INTERNAL_FAILURE='movement-import-revert-failed';
const blockersOf=(job:BulkJobRow):ImportRevertBlocker[]=>(job.errors??[]).map(e=>({itemId:'',label:e.ref,reason:e.message}));
const toErrors=(blockers:ImportRevertBlocker[])=>blockers.slice(0,2000).map(b=>({rowNum:0,ref:b.label,message:b.reason}));

/** The employee's own movement records a rollback writes, by table, and the column naming the employee. Reporting
 * lines are the employee's own (as subordinate); a rollback that reaches any other row falls back. An organisation
 * classification (written only by its definer, for a tenant with a published group structure) is not replayed: such a
 * rollback falls back too. */
const SCOPED:readonly {table:string;by:string}[]=[
 {table:'employment',by:'id'},{table:'assignment',by:'employment_id'},{table:'compensation',by:'employment_id'},
 {table:'reporting_line',by:'subordinate_employment_id'},
];
/** Tables only the database's own triggers write when the captured rows are written again (the audit chain's pending
 * rows, notification processing, the Access revision, tenant epochs and the replacement-holiday queue): their writes
 * are not replayed, only counted. */
const TRIGGER_MAINTAINED=new Set(['domain_event_chain_pending','notification_event_processing','access_configuration','company_organisation_source_epoch','performance_assessment_reminder_epoch','reward_access_source_epoch','system_label_criteria_epoch','replacement_holiday_queue']);
/** Columns the database assigns to an appended event (sequence, chain, time): never copied. */
const EVENT_ASSIGNED=new Set(['sequence','chain_seq','prev_hash','hash','occurred_at']);
/** True for a row this transaction (or one of its savepoints) wrote: its creating transaction id lies at or above this
 * transaction's own (subtransactions are numbered after it) and is still in progress. A visible row from another
 * transaction is committed; only ours is in progress. Ids are compared within a bounded window above ours, so the
 * status function is never asked about an id outside its range (an error would only send the revert to the
 * synchronous fallback). */
const OURS=(alias:string)=>sql.raw(`(case when ((pg_current_xact_id()::text::bigint>>32<<32)|${alias}.xmin::text::bigint) between pg_current_xact_id()::text::bigint and pg_current_xact_id()::text::bigint+1000000 then pg_xact_status((((pg_current_xact_id()::text::bigint>>32<<32)|${alias}.xmin::text::bigint))::text::xid8)='in progress' else false end)`);
const ident=(name:string)=>{if(!/^[a-z_]+$/.test(name))throw new Error('Unexpected identifier.');return sql.raw(name);};

async function digestsTx(tx:Tx,tenantId:string,employmentIds:string[]){
 const out:Record<string,Record<string,string>>={};
 for(const {table,by} of SCOPED){
  const rows=await tx.execute<{e:string;d:string}>(sql`select t.${ident(by)}::text as e,md5(string_agg(to_jsonb(t)::text,',' order by t.id)) as d from ${ident(table)} t where t.tenant_id=${tenantId}::uuid and t.${ident(by)}=any(${pgUuids(employmentIds)}) group by 1`);
  for(const r of rows)(out[r.e]??={})[table]=r.d;
 }
 return out;
}
async function markersTx(tx:Tx,tenantId:string,employmentIds:string[]){
 const rows=await tx.execute<{e:string;m:string}>(sql`select subject_employment_id::text e,coalesce(max(sequence),0)::text m from domain_event where tenant_id=${tenantId}::uuid and subject_employment_id=any(${pgUuids(employmentIds)}) group by 1`);
 return Object.fromEntries(rows.map(r=>[r.e,r.m])) as Record<string,string>;
}
/** The closed-payroll facts the rollback's guard reads: the employee's payslips and their batches. */
async function payrollTx(tx:Tx,tenantId:string,employmentIds:string[]){
 const rows=await tx.execute<{e:string;d:string}>(sql`select p.employment_id::text e,md5(string_agg(p.id::text||':'||b.id::text||':'||coalesce(b.status::text,'')||':'||coalesce(b.pay_period::text,''),',' order by p.id)) d from payslip p join payroll_batch b on b.id=p.batch_id where p.tenant_id=${tenantId}::uuid and p.employment_id=any(${pgUuids(employmentIds)}) group by 1`);
 return Object.fromEntries(rows.map(r=>[r.e,r.d])) as Record<string,string>;
}
const pgUuids=(ids:readonly string[])=>ids.length?sql`ARRAY[${sql.join(ids.map(id=>sql`${id}`),sql`, `)}]::uuid[]`:sql`'{}'::uuid[]`;
async function countsTx(tx:Tx){
 const rows=await tx.execute<{t:string;i:string;u:string;d:string}>(sql`select relname t,n_tup_ins::text i,n_tup_upd::text u,n_tup_del::text d from pg_stat_xact_user_tables where schemaname='public' and n_tup_ins+n_tup_upd+n_tup_del>0`);
 return Object.fromEntries(rows.map(r=>[r.t,[Number(r.i),Number(r.u),Number(r.d)]])) as Record<string,[number,number,number]>;
}
const delta=(after:Record<string,[number,number,number]>,before:Record<string,[number,number,number]>)=>{
 const out:Record<string,[number,number,number]>={};
 for(const [t,[i,u,d]] of Object.entries(after)){const b=before[t]??[0,0,0];const x:[number,number,number]=[i-b[0],u-b[1],d-b[2]];if(x.some(n=>n))out[t]=x;}
 return out;
};
class Captured extends Error{constructor(readonly capture:MovementRevertCapture|{fallback:string}){super('movement_revert_capture');}}
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);

/** One employee's compensation, rehearsed and captured (see the header). The caller's savepoint is left unchanged. */
export async function captureMovementRevertTx(tx:Tx,ctx:SessionContext,employmentId:string,items:ImportAttemptItemRow[],reason:string):Promise<StepResult>{
 const tenantId=ctx.tenantId,day=todayInKualaLumpur();
 const digests=(await digestsTx(tx,tenantId,[employmentId]))[employmentId]??{};
 const marker=(await markersTx(tx,tenantId,[employmentId]))[employmentId]??'0';
 const payroll=(await payrollTx(tx,tenantId,[employmentId]))[employmentId]??'';
 const [{start}]=await tx.execute<{start:string}>(sql`select to_jsonb(now())#>>'{}' as start`);
 const before=await countsTx(tx);
 try{
  await tx.transaction(async rehearsal=>{
   // Every row write of the movement-record tables is recorded, in order, inside this savepoint (draft 9914).
   await rehearsal.execute(sql`select set_config('app.movement_revert_capture','on',true)`);
   await applyMovementRevertTx(rehearsal,ctx,items,reason);
   await rehearsal.execute(sql`select set_config('app.movement_revert_capture','off',true)`);
   const counts=delta(await countsTx(rehearsal),before);
   const [{end}]=await rehearsal.execute<{end:string}>(sql`select to_jsonb(clock_timestamp())#>>'{}' as end`);
   const writes=[...await rehearsal.execute<{table:string;op:RowWrite['op'];id:string;old:Row|null;new:Row|null}>(sql`select table_name as table,op,row_id::text as id,old_row as old,new_row as new from app.movement_revert_capture order by seq`)];
   const events=[...await rehearsal.execute<{row:Row}>(sql`select to_jsonb(t) as row from domain_event t where t.tenant_id=${tenantId}::uuid and t.subject_employment_id=${employmentId}::uuid and t.sequence>${marker}::bigint and ${OURS('t')} order by t.sequence`)].map(r=>r.row);
   // Only the employee's own movement records: a write that reaches another employee's row falls back.
   for(const w of writes){const scope=SCOPED.find(x=>x.table===w.table);if(!scope||String((w.new??w.old)?.[scope.by])!==employmentId)throw new Captured({fallback:'outside:'+w.table});}
   const unknown=Object.keys(counts).filter(t=>t!=='domain_event'&&!SCOPED.some(x=>x.table===t)&&!TRIGGER_MAINTAINED.has(t));
   if(unknown.length)throw new Captured({fallback:'table:'+unknown.sort().join(',')});
   for(const [table,[i,u,d]] of Object.entries(counts)){
    if(table==='domain_event'){if(i!==events.length||u||d)throw new Captured({fallback:'events'});continue;}
    if(SCOPED.some(x=>x.table===table)){const mine=writes.filter(w=>w.table===table);if(i!==mine.filter(w=>w.op==='INSERT').length||u!==mine.filter(w=>w.op==='UPDATE').length||d!==mine.filter(w=>w.op==='DELETE').length)throw new Captured({fallback:'counts:'+table});}
   }
   const companies=[...new Set(writes.filter(w=>w.table==='employment'&&w.op==='UPDATE'&&!same(w.old?.company_id,w.new?.company_id)).map(w=>String(w.new!.company_id)))];
   throw new Captured({employmentId,day,digests,marker,payroll,writes,events,counts,window:[start,end],companies});
  });
 }catch(error){
  if(error instanceof Captured)return 'fallback' in error.capture?{fallback:error.capture.fallback}:{capture:error.capture};
  if(isTransientBulkJobError(error))throw error;
  // The owner refused (or anything else failed): the synchronous revert decides, with its own words.
  return{fallback:'refused:'+publicErrorMessage(error).slice(0,200)};
 }
 throw new Error('movement_revert_capture_did_not_rollback');
}

/** A timestamp the rollback wrote at the moment of the revert (inside the plan's window) becomes the release's time. */
function stamp(value:unknown,window:[number,number],now:string){
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value))return value;
 const t=Date.parse(value);return t>=window[0]-1&&t<=window[1]+1?now:value;
}
const stampRow=(row:Row,columns:readonly string[],window:[number,number],now:string)=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,columns.includes(k)?stamp(v,window,now):v]));
const parseWindow=(w:[string,string]):[number,number]=>[Date.parse(w[0]),Date.parse(w[1])];
class ReleaseRefused extends Error{constructor(readonly why:string){super('movement_revert_release_refused:'+why);}}

/** The release (see the header). Throws ReleaseRefused for anything that sends the revert to the fallback. */
async function releaseTx(tx:Tx,ctx:SessionContext,job:BulkJobRow,unit:BulkJobUnit,captures:MovementRevertCapture[]):Promise<{restored:number}>{
 const {attemptId,reason}=inputOf(job),plan=planOf(job),tenantId=ctx.tenantId;
 let mark=performance.now();const phase=(name:string)=>{const t=performance.now();unit.metric('release'+name+'Ms',t-mark);mark=t;};
 await tx.execute(sql`select set_config('application_name','aihr-bulk:movement_import_revert:release',true)`);
 await unit.fenceTx(tx);
 // The synchronous revert's locks, in its order (writers before the attempt row). Exclusive Access, as that revert
 // takes it (lockMovementWritersTx): the bounded wait first, so a busy tenant is a 55P03 the kernel retries.
 await lockAccessConfigurationWriteTx(tx,tenantId);
 await tx.execute(sql`select app.access_configuration_write_lock()`);await lockLeaveDependencyConfigurationTx(tx,tenantId);
 const source=await lockImportAttemptTx(tx,ctx,attemptId,'movement');
 const [principal]=await tx.execute<{ok:boolean}>(sql`select app.principal_snapshot_current() as ok`);if(!principal?.ok)throw new ReleaseRefused('principal');
 const [covers]=await tx.execute<{ok:boolean}>(sql`select app.import_attempt_access(${source.id}::uuid,'maintain',true) as ok`);if(!covers?.ok)throw new ReleaseRefused('maintain');
 const events=await importAttemptEventsTx(tx,source.id);
 if(events.some(e=>e.kind==='reverted'))throw new ReleaseRefused('reverted');
 if(events.find(e=>e.kind==='confirmed')?.id!==plan.confirmedEventId)throw new ReleaseRefused('confirmed');
 const items=(await importAttemptItemsTx(tx,source.id)).filter(i=>i.status==='applied');
 if(!same(items.map(i=>i.id).sort(),[...plan.itemIds??[]].sort()))throw new ReleaseRefused('items');
 if(captures.some(c=>c.day!==todayInKualaLumpur()))throw new ReleaseRefused('day');
 const employmentIds=captures.map(c=>c.employmentId);
 // Every planned employee's records exactly as the plan saw them.
 const [digests,markers,payroll]=[await digestsTx(tx,tenantId,employmentIds),await markersTx(tx,tenantId,employmentIds),await payrollTx(tx,tenantId,employmentIds)];
 for(const c of captures){
  const now=digests[c.employmentId]??{};const differs=SCOPED.map(x=>x.table).filter(t=>(now[t]??'')!==(c.digests[t]??''));
  if(differs.length)throw new ReleaseRefused('records:'+differs.join(','));
  if((markers[c.employmentId]??'0')!==c.marker)throw new ReleaseRefused('ledger');
  if((payroll[c.employmentId]??'')!==c.payroll)throw new ReleaseRefused('payroll');
 }
 // Authority now: maintain for every employment (as the review's per-employment check) and administration of every
 // company an employment returns to (as the company transfer's own rollback asks).
 // Set-wise (9911): the same rows as app.access_workforce_employment(e.id,'workforce.maintain'), the company check once.
 const [maintained]=await tx.execute<{n:number}>(sql`select count(*)::int n from employment e where e.id=any(${pgUuids(employmentIds)}) and ${workforceEmploymentSetPredicate({tenantId:sql`e.tenant_id`,companyId:sql`e.company_id`,voidedAt:sql`e.voided_at`,importPendingAttemptId:sql`e.import_pending_attempt_id`},'maintain')}`);
 if(maintained?.n!==employmentIds.length)throw new ReleaseRefused('access');
 for(const company of new Set(captures.flatMap(c=>c.companies))){const [ok]=await tx.execute<{ok:boolean}>(sql`select app.is_admin_for(${company}::uuid) as ok`);if(!ok?.ok)throw new ReleaseRefused('company');}
 phase('Checks');
 const [{now}]=await tx.execute<{now:string}>(sql`select to_jsonb(now())#>>'{}' as now`);
 const before=await countsTx(tx);
 // The recorded writes, set-based: one statement per group of writes of the same table, kind and changed columns (and
 // the same ordinal write of a row), the groups in an order every employee's own write order agrees with; then the
 // events, in the rollback's order. Each write sets exactly the columns it changed, so the same triggers run on the
 // same rows as often as in the rehearsal.
 const expected=new Map<string,{table:string;row:Row|null}>();let replayed:Record<string,[number,number,number]>={};
 const add=(table:string,[i,u,d]:[number,number,number])=>{const x=replayed[table]??[0,0,0];replayed={...replayed,[table]:[x[0]+i,x[1]+u,x[2]+d]};};
 type Op={key:string;table:string;op:RowWrite['op'];columns:string[];row:Row};
 const groups=new Map<string,Op[]>(),edges=new Map<string,Set<string>>(),indegree=new Map<string,number>();
 for(const c of captures){
  const w=parseWindow(c.window);const rounds=new Map<string,number>();let previous:string|null=null;
  for(const write of c.writes){
   const rowKey=write.table+'|'+write.id,round=rounds.get(rowKey)??0;rounds.set(rowKey,round+1);
   const after=write.new?stampRow(write.new,Object.keys(write.new),w,now):null;
   const columns=write.op==='UPDATE'?Object.keys(write.new!).filter(k=>!same(write.old?.[k],write.new![k])).sort():write.op==='INSERT'?Object.keys(write.new!):[];
   const key=`${round}|${write.table}|${write.op}|${columns.join(',')}`;
   if(!groups.has(key)){groups.set(key,[]);indegree.set(key,0);edges.set(key,new Set());}
   groups.get(key)!.push({key,table:write.table,op:write.op,columns,row:after??{id:write.id}});
   expected.set(rowKey,{table:write.table,row:after});
   if(previous&&previous!==key&&!edges.get(previous)!.has(key)){edges.get(previous)!.add(key);indegree.set(key,indegree.get(key)!+1);}
   previous=key;
  }
 }
 const ready=[...groups.keys()].filter(k=>indegree.get(k)===0),sequence:string[]=[];
 while(ready.length){const k=ready.shift()!;sequence.push(k);for(const next of edges.get(k)!){indegree.set(next,indegree.get(next)!-1);if(indegree.get(next)===0)ready.push(next);}}
 if(sequence.length!==groups.size)throw new ReleaseRefused('order');
 for(const key of sequence){
  const ops=groups.get(key)!,{table,op,columns}=ops[0],rows=ops.map(o=>o.row),json=JSON.stringify(rows);
  if(op==='UPDATE')await tx.execute(sql`update ${ident(table)} t set ${columns.length?sql.join(columns.map(c=>sql`${ident(c)}=v.${ident(c)}`),sql`, `):sql`id=v.id`} from jsonb_populate_recordset(null::${ident(table)},${json}::jsonb) v where t.id=v.id`);
  else if(op==='INSERT')await tx.execute(sql`insert into ${ident(table)}(${sql.join(columns.map(ident),sql`, `)}) select ${sql.join(columns.map(c=>sql`v.${ident(c)}`),sql`, `)} from jsonb_populate_recordset(null::${ident(table)},${json}::jsonb) with ordinality v order by v.ordinality`);
  else await tx.execute(sql`delete from ${ident(table)} where id=any(${pgUuids(rows.map(r=>String(r.id)))})`);
  add(table,op==='INSERT'?[rows.length,0,0]:op==='UPDATE'?[0,rows.length,0]:[0,0,rows.length]);
  if(process.env.MOVEMENT_REVERT_PROFILE)console.log('[revert release]',key,rows.length,Math.round(performance.now()-mark));
 }
 phase('Writes');
 const eventRows=captures.flatMap(c=>c.events.map(e=>Object.fromEntries(Object.entries(e).filter(([k])=>!EVENT_ASSIGNED.has(k)))));
 if(eventRows.length){
  const columns=Object.keys(eventRows[0]);
  await tx.execute(sql`insert into domain_event(${sql.join(columns.map(ident),sql`, `)}) select ${sql.join(columns.map(c=>sql`v.${ident(c)}`),sql`, `)} from jsonb_populate_recordset(null::domain_event,${JSON.stringify(eventRows)}::jsonb) with ordinality v order by v.ordinality`);
  add('domain_event',[eventRows.length,0,0]);
 }
 phase('Events');
 if(process.env.MOVEMENT_REVERT_PROFILE){await tx.execute(sql`set constraints all immediate`);phase('Deferred');}
 // The result must be what the rehearsal left: every written row, the events and their order, and the write counts.
 for(const {table} of SCOPED){
  const finals=[...expected.values()].filter(e=>e.table===table);if(!finals.length)continue;
  const rows=finals.flatMap(e=>e.row?[e.row]:[]),gone=[...expected.entries()].filter(([,e])=>e.table===table&&!e.row).map(([k])=>k.split('|')[1]);
  const [diff]=await tx.execute<{n:number}>(sql`select (select count(*)::int from jsonb_populate_recordset(null::${ident(table)},${JSON.stringify(rows)}::jsonb) e left join ${ident(table)} t on t.id=e.id where t.id is null or to_jsonb(t)<>to_jsonb(e))+(select count(*)::int from ${ident(table)} where id=any(${pgUuids(gone)})) n`);
  if((diff?.n??1)!==0)throw new ReleaseRefused('image:'+table);
 }
 if(eventRows.length){
  const ids=eventRows.map(e=>String(e.id));
  const [diff]=await tx.execute<{n:number;order:string[]}>(sql`select (select count(*)::int from jsonb_populate_recordset(null::domain_event,${JSON.stringify(eventRows)}::jsonb) e left join domain_event t on t.id=e.id where t.id is null or (to_jsonb(t)-${sql.raw(`'{${[...EVENT_ASSIGNED].join(',')}}'::text[]`)})<>(to_jsonb(e)-${sql.raw(`'{${[...EVENT_ASSIGNED].join(',')}}'::text[]`)})) n,(select array_agg(id::text order by sequence) from domain_event where id=any(${pgUuids(ids)})) as order`);
  if(diff?.n!==0||!same(diff.order,ids))throw new ReleaseRefused('events');
 }
 const written=delta(await countsTx(tx),before);
 const planned:Record<string,[number,number,number]>={};
 for(const c of captures)for(const [t,[i,u,d]] of Object.entries(c.counts)){const x=planned[t]??[0,0,0];planned[t]=[x[0]+i,x[1]+u,x[2]+d];}
 for(const table of new Set([...Object.keys(written),...Object.keys(planned)])){
  const w=written[table]??[0,0,0];
  if(SCOPED.some(s=>s.table===table)||table==='domain_event'){if(!same(w,replayed[table]??[0,0,0]))throw new ReleaseRefused('count:'+table);continue;}
  // A table the database maintains: the replay writes it through the same triggers exactly as often as the rehearsal.
  if(!same(w,planned[table]??[0,0,0]))throw new ReleaseRefused('count:'+table);
 }
 phase('Verify');
 await recordImportEventTx(tx,ctx,{attemptId,kind:'reverted',importKind:'movement',reason,detail:{restored:items.length,...plan.detail}});
 const released={restored:items.length,path:'release' as const};
 // The marker commits with the release, through the sealed job update (this transaction fenced on the lease above).
 await unit.set(tx,{planMerge:{released}});
 return{restored:items.length};
}

// ---- Admission, progress and the handler.
export function movementImportRevertProgress(row:BulkJobRow):ImportRevertJobProgress{
 const plan=planOf(row);
 return{id:row.id,state:row.state,attemptId:plan.attemptId??inputOf(row)?.attemptId??'',error:row.error===INTERNAL_FAILURE?null:row.error,blockers:blockersOf(row),restored:row.state==='completed'?(plan.released?.restored??null):null};
}
/** Admission, with the synchronous revert's input checks and its first authority check, in its words. */
export async function createMovementImportRevertJob(ctx:SessionContext,attemptId:string,input:{previewHash:string;reason:string}):Promise<ImportRevertJobProgress>{
 if(!uuid.test(attemptId))throw new ImportHistoryError('Import attempt unavailable.');
 const reason=normalizeImportRevertReason(input.reason);if(!reason)throw new ImportHistoryError('Enter a reason for the revert (3 to 1,000 characters).');
 if(typeof input.previewHash!=='string'||!/^[0-9a-f]{64}$/.test(input.previewHash))throw new ImportHistoryError('Review what will be restored before confirming.');
 try{
  return await withTenant(ctx,async tx=>{
   const [principal]=await tx.execute<{ok:boolean}>(sql`select app.principal_snapshot_current() as ok`);
   if(!principal?.ok)throw new ImportHistoryError(REFUSALS.access);
   const [attempt]=await tx.execute<{kind:string;company_ids:string[]}>(sql`select kind,company_ids from import_attempt where id=${attemptId}::uuid`);
   if(!attempt||attempt.kind!=='movement')throw new ImportHistoryError('Import attempt unavailable.');
   const [covers]=await tx.execute<{ok:boolean}>(sql`select app.import_attempt_access(${attemptId}::uuid,'maintain',true) as ok`);
   if(!covers?.ok)throw new ImportHistoryError(REFUSALS.maintain);
   const {row}=await enqueueBulkJobTx(tx,ctx,{kind:MOVEMENT_REVERT_KIND,companyIds:attempt.company_ids,input:{attemptId,previewHash:input.previewHash,reason} satisfies RevertInput});
   return movementImportRevertProgress(row);
  });
 }catch(error){
  if(error instanceof BulkJobError)throw new ImportHistoryError(error.message===BULK_JOB_ALREADY_RUNNING?'Another revert you started is still running. Wait for it to finish.':'Import attempt unavailable.');
  throw error;
 }
}
export async function getMovementImportRevertJob(ctx:SessionContext,id:string){
 return withTenant(ctx,async tx=>movementImportRevertProgress(await bulkJobTx(tx,id,{kind:MOVEMENT_REVERT_KIND})));
}
/** The signed-in user's running revert of this attempt, if any (the history page rejoins it). */
export async function activeMovementImportRevertJob(ctx:SessionContext,attemptId:string){
 return withTenant(ctx,async tx=>{
  const rows=await listBulkJobsTx(tx,ctx,MOVEMENT_REVERT_KIND,10);
  // The worker writes the plan in prepare (there is no admission plan); until then the attempt is the admitted input's.
  const row=rows.find(r=>(planOf(r).attemptId??inputOf(r)?.attemptId)===attemptId&&['queued','preparing','running','finalizing'].includes(r.state));
  return row?movementImportRevertProgress(row):null;
 });
}
/** Jobs whose synchronous fallback ran in this process (it records its own failure on the attempt). */
const referenceRan=new Set<string>();
const captureOf=(result:unknown)=>(result as StepResult|null)??{fallback:'missing'};

export const movementImportRevertJobHandler:BulkJobHandler<{employmentId:string;itemIds:string[]}>={
 kind:MOVEMENT_REVERT_KIND,
 mode:'per-step',
 chunkBudgetMs:100,maxStepsPerChunk:4,
 phaseOf:()=>'plan',
 isTransient:isTransientBulkJobError,
 /** The review, once, on a read-only snapshot without the writer locks; then one plan step per employee. An attempt
  * with Update or Delete items is decided by the synchronous revert (its review rehearses them under the locks). */
 async prepare(ctx,job){
  const {attemptId,previewHash}=inputOf(job);
  if(await withTenant(ctx,tx=>movementRevertReviewWritesTx(tx,attemptId)))return{steps:[],plan:{attemptId,fallback:'corrections'} satisfies RevertPlan};
  try{
   const plan=await planImportRevert(ctx,attemptId,movementRevertHandler);
   if(plan.blockers.length)return{refused:BLOCKED,errors:toErrors(plan.blockers),plan:{attemptId}};
   if(plan.previewHash!==previewHash)return{refused:REFUSALS.changed,plan:{attemptId}};
   const items=plan.items as ImportAttemptItemRow[];
   const steps=movementRevertEmployments(items).map((employmentId,seq)=>({kind:'employee',rowNum:seq+1,payload:{employmentId,itemIds:items.filter(i=>(i.employmentId??'')===employmentId).map(i=>i.id)}}));
   const corrections=items.filter(i=>!!(i.after as {action?:string}|null)?.action).length;
   return{steps,plan:{attemptId,confirmedEventId:plan.confirmedEventId,itemIds:items.map(i=>i.id),detail:{movements:items.length-corrections,...(corrections?{corrections}:{})}} satisfies RevertPlan,counters:{items:items.length}};
  }catch(error){
   if(error instanceof ImportHistoryError)return{refused:error.message,errors:toErrors(error.blockers),plan:{attemptId}};
   throw error;
  }
 },
 /** The revert's own writer locks, once for the chunk, with a bounded wait (a wait over 1 s is retried). Exclusive
  * Access, as the synchronous revert takes it (lockMovementWritersTx). */
 async beginChunkTx(tx,ctx){
  await tx.execute(sql`select set_config('lock_timeout','1000ms',true)`);
  await lockAccessConfigurationWriteTx(tx,ctx.tenantId);
  await tx.execute(sql`select app.access_configuration_write_lock()`);await lockLeaveDependencyConfigurationTx(tx,ctx.tenantId);
 },
 /** One employee's compensation, rehearsed in a savepoint that always rolls back, and what it wrote. */
 async applyStepTx(tx,ctx,job,step){
  const {attemptId,reason}=inputOf(job);
  const items=(await importAttemptItemsTx(tx,attemptId)).filter(i=>i.status==='applied'&&step.payload.itemIds.includes(i.id));
  if(items.length!==step.payload.itemIds.length)return{result:{fallback:'items'} satisfies StepResult};
  const result=await captureMovementRevertTx(tx,ctx,step.payload.employmentId,items,reason);
  const counters:Record<string,number>=result.capture?{planned:1}:{fallback:1};
  return{result,counters};
 },
 /** The release, or the synchronous revert when the plan or the release says so. */
 async finalize(ctx,job,unit){
  const {attemptId,previewHash,reason}=inputOf(job);const plan=planOf(job);
  const counted=(extra:Record<string,number>):Record<string,number>=>extra;
  if(plan.released)return{result:{attemptId,restored:plan.released.restored},counters:counted({restored:plan.released.restored})};
  let fallback=plan.fallback;const captures:MovementRevertCapture[]=[];
  if(!fallback){
   const steps=await withTenant(ctx,tx=>tx.execute<{state:string;result:unknown}>(sql`select state,result from bulk_job_step where job_id=${job.id}::uuid order by seq`));
   for(const step of steps){const r=step.state==='applied'?captureOf(step.result):{fallback:'step'};if(r.fallback){fallback=r.fallback;break;}captures.push(r.capture!);}
  }
  if(!fallback){
   const started=performance.now();
   try{
    const done=await withTenant(ctx,tx=>releaseTx(tx,ctx,job,unit,captures));
    unit.metric('releaseTxMs',performance.now()-started);
    return{result:{attemptId,restored:done.restored},counters:counted({restored:done.restored,released:1})};
   }catch(error){
    // Any refusal or failure of the release rolled it back whole; the synchronous revert decides, in its words.
    if(isTransientBulkJobError(error))throw error;
    fallback=error instanceof ReleaseRefused?error.why:'release:'+publicErrorMessage(error).slice(0,200);
   }
  }
  // The synchronous revert, exactly as before: its own locked review, blockers, hash check, rollback and records
  // (a refusal there is recorded on the attempt by revertImport itself).
  const started=performance.now();referenceRan.add(job.id);
  const done=await revertImport(ctx,attemptId,movementRevertHandler,{previewHash,reason});
  unit.metric('referenceTxMs',performance.now()-started);
  await withTenant(ctx,async tx=>{await unit.fenceTx(tx);await unit.set(tx,{planMerge:{released:{restored:done.restored,path:'reference'},fallback}});});
  return{result:{attemptId,restored:done.restored},counters:counted({restored:done.restored,reference:1})};
 },
 async describeFailure(_job,error){
  if(error instanceof ImportHistoryError)return{error:error.message,errors:toErrors(error.blockers)};
  console.error('[movement import revert]',publicErrorMessage(error));
  return{error:INTERNAL_FAILURE};
 },
 /** A refusal before the revert ran is recorded as a failed revert with its blockers, as the synchronous revert did
  * (the synchronous fallback records its own). */
 async afterTerminal(ctx,job){
  const ran=referenceRan.delete(job.id);
  if(job.state==='completed'||!ctx||ran)return;
  const plan=planOf(job),attemptId=plan.attemptId??inputOf(job)?.attemptId;if(!attemptId||plan.released)return;
  await recordImportFailure(ctx,attemptId,'movement','revert_failed',job.error===INTERNAL_FAILURE||!job.error?new Error('revert failed'):new ImportHistoryError(job.error,blockersOf(job)));
 },
};
