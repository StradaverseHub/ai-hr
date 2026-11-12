/** Owner decision 12 November 2026 (Manager Today, item 4) — the per-company "minimum people present" leave setting
 * (draft migration 9770, core/leave-team-minimum.ts) and the approver recommendation's team_coverage check against it
 * (core/recommenders/leave-decision.ts), on fictional data.
 *
 *  1. The setting: an administrator of the company saves it, and the change and its audit event commit together; an
 *     empty box clears it; anyone else (a manager, an administrator of another company, another tenant) is refused
 *     and nothing changes. The column refuses a negative number by itself.
 *  2. The recommendation: with no minimum set it is unchanged (same checks, owners, reads and outcome); with one set,
 *     the minimum met exactly on a day passes, one person fewer fails and names the day with how many would be
 *     present, and a multi-day request names only the days below it. The team is the applicant's line manager and that
 *     manager's reports; people outside it, pending leave and hourly leave do not count as away. It stays advice: the
 *     verdict is needs_review, never a block. */
import {randomUUID} from 'node:crypto';
import {and,eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import * as schema from '../db/schema';
import type {SessionContext} from '../db/client';
import {hireEmployee,setReportingLine} from '../core/org';
import {requestLeave} from '../packs/leave/service';
import {LeaveTeamMinimumError,leaveTeamPresence,listLeaveTeamMinimums,parseLeaveTeamMinimum,setLeaveTeamMinimum} from '../core/leave-team-minimum';
import {todayInKualaLumpur} from '../lib/hr-date';
import {setWorkerSwitch} from '../core/agent-registry/controls';
import {listOutcomeRecords} from '../core/outcome-record/record';
import {RECOMMENDER_AGENT_IDENTITY,leaveDecisionChecks,recommendLeaveDecision,recommendationText,shortDays,type LeaveDecisionFacts} from '../core/recommenders/leave-decision';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

const facts=(over:Partial<LeaveDecisionFacts>={}):LeaveDecisionFacts=>({request:{startDate:'2026-11-10',endDate:'2026-11-12',days:3,hasDocument:false},balanceNow:5,
 ownLeave:{complete:true,overlappingApproved:0,overlappingPending:0},othersAway:0,
 leaveType:{allowNegativeBalance:false,maxNegativeBalance:null,requiresDocument:false,mandatoryAfterDays:null},policyVersion:'leave_type:fixture@v1',today:'2026-11-02',...over});
const coverageOf=(f:LeaveDecisionFacts)=>leaveDecisionChecks(f).find(check=>check.check==='team_coverage')!;

describe('the team_coverage check against a minimum (pure)',()=>{
 it('with no minimum the check is exactly the earlier one',()=>{
  for(const othersAway of [0,1,3,null]){
   const before=leaveDecisionChecks(facts({othersAway}));
   expect(leaveDecisionChecks(facts({othersAway,teamMinimum:null}))).toEqual(before);
   expect(leaveDecisionChecks(facts({othersAway,teamMinimum:undefined}))).toEqual(before);
  }
  expect(coverageOf(facts({othersAway:2}))).toMatchObject({result:'unusual',owner:'core/read.ts#plannedAbsences'});
 });
 it('passes on the boundary, fails one below it (never blocking), and is missing when it could not be read',()=>{
  const days=[{date:'2026-11-10',present:3},{date:'2026-11-11',present:2},{date:'2026-11-12',present:3}];
  // Others are away, but the company's minimum is met on every day: the minimum decides, so it passes.
  expect(coverageOf(facts({othersAway:2,teamMinimum:{minimum:2,days}}))).toMatchObject({result:'pass',blocking:false,owner:'core/leave-team-minimum.ts#leaveTeamPresence',ruleVersion:'leave_decision_recommender:v1'});
  expect(coverageOf(facts({teamMinimum:{minimum:3,days}}))).toMatchObject({result:'fail',blocking:false});
  expect(shortDays({minimum:3,days})).toEqual([{date:'2026-11-11',present:2}]);
  expect(shortDays({minimum:4,days}).map(day=>day.date)).toEqual(['2026-11-10','2026-11-11','2026-11-12']);
  expect(coverageOf(facts({teamMinimum:{minimum:0,days:[{date:'2026-11-10',present:0}]}})).result).toBe('pass');
  expect(coverageOf(facts({teamMinimum:'unreadable'})).result).toBe('missing');
 });
 it('words the days below the minimum deterministically',()=>{
  const checks=leaveDecisionChecks(facts({teamMinimum:{minimum:3,days:[{date:'2026-11-10',present:3},{date:'2026-11-11',present:2}]}}));
  const text=recommendationText({verdict:'needs_review',checks,teamCoverage:{minimum:3,teamSize:4,shortDays:[{date:'2026-11-11',present:2}]}});
  expect(text).toContain('Approving would leave fewer than the minimum of 3 people present on 2026-11-11 (2 present).');
  expect(text).not.toContain('A leave rule would refuse');
  const met=leaveDecisionChecks(facts({teamMinimum:{minimum:1,days:[{date:'2026-11-10',present:1}]}}));
  expect(recommendationText({verdict:'recommend_approve',checks:met,teamCoverage:{minimum:1,teamSize:2,shortDays:[]}}))
   .toContain('At least 1 person of the team stay present on every day of this request.');
 });
 it('reads the form box: empty clears, a whole number from 0 to 10,000 is kept, anything else is refused',()=>{
  expect(parseLeaveTeamMinimum('')).toBeNull();expect(parseLeaveTeamMinimum('  ')).toBeNull();expect(parseLeaveTeamMinimum(null)).toBeNull();
  expect(parseLeaveTeamMinimum('0')).toBe(0);expect(parseLeaveTeamMinimum(' 12 ')).toBe(12);expect(parseLeaveTeamMinimum('10000')).toBe(10000);
  for(const bad of ['-1','1.5','abc','10001','1e3',-1,1.5,{}])expect(()=>parseLeaveTeamMinimum(bad),String(bad)).toThrow(LeaveTeamMinimumError);
 });
});

let b:Base,hr:SessionContext,boss:{employmentId:string;personId:string;ctx:SessionContext},
 applicant:{employmentId:string;personId:string;ctx:SessionContext},colleague:{employmentId:string;personId:string;ctx:SessionContext},
 outsider:{employmentId:string;personId:string;ctx:SessionContext},requestId:string,date:string;
async function login(name:string,role:'employee'|'manager'|'hr_admin'){
 const hired=await hireEmployee(adminCtx(b),{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const userId=await createAppUser(b.tenantId,hired.personId,role);
 await owner.db.insert(schema.leaveLedger).values({tenantId:b.tenantId,employmentId:hired.employmentId,leaveTypeId:b.annualLeaveTypeId,entryType:'accrual',days:'10',effectiveOn:todayInKualaLumpur()});
 return{...hired,ctx:{...await entitledCtx(b,[role]),userId,personId:hired.personId,roles:[role],grants:[{role,companyId:null}]} as SessionContext};
}
/** The next `count` weekdays strictly after `after`. */
function weekdaysAfter(after:string,count:number):string[]{
 const out:string[]=[],day=new Date(after+'T00:00:00Z');
 while(out.length<count){day.setUTCDate(day.getUTCDate()+1);if(![0,6].includes(day.getUTCDay()))out.push(day.toISOString().slice(0,10));}
 return out;
}
async function approvedLeave(employmentId:string,day:string,durationType:'full_day'|'half_day_am'|'hourly'='full_day'){
 const days=durationType==='full_day'?'1':durationType==='half_day_am'?'0.5':'0.25';
 const [row]=await owner.db.insert(schema.leaveRequest).values({tenantId:b.tenantId,employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:day,endDate:day,days,
  durationType,status:'approved',...(durationType==='hourly'?{hours:'2',fromTime:'09:00',toTime:'11:00'}:{})}).returning({id:schema.leaveRequest.id});
 await owner.db.insert(schema.leaveRequestDate).values({tenantId:b.tenantId,leaveRequestId:row.id,subjectEmploymentId:employmentId,leaveDate:day,days,status:'approved'});
 return row.id;
}
/** The SQLSTATE anywhere on an error's cause chain. */
const sqlState=(error:unknown)=>{let cur=error as {code?:string;cause?:unknown}|undefined;for(let i=0;cur&&i<5;i++){if(typeof cur.code==='string')return cur.code;cur=cur.cause as typeof cur;}return null;};
const setMinimum=(value:number|null,companyId=b.companyId)=>owner.db.update(schema.company).set({leaveTeamMinimumPresent:value}).where(eq(schema.company.id,companyId));
const recommend=async(id=requestId)=>{const result=await recommendLeaveDecision(boss.ctx,{leaveRequestId:id});if(result.kind!=='recommendation')throw Error('expected a recommendation: '+result.reason);return result.recommendation;};
const coverage=(r:Awaited<ReturnType<typeof recommend>>)=>r.checks.find(check=>check.check==='team_coverage')!;
const events=(companyId:string)=>owner.db.select({payload:schema.domainEvent.payload,actorId:schema.domainEvent.actorId}).from(schema.domainEvent)
 .where(and(eq(schema.domainEvent.aggregateId,companyId),eq(schema.domainEvent.eventType,'company.leave-team-minimum.changed')));
const stored=async(companyId:string)=>(await owner.db.select({v:schema.company.leaveTeamMinimumPresent}).from(schema.company).where(eq(schema.company.id,companyId)))[0]?.v;

beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();b=await seedBase();
 hr=(await login('Fictional Minimum Administrator','hr_admin')).ctx;
 boss=await login('Fictional Team Lead','manager');
 applicant=await login('Fictional Minimum Applicant','employee');
 colleague=await login('Fictional Minimum Colleague','employee');
 // Someone with another manager: outside the applicant's team.
 const otherBoss=await login('Fictional Other Lead','manager');
 outsider=await login('Fictional Other Team Member','employee');
 for(const report of [applicant.employmentId,colleague.employmentId])
  await setReportingLine(adminCtx(b),{subordinateEmploymentId:report,managerEmploymentId:boss.employmentId,lineType:'administrative',validFrom:'2020-01-01'});
 await setReportingLine(adminCtx(b),{subordinateEmploymentId:outsider.employmentId,managerEmploymentId:otherBoss.employmentId,lineType:'administrative',validFrom:'2020-01-01'});
 date=weekdaysAfter(todayInKualaLumpur(),1)[0];
 requestId=(await requestLeave(applicant.ctx,{employmentId:applicant.employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:date,endDate:date,durationType:'full_day',reason:'Fictional minimum reason'})).leaveRequestId;
 await setWorkerSwitch(hr,{workerId:'approver_recommendation',enabled:true});
});

describe('the company setting',()=>{
 it('an administrator saves it with its audit event in the same change, clears it, and an unchanged save records nothing',async()=>{
  expect(await stored(b.companyId)).toBeNull();
  expect(await listLeaveTeamMinimums(hr)).toEqual([{companyId:b.companyId,name:expect.any(String),minimum:null}]);
  expect(await setLeaveTeamMinimum(hr,{companyId:b.companyId,minimum:'2'})).toEqual({companyId:b.companyId,before:null,after:2,changed:true});
  expect(await stored(b.companyId)).toBe(2);
  expect(await events(b.companyId)).toEqual([{payload:{before:null,after:2},actorId:hr.userId}]);
  expect(await listLeaveTeamMinimums(hr)).toEqual([{companyId:b.companyId,name:expect.any(String),minimum:2}]);
  expect(await setLeaveTeamMinimum(hr,{companyId:b.companyId,minimum:' 2 '})).toMatchObject({changed:false});
  expect(await events(b.companyId)).toHaveLength(1);
  expect(await setLeaveTeamMinimum(hr,{companyId:b.companyId,minimum:''})).toEqual({companyId:b.companyId,before:2,after:null,changed:true});
  expect(await stored(b.companyId)).toBeNull();
  expect((await events(b.companyId)).map(row=>row.payload)).toEqual(expect.arrayContaining([{before:null,after:2},{before:2,after:null}]));
  expect(await events(b.companyId)).toHaveLength(2);
 });

 it('refuses a manager, an administrator of another company and another tenant, and changes nothing',async()=>{
  await expect(setLeaveTeamMinimum(boss.ctx,{companyId:b.companyId,minimum:'3'})).rejects.toMatchObject({name:'LeaveTeamMinimumError',code:'not_allowed'});
  await expect(setLeaveTeamMinimum(applicant.ctx,{companyId:b.companyId,minimum:'3'})).rejects.toMatchObject({code:'not_allowed'});
  expect(await listLeaveTeamMinimums(boss.ctx)).toEqual([]);
  // An administrator of a second company only.
  const [second]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Fictional Second Company Sdn Bhd'}).returning({id:schema.company.id});
  // A login whose only role is hr_admin of the second company (role_assignment row and session grant agree).
  const [p]=await owner.db.insert(schema.person).values({tenantId:b.tenantId,fullName:'Fictional Scoped Administrator',primaryEmail:`${randomUUID()}@fixture.test`}).returning({id:schema.person.id});
  const [u]=await owner.db.insert(schema.appUser).values({tenantId:b.tenantId,workosUserId:`user_${randomUUID()}`,personId:p.id}).returning({id:schema.appUser.id});
  await owner.db.insert(schema.roleAssignment).values({tenantId:b.tenantId,appUserId:u.id,companyId:second.id,role:'hr_admin'});
  const scoped={...adminCtx(b),userId:u.id,grants:[{role:'hr_admin',companyId:second.id}]} as SessionContext;
  await expect(setLeaveTeamMinimum(scoped,{companyId:b.companyId,minimum:'3'})).rejects.toMatchObject({code:'not_allowed'});
  expect((await listLeaveTeamMinimums(scoped)).map(row=>row.companyId)).toEqual([second.id]);
  await setLeaveTeamMinimum(scoped,{companyId:second.id,minimum:'4'});
  expect(await stored(second.id)).toBe(4);
  // Another tenant's administrator cannot reach this tenant's company, nor list it.
  const otherTenant=await seedBase();
  await expect(setLeaveTeamMinimum(adminCtx(otherTenant),{companyId:b.companyId,minimum:'5'})).rejects.toMatchObject({code:'not_allowed'});
  expect((await listLeaveTeamMinimums(adminCtx(otherTenant))).map(row=>row.companyId)).not.toContain(b.companyId);
  // A malformed company id or value is refused before anything is read.
  await expect(setLeaveTeamMinimum(hr,{companyId:'not-a-company',minimum:'1'})).rejects.toMatchObject({code:'not_allowed'});
  await expect(setLeaveTeamMinimum(hr,{companyId:b.companyId,minimum:'-1'})).rejects.toMatchObject({code:'invalid'});
  expect(await stored(b.companyId)).toBeNull();
  expect(await events(b.companyId)).toEqual([]);
  // The column refuses a negative number on its own (migration 9770's CHECK).
  expect(sqlState(await setMinimum(-1).then(()=>null,(error:unknown)=>error))).toBe('23514');
 });
});

describe('the recommendation against the minimum',()=>{
 it('with no minimum set the recommendation is unchanged',async()=>{
  await approvedLeave(colleague.employmentId,date);
  const r=await recommend();
  expect(coverage(r)).toEqual({check:'team_coverage',owner:'core/read.ts#plannedAbsences',ruleVersion:'leave_decision_recommender:v1',result:'unusual',blocking:false});
  expect(r.teamCoverage).toBeNull();
  const [record]=(await listOutcomeRecords(boss.ctx)).filter(row=>row.agentIdentity===RECOMMENDER_AGENT_IDENTITY);
  expect(Object.keys(record.outcome as object).sort()).toEqual(['action','checks','failedRules','leaveRequestId','verdict']);
  expect(record.reads.map((read:{tool:string})=>read.tool)).not.toContain('core/leave-team-minimum.ts#leaveTeamPresence');
  expect(await leaveTeamPresence(boss.ctx,{leaveRequestId:requestId,today:todayInKualaLumpur()})).toEqual({kind:'no_minimum'});
 });

 it('passes when the team stays exactly at the minimum on the day, and fails one person below it, naming the day',async()=>{
  // The team: the lead, the applicant and the colleague. Approving leaves the lead and the colleague present: 2.
  await setMinimum(2);
  const atBoundary=await recommend();
  expect(coverage(atBoundary)).toMatchObject({result:'pass',owner:'core/leave-team-minimum.ts#leaveTeamPresence'});
  expect(atBoundary.teamCoverage).toEqual({minimum:2,teamSize:3,shortDays:[]});
  expect(atBoundary.verdict).toBe('recommend_approve');
  await setMinimum(3);
  const below=await recommend();
  expect(coverage(below)).toMatchObject({result:'fail',blocking:false});
  expect(below.teamCoverage).toEqual({minimum:3,teamSize:3,shortDays:[{date,present:2}]});
  // Advice only: needs the approver's review, and the failed rule is not a blocking one.
  expect(below.verdict).toBe('needs_review');
  expect(below.failedRules).toEqual([{check:'team_coverage',blocking:false,ruleVersion:'leave_decision_recommender:v1'}]);
  expect(recommendationText(below)).toContain(`present on ${date} (2 present)`);
  // The outcome record keeps the minimum and the short day.
  const records=(await listOutcomeRecords(boss.ctx)).filter(row=>row.agentIdentity===RECOMMENDER_AGENT_IDENTITY);
  expect(records.find(row=>row.id===below.recordId)!.outcome).toMatchObject({teamMinimum:3,teamShortDays:[`${date}:2`],failedRules:['team_coverage:non_blocking']});
 });

 it('counts approved full- and half-day leave of the team as away, but not hourly or pending leave, nor people outside the team',async()=>{
  await setMinimum(2);
  await approvedLeave(outsider.employmentId,date);
  const [pending]=await owner.db.insert(schema.leaveRequest).values({tenantId:b.tenantId,employmentId:colleague.employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:date,endDate:date,days:'1',status:'pending'}).returning({id:schema.leaveRequest.id});
  const hourly=await approvedLeave(colleague.employmentId,date,'hourly');
  expect((await recommend()).teamCoverage).toEqual({minimum:2,teamSize:3,shortDays:[]});
  await owner.db.delete(schema.leaveRequestDate).where(eq(schema.leaveRequestDate.leaveRequestId,hourly));
  await owner.db.delete(schema.leaveRequest).where(eq(schema.leaveRequest.id,hourly));
  await owner.db.delete(schema.leaveRequest).where(eq(schema.leaveRequest.id,pending.id));
  await approvedLeave(colleague.employmentId,date,'half_day_am');
  expect((await recommend()).teamCoverage).toEqual({minimum:2,teamSize:3,shortDays:[{date,present:1}]});
 });

 it('names exactly the days of a multi-day request that fall below the minimum',async()=>{
  await setMinimum(2);
  // A Monday-to-Wednesday request at least a week later; the colleague is away on its middle day only.
  const monday=new Date(weekdaysAfter(todayInKualaLumpur(),5)[4]+'T00:00:00Z');do{monday.setUTCDate(monday.getUTCDate()+1);}while(monday.getUTCDay()!==1);
  const [first,middle,last]=[0,1,2].map(offset=>new Date(monday.getTime()+offset*86_400_000).toISOString().slice(0,10));
  const id=(await requestLeave(applicant.ctx,{employmentId:applicant.employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:first,endDate:last,durationType:'full_day',reason:'Fictional three days'})).leaveRequestId;
  await approvedLeave(colleague.employmentId,middle);
  const presence=await leaveTeamPresence(boss.ctx,{leaveRequestId:id,today:todayInKualaLumpur()});
  if(presence.kind!=='presence')throw Error('expected presence');
  // Every day of the request is checked, in date order.
  expect(presence.days).toEqual([{date:first,present:2},{date:middle,present:1},{date:last,present:2}]);
  const r=await recommend(id);
  expect(r.teamCoverage).toEqual({minimum:2,teamSize:3,shortDays:[{date:middle,present:1}]});
  expect(coverage(r).result).toBe('fail');
  // Away on the first and last day as well: all three named, in date order.
  await approvedLeave(colleague.employmentId,first);await approvedLeave(colleague.employmentId,last);
  expect((await recommend(id)).teamCoverage!.shortDays).toEqual([{date:first,present:1},{date:middle,present:1},{date:last,present:1}]);
 });

 it('an applicant with no line manager has no team: the earlier check runs even with a minimum set',async()=>{
  await setMinimum(5);
  const loner=await login('Fictional Unmanaged Applicant','employee');
  const id=(await requestLeave(loner.ctx,{employmentId:loner.employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:date,endDate:date,durationType:'full_day',reason:'Fictional no team'})).leaveRequestId;
  expect(await leaveTeamPresence(hr,{leaveRequestId:id,today:todayInKualaLumpur()})).toEqual({kind:'no_team',minimum:5});
  // The applicant with a lead is unaffected by the loner, and is counted against the minimum.
  expect((await leaveTeamPresence(hr,{leaveRequestId:requestId,today:todayInKualaLumpur()})).kind).toBe('presence');
 });
});
