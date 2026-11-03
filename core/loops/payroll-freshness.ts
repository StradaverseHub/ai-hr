/** AI v2 Phase 2 hardening (4 November 2026) — keeping the Salary payroll and Audit loops fresh between nightly sweeps.
 *
 * The nightly sweep (scripts/review-sweep.ts, 03:00) runs every loop once a day, so a run processed, reprocessed or closed
 * at 10:00 used to show its checks only the next morning. The 15-minute payroll tick (core/loops/tick.ts) now also runs
 * these two loops, but ONLY for the companies whose payroll changed since the loop last ran there: a payroll run created,
 * processed, reprocessed (in part or whole), closed, reopened, reset, deleted, widened or marked for recalculation (the
 * payroll owner's own `payroll-batch.*` events), and for the Audit loop also a statutory report or file generated, filed
 * or reversed, or a bank file generated. Read under the loop sponsor's authority (domain events are an administrator's
 * read); each company is compared with the loop's own last completed run there (teras_loop_run, read as the agent).
 * Nothing is written here and no model is called. */
import {and,eq,inArray,sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {terasLoopRun,type TerasLoopWorker} from '../../db/teras-schema';

/** The payroll owner's run events that change what the Salary payroll loop would find. */
export const PAYROLL_RUN_CHANGE_EVENTS=Object.freeze(['payroll-batch.created','payroll-batch.processed','payroll-batch.selective-reprocessed',
 'payroll-batch.closed','payroll-batch.unlocked','payroll-batch.reset','payroll-batch.deleted','payroll-batch.run-added','payroll-batch.scope-widened',
 'payroll-batch.recalc-required','payroll-batch.recalc-cleared','payroll-batch.employee-payroll-removed']);
/** And, for the Audit loop, the month's files. */
export const PAYROLL_FILE_CHANGE_EVENTS=Object.freeze(['statutory-report.generated','statutory-report.file-generated','statutory-report.filed',
 'statutory-report.filing-reversed','bank-payment-file.generated']);

/** Each company's last completed run of one loop, read as the agent principal (null when it never ran there). */
export async function lastLoopRunsTx(tx:Tx,tenantId:string,workerId:TerasLoopWorker,companies:readonly string[]):Promise<Map<string,Date|null>>{
 const out=new Map<string,Date|null>(companies.map(companyId=>[companyId,null]));
 if(!companies.length)return out;
 const rows=await tx.select({companyId:terasLoopRun.companyId,at:sql<Date|string|null>`max(${terasLoopRun.startedAt})`}).from(terasLoopRun)
  .where(and(eq(terasLoopRun.tenantId,tenantId),eq(terasLoopRun.workerId,workerId),eq(terasLoopRun.status,'ran'),inArray(terasLoopRun.companyId,[...companies])))
  .groupBy(terasLoopRun.companyId);
 for(const row of rows)if(row.companyId)out.set(row.companyId,row.at==null?null:new Date(String(row.at instanceof Date?row.at.toISOString():row.at)));
 return out;
}

/** The companies whose payroll (and, with `files`, statutory and bank files) changed after the given instant. A company
 * the loop never ran for is always changed. Read as the sponsor. */
export async function payrollChangedCompanies(sponsor:SessionContext,input:Readonly<{companies:readonly string[];since:ReadonlyMap<string,Date|null>;files?:boolean}>):Promise<string[]>{
 const companies=[...input.companies];
 if(!companies.length)return [];
 const never=companies.filter(companyId=>!input.since.get(companyId));
 const known=companies.filter(companyId=>!!input.since.get(companyId));
 if(!known.length)return never;
 const oldest=new Date(Math.min(...known.map(companyId=>input.since.get(companyId)!.getTime())));
 const latest=await withTenant(sponsor,async tx=>{
  const runs=Array.from(await tx.execute(sql`select b.company_id,max(d.occurred_at) as at from public.domain_event d
   join public.payroll_batch b on b.id=d.aggregate_id and b.tenant_id=d.tenant_id
   where d.tenant_id=${sponsor.tenantId}::uuid and d.aggregate_type='payroll-batch'
    and d.event_type in (${sql.join(PAYROLL_RUN_CHANGE_EVENTS.map(type=>sql`${type}`),sql`,`)})
    and d.occurred_at>${oldest.toISOString()}::timestamptz and b.company_id in (${sql.join(known.map(id=>sql`${id}::uuid`),sql`,`)})
   group by b.company_id`) as unknown as {company_id:string;at:string|Date}[]);
  const files=input.files?Array.from(await tx.execute(sql`select d.payload->>'companyId' as company_id,max(d.occurred_at) as at from public.domain_event d
   where d.tenant_id=${sponsor.tenantId}::uuid and d.event_type in (${sql.join(PAYROLL_FILE_CHANGE_EVENTS.map(type=>sql`${type}`),sql`,`)})
    and d.occurred_at>${oldest.toISOString()}::timestamptz and d.payload->>'companyId' in (${sql.join(known.map(id=>sql`${id}`),sql`,`)})
   group by 1`) as unknown as {company_id:string;at:string|Date}[]):[];
  return [...runs,...files];
 });
 const changed=new Set(never);
 for(const row of latest){
  const since=input.since.get(row.company_id);
  const at=row.at instanceof Date?row.at:new Date(String(row.at));
  if(since&&at.getTime()>since.getTime())changed.add(row.company_id);
 }
 return companies.filter(companyId=>changed.has(companyId));
}
