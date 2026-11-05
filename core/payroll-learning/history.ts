/** Payroll history learning, P1 — the history reader: what one company's payroll history may teach, and nothing more.
 *
 * ══ WHAT IS READ ══
 *  - CLOSED RUNS ONLY (payroll_status 'closed'): a draft or processed run can still be reprocessed or reset, so it is never
 *    history. Imported payroll history is closed `adjustment` runs; each counts by its payroll cycle's own run type (the
 *    behavioural type the cycle maps to), since the old system's months were regular, bonus or off-cycle pay.
 *  - NO LOOK-AHEAD: only months before the as-of month (pay_period < asOf), within WINDOW_MONTHS of it; and, when a
 *    replay names an instant (`knownBefore`, phase P3's backtest), only what was recorded before it: runs closed, flags
 *    disposed, exceptions resolved and salary records entered before that instant.
 *  - EFFECTIVE COPIES ONLY: every payslip passes app.payroll_history_effective (0602), so a payslip a payroll-history
 *    import superseded is never read, here as on every other reader (the restrictive payslip policy says the same).
 *  - Under the caller's own row-level security: the learning sponsor (a payroll administrator of the company,
 *    ./recompute.ts) or the payroll administrator viewing a page. Nothing crosses a company or a tenant.
 * ══ WHAT IS SET ASIDE (per person and month, in every basis) ══
 *  - problem_swing: payroll HR found the month's net-swing flag a real problem (teras_payroll_swing_disposition);
 *  - fixed_upstream: an exception on the month's run was resolved as fixed at the source (payroll_anomaly_verdict);
 *  - correction: the person's result was reprocessed after the run had been closed once and reopened; a live adjustment
 *    run paid them that month; or the imported month is a correction of an earlier import;
 *  - manual_figure: a statutory figure on one of the month's payslips was set by hand (the same provenance the pay
 *    difference service names set_by_hand);
 *  - before_salary_change: the month is before the person's latest basic salary change effective by the as-of month
 *    (the compensation record, the salary's owner). A change from the 1st counts from its own month; a change mid-month
 *    from the next month, since the month it falls in was paid at two rates;
 *  - first_month and last_month: the person's first month with the company (their company join date, else their group
 *    join date) and the month their employment ended; part_month: a payslip of the month carries an unpaid-leave or
 *    absence line, or the kernel's proration stamp with a factor under 1 (reportContext.proration). A part month is usual
 *    for nobody (coordinator review, 4 November 2026).
 * Nothing here computes pay or writes. */
import {and,eq,gte,inArray,isNull,lt,sql} from 'drizzle-orm';
import type {Tx} from '../../db/client';
import {compensation,employment,payrollAnomalyVerdict,payrollBatch,payrollCycle,payslip} from '../../db/schema';
import {terasPayrollSwingDisposition} from '../../db/teras-payroll-cycle-schema';
import {STATUTORY_EXPLAIN_KEYS,statutoryProvenance} from '../statutory-explain';
import {nextPeriod,previousPeriod} from '../loops/period';
import {WINDOW_MONTHS,toSen} from './baseline-math';
import type {LearningMonth,LearningRow,LearningRunType,MonthExclusion} from './learn';

const PERIOD=/^\d{4}-(0[1-9]|1[0-2])$/;
export const isPeriod=(value:unknown):value is string=>typeof value==='string'&&PERIOD.test(value);
/** The first month of the window that ends just before `asOf`. */
export function windowStart(asOf:string,months=WINDOW_MONTHS):string{let p=asOf;for(let i=0;i<months;i++)p=previousPeriod(p);return p;}
const key=(employmentId:string,period:string)=>`${employmentId}:${period}`;

/** The first month learned from after the person's latest basic salary change effective by `asOf`, or null when there is
 * none. `records` are the person's current salary records (any order). PURE. */
export function salaryChangeFrom(records:readonly Readonly<{validFrom:string;basicSalary:unknown}>[],asOf:string):string|null{
 const ordered=[...records].filter(row=>/^\d{4}-\d{2}-\d{2}$/.test(row.validFrom)).sort((a,b)=>a.validFrom.localeCompare(b.validFrom));
 let from:string|null=null;
 for(let i=1;i<ordered.length;i++){
  if(toSen(ordered[i].basicSalary)===toSen(ordered[i-1].basicSalary))continue;
  const month=ordered[i].validFrom.slice(0,7);
  if(month>asOf)break;
  from=ordered[i].validFrom.slice(8,10)==='01'?month:nextPeriod(month);
 }
 return from;
}

/** Whether any statutory figure on the payslip was set by hand. PURE. */
export function hasManualFigure(statutory:unknown):boolean{
 return STATUTORY_EXPLAIN_KEYS.some(item=>statutoryProvenance(statutory,item).source!=='computed');
}

/** Whether a payslip is for part of a month: the kernel stamped unpaid-leave or absence days or amount on it, or a
 * proration factor under 1. The run's own stamps are read, not the payslip display (which lumps a line that exceeds its
 * column); the deduction column is not needed. PURE. */
export function isPartMonth(statutory:unknown,_otherDeductions?:unknown):boolean{
 const st=(statutory??{}) as {unpaidLeave?:unknown;absent?:unknown;reportContext?:{proration?:{factor?:unknown}}};
 const stamped=(raw:unknown)=>!!raw&&typeof raw==='object'&&(Number((raw as {days?:unknown}).days)>0||Number((raw as {amount?:unknown}).amount)>0);
 if(stamped(st.unpaidLeave)||stamped(st.absent))return true;
 const factor=st.reportContext?.proration?.factor;
 return typeof factor==='number'&&Number.isFinite(factor)&&factor<1;
}

export type ExclusionFacts=Readonly<{
 /** `${employmentId}:${period}` keys. */
 problemSwings:ReadonlySet<string>;fixedUpstream:ReadonlySet<string>;corrections:ReadonlySet<string>;
 /** The first month learned from after a salary change, per employment. */
 salaryFrom:ReadonlyMap<string,string>;
 /** Each person's first month with the company and the month their employment ended (null while employed). */
 tenure?:ReadonlyMap<string,Readonly<{first:string;last:string|null}>>}>;

/** Each person's months, in period order, with the reasons each is set aside. PURE. */
export function personMonths(rows:readonly LearningRow[],facts:ExclusionFacts):Map<string,LearningMonth[]>{
 const grouped=new Map<string,Map<string,LearningRow[]>>();
 for(const row of rows){
  const months=grouped.get(row.employmentId)??new Map<string,LearningRow[]>();
  months.set(row.payPeriod,[...(months.get(row.payPeriod)??[]),row]);
  grouped.set(row.employmentId,months);
 }
 const out=new Map<string,LearningMonth[]>();
 for(const [employmentId,months] of [...grouped].sort(([a],[b])=>a.localeCompare(b))){
  const list:LearningMonth[]=[];
  for(const [period,monthRows] of [...months].sort(([a],[b])=>a.localeCompare(b))){
   const k=key(employmentId,period),excluded:MonthExclusion[]=[];
   if(facts.problemSwings.has(k))excluded.push('problem_swing');
   if(facts.fixedUpstream.has(k))excluded.push('fixed_upstream');
   if(facts.corrections.has(k)||monthRows.some(row=>row.runType==='adjustment'&&!row.imported))excluded.push('correction');
   if(monthRows.some(row=>hasManualFigure(row.figures.statutory)))excluded.push('manual_figure');
   const from=facts.salaryFrom.get(employmentId);
   if(from&&period<from)excluded.push('before_salary_change');
   const tenure=facts.tenure?.get(employmentId);
   if(tenure&&period===tenure.first)excluded.push('first_month');
   if(tenure?.last&&period===tenure.last)excluded.push('last_month');
   if(monthRows.some(row=>isPartMonth(row.figures.statutory,row.figures.otherDeductions)))excluded.push('part_month');
   list.push(Object.freeze({period,rows:Object.freeze(monthRows),excluded:Object.freeze(excluded)}));
  }
  out.set(employmentId,list);
 }
 return out;
}

export type LearningHistory=Readonly<{companyId:string;asOf:string;from:string;
 /** The latest closed month in the window, or null when the company has none. */
 latestClosed:string|null;months:ReadonlyMap<string,readonly LearningMonth[]>}>;
export type HistoryOptions=Readonly<{companyId:string;asOf:string;
 /** Only these people (the evidence of one page); all when omitted. */
 employmentIds?:readonly string[];
 /** A replay: only what was recorded before this instant (phase P3's backtest). */
 knownBefore?:Date;
 /** Leave out people whose learned baseline is due to go (the leaver retention rule, migration 2012). */
 skipRetired?:boolean}>;

const RUN_TYPES:readonly LearningRunType[]=['regular','bonus','off_cycle','adjustment'];
const monthOf=(value:unknown)=>{const text=value instanceof Date?value.toISOString().slice(0,10):String(value??'');return /^\d{4}-\d{2}-\d{2}$/.test(text)?text.slice(0,7):null;};
const runTypeOf=(value:unknown):LearningRunType=>RUN_TYPES.includes(value as LearningRunType)?value as LearningRunType:'adjustment';

/** The company's closed-run history before `asOf`, as the caller may read it, grouped per person with its exclusions. */
export async function readLearningHistoryTx(tx:Tx,options:HistoryOptions):Promise<LearningHistory>{
 if(!isPeriod(options.asOf))throw new RangeError('The as-of month is YYYY-MM.');
 const from=windowStart(options.asOf),known=options.knownBefore?.toISOString()??null;
 const closedAt=sql`coalesce(${payrollBatch.closedAt},${payrollBatch.createdAt})`;
 const batches=await tx.select({id:payrollBatch.id,payPeriod:payrollBatch.payPeriod,runType:payrollBatch.runType,imported:sql<boolean>`${payrollBatch.historyImportAttemptId} is not null`,
  cycleRunType:payrollCycle.runType}).from(payrollBatch).leftJoin(payrollCycle,eq(payrollCycle.id,payrollBatch.payrollCycleId))
  .where(and(eq(payrollBatch.companyId,options.companyId),eq(payrollBatch.status,'closed'),gte(payrollBatch.payPeriod,from),lt(payrollBatch.payPeriod,options.asOf),
   known?sql`${closedAt}<${known}::timestamptz`:undefined));
 const latestClosed=batches.length?batches.map(batch=>batch.payPeriod).sort().at(-1)!:null;
 if(!batches.length)return Object.freeze({companyId:options.companyId,asOf:options.asOf,from,latestClosed,months:new Map()});
 const byBatch=new Map(batches.map(batch=>[batch.id,batch]));
 const ids=[...byBatch.keys()];
 const people=options.employmentIds?[...new Set(options.employmentIds)]:null;
 if(people&&!people.length)return Object.freeze({companyId:options.companyId,asOf:options.asOf,from,latestClosed,months:new Map()});
 const slips=await tx.select({id:payslip.id,employmentId:payslip.employmentId,batchId:payslip.batchId,basic:payslip.basicSalary,allowance:payslip.allowance,
  overtime:payslip.overtimePay,bonus:payslip.bonus,gross:payslip.grossPay,statutory:payslip.statutory,otherDeductions:payslip.otherDeductions,
  totalDeductions:payslip.totalDeductions,net:payslip.netPay,
  // An imported month that corrects an earlier import of the same record.
  corrected:sql<boolean>`exists(select 1 from public.payroll_history_import_revision r where r.snapshot_id=${payslip.id} and r.kind='correction')`})
  .from(payslip).innerJoin(employment,eq(employment.id,payslip.employmentId))
  .where(and(inArray(payslip.batchId,ids),eq(employment.companyId,options.companyId),sql`app.payroll_history_effective(${payslip.id})`,
   people?inArray(payslip.employmentId,people):undefined,
   options.skipRetired?sql`app._payroll_learning_leaver_due(${payslip.employmentId}) is not true`:undefined));
 const rows:LearningRow[]=[];
 const corrections=new Set<string>();
 for(const slip of slips){
  const batch=byBatch.get(slip.batchId)!;
  const runType=batch.imported?runTypeOf(batch.cycleRunType??'regular'):runTypeOf(batch.runType);
  rows.push(Object.freeze({employmentId:slip.employmentId,batchId:slip.batchId,payPeriod:batch.payPeriod,runType,imported:batch.imported,
   figures:Object.freeze({basic:slip.basic,allowance:slip.allowance,overtime:slip.overtime,bonus:slip.bonus,gross:slip.gross,statutory:slip.statutory,
    otherDeductions:slip.otherDeductions,totalDeductions:slip.totalDeductions,net:slip.net})}));
  if(slip.corrected)corrections.add(key(slip.employmentId,batch.payPeriod));
 }
 const employmentIds=[...new Set(rows.map(row=>row.employmentId))];
 if(!employmentIds.length)return Object.freeze({companyId:options.companyId,asOf:options.asOf,from,latestClosed,months:new Map()});
 const periodOf=(batchId:string)=>byBatch.get(batchId)!.payPeriod;
 // Problem swings, fixed-at-the-source exceptions and reprocessing after a reopen, as recorded (before `knownBefore`).
 const swings=await tx.select({employmentId:terasPayrollSwingDisposition.employmentId,payPeriod:terasPayrollSwingDisposition.payPeriod}).from(terasPayrollSwingDisposition)
  .where(and(eq(terasPayrollSwingDisposition.companyId,options.companyId),eq(terasPayrollSwingDisposition.disposition,'problem'),
   inArray(terasPayrollSwingDisposition.employmentId,employmentIds),gte(terasPayrollSwingDisposition.payPeriod,from),lt(terasPayrollSwingDisposition.payPeriod,options.asOf),
   known?sql`${terasPayrollSwingDisposition.decidedAt}<${known}::timestamptz`:undefined));
 const fixes=await tx.select({employmentId:payrollAnomalyVerdict.employmentId,batchId:payrollAnomalyVerdict.batchId}).from(payrollAnomalyVerdict)
  .where(and(inArray(payrollAnomalyVerdict.batchId,ids),inArray(payrollAnomalyVerdict.employmentId,employmentIds),eq(payrollAnomalyVerdict.resolution,'fixed_upstream'),
   known?sql`${payrollAnomalyVerdict.resolvedAt}<${known}::timestamptz`:undefined));
 const reprocessed=Array.from(await tx.execute(sql`select h.employment_id,h.batch_id from public.payroll_employee_result_history h
  where h.batch_id in (${sql.join(ids.map(id=>sql`${id}::uuid`),sql`,`)}) and h.action='reprocess'
   and h.employment_id in (${sql.join(employmentIds.map(id=>sql`${id}::uuid`),sql`,`)})
   and exists(select 1 from public.payroll_status_history u where u.batch_id=h.batch_id and u.action='unlock' and u.created_at<h.created_at)
   ${known?sql`and h.created_at<${known}::timestamptz`:sql``}`) as unknown as {employment_id:string;batch_id:string}[]);
 for(const row of reprocessed)corrections.add(key(row.employment_id,periodOf(row.batch_id)));
 // The salary's owner: each person's current salary records (a superseded record was replaced, never in force).
 const salaries=await tx.select({employmentId:compensation.employmentId,validFrom:compensation.validFrom,basicSalary:compensation.basicSalary}).from(compensation)
  .where(and(inArray(compensation.employmentId,employmentIds),isNull(compensation.supersededAt),
   known?sql`${compensation.recordedAt}<${known}::timestamptz`:undefined));
 const salaryRecords=new Map<string,{validFrom:string;basicSalary:unknown}[]>();
 for(const row of salaries)salaryRecords.set(row.employmentId,[...(salaryRecords.get(row.employmentId)??[]),{validFrom:String(row.validFrom),basicSalary:row.basicSalary}]);
 const salaryFrom=new Map<string,string>();
 for(const [employmentId,records] of salaryRecords){const at=salaryChangeFrom(records,options.asOf);if(at)salaryFrom.set(employmentId,at);}
 // Each person's first and last month with the company, from the employment's own dates.
 const dates=await tx.select({id:employment.id,hiredOn:employment.hiredOn,joinDate:employment.joinDate,terminatedOn:employment.terminatedOn}).from(employment)
  .where(inArray(employment.id,employmentIds));
 const tenure=new Map<string,{first:string;last:string|null}>();
 for(const row of dates){const first=monthOf(row.joinDate)??monthOf(row.hiredOn);if(first)tenure.set(row.id,{first,last:monthOf(row.terminatedOn)});}
 const months=personMonths(rows,{problemSwings:new Set(swings.map(row=>key(row.employmentId,row.payPeriod))),
  fixedUpstream:new Set(fixes.map(row=>key(row.employmentId,periodOf(row.batchId)))),corrections,salaryFrom,tenure});
 return Object.freeze({companyId:options.companyId,asOf:options.asOf,from,latestClosed,months});
}
