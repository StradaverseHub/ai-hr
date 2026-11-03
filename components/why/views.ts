/** AI v2 W5 — the "Why?" panels' words, from the owner services' own figures.
 *
 * Each builder takes one owner explanation (core/pay-difference.ts, core/leave-balance-explain.ts,
 * core/claim-limit-explain.ts) and turns it into the panel's lines with the page's translator and the product's one
 * formatter for each kind of figure (lib/money.ts formatMoney, lib/day-format.ts formatDays, lib/hr-date.ts
 * formatPayPeriodMonth). It formats; it never computes: every number printed is a number the owner returned, and a
 * figure the owner withheld (null) is left out rather than shown as zero. Payslip line names are the employee
 * payslip's own labels (`me.payslip`), so the panel and the payslip beside it name a line the same way. Pure. */
import {formatMoney} from '@/lib/money';
import {formatDays} from '@/lib/day-format';
import {formatPayPeriodMonth} from '@/lib/hr-date';
import type {PayCause,PayDifference,PayDifferenceRefusal,PayLineKey,PayslipDeductionExplanation,PayslipDeductionWhy} from '@/core/pay-difference';
import type {LeaveBalanceExplanation} from '@/core/leave-balance-explain';
import type {ClaimLimitExplanation} from '@/core/claim-limit-explain';
import type {WhyFigure,WhyPanelView,WhySection} from './why-panel';

export type Translate=(key:string,values?:Record<string,string|number>)=>string;
export type WhyFormat=Readonly<{locale:string;currency:string|null}>;

/** The employee payslip's own label for each line (messages `me.payslip`). */
export const PAYSLIP_LINE_LABEL:Readonly<Record<PayLineKey,string>>={basic:'basicSalary',allowance:'allowances',overtime:'overtime',bonus:'bonus',claim:'claim',
 epf:'epf',socso:'socso',skbbk:'skbbk',eis:'eis',pcb:'pcb',cp38:'cp38',zakat:'zakat',unpaidLeave:'unpaidLeaveLine',absent:'absentLine',otherDeductions:'otherDeductions',
 gross:'grossPay',totalDeductions:'totalDeductions',net:'netPay'};

const money=(f:WhyFormat,value:number|null|undefined)=>value===null||value===undefined?'—':formatMoney(value,f.currency);
/** A difference with its sign: "+MYR 500.00", "−MYR 182.40", or the plain zero. */
export const signedMoney=(f:WhyFormat,value:number)=>value>0?`+${formatMoney(value,f.currency)}`:value<0?`−${formatMoney(-value,f.currency)}`:formatMoney(0,f.currency);
const month=(f:WhyFormat,period:string)=>formatPayPeriodMonth(period,f.locale);
const day=(f:WhyFormat,iso:string)=>new Intl.DateTimeFormat(f.locale,{dateStyle:'medium',timeZone:'UTC'}).format(new Date(`${iso}T00:00:00Z`));
const percent=(f:WhyFormat,value:number)=>`${value.toLocaleString(f.locale,{minimumFractionDigits:2,maximumFractionDigits:2})}%`;

function causeLine(cause:PayCause,ruleVersion:{current:string|null;previous:string|null},periods:{period:string;previousPeriod:string},f:WhyFormat,t:Translate,tp:Translate):string{
 const at={period:month(f,periods.period),previousPeriod:month(f,periods.previousPeriod)};
 const count=(unit:'days'|'hours',value:number|null)=>value===null?'—':t(`pay.${unit}`,{count:value});
 switch(cause.kind){
  case 'unpaid_leave':case 'absence':case 'days_paid':return t(`pay.cause.${cause.kind}`,{...at,current:count('days',cause.current),previous:count('days',cause.previous)});
  case 'overtime_hours':return t('pay.cause.overtime_hours',{...at,current:count('hours',cause.current),previous:count('hours',cause.previous)});
  case 'salary_change':return cause.effectiveFrom?t('pay.cause.salary_change',{current:money(f,cause.current),previous:money(f,cause.previous),date:day(f,cause.effectiveFrom)})
   :t('pay.cause.salary_change_undated',{current:money(f,cause.current),previous:money(f,cause.previous)});
  case 'additional_run':return t('pay.cause.additional_run',{...at,current:String(cause.current??0),previous:String(cause.previous??0)});
  case 'statutory_rules':return t('pay.cause.statutory_rules',{current:ruleVersion.current??'—',previous:ruleVersion.previous??'—'});
  case 'set_by_hand':return t('pay.cause.set_by_hand',{period:at.period,items:(cause.items??[]).map(key=>tp(PAYSLIP_LINE_LABEL[key as PayLineKey]??key)).join(', ')});
 }
}

/** "Why is my pay different from last month?" for one company's months (the payslip screen passes one company). */
export function payDifferenceView(result:PayDifference|PayDifferenceRefusal,f:WhyFormat,t:Translate,tp:Translate):WhyPanelView{
 const base={kind:'pay' as const,serviceNote:t('pay.note'),question:t('pay.linkLabel')};
 if(!result.ok)return{...base,title:t('pay.linkLabel'),lead:t(result.reason==='earliest'?'pay.earliest':'pay.noData')};
 const periods={period:result.period,previousPeriod:result.previousPeriod};
 const named={period:month(f,result.period),previous:month(f,result.previousPeriod)};
 const comparison=result.comparisons[0];
 const onlyIn=[...result.onlyIn.current,...result.onlyIn.previous];
 const notes:string[]=onlyIn.length?[t('pay.onlyIn',{companies:[...new Set(onlyIn)].join(', ')})]:[];
 if(!comparison)return{...base,title:t('pay.title',named),lead:t('pay.noData'),notes,question:t('pay.question',named)};
 const net=comparison.totals.net.change;
 const lead=net>0?t('pay.netUp',{amount:formatMoney(net,f.currency),previous:named.previous}):net<0?t('pay.netDown',{amount:formatMoney(-net,f.currency),previous:named.previous}):t('pay.netSame',{previous:named.previous});
 const row=(key:PayLineKey,line:{current:number;previous:number;change:number},strong=false)=>({label:tp(PAYSLIP_LINE_LABEL[key]),cells:[money(f,line.previous),money(f,line.current),signedMoney(f,line.change)],strong});
 const rows=[...comparison.lines.map(line=>row(line.key,line)),
  row('gross',comparison.totals.gross,true),row('totalDeductions',comparison.totals.totalDeductions,true),row('net',comparison.totals.net,true)];
 const sections:WhySection[]=[];
 if(comparison.payItems.length)sections.push({heading:t('pay.payItems'),lines:comparison.payItems.map(item=>`${item.name}: ${money(f,item.previous)} → ${money(f,item.current)} (${signedMoney(f,item.change)})`)});
 if(comparison.statutory.length)sections.push({heading:t('pay.statutory'),lines:comparison.statutory.flatMap(item=>{const name=tp(PAYSLIP_LINE_LABEL[item.key as PayLineKey]??item.key);
  return[t(`rule.${item.ruleKind}`,{name}),item.baseCurrent!==null&&item.basePrevious!==null
   ?t('pay.statutoryBase',{name,current:money(f,item.baseCurrent),previous:money(f,item.basePrevious),previousPeriod:named.previous}):t('pay.statutoryBaseUnknown',{name})];})});
 sections.push({heading:t('pay.causes'),lines:comparison.causes.length?comparison.causes.map(cause=>causeLine(cause,comparison.ruleVersion,periods,f,t,tp)):[t('pay.noCause')]});
 if(comparison.payslips.current>1||comparison.payslips.previous>1)notes.unshift(t('pay.runs',{period:named.period,previousPeriod:named.previous,current:comparison.payslips.current,previous:comparison.payslips.previous}));
 return{...base,title:t('pay.title',named),lead,question:t('pay.question',named),notes,sections,
  table:{caption:t('pay.title',named),head:[t('pay.colItem'),named.previous,named.period,t('pay.colChange')],rows}};
}

/** "Why is this deduction this amount?" for one line of one payslip. */
export function deductionView(key:PayslipDeductionWhy,explanation:PayslipDeductionExplanation,period:string,f:WhyFormat,t:Translate,tp:Translate):WhyPanelView{
 const name=tp(PAYSLIP_LINE_LABEL[key]);
 const base={kind:'deduction' as const,title:t('deduction.title',{name,amount:money(f,explanation.amount)}),serviceNote:t('deduction.note'),question:t('deduction.question',{name,period:month(f,period)})};
 if(explanation.days!==null)return{...base,figures:[{label:t('deduction.days'),value:t('pay.days',{count:explanation.days})},{label:name,value:money(f,explanation.amount),strong:true}],notes:[t('deduction.absenceNote')]};
 const s=explanation.statutory!;
 const figures:WhyFigure[]=[{label:t('deduction.takeHome'),value:money(f,s.employeeTakeHome),strong:true}];
 if(s.employeeReported!==s.employeeTakeHome)figures.push({label:t('deduction.reported'),value:money(f,s.employeeReported)});
 if(s.employerBorne>0)figures.push({label:t('deduction.employerBorne'),value:money(f,s.employerBorne)});
 if(s.employer>0)figures.push({label:t('deduction.employer'),value:money(f,s.employer)});
 if(s.totalBase!==null)figures.push({label:t('deduction.base'),value:money(f,s.totalBase)});
 if(s.effectiveEmployeeRatePercent!==null&&s.ruleKind!=='mtd')figures.push({label:t('deduction.rate'),value:percent(f,s.effectiveEmployeeRatePercent)});
 const notes=[...(s.workingNotRecorded?[t('deduction.notRecorded')]:[]),...(s.additionalRun?[t('deduction.additional')]:[]),...(s.ruleVersion?[t('deduction.version',{version:s.ruleVersion})]:[])];
 return{...base,lead:t(`rule.${s.ruleKind}`,{name}),figures,notes};
}

/** "Why is my leave balance this figure?" for one own leave type. */
export function leaveBalanceView(explanation:LeaveBalanceExplanation,f:WhyFormat,t:Translate):WhyPanelView{
 const days=(value:number)=>t('leave.daysValue',{days:formatDays(value)});
 const x=explanation.figures,figures:WhyFigure[]=[];
 const add=(key:string,value:number|null,strong=false)=>{if(value!==null)figures.push({label:t(`leave.${key}`),value:days(value),strong});};
 add('entitlement',x.entitlement);add('earnedSoFar',x.earnedSoFar);add('broughtForward',x.broughtForward);add('adjustments',x.adjustments);
 add('totalEntitlement',x.totalEntitlement,true);add('taken',x.taken);add('pending',x.pending);if(x.forfeited)add('forfeited',x.forfeited);
 add('available',x.available,true);if(explanation.canApplyFor!==null&&explanation.canApplyFor!==x.available)add('canApplyFor',explanation.canApplyFor,true);
 const takenOnly=x.entitlement===null&&x.totalEntitlement===null&&x.available===null&&!explanation.withheld;
 const notes=[...(explanation.entitlementTemplateName?[t('leave.table',{name:explanation.entitlementTemplateName})]:[]),
  ...(explanation.proration?.prorated?[t('leave.prorated',{annual:days(explanation.proration.annualEntitlementDays),display:days(explanation.proration.displayEntitlementDays)})]:[]),
  ...(explanation.proration?.roundingApplied?[t('leave.rounded')]:[]),
  ...(explanation.carryForwardExpiryDate&&(x.broughtForward??0)>0?[t('leave.expiry',{date:day(f,explanation.carryForwardExpiryDate)})]:[]),
  ...(explanation.withheld?[t('leave.withheld')]:[]),...(takenOnly?[t('leave.takenOnly')]:[])];
 return{kind:'leave',title:t('leave.title',{leaveType:explanation.leaveType}),lead:t('leave.cycle',{start:day(f,explanation.cycleStart),end:day(f,explanation.cycleEnd)}),
  figures,notes,serviceNote:t('leave.note'),question:t('leave.question',{leaveType:explanation.leaveType})};
}

/** "Why is my claim limit this figure, and how much have I used?" for one own claim type. */
export function claimLimitView(explanation:ClaimLimitExplanation,f:WhyFormat,t:Translate):WhyPanelView{
 const figures:WhyFigure[]=[],x=explanation;
 const add=(key:string,value:string,strong=false,values?:Record<string,string>)=>figures.push({label:t(`claim.${key}`,values),value,strong});
 if(x.annual){add('annual',money(f,x.annual.limit));add('usedYear',money(f,x.annual.used));if(x.annual.pending>0)add('pendingYear',money(f,x.annual.pending));
  if(x.annual.remaining!==null)add('remainingYear',money(f,x.annual.remaining),true);}
 if(x.monthly){add('monthly',money(f,x.monthly.limit));add('usedMonth',money(f,x.monthly.used));if(x.monthly.remaining!==null)add('remainingMonth',money(f,x.monthly.remaining),true);}
 if(x.block){add('block',money(f,x.block.limit));add('usedBlock',money(f,x.block.used));
  if(x.block.remaining!==null&&x.block.endsOn)add('remainingBlock',money(f,x.block.remaining),true,{date:day(f,x.block.endsOn)});}
 if(x.perClaimCap!==null)add('perClaim',money(f,x.perClaimCap));
 if(x.lifetime){add('lifetime',money(f,x.lifetime.limit));add('usedLifetime',money(f,x.lifetime.used));}
 if(x.claimsPerYear){add('claimsPerYear',String(x.claimsPerYear.max));add('claimsUsed',String(x.claimsPerYear.used));}
 const items=x.items.map(item=>[item.name+':',...(item.annual?[`${t('claim.annual')} ${money(f,item.annual.limit)}`,`${t('claim.usedYear')} ${money(f,item.annual.used)}`]:[]),
  ...(item.monthly?[`${t('claim.monthly')} ${money(f,item.monthly.limit)}`,`${t('claim.usedMonth')} ${money(f,item.monthly.used)}`]:[]),
  ...(item.perClaimCap!==null?[`${t('claim.perClaim')} ${money(f,item.perClaimCap)}`]:[])].join(' '));
 const notes=[...(x.unlimited?[t('claim.unlimited')]:[]),
  ...(x.policy.validFrom?[t(x.policy.gradeScoped?'claim.policyGrade':'claim.policyDefault',{date:day(f,x.policy.validFrom)})]:[]),...(x.unlimited?[]:[t('claim.usedNote')])];
 return{kind:'claim',title:t('claim.title',{claimType:x.claimType}),figures,sections:items.length?[{heading:t('claim.items'),lines:items}]:[],notes,
  serviceNote:t('claim.note'),question:t('claim.question',{claimType:x.claimType})};
}
