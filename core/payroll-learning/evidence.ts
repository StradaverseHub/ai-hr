/** Payroll history learning, P2 — the evidence lines: "Usual for this person: within / above / below range from N runs".
 *
 * Shown to payroll HR on the Salary payroll loop's page (each net-swing flag: the person's net pay for the month, all the
 * month's runs added up, against their month_total baseline) and in a run's anomaly queue (each person's net pay in the run
 * against their regular or bonus baseline, by the run's type). Payroll HR may see the exact range there.
 *
 * Rules:
 *  - only for a company whose learning mode is evidence or classify (./mode.ts): off shows nothing, whatever is stored;
 *  - only from a provisional or stable baseline (3 clean closed runs or more, owner decision of 4 November 2026); none,
 *    rebasing (after a salary change) and contradicted (the latest pay has moved) give no line;
 *  - NO LOOK-AHEAD: the baseline is the latest one whose as-of month is the period itself or earlier, so every month it
 *    rests on is before the period being judged;
 *  - read under the viewer's own row-level security: baselines are a payroll administrator's read only (migration 2012),
 *    payslips the effective ones only. Another company, another tenant, an employee and the agent principal get nothing.
 * The figures are integer sen: the period's own payslip figures added up in sen and the baseline's stored P10 and P90;
 * the judgement is ./baseline-math.ts judge. A line explains; it never changes a flag, a check, a figure or a severity. */
import {and,eq,inArray,sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../../db/client';
import {payrollBatch,payrollCycle,payslip} from '../../db/schema';
import type {ComponentStats,LearningBasis} from '../../db/payroll-learning-schema';
import {givesEvidence,judge,toSen,type Judgement} from './baseline-math';
import {learningModesTx} from './mode';

export type Evidence=Readonly<{basis:LearningBasis;judgement:Judgement;runs:number;status:'provisional'|'stable';
 /** The person's usual range, P10 to P90, in sen. */
 low:number;high:number;
 /** The figure judged, in sen (the person's net pay for the period or the run). */
 value:number}>;

const PERIOD=/^\d{4}-(0[1-9]|1[0-2])$/;
const isStats=(value:unknown):value is ComponentStats=>!!value&&typeof value==='object'&&['n','p10','p90'].every(key=>Number.isSafeInteger((value as Record<string,unknown>)[key]));

/** The latest baseline of each person for one basis with an as-of month no later than `period`: its status, runs and net. */
async function baselinesTx(tx:Tx,tenantId:string,input:Readonly<{companyIds:readonly string[];employmentIds:readonly string[];basis:LearningBasis;period:string}>){
 if(!input.companyIds.length||!input.employmentIds.length)return new Map<string,{status:string;runs:number;net:unknown}>();
 const rows=await tx.execute(sql`select distinct on (b.employment_id) b.employment_id,b.status,b.runs,b.components->'net' as net from public.payroll_learned_baseline b
  where b.tenant_id=${tenantId}::uuid and b.basis=${input.basis} and b.as_of_period<=${input.period}
   and b.company_id in (${sql.join(input.companyIds.map(id=>sql`${id}::uuid`),sql`,`)})
   and b.employment_id in (${sql.join(input.employmentIds.map(id=>sql`${id}::uuid`),sql`,`)})
  order by b.employment_id,b.as_of_period desc,b.version desc`) as unknown as {employment_id:string;status:string;runs:number;net:unknown}[];
 return new Map(Array.from(rows).map(row=>[row.employment_id,row]));
}
function evidenceOf(basis:LearningBasis,stored:{status:string;runs:number;net:unknown}|undefined,value:number|undefined):Evidence|null{
 if(!stored||value===undefined||!givesEvidence(stored.status as never)||!isStats(stored.net))return null;
 return Object.freeze({basis,judgement:judge(value,stored.net),runs:stored.runs,status:stored.status as 'provisional'|'stable',low:stored.net.p10,high:stored.net.p90,value});
}
const viewer=(ctx:SessionContext)=>!!ctx.userId&&!ctx.agent;
async function learningCompaniesTx(tx:Tx,tenantId:string,companyIds:readonly string[]){
 const modes=await learningModesTx(tx,tenantId,companyIds);
 return [...modes.values()].filter(row=>row.mode==='evidence'||row.mode==='classify').map(row=>row.companyId);
}

/** Evidence for the Salary payroll page's net-swing flags of one month: by employment. */
export async function swingFlagEvidence(ctx:SessionContext,input:Readonly<{period:string;flags:readonly Readonly<{companyId:string;employmentId:string|null}>[]}>):Promise<ReadonlyMap<string,Evidence>>{
 const flags=input.flags.filter((flag):flag is {companyId:string;employmentId:string}=>!!flag.employmentId);
 if(!viewer(ctx)||!PERIOD.test(input.period)||!flags.length)return new Map();
 return withTenant(ctx,async tx=>{
  const companies=await learningCompaniesTx(tx,ctx.tenantId,[...new Set(flags.map(flag=>flag.companyId))]);
  const people=[...new Set(flags.filter(flag=>companies.includes(flag.companyId)).map(flag=>flag.employmentId))];
  if(!people.length)return new Map();
  const stored=await baselinesTx(tx,ctx.tenantId,{companyIds:companies,employmentIds:people,basis:'month_total',period:input.period});
  if(!stored.size)return new Map();
  // The month's net pay, every processed or closed run of it added up, as the net-swing flag compares months.
  const slips=await tx.select({employmentId:payslip.employmentId,net:payslip.netPay}).from(payslip).innerJoin(payrollBatch,eq(payrollBatch.id,payslip.batchId))
   .where(and(inArray(payrollBatch.companyId,companies),eq(payrollBatch.payPeriod,input.period),inArray(payrollBatch.status,['processed','closed']),
    inArray(payslip.employmentId,[...stored.keys()]),sql`app.payroll_history_effective(${payslip.id})`));
  const totals=new Map<string,number>();
  for(const slip of slips)totals.set(slip.employmentId,(totals.get(slip.employmentId)??0)+toSen(slip.net));
  const out=new Map<string,Evidence>();
  for(const [employmentId,row] of stored){const evidence=evidenceOf('month_total',row,totals.get(employmentId));if(evidence)out.set(employmentId,evidence);}
  return out;
 });
}

/** Evidence for one run's anomaly queue: each person's net pay in the run against their baseline of the run's type
 * (regular or bonus; an imported month by its cycle's type). Off-cycle and adjustment runs have none. */
export async function runEvidence(ctx:SessionContext,input:Readonly<{batchId:string}>):Promise<ReadonlyMap<string,Evidence>>{
 if(!viewer(ctx)||!/^[0-9a-f-]{36}$/i.test(input.batchId))return new Map();
 return withTenant(ctx,async tx=>{
  const [batch]=await tx.select({companyId:payrollBatch.companyId,payPeriod:payrollBatch.payPeriod,runType:payrollBatch.runType,
   imported:sql<boolean>`${payrollBatch.historyImportAttemptId} is not null`,cycleRunType:payrollCycle.runType}).from(payrollBatch)
   .leftJoin(payrollCycle,eq(payrollCycle.id,payrollBatch.payrollCycleId)).where(eq(payrollBatch.id,input.batchId)).limit(1);
  if(!batch)return new Map();
  const type=batch.imported?(batch.cycleRunType??'regular'):batch.runType;
  if(type!=='regular'&&type!=='bonus')return new Map();
  const companies=await learningCompaniesTx(tx,ctx.tenantId,[batch.companyId]);
  if(!companies.length)return new Map();
  const slips=await tx.select({employmentId:payslip.employmentId,net:payslip.netPay}).from(payslip)
   .where(and(eq(payslip.batchId,input.batchId),sql`app.payroll_history_effective(${payslip.id})`));
  if(!slips.length)return new Map();
  const values=new Map<string,number>();
  for(const slip of slips)values.set(slip.employmentId,(values.get(slip.employmentId)??0)+toSen(slip.net));
  const stored=await baselinesTx(tx,ctx.tenantId,{companyIds:companies,employmentIds:[...values.keys()],basis:type,period:batch.payPeriod});
  const out=new Map<string,Evidence>();
  for(const [employmentId,row] of stored){const evidence=evidenceOf(type,row,values.get(employmentId));if(evidence)out.set(employmentId,evidence);}
  return out;
 });
}
