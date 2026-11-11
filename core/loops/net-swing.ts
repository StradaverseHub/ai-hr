/** AI v2 P2-2a — the Salary payroll loop's change against last month, per person, by cause, and its net-swing flag.
 *
 * PURE. Every figure is the pay-difference service's (core/pay-difference.ts comparePayPeriods): a month's runs added up
 * (a regular run and its bonus or off-cycle runs together) and the previous paid month subtracted, with the causes the
 * runs recorded. This module adds one comparison of its own and nothing else: the size of the net change as a share of
 * the previous month's net pay, in basis points (1500 = 15%), against the company's threshold. It never computes,
 * changes or proposes a figure of pay.
 *
 * A person's PATTERN names what moved their pay most, so payroll HR's dispositions can be grouped by it
 * (core/loops/swing-proposals.ts): the pay item whose own change is at least half of the net change, keyed on its pay
 * component's stable id (item:<pay component id>, resolved from the code the run stamped on the line, so renaming the
 * component never re-keys a pattern it has learned; the name is only ever shown), else the first cause the runs
 * recorded (cause:<kind>), else cause:other. An item whose line cannot be tied to exactly one catalogued component (two
 * components sharing its name, or a code no longer in the catalogue) is described by its cause instead. An EXCLUDED pattern (approved by an administrator)
 * does not raise a flag while the change left after that item's own change is within the threshold. An excluded CAUSE
 * explains a change only when it is the only cause the runs recorded and the swing is under twice the threshold
 * (Phase 2 hardening, 4 November 2026): with any other cause beside it, or a swing at least twice the threshold, the
 * person is flagged as if nothing were excluded, so an exclusion can never hide a change of any size. A person paid in only one of the two months, or whose previous net pay was not positive, has
 * no ratio and is never flagged (they are listed as changed). */
import {comparePayPeriods,explainNetChange,PAY_CAUSE_KINDS,type ExplainingPayCause,type PayCauseKind,type StoredPayslipRow} from '../pay-difference';
import {previousPeriod} from './period';
import {storedComponentLines} from '../payslip-earning-lines';

export const DEFAULT_SWING_THRESHOLD_BP=1500;
/** The lowest and highest threshold a setting may hold (migration 2005's CHECK: 100–5000 basis points). */
const MIN_THRESHOLD_BP=100,MAX_SETTING_THRESHOLD_BP=5000;
/** The threshold to judge by: the company's own when it is a valid setting, else the 15% default, never "no check". */
export const swingThresholdOrDefault=(value:unknown):number=>
 typeof value==='number'&&Number.isInteger(value)&&value>=MIN_THRESHOLD_BP&&value<=MAX_SETTING_THRESHOLD_BP?value:DEFAULT_SWING_THRESHOLD_BP;
/** The months a comparison for `period` reads: the period and the three before it (the previous PAID month may be
 * earlier than the calendar month before). One list for every reader, so the Salary loop and the anomaly layer compare
 * the same rows. */
export const swingMonths=(period:string):string[]=>{const out=[period];for(let i=0;i<3;i++)out.push(previousPeriod(out[out.length-1]));return out;};
export const SWING_PATTERN_RE=/^(cause:[a-z_]{1,40}|item:[A-Za-z0-9_.-]{1,40})$/;
export const isSwingPattern=(value:unknown):value is string=>typeof value==='string'&&SWING_PATTERN_RE.test(value);

export type SwingPerson=Readonly<{employmentId:string;
 /** Whether the person's net pay differs from the previous paid month. */
 changed:boolean;
 /** |net change| / previous net, in basis points; null when there is no ratio (see the header). */
 swingBp:number|null;direction:'up'|'down'|null;pattern:string|null;causes:readonly PayCauseKind[];
 flagged:boolean;
 /** Not flagged because an approved exclusion explains the change. */
 excluded:boolean;
 /** "Check the payroll first" (owner, 11 November 2026): the change no payroll record explains, as a share of the previous
  * net pay in basis points (core/pay-difference.ts explainNetChange); null when there is no ratio. A person is flagged
  * only when this, as well as the whole swing, is over the threshold. */
 unexplainedBp:number|null;
 /** The recorded causes that accounted for part of the change. */
 explainedBy:readonly ExplainingPayCause[];
 /** The month's net pay and the previous paid month's, as the pay-difference service added them up. */
 netPay:number;previousNetPay:number}>;
export type SwingSummary=Readonly<{people:readonly SwingPerson[];compared:number;changed:number;flagged:number;
 /** How many people's change each cause appears in. */
 causes:Readonly<Record<PayCauseKind,number>>}>;
export type SwingSetting=Readonly<{thresholdBp:number;exclusions:readonly string[]}>;
/** The company's pay components by the code a run stamps on its lines (packs/payroll/service listPayComponents). */
export type ComponentIds=ReadonlyMap<string,string>;
type SwingInput=Readonly<{period:string;companyId:string;componentIds?:ComponentIds}>&SwingSetting;

/** The pattern of the pay item the pay-difference service named: its one catalogued component, or null. */
function itemPattern(rows:readonly StoredPayslipRow[],name:string,componentIds:ComponentIds|undefined):string|null{
 if(!componentIds)return null;
 const codes=new Set<string>();
 for(const row of rows)for(const line of storedComponentLines(row.statutory)){
  const lineName=(line.name??'').trim(),code=(line.code??'').trim();
  if(code&&(lineName===name||(!lineName&&code===name)))codes.add(code);
 }
 if(codes.size!==1)return null;
 const id=componentIds.get([...codes][0]);
 return id&&isSwingPattern(`item:${id}`)?`item:${id}`:null;
}

/** THE ONE OWNER of the net-swing flag. The Salary payroll loop (netSwings) and the payroll anomaly layer's `net-swing`
 * detector (core/payroll-anomaly-detectors.ts) both call this, with the company's one threshold, so they cannot disagree.
 * Flagged = the whole swing is over the threshold AND the part no payroll record explains is over it too, unless an
 * approved exclusion applies (the Phase 2 hardening rules below are unchanged). */
export function netSwingFor(employmentId:string,rows:readonly StoredPayslipRow[],input:SwingInput):SwingPerson|null{
 const result=comparePayPeriods(rows,{period:input.period,companyId:input.companyId});
 if(!result.ok||!result.comparisons.length)return null;
 const cmp=result.comparisons[0],net=cmp.totals.net,causes=cmp.causes.map(cause=>cause.kind);
 const changed=net.change!==0;
 const money={netPay:net.current,previousNetPay:net.previous};
 if(!changed)return Object.freeze({employmentId,changed,swingBp:0,direction:null,pattern:null,causes,flagged:false,excluded:false,unexplainedBp:0,explainedBy:Object.freeze([]),...money});
 const top=cmp.payItems[0];
 const pattern=(top&&Math.abs(top.change)*2>=Math.abs(net.change)?itemPattern(rows,top.name,input.componentIds):null)
  ??(causes[0]?`cause:${causes[0]}`:'cause:other');
 const direction=net.change>0?'up' as const:'down' as const;
 if(!(net.previous>0))return Object.freeze({employmentId,changed,swingBp:null,direction,pattern,causes,flagged:false,excluded:false,unexplainedBp:null,explainedBy:Object.freeze([]),...money});
 const ratio=(value:number)=>Math.round(Math.abs(value)*10_000/net.previous);
 const swingBp=ratio(net.change);
 // The service computes what the records explain; this only compares. Not comparable ⇒ nothing explained.
 const explanation=explainNetChange(rows,{period:input.period,compareTo:cmp.previousPeriod,companyId:cmp.companyId});
 const unexplainedBp=ratio(explanation?explanation.unexplained:net.change);
 const explainedBy=Object.freeze((Object.keys(explanation?.byCause??{}) as ExplainingPayCause[]).sort());
 const over=swingBp>input.thresholdBp&&unexplainedBp>input.thresholdBp;
 let excluded=false;
 // A figure set by hand is never excused, by a record or by an exclusion (owner, 11 November 2026).
 if(over&&input.exclusions.includes(pattern)&&!causes.includes('set_by_hand')){
  // An excluded cause: the only cause recorded, and the swing under twice the threshold. An excluded item: the change
  // left once that item's own change is set aside must be within the threshold.
  excluded=pattern.startsWith('cause:')
   ?causes.every(kind=>`cause:${kind}`===pattern)&&swingBp<2*input.thresholdBp
   :ratio(net.change-(top?.change??0))<=input.thresholdBp;
 }
 return Object.freeze({employmentId,changed,swingBp,direction,pattern,causes,flagged:over&&!excluded,excluded,unexplainedBp,explainedBy,...money});
}

/** Every person paid by the company in the period, compared with their previous paid month there. */
export function netSwings(rowsByEmployment:ReadonlyMap<string,readonly StoredPayslipRow[]>,input:SwingInput):SwingSummary{
 const people:SwingPerson[]=[];
 for(const [employmentId,rows] of [...rowsByEmployment].sort(([a],[b])=>a.localeCompare(b))){
  const person=netSwingFor(employmentId,rows,input);
  if(person)people.push(person);
 }
 const causes=Object.fromEntries(PAY_CAUSE_KINDS.map(kind=>[kind,people.filter(person=>person.changed&&person.causes.includes(kind)).length])) as Record<PayCauseKind,number>;
 return Object.freeze({people:Object.freeze(people),compared:people.length,changed:people.filter(person=>person.changed).length,
  flagged:people.filter(person=>person.flagged).length,causes:Object.freeze(causes)});
}
