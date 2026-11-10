/** One Home response reads each own date-local fact once for its widest window (db/shared-read.ts
 * declareSharedReadWindow) and slices it per card. Every slice must equal the reader's own narrow read: original holiday
 * calendars (national, tentative, company-scoped override, across a year end), retained replacement days, approved and
 * pending leave presence (whole-span and per-date children, full and part days), and dated company proof, including
 * dates outside tenure. A window that does not cover the request, or a read outside the shared carrier, reads as before. */
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {declareSharedReadWindow,withSharedReadSnapshot,withTenant,type SessionContext,type Tx} from '../db/client';
import type {SharedReadStats} from '../db/shared-read';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {holidayDatesFor,originalHolidayCalendarFor} from '../core/holidays';
import {replacementHolidayCalendarProjectionsTx} from '../core/holiday-replacement-read';
import {provenCompanyDatesTx} from '../core/employment-company';
import {approvedLeavePresenceByEmploymentTx,leaveCalendarPresenceByEmploymentTx,nextApprovedLeavePresenceTx} from '../packs/leave/service';
import {adminCtx,closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {todayInKualaLumpur} from '../lib/hr-date';

// The next December not yet begun, so the policy can take effect before every source date.
const now=todayInKualaLumpur(),Y0=Number(now.slice(0,4))+(now.slice(5)<'12-01'?0:1),Y1=Y0+1;
const day=(base:string,offset:number)=>new Date(Date.parse(base+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10);
// A fixed window across a year end, so per-year chunks and the business-group override year both differ inside it.
const W={from:`${Y0}-12-10`,to:`${Y1}-01-25`};
let b:Base,ctx:SessionContext,employmentId:string,otherCompanyEmployment:string;
const sessions:SharedReadStats[]=[];
const hooks=globalThis as {__aihrPerfSharedRead?:(stats:SharedReadStats)=>void};

beforeAll(async()=>{
 await migrateTestDb();await resetDb();b=await seedBase();ctx=adminCtx(b);
 const hr=await entitledCtx(b);
 const [second]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional second company',country:'MY'}).returning();
 const [secondDepartment]=await owner.db.insert(s.department).values({tenantId:b.tenantId,companyId:second.id,name:'Fictional department'}).returning();
 employmentId=(await hireEmployee(hr,{person:{fullName:'Fictional Window Person',primaryEmail:'window@example.invalid'},companyId:b.companyId,departmentId:b.deptA,
  employmentType:'full_time',hiredOn:`${Y0}-12-14`,employeeCode:'WIN001'})).employmentId;
 otherCompanyEmployment=(await hireEmployee(hr,{person:{fullName:'Fictional Other Person',primaryEmail:'other@example.invalid'},companyId:second.id,departmentId:secondDepartment.id,
  employmentType:'full_time',hiredOn:`${Y0}-01-01`,employeeCode:'WIN002'})).employmentId;
 const [national]=await owner.db.insert(s.holiday).values({tenantId:b.tenantId,country:'MY',holidayDate:`${Y0}-12-25`,name:'Fictional national'}).returning();
 await owner.db.insert(s.holiday).values([
  {tenantId:b.tenantId,country:'MY',holidayDate:`${Y0}-12-12`,name:'Fictional before hire'},
  {tenantId:b.tenantId,country:'MY',holidayDate:`${Y0}-12-31`,name:'Fictional tentative',tentative:true},
  {tenantId:b.tenantId,country:'MY',holidayDate:`${Y1}-01-01`,name:'Fictional new year'},
  {tenantId:b.tenantId,country:'MY',holidayDate:`${Y1}-01-20`,name:'Fictional inactive',active:false},
  // A company-scoped row in 2027 replaces that year's gazette for the second company only.
  {tenantId:b.tenantId,country:'MY',companyId:second.id,holidayDate:`${Y1}-01-14`,name:'Fictional company day'},
 ]);
 const [policy]=await owner.db.insert(s.replacementHolidayPolicy).values({tenantId:b.tenantId,companyId:b.companyId,effectiveFrom:now,regime:'MY_EA_60D',
  confirmed:true,restMode:'scheduled_rest',searchDays:30,reason:'Fictional replacement policy',createdBy:'fixture'}).returning();
 await owner.db.insert(s.replacementHoliday).values({tenantId:b.tenantId,employmentId,companyId:b.companyId,sourceHolidayId:national.id,policyId:policy.id,sourceDate:`${Y0}-12-25`,
  sourceName:national.name,inputDigest:'fictional',status:'allocated',replacementDate:`${Y0}-12-28`,reason:'Fictional replacement'});
 const [withChildren]=await owner.db.insert(s.leaveRequest).values([
  {tenantId:b.tenantId,employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:`${Y1}-01-05`,endDate:`${Y1}-01-07`,days:'3',status:'approved' as const},
  {tenantId:b.tenantId,employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:`${Y0}-12-16`,endDate:`${Y0}-12-18`,days:'3',status:'approved' as const},
  {tenantId:b.tenantId,employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:`${Y0}-12-22`,endDate:`${Y0}-12-22`,days:'0.5',durationType:'half_day_pm',status:'approved' as const},
  {tenantId:b.tenantId,employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:`${Y1}-01-12`,endDate:`${Y1}-01-13`,days:'2',status:'pending' as const},
 ]).returning();
 await owner.db.insert(s.leaveRequestDate).values([
  {tenantId:b.tenantId,leaveRequestId:withChildren.id,subjectEmploymentId:employmentId,leaveDate:`${Y1}-01-05`,days:'1',status:'approved' as const},
  {tenantId:b.tenantId,leaveRequestId:withChildren.id,subjectEmploymentId:employmentId,leaveDate:`${Y1}-01-06`,days:'1',status:'rejected' as const},
  {tenantId:b.tenantId,leaveRequestId:withChildren.id,subjectEmploymentId:employmentId,leaveDate:`${Y1}-01-07`,days:'1',status:'approved' as const},
 ]);
 hooks.__aihrPerfSharedRead=stats=>{sessions.push(stats);};
});
afterAll(async()=>{delete hooks.__aihrPerfSharedRead;await closeAll();});

const owners=(tx:Tx,id:string,from:string,to:string)=>Promise.all([
 originalHolidayCalendarFor(tx,{employmentId:id,startDate:from,endDate:to}),
 holidayDatesFor(tx,{employmentId:id,startDate:from,endDate:to}).then(dates=>[...dates].sort()),
 replacementHolidayCalendarProjectionsTx(tx,{employmentIds:[id],startDate:from,endDate:to}),
 approvedLeavePresenceByEmploymentTx(tx,[id],from,to).then(map=>[...map].map(([key,dates])=>[key,[...dates]])),
 leaveCalendarPresenceByEmploymentTx(tx,[id],from,to).then(value=>({approved:[...value.approved].map(([key,dates])=>[key,[...dates]]),pending:[...value.pending].map(([key,dates])=>[key,[...dates]])})),
 provenCompanyDatesTx(tx,[to,from,day(from,1),from].map(date=>({employmentId:id,date}))).then(map=>[...map]),
 nextApprovedLeavePresenceTx(tx,id,from),
]);
const narrow=[[W.from,W.to],[`${Y0}-12-10`,`${Y0}-12-13`],[`${Y0}-12-14`,`${Y0}-12-14`],[`${Y0}-12-24`,`${Y1}-01-02`],[`${Y1}-01-05`,`${Y1}-01-07`],[`${Y1}-01-13`,`${Y1}-01-25`],[`${Y0}-12-31`,`${Y1}-01-01`]] as const;

describe('Home date-local reads sliced from one declared window',()=>{
 it('equal each owner\'s own narrow read, for the subject and for another company\'s employment',async()=>{
  for(const id of [employmentId,otherCompanyEmployment]){
   const independent=await Promise.all(narrow.map(([from,to])=>withTenant(ctx,tx=>owners(tx,id,from,to),{readOnlySnapshot:true})));
   sessions.length=0;
   const sliced=await withSharedReadSnapshot(ctx,async()=>{
    declareSharedReadWindow(id,W.from,W.to);
    return Promise.all(narrow.map(([from,to])=>withTenant(ctx,tx=>owners(tx,id,from,to),{readOnlySnapshot:true})));
   });
   expect(sliced).toEqual(independent);
   expect(sessions[0].fallbacks).toBe(0);
   // Real rows were compared, not empty answers.
   if(id===employmentId){
    expect(independent[0][0].map(row=>row.date)).toEqual([`${Y0}-12-25`,`${Y0}-12-31`,`${Y1}-01-01`,`${Y1}-01-20`]);
    expect(independent[0][2].map(row=>row.replacementDate)).toEqual([`${Y0}-12-28`]);
    expect(independent[0][4].pending).toEqual([[employmentId,[[`${Y1}-01-12`,'full_day'],[`${Y1}-01-13`,'full_day']]]]);
   }else expect(independent[0][0].map(row=>row.date)).toEqual([`${Y0}-12-12`,`${Y0}-12-25`,`${Y0}-12-31`,`${Y1}-01-14`]);
  }
 });

 it('reads the window once instead of once per caller',async()=>{
  const count=async(declare:boolean)=>{
   sessions.length=0;
   await withSharedReadSnapshot(ctx,async()=>{
    if(declare)declareSharedReadWindow(employmentId,W.from,W.to);
    await Promise.all(narrow.slice(1).map(([from,to])=>withTenant(ctx,tx=>owners(tx,employmentId,from,to),{readOnlySnapshot:true})));
   });
   return sessions[0].statements-sessions[0].memoHits;
  };
  const [plain,windowed]=[await count(false),await count(true)];
  expect(windowed).toBeLessThan(plain);
 });

 it('never slices outside the carrier, outside the window or for another employment',async()=>{
  const outside=await withSharedReadSnapshot(ctx,async()=>{
   declareSharedReadWindow(employmentId,`${Y0}-12-20`,`${Y0}-12-31`);
   return Promise.all([withTenant(ctx,tx=>owners(tx,employmentId,`${Y0}-12-14`,`${Y1}-01-02`),{readOnlySnapshot:true}),
    withTenant(ctx,tx=>owners(tx,otherCompanyEmployment,`${Y0}-12-24`,`${Y0}-12-26`),{readOnlySnapshot:true})]);
  });
  expect(outside).toEqual([await withTenant(ctx,tx=>owners(tx,employmentId,`${Y0}-12-14`,`${Y1}-01-02`),{readOnlySnapshot:true}),
   await withTenant(ctx,tx=>owners(tx,otherCompanyEmployment,`${Y0}-12-24`,`${Y0}-12-26`),{readOnlySnapshot:true})]);
  // A READ COMMITTED owner transaction inside the session is not the carrier and reads alone.
  const [own]=await withSharedReadSnapshot(ctx,async()=>{
   declareSharedReadWindow(employmentId,W.from,W.to);
   return Promise.all([withTenant(ctx,async tx=>{await tx.execute(sql`select current_setting('transaction_isolation')='read committed' as rc`);return owners(tx,employmentId,`${Y0}-12-24`,`${Y1}-01-02`);})]);
  });
  expect(own).toEqual(await withTenant(ctx,tx=>owners(tx,employmentId,`${Y0}-12-24`,`${Y1}-01-02`)));
 });
});
