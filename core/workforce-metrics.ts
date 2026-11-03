/** AI v2 W7 — governed workforce metrics for analysis in chat (pattern: the pay averages, packs/payroll/pay-averages.ts).
 *
 * Four metrics, each computed here from its native owner and read AS THE CALLER under RLS. A model only words them:
 *  - headcount: people with an employment active on a date, optionally with joiners and leavers in a period
 *    (the effective-dated employment and assignment owners, core/analytics.ts semantics);
 *  - turnover: leavers in a period divided by the average of the headcount on its first and last days;
 *  - overtime_trend: overtime HOURS (never pay) recorded on attendance for each of the six full months before the
 *    current month (the attendance owner: ot_minutes, or the recorded duration of a day an overtime pattern calculated,
 *    exactly as the Overtime report sums them, lib/overtime-records.ts summarizeOvertimeRecords);
 *  - leave_liability: the outstanding annual leave balance in DAYS (never money) on a date (the leave ledger).
 * Dates come from the HR date owner (lib/hr-date.ts); a named period is resolved here, never by a model.
 *
 * WHO MAY ASK. An HR administrator, for the companies the database says they administer (app.is_admin_for, for a
 * current principal, the company not archived, with the employees module and the metric's module enabled). A manager,
 * for their own team only (core/my-team-scope.ts resolveMyTeamScopeTx, the My Team page's own scope), and only what
 * that page shows: headcount as of today, overtime where attendance is on (the page links each person's attendance
 * records), and annual leave days where the leave type's Available and Pending lines are shown. No turnover, joiners
 * or leavers for a manager. Everyone else is refused in one sentence.
 *
 * SUPPRESSION (fail closed), the pay-average rules (packs/payroll/pay-averages.ts suppressChildren), decided over the
 * caller's whole scope. Groups count PEOPLE, each person once per company:
 *  1. a group of fewer than WORKFORCE_MINIMUM_GROUP people is withheld; for overtime and leave days, so is a group whose
 *     members' values are all equal (its total and average would be each member's exact figure, zero included);
 *  2. a group whose complement within its parent (a department within its company or the team, a company within all
 *     companies) is 1 to 4 people is withheld;
 *  3. complementary suppression: the withheld groups of a parent must be none, or at least two holding at least five
 *     people together whose values are not all equal; otherwise the smallest published group is withheld too;
 *  4. a withheld company or team withholds all its departments.
 * A group's size is its population: for a point in time, the people active on that date; for a period (a month for
 * overtime), everyone employed in the group at any time in it. A withheld group shows why and no figure. */
import {and,asc,eq,gte,inArray,isNull,lte,or,sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {assignment,attendance,company,department,employment,leaveLedger,leaveType} from '../db/schema';
import {hasTeamAccess,isAdmin} from '../lib/authz-model';
import {todayInKualaLumpur} from '../lib/hr-date';
import {monthRange} from '../lib/roster-month';
import {summarizeOvertimeRecords,type FormulaOvertimeRecord} from '../lib/overtime-records';
import {isModuleEnabled,ModuleNotEnabledError,resolveEntitlementsTx} from './entitlements';
import {resolveEssView} from './ess-view';
import {MyTeamAuthorizationError,resolveMyTeamScopeTx} from './my-team-scope';
import {formulaOvertimeForRowsTx} from '../packs/attendance/service';
import {leaveTypeIs} from '../packs/leave/service';
import {PAY_AVERAGE_MINIMUM_GROUP,suppressChildren,valuesIdentical} from '../packs/payroll/service';

export const WORKFORCE_METRICS=['headcount','turnover','overtime_trend','leave_liability'] as const;
export type WorkforceMetric=(typeof WORKFORCE_METRICS)[number];
export const WORKFORCE_PERIODS=['this_month','last_month','this_quarter','last_quarter','this_year','last_year'] as const;
export type WorkforcePeriod=(typeof WORKFORCE_PERIODS)[number];
export const WORKFORCE_BREAKDOWNS=['company','department'] as const;
export type WorkforceBreakdown=(typeof WORKFORCE_BREAKDOWNS)[number];
export type WorkforceScope='administered_companies'|'team';
export const WORKFORCE_MINIMUM_GROUP=PAY_AVERAGE_MINIMUM_GROUP;
export const OVERTIME_TREND_MONTHS=6;
export const WORKFORCE_REASONS=['fewer_than_minimum','values_identical','complement_too_small','protects_another_group','company_suppressed','team_suppressed'] as const;
export type WorkforceReason=(typeof WORKFORCE_REASONS)[number];
/** Exactly what each metric measures. */
export const WORKFORCE_METRIC_LABELS:Readonly<Record<WorkforceMetric,string>>=Object.freeze({
 headcount:'People with an employment active on the date (hired on or before it and not yet terminated; an employment ends on its termination date), each person once per company, by the department of the assignment in force on that date. With a period, the headcount is on its last day; joiners are people hired within it and leavers are people whose employment ended within it, by the department of their last assignment in the period; a move from one employment to another in the same company is neither.',
 turnover:'Leavers in the period divided by the average of the headcount on its first and last days, as a percentage to one decimal place. Leavers are people whose employment in the company ended within the period and who were not employed there again by its end. Each person counts once per company, by the department of their last assignment in the period.',
 overtime_trend:'Overtime hours (not pay) recorded on attendance in each of the six full calendar months before the current month: each attendance day\'s stored overtime minutes, or the recorded duration where an overtime pattern calculated the day, summed per group and shown to one decimal place. A month marked not complete has attendance days whose overtime is not yet calculated; they count as none. Each group is the people employed in it at any time in the month.',
 leave_liability:'Outstanding annual leave balance in days (not money) on the date: every annual leave ledger entry dated on or before it (grants, accruals, carry-forward, adjustments, expiries and approved leave taken), summed per person; pending requests are not deducted. Total and average per person, by the department of the assignment in force on the date.',
});

/** One person in one company over one window. Internal to the service: never returned. */
export type WorkforceUnit=Readonly<{companyId:string;personId:string;departmentKey:string|null;
 activeStart:boolean;activeEnd:boolean;joined:boolean;left:boolean;
 /** Overtime: the person's recorded minutes in the month, as a fraction, and whether every day was calculated. */
 minutes?:Readonly<{numerator:string;denominator:string}>;complete?:boolean;
 /** Leave: the person's annual leave balance in hundredths of a day. */
 hundredths?:number}>;
export type WorkforceCell=Readonly<Record<string,unknown>>;
export type WorkforceDepartment=Readonly<{department:string|null}>&WorkforceCell;
export type WorkforceCompany=Readonly<{companyId:string;company:string;departments?:readonly WorkforceDepartment[]}>&WorkforceCell;
export type WorkforceMetricsResult=Readonly<{ok:true;metric:WorkforceMetric;metricLabel:string;scope:WorkforceScope;breakdown:WorkforceBreakdown;
 asOf?:string;period?:Readonly<{from:string;to:string}>;minimumGroup:number;
 /** Every company in the caller's scope combined, or the whole team. */
 overall:WorkforceCell;
 /** One row per administered company (empty for a team). */
 companies:readonly WorkforceCompany[];
 /** The team's departments, when a manager asks by department. */
 departments?:readonly WorkforceDepartment[]}>;
export type WorkforceMetricsRefused=Readonly<{ok:false;refusal:'not_permitted'|'invalid_input';message:string}>;
export type WorkforceMetricsOptions=Readonly<{metric?:unknown;breakdown?:unknown;period?:unknown;from?:unknown;to?:unknown;asOf?:unknown}>;

const NOT_PERMITTED='Workforce figures are available only to HR administrators, for the companies they administer, and to managers, for their own team.';
const TEAM_TURNOVER='Turnover is available only to HR administrators, for the companies they administer.';
const TEAM_TODAY='For your team, figures are as of today; joiners, leavers and turnover over a period are available to HR administrators.';
const TEAM_ATTENDANCE='Overtime for your team is available only where attendance is switched on.';
const ATTENDANCE_OFF='Overtime is available only for companies where attendance is switched on.';
const TEAM_LEAVE='Your team page does not show annual leave balances, so they are not available here.';
const MAX_ROWS=400_000;
const refused=(refusal:WorkforceMetricsRefused['refusal'],message:string):WorkforceMetricsRefused=>Object.freeze({ok:false,refusal,message});
const freeze=<T>(value:T):T=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;

// ─── Dates (the HR date owner gives today; everything else is calendar arithmetic) ───────────────────────────────
const DATE=/^\d{4}-\d{2}-\d{2}$/;
export const isRealDate=(value:unknown):value is string=>typeof value==='string'&&DATE.test(value)&&!Number.isNaN(Date.parse(value+'T00:00:00Z'))
 &&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const shiftDays=(iso:string,days:number)=>new Date(Date.parse(iso+'T00:00:00Z')+days*86_400_000).toISOString().slice(0,10);
const month=(year:number,index:number)=>`${year}-${String(index).padStart(2,'0')}`;
/** The six full calendar months before the current one, oldest first. */
export function overtimeTrendMonths(today:string):readonly string[]{
 const year=Number(today.slice(0,4)),current=Number(today.slice(5,7));
 return Object.freeze(Array.from({length:OVERTIME_TREND_MONTHS},(_,index)=>{
  const back=OVERTIME_TREND_MONTHS-index,total=year*12+(current-1)-back;return month(Math.floor(total/12),total%12+1);}));
}
/** A named period, as dates, from today. The current month, quarter and year end today. */
export function workforcePeriodRange(period:WorkforcePeriod,today:string):Readonly<{from:string;to:string}>{
 const year=Number(today.slice(0,4)),current=Number(today.slice(5,7)),quarter=Math.floor((current-1)/3)*3+1;
 switch(period){
  case 'this_month':return{from:today.slice(0,7)+'-01',to:today};
  case 'last_month':{const total=year*12+current-2;return monthRange(month(Math.floor(total/12),total%12+1));}
  case 'this_quarter':return{from:month(year,quarter)+'-01',to:today};
  case 'last_quarter':{const total=year*12+quarter-4,start=month(Math.floor(total/12),total%12+1),end=year*12+quarter-2;
   return{from:start+'-01',to:monthRange(month(Math.floor(end/12),end%12+1)).to};}
  case 'this_year':return{from:year+'-01-01',to:today};
  case 'last_year':return{from:(year-1)+'-01-01',to:(year-1)+'-12-31'};
 }
}

// ─── Pure figures and suppression ───────────────────────────────────────────────────────────────────────────────
const gcd=(a:bigint,b:bigint):bigint=>{let x=a<BigInt(0)?-a:a,y=b<BigInt(0)?-b:b;while(y!==BigInt(0)){const r=x%y;x=y;y=r;}return x;};
const reduced=(minutes:Readonly<{numerator:string;denominator:string}>)=>{
 const n=BigInt(minutes.numerator),d=BigInt(minutes.denominator),g=gcd(n,d)||BigInt(1);return{n:n/g,d:d/g};
};
/** Minutes summed exactly, as hours rounded half up to one decimal place. */
export function overtimeHoursText(values:readonly Readonly<{numerator:string;denominator:string}>[]):string{
 let n=BigInt(0),d=BigInt(1);
 for(const value of values){const next=reduced(value);n=n*next.d+next.n*d;d=d*next.d;const g=gcd(n,d)||BigInt(1);n/=g;d/=g;}
 // Tenths of an hour are minutes / 6: floor((2n + 6d) / 12d) rounds half up.
 const tenths=(BigInt(2)*n+BigInt(6)*d)/(BigInt(12)*d);
 return `${tenths/BigInt(10)}.${tenths%BigInt(10)}`;
}
/** Hundredths as a decimal string, "12.05". */
const hundredthsText=(value:number)=>{const sign=value<0?'-':'',abs=Math.abs(value);return sign+Math.floor(abs/100)+'.'+String(abs%100).padStart(2,'0');};
/** round(numerator / denominator), half up, for a positive denominator. */
const roundHalfUp=(numerator:number,denominator:number)=>Math.floor((2*numerator+denominator)/(2*denominator));

const count=(units:readonly WorkforceUnit[],test:(unit:WorkforceUnit)=>boolean)=>units.reduce((total,unit)=>total+(test(unit)?1:0),0);
function figuresOf(metric:WorkforceMetric,units:readonly WorkforceUnit[],withPeriod:boolean):Record<string,unknown>{
 switch(metric){
  case 'headcount':return{headcount:count(units,unit=>unit.activeEnd),...(withPeriod?{joiners:count(units,unit=>unit.joined),leavers:count(units,unit=>unit.left)}:{})};
  case 'turnover':{
   const start=count(units,unit=>unit.activeStart),end=count(units,unit=>unit.activeEnd),leavers=count(units,unit=>unit.left),both=start+end;
   // Leavers / ((start + end) / 2) x 100 is 2000 x leavers / (start + end) tenths of a percent.
   const tenths=both?roundHalfUp(2000*leavers,both):null;
   return{leavers,headcountStart:start,headcountEnd:end,averageHeadcount:`${Math.floor(both/2)}.${both%2?5:0}`,turnoverRate:tenths===null?null:`${Math.floor(tenths/10)}.${tenths%10}`};
  }
  case 'leave_liability':{
   const total=units.reduce((sum,unit)=>sum+(unit.hundredths??0),0);
   if(!Number.isSafeInteger(2*total+units.length))throw new Error('Leave liability figures are out of range.');
   return{people:units.length,totalDays:hundredthsText(total),averageDays:hundredthsText(roundHalfUp(total,units.length))};
  }
  case 'overtime_trend':return{hours:overtimeHoursText(units.map(unit=>unit.minutes??{numerator:'0',denominator:'1'})),complete:units.every(unit=>unit.complete!==false)};
 }
}
type Node=Readonly<{units:readonly WorkforceUnit[];reason:WorkforceReason|undefined}>;
type Group=Readonly<{key:string;name:string|null;units:readonly WorkforceUnit[]}>;
type Layout=Readonly<{overall:Node;companies:readonly Readonly<{node:Node|null;departments:readonly Readonly<Group&{node:Node}>[]}>[];team:readonly Readonly<Group&{node:Node}>[]}>;
type Value=(unit:WorkforceUnit)=>number;
/** Values that decide the identical-values rule: none for counts. */
function valueFor(metric:WorkforceMetric):Value|undefined{
 if(metric==='leave_liability')return unit=>unit.hundredths??0;
 if(metric!=='overtime_trend')return undefined;
 const ids=new Map<string,number>();
 return unit=>{const value=reduced(unit.minutes??{numerator:'0',denominator:'1'}),key=value.n+'/'+value.d;let id=ids.get(key);if(id===undefined){id=ids.size;ids.set(key,id);}return id;};
}
const primaryReason=(units:readonly WorkforceUnit[],value:Value|undefined):WorkforceReason|undefined=>
 units.length<WORKFORCE_MINIMUM_GROUP?'fewer_than_minimum':value&&valuesIdentical(units.map(value))?'values_identical':undefined;
const child=(group:Group,value:Value|undefined)=>({key:group.key,people:group.units.length,...(value?{values:group.units.map(value)}:{})});
/** Departments by name, then key; people with no single department last. */
function departmentGroups(units:readonly WorkforceUnit[],names:ReadonlyMap<string,string>):Group[]{
 const groups=new Map<string,WorkforceUnit[]>();
 for(const unit of units){const key=unit.departmentKey??'';groups.set(key,[...(groups.get(key)??[]),unit]);}
 const name=(key:string)=>key?names.get(key)??'':'';
 return [...groups.keys()].sort((a,b)=>(a===''?1:0)-(b===''?1:0)||compare(name(a),name(b))||compare(a,b))
  .map(key=>({key,name:key?name(key):null,units:groups.get(key)!}));
}
function childrenOf(parent:Node,groups:readonly Group[],value:Value|undefined,parentWithheld:WorkforceReason):Readonly<Group&{node:Node}>[]{
 const decisions:ReadonlyMap<string,WorkforceReason>=parent.reason?new Map(groups.map(group=>[group.key,parentWithheld] as const))
  :suppressChildren(parent.units.length,groups.map(group=>child(group,value)));
 return groups.map(group=>({...group,node:{units:group.units,reason:decisions.get(group.key)}}));
}
function layout(units:readonly WorkforceUnit[],scope:WorkforceScope,companyIds:readonly string[],names:ReadonlyMap<string,string>,value:Value|undefined):Layout{
 const overall:Node={units,reason:primaryReason(units,value)};
 if(scope==='team')return{overall,companies:[],team:childrenOf(overall,departmentGroups(units,names),value,'team_suppressed')};
 const byCompany=companyIds.map(companyId=>({key:companyId,name:null,units:units.filter(unit=>unit.companyId===companyId)}));
 const populated=byCompany.filter(group=>group.units.length>0);
 // The all-companies total is a parent only when it is published; otherwise only rule 1 applies to companies.
 const decisions:ReadonlyMap<string,WorkforceReason>=overall.reason
  ?new Map(populated.flatMap(group=>{const reason=primaryReason(group.units,value);return reason?[[group.key,reason] as const]:[];}))
  :suppressChildren(units.length,populated.map(group=>child(group,value)));
 return{overall,team:[],companies:byCompany.map(group=>{
  if(!group.units.length)return{node:null,departments:[]};
  const node:Node={units:group.units,reason:decisions.get(group.key)};
  return{node,departments:childrenOf(node,departmentGroups(group.units,names),value,'company_suppressed')};
 })};
}
const cellOf=(metric:WorkforceMetric,node:Node|null,withPeriod:boolean):WorkforceCell=>!node||!node.units.length?{status:'no_people'}
 :node.reason?{status:'suppressed',withheldBecause:node.reason}:{status:'published',...figuresOf(metric,node.units,withPeriod)};

export type WorkforceCellsInput=Readonly<{metric:WorkforceMetric;scope:WorkforceScope;breakdown:WorkforceBreakdown;withPeriod:boolean;
 companies:readonly Readonly<{companyId:string;company:string}>[];departmentNames:ReadonlyMap<string,string>;
 /** Every unit of the window (headcount, turnover, leave days). */
 units?:readonly WorkforceUnit[];
 /** Overtime: the units of each month, oldest first. */
 months?:readonly Readonly<{month:string;units:readonly WorkforceUnit[]}>[]}>;
/** The groups of one result from units already read. Pure. */
export function workforceCells(input:WorkforceCellsInput):Pick<WorkforceMetricsResult,'overall'|'companies'|'departments'>{
 const {metric,scope,breakdown,withPeriod,companies,departmentNames:names}=input,ids=companies.map(row=>row.companyId),value=valueFor(metric);
 const byDepartment=breakdown==='department';
 if(metric!=='overtime_trend'){
  const shape=layout(input.units??[],scope,ids,names,value);
  const departments=(rows:readonly Readonly<Group&{node:Node}>[])=>rows.map(row=>({department:row.name,...cellOf(metric,row.node,withPeriod)}));
  return{overall:cellOf(metric,shape.overall,withPeriod),
   companies:companies.map((row,index)=>{const entry=shape.companies[index];
    return{companyId:row.companyId,company:row.company,...cellOf(metric,entry.node,withPeriod),...(byDepartment&&entry.node?{departments:departments(entry.departments)}:{})};}),
   ...(scope==='team'&&byDepartment?{departments:departments(shape.team)}:{})};
 }
 const months=(input.months??[]).map(row=>({month:row.month,shape:layout(row.units,scope,ids,names,value)}));
 const monthCell=(label:string,node:Node|null)=>({month:label,...cellOf(metric,node,false)});
 /** One row per department seen in any month; a month it had nobody reads no_people. */
 const departmentsOver=(pick:(shape:Layout)=>readonly Readonly<Group&{node:Node}>[])=>{
  const seen=new Map<string,Group>();
  for(const row of months)for(const group of pick(row.shape))if(!seen.has(group.key))seen.set(group.key,group);
  const ordered=departmentGroups([...seen.values()].flatMap(group=>group.units.slice(0,1)),names);
  return ordered.map(group=>({department:group.name,months:months.map(row=>monthCell(row.month,pick(row.shape).find(other=>other.key===group.key)?.node??null))}));
 };
 return{overall:{months:months.map(row=>monthCell(row.month,row.shape.overall))},
  companies:companies.map((row,index)=>({companyId:row.companyId,company:row.company,months:months.map(entry=>monthCell(entry.month,entry.shape.companies[index].node)),
   ...(byDepartment&&months.some(entry=>entry.shape.companies[index].node)?{departments:departmentsOver(shape=>shape.companies[index].departments)}:{})})),
  ...(scope==='team'&&byDepartment?{departments:departmentsOver(shape=>shape.team)}:{})};
}

// ─── Units from the owners' rows ────────────────────────────────────────────────────────────────────────────────
export type WorkforceEmploymentRow=Readonly<{id:string;personId:string;companyId:string;hiredOn:string;terminatedOn:string|null}>;
export type WorkforceAssignmentRow=Readonly<{employmentId:string;departmentId:string|null;validFrom:string;validTo:string|null}>;
/** Active on a day: hired on or before it and not yet terminated (an employment ends on its termination date). */
const activeOn=(row:WorkforceEmploymentRow,day:string)=>row.hiredOn<=day&&(row.terminatedOn===null||row.terminatedOn>day);
/** The department of the assignment in force on a day; on a termination date the closing assignment still counts.
 * Null when none, or several disagree. */
function departmentOn(rows:readonly WorkforceAssignmentRow[],day:string,inclusive:boolean):string|null{
 const covering=new Set(rows.filter(row=>row.validFrom<=day&&(row.validTo===null||(inclusive?row.validTo>=day:row.validTo>day))).map(row=>row.departmentId));
 return covering.size===1?[...covering][0]:null;
}
/** One unit per company and person employed in [from, to]; with `pointInTime`, only people active on `to`. Each
 * unit also lists the employments behind it, for the overtime and leave owners. Pure. */
export function workforceUnits(employments:readonly WorkforceEmploymentRow[],assignments:ReadonlyMap<string,readonly WorkforceAssignmentRow[]>,
 window:Readonly<{from:string;to:string}>,pointInTime:boolean):readonly Readonly<{unit:WorkforceUnit;employmentIds:readonly string[]}>[]{
 const {from,to}=window,people=new Map<string,WorkforceEmploymentRow[]>();
 for(const row of employments){
  if(row.hiredOn>to||(row.terminatedOn!==null&&row.terminatedOn<from))continue;
  if(pointInTime&&!activeOn(row,to))continue;
  const key=row.companyId+'|'+row.personId;people.set(key,[...(people.get(key)??[]),row]);
 }
 return [...people.values()].map(rows=>{
  const others=(row:WorkforceEmploymentRow)=>rows.filter(other=>other!==row);
  // The last day each employment is in the window: its termination date when that falls inside, else the window's end.
  const reference=(row:WorkforceEmploymentRow)=>row.terminatedOn!==null&&row.terminatedOn<=to?row.terminatedOn:to;
  const last=rows.reduce((best,row)=>reference(row)>best?reference(row):best,'');
  const departments=new Set(rows.filter(row=>reference(row)===last).map(row=>departmentOn(assignments.get(row.id)??[],last,row.terminatedOn===last)));
  const unit:WorkforceUnit={companyId:rows[0].companyId,personId:rows[0].personId,departmentKey:departments.size===1?[...departments][0]:null,
   activeStart:rows.some(row=>activeOn(row,from)),activeEnd:rows.some(row=>activeOn(row,to)),
   // A new employment the day another ends, or an old one ending the day another starts, is a move, not a joiner or leaver.
   joined:rows.some(row=>row.hiredOn>=from&&row.hiredOn<=to&&!others(row).some(other=>activeOn(other,shiftDays(row.hiredOn,-1)))),
   left:rows.some(row=>row.terminatedOn!==null&&row.terminatedOn>=from&&row.terminatedOn<=to&&!others(row).some(other=>activeOn(other,row.terminatedOn!)))
    &&!rows.some(row=>activeOn(row,to))};
  return{unit,employmentIds:rows.map(row=>row.id)};
 });
}

// ─── Input ──────────────────────────────────────────────────────────────────────────────────────────────────────
type Parsed=Readonly<{ok:true;metric:WorkforceMetric;breakdown:WorkforceBreakdown;window:Readonly<{from:string;to:string}>|null;asOf:string|null;asOfGiven:boolean}>;
function parse(options:WorkforceMetricsOptions,today:string):Parsed|WorkforceMetricsRefused{
 const {metric,breakdown='company',period,from,to,asOf}=options;
 if(typeof metric!=='string'||!(WORKFORCE_METRICS as readonly string[]).includes(metric))return refused('invalid_input','Choose a metric: headcount, turnover, overtime_trend or leave_liability.');
 if(typeof breakdown!=='string'||!(WORKFORCE_BREAKDOWNS as readonly string[]).includes(breakdown))return refused('invalid_input','Choose a breakdown by company or by department.');
 let window:Readonly<{from:string;to:string}>|null=null;
 if(period!==undefined){
  if(from!==undefined||to!==undefined)return refused('invalid_input','Give either a named period or two dates, not both.');
  if(typeof period!=='string'||!(WORKFORCE_PERIODS as readonly string[]).includes(period))return refused('invalid_input','Choose a period: this_month, last_month, this_quarter, last_quarter, this_year or last_year.');
  window=workforcePeriodRange(period as WorkforcePeriod,today);
 }else if(from!==undefined||to!==undefined){
  if(!isRealDate(from)||!isRealDate(to)||from>to)return refused('invalid_input','Give the period as two dates, YYYY-MM-DD, the first not after the second.');
  if(to>today)return refused('invalid_input','The period cannot end after today.');
  if(Date.parse(to+'T00:00:00Z')-Date.parse(from+'T00:00:00Z')>1096*86_400_000)return refused('invalid_input','Choose a period of at most three years.');
  window={from,to};
 }
 if(asOf!==undefined&&(!isRealDate(asOf)||asOf>today))return refused('invalid_input','Give the date as YYYY-MM-DD, not after today.');
 const given=typeof asOf==='string'?asOf:null,kind=metric as WorkforceMetric;
 if(kind==='overtime_trend'&&(window||given))return refused('invalid_input','The overtime trend always covers the six full months before this month; ask without a date or period.');
 if(kind==='turnover'&&!window)return refused('invalid_input','Name the period for turnover, for example last_quarter.');
 if((kind==='turnover'||kind==='headcount')&&window&&given)return refused('invalid_input','Give either a date or a period, not both.');
 if(kind==='leave_liability'&&window)return refused('invalid_input','Leave days are a balance on one date; give a date, not a period.');
 return{ok:true,metric:kind,breakdown:breakdown as WorkforceBreakdown,window,
  asOf:kind==='headcount'?(window?window.to:given??today):kind==='leave_liability'?given??today:null,asOfGiven:given!==null};
}

// ─── The read, as the caller ────────────────────────────────────────────────────────────────────────────────────
const MODULE_OF:Readonly<Record<WorkforceMetric,string>>={headcount:'employees',turnover:'employees',overtime_trend:'attendance',leave_liability:'leave'};
const chunks=<T>(rows:readonly T[],size=5000):T[][]=>Array.from({length:Math.ceil(rows.length/size)},(_,index)=>rows.slice(index*size,(index+1)*size));
async function employmentsTx(tx:Tx,ctx:SessionContext,scope:Readonly<{companyIds:readonly string[]}|{employmentIds:readonly string[]}>,window:Readonly<{from:string;to:string}>){
 if(('companyIds' in scope?scope.companyIds:scope.employmentIds).length===0)return [];
 const subject='companyIds' in scope?inArray(employment.companyId,[...scope.companyIds]):inArray(employment.id,[...scope.employmentIds]);
 const rows=await tx.select({id:employment.id,personId:employment.personId,companyId:employment.companyId,hiredOn:employment.hiredOn,terminatedOn:employment.terminatedOn})
  .from(employment).where(and(eq(employment.tenantId,ctx.tenantId),subject,lte(employment.hiredOn,window.to),or(isNull(employment.terminatedOn),gte(employment.terminatedOn,window.from))))
  .orderBy(asc(employment.id)).limit(MAX_ROWS+1);
 if(rows.length>MAX_ROWS)throw new Error('Workforce metrics: too many employments to summarise.');
 return rows as WorkforceEmploymentRow[];
}
async function assignmentsTx(tx:Tx,employmentIds:readonly string[]){
 const out=new Map<string,WorkforceAssignmentRow[]>();
 for(const part of chunks(employmentIds)){
  const rows=await tx.select({employmentId:assignment.employmentId,departmentId:assignment.departmentId,validFrom:assignment.validFrom,validTo:assignment.validTo})
   .from(assignment).where(and(inArray(assignment.employmentId,part),isNull(assignment.supersededAt)));
  for(const row of rows)out.set(row.employmentId,[...(out.get(row.employmentId)??[]),row as WorkforceAssignmentRow]);
 }
 return out;
}
/** Names of departments the caller can read; a department without a readable name counts as no single department. */
async function departmentNamesTx(tx:Tx,ids:readonly string[]){
 const names=new Map<string,string>();
 for(const part of chunks(ids))for(const row of await tx.select({id:department.id,name:department.name}).from(department).where(inArray(department.id,part)))names.set(row.id,row.name);
 return names;
}
const marker=(value:unknown):unknown=>{if(typeof value!=='string')return value;try{return JSON.parse(value);}catch{return value;}};
/** Recorded overtime minutes per employment and month (the attendance owner's rows, the Overtime report's sum). */
async function overtimeTx(tx:Tx,ctx:SessionContext,employmentIds:readonly string[],from:string,to:string){
 const rows:{employmentId:string;date:string;otMinutes:number|null;marker:unknown;source:boolean}[]=[];
 for(const part of chunks(employmentIds)){
  const read=await tx.select({employmentId:attendance.employmentId,date:attendance.attendanceDate,otMinutes:attendance.otMinutes,
   marker:sql<unknown>`${attendance.calcTrace}->'overtimePattern'`,
   source:sql<boolean>`EXISTS(SELECT 1 FROM attendance_overtime_source s WHERE s.tenant_id=attendance.tenant_id AND s.employment_id=attendance.employment_id AND s.attendance_date=attendance.attendance_date AND s.current_calculation_id IS NOT NULL)`})
   .from(attendance).where(and(eq(attendance.tenantId,ctx.tenantId),inArray(attendance.employmentId,part),gte(attendance.attendanceDate,from),lte(attendance.attendanceDate,to)));
  for(const row of read)rows.push(row);
  if(rows.length>MAX_ROWS)throw new Error('Workforce metrics: too many attendance days to summarise.');
 }
 // Only a day an overtime pattern touched needs the recorded duration; every other day is its stored minutes.
 const formulaRows=rows.filter(row=>row.source||(marker(row.marker)!==null&&marker(row.marker)!==undefined));
 const formula=formulaRows.length?await formulaOvertimeForRowsTx(tx,ctx,formulaRows.map(row=>({employmentId:row.employmentId,date:row.date,calcTrace:{overtimePattern:marker(row.marker)??null}})))
  :new Map<string,FormulaOvertimeRecord|null>();
 const byMonth=new Map<string,{otMinutes:number|null;formulaOvertime:FormulaOvertimeRecord|null}[]>();
 for(const row of rows){const key=row.employmentId+'|'+row.date.slice(0,7);
  byMonth.set(key,[...(byMonth.get(key)??[]),{otMinutes:row.otMinutes,formulaOvertime:formula.get(row.employmentId+'|'+row.date)??null}]);}
 return byMonth;
}
/** Annual leave balance per employment on a date, in hundredths of a day (the leave ledger, as the balance reads it). */
async function leaveTx(tx:Tx,ctx:SessionContext,employmentIds:readonly string[],asOf:string,team:boolean):Promise<ReadonlyMap<string,number>|null>{
 const types=(await tx.select({id:leaveType.id,code:leaveType.code,role:leaveType.role,essViewConfig:leaveType.essViewConfig,archivedAt:leaveType.archivedAt})
  .from(leaveType).where(eq(leaveType.tenantId,ctx.tenantId))).filter(row=>leaveTypeIs(row,'annual'));
 // A manager sees what My Team shows: an annual type whose Available or Pending line is hidden is not shown there.
 if(team&&types.some(row=>row.archivedAt===null&&(!resolveEssView(row.essViewConfig).available||!resolveEssView(row.essViewConfig).pendingApproval)))return null;
 const out=new Map<string,number>();
 if(!types.length)return out;
 for(const part of chunks(employmentIds))for(const row of await tx.select({employmentId:leaveLedger.employmentId,days:sql<string>`coalesce(sum(${leaveLedger.days}),0)`}).from(leaveLedger)
  .where(and(eq(leaveLedger.tenantId,ctx.tenantId),inArray(leaveLedger.employmentId,part),inArray(leaveLedger.leaveTypeId,types.map(type=>type.id)),lte(leaveLedger.effectiveOn,asOf)))
  .groupBy(leaveLedger.employmentId))out.set(row.employmentId,Math.round(Number(row.days)*100));
 return out;
}

/** Workforce metrics for the caller's administered companies, or their own team, read as the caller under RLS. */
export async function workforceMetrics(ctx:SessionContext,options:WorkforceMetricsOptions):Promise<WorkforceMetricsResult|WorkforceMetricsRefused>{
 const today=todayInKualaLumpur(),parsed=parse(options,today);
 if(!parsed.ok)return parsed;
 if(!ctx.userId||!hasTeamAccess(ctx))return refused('not_permitted',NOT_PERMITTED);
 const {metric,breakdown}=parsed;
 return withTenant(ctx,async tx=>{
  const entitled={...ctx,entitlements:await resolveEntitlementsTx(tx,ctx.tenantId),entitlementsExempt:undefined,entitlementsError:undefined};
  let scope:WorkforceScope,companies:readonly {companyId:string;company:string}[]=[],subject:{companyIds:readonly string[]}|{employmentIds:readonly string[]};
  if(isAdmin(ctx)){
   // The database decides the administered scope, for a current principal.
   const scoped=await tx.select({companyId:company.id,company:company.legalName}).from(company)
    .where(and(eq(company.tenantId,ctx.tenantId),isNull(company.archivedAt),sql`app.principal_snapshot_current() IS TRUE`,sql`app.is_admin_for(${company.id}) IS TRUE`))
    .orderBy(asc(company.legalName),asc(company.id));
   companies=scoped.filter(row=>isModuleEnabled(entitled,'employees',row.companyId)&&isModuleEnabled(entitled,MODULE_OF[metric],row.companyId));
   // The caller's own companies with attendance off: say so, rather than that they administer nothing.
   if(!companies.length)return refused('not_permitted',scoped.length&&metric==='overtime_trend'?ATTENDANCE_OFF:NOT_PERMITTED);
   scope='administered_companies';subject={companyIds:companies.map(row=>row.companyId)};
  }else{
   // A manager: the My Team page's own scope, every report it shows, as of today.
   if(metric==='turnover')return refused('not_permitted',TEAM_TURNOVER);
   if(parsed.window||parsed.asOfGiven&&parsed.asOf!==today)return refused('invalid_input',TEAM_TODAY);
   if(metric==='overtime_trend'&&!isModuleEnabled(entitled,'attendance'))return refused('not_permitted',TEAM_ATTENDANCE);
   let members:Awaited<ReturnType<typeof resolveMyTeamScopeTx>>;
   try{members=await resolveMyTeamScopeTx(tx,entitled,{view:'month',scope:'all'});}
   catch(error){if(error instanceof MyTeamAuthorizationError||error instanceof ModuleNotEnabledError)return refused('not_permitted',NOT_PERMITTED);throw error;}
   scope='team';subject={employmentIds:members.employees.map(row=>row.employmentId)};
  }
  const team=scope==='team';
  const months=metric==='overtime_trend'?overtimeTrendMonths(today).map(label=>({label,...monthRange(label)})):[];
  const window=months.length?{from:months[0].from,to:months[months.length-1].to}:parsed.window??{from:parsed.asOf!,to:parsed.asOf!};
  const employments=await employmentsTx(tx,ctx,subject,window);
  const assignments=await assignmentsTx(tx,employments.map(row=>row.id));
  const names=await departmentNamesTx(tx,[...new Set([...assignments.values()].flat().flatMap(row=>row.departmentId?[row.departmentId]:[]))]);
  // A department the caller cannot read (no name under RLS) counts as no single department.
  const readable=new Map([...assignments].map(([id,rows])=>[id,rows.map(row=>({...row,departmentId:row.departmentId&&names.has(row.departmentId)?row.departmentId:null}))]));
  const base={metric,breakdown,scope,companies,departmentNames:names};
  let cells:Pick<WorkforceMetricsResult,'overall'|'companies'|'departments'>;
  if(metric==='overtime_trend'){
   const recorded=await overtimeTx(tx,ctx,employments.map(row=>row.id),window.from,window.to);
   cells=workforceCells({...base,withPeriod:false,months:months.map(entry=>({month:entry.label,units:workforceUnits(employments,readable,entry,false).map(({unit,employmentIds})=>{
    const summary=summarizeOvertimeRecords(employmentIds.flatMap(id=>recorded.get(id+'|'+entry.label)??[]));
    return{...unit,minutes:{numerator:summary.knownMinutes.numerator,denominator:summary.knownMinutes.denominator},complete:summary.complete};})}))});
  }else if(metric==='leave_liability'){
   const units=workforceUnits(employments,readable,window,true);
   const balances=await leaveTx(tx,ctx,employments.map(row=>row.id),parsed.asOf!,team);
   if(!balances)return refused('not_permitted',TEAM_LEAVE);
   cells=workforceCells({...base,withPeriod:false,units:units.map(({unit,employmentIds})=>({...unit,hundredths:employmentIds.reduce((sum,id)=>sum+(balances.get(id)??0),0)}))});
  }else{
   const withPeriod=parsed.window!==null;
   cells=workforceCells({...base,withPeriod,units:workforceUnits(employments,readable,window,!withPeriod).map(row=>row.unit)});
  }
  const result:WorkforceMetricsResult={ok:true,metric,metricLabel:WORKFORCE_METRIC_LABELS[metric],scope,breakdown,
   ...(parsed.asOf?{asOf:parsed.asOf}:{}),...(parsed.window?{period:parsed.window}:{}),minimumGroup:WORKFORCE_MINIMUM_GROUP,...cells};
  return freeze(result);
 });
}
