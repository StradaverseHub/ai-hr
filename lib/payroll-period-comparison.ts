/** Declarative report contract and exact arithmetic; never calculates an employee's pay. */
export const PAYROLL_COMPARISON_DATASET='payroll_period_comparison';
export const PAYROLL_COMPARISON_COLUMNS=['employeeCode','employeeName','department','grade','company','costCentre','variancePct','effectiveDate','remarks'] as const;
export type PayrollComparisonColumn=typeof PAYROLL_COMPARISON_COLUMNS[number];
export const PAYROLL_COMPARISON_REASONS=['unexplained','increment','promotion','demotion','newHire','resigned','proratedLeaving','transfer','unclassified'] as const;
export type PayrollComparisonReason=typeof PAYROLL_COMPARISON_REASONS[number];
export type PayrollComparisonDefinition={
 version:1;payItemCode:string;compareMode:'previous'|'specific';previousPeriod:string|null;
 runType:'regular'|'all';minVariance:string;autoTag:boolean;onlyVariances:boolean;
 columns:PayrollComparisonColumn[];roles:('hr_admin'|'super_admin')[];
};
export const DEFAULT_PAYROLL_COMPARISON:PayrollComparisonDefinition={version:1,payItemCode:'BASIC',compareMode:'previous',previousPeriod:null,
 runType:'regular',minVariance:'0.01',autoTag:true,onlyVariances:true,columns:[...PAYROLL_COMPARISON_COLUMNS],roles:['hr_admin','super_admin']};
export class PayrollComparisonInputError extends Error {constructor(readonly code:string){super(`Payroll comparison: ${code}`);this.name='PayrollComparisonInputError';}}
const fail=(code:string):never=>{throw new PayrollComparisonInputError(code);};
export const isPayrollComparisonPeriod=(value:unknown):value is string=>typeof value==='string'&&/^(?:19|20|21)\d{2}-(0[1-9]|1[0-2])$/.test(value);
export function previousPayrollComparisonPeriod(current:string){
 if(!isPayrollComparisonPeriod(current))fail('period');
 const [year,month]=current.split('-').map(Number);return month===1?`${year-1}-12`:`${year}-${String(month-1).padStart(2,'0')}`;
}
/** The input already is a saved result amount, with at most two decimal places. */
export function payrollAmountMinor(value:unknown):bigint{
 if(typeof value!=='string'&&typeof value!=='number')fail('amount');
 const text=String(value);
 if(!/^-?\d{1,16}(?:\.\d{1,2})?$/.test(text))fail('amount');
 const negative=text.startsWith('-'),[whole,fraction='']=text.replace(/^-/,'').split('.');
 const amount=BigInt(whole)*BigInt('100')+BigInt(fraction.padEnd(2,'0'));return negative?-amount:amount;
}
export function payrollMinorDecimal(value:bigint):string{
 const abs=value<BigInt('0')?-value:value;return `${value<BigInt('0')?'-':''}${abs/BigInt('100')}.${String(abs%BigInt('100')).padStart(2,'0')}`;
}
const roundedRatio=(numerator:bigint,denominator:bigint)=>{
 if(!denominator)fail('zeroDenominator');
 const negative=(numerator<BigInt('0'))!==(denominator<BigInt('0')),a=numerator<BigInt('0')?-numerator:numerator,b=denominator<BigInt('0')?-denominator:denominator;
 const rounded=a/b+(a%b*BigInt('2')>=b?BigInt('1'):BigInt('0'));return negative?-rounded:rounded;
};
export function payrollVariance(previous:bigint,current:bigint){
 const difference=current-previous;
 return {difference:payrollMinorDecimal(difference),percentage:previous===BigInt('0')?null:payrollMinorDecimal(roundedRatio(difference*BigInt('10000'),previous))};
}
function exactKeys(value:Record<string,unknown>,allowed:readonly string[]){if(Object.keys(value).some(key=>!allowed.includes(key)))fail('unknownField');}
function selected<T extends string>(value:unknown,allowed:readonly T[],code:string):T[]{
 if(!Array.isArray(value)||value.some(entry=>typeof entry!=='string'||!allowed.includes(entry as T))||new Set(value).size!==value.length)fail(code);
 return value as T[];
}
export function validatePayrollComparisonDefinition(value:unknown):PayrollComparisonDefinition{
 if(!value||typeof value!=='object'||Array.isArray(value))fail('definition');
 const v=value as Record<string,unknown>;
 exactKeys(v,['version','payItemCode','compareMode','previousPeriod','runType','minVariance','autoTag','onlyVariances','columns','roles']);
 if(v.version!==1||typeof v.payItemCode!=='string'||!/^[-A-Za-z0-9_/.]{1,64}$/.test(v.payItemCode))fail('payItem');
 if(v.compareMode!=='previous'&&v.compareMode!=='specific')fail('compareMode');
 if(v.compareMode==='specific'?!isPayrollComparisonPeriod(v.previousPeriod):v.previousPeriod!==null)fail('previousPeriod');
 if(v.runType!=='regular'&&v.runType!=='all')fail('runType');
 const minimum=payrollAmountMinor(v.minVariance);if(minimum<BigInt('0')||minimum>BigInt('99999999999999'))fail('minVariance');
 if(typeof v.autoTag!=='boolean'||typeof v.onlyVariances!=='boolean')fail('boolean');
 const columns=selected(v.columns,PAYROLL_COMPARISON_COLUMNS,'columns'),roles=selected(v.roles,['hr_admin','super_admin'] as const,'roles');if(!roles.length)fail('roles');
 return {version:1,payItemCode:v.payItemCode,compareMode:v.compareMode,previousPeriod:v.previousPeriod as string|null,runType:v.runType,
  minVariance:payrollMinorDecimal(minimum),autoTag:v.autoTag,onlyVariances:v.onlyVariances,columns,roles};
}
export type PayrollComparisonFilters={currentPeriod:string|null;previousPeriod:string|null;companyId:string|null;departmentId:string|null;
 runType:'regular'|'all';minVariance:string;onlyVariances:boolean;reason:PayrollComparisonReason|null;page:number;pageSize:number};
const id=(value:unknown)=>value==null||value===''?null:typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)?value:fail('identity');
export function payrollComparisonFilters(values:Record<string,unknown>,definition:PayrollComparisonDefinition):PayrollComparisonFilters{
 exactKeys(values,['currentPeriod','previousPeriod','companyId','departmentId','runType','minVariance','onlyVariances','reason','page','pageSize']);
 const month=(value:unknown)=>value==null||value===''?null:isPayrollComparisonPeriod(value)?value:fail('period');
 const currentPeriod=month(values.currentPeriod),previousPeriod=month(values.previousPeriod)??(definition.compareMode==='specific'?definition.previousPeriod:currentPeriod?previousPayrollComparisonPeriod(currentPeriod):null);
 if(currentPeriod&&previousPeriod&&previousPeriod>=currentPeriod)fail('periodOrder');
 const runType=values.runType??definition.runType;if(runType!=='all'&&runType!=='regular')fail('runType');
 const minimum=payrollAmountMinor(values.minVariance??definition.minVariance);if(minimum<BigInt('0')||minimum>BigInt('99999999999999'))fail('minVariance');
 const only=values.onlyVariances??definition.onlyVariances;
 if(![true,false,'1','0'].includes(only as never))fail('boolean');
 const reason=values.reason==null||values.reason===''?null:PAYROLL_COMPARISON_REASONS.includes(values.reason as PayrollComparisonReason)?values.reason as PayrollComparisonReason:fail('reason');
 const integer=(value:unknown,fallback:number,max:number)=>{if(value==null||value==='')return fallback;if(typeof value!=='number'&&(typeof value!=='string'||!/^\d+$/.test(value)))fail('pagination');const n=Number(value);if(!Number.isSafeInteger(n)||n<1||n>max)fail('pagination');return n;};
 return {currentPeriod,previousPeriod,companyId:id(values.companyId),departmentId:id(values.departmentId),runType,minVariance:payrollMinorDecimal(minimum),onlyVariances:only===true||only==='1',reason,page:integer(values.page,1,1000000),pageSize:integer(values.pageSize,50,200)};
}
/** These are already projected, applied facts from Movement, never raw event-name guesses. */
export type PayrollComparisonMovement={id:string;sequence:number;effectiveDate:string;kind:'increment'|'promotion'|'demotion'|'transfer'|'exit';salaryChanged:boolean;status:'applied'|'pending'|'superseded'|'reversed'};
export type PayrollReasonEvidence={reason:PayrollComparisonReason;effectiveDate:string|null;evidenceIds:string[];multipleChanges:boolean;prorated:boolean};
export function payrollComparisonReason(p:{autoTag:boolean;periodFrom:string;periodTo:string;hireDate:string;exitDate:string|null;
 previous:bigint;current:bigint;previousPeriodFrom:string;previousCoverage:{from:string;to:string}[];currentCoverage:{from:string;to:string}[];movements:readonly PayrollComparisonMovement[];verifiedTransferIds?:readonly string[]}):PayrollReasonEvidence{
 const result=(reason:PayrollComparisonReason,effectiveDate:string|null=null,evidenceIds:string[]=[],multipleChanges=false,prorated=false):PayrollReasonEvidence=>({reason,effectiveDate,evidenceIds,multipleChanges,prorated});
 if(!p.autoTag)return result('unclassified');
 const applied=p.movements.filter(m=>m.status==='applied'&&m.effectiveDate>=p.periodFrom&&m.effectiveDate<=p.periodTo);
 const transfers=applied.filter(m=>m.kind==='transfer'&&p.verifiedTransferIds?.includes(m.id)).sort((a,b)=>b.effectiveDate.localeCompare(a.effectiveDate)||b.sequence-a.sequence);
 if(transfers.length)return result('transfer',transfers[0].effectiveDate,transfers.map(m=>m.id));
 const within=(date:string)=>date>=p.periodFrom&&date<=p.periodTo;
 const coveredHire=p.currentCoverage.some(coverage=>coverage.from===p.hireDate&&coverage.from>p.periodFrom);
 if(p.previous===BigInt('0')&&p.current>BigInt('0')&&within(p.hireDate))return result('newHire',p.hireDate,[],false,coveredHire);
 const exits=p.movements.filter(m=>m.status==='applied'&&m.kind==='exit'&&m.effectiveDate===p.exitDate&&m.effectiveDate>=p.previousPeriodFrom&&m.effectiveDate<=p.periodTo);
 if(p.exitDate&&exits.length&&p.previous>BigInt('0')&&p.current===BigInt('0')&&(within(p.exitDate)||p.previousCoverage.some(coverage=>coverage.to===p.exitDate)))return result('resigned',p.exitDate,exits.map(m=>m.id));
 if(p.exitDate&&within(p.exitDate)&&p.current>BigInt('0')&&exits.length&&p.currentCoverage.some(coverage=>coverage.to===p.exitDate&&coverage.to<p.periodTo))return result('proratedLeaving',p.exitDate,exits.map(m=>m.id),false,true);
 const changes=applied.filter((m):m is PayrollComparisonMovement&{kind:'increment'|'promotion'|'demotion'}=>m.salaryChanged&&['increment','promotion','demotion'].includes(m.kind)).sort((a,b)=>b.effectiveDate.localeCompare(a.effectiveDate)||b.sequence-a.sequence);
 if(changes.length)return result(changes[0].kind,changes[0].effectiveDate,changes.map(m=>m.id),changes.length>1);
 return result('unexplained');
}
