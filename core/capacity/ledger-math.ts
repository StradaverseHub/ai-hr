/** AI v2 Phase 2, P2-4 — the HR capacity ledger's arithmetic. Pure: no database, no clock, no model.
 *
 * HOURS FREED = items done x the company's own manual minutes per item (its baseline) - the review time people spent.
 *
 * REVIEW TIME is measured per item from the records: the time between AI Centre preparing the item and a person
 * confirming it, capped. The cap is the smaller of REVIEW_CAP_MINUTES and the item's own manual minutes:
 *  - a longer gap means the item waited, not that someone worked on it for that long;
 *  - reviewing a prepared item never counts as costing more than doing it by hand, so no item frees negative time.
 * A loop records the confirmation when it next checks, so most gaps reach the cap: the ledger then under-states the time
 * freed rather than over-states it. Work with no confirmation step (an employee question AI Centre answered) has no
 * review time.
 *
 * Every figure is minutes, counts and calendar dates. No staff-to-employee ratio is computed or returned (owner rule). */
import {CAPACITY_ITEMS,type CapacityBaselineItems,type CapacityItem,type CapacityPeriod} from './types';

export const REVIEW_CAP_MINUTES=15;
/** "About N working days": hours / WORKING_DAY_HOURS. */
export const WORKING_DAY_HOURS=8;
/** The chart shows at least this many months, ending with the current month. */
export const CHART_MIN_MONTHS=6;

export function reviewMinutes(gapMinutes:number,baselineMinutes:number):number{
 const gap=Number.isFinite(gapMinutes)?Math.max(0,gapMinutes):REVIEW_CAP_MINUTES;
 return Math.min(gap,REVIEW_CAP_MINUTES,Math.max(0,baselineMinutes));
}

const DATE=/^\d{4}-\d{2}-\d{2}$/;
const isDate=(value:string)=>DATE.test(value)&&!Number.isNaN(Date.parse(value+'T00:00:00Z'));
export function addDays(date:string,days:number):string{
 if(!isDate(date))throw new RangeError('Not a calendar date: '+date);
 return new Date(Date.parse(date+'T00:00:00Z')+days*86_400_000).toISOString().slice(0,10);
}
/** The instant a Malaysia calendar day starts (Malaysia keeps +08:00 all year). */
export const malaysiaDayStart=(date:string)=>{if(!isDate(date))throw new RangeError('Not a calendar date: '+date);return new Date(date+'T00:00:00+08:00');};

/** First day (inclusive) of a ledger period, for `today` in Malaysia. */
export function periodStartDate(period:CapacityPeriod,today:string):string{
 if(!isDate(today))throw new RangeError('Not a calendar date: '+today);
 const [y,m]=today.split('-').map(Number);
 if(period==='last30')return addDays(today,-29);
 if(period==='quarter')return `${y}-${String(Math.floor((m-1)/3)*3+1).padStart(2,'0')}-01`;
 return `${y}-01-01`;
}

/** The chart's months, oldest first, ending with today's month: this year's months for "This year", and never fewer
 * than CHART_MIN_MONTHS. */
export function chartMonths(period:CapacityPeriod,today:string):string[]{
 if(!isDate(today))throw new RangeError('Not a calendar date: '+today);
 const [y,m]=today.split('-').map(Number);
 const count=Math.max(CHART_MIN_MONTHS,period==='year'?m:0);
 const out:string[]=[];
 for(let i=count-1;i>=0;i--){const index=y*12+(m-1)-i;out.push(`${Math.floor(index/12)}-${String(index%12+1).padStart(2,'0')}`);}
 return out;
}

/** One company's work of one item on one Malaysia calendar day. `gaps`: minutes from preparation to confirmation, one
 * per item done, or null for work that has no confirmation step. */
export type WorkFact=Readonly<{companyId:string;item:CapacityItem;date:string;count:number;changed:number;gaps:readonly number[]|null}>;
export type BaselineFact=Readonly<{companyId:string;items:CapacityBaselineItems}>;
export type CountFact=Readonly<{companyId:string;date:string;count:number}>;
export type LedgerInput=Readonly<{
 /** First day of the period (inclusive); work on later days up to today counts. */
 periodFrom:string;months:readonly string[];companyIds:readonly string[];baselines:readonly BaselineFact[];work:readonly WorkFact[];
 /** null: not shown to this viewer (payroll is not in use, or they may not read it). */
 payrollErrors:readonly CountFact[]|null;
 /** Whether question and confirmed-action counts were readable for this viewer. */
 outcomesVisible:boolean;
}>;
export type LedgerRow=Readonly<{item:CapacityItem;done:number;manualMinutes:number;reviewMinutes:number;freedMinutes:number;
 /** Done in a company whose baseline has no minutes for this item: counted as done, freeing no time. */
 withoutBaseline:number}>;
export type Ledger=Readonly<{
 /** null when no company in scope has a baseline. */
 freedMinutes:number|null;
 loopActions:Readonly<{done:number;changed:number}>;
 questions:number|null;payrollErrors:number|null;
 rows:readonly LedgerRow[];months:readonly Readonly<{month:string;freedMinutes:number}>[];
 companiesWithoutBaseline:readonly string[];
}>;

const isLoop=(item:CapacityItem)=>item.startsWith('loop_');

/** Minutes freed and reviewed by one fact under its company's baseline; null when the baseline has no such item. */
export function factMinutes(fact:WorkFact,baseline:CapacityBaselineItems|undefined){
 const each=baseline?.[fact.item]?.minutes;
 if(each==null||!Number.isFinite(each)||each<0)return null;
 const review=fact.gaps===null?0:fact.gaps.reduce((sum,gap)=>sum+reviewMinutes(gap,each),0);
 const manual=fact.count*each;
 return {manual,review,freed:manual-review};
}

export function computeLedger(input:LedgerInput):Ledger{
 const scope=new Set(input.companyIds);
 const baselines=new Map(input.baselines.filter(row=>scope.has(row.companyId)).map(row=>[row.companyId,row.items]));
 const rows=new Map<CapacityItem,{done:number;manualMinutes:number;reviewMinutes:number;freedMinutes:number;withoutBaseline:number}>();
 const months=new Map(input.months.map(month=>[month,0]));
 let freed=0,loopDone=0,loopChanged=0,questions=0;
 for(const fact of input.work){
  if(!scope.has(fact.companyId)||fact.count<=0)continue;
  if(fact.gaps!==null&&fact.gaps.length!==fact.count)throw new RangeError('A work fact needs one gap per item.');
  const minutes=factMinutes(fact,baselines.get(fact.companyId));
  const month=fact.date.slice(0,7);
  if(minutes&&months.has(month))months.set(month,months.get(month)!+minutes.freed);
  if(fact.date<input.periodFrom)continue;
  const row=rows.get(fact.item)??{done:0,manualMinutes:0,reviewMinutes:0,freedMinutes:0,withoutBaseline:0};
  row.done+=fact.count;
  if(minutes){row.manualMinutes+=minutes.manual;row.reviewMinutes+=minutes.review;row.freedMinutes+=minutes.freed;freed+=minutes.freed;}
  else row.withoutBaseline+=fact.count;
  rows.set(fact.item,row);
  if(isLoop(fact.item)){loopDone+=fact.count;loopChanged+=fact.changed;}
  if(fact.item==='questions_answered')questions+=fact.count;
 }
 const order=(item:CapacityItem)=>CAPACITY_ITEMS.indexOf(item);
 return Object.freeze({
  freedMinutes:baselines.size?freed:null,
  loopActions:Object.freeze({done:loopDone,changed:loopChanged}),
  questions:input.outcomesVisible?questions:null,
  payrollErrors:input.payrollErrors===null?null:input.payrollErrors.filter(row=>scope.has(row.companyId)&&row.date>=input.periodFrom).reduce((sum,row)=>sum+row.count,0),
  rows:Object.freeze([...rows].map(([item,row])=>Object.freeze({item,...row}))
   .sort((a,b)=>b.freedMinutes-a.freedMinutes||b.done-a.done||order(a.item)-order(b.item))),
  months:Object.freeze([...months].map(([month,freedMinutes])=>Object.freeze({month,freedMinutes}))),
  companiesWithoutBaseline:Object.freeze(input.companyIds.filter(id=>!baselines.has(id))),
 });
}

/** Minutes to hours, one decimal, for display. */
export const hoursOf=(minutes:number)=>Math.round(minutes/6)/10;
