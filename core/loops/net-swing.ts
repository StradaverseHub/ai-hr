/** AI v2 P2-2a — the Salary payroll loop's change against last month, per person, by cause, and its net-swing flag.
 *
 * PURE. Every figure is the pay-difference service's (core/pay-difference.ts comparePayPeriods): a month's runs added up
 * (a regular run and its bonus or off-cycle runs together) and the previous paid month subtracted, with the causes the
 * runs recorded. This module adds one comparison of its own and nothing else: the size of the net change as a share of
 * the previous month's net pay, in basis points (1500 = 15%), against the company's threshold. It never computes,
 * changes or proposes a figure of pay.
 *
 * A person's PATTERN names what moved their pay most, so payroll HR's dispositions can be grouped by it
 * (core/loops/swing-proposals.ts): the pay item whose own change is at least half of the net change (item:<code>), else
 * the first cause the runs recorded (cause:<kind>), else cause:other. An EXCLUDED pattern (approved by an administrator)
 * does not raise a flag while the change left after that item's own change is within the threshold; an excluded cause
 * does not raise one at all. A person paid in only one of the two months, or whose previous net pay was not positive, has
 * no ratio and is never flagged (they are listed as changed). */
import {comparePayPeriods,PAY_CAUSE_KINDS,type PayCauseKind,type StoredPayslipRow} from '../pay-difference';

export const DEFAULT_SWING_THRESHOLD_BP=1500;
export const SWING_PATTERN_RE=/^(cause:[a-z_]{1,40}|item:[A-Za-z0-9_.-]{1,40})$/;
export const isSwingPattern=(value:unknown):value is string=>typeof value==='string'&&SWING_PATTERN_RE.test(value);

export type SwingPerson=Readonly<{employmentId:string;
 /** Whether the person's net pay differs from the previous paid month. */
 changed:boolean;
 /** |net change| / previous net, in basis points; null when there is no ratio (see the header). */
 swingBp:number|null;direction:'up'|'down'|null;pattern:string|null;causes:readonly PayCauseKind[];
 flagged:boolean;
 /** Not flagged because an approved exclusion explains the change. */
 excluded:boolean}>;
export type SwingSummary=Readonly<{people:readonly SwingPerson[];compared:number;changed:number;flagged:number;
 /** How many people's change each cause appears in. */
 causes:Readonly<Record<PayCauseKind,number>>}>;
export type SwingSetting=Readonly<{thresholdBp:number;exclusions:readonly string[]}>;

/** A pay item's stored code as a pattern; an item with no code that fits is described by its cause instead. */
const itemPattern=(name:string)=>{const code=name.trim().replace(/\s+/g,'_');return /^[A-Za-z0-9_.-]{1,40}$/.test(code)?`item:${code}`:null;};

export function netSwingFor(employmentId:string,rows:readonly StoredPayslipRow[],input:Readonly<{period:string;companyId:string}>&SwingSetting):SwingPerson|null{
 const result=comparePayPeriods(rows,{period:input.period,companyId:input.companyId});
 if(!result.ok||!result.comparisons.length)return null;
 const cmp=result.comparisons[0],net=cmp.totals.net,causes=cmp.causes.map(cause=>cause.kind);
 const changed=net.change!==0;
 if(!changed)return Object.freeze({employmentId,changed,swingBp:0,direction:null,pattern:null,causes,flagged:false,excluded:false});
 const top=cmp.payItems[0];
 const pattern=top&&Math.abs(top.change)*2>=Math.abs(net.change)?(itemPattern(top.name)??(causes[0]?`cause:${causes[0]}`:'cause:other'))
  :causes[0]?`cause:${causes[0]}`:'cause:other';
 const direction=net.change>0?'up' as const:'down' as const;
 if(!(net.previous>0))return Object.freeze({employmentId,changed,swingBp:null,direction,pattern,causes,flagged:false,excluded:false});
 const ratio=(value:number)=>Math.round(Math.abs(value)*10_000/net.previous);
 const swingBp=ratio(net.change);
 const over=swingBp>input.thresholdBp;
 let excluded=false;
 if(over&&input.exclusions.includes(pattern)){
  // An excluded item: the change left once that item's own change is set aside must be within the threshold.
  excluded=pattern.startsWith('cause:')||ratio(net.change-(top?.change??0))<=input.thresholdBp;
 }
 return Object.freeze({employmentId,changed,swingBp,direction,pattern,causes,flagged:over&&!excluded,excluded});
}

/** Every person paid by the company in the period, compared with their previous paid month there. */
export function netSwings(rowsByEmployment:ReadonlyMap<string,readonly StoredPayslipRow[]>,input:Readonly<{period:string;companyId:string}>&SwingSetting):SwingSummary{
 const people:SwingPerson[]=[];
 for(const [employmentId,rows] of [...rowsByEmployment].sort(([a],[b])=>a.localeCompare(b))){
  const person=netSwingFor(employmentId,rows,input);
  if(person)people.push(person);
 }
 const causes=Object.fromEntries(PAY_CAUSE_KINDS.map(kind=>[kind,people.filter(person=>person.changed&&person.causes.includes(kind)).length])) as Record<PayCauseKind,number>;
 return Object.freeze({people:Object.freeze(people),compared:people.length,changed:people.filter(person=>person.changed).length,
  flagged:people.filter(person=>person.flagged).length,causes:Object.freeze(causes)});
}
