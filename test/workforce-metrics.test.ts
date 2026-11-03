/** AI v2 W7 — governed workforce metrics computed by the workforce service (core/workforce-metrics.ts) and read by the
 * harness as `workforce_metrics`.
 *
 * Pure part: periods, months, rounding, units from effective-dated employment and assignment rows, and every
 * suppression rule, against expectations computed by hand. Database part: the real read as the caller under RLS on
 * fictional fixtures (test/review/review-actors.ts plus a fictional metrics company): headcount with effective-dated
 * departments, joiners, leavers and turnover; overtime hours per month from attendance; annual leave days from the
 * ledger; groups of four withheld and five published; HR administrators for their companies and managers for their
 * own team only; company and tenant isolation; and, through the harness with a scripted model, no person, id or exact
 * figure in the model input or the trace. */
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import * as schema from '../db/schema';
import type {SessionContext} from '../db/client';
import {hireEmployee,setReportingLine,terminateEmployment,transferEmployee} from '../core/org';
import {todayInKualaLumpur} from '../lib/hr-date';
import {OVERTIME_TREND_MONTHS,WORKFORCE_BREAKDOWNS,WORKFORCE_METRICS,WORKFORCE_METRIC_LABELS,WORKFORCE_MINIMUM_GROUP,WORKFORCE_PERIODS,WORKFORCE_REASONS,
 overtimeHoursText,overtimeTrendMonths,workforceCells,workforceMetrics,workforcePeriodRange,workforceUnits,
 type WorkforceAssignmentRow,type WorkforceEmploymentRow,type WorkforceMetricsResult,type WorkforceUnit} from '../core/workforce-metrics';
import {WORKFORCE_METRIC_NAMES,WORKFORCE_METRIC_PERIODS,WORKFORCE_METRIC_REASONS,PAY_AGGREGATE_BREAKDOWNS} from '../core/semantic-model/entities-metrics';
import {TERAS_CAPABILITIES,terasCapabilitiesFor} from '../core/explainers/capabilities';
import {HARNESS_TEST_ONLY,runTurn} from '../core/harness/runner';
import {InMemoryTaskMemoryStore} from '../core/harness/memory';
import type {ModelRequest} from '../core/harness/model-client';
import {scriptedModel,type ScriptStep} from './harness-ratchet/scripted-model';
import {buildMatrix,type Actor,type Matrix} from './review/review-actors';
import {adminCtx,closeAll,entitledCtx,migrateTestDb,owner,resetDb,setModule,type Base} from './harness';

const C1='00000000-0000-4000-8000-0000000000c1',C2='00000000-0000-4000-8000-0000000000c2';
const NAMES=new Map([['d-a','Fictional Assembly'],['d-b','Fictional Bindery'],['d-c','Fictional Coating']]);
const ONE=[{companyId:C1,company:'Fictional One'}],TWO=[...ONE,{companyId:C2,company:'Fictional Two'}];
const unit=(companyId:string,departmentKey:string|null,extra:Partial<WorkforceUnit>={}):WorkforceUnit=>
 ({companyId,personId:randomUUID(),departmentKey,activeStart:true,activeEnd:true,joined:false,left:false,...extra});
const many=(count:number,companyId:string,departmentKey:string|null,extra:Partial<WorkforceUnit>={})=>Array.from({length:count},()=>unit(companyId,departmentKey,extra));
const minutes=(value:number)=>({minutes:{numerator:String(value),denominator:'1'},complete:true});
type Cells=ReturnType<typeof workforceCells>;
const rows=(list:readonly Record<string,unknown>[]|undefined)=>(list??[]).map(row=>[row.department??row.company,row.status,row.withheldBecause??null]);
const departmentsOf=(cells:Cells,index=0)=>rows(cells.companies[index]?.departments as Record<string,unknown>[]|undefined);
const headcount=(units:readonly WorkforceUnit[],companies=ONE,breakdown:'company'|'department'='department')=>
 workforceCells({metric:'headcount',scope:'administered_companies',breakdown,withPeriod:false,companies,departmentNames:NAMES,units});

describe('workforce metrics: dates and rounding (pure)',()=>{
 it('resolves named periods and the six overtime months from today, across year ends',()=>{
  expect(workforcePeriodRange('last_quarter','2026-11-03')).toEqual({from:'2026-07-01',to:'2026-09-30'});
  expect(workforcePeriodRange('last_quarter','2026-02-10')).toEqual({from:'2025-10-01',to:'2025-12-31'});
  expect(workforcePeriodRange('this_quarter','2026-11-03')).toEqual({from:'2026-10-01',to:'2026-11-03'});
  expect(workforcePeriodRange('last_month','2026-01-15')).toEqual({from:'2025-12-01',to:'2025-12-31'});
  expect(workforcePeriodRange('last_month','2024-03-05')).toEqual({from:'2024-02-01',to:'2024-02-29'});
  expect(workforcePeriodRange('this_month','2026-11-03')).toEqual({from:'2026-11-01',to:'2026-11-03'});
  expect(workforcePeriodRange('this_year','2026-11-03')).toEqual({from:'2026-01-01',to:'2026-11-03'});
  expect(workforcePeriodRange('last_year','2026-11-03')).toEqual({from:'2025-01-01',to:'2025-12-31'});
  expect(overtimeTrendMonths('2026-11-03')).toEqual(['2026-05','2026-06','2026-07','2026-08','2026-09','2026-10']);
  expect(overtimeTrendMonths('2026-03-31')).toEqual(['2025-09','2025-10','2025-11','2025-12','2026-01','2026-02']);
  expect(OVERTIME_TREND_MONTHS).toBe(6);expect(WORKFORCE_MINIMUM_GROUP).toBe(5);
 });
 it('sums overtime minutes exactly and shows hours half up to one decimal place',()=>{
  // 345 minutes = 5.75 hours -> 5.8; 3 minutes = 0.05 hours -> 0.1; a third of a minute and two thirds make one.
  expect(overtimeHoursText([60,90,30,0,45,120].map(value=>({numerator:String(value),denominator:'1'})))).toBe('5.8');
  expect(overtimeHoursText([{numerator:'3',denominator:'1'}])).toBe('0.1');
  expect(overtimeHoursText([{numerator:'2',denominator:'1'}])).toBe('0.0');
  expect(overtimeHoursText([{numerator:'1',denominator:'3'},{numerator:'2',denominator:'3'},{numerator:'59',denominator:'1'}])).toBe('1.0');
  expect(overtimeHoursText([])).toBe('0.0');
 });
 it('declares the same vocabulary in the semantic model as the service uses',()=>{
  expect([...WORKFORCE_METRIC_NAMES]).toEqual([...WORKFORCE_METRICS]);expect([...WORKFORCE_METRIC_PERIODS]).toEqual([...WORKFORCE_PERIODS]);
  expect([...WORKFORCE_METRIC_REASONS]).toEqual([...WORKFORCE_REASONS]);expect([...PAY_AGGREGATE_BREAKDOWNS]).toEqual([...WORKFORCE_BREAKDOWNS]);
  for(const metric of WORKFORCE_METRICS)expect(WORKFORCE_METRIC_LABELS[metric].length).toBeGreaterThan(80);
  expect(WORKFORCE_METRIC_LABELS.overtime_trend).toMatch(/not pay/);expect(WORKFORCE_METRIC_LABELS.leave_liability).toMatch(/not money/);
 });
});

describe('workforce metrics: units from effective-dated rows (pure)',()=>{
 const P=['p1','p2','p3','p4','p5','p6'];
 const emp=(id:string,personId:string,hiredOn:string,terminatedOn:string|null=null,companyId=C1):WorkforceEmploymentRow=>({id,personId,companyId,hiredOn,terminatedOn});
 const at=(employmentId:string,departmentId:string|null,validFrom:string,validTo:string|null=null):WorkforceAssignmentRow=>({employmentId,departmentId,validFrom,validTo});
 const employments=[emp('e1',P[0],'2020-01-01','2025-03-31'),emp('e2a',P[1],'2020-01-01','2025-04-01'),emp('e2b',P[1],'2025-04-01'),
  emp('e3',P[2],'2025-02-01'),emp('e4',P[3],'2020-01-01'),emp('e5',P[4],'2020-01-01'),emp('e5b',P[4],'2021-01-01',null,C2),emp('e6',P[5],'2025-07-01')];
 const assignments=new Map<string,WorkforceAssignmentRow[]>([['e1',[at('e1','d-a','2020-01-01','2025-03-31')]],['e2a',[at('e2a','d-a','2020-01-01','2025-04-01')]],['e2b',[at('e2b','d-b','2025-04-01')]],
  ['e3',[at('e3','d-b','2025-02-01')]],['e4',[at('e4','d-a','2020-01-01','2025-04-01'),at('e4','d-c','2025-04-01')]],['e5',[at('e5','d-a','2020-01-01'),at('e5','d-b','2024-01-01')]],
  ['e5b',[at('e5b','d-c','2021-01-01')]],['e6',[at('e6','d-a','2025-07-01')]]]);
 const of=(list:ReturnType<typeof workforceUnits>,personId:string,companyId=C1)=>list.find(row=>row.unit.personId===personId&&row.unit.companyId===companyId);
 it('counts a leaver, a joiner, a move between employments and a transfer as the dated rows say',()=>{
  const period=workforceUnits(employments,assignments,{from:'2025-01-01',to:'2025-06-30'},false);
  // Six units: p6 joins after the period; p5 is two units, one per company.
  expect(period.map(row=>row.unit.personId+'@'+row.unit.companyId).sort()).toEqual([...P.slice(0,5).map(id=>id+'@'+C1),P[4]+'@'+C2].sort());
  // Terminated inside the period: a leaver, counted in the department of the assignment closing on that date.
  expect(of(period,P[0])!.unit).toMatchObject({departmentKey:'d-a',activeStart:true,activeEnd:false,joined:false,left:true});
  // One employment ends the day the next starts: neither a leaver nor a joiner, in the newer employment's department.
  expect(of(period,P[1])).toMatchObject({unit:{departmentKey:'d-b',activeStart:true,activeEnd:true,joined:false,left:false},employmentIds:['e2a','e2b']});
  expect(of(period,P[2])!.unit).toMatchObject({departmentKey:'d-b',activeStart:false,activeEnd:true,joined:true,left:false});
  // Transferred on 1 April: in Coating at the end of the period, in Assembly on 1 March.
  expect(of(period,P[3])!.unit.departmentKey).toBe('d-c');
  expect(of(workforceUnits(employments,assignments,{from:'2025-03-01',to:'2025-03-01'},true),P[3])!.unit.departmentKey).toBe('d-a');
  // Two current assignments that disagree: no single department.
  expect(of(period,P[4])!.unit.departmentKey).toBeNull();expect(of(period,P[4],C2)!.unit.departmentKey).toBe('d-c');
 });
 it('keeps only people active on the date for a point in time',()=>{
  const point=workforceUnits(employments,assignments,{from:'2025-03-31',to:'2025-03-31'},true);
  // p1's employment ends on 31 March, so p1 is not employed that day; p6 is not hired yet.
  expect(point.map(row=>row.unit.personId+'@'+row.unit.companyId).sort()).toEqual([P[1],P[2],P[3],P[4]].map(id=>id+'@'+C1).concat(P[4]+'@'+C2).sort());
  expect(of(point,P[1])!.employmentIds).toEqual(['e2a']);
 });
});

describe('workforce metrics: suppression (pure)',()=>{
 it('publishes groups of five and withholds a group of four, with the group it would reveal',()=>{
  const five=headcount([...many(6,C1,'d-a'),...many(5,C1,'d-b'),...many(5,C1,'d-c')]);
  expect(departmentsOf(five)).toEqual([['Fictional Assembly','published',null],['Fictional Bindery','published',null],['Fictional Coating','published',null]]);
  expect(five.companies[0].departments).toEqual([{department:'Fictional Assembly',status:'published',headcount:6},{department:'Fictional Bindery',status:'published',headcount:5},
   {department:'Fictional Coating',status:'published',headcount:5}]);
  const four=headcount([...many(6,C1,'d-a'),...many(5,C1,'d-b'),...many(4,C1,'d-c')]);
  expect(departmentsOf(four)).toEqual([['Fictional Assembly','published',null],['Fictional Bindery','suppressed','protects_another_group'],['Fictional Coating','suppressed','fewer_than_minimum']]);
  expect(four.overall).toEqual({status:'published',headcount:15});expect(four.companies[0]).toMatchObject({status:'published',headcount:15});
  for(const hidden of (four.companies[0].departments as Record<string,unknown>[]).filter(row=>row.status==='suppressed'))expect(Object.keys(hidden).sort()).toEqual(['department','status','withheldBecause']);
 });
 it('withholds a group whose complement is one to four people, companies within all companies, and the departments of a withheld company',()=>{
  expect(departmentsOf(headcount([...many(10,C1,'d-a'),...many(2,C1,'d-b')]))).toEqual([['Fictional Assembly','suppressed','complement_too_small'],['Fictional Bindery','suppressed','fewer_than_minimum']]);
  const result=headcount([...many(8,C1,'d-a'),...many(6,C1,'d-b'),...many(3,C2,'d-c')],TWO);
  expect(rows(result.companies as unknown as Record<string,unknown>[])).toEqual([['Fictional One','suppressed','complement_too_small'],['Fictional Two','suppressed','fewer_than_minimum']]);
  expect(result.overall).toEqual({status:'published',headcount:17});
  expect(departmentsOf(result)).toEqual([['Fictional Assembly','suppressed','company_suppressed'],['Fictional Bindery','suppressed','company_suppressed']]);
  // A total of four publishes nothing.
  expect(headcount(many(4,C1,'d-a'),ONE,'company').overall).toEqual({status:'suppressed',withheldBecause:'fewer_than_minimum'});
 });
 it('lists a company with nobody as no_people, which protects nothing',()=>{
  const result=headcount(many(10,C1,'d-a'),TWO,'company');
  expect(result.companies).toEqual([{companyId:C1,company:'Fictional One',status:'published',headcount:10},{companyId:C2,company:'Fictional Two',status:'no_people'}]);
 });
 it('withholds leave days that are all equal, and publishes them when one person differs',()=>{
  const leave=(values:readonly number[])=>workforceCells({metric:'leave_liability',scope:'administered_companies',breakdown:'company',withPeriod:false,companies:ONE,departmentNames:NAMES,
   units:values.map(hundredths=>unit(C1,'d-a',{hundredths}))});
  const same=leave([1000,1000,1000,1000,1000]);
  expect(same.overall).toEqual({status:'suppressed',withheldBecause:'values_identical'});expect(JSON.stringify(same)).not.toContain('10.00');
  // 52.50 days over five people: 10.50 each on average.
  expect(leave([1000,1000,1000,1000,1250]).overall).toEqual({status:'published',people:5,totalDays:'52.50',averageDays:'10.50'});
  // A negative balance counts as it stands: -3.00 + 4 x 2.00 = 5.00, average 1.00.
  expect(leave([-300,200,200,200,200]).overall).toEqual({status:'published',people:5,totalDays:'5.00',averageDays:'1.00'});
 });
 it('withholds an overtime month where everyone recorded the same (zero included), and lists every department across months',()=>{
  const result=workforceCells({metric:'overtime_trend',scope:'administered_companies',breakdown:'department',withPeriod:false,companies:ONE,departmentNames:NAMES,months:[
   {month:'2026-05',units:[...many(6,C1,'d-a',minutes(0)),...many(5,C1,'d-b',minutes(0))]},
   {month:'2026-06',units:[...[60,90,30,0,45,120].map(value=>unit(C1,'d-a',minutes(value))),...many(5,C1,'d-b',minutes(0)),...[10,20,30,40,50].map(value=>unit(C1,'d-c',minutes(value)))]},
  ]});
  expect(result.overall).toEqual({months:[{month:'2026-05',status:'suppressed',withheldBecause:'values_identical'},{month:'2026-06',status:'published',hours:'8.3',complete:true}]});
  const departments=result.companies[0].departments as {department:string;months:Record<string,unknown>[]}[];
  expect(departments.map(row=>[row.department,row.months.map(month=>month.status==='published'?month.hours:month.withheldBecause??month.status)])).toEqual([
   ['Fictional Assembly',['company_suppressed','5.8']],['Fictional Bindery',['company_suppressed','values_identical']],['Fictional Coating',['no_people','protects_another_group']]]);
  // One day not yet calculated marks the month not complete; it still counts as none.
  const open=workforceCells({metric:'overtime_trend',scope:'administered_companies',breakdown:'company',withPeriod:false,companies:ONE,departmentNames:NAMES,months:[
   {month:'2026-06',units:[unit(C1,'d-a',{...minutes(30),complete:false}),...[10,20,30,40].map(value=>unit(C1,'d-a',minutes(value)))]}]});
  expect(open.overall).toEqual({months:[{month:'2026-06',status:'published',hours:'2.2',complete:false}]});
 });
 it('computes turnover against hand-worked figures',()=>{
  // Start 10, end 8, 2 leavers: average 9.0, 2 / 9 = 22.2%.
  const units=[...many(8,C1,'d-a'),...many(2,C1,'d-a',{activeEnd:false,left:true})];
  expect(workforceCells({metric:'turnover',scope:'administered_companies',breakdown:'company',withPeriod:true,companies:ONE,departmentNames:NAMES,units}).overall)
   .toEqual({status:'published',leavers:2,headcountStart:10,headcountEnd:8,averageHeadcount:'9.0',turnoverRate:'22.2'});
  // Start 14, end 13, 2 leavers: average 13.5, 2 / 13.5 = 14.8%; nobody on either day has no rate.
  const odd=[...many(12,C1,'d-a'),...many(2,C1,'d-a',{activeEnd:false,left:true}),unit(C1,'d-a',{activeStart:false,joined:true})];
  expect(workforceCells({metric:'turnover',scope:'administered_companies',breakdown:'company',withPeriod:true,companies:ONE,departmentNames:NAMES,units:odd}).overall)
   .toMatchObject({averageHeadcount:'13.5',turnoverRate:'14.8'});
  const none=many(5,C1,'d-a',{activeStart:false,activeEnd:false,joined:true,left:true});
  expect(workforceCells({metric:'turnover',scope:'administered_companies',breakdown:'company',withPeriod:true,companies:ONE,departmentNames:NAMES,units:none}).overall)
   .toEqual({status:'published',leavers:5,headcountStart:0,headcountEnd:0,averageHeadcount:'0.0',turnoverRate:null});
 });
 it('treats a team as the parent of its departments',()=>{
  const team=(units:readonly WorkforceUnit[])=>workforceCells({metric:'headcount',scope:'team',breakdown:'department',withPeriod:false,companies:[],departmentNames:NAMES,units});
  const small=team(many(4,C1,'d-a'));
  expect(small).toEqual({overall:{status:'suppressed',withheldBecause:'fewer_than_minimum'},companies:[],departments:[{department:'Fictional Assembly',status:'suppressed',withheldBecause:'team_suppressed'}]});
  const split=team([...many(5,C1,'d-a'),unit(C2,'d-b')]);
  expect(split.overall).toEqual({status:'published',headcount:6});
  expect(rows(split.departments as Record<string,unknown>[])).toEqual([['Fictional Assembly','suppressed','complement_too_small'],['Fictional Bindery','suppressed','fewer_than_minimum']]);
 });
 it('returns no person and no individual figure',()=>{
  const units=[...[60,90,30,0,45,120].map(value=>unit(C1,'d-a',minutes(value)))];
  const result=workforceCells({metric:'overtime_trend',scope:'administered_companies',breakdown:'department',withPeriod:false,companies:ONE,departmentNames:NAMES,months:[{month:'2026-06',units}]});
  const text=JSON.stringify(result);
  for(const row of units)expect(text).not.toContain(row.personId);
  for(const hours of ['1.0','1.5','0.5','0.8','2.0'])expect(text).not.toContain('"'+hours+'"');
 });
});

// ─── Database: the real read, as the caller ───────────────────────────────────────────────────────────────────────
let m:Matrix;
type Hired={employmentId:string;personId:string};
type Metrics=Readonly<{companyId:string;assembly:string;bindery:string;coating:string;admin:SessionContext}>;
const METRICS_COMPANY='Fictional Metrics Sdn Bhd';
const ok=(result:Awaited<ReturnType<typeof workforceMetrics>>):WorkforceMetricsResult=>{if(!result.ok)throw Error('Refused: '+result.message);return result;};
const baseOf=(ctx:SessionContext):Base=>ctx.tenantId===m.b.tenantId?m.b:m.b2;
/** The session with the tenant's current modules (setModule after the matrix was built). */
const session=async(actor:Actor|SessionContext):Promise<SessionContext>=>{const ctx='ctx' in actor?actor.ctx:actor;return{...ctx,entitlements:(await entitledCtx(baseOf(ctx))).entitlements};};
async function hire(companyId:string,departmentId:string,label:string,hiredOn='2020-01-01'):Promise<Hired>{
 return hireEmployee(adminCtx(m.b),{person:{fullName:'Fictional Worker '+label,primaryEmail:randomUUID()+'@workforce-metrics.test'},companyId,departmentId,employmentType:'full_time',hiredOn});
}
/** Hired one after another: employee codes are allocated per company. */
async function hireAll(companyId:string,departmentId:string,prefix:string,count:number,hiredOn?:string):Promise<Hired[]>{
 const out:Hired[]=[];for(let index=0;index<count;index++)out.push(await hire(companyId,departmentId,prefix+index,hiredOn));return out;
}
async function login(personId:string,role:'hr_admin'|'manager',companyId:string|null):Promise<SessionContext>{
 const [user]=await owner.db.insert(schema.appUser).values({tenantId:m.b.tenantId,workosUserId:'user_'+randomUUID(),personId}).returning({id:schema.appUser.id});
 await owner.db.insert(schema.roleAssignment).values({tenantId:m.b.tenantId,appUserId:user.id,role,companyId});
 return{...await entitledCtx(m.b,[role]),userId:user.id,personId,roles:[role],grants:[{role,companyId}]} as SessionContext;
}
/** A fictional company with three departments and an HR administrator for it alone (their own employment is in the
 * second company, so the metrics company counts only the people each test hires). */
async function metricsCompany():Promise<Metrics>{
 const [created]=await owner.db.insert(schema.company).values({tenantId:m.b.tenantId,legalName:METRICS_COMPANY}).returning({id:schema.company.id});
 const department=async(name:string)=>(await owner.db.insert(schema.department).values({tenantId:m.b.tenantId,companyId:created.id,name}).returning({id:schema.department.id}))[0].id;
 const assembly=await department('Fictional Assembly'),bindery=await department('Fictional Bindery'),coating=await department('Fictional Coating');
 const person=await hireEmployee(adminCtx(m.b),{person:{fullName:'Fictional Metrics Administrator',primaryEmail:randomUUID()+'@workforce-metrics.test'},companyId:m.company2,departmentId:m.dept2,employmentType:'full_time',hiredOn:'2020-01-01'});
 return{companyId:created.id,assembly,bindery,coating,admin:await login(person.personId,'hr_admin',created.id)};
}
const attendanceDay=(employmentId:string,date:string,otMinutes:number|null)=>owner.db.insert(schema.attendance).values({tenantId:m.b.tenantId,employmentId,attendanceDate:date,status:'present',dayType:'workday',
 workedMinutes:otMinutes===null?null:480+otMinutes,otMinutes});
const ledger=(employmentId:string,leaveTypeId:string,days:string,effectiveOn:string,entryType:'accrual'|'debit'='accrual')=>
 owner.db.insert(schema.leaveLedger).values({tenantId:m.b.tenantId,employmentId,leaveTypeId,entryType,days,effectiveOn});
const departmentRows=(result:WorkforceMetricsResult,index=0)=>(result.companies[index].departments??[]).map(row=>{const {department,...rest}=row;return[department,rest];});

describe('workforce metrics over the native owners, as the caller',()=>{
 beforeAll(migrateTestDb);afterAll(closeAll);
 beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-workforce-metrics-passphrase');await resetDb();m=await buildMatrix();
  for(const tenant of [m.b.tenantId,m.b2.tenantId])for(const code of ['assistant','attendance'])await setModule(tenant,code,'active');});

 it('counts headcount by department and withholds a department of four until it has five',async()=>{
  const c=await metricsCompany();
  await hireAll(c.companyId,c.assembly,'A',6);await hireAll(c.companyId,c.bindery,'B',5);await hireAll(c.companyId,c.coating,'C',4);
  const four=ok(await workforceMetrics(await session(c.admin),{metric:'headcount',breakdown:'department'}));
  expect(four).toMatchObject({metric:'headcount',scope:'administered_companies',breakdown:'department',asOf:todayInKualaLumpur(),minimumGroup:5,overall:{status:'published',headcount:15}});
  expect(four.metricLabel).toBe(WORKFORCE_METRIC_LABELS.headcount);
  expect(four.companies).toEqual([{companyId:c.companyId,company:METRICS_COMPANY,status:'published',headcount:15,departments:[
   {department:'Fictional Assembly',status:'published',headcount:6},
   {department:'Fictional Bindery',status:'suppressed',withheldBecause:'protects_another_group'},
   {department:'Fictional Coating',status:'suppressed',withheldBecause:'fewer_than_minimum'}]}]);
  await hire(c.companyId,c.coating,'C4');
  const five=ok(await workforceMetrics(await session(c.admin),{metric:'headcount',breakdown:'department'}));
  expect(departmentRows(five)).toEqual([['Fictional Assembly',{status:'published',headcount:6}],['Fictional Bindery',{status:'published',headcount:5}],['Fictional Coating',{status:'published',headcount:5}]]);
  expect(five.overall).toEqual({status:'published',headcount:16});
 });

 it('reads departments, joiners, leavers and turnover from the effective-dated employment and assignment owners',async()=>{
  const c=await metricsCompany(),admin=adminCtx(m.b);
  const assembly=await hireAll(c.companyId,c.assembly,'A',8),bindery=await hireAll(c.companyId,c.bindery,'B',6);
  await transferEmployee(admin,{employmentId:assembly[7].employmentId,effectiveDate:'2025-04-01',departmentId:c.bindery});
  await hire(c.companyId,c.bindery,'J','2025-02-01');
  await terminateEmployment(admin,{employmentId:assembly[0].employmentId,terminationDate:'2025-03-31'});
  await terminateEmployment(admin,{employmentId:assembly[1].employmentId,terminationDate:'2025-05-15'});
  expect(bindery).toHaveLength(6);
  const read=async(options:Parameters<typeof workforceMetrics>[1])=>ok(await workforceMetrics(await session(c.admin),{breakdown:'department',...options}));
  // 1 March 2025: the transferred person is still in Assembly; the joiner is in Bindery; nobody has left yet.
  const march=await read({metric:'headcount',asOf:'2025-03-01'});
  expect(march.overall).toEqual({status:'published',headcount:15});
  expect(departmentRows(march)).toEqual([['Fictional Assembly',{status:'published',headcount:8}],['Fictional Bindery',{status:'published',headcount:7}]]);
  // Today: two have left Assembly and the transfer has moved one to Bindery.
  expect(departmentRows(await read({metric:'headcount'}))).toEqual([['Fictional Assembly',{status:'published',headcount:5}],['Fictional Bindery',{status:'published',headcount:8}]]);
  // January to June 2025: the leavers count in the department their last assignment was in.
  const half={from:'2025-01-01',to:'2025-06-30'};
  const period=await read({metric:'headcount',...half});
  expect(period).toMatchObject({asOf:'2025-06-30',period:half,overall:{status:'published',headcount:13,joiners:1,leavers:2}});
  expect(departmentRows(period)).toEqual([['Fictional Assembly',{status:'published',headcount:5,joiners:0,leavers:2}],['Fictional Bindery',{status:'published',headcount:8,joiners:1,leavers:0}]]);
  // Turnover: start 14, end 13, 2 leavers -> 2 / 13.5 = 14.8%. Assembly: 7 and 5, 2 / 6 = 33.3%. Bindery: 7 and 8, none.
  const turnover=await read({metric:'turnover',...half});
  expect(turnover.overall).toEqual({status:'published',leavers:2,headcountStart:14,headcountEnd:13,averageHeadcount:'13.5',turnoverRate:'14.8'});
  expect(departmentRows(turnover)).toEqual([
   ['Fictional Assembly',{status:'published',leavers:2,headcountStart:7,headcountEnd:5,averageHeadcount:'6.0',turnoverRate:'33.3'}],
   ['Fictional Bindery',{status:'published',leavers:0,headcountStart:7,headcountEnd:8,averageHeadcount:'7.5',turnoverRate:'0.0'}]]);
  // A named period is resolved by the service from today.
  expect((await read({metric:'turnover',period:'last_quarter'})).period).toEqual(workforcePeriodRange('last_quarter',todayInKualaLumpur()));
 });

 it('sums overtime hours per month from attendance and withholds months where everyone recorded the same',async()=>{
  const c=await metricsCompany(),months=overtimeTrendMonths(todayInKualaLumpur()),last=months[5];
  const assembly=await hireAll(c.companyId,c.assembly,'A',6),bindery=await hireAll(c.companyId,c.bindery,'B',5),coating=await hireAll(c.companyId,c.coating,'C',5);
  for(const [index,value] of [60,90,30,0,45,120].entries())await attendanceDay(assembly[index].employmentId,last+'-10',value);
  // A day with no overtime calculated yet (no clock-out): it counts as none and marks the month not complete.
  await attendanceDay(assembly[0].employmentId,last+'-11',null);
  for(const person of bindery)await attendanceDay(person.employmentId,last+'-10',0);
  for(const [index,value] of [10,20,30,40,50].entries())await attendanceDay(coating[index].employmentId,last+'-10',value);
  // Outside the six months: never read.
  await attendanceDay(assembly[1].employmentId,todayInKualaLumpur().slice(0,7)+'-01',600);
  const result=ok(await workforceMetrics(await session(c.admin),{metric:'overtime_trend',breakdown:'department'}));
  expect(result).not.toHaveProperty('asOf');expect(result).not.toHaveProperty('period');
  const earlier=months.slice(0,5).map(month=>({month,status:'suppressed',withheldBecause:'values_identical'}));
  // 345 + 0 + 150 minutes = 8.25 hours -> 8.3.
  expect(result.overall).toEqual({months:[...earlier,{month:last,status:'published',hours:'8.3',complete:false}]});
  expect(result.companies[0]).toMatchObject({company:METRICS_COMPANY,months:[...earlier,{month:last,status:'published',hours:'8.3',complete:false}]});
  const departments=result.companies[0].departments as unknown as {department:string;months:Record<string,unknown>[]}[];
  expect(departments.map(row=>[row.department,row.months[5]])).toEqual([
   ['Fictional Assembly',{month:last,status:'published',hours:'5.8',complete:false}],
   ['Fictional Bindery',{month:last,status:'suppressed',withheldBecause:'values_identical'}],
   ['Fictional Coating',{month:last,status:'suppressed',withheldBecause:'protects_another_group'}]]);
  for(const row of departments)expect(row.months.slice(0,5).map(month=>month.withheldBecause)).toEqual(Array(5).fill('company_suppressed'));
  expect(await workforceMetrics(await session(c.admin),{metric:'overtime_trend',period:'last_month'})).toMatchObject({ok:false,refusal:'invalid_input'});
 });

 it('sums annual leave days from the ledger on a date, leaving out other leave types and later entries',async()=>{
  const c=await metricsCompany();
  const [medical]=await owner.db.insert(schema.leaveType).values({tenantId:m.b.tenantId,code:'MEDICAL',name:'Medical Leave',paid:true}).returning({id:schema.leaveType.id});
  const assembly=await hireAll(c.companyId,c.assembly,'A',6),bindery=await hireAll(c.companyId,c.bindery,'B',5),coating=await hireAll(c.companyId,c.coating,'C',5);
  const annual=m.b.annualLeaveTypeId;
  for(const [index,days] of ['14.00','12.50','10.00','8.25','14.00','3.00'].entries())await ledger(assembly[index].employmentId,annual,days,'2025-01-01');
  await ledger(assembly[0].employmentId,annual,'-2.00','2025-06-01','debit');
  await ledger(assembly[1].employmentId,annual,'5.00','2026-01-05');
  await ledger(assembly[2].employmentId,medical.id,'9.00','2025-01-01');
  for(const person of bindery)await ledger(person.employmentId,annual,'10.00','2025-01-01');
  for(const [index,days] of ['1.00','2.00','3.00','4.00','5.50'].entries())await ledger(coating[index].employmentId,annual,days,'2025-01-01');
  const result=ok(await workforceMetrics(await session(c.admin),{metric:'leave_liability',breakdown:'department',asOf:'2025-12-31'}));
  // Assembly: 12.00 + 12.50 + 10.00 + 8.25 + 14.00 + 3.00 = 59.75 over 6 = 9.96. All: 59.75 + 50.00 + 15.50 = 125.25 over 16 = 7.83.
  expect(result).toMatchObject({asOf:'2025-12-31',overall:{status:'published',people:16,totalDays:'125.25',averageDays:'7.83'}});
  expect(departmentRows(result)).toEqual([['Fictional Assembly',{status:'published',people:6,totalDays:'59.75',averageDays:'9.96'}],
   ['Fictional Bindery',{status:'suppressed',withheldBecause:'values_identical'}],['Fictional Coating',{status:'suppressed',withheldBecause:'protects_another_group'}]]);
  // Today the 5.00 days granted in January 2026 count too.
  expect(ok(await workforceMetrics(await session(c.admin),{metric:'leave_liability'})).overall).toEqual({status:'published',people:16,totalDays:'130.25',averageDays:'8.14'});
 });

 it('refuses everyone without HR administration or a team, a forged session, and malformed requests',async()=>{
  const c=await metricsCompany();await hireAll(c.companyId,c.assembly,'A',6);
  for(const actor of [m.employee,m.colleague,m.delegate,m.payroll])
   expect(await workforceMetrics(await session(actor),{metric:'headcount'}),actor.name).toMatchObject({ok:false,refusal:'not_permitted'});
  const forged={...await session(m.employee),roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]} as SessionContext;
  expect(await workforceMetrics(forged,{metric:'headcount'})).toEqual(await workforceMetrics(await session(m.employee),{metric:'headcount'}));
  const capability=TERAS_CAPABILITIES.find(row=>row.name==='workforce_metrics')!;
  expect(capability).toMatchObject({module:null,admin:false,access:'team',worker:null});
  expect((await terasCapabilitiesFor(await session(m.employee))).map(row=>row.name)).not.toContain('workforce_metrics');
  expect((await terasCapabilitiesFor(await session(m.payroll))).map(row=>row.name)).not.toContain('workforce_metrics');
  expect((await terasCapabilitiesFor(await session(m.manager))).map(row=>row.name)).toContain('workforce_metrics');
  expect((await terasCapabilitiesFor(await session(c.admin))).map(row=>row.name)).toContain('workforce_metrics');
  expect(await capability.run(await session(m.employee),{metric:'headcount'},{companyId:m.b.companyId})).toMatchObject({ok:false,refusal:'not_permitted'});
  const admin=await session(c.admin);
  for(const options of [{metric:'salary'},{metric:'headcount',breakdown:'person'},{metric:'turnover'},{metric:'turnover',period:'last_decade'},
   {metric:'turnover',period:'last_month',from:'2025-01-01',to:'2025-02-01'},{metric:'turnover',from:'2025-03-01',to:'2025-02-01'},{metric:'headcount',asOf:'2099-01-01'},
   {metric:'headcount',asOf:'2025-02-30'},{metric:'leave_liability',period:'last_month'},{metric:'headcount',asOf:'2025-01-01',period:'last_month'}])
   expect(await workforceMetrics(admin,options),JSON.stringify(options)).toMatchObject({ok:false,refusal:'invalid_input'});
 });

 it('gives a manager their own team only, as the team page shows it, withholding a team of four',async()=>{
  const c=await metricsCompany(),admin=adminCtx(m.b),months=overtimeTrendMonths(todayInKualaLumpur()),last=months[5];
  const lead=await hire(c.companyId,c.coating,'Lead');
  const reports=await hireAll(c.companyId,c.assembly,'R',5),outsider=await hire(c.companyId,c.assembly,'N');
  for(const report of reports.slice(0,4))await setReportingLine(admin,{subordinateEmploymentId:report.employmentId,managerEmploymentId:lead.employmentId,lineType:'administrative',validFrom:'2020-01-01'});
  const manager=await login(lead.personId,'manager',null);
  const read=async(options:Parameters<typeof workforceMetrics>[1])=>workforceMetrics(await session(manager),options);
  expect(await read({metric:'headcount',breakdown:'department'})).toMatchObject({ok:true,scope:'team',companies:[],overall:{status:'suppressed',withheldBecause:'fewer_than_minimum'},
   departments:[{department:'Fictional Assembly',status:'suppressed',withheldBecause:'team_suppressed'}]});
  await setReportingLine(admin,{subordinateEmploymentId:reports[4].employmentId,managerEmploymentId:lead.employmentId,lineType:'administrative',validFrom:'2020-01-01'});
  const team=ok(await read({metric:'headcount',breakdown:'department'}));
  expect(team).toMatchObject({scope:'team',asOf:todayInKualaLumpur(),companies:[],overall:{status:'published',headcount:5},departments:[{department:'Fictional Assembly',status:'published',headcount:5}]});
  // Overtime: 30 + 60 + 90 + 120 + 150 minutes = 7.5 hours; the person outside the team is never counted.
  for(const [index,value] of [30,60,90,120,150].entries())await attendanceDay(reports[index].employmentId,last+'-10',value);
  await attendanceDay(outsider.employmentId,last+'-10',600);
  const overtime=ok(await read({metric:'overtime_trend'}));
  expect(overtime.overall).toEqual({months:[...months.slice(0,5).map(month=>({month,status:'suppressed',withheldBecause:'values_identical'})),{month:last,status:'published',hours:'7.5',complete:true}]});
  // Leave days: 1 + 2 + 3 + 4 + 5 = 15.00, 3.00 each; the outsider's 50 days are not the team's.
  for(const [index,days] of ['1.00','2.00','3.00','4.00','5.00'].entries())await ledger(reports[index].employmentId,m.b.annualLeaveTypeId,days,'2025-01-01');
  await ledger(outsider.employmentId,m.b.annualLeaveTypeId,'50.00','2025-01-01');
  expect(ok(await read({metric:'leave_liability'})).overall).toEqual({status:'published',people:5,totalDays:'15.00',averageDays:'3.00'});
  // No turnover, no period and no past date for a team.
  expect(await read({metric:'turnover',period:'last_quarter'})).toMatchObject({ok:false,refusal:'not_permitted'});
  expect(await read({metric:'headcount',period:'last_month'})).toMatchObject({ok:false,refusal:'invalid_input'});
  expect(await read({metric:'headcount',asOf:'2025-01-01'})).toMatchObject({ok:false,refusal:'invalid_input'});
  expect(await read({metric:'headcount',asOf:todayInKualaLumpur()})).toMatchObject({ok:true,overall:{headcount:5}});
  // Where My Team does not show annual leave Available, the team's leave days are not shown either.
  await owner.db.update(schema.leaveType).set({essViewConfig:{available:false}}).where(eq(schema.leaveType.id,m.b.annualLeaveTypeId));
  expect(await read({metric:'leave_liability'})).toMatchObject({ok:false,refusal:'not_permitted'});
  expect(ok(await workforceMetrics(await session(c.admin),{metric:'leave_liability'})).overall).toMatchObject({status:'published'});
  // Without attendance there is no overtime for the team.
  await setModule(m.b.tenantId,'attendance','disabled');
  expect(await read({metric:'overtime_trend'})).toMatchObject({ok:false,refusal:'not_permitted'});
 });

 it('keeps each administrator to the companies they administer, and each tenant to its own',async()=>{
  const c=await metricsCompany();const staff=await hireAll(c.companyId,c.assembly,'A',6);
  const names=async(ctx:SessionContext,metric='headcount')=>ok(await workforceMetrics(await session(ctx),{metric})).companies.map(row=>[row.company,row.status,row.headcount??row.withheldBecause??null]);
  // The matrix: eight people in Acme, the second company's administrator and the metrics administrator in the second.
  expect(await names(m.companyAdmin.ctx)).toEqual([['Acme Sdn Bhd','published',8]]);
  expect(await names(m.otherCompanyAdmin.ctx)).toEqual([['Fictional Second Company Sdn Bhd','suppressed','fewer_than_minimum']]);
  expect(await names(c.admin)).toEqual([[METRICS_COMPANY,'published',6]]);
  // All three for the group administrator: 16 in all; the second company is withheld, and the smallest other with it.
  const group=ok(await workforceMetrics(await session(m.groupAdmin),{metric:'headcount'}));
  expect(group.overall).toEqual({status:'published',headcount:16});
  expect(group.companies.map(row=>[row.company,row.status,row.headcount??row.withheldBecause])).toEqual([['Acme Sdn Bhd','published',8],
   [METRICS_COMPANY,'suppressed','protects_another_group'],['Fictional Second Company Sdn Bhd','suppressed','fewer_than_minimum']]);
  const other=ok(await workforceMetrics(await session(m.otherTenant),{metric:'headcount'}));
  expect(other.companies.map(row=>[row.companyId,row.status])).toEqual([[m.b2.companyId,'suppressed']]);
  for(const text of [m.b.companyId,m.company2,c.companyId,METRICS_COMPANY,'Second Company',...staff.map(row=>row.employmentId)])expect(JSON.stringify(other)).not.toContain(text);
  // Attendance on for the metrics company alone: the group administrator's overtime covers it alone.
  await setModule(m.b.tenantId,'attendance','disabled');await setModule(m.b.tenantId,'attendance','active',c.companyId);
  expect((await names(m.groupAdmin.ctx,'overtime_trend')).map(row=>row[0])).toEqual([METRICS_COMPANY]);
  expect(await workforceMetrics(await session(m.companyAdmin),{metric:'overtime_trend'})).toMatchObject({ok:false,refusal:'not_permitted'});
 });

 const turn=async(ctx:SessionContext,question:string,script:readonly ScriptStep[])=>{const model=scriptedModel(script);
  const result=await runTurn({enabled:HARNESS_TEST_ONLY,ctx,conversationId:randomUUID(),question,scope:{companyId:m.b.companyId,locale:'en'},model,memory:new InMemoryTaskMemoryStore()});
  return{result,model};};
 const lastToolResult=(request:ModelRequest):Record<string,unknown>=>{
  const tool=[...request.messages].reverse().find(message=>message.role==='tool');if(!tool)throw Error('No tool result sent.');
  return JSON.parse((tool.content as string).split('\n').slice(1,-1).join('\n'));
 };
 it('reaches the model only as placeholders and bands, and the person sees the exact figure',async()=>{
  const c=await metricsCompany();
  const staff=[...await hireAll(c.companyId,c.assembly,'A',6),...await hireAll(c.companyId,c.bindery,'B',5),...await hireAll(c.companyId,c.coating,'C',5)];
  const admin=await session(c.admin);
  let placeholder='';
  const {result,model}=await turn(admin,'How many people do we have in each department?',[{calls:[{name:'workforce_metrics',args:{metric:'headcount',breakdown:'department'}}]},
   request=>{const sent=lastToolResult(request) as {companies:{company:string;headcount:string;departments:{department:string;headcount:string}[]}[]};
    expect(sent.companies[0].company).toBe(METRICS_COMPANY);expect(sent.companies[0].departments.map(row=>row.department)).toEqual(['Fictional Assembly','Fictional Bindery','Fictional Coating']);
    expect(sent.companies[0]).not.toHaveProperty('companyId');expect(sent).not.toHaveProperty('minimumGroup');
    for(const row of [sent.companies[0],...sent.companies[0].departments])expect(row.headcount).toMatch(/^\{\{F\d+\}\} \(/);
    placeholder=/\{\{F\d+\}\}/.exec(sent.companies[0].headcount)![0];
    return{final:{reply:`${METRICS_COMPANY} has ${placeholder} people.`,mode:'answer'}};}]);
  expect(model.requests[0].tools.map(tool=>tool.name)).toContain('workforce_metrics');
  expect(result.trace.calls).toEqual([expect.objectContaining({tool:'workforce_metrics',status:'ok'})]);
  expect(result.trace.disclosure[0]).toMatchObject({tool:'workforce_metrics',entity:'workforce_metric',undeclared:[],removed:[]});
  expect(result.trace.disclosure[0].banded.length).toBeGreaterThanOrEqual(5);
  expect(result.reply).toBe(`${METRICS_COMPANY} has 16 people.`);
  const sent=JSON.stringify(model.requests.map(request=>request.messages)),trace=JSON.stringify(result.trace);
  for(const text of [sent,trace]){
   for(const id of [c.companyId,c.assembly,c.bindery,c.coating,...staff.flatMap(person=>[person.employmentId,person.personId])])expect(text).not.toContain(id);
   expect(text).not.toContain('Fictional Worker ');
  }
 });
 it('is not offered to an employee, so their turn reads nothing',async()=>{
  const {result,model}=await turn(await session(m.employee),'How many people are in each department?',[{calls:[{name:'workforce_metrics',args:{metric:'headcount'}}]},{final:{reply:'I cannot count other people here.',mode:'refuse'}}]);
  expect(model.requests[0].tools.map(tool=>tool.name)).not.toContain('workforce_metrics');
  expect(result.trace.calls).toEqual([expect.objectContaining({tool:'workforce_metrics',status:'not_offered'})]);expect(result.reads).toEqual([]);
 });
});
