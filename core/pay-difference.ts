/** AI v2 W5 — "Why is my pay different from last month?" and "Why is this deduction this amount?", answered from
 * the payslips themselves.
 *
 * ══ THE OWNER RULE ══
 *
 * "The AI never does the money maths." Every figure here is a figure a payslip's own run stored, read through the
 * same readers the payslip screen and PDF print it with (lib/payslip-pdf.ts buildPayslipPdfData and
 * payslipPresentationRows): payslipDisplayEarnings for the earning boxes, payslipEmployerBorne for what came off
 * take-home, payslipAbsenceLines for unpaid leave, absence, CP38 and the "Other deductions" residual,
 * payslipZakatLine for zakat, and core/statutory-explain.ts explainStatutory for the statutory working. The only
 * arithmetic is this service's own, done here and nowhere else: a month's runs are added up (a month can carry a
 * regular run and a bonus run, exactly as core/assistant-tools.ts my_pay_change sums them) and one month is
 * subtracted from the other, each rounded to the sen. The model receives the results as bands and placeholders and
 * may word them; it never computes or changes one.
 *
 * ══ CAUSES ARE READ, NEVER GUESSED ══
 *
 * A cause is listed only where the run recorded it on the payslip: the unpaid-leave and absence days
 * (`statutory.unpaidLeave` / `statutory.absent`, e2632276), the overtime hours behind an attendance-derived or
 * quantity-times-rate overtime line (a96d320c), the salary record the run was priced from (`statutory.salaryBasis`),
 * the days paid (`days_worked`), an additional run in the month, the statutory ruleset version the run stamped
 * (core/payslip-recompute.ts payslipProvenance) and a statutory figure somebody set by hand (statutoryProvenance).
 * A payslip written before a stamp existed simply has no such cause; nothing is inferred from the size of a change.
 *
 * ══ ONE COMPANY AT A TIME ══
 *
 * Money from two employers is never added together (lib/money.ts: a total over two companies may be over two
 * currencies). Each company paid in both months gets its own comparison; a company that paid in only one of the
 * two is named, not netted. Pure: no session, no database, no i18n. */
import {payslipDisplayEarnings} from './pay-display-category';
import {payslipEmployerBorne} from './payslip-employer-borne';
import {payslipAbsenceLines} from './payslip-absence-lines';
import {payslipZakatLine} from './payslip-zakat-line';
import {payItemLinesForBuckets,storedComponentLines,storedOvertimeLines,type EarningBucket} from './payslip-earning-lines';
import {payslipProvenance} from './payslip-recompute';
import {explainStatutory,STATUTORY_EXPLAIN_KEYS,type StatutoryExplainKey,type StatutoryRuleKind,type StatutoryProvenanceSource} from './statutory-explain';

/** One payslip row as the own payslip readers return it (core/read.ts myPayslips). */
export type StoredPayslipRow=Readonly<{companyId:string;company:string;payPeriod:string;runType:string;runSeq:number;
 basic:unknown;allowance:unknown;overtime:unknown;bonus:unknown;gross:unknown;statutory:unknown;otherDeductions:unknown;
 totalDeductions:unknown;net:unknown;daysWorked:unknown}>;

/** The lines a payslip prints, in its own order: the earnings box, the deductions box, then the three totals. */
export const PAY_EARNING_LINES=['basic','allowance','overtime','bonus','claim'] as const;
export const PAY_DEDUCTION_LINES=['epf','socso','skbbk','eis','pcb','cp38','zakat','unpaidLeave','absent','otherDeductions'] as const;
export const PAY_TOTAL_LINES=['gross','totalDeductions','net'] as const;
export const PAY_LINE_KEYS=[...PAY_EARNING_LINES,...PAY_DEDUCTION_LINES,...PAY_TOTAL_LINES] as const;
export type PayLineKey=(typeof PAY_LINE_KEYS)[number];
export type PayLineGroup='earnings'|'deductions'|'totals';
export const PAY_CAUSE_KINDS=['unpaid_leave','absence','overtime_hours','salary_change','days_paid','additional_run','statutory_rules','set_by_hand'] as const;
export type PayCauseKind=(typeof PAY_CAUSE_KINDS)[number];
/** The statutory deductions a person can ask "why is this amount?" about on their own payslip. */
export const PAYSLIP_DEDUCTION_WHY=['epf','socso','skbbk','eis','pcb','unpaidLeave','absent'] as const;
export type PayslipDeductionWhy=(typeof PAYSLIP_DEDUCTION_WHY)[number];

const round2=(value:number)=>Math.round(value*100)/100;
const num=(value:unknown)=>{const n=typeof value==='number'?value:typeof value==='string'?Number(value):Number.NaN;return Number.isFinite(n)?n:0;};
const numOrNull=(value:unknown)=>{if(value===null||value===undefined||value==='')return null;const n=Number(value);return Number.isFinite(n)?n:null;};
const groupOf=(key:PayLineKey):PayLineGroup=>(PAY_EARNING_LINES as readonly string[]).includes(key)?'earnings':(PAY_DEDUCTION_LINES as readonly string[]).includes(key)?'deductions':'totals';

/** The stored columns a payslip's lines are printed from (also the shape of the payslip detail read). */
export type PayslipFigureRow=Pick<StoredPayslipRow,'basic'|'allowance'|'overtime'|'bonus'|'gross'|'statutory'|'otherDeductions'|'totalDeductions'|'net'>;
/** Each line of one payslip exactly as the payslip prints it. */
export function payslipLineFigures(row:PayslipFigureRow):Readonly<Record<PayLineKey,number>>{
 const statutory=(row.statutory??{}) as Record<string,unknown>;
 const shown=payslipDisplayEarnings(row),borne=payslipEmployerBorne(row.statutory),absence=payslipAbsenceLines(row.statutory,row.otherDeductions);
 const zakat=payslipZakatLine(statutory as never);
 return Object.freeze({basic:shown.basic,allowance:shown.allowance,overtime:shown.overtime,bonus:shown.bonus,claim:shown.claim,
  epf:borne.employee.epf,socso:borne.employee.socso,skbbk:borne.employee.skbbk,eis:borne.employee.eis,pcb:borne.employee.pcb,
  // The rows the payslip prints: an applied CP38 only when it was carved out of its column, zakat only when the
  // slip's own total counts it, and the residual "Other deductions" only when it prints.
  cp38:absence.cp38.show?absence.cp38.amount:0,zakat:zakat.amount>0&&zakat.countedInTotal?zakat.amount:0,
  unpaidLeave:absence.unpaidLeave?.amount??0,absent:absence.absent?.amount??0,otherDeductions:absence.showResidual?absence.residual:0,
  gross:num(row.gross),totalDeductions:num(row.totalDeductions),net:num(row.net)});
}

/** Overtime hours the run recorded behind its overtime figure: the attendance legs, or pay items priced by the hour. */
function overtimeHours(statutory:unknown):number|null{
 const legs=storedOvertimeLines(statutory).filter(line=>line.detail?.unit==='hours');
 const items=payItemLinesForBuckets(storedComponentLines(statutory),['ot']).filter(line=>line.detail?.unit==='hours');
 const lines=legs.length?legs:items;
 return lines.length?round2(lines.reduce((sum,line)=>sum+(line.detail?.qty??0),0)):null;
}
const PAY_ITEM_BUCKETS:readonly EarningBucket[]=['wage','reimburse','ot','bonus'];
/** The named pay items behind the earning boxes, by the item's own stored code (its name when it has none). */
function payItems(statutory:unknown):Map<string,{name:string;amount:number}>{
 const out=new Map<string,{name:string;amount:number}>();
 for(const line of payItemLinesForBuckets(storedComponentLines(statutory),PAY_ITEM_BUCKETS)){
  const key=(line.code??'').trim()||line.name.trim();if(!key)continue;
  const prior=out.get(key);out.set(key,{name:prior?.name||line.name.trim()||key,amount:round2((prior?.amount??0)+line.amount)});
 }
 return out;
}
type SalaryBasis={basicSalary:number;effectiveFrom:string|null};
function salaryBasis(statutory:unknown):SalaryBasis|null{
 const basis=((statutory??{}) as {salaryBasis?:{basicSalary?:unknown;effectiveFrom?:unknown}}).salaryBasis;
 const basic=numOrNull(basis?.basicSalary);
 return basic===null?null:{basicSalary:basic,effectiveFrom:typeof basis?.effectiveFrom==='string'?basis.effectiveFrom:null};
}

/** One month at one company: every run's lines added up, and the facts its runs recorded. */
type Month=Readonly<{period:string;runs:number;additionalRuns:number;figures:Record<PayLineKey,number>;items:Map<string,{name:string;amount:number}>;
 unpaidDays:number;absentDays:number;overtimeHours:number|null;regular:StoredPayslipRow|null}>;
function month(rows:readonly StoredPayslipRow[]):Month{
 const figures=Object.fromEntries(PAY_LINE_KEYS.map(key=>[key,0])) as Record<PayLineKey,number>;
 const items=new Map<string,{name:string;amount:number}>();
 let unpaidDays=0,absentDays=0,hours:number|null=null;
 for(const row of rows){
  const own=payslipLineFigures(row);for(const key of PAY_LINE_KEYS)figures[key]=round2(figures[key]+own[key]);
  for(const [key,item] of payItems(row.statutory)){const prior=items.get(key);items.set(key,{name:prior?.name??item.name,amount:round2((prior?.amount??0)+item.amount)});}
  const absence=payslipAbsenceLines(row.statutory,row.otherDeductions);
  unpaidDays=round2(unpaidDays+(absence.unpaidLeave?.days??0));absentDays=round2(absentDays+(absence.absent?.days??0));
  const ownHours=overtimeHours(row.statutory);if(ownHours!==null)hours=round2((hours??0)+ownHours);
 }
 const regulars=rows.filter(row=>row.runType==='regular').sort((a,b)=>a.runSeq-b.runSeq);
 return{period:rows[0].payPeriod,runs:rows.length,additionalRuns:rows.length-regulars.length,figures,items,unpaidDays,absentDays,overtimeHours:hours,
  // The month's statutory working and salary record come from its regular run only: an additional run stamps
  // increments over the whole month's bases (core/statutory-explain.ts), so its bases are not this month's wage.
  regular:regulars.length===1?regulars[0]:null};
}

export type PayChange=Readonly<{current:number;previous:number;change:number}>;
export type PayLineChange=Readonly<{key:PayLineKey;group:PayLineGroup}>&PayChange;
export type PayItemChange=Readonly<{name:string}>&PayChange;
export type StatutoryChange=Readonly<{key:StatutoryExplainKey;ruleKind:StatutoryRuleKind;setBy:StatutoryProvenanceSource;
 baseCurrent:number|null;basePrevious:number|null;baseChange:number|null}>;
export type PayCause=Readonly<{kind:PayCauseKind;current:number|null;previous:number|null;effectiveFrom?:string|null;items?:readonly string[]}>;
export type PayComparison=Readonly<{company:string;companyId:string;period:string;previousPeriod:string;
 payslips:Readonly<{current:number;previous:number}>;totals:Readonly<Record<(typeof PAY_TOTAL_LINES)[number],PayChange>>;
 lines:readonly PayLineChange[];payItems:readonly PayItemChange[];statutory:readonly StatutoryChange[];causes:readonly PayCause[];
 ruleVersion:Readonly<{current:string|null;previous:string|null}>}>;
export type PayDifference=Readonly<{ok:true;period:string;previousPeriod:string;availablePeriods:readonly string[];comparisons:readonly PayComparison[];
 /** Companies that paid the person in only one of the two months: named, never netted against the other. */
 onlyIn:Readonly<{current:readonly string[];previous:readonly string[]}>}>;
export type PayDifferenceRefusal=Readonly<{ok:false;reason:'no_data'|'no_period'|'earliest'|'same_period';availablePeriods:readonly string[]}>;

const change=(current:number,previous:number):PayChange=>({current,previous,change:round2(current-previous)});
function compareMonths(company:{companyId:string;company:string},now:Month,before:Month):PayComparison{
 const lines=[...PAY_EARNING_LINES,...PAY_DEDUCTION_LINES].map(key=>({key,group:groupOf(key),...change(now.figures[key],before.figures[key])}))
  .filter(line=>line.change!==0);
 const totals={gross:change(now.figures.gross,before.figures.gross),totalDeductions:change(now.figures.totalDeductions,before.figures.totalDeductions),net:change(now.figures.net,before.figures.net)};
 const payItemChanges=[...new Set([...now.items.keys(),...before.items.keys()])]
  .map(key=>({name:now.items.get(key)?.name??before.items.get(key)!.name,...change(now.items.get(key)?.amount??0,before.items.get(key)?.amount??0)}))
  .filter(item=>item.change!==0).sort((a,b)=>Math.abs(b.change)-Math.abs(a.change)||a.name.localeCompare(b.name));
 const nowWorking=now.regular?explainStatutory(now.regular.statutory,now.regular.runType):null;
 const beforeWorking=before.regular?explainStatutory(before.regular.statutory,before.regular.runType):null;
 const moved=new Set(lines.map(line=>line.key));
 const statutory:StatutoryChange[]=nowWorking?nowWorking.items.filter(item=>moved.has(item.key as PayLineKey)).map(item=>{
  const prior=beforeWorking?.items.find(row=>row.key===item.key)??null;
  const baseCurrent=item.totalBase,basePrevious=prior?.totalBase??null;
  return{key:item.key,ruleKind:item.ruleKind,setBy:item.provenance.source,baseCurrent,basePrevious,
   baseChange:baseCurrent===null||basePrevious===null?null:round2(baseCurrent-basePrevious)};
 }):[];
 const causes:PayCause[]=[];
 if(now.unpaidDays||before.unpaidDays)causes.push({kind:'unpaid_leave',current:now.unpaidDays,previous:before.unpaidDays});
 if(now.absentDays||before.absentDays)causes.push({kind:'absence',current:now.absentDays,previous:before.absentDays});
 if((now.overtimeHours??0)>0||(before.overtimeHours??0)>0)causes.push({kind:'overtime_hours',current:now.overtimeHours,previous:before.overtimeHours});
 const salaryNow=now.regular?salaryBasis(now.regular.statutory):null,salaryBefore=before.regular?salaryBasis(before.regular.statutory):null;
 if(salaryNow&&salaryBefore&&salaryNow.basicSalary!==salaryBefore.basicSalary)
  causes.push({kind:'salary_change',current:salaryNow.basicSalary,previous:salaryBefore.basicSalary,effectiveFrom:salaryNow.effectiveFrom});
 const daysNow=now.regular?numOrNull(now.regular.daysWorked):null,daysBefore=before.regular?numOrNull(before.regular.daysWorked):null;
 if(daysNow!==null&&daysBefore!==null&&daysNow!==daysBefore)causes.push({kind:'days_paid',current:daysNow,previous:daysBefore});
 if(now.additionalRuns||before.additionalRuns)causes.push({kind:'additional_run',current:now.additionalRuns,previous:before.additionalRuns});
 const versionNow=now.regular?payslipProvenance(now.regular.statutory).rulesetVersion:null,versionBefore=before.regular?payslipProvenance(before.regular.statutory).rulesetVersion:null;
 if(versionNow&&versionBefore&&versionNow!==versionBefore)causes.push({kind:'statutory_rules',current:null,previous:null});
 const byHand=(nowWorking?.items??[]).filter(item=>item.provenance.source!=='computed').map(item=>item.key);
 if(byHand.length)causes.push({kind:'set_by_hand',current:null,previous:null,items:byHand});
 return Object.freeze({company:company.company,companyId:company.companyId,period:now.period,previousPeriod:before.period,payslips:{current:now.runs,previous:before.runs},
  totals,lines,payItems:payItemChanges,statutory,causes,ruleVersion:{current:versionNow,previous:versionBefore}});
}

/** Compares two of the person's own released months. `period` defaults to the latest released month; `compareTo`
 * to the latest released month before it (the month they were last paid, which is not always the calendar month
 * before: a joiner, a leaver or an unpaid month leaves a gap). `companyId` narrows to one employer (the payslip
 * screen compares the company whose payslip is open). Rows must already be the caller's own released payslips. */
export function comparePayPeriods(rows:readonly StoredPayslipRow[],input:Readonly<{period?:string;compareTo?:string;companyId?:string}>={}):PayDifference|PayDifferenceRefusal{
 const own=input.companyId?rows.filter(row=>row.companyId===input.companyId):rows;
 const availablePeriods=[...new Set(own.map(row=>row.payPeriod))].sort().reverse();
 if(!availablePeriods.length)return{ok:false,reason:'no_data',availablePeriods};
 const period=input.period??availablePeriods[0];
 if(!availablePeriods.includes(period))return{ok:false,reason:'no_period',availablePeriods:availablePeriods.slice(0,12)};
 const previousPeriod=input.compareTo??availablePeriods.find(row=>row<period);
 if(previousPeriod===undefined)return{ok:false,reason:'earliest',availablePeriods:availablePeriods.slice(0,12)};
 if(previousPeriod===period)return{ok:false,reason:'same_period',availablePeriods:availablePeriods.slice(0,12)};
 if(!availablePeriods.includes(previousPeriod))return{ok:false,reason:'no_period',availablePeriods:availablePeriods.slice(0,12)};
 const companies=(target:string)=>new Map(own.filter(row=>row.payPeriod===target).map(row=>[row.companyId,row.company]));
 const now=companies(period),before=companies(previousPeriod);
 const comparisons=[...now].filter(([id])=>before.has(id)).sort((a,b)=>a[1].localeCompare(b[1])).map(([companyId,company])=>{
  const at=(target:string)=>month(own.filter(row=>row.companyId===companyId&&row.payPeriod===target));
  return compareMonths({companyId,company},at(period),at(previousPeriod));
 });
 return Object.freeze({ok:true,period,previousPeriod,availablePeriods:availablePeriods.slice(0,12),comparisons,
  onlyIn:{current:[...now].filter(([id])=>!before.has(id)).map(([,name])=>name).sort(),previous:[...before].filter(([id])=>!now.has(id)).map(([,name])=>name).sort()}});
}

export type PayslipDeductionExplanation=Readonly<{key:PayslipDeductionWhy;amount:number;
 statutory:Readonly<{ruleKind:StatutoryRuleKind;setBy:StatutoryProvenanceSource;employeeReported:number;employeeTakeHome:number;employerBorne:number;employer:number;
  totalBase:number|null;effectiveEmployeeRatePercent:number|null;workingNotRecorded:boolean;additionalRun:boolean;ruleVersion:string|null}>|null;
 days:number|null}>;
const percent=(rate:number|null)=>rate===null?null:Math.round(rate*10_000)/100;
/** "Why is this deduction this amount?" for one line of one payslip: the statutory working the run recorded
 * (explainStatutory, the same reader the statutory explainer uses), or the days an unpaid-leave or absence line was
 * deducted for. `amount` is the line as the payslip prints it. Null when the payslip prints no such line. */
export function explainPayslipDeduction(row:PayslipFigureRow&Readonly<{runType:string}>,key:PayslipDeductionWhy):PayslipDeductionExplanation|null{
 const figures=payslipLineFigures(row);
 if(key==='unpaidLeave'||key==='absent'){
  const absence=payslipAbsenceLines(row.statutory,row.otherDeductions),line=key==='unpaidLeave'?absence.unpaidLeave:absence.absent;
  return line?Object.freeze({key,amount:figures[key],statutory:null,days:line.days}):null;
 }
 const working=explainStatutory(row.statutory,row.runType);
 const item=working.items.find(entry=>entry.key===(key as StatutoryExplainKey));
 if(!item||!(STATUTORY_EXPLAIN_KEYS as readonly string[]).includes(key))return null;
 return Object.freeze({key,amount:figures[key],days:null,statutory:Object.freeze({ruleKind:item.ruleKind,setBy:item.provenance.source,employeeReported:item.employeeReported,
  employeeTakeHome:item.employeeTakeHome,employerBorne:item.employerBorne,employer:item.employer,totalBase:item.totalBase,
  effectiveEmployeeRatePercent:percent(item.effectiveEmployeeRate),workingNotRecorded:item.workingNotRecorded,additionalRun:working.basesCoverWholeMonth,ruleVersion:working.rulesetVersion})});
}
