/** docs/SCALE-AND-RELEASE-RULES.md rule 3 for the team presence read the leave recommendation adds when a company sets a
 * "minimum people present" (core/leave-team-minimum.ts leaveTeamPresence), on the fictional group fixture of 71
 * companies and about 1,000 employments (test/helpers/ai-centre-scale-fixture.ts).
 *
 * The read is set-based: the request with its company's minimum, its dates, and one count over every day of the request,
 * whatever the number of companies, employments or days. Here it answers the same days and counts as an independent
 * count over the fixture's rows, identically under "All companies" (a group administrator, and an administrator granted
 * every company one by one) and under one company, in the same small number of statements. With no minimum set it stops
 * after its first statement, so the recommendation is unchanged and costs one read more. The recommendation's checks
 * with no minimum equal the earlier reader's (test/leave-team-minimum.test.ts, "with no minimum set"). */
import {randomUUID} from 'node:crypto';
import {and,eq,inArray,isNull} from 'drizzle-orm';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import * as schema from '../db/schema';
import type {SessionContext} from '../db/client';
import {leaveTeamPresence} from '../core/leave-team-minimum';
import {todayInKualaLumpur} from '../lib/hr-date';
import {closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {buildScaleFixture,type ScaleFixture} from './helpers/ai-centre-scale-fixture';
import {observeStatements} from './helpers/statement-observer';

let b:Base,fixture:ScaleFixture,requestId:string,days:string[],expected:{date:string;present:number}[],teamSize:number,presenceStatements=0;
const today=todayInKualaLumpur();
/** The fewest present on any day: met exactly, so the request passes on its boundary day. */
let MINIMUM=0;

async function leave(employmentId:string,day:string,status:'approved'|'pending',durationType:'full_day'|'half_day_am'|'hourly'='full_day'){
 const amount=durationType==='full_day'?'1':durationType==='half_day_am'?'0.5':'0.25';
 const [row]=await owner.db.insert(schema.leaveRequest).values({tenantId:b.tenantId,employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:day,endDate:day,days:amount,durationType,status,
  ...(durationType==='hourly'?{hours:'2',fromTime:'09:00',toTime:'11:00'}:{})}).returning({id:schema.leaveRequest.id});
 await owner.db.insert(schema.leaveRequestDate).values({tenantId:b.tenantId,leaveRequestId:row.id,subjectEmploymentId:employmentId,leaveDate:day,days:amount,status});
}

beforeAll(async()=>{
 await migrateTestDb();await resetDb();b=await seedBase();
 fixture=await buildScaleFixture(b,{events:2000});
 // The team: an operating company's active staff, one of them the line manager of the others.
 const staff=await owner.db.select({id:schema.employment.id,personId:schema.employment.personId}).from(schema.employment)
  .where(and(eq(schema.employment.companyId,fixture.singleCompanyId),isNull(schema.employment.terminatedOn),inArray(schema.employment.id,[...fixture.activeEmploymentIds])))
  .orderBy(schema.employment.employeeCode);
 expect(staff.length).toBeGreaterThanOrEqual(8);
 const [lead,...reports]=staff.slice(0,Math.min(staff.length,20));
 await owner.db.insert(schema.reportingLine).values(reports.map(report=>({tenantId:b.tenantId,subordinateEmploymentId:report.id,managerEmploymentId:lead.id,lineType:'administrative' as const,validFrom:'2020-01-01'})));
 // Someone in another company reports to someone else: not in this team.
 const elsewhere=fixture.activeEmploymentIds.filter(id=>!staff.some(row=>row.id===id)).slice(0,2);
 await owner.db.insert(schema.reportingLine).values({tenantId:b.tenantId,subordinateEmploymentId:elsewhere[0],managerEmploymentId:elsewhere[1],lineType:'administrative',validFrom:'2020-01-01'});
 // The applicant asks for Monday to Friday at least a week out, recorded day by day.
 const monday=new Date(today+'T00:00:00Z');monday.setUTCDate(monday.getUTCDate()+7);while(monday.getUTCDay()!==1)monday.setUTCDate(monday.getUTCDate()+1);
 days=[0,1,2,3,4].map(offset=>new Date(monday.getTime()+offset*86_400_000).toISOString().slice(0,10));
 const applicant=reports[0];
 const [request]=await owner.db.insert(schema.leaveRequest).values({tenantId:b.tenantId,employmentId:applicant.id,leaveTypeId:b.annualLeaveTypeId,startDate:days[0],endDate:days[4],days:'5',status:'pending'})
  .returning({id:schema.leaveRequest.id});
 requestId=request.id;
 await owner.db.insert(schema.leaveRequestDate).values(days.map(day=>({tenantId:b.tenantId,leaveRequestId:request.id,subjectEmploymentId:applicant.id,leaveDate:day,days:'1',status:'pending' as const})));
 // The rest of the team's leave on those days: approved full and half days count as away; hourly and pending do not.
 const [r1,r2,r3,r4,r5]=reports.slice(1);
 await leave(r1.id,days[0],'approved');await leave(r1.id,days[1],'approved');
 await leave(r2.id,days[1],'approved','half_day_am');await leave(lead.id,days[1],'approved');
 await leave(r3.id,days[2],'approved','hourly');
 await leave(r4.id,days[3],'pending');
 await leave(r5.id,days[4],'approved');await leave(r5.id,days[0],'approved');
 // Leave outside the team on the same days changes nothing.
 for(const day of days)await leave(elsewhere[0],day,'approved');
 const away:Record<string,string[]>={[days[0]]:[r1.id,r5.id],[days[1]]:[r1.id,r2.id,lead.id],[days[2]]:[],[days[3]]:[],[days[4]]:[r5.id]};
 const others=[lead,...reports.slice(1)];
 teamSize=others.length+1;
 expected=days.map(date=>({date,present:others.filter(member=>!away[date].includes(member.id)).length}));
 MINIMUM=Math.min(...expected.map(day=>day.present));
 expect(MINIMUM).toBeGreaterThan(0);
 await owner.db.update(schema.company).set({leaveTeamMinimumPresent:MINIMUM}).where(eq(schema.company.id,fixture.singleCompanyId));
},240_000);
afterAll(closeAll);

describe('team presence at group scale',()=>{
 const personas=()=>Object.entries(fixture.personas) as [string,SessionContext][];
 it('answers the independent count, the same under All companies and one company, in a bounded number of statements',async()=>{
  const counts:number[]=[];
  for(const [name,persona] of personas()){
   const observed=await observeStatements(()=>leaveTeamPresence(persona,{leaveRequestId:requestId,today}));
   expect(observed.result,name).toEqual({kind:'presence',minimum:MINIMUM,teamSize,days:expected});
   counts.push(ownReads(observed.statements).length);
   expect(observed.transactions,name).toBe(1);
   expect(observed.ms,`${name} took ${Math.round(observed.ms)} ms`).toBeLessThan(5_000);
  }
  // Three reads under every scope (the session's own setup statements aside, which differ by login): the request with
  // its minimum, its dates, and one count over every day.
  expect(counts,'the same reads under every scope').toEqual(counts.map(()=>3));
  presenceStatements=counts[0];
 },120_000);

 it('one day short of the minimum is named with its count, and no minimum costs one statement',async()=>{
  const higher=Math.max(...expected.map(day=>day.present));
  await owner.db.update(schema.company).set({leaveTeamMinimumPresent:higher}).where(eq(schema.company.id,fixture.singleCompanyId));
  const presence=await leaveTeamPresence(fixture.personas.single,{leaveRequestId:requestId,today});
  if(presence.kind!=='presence')throw Error('expected presence');
  expect(presence.days.filter(day=>day.present<higher)).toEqual(expected.filter(day=>day.present<higher));
  await owner.db.update(schema.company).set({leaveTeamMinimumPresent:null}).where(eq(schema.company.id,fixture.singleCompanyId));
  for(const [name,persona] of personas()){
   const observed=await observeStatements(()=>leaveTeamPresence(persona,{leaveRequestId:requestId,today}));
   expect(observed.result,name).toEqual({kind:'no_minimum'});
   // The same transaction with only its first read: no dates and no count.
   expect(ownReads(observed.statements).length,name).toBe(presenceStatements-2);
  }
  await owner.db.update(schema.company).set({leaveTeamMinimumPresent:MINIMUM}).where(eq(schema.company.id,fixture.singleCompanyId));
 },120_000);

 it('refuses a request id the caller cannot see rather than counting nothing',async()=>{
  await expect(leaveTeamPresence(fixture.personas.single,{leaveRequestId:randomUUID(),today})).rejects.toThrow();
 },60_000);
});
/** The read's own statements: those over the leave and reporting tables, not the session's setup or identity statements. */
function ownReads(statements:readonly {sql:string}[]){return statements.filter(statement=>/\b(leave_request|leave_request_date|reporting_line)\b/i.test(statement.sql));}
