/** Pay averages (AI Centre issue 13b; owner decision 3 November 2026: "Yes, averages only").
 *
 * Headcount, average and median of ONE measure, read from each company's latest closed regular payroll run, for
 * a caller with payroll access. The service computes every figure; a model only words them. Pure statistics below
 * (payAverageCells), one read as the caller under RLS (payAverages).
 *
 * THE MEASURE is `basic_pay_paid`: the Basic figure printed on each payslip of the run (core/pay-display-category.ts
 * payslipDisplayEarnings, the same figure the payslip and the Payroll Register show). It is what the run paid as basic
 * for that month: prorated for joiners and leavers, rate x days or hours for daily and hourly pay, before unpaid-leave
 * and every other deduction, and without allowances, overtime, bonus or claims. A payslip with zero basic counts.
 *
 * WHO MAY ASK: a caller holding payroll access (an HR administrator or a payroll partner, lib/authz-model.ts
 * canManagePayroll) for each company read; a company counts only when the database's own payroll scope
 * (app.can_admin_payroll_for, the payslip RLS owner) admits it, the principal is current, the company is not
 * archived and its payroll module is enabled. Anyone else is refused, and so is a company filter naming a company
 * outside that scope (one message for both, so the refusal is no existence oracle).
 *
 * SUPPRESSION (fail closed). Groups count PEOPLE (a person with two payslips in one company's run is one person, their
 * basic summed); each person counts once per company. Every rule is decided on the caller's whole scope BEFORE any
 * filter selects what is returned, so a filter can only hide cells, never reveal one or change a decision:
 *  1. a group of fewer than PAY_AVERAGE_MINIMUM_GROUP people is suppressed;
 *  2. differencing: a group whose complement within its parent (company within all companies, department within
 *     its company) is 1 to 4 people is suppressed, since the parent minus it would describe that small complement;
 *  3. complementary suppression: within a parent, the suppressed groups must be none, or at least two holding at
 *     least PAY_AVERAGE_MINIMUM_GROUP people together; otherwise the smallest published group is suppressed too;
 *  4. a suppressed company suppresses all its departments; the all-companies total is published only when every
 *     company with a run shares one currency.
 * A suppressed group shows why (withheldBecause) and no headcount or figure. Medians are rounded to the nearest 10 currency units, so an
 * odd-sized group's median is never one person's exact pay; averages are rounded half up to the cent. */
import {and,asc,desc,eq,inArray,isNull,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../../db/client';
import {assignment,company,department,employment,payrollBatch,payslip} from '../../db/schema';
import {canManagePayroll} from '../../lib/authz-model';
import {isModuleEnabled,resolveEntitlementsTx} from '../../core/entitlements';
import {payslipDisplayEarnings} from '../../core/pay-display-category';

export const PAY_AVERAGE_MINIMUM_GROUP=5;
/** Medians are published to this many cents (10.00 currency units). */
export const PAY_AVERAGE_MEDIAN_STEP_CENTS=1000;
export const PAY_AVERAGE_MEASURE='basic_pay_paid' as const;
export const PAY_AVERAGE_MEASURE_LABEL='Basic pay paid in each company\'s latest closed regular payroll run, as printed under Basic on the payslip and in the Payroll Register: prorated for joiners and leavers, rate x days or hours for daily- and hourly-paid staff, before unpaid leave and every other deduction, and excluding allowances, overtime, bonus and claims. Each person counts once per company; a payslip with zero basic counts.';
export type PayAverageBreakdown='company'|'department';
export type SuppressionReason='fewer_than_minimum'|'complement_too_small'|'protects_another_group'|'company_suppressed';
export type PayAverageFigures=Readonly<{headcount:number;average:string;median:string}>;
export type PayAverageCell=Readonly<{status:'published'}&PayAverageFigures>|Readonly<{status:'suppressed';withheldBecause:SuppressionReason}>;
export type PayAverageDepartment=Readonly<{department:string|null}>&PayAverageCell;
export type PayAverageCompany=Readonly<{companyId:string;company:string;currency:string;payPeriod:string;departments?:readonly PayAverageDepartment[]}>&PayAverageCell
 |Readonly<{companyId:string;company:string;currency:string;status:'no_closed_run'}>;
export type PayAverageOverall=Readonly<{currency:string}>&PayAverageCell|Readonly<{status:'not_combined';withheldBecause:'mixed_currencies'}>|Readonly<{status:'no_closed_run'}>;
export type PayAverages=Readonly<{ok:true;measure:typeof PAY_AVERAGE_MEASURE;measureLabel:string;breakdown:PayAverageBreakdown;minimumGroup:number;
 /** Always every company in the caller's scope, whatever the filter: a filtered total would difference a suppressed company. */
 overall:PayAverageOverall;companies:readonly PayAverageCompany[]}>;
export type PayAveragesRefused=Readonly<{ok:false;refusal:'not_permitted'|'invalid_input';message:string}>;
export type PayAveragesOptions=Readonly<{breakdown?:PayAverageBreakdown;
 /** Selects which companies are RETURNED; never changes a figure or a suppression decision. */
 companyIds?:readonly string[]}>;

/** One person's basic pay in one company's run, in cents. */
export type PayAverageRow=Readonly<{companyId:string;personId:string;departmentKey:string|null;cents:number}>;
export type PayAverageCompanyInput=Readonly<{companyId:string;company:string;currency:string;payPeriod:string|null}>;
export type PayAverageDepartmentNames=ReadonlyMap<string,string>;

const NOT_PERMITTED='Pay averages are available only to people with payroll access, for the companies whose payroll they administer.';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Payslips per read; far above any tenant today. */
const MAX_PEOPLE=200_000;
const refused=(refusal:PayAveragesRefused['refusal'],message:string):PayAveragesRefused=>Object.freeze({ok:false,refusal,message});
const freeze=<T>(value:T):T=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};

/** Cents as a decimal string, "1234.05". */
export function centsText(cents:number):string{
 const sign=cents<0?'-':'',abs=Math.abs(cents);return sign+Math.floor(abs/100)+'.'+String(abs%100).padStart(2,'0');
}
/** Half up, on integers only: round(numerator / denominator) for a positive denominator. */
const roundHalfUp=(numerator:number,denominator:number)=>Math.floor((2*numerator+denominator)/(2*denominator));
/** Headcount, average (half up to the cent) and median (half up to PAY_AVERAGE_MEDIAN_STEP_CENTS). */
export function figuresOf(values:readonly number[]):PayAverageFigures{
 const sorted=[...values].sort((a,b)=>a-b),count=sorted.length,middle=Math.floor(count/2);
 const sum=sorted.reduce((total,value)=>total+value,0);
 if(!count||!Number.isSafeInteger(2*sum+count)||!Number.isSafeInteger(2*sorted[count-1]))throw new Error('Pay average figures are out of range.');
 // Twice the median, so an even count's midpoint stays an integer.
 const twiceMedian=count%2?2*sorted[middle]:sorted[middle-1]+sorted[middle];
 return{headcount:count,average:centsText(roundHalfUp(sum,count)),median:centsText(roundHalfUp(twiceMedian,2*PAY_AVERAGE_MEDIAN_STEP_CENTS)*PAY_AVERAGE_MEDIAN_STEP_CENTS)};
}
/** Suppression of the children of one published parent of `parent` people (rules 1 to 3). Keys are compared as
 * given, so the order of `children` decides ties deterministically. Returns the suppressed keys and why. */
export function suppressChildren(parent:number,children:readonly Readonly<{key:string;people:number}>[]):ReadonlyMap<string,SuppressionReason>{
 const out=new Map<string,SuppressionReason>(),minimum=PAY_AVERAGE_MINIMUM_GROUP;
 for(const child of children){
  if(child.people<minimum)out.set(child.key,'fewer_than_minimum');
  else if(parent-child.people>0&&parent-child.people<minimum)out.set(child.key,'complement_too_small');
 }
 const held=()=>children.filter(child=>out.has(child.key)).reduce((total,child)=>total+child.people,0);
 while(out.size&&(out.size<2||held()<minimum)){
  const next=children.filter(child=>!out.has(child.key)).sort((a,b)=>a.people-b.people)[0];
  if(!next)break;out.set(next.key,'protects_another_group');
 }
 return out;
}
/** Code-point order: the same in every runtime and locale. */
const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;
const cell=(values:readonly number[],reason:SuppressionReason|undefined):PayAverageCell=>reason?{status:'suppressed',withheldBecause:reason}:{status:'published',...figuresOf(values)};

/** The whole result from rows already read. Pure. `companies` lists every company in the caller's scope, in output
 * order; departments are listed by name, then key, with people of no single current department last. */
export function payAverageCells(companies:readonly PayAverageCompanyInput[],rows:readonly PayAverageRow[],departmentNames:PayAverageDepartmentNames,
 breakdown:PayAverageBreakdown,select?:ReadonlySet<string>):PayAverages{
 const byCompany=new Map<string,Map<string,{department:string|null;cents:number}>>();
 for(const row of rows){
  if(!Number.isSafeInteger(row.cents))throw new Error('Pay average input is not a whole number of cents.');
  const people=byCompany.get(row.companyId)??new Map<string,{department:string|null;cents:number}>();byCompany.set(row.companyId,people);
  const prior=people.get(row.personId);
  // A person with several payslips in one run is one person: basic summed; a department only when they all agree.
  people.set(row.personId,prior?{department:prior.department===row.departmentKey?prior.department:null,cents:prior.cents+row.cents}:{department:row.departmentKey,cents:row.cents});
 }
 const withRun=companies.filter(row=>row.payPeriod!==null&&(byCompany.get(row.companyId)?.size??0)>0);
 const valuesOf=(companyId:string)=>[...(byCompany.get(companyId)?.values()??[])].map(person=>person.cents);
 const currencies=new Set(withRun.map(row=>row.currency));
 const combined=currencies.size===1;
 const allValues=withRun.flatMap(row=>valuesOf(row.companyId));
 // The all-companies total is a parent only when it is published; otherwise only rule 1 applies to companies.
 const overallSuppressed=combined&&allValues.length<PAY_AVERAGE_MINIMUM_GROUP;
 const companyDecisions=combined&&!overallSuppressed
  ?suppressChildren(allValues.length,withRun.map(row=>({key:row.companyId,people:valuesOf(row.companyId).length})))
  :new Map(withRun.filter(row=>valuesOf(row.companyId).length<PAY_AVERAGE_MINIMUM_GROUP||overallSuppressed).map(row=>[row.companyId,'fewer_than_minimum' as SuppressionReason]));
 const overall:PayAverageOverall=!withRun.length?{status:'no_closed_run'}:!combined?{status:'not_combined',withheldBecause:'mixed_currencies'}
  :{currency:[...currencies][0],...cell(allValues,overallSuppressed?'fewer_than_minimum':undefined)};
 const output=companies.filter(row=>!select||select.has(row.companyId)).map((row):PayAverageCompany=>{
  const base={companyId:row.companyId,company:row.company,currency:row.currency};
  if(row.payPeriod===null||!withRun.includes(row))return{...base,status:'no_closed_run'};
  const values=valuesOf(row.companyId),companyReason=companyDecisions.get(row.companyId);
  const result={...base,payPeriod:row.payPeriod,...cell(values,companyReason)};
  if(breakdown!=='department')return result;
  const groups=new Map<string,number[]>();
  for(const person of byCompany.get(row.companyId)!.values()){const key=person.department??'';groups.set(key,[...(groups.get(key)??[]),person.cents]);}
  const name=(key:string)=>key?departmentNames.get(key)??'':'';
  const ordered=[...groups.keys()].sort((a,b)=>(a===''?1:0)-(b===''?1:0)||compare(name(a),name(b))||compare(a,b));
  const decisions=companyReason?new Map(ordered.map(key=>[key,'company_suppressed' as SuppressionReason]))
   :suppressChildren(values.length,ordered.map(key=>({key,people:groups.get(key)!.length})));
  return{...result,departments:ordered.map(key=>({department:key?name(key):null,...cell(groups.get(key)!,decisions.get(key))}))};
 });
 const result:PayAverages={ok:true,measure:PAY_AVERAGE_MEASURE,measureLabel:PAY_AVERAGE_MEASURE_LABEL,breakdown,minimumGroup:PAY_AVERAGE_MINIMUM_GROUP,overall,companies:output};
 return freeze(result);
}

/** Pay averages over each company's latest closed regular run, read as the caller under RLS. */
export async function payAverages(ctx:SessionContext,options:PayAveragesOptions={}):Promise<PayAverages|PayAveragesRefused>{
 const breakdown=options.breakdown??'company';
 if(breakdown!=='company'&&breakdown!=='department')return refused('invalid_input','Choose a breakdown by company or by department.');
 const filter=options.companyIds;
 if(filter!==undefined&&(!Array.isArray(filter)||!filter.length||filter.length>100||filter.some(id=>typeof id!=='string'||!UUID.test(id))))return refused('invalid_input','Name between one and a hundred companies.');
 if(!ctx.userId||!canManagePayroll(ctx))return refused('not_permitted',NOT_PERMITTED);
 return withTenant(ctx,async tx=>{
  // The database decides the payroll scope: the payslip policy's own app.can_admin_payroll_for, for a current principal.
  const scoped=await tx.select({companyId:company.id,company:company.legalName,currency:company.currency}).from(company)
   .where(and(eq(company.tenantId,ctx.tenantId),isNull(company.archivedAt),sql`app.principal_snapshot_current() IS TRUE`,sql`app.can_admin_payroll_for(${company.id}) IS TRUE`))
   .orderBy(asc(company.legalName),asc(company.id));
  const entitled={...ctx,entitlements:await resolveEntitlementsTx(tx,ctx.tenantId),entitlementsExempt:undefined,entitlementsError:undefined};
  const companies=scoped.filter(row=>isModuleEnabled(entitled,'payroll',row.companyId));
  if(!companies.length)return refused('not_permitted',NOT_PERMITTED);
  const ids=companies.map(row=>row.companyId),select=filter?new Set(filter.map(id=>id.toLowerCase())):undefined;
  if(select&&[...select].some(id=>!ids.includes(id)))return refused('not_permitted',NOT_PERMITTED);
  // Latest closed REGULAR run per company: off-cycle, bonus and adjustment runs pay no basic (core/payroll.ts).
  const runs=await tx.selectDistinctOn([payrollBatch.companyId],{id:payrollBatch.id,companyId:payrollBatch.companyId,payPeriod:payrollBatch.payPeriod}).from(payrollBatch)
   .where(and(eq(payrollBatch.tenantId,ctx.tenantId),inArray(payrollBatch.companyId,ids),eq(payrollBatch.status,'closed'),eq(payrollBatch.runType,'regular')))
   .orderBy(payrollBatch.companyId,desc(payrollBatch.payPeriod),desc(payrollBatch.runSeq),desc(payrollBatch.id));
  const runOf=new Map(runs.map(run=>[run.companyId,run]));
  const slips=runs.length?await tx.select({slipId:payslip.id,batchId:payslip.batchId,personId:employment.personId,basic:payslip.basicSalary,
    display:sql<Record<string,unknown>|null>`${payslip.statutory}->'displayEarnings'`,departmentId:assignment.departmentId,department:department.name})
   .from(payslip).innerJoin(employment,eq(employment.id,payslip.employmentId))
   // The person's current department, read as the Payroll Register reads it (core/payroll-view.ts).
   .leftJoin(assignment,and(eq(assignment.employmentId,employment.id),isNull(assignment.validTo),isNull(assignment.supersededAt)))
   .leftJoin(department,eq(department.id,assignment.departmentId))
   .where(and(eq(payslip.tenantId,ctx.tenantId),inArray(payslip.batchId,runs.map(run=>run.id)))):[];
  const companyOfBatch=new Map(runs.map(run=>[run.id,run.companyId])),names=new Map<string,string>();
  // One entry per payslip: an employment with several current assignment rows keeps its slip once, with no single department.
  const perSlip=new Map<string,{companyId:string;personId:string;departments:Set<string|null>;cents:number}>();
  for(const slip of slips){
   const companyId=companyOfBatch.get(slip.batchId)!;
   // A department the caller cannot read (no name under RLS) counts as no single department.
   const departmentId=slip.departmentId&&slip.department!==null?slip.departmentId:null;
   if(departmentId)names.set(departmentId,slip.department!);
   const known=perSlip.get(slip.slipId);if(known){known.departments.add(departmentId);continue;}
   const basic=payslipDisplayEarnings({basic:slip.basic,statutory:slip.display?{displayEarnings:slip.display}:{}}).basic;
   perSlip.set(slip.slipId,{companyId,personId:slip.personId,departments:new Set([departmentId]),cents:Math.round(basic*100)});
  }
  if(perSlip.size>MAX_PEOPLE)throw new Error('Pay averages: payroll runs too large to summarise.');
  const rows=[...perSlip.values()].map(slip=>({companyId:slip.companyId,personId:slip.personId,cents:slip.cents,
   departmentKey:slip.departments.size===1?[...slip.departments][0]:null}));
  return payAverageCells(companies.map(row=>({...row,payPeriod:runOf.get(row.companyId)?.payPeriod??null})),rows,names,breakdown,select);
 });
}
