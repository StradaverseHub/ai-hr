/** Payroll history learning, P1 — from one person's clean closed months to their baselines. PURE: no session, database,
 * clock or model.
 *
 * Input: the person's months as ./history.ts read them (closed runs only, months before the as-of month only, effective
 * payslips only), each month with its runs and the reasons, if any, it is set aside. Output: one baseline per basis:
 *  - regular: the month's regular run (an imported month counts by its payroll cycle's run type);
 *  - month_total: every run of the month added up, as the Salary payroll loop's net swing compares months;
 *  - bonus: the month's bonus runs, in the months that had one.
 * A month set aside for any reason (./history.ts MONTH_EXCLUSIONS) is not learned from in any basis; it counts as
 * excluded. Each component's values are integer sen, worked once per payslip from the payroll owner's own readers
 * (core/pay-difference.ts payslipLineFigures, the payslip's own pay item lines) and added up per month in sen; the
 * statistics are ./baseline-math.ts's. */
import type {BaselineStatus,ComponentStats,LearningBasis} from '../../db/payroll-learning-schema';
import {payslipLineFigures,type PayslipFigureRow} from '../pay-difference';
import {payItemLinesForBuckets,storedComponentLines,type EarningBucket} from '../payslip-earning-lines';
import {importedPayItemLines} from '../payslip-imported-lines';
import {MAX_PAY_ITEMS,baselineStatus,componentStats,toSen} from './baseline-math';

export const LEARNING_BASES:readonly LearningBasis[]=Object.freeze(['regular','month_total','bonus']);
/** The payslip's own lines learned in every basis, net first. Net and gross are always kept; the others when paid. */
export const LEARNED_LINES=Object.freeze(['net','gross','totalDeductions','basic','allowance','overtime','bonus','claim'] as const);
export type LearnedLine=(typeof LEARNED_LINES)[number];
export const MONTH_EXCLUSIONS=Object.freeze(['problem_swing','fixed_upstream','correction','manual_figure','before_salary_change',
 // A part month is usual for nobody: the person's first and last month with the company, and a month with an unpaid-leave,
 // absence or proration line (coordinator review, 4 November 2026).
 'first_month','last_month','part_month'] as const);
export type MonthExclusion=(typeof MONTH_EXCLUSIONS)[number];
export type LearningRunType='regular'|'bonus'|'off_cycle'|'adjustment';

/** One effective payslip of one closed run. `runType` is the run's behavioural type (an imported month's cycle type). */
export type LearningRow=Readonly<{employmentId:string;batchId:string;payPeriod:string;runType:LearningRunType;imported:boolean;
 figures:PayslipFigureRow}>;
export type LearningMonth=Readonly<{period:string;rows:readonly LearningRow[];excluded:readonly MonthExclusion[]}>;
export type LearnedBaseline=Readonly<{basis:LearningBasis;status:BaselineStatus;runs:number;excluded:number;throughPeriod:string|null;
 components:Readonly<Record<string,ComponentStats>>}>;

const PAY_ITEM_BUCKETS:readonly EarningBucket[]=['wage','reimburse','ot','bonus'];
const basisRows=(basis:LearningBasis,rows:readonly LearningRow[])=>basis==='month_total'?rows:rows.filter(row=>row.runType===basis);

/** One payslip's learned values in sen: its lines, and its pay items keyed item:<pay component id> (a code that is not
 * exactly one catalogued component is left out, as the net-swing pattern leaves it). */
export function rowValues(row:LearningRow,componentIds:ReadonlyMap<string,string>):Map<string,number>{
 const out=new Map<string,number>();
 const shown=payslipLineFigures(row.figures);
 // Net, gross and total deductions straight from the stored columns, so nothing passes through a float.
 out.set('net',toSen(row.figures.net));out.set('gross',toSen(row.figures.gross));out.set('totalDeductions',toSen(row.figures.totalDeductions));
 for(const key of ['basic','allowance','overtime','bonus','claim'] as const)out.set(key,toSen(shown[key]));
 // Each month's lines in their own place: a kernel run's componentLines, an imported month's importedLines.
 const lines=row.imported?importedPayItemLines(row.figures.statutory):storedComponentLines(row.figures.statutory);
 for(const line of payItemLinesForBuckets(lines,PAY_ITEM_BUCKETS)){
  const code=(line.code??'').trim(),id=code?componentIds.get(code):undefined;
  if(!id)continue;
  const key=`item:${id}`;
  out.set(key,(out.get(key)??0)+toSen(line.amount));
 }
 return out;
}

/** A person's baselines for every basis, from their months in period order (all before the as-of month). */
export function learnBaselines(months:readonly LearningMonth[],componentIds:ReadonlyMap<string,string>):Readonly<Record<LearningBasis,LearnedBaseline>>{
 const ordered=[...months].sort((a,b)=>a.period.localeCompare(b.period));
 const out={} as Record<LearningBasis,LearnedBaseline>;
 for(const basis of LEARNING_BASES){
  const candidates=ordered.filter(month=>basisRows(basis,month.rows).length>0);
  const included=candidates.filter(month=>month.excluded.length===0);
  const rebased=candidates.some(month=>month.excluded.includes('before_salary_change'));
  const perMonth=included.map(month=>{
   const sum=new Map<string,number>();
   for(const row of basisRows(basis,month.rows))for(const [key,sen] of rowValues(row,componentIds))sum.set(key,(sum.get(key)??0)+sen);
   return {month:Number(month.period.slice(5,7)),values:sum};
  });
  const keys=new Set<string>(['net','gross']);
  for(const {values} of perMonth)for(const [key,sen] of values)if(sen!==0)keys.add(key);
  const stats=new Map<string,ComponentStats>();
  for(const key of keys)stats.set(key,componentStats(perMonth.map(({month,values})=>({month,sen:values.get(key)??0}))));
  // The payslip lines are always kept; the pay items, the largest first, up to the cap.
  const lines=[...keys].filter(key=>!key.startsWith('item:')).sort((a,b)=>LEARNED_LINES.indexOf(a as LearnedLine)-LEARNED_LINES.indexOf(b as LearnedLine));
  const items=[...keys].filter(key=>key.startsWith('item:'))
   .sort((a,b)=>Math.abs(stats.get(b)!.median)-Math.abs(stats.get(a)!.median)||a.localeCompare(b)).slice(0,MAX_PAY_ITEMS).sort();
  const components=Object.freeze(Object.fromEntries([...lines,...items].map(key=>[key,stats.get(key)!])));
  const status=baselineStatus({runs:included.length,mainOrdered:perMonth.map(({values})=>values.get('net')??0),rebased});
  out[basis]=Object.freeze({basis,status,runs:included.length,excluded:candidates.length-included.length,
   throughPeriod:included.length?included[included.length-1].period:null,components});
 }
 return Object.freeze(out);
}
