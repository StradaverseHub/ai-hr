/** Read recorded paid results. Today's pay-item catalogue and company settings are deliberately absent. */
import { payrollAmountMinor, payrollMinorDecimal } from './payroll-period-comparison';
import {isCalendarDate} from './calendar-date';
import type {ComparisonSource,ComparisonRun} from './payroll-comparison-result';
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** A transfer can create two employer rows in the same month. Each row's dated context belongs to
 * its own last recorded payroll-ownership day, not automatically the selected month's final day.
 * Prefer the current side where present, retaining previous-only leavers and exact employer identity. */
export function payrollComparisonDatedSubjects(sources:readonly Pick<ComparisonSource,'employmentId'|'companyId'|'runId'|'coverage'|'proratedCoverage'>[],
 runs:readonly Pick<ComparisonRun,'id'|'period'>[],previousPeriod:string,currentPeriod:string){
 const periods=new Map(runs.map(run=>[run.id,run.period]));
 const subjects=new Map<string,{employmentId:string;companyId:string;date:string;side:number}>();
 for(const source of sources){
  const period=periods.get(source.runId),side=period===currentPeriod?2:period===previousPeriod?1:0;
  if(!side||!isCalendarDate(source.coverage.from)||!isCalendarDate(source.coverage.to)||source.coverage.from>source.coverage.to||source.coverage.from.slice(0,7)!==period||source.coverage.to.slice(0,7)!==period)
   throw Error('Recorded payroll ownership dates are unavailable for this comparison.');
  const paid=source.proratedCoverage;
  if(paid){
   const window=paid.windowFrom!==undefined||paid.windowTo!==undefined;
   if(!isCalendarDate(paid.from)||!isCalendarDate(paid.to)||paid.from>paid.to||
    (window?typeof paid.windowFrom!=='string'||typeof paid.windowTo!=='string'||!isCalendarDate(paid.windowFrom)||!isCalendarDate(paid.windowTo)||paid.windowFrom>paid.from||paid.to>paid.windowTo:
     paid.from<source.coverage.from||paid.to>source.coverage.to))
    throw Error('Recorded paid-tenure evidence is unavailable.');
  }
  const key=source.employmentId+'|'+source.companyId,old=subjects.get(key),date=paid&&paid.to>=source.coverage.from&&paid.to<source.coverage.to?paid.to:source.coverage.to;
  if(!old||side>old.side||side===old.side&&date>old.date)subjects.set(key,{employmentId:source.employmentId,companyId:source.companyId,date,side});
 }
 return [...subjects.values()].sort((a,b)=>a.employmentId.localeCompare(b.employmentId)||a.companyId.localeCompare(b.companyId)).map(({side,...subject})=>subject);
}

export function recordedPayrollComparisonCurrency(statutory: unknown, companyId: string): string | null {
  const stamp = object(object(statutory)?.reportContext);
  return stamp?.version === 1 && stamp.payingCompanyId === companyId &&
    typeof stamp.currency === 'string' && /^[A-Z]{3}$/.test(stamp.currency) ? stamp.currency : null;
}
/** Recorded lines establish their own amounts. Only an explicit complete-itemization stamp proves that
 * an absent code paid zero: legacy arrays may contain just formula OT while other pay has no item code. */
export function recordedPayrollComparisonAmount(basicSalary: string, statutory: unknown, code: string, companyId?:string): string | null {
  if (code === 'BASIC') return payrollMinorDecimal(payrollAmountMinor(basicSalary));
  const lines = object(statutory)?.componentLines;
  if (!Array.isArray(lines)) return null;
  let amount = BigInt('0'),matched=false;
  for (const entry of lines) {
    const line = object(entry);
    if (!line || typeof line.code !== 'string') return null;
    if (line.code !== code) continue;
    matched=true;
    try { amount += payrollAmountMinor(line.amount); } catch { return null; }
  }
  const stamp=object(object(statutory)?.reportContext);
  const complete=companyId!==undefined&&stamp?.version===1&&stamp.payingCompanyId===companyId&&stamp.itemization==='complete';
  return matched||complete?payrollMinorDecimal(amount):null;
}

/** Employer-owned coverage is not paid tenure. Read only the calculation's explicit monthly evidence. */
export function recordedPayrollProrationCoverage(statutory:unknown,companyId:string,period:{from:string;to:string},payItemCode:string):{from:string;to:string;windowFrom:string;windowTo:string}|undefined{
  if(payItemCode!=='BASIC')return;
  const stamp=object(object(statutory)?.reportContext),proof=object(stamp?.proration),window=object(proof?.window);
  if(stamp?.version!==1||stamp.payingCompanyId!==companyId||!proof||proof.payMode!=='monthly'||typeof proof.factor!=='number'||!Number.isFinite(proof.factor)||proof.factor<0||proof.factor>=1)return;
  const valid=(value:unknown):value is string=>typeof value==='string'&&isCalendarDate(value);
  if(!window||!valid(proof.from)||proof.to!==null&&!valid(proof.to)||!valid(window.from)||!valid(window.to))return;
  const windowFrom=window.from,windowTo=window.to;
  if(windowFrom>windowTo||windowTo<period.from||windowTo>period.to||(Date.parse(windowTo+'T00:00:00Z')-Date.parse(windowFrom+'T00:00:00Z'))/86400000>366)return;
  const from=proof.from>windowFrom?proof.from:windowFrom,to=proof.to&&proof.to<windowTo?proof.to:windowTo;
  if(from>to||from===windowFrom&&to===windowTo)return;
  return {from,to,windowFrom,windowTo};
}
