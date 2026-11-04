/** Payroll history learning, P1 — the baseline maths. PURE: no session, no database, no clock, no model.
 *
 * ══ THE OWNER RULE ══
 *
 * "Nothing learned does money maths through the model." Every figure here is integer sen, taken from the effective
 * payslips of closed runs (./history.ts turns each into sen once, from the payroll owner's own figures), and every
 * statistic is an observed value: the median and the P10 and P90 are NEAREST-RANK order statistics (the value at rank
 * ceil(p·n/100) of the sorted values; the median is p = 50, the lower median when n is even), so nothing is averaged,
 * interpolated or rounded. A model only ever words the result as a band; it never computes or changes one.
 *
 * Per person, per basis (regular: the regular run of each month; month_total: every run of the month added up; bonus:
 * the bonus runs of the months that had one) and per component (the payslip's own lines and the pay items, ./history.ts):
 *  - n: the clean months it rests on; nonZero: of them, the months the component was paid; monthMask: the calendar months
 *    (bit m-1 for month m) it was paid in; fixed: the same non-zero amount in every month of at least 3;
 *  - median, p10, p90.
 * Status (owner decision of 4 November 2026: evidence lines from 3 runs; a learned "normal" may hide a flag only from a
 * stable baseline of 6 or more, phase P4):
 *  - none: fewer than 3 clean months; rebasing: fewer than 3 because a salary change set the earlier months aside;
 *  - provisional: 3 to 5; stable: 6 or more;
 *  - contradicted: at least 5, and the two latest months' net pay both above (or both below) the range of the months
 *    before them: the person's pay has moved and the earlier range no longer describes it.
 * Only provisional and stable baselines ever give an evidence line (./evidence.ts); none of them hides anything. */
import type {BaselineStatus,ComponentStats} from '../../db/payroll-learning-schema';

export const BASELINE_METHOD='payroll_baseline@v1' as const;
/** Evidence lines appear from this many clean closed runs (owner decision, 4 November 2026). */
export const EVIDENCE_MIN_RUNS=3;
/** A baseline is stable, and (phase P4) may hide a flag, from this many (owner decision, 4 November 2026). */
export const STABLE_MIN_RUNS=6;
/** Contradicted needs at least this many: three before the two latest. */
export const CONTRADICTION_MIN_RUNS=5;
/** The months a baseline looks back over, before its as-of month. */
export const WINDOW_MONTHS=24;
/** At most this many pay items per basis (the payslip lines are always kept). */
export const MAX_PAY_ITEMS=32;

const assertSen=(value:number)=>{if(!Number.isSafeInteger(value))throw new RangeError('A learned figure must be a whole number of sen.');return value;};

/** The value at nearest rank ceil(p·n/100) of `sorted` (ascending, non-empty), for p in 1..100, in integer arithmetic. */
export function nearestRank(sorted:readonly number[],p:number):number{
 if(!sorted.length)throw new RangeError('No values.');
 if(!Number.isInteger(p)||p<1||p>100)throw new RangeError('A percentile is a whole number from 1 to 100.');
 const rank=Math.max(1,Math.floor((p*sorted.length+99)/100));
 return sorted[Math.min(rank,sorted.length)-1];
}

/** One component's statistics over the clean months, in period order (each value integer sen; month 1..12). */
export function componentStats(values:readonly Readonly<{month:number;sen:number}>[]):ComponentStats{
 const sen=values.map(value=>assertSen(value.sen));
 const sorted=[...sen].sort((a,b)=>a-b);
 const n=sen.length,nonZero=sen.filter(value=>value!==0).length;
 let monthMask=0;
 for(const value of values){if(!Number.isInteger(value.month)||value.month<1||value.month>12)throw new RangeError('A month is 1 to 12.');if(value.sen!==0)monthMask|=1<<(value.month-1);}
 if(!n)return Object.freeze({n:0,median:0,p10:0,p90:0,nonZero:0,monthMask:0,fixed:false});
 return Object.freeze({n,median:nearestRank(sorted,50),p10:nearestRank(sorted,10),p90:nearestRank(sorted,90),nonZero,monthMask,
  fixed:n>=3&&nonZero===n&&sorted[0]===sorted[n-1]});
}

/** Whether the two latest values both sit outside the nearest-rank P10–P90 range of the values before them, on one side. */
export function contradicted(ordered:readonly number[]):boolean{
 if(ordered.length<CONTRADICTION_MIN_RUNS)return false;
 const earlier=[...ordered.slice(0,-2)].sort((a,b)=>a-b),last=ordered.slice(-2);
 const low=nearestRank(earlier,10),high=nearestRank(earlier,90);
 return last.every(value=>value>high)||last.every(value=>value<low);
}

/** The status of a baseline over `runs` clean months, the main figure's values in period order, and whether a salary
 * change set earlier months aside. */
export function baselineStatus(input:Readonly<{runs:number;mainOrdered:readonly number[];rebased:boolean}>):BaselineStatus{
 if(input.runs<EVIDENCE_MIN_RUNS)return input.rebased?'rebasing':'none';
 if(contradicted(input.mainOrdered))return 'contradicted';
 return input.runs>=STABLE_MIN_RUNS?'stable':'provisional';
}

export type Judgement='within'|'above'|'below';
/** Where a value (integer sen) sits against a component's learned range: below P10, above P90, or within (inclusive). */
export function judge(value:number,stats:Pick<ComponentStats,'p10'|'p90'>):Judgement{
 assertSen(value);
 return value<stats.p10?'below':value>stats.p90?'above':'within';
}
/** Only these statuses give an evidence line. */
export const givesEvidence=(status:BaselineStatus)=>status==='provisional'||status==='stable';

/** RM figures as the payroll owner stores them (numeric text or number, two decimals) to integer sen, exactly. */
export function toSen(value:unknown):number{
 const text=typeof value==='number'?value.toFixed(2):typeof value==='string'?value.trim():'';
 const match=/^(-)?(\d{1,13})(?:\.(\d{1,2}))?$/.exec(text);
 if(!match)return 0;
 const sen=Number(match[2])*100+Number((match[3]??'').padEnd(2,'0'));
 return assertSen(match[1]?-sen:sen);
}

// ── The small-group rule (the AI read, ./status.ts) ──

/** Counts under this many people are never given to the model. */
export const SMALL_GROUP_MINIMUM=5;
/** Suppresses every count from 1 to SMALL_GROUP_MINIMUM−1, and then complementary cells: while exactly one cell of the
 * row is suppressed, the smallest remaining non-zero cell is suppressed too, so no suppressed count can be worked out
 * from a total read elsewhere. Zero is shown (nobody is not a small group). Keys keep their order. */
export function suppressSmallCounts<K extends string>(counts:Readonly<Record<K,number>>,minimum=SMALL_GROUP_MINIMUM):Readonly<Record<K,number|null>>{
 const keys=Object.keys(counts) as K[];
 for(const key of keys)if(!Number.isSafeInteger(counts[key])||counts[key]<0)throw new RangeError('A count is a whole number.');
 const hidden=new Set<K>(keys.filter(key=>counts[key]>0&&counts[key]<minimum));
 if(hidden.size===1){
  const next=keys.filter(key=>!hidden.has(key)&&counts[key]>0).sort((a,b)=>counts[a]-counts[b]||keys.indexOf(a)-keys.indexOf(b))[0];
  if(next!==undefined)hidden.add(next);
 }
 return Object.freeze(Object.fromEntries(keys.map(key=>[key,hidden.has(key)?null:counts[key]]))) as Readonly<Record<K,number|null>>;
}
