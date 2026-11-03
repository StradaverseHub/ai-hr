/** AI v2 P2-2b — the inputs snapshot of a payroll run, as the run used them.
 *
 * The payroll processing owner (core/payroll.ts generatePayslipsTx) calls `captureRunInputsAtProcessingTx` in its own
 * transaction, right after it records the run as processed (or an employee subset as reprocessed). The snapshot is taken from
 * the rows that transaction has just read and written, so it is the inputs at the time of the run, not at a later capture:
 *  - one sha256 and a row count per component, each over the owner rows exactly as the owner holds them: attendance and
 *    overtime in their cut-off windows, leave overlapping its window, claims paid by or falling in this run, the pay
 *    (compensation) in force, the run's own inputs, one-off transactions and run components;
 *  - the same over the payslips the run produced, so the snapshot ties the inputs to their results.
 * Nothing here calculates or changes a figure: it reads, hashes in the database and appends one capture. EVERYTHING runs
 * inside a savepoint, the company's cut-off schedule read included (Phase 2 hardening, 4 November 2026), so a capture that
 * cannot be read or written never changes or stops the payroll run; the miss is recorded instead as a
 * `payroll-audit.inputs-not-captured` domain event, and the daily Audit loop's `inputs_now` capture still shows the inputs.
 * BOUNDED: no single JSON of the run's rows is ever built. The database returns one row per employment and input kind
 * (that employment's row count and the hash of its own rows), and the component's hash is folded from those, one
 * employment at a time, in employment order. A run of thousands of people therefore reads thousands of short rows per
 * kind, and the capture itself holds only a count and a hash per kind. */
import {createHash} from 'node:crypto';
import {sql,type SQL} from 'drizzle-orm';
import type {SessionContext,Tx} from '../../db/client';
import {actorOf,appendEvent} from '../../db/events';
import {appendCapturesTx} from './append';

export type CutOffWindows=Readonly<{attendance:{start:string;end:string};overtime:{start:string;end:string};leave:{start:string;end:string};claim:{start:string;end:string}}>;
export type InputComponent=Readonly<{rows:number;hash:string|null}>;
export type RunInputs=Readonly<{employments:number;windows:CutOffWindows;components:Readonly<Record<string,InputComponent>>;results:InputComponent}>;
export const INPUT_COMPONENTS=Object.freeze(['attendance','overtime','leave','claims','payChanges','runInputs','transactions','runComponents'] as const);

type Row=Record<string,unknown>;
const rows=async(tx:Tx,query:SQL)=>Array.from(await tx.execute(query) as unknown as Row[]);
const monthEnd=(period:string)=>{const y=Number(period.slice(0,4)),m=Number(period.slice(5,7));return `${period}-${String(new Date(Date.UTC(y,m,0)).getUTCDate()).padStart(2,'0')}`;};

/** One component: per employment, its rows counted and hashed in the database (one result row per employment), then the
 * per-employment hashes folded incrementally into the component's hash. Never one JSON of every row. */
async function componentTx(tx:Tx,query:SQL):Promise<InputComponent>{
 const perEmployment=await rows(tx,sql`select x.employment_id::text as e,count(*)::int as n,
  app.payroll_audit_hash(jsonb_agg(to_jsonb(x) order by x.id)::text) as h from (${query}) x group by x.employment_id order by x.employment_id`);
 const hash=createHash('sha256');let total=0;
 for(const row of perEmployment){total+=Number(row.n??0);hash.update(`${String(row.e)}:${Number(row.n??0)}:${String(row.h)}\n`);}
 return Object.freeze({rows:total,hash:hash.digest('hex')});
}

/** Every component of one run's inputs, and its results, read in `tx`. Instants inside the hashed rows render in UTC whatever
 * the session (and the session's own setting is put back), so a snapshot taken while processing and one taken by the daily
 * loop hash the same unchanged rows the same way. */
export async function runInputsTx(tx:Tx,p:Readonly<{batchId:string;payPeriod:string;windows:CutOffWindows}>):Promise<RunInputs>{
 const [zone]=await rows(tx,sql`select current_setting('timezone') as tz`);
 await tx.execute(sql`select set_config('timezone','UTC',true)`);
 try{return await runInputsUtcTx(tx,p);}
 finally{await tx.execute(sql`select set_config('timezone',${String(zone?.tz??'UTC')},true)`);}
}
async function runInputsUtcTx(tx:Tx,p:Readonly<{batchId:string;payPeriod:string;windows:CutOffWindows}>):Promise<RunInputs>{
 const {batchId,payPeriod,windows}=p;
 const [count]=await rows(tx,sql`select count(distinct s.employment_id)::int as n from public.payslip s where s.batch_id=${batchId}::uuid`);
 // The run's people, as a subquery: never a literal list of thousands of ids.
 const inList=sql`(select s.employment_id from public.payslip s where s.batch_id=${batchId}::uuid)`;
 const queries:Readonly<Record<(typeof INPUT_COMPONENTS)[number],SQL>>={
  attendance:sql`select a.* from public.attendance a where a.employment_id in ${inList} and a.attendance_date between ${windows.attendance.start}::date and ${windows.attendance.end}::date`,
  overtime:sql`select a.id,a.employment_id,a.attendance_date,a.ot_minutes,a.ot_flat_minutes,a.ot00_minutes,a.ot10_minutes,a.ot15_minutes,a.ot20_minutes,a.ot30_minutes
   from public.attendance a where a.employment_id in ${inList} and a.attendance_date between ${windows.overtime.start}::date and ${windows.overtime.end}::date and coalesce(a.ot_minutes,0)>0`,
  leave:sql`select l.* from public.leave_request l where l.employment_id in ${inList} and l.start_date<=${windows.leave.end}::date and l.end_date>=${windows.leave.start}::date`,
  claims:sql`select c.* from public.claim_request c where c.payroll_batch_id=${batchId}::uuid
   or (c.employment_id in ${inList} and c.incurred_on between ${windows.claim.start}::date and ${windows.claim.end}::date)`,
  payChanges:sql`select c.* from public.compensation c where c.employment_id in ${inList} and c.valid_from<=${monthEnd(payPeriod)}::date
   and (c.valid_to is null or c.valid_to>=${payPeriod+'-01'}::date)`,
  runInputs:sql`select i.* from public.payroll_input i where i.batch_id=${batchId}::uuid`,
  transactions:sql`select t.* from public.payroll_individual_txn t where t.batch_id=${batchId}::uuid or t.consumed_batch_id=${batchId}::uuid`,
  runComponents:sql`select c.* from public.payroll_batch_component c where c.batch_id=${batchId}::uuid`,
 };
 const components:Record<string,InputComponent>={};
 for(const key of INPUT_COMPONENTS)components[key]=await componentTx(tx,queries[key]);
 const results=await componentTx(tx,sql`select s.* from public.payslip s where s.batch_id=${batchId}::uuid`);
 return Object.freeze({employments:Number(count?.n??0),windows,components:Object.freeze(components),results});
}

/** The processing owner's hook: the inputs as this run used them, captured in the run's own transaction. Never throws.
 * `windows` is read INSIDE the capture's savepoint (the owner passes its schedule reader), so even a failure to read the
 * company's cut-off schedule stays in the savepoint and is recorded as a miss. */
export async function captureRunInputsAtProcessingTx(tx:Tx,ctx:SessionContext,
 p:Readonly<{batchId:string;companyId:string;payPeriod:string;windows:(savepoint:Tx)=>Promise<CutOffWindows>;trigger:'processed'|'reprocessed';employmentIds?:readonly string[]}>):Promise<boolean>{
 const miss=async(reason:'no_login'|'not_written')=>{
  try{await tx.transaction(savepoint=>appendEvent(savepoint as unknown as Tx,{tenantId:ctx.tenantId,aggregateType:'payroll-audit',aggregateId:p.companyId,
   eventType:'payroll-audit.inputs-not-captured',actor:actorOf(ctx),payload:{batchId:p.batchId,companyId:p.companyId,payPeriod:p.payPeriod,trigger:p.trigger,reason}}));}
  catch{/* The run itself is never stopped by its audit record. */}
  return false;
 };
 if(!ctx.userId||ctx.agent)return miss('no_login');
 try{
  return await tx.transaction(async savepoint=>{
   const s=savepoint as unknown as Tx;
   const windows=await p.windows(s);
   const inputs=await runInputsTx(s,{batchId:p.batchId,payPeriod:p.payPeriod,windows});
   await appendCapturesTx(s,ctx.tenantId,{kind:'user',userId:ctx.userId!},p,[{kind:'inputs_snapshot',sourceKey:'inputs:'+p.batchId,batchId:p.batchId,
    content:{basis:'processed',trigger:p.trigger,processedBy:ctx.userId!,...(p.employmentIds?{reprocessedEmploymentIds:[...p.employmentIds].sort()}:{}),...inputs}}]);
   return true;
  });
 }catch{return miss('not_written');}
}
