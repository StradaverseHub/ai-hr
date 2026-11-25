/** ADR-0181 package 1.4 — the per-date leave breakdown read for a SET of requests (core/read.ts
 * leaveRequestDateBreakdowns), docs/SCALE-AND-RELEASE-RULES.md rules 2 and 3, on the fictional group fixture of 71
 * companies and about 1,000 employments (test/helpers/ai-centre-scale-fixture.ts).
 *
 * The Approvals page (every pending leave row) and the own leave history (its five newest rows) used to call the
 * per-row owner leaveRequestDateBreakdown once per row, one transaction each. The set owner answers, for every id
 * asked, exactly what the per-row owner answers — same rows, same order, same row-security outcome, an empty list for
 * an id the viewer cannot see or that has no per-date rows — under a group HR administrator, an HR administrator
 * granted every company one by one, a single-company HR administrator, a line manager and the employee themself. It
 * does so in one transaction whose statements do not grow with the number of ids, and sends nothing for no ids.
 *
 * About 200 pending requests spread over the companies: multi-day spans with mixed per-date decisions, half-day spans,
 * spans over a rest day (Friday to Monday, no weekend rows) and over a holiday (no row for that day), and single-day
 * requests that carry no per-date rows (the ordinary whole-request approval). Every name and reason is invented. */
import {randomUUID} from 'node:crypto';
import {inArray,sql} from 'drizzle-orm';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import * as schema from '../db/schema';
import type {SessionContext} from '../db/client';
import {leaveRequestDateBreakdown,leaveRequestDateBreakdowns,type LeaveRequestDateBreakdownRow} from '../core/read';
import {todayInKualaLumpur} from '../lib/hr-date';
import {closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {buildScaleFixture,type ScaleFixture} from './helpers/ai-centre-scale-fixture';
import {observeStatements} from './helpers/statement-observer';

type DateSpec={date:string;days:string;status:'pending'|'approved'|'rejected';rejectReason?:string;decided?:boolean};
type RequestSpec={id:string;employmentId:string;companyId:string;startDate:string;endDate:string;days:string;durationType:'full_day'|'half_day_am';dates:DateSpec[]};

const DAY=86_400_000;
const plus=(day:string,n:number)=>new Date(Date.parse(`${day}T00:00:00Z`)+n*DAY).toISOString().slice(0,10);
const REQUESTS=200;

let b:Base,fixture:ScaleFixture,specs:RequestSpec[],requestIds:string[];
let personas:Record<'group'|'multi'|'single'|'manager'|'employee',SessionContext>;
let teamEmploymentIds:Set<string>,employeeEmploymentId:string;

/** One request of shape `shape` for `employmentId` in the week starting on Monday `monday`. */
function request(employmentId:string,companyId:string,monday:string,shape:number):RequestSpec{
 const id=randomUUID();
 switch(shape){
  case 0:// Monday to Wednesday, decided date by date: approved, rejected, still pending.
   return {id,employmentId,companyId,startDate:monday,endDate:plus(monday,2),days:'3',durationType:'full_day',dates:[
    {date:monday,days:'1.00',status:'approved',decided:true},
    {date:plus(monday,1),days:'1.00',status:'rejected',rejectReason:'Fictional cover gap that week',decided:true},
    {date:plus(monday,2),days:'1.00',status:'pending'}]};
  case 1:// Two half days.
   return {id,employmentId,companyId,startDate:monday,endDate:plus(monday,1),days:'1',durationType:'half_day_am',dates:[
    {date:monday,days:'0.50',status:'pending'},{date:plus(monday,1),days:'0.50',status:'pending'}]};
  case 2:// Friday to Monday: the weekend's rest days carry no row.
   return {id,employmentId,companyId,startDate:plus(monday,4),endDate:plus(monday,7),days:'2',durationType:'full_day',dates:[
    {date:plus(monday,4),days:'1.00',status:'pending'},{date:plus(monday,7),days:'1.00',status:'approved',decided:true}]};
  case 3:// Tuesday to Thursday over a (fictional) Wednesday holiday: no row for the holiday.
   return {id,employmentId,companyId,startDate:plus(monday,1),endDate:plus(monday,3),days:'2',durationType:'full_day',dates:[
    {date:plus(monday,1),days:'1.00',status:'pending'},{date:plus(monday,3),days:'1.00',status:'pending'}]};
  default:// One day: no per-date rows (the ordinary whole-request approval).
   return {id,employmentId,companyId,startDate:monday,endDate:monday,days:'1',durationType:'full_day',dates:[]};
 }
}

beforeAll(async()=>{
 await migrateTestDb();await resetDb();b=await seedBase();
 fixture=await buildScaleFixture(b,{events:2000});
 const active=await owner.db.select({id:schema.employment.id,companyId:schema.employment.companyId,personId:schema.employment.personId}).from(schema.employment)
  .where(inArray(schema.employment.id,[...fixture.activeEmploymentIds])).orderBy(schema.employment.companyId,schema.employment.employeeCode);
 // The team: in the single-company administrator's company, a line manager and five direct reports.
 const staff=active.filter(e=>e.companyId===fixture.singleCompanyId);
 expect(staff.length).toBeGreaterThanOrEqual(6);
 const [lead,...rest]=staff;const reports=rest.slice(0,5);
 await owner.db.insert(schema.reportingLine).values(reports.map(report=>({tenantId:b.tenantId,subordinateEmploymentId:report.id,managerEmploymentId:lead.id,lineType:'administrative' as const,validFrom:'2020-01-01'})));
 teamEmploymentIds=new Set([lead.id,...reports.map(r=>r.id)]);
 const employee=reports[0];employeeEmploymentId=employee.id;
 // Requests start at least two weeks out, on a Monday.
 const monday0=(()=>{let d=plus(todayInKualaLumpur(),14);while(new Date(`${d}T00:00:00Z`).getUTCDay()!==1)d=plus(d,1);return d;})();
 const week=(w:number)=>plus(monday0,7*w);
 // The employee has three requests in separate fortnights; the rest of the team one each; then one request per
 // employment, taken company by company in rounds so every staffed company has requests.
 specs=[request(employee.id,employee.companyId,week(0),0),request(employee.id,employee.companyId,week(2),2),request(employee.id,employee.companyId,week(4),4),
  ...[lead,...reports.slice(1)].map((e,i)=>request(e.id,e.companyId,week(i%6),(i+1)%5))];
 const byCompany=new Map<string,typeof active>();
 for(const e of active)if(!teamEmploymentIds.has(e.id))(byCompany.get(e.companyId)??byCompany.set(e.companyId,[]).get(e.companyId)!).push(e);
 for(let round=0;specs.length<REQUESTS;round++){
  let added=false;
  for(const members of byCompany.values()){
   if(specs.length>=REQUESTS)break;
   const e=members[round];if(!e)continue;
   specs.push(request(e.id,e.companyId,week(specs.length%6),specs.length%5));added=true;
  }
  if(!added)break;
 }
 expect(specs.length).toBe(REQUESTS);
 expect(new Set(specs.map(s=>s.companyId)).size,'requests spread over the group').toBeGreaterThanOrEqual(50);
 requestIds=specs.map(s=>s.id);
 await owner.db.insert(schema.leaveRequest).values(specs.map(s=>({id:s.id,tenantId:b.tenantId,employmentId:s.employmentId,leaveTypeId:b.annualLeaveTypeId,
  startDate:s.startDate,endDate:s.endDate,days:s.days,durationType:s.durationType,status:'pending' as const})));
 const decidedAt=new Date(Date.now()-DAY);
 // Inserted in reverse date order so the read's ordering, not the insertion order, is what the test sees.
 const dateRows=specs.flatMap(s=>[...s.dates].reverse().map(d=>({tenantId:b.tenantId,leaveRequestId:s.id,subjectEmploymentId:s.employmentId,leaveDate:d.date,days:d.days,status:d.status,
  rejectReason:d.rejectReason??null,decidedByEmploymentId:d.decided?lead.id:null,decidedAt:d.decided?decidedAt:null})));
 for(let i=0;i<dateRows.length;i+=500)await owner.db.insert(schema.leaveRequestDate).values(dateRows.slice(i,i+500));
 await owner.db.execute(sql`analyze public.leave_request, public.leave_request_date, public.reporting_line`);
 const login=async(personId:string,role:'manager'|'employee'):Promise<SessionContext>=>{
  const userId=await createAppUser(b.tenantId,personId,role);
  return {...await entitledCtx(b,[role]),userId,personId,roles:[role]};
 };
 personas={group:fixture.personas.group,multi:fixture.personas.multi,single:fixture.personas.single,
  manager:await login(lead.personId,'manager'),employee:await login(employee.personId,'employee')};
},240_000);
afterAll(closeAll);

/** The per-row owner's answer for each id, in order, a few at a time. */
async function perRow(ctx:SessionContext,ids:readonly string[]){
 const out:[string,LeaveRequestDateBreakdownRow[]][]=[];
 for(let i=0;i<ids.length;i+=20)out.push(...await Promise.all(ids.slice(i,i+20).map(async id=>[id,await leaveRequestDateBreakdown(ctx,id)] as [string,LeaveRequestDateBreakdownRow[]])));
 return out;
}
const fingerprint=(rows:readonly LeaveRequestDateBreakdownRow[])=>rows.map(r=>`${r.leaveDate}:${r.days}:${r.status}:${r.rejectReason??''}`);
const expectedFingerprint=(s:RequestSpec)=>[...s.dates].sort((x,y)=>x.date.localeCompare(y.date)).map(d=>`${d.date}:${d.days}:${d.status}:${d.rejectReason??''}`);

describe('per-date leave breakdowns for a set of requests at group scale',()=>{
 // Not yet measured on the hosted runner: about 1,000 per-row transactions across five viewers. Budgeted at 180 s
 // (the global limit is 30 s); revisit with the first hosted measurement.
 it('answers exactly the per-row owner for every id and viewer, including ids the viewer cannot see',async()=>{
  const unknown=randomUUID();
  // A duplicate, an upper-case spelling of a visible id and an id that does not exist are asked too.
  const asked=[...requestIds,requestIds[1],requestIds[0].toUpperCase(),unknown];
  const distinct=[...new Set(asked)];
  const visibleTo:Record<string,Set<string>>={};
  for(const [name,ctx] of Object.entries(personas)){
   const set=await leaveRequestDateBreakdowns(ctx,asked);
   expect([...set.keys()],`${name}: every distinct id, first-asked order`).toEqual(distinct);
   expect([...set.entries()],`${name}: same rows in the same order as the per-row owner`).toEqual(await perRow(ctx,distinct));
   expect(set.get(unknown),name).toEqual([]);
   expect(set.get(requestIds[0].toUpperCase()),name).toEqual(set.get(requestIds[0]));
   visibleTo[name]=new Set(requestIds.filter(id=>set.get(id)!.length>0));
   // Independent of either owner: what was inserted, in date order, for every request this viewer can see.
   for(const s of specs)if(visibleTo[name].has(s.id))expect(fingerprint(set.get(s.id)!),`${name}: ${s.id}`).toEqual(expectedFingerprint(s));
  }
  const withRows=(keep:(s:RequestSpec)=>boolean)=>new Set(specs.filter(s=>s.dates.length>0&&keep(s)).map(s=>s.id));
  // Nonempty, and exactly the population each viewer's row security admits.
  expect(withRows(()=>true).size).toBeGreaterThan(120);
  expect(visibleTo.group).toEqual(withRows(()=>true));
  expect(visibleTo.multi).toEqual(withRows(()=>true));
  expect(visibleTo.single).toEqual(withRows(s=>s.companyId===fixture.singleCompanyId));
  expect(visibleTo.manager).toEqual(withRows(s=>teamEmploymentIds.has(s.employmentId)));
  expect(visibleTo.employee).toEqual(withRows(s=>s.employmentId===employeeEmploymentId));
  // The narrower viewers see strictly less than the group: lead + four of five reports have rows (six requests,
  // two of them the employee's), and the single company holds the team.
  expect(visibleTo.single.size).toBeLessThan(visibleTo.group.size);
  expect(visibleTo.single.size).toBeGreaterThanOrEqual(visibleTo.manager.size);
  expect(visibleTo.manager.size).toBe(6);
  expect(visibleTo.employee.size).toBe(2);
 },180_000);

 it('one transaction, and the same statements for 1 id as for 200; no ids sends nothing',async()=>{
  for(const [name,ctx] of Object.entries(personas)){
   const one=await observeStatements(()=>leaveRequestDateBreakdowns(ctx,[requestIds[0]]));
   const all=await observeStatements(()=>leaveRequestDateBreakdowns(ctx,requestIds));
   expect(one.transactions,name).toBe(1);
   expect(all.transactions,name).toBe(1);
   expect(all.statements.length,`${name}: statements do not grow with the ids`).toBe(one.statements.length);
   expect(ownReads(one.statements).length,name).toBe(1);
   expect(ownReads(all.statements).length,name).toBe(1);
   expect(all.result.size,name).toBe(REQUESTS);
   const none=await observeStatements(()=>leaveRequestDateBreakdowns(ctx,[]));
   expect(none.result.size,name).toBe(0);
   expect(none.statements.length,`${name}: no ids, no statement`).toBe(0);
  }
  // The per-row owner it replaces on the two pages: one transaction per id.
  const loop=await observeStatements(()=>Promise.all(requestIds.slice(0,20).map(id=>leaveRequestDateBreakdown(personas.group,id))));
  expect(loop.transactions).toBe(20);
 },120_000);
});
/** The read's own statements: those over leave_request_date, not the session's setup or identity statements. */
function ownReads(statements:readonly {sql:string}[]){return statements.filter(statement=>/\bleave_request_date\b/i.test(statement.sql));}
