import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import type {SessionContext} from '../db/client';
import {withTenant} from '../db/client';
import {appUser,leaveType,leaveLedger} from '../db/schema';
import {hireEmployee} from '../core/org';
import {readEmployeeHomeTimeOff} from '../core/employee-home-time-off';
import {requestLeave,decideLeave,decideLeaveDates,requestLeaveCancellation,decideLeaveCancellation,myLeaveDashboard,
 leaveTypeApplySummary,approvedLeavePresenceByEmploymentTx,setLeaveApprovalPolicy} from '../packs/leave/service';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,harnessSnapshot,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base,CALLER:SessionContext;
vi.mock('../lib/session',()=>({getSession:async()=>CALLER}));
vi.mock('next-intl/server',()=>({getLocale:async()=>'en'}));
const {GET}=await import('../app/api/home/time-off/route');
const today=()=>todayInKualaLumpur(),add=(date:string,n:number)=>new Date(Date.parse(date+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();});
async function worker(role:'employee'|'hr_admin'='employee'){
 const hired=await hireEmployee(adminCtx(b),{person:{fullName:'Fictional time off '+randomUUID(),primaryEmail:randomUUID()+'@example.test'},
  companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:String(Number(today().slice(0,4))-1)+'-01-01'});
 const userId=await createAppUser(b.tenantId,hired.personId,role);
 const ctx:SessionContext={tenantId:b.tenantId,userId,personId:hired.personId,roles:[role],entitlements:harnessSnapshot(b.tenantId)};
 return {...hired,ctx};
}
async function type(employmentId:string,partial:Partial<typeof leaveType.$inferInsert>={}){
 const [row]=await owner.db.insert(leaveType).values({tenantId:b.tenantId,name:'Fictional annual Home leave',code:'HOME_'+randomUUID().slice(0,7).toUpperCase(),
  counting:'calendar_days',paid:true,visibleToEmployee:true,role:'annual',employeeCancelApproved:true,...partial}).returning();
 await owner.db.insert(leaveLedger).values({tenantId:b.tenantId,employmentId,leaveTypeId:row.id,entryType:'accrual',days:'20.00',effectiveOn:today().slice(0,4)+'-01-01'});
 return row.id;
}
describe('Home Time Off consumes canonical own leave facts',()=>{
 it('uses the Apply form available figure once and returns only the selected own response',async()=>{
  const own=await worker(),other=await worker();CALLER=own.ctx;
  const typeId=await type(own.employmentId),a=adminCtx(b);
  const approved=await requestLeave(a,{employmentId:own.employmentId,leaveTypeId:typeId,startDate:add(today(),1),endDate:add(today(),2),today:today()});
  await decideLeave(a,{leaveRequestId:approved.leaveRequestId,decision:'approved'});
  await requestLeave(a,{employmentId:own.employmentId,leaveTypeId:typeId,startDate:add(today(),5),endDate:add(today(),5),today:today()});
  const result=await readEmployeeHomeTimeOff(own.ctx,own.employmentId,'en');
  const popup=await leaveTypeApplySummary(own.ctx,{employmentId:own.employmentId,leaveTypeId:typeId});
  expect(result.balances.find(row=>row.id===typeId)).toEqual({id:typeId,name:'Fictional annual Home leave',annualLeave:true,available:popup.available,pending:popup.pending});
  expect(popup.available).toBe(17);expect(popup.pending).toBe(1);
  expect(result.nextApproved).toEqual({requestId:approved.leaveRequestId,date:add(today(),1),duration:'full_day'});
  const response=await GET(new Request('http://localhost/api/home/time-off?employmentId='+own.employmentId));
  expect(response.status).toBe(200);expect(await response.json()).toEqual(result);
  expect(response.headers.get('cache-control')).toBe('private, no-store');expect(response.headers.get('vary')).toBe('Cookie, Authorization');
  for(const field of ['reason','medical','basicSalary','gross','personId'])expect(JSON.stringify(result)).not.toContain(field);
  expect(JSON.stringify(result)).not.toContain(other.employmentId);
 });
 it('keeps hidden figures null rather than exposing a balance or fabricating zero',async()=>{
  const own=await worker(),typeId=await type(own.employmentId,{essViewConfig:{available:false,pendingApproval:false}});
  const result=await readEmployeeHomeTimeOff(own.ctx,own.employmentId,'en');
  expect(result.balances.find(row=>row.id===typeId)).toMatchObject({available:null,pending:null});
  const canonical=await myLeaveDashboard(own.ctx,own.employmentId,{today:today(),locale:'en'});
  expect(canonical.cards.find(row=>row.leaveTypeId===typeId)?.canApplyFor).toBeNull();
  expect(result.nextApproved).toBeNull();
 });
 it('uses only approved per-date truth and advances after a real cancellation',async()=>{
  const own=await worker(),a=adminCtx(b);
  await setLeaveApprovalPolicy(a,{companyId:b.companyId,levels:['hr_admin']});
  const typeId=await type(own.employmentId,{counting:'working_days',perDateApproval:true});
  let monday=add(today(),1);while(new Date(monday+'T12:00:00Z').getUTCDay()!==1)monday=add(monday,1);
  const request=await requestLeave(a,{employmentId:own.employmentId,leaveTypeId:typeId,startDate:monday,endDate:add(monday,2),today:today()});
  await decideLeaveDates(a,{leaveRequestId:request.leaveRequestId,decisions:[
   {leaveDate:monday,decision:'rejected',rejectReason:'Fictional private reason'},
   {leaveDate:add(monday,1),decision:'approved'},{leaveDate:add(monday,2),decision:'approved'},
  ]});
  const initial=await readEmployeeHomeTimeOff(own.ctx,own.employmentId);
  expect(initial.nextApproved).toMatchObject({date:add(monday,1),duration:'full_day'});
  const presence=await withTenant(own.ctx,tx=>approvedLeavePresenceByEmploymentTx(tx,[own.employmentId],monday,add(monday,2)));
  expect(presence.get(own.employmentId)?.has(initial.nextApproved!.date)).toBe(true);
  expect(presence.get(own.employmentId)?.has(monday)).toBe(false);
  const cancellation=await requestLeaveCancellation(own.ctx,{leaveRequestId:request.leaveRequestId,cancelDates:[add(monday,1)],today:today(),reason:'Fictional return'});
  if(cancellation.status!=='approved')await decideLeaveCancellation(a,{cancellationRequestId:cancellation.cancellationRequestId,decision:'approved'});
  expect((await readEmployeeHomeTimeOff(own.ctx,own.employmentId)).nextApproved?.date).toBe(add(monday,2));
 });
 it('refuses foreign, forged, stale and injected scope selectors, including HR readers',async()=>{
  const own=await worker('hr_admin'),other=await worker();CALLER=own.ctx;
  for(const id of ['',other.employmentId,randomUUID()])await expect(readEmployeeHomeTimeOff(own.ctx,id)).rejects.toMatchObject({code:'employmentUnavailable'});
  await expect(readEmployeeHomeTimeOff({...own.ctx,personId:other.personId},other.employmentId)).rejects.toMatchObject({code:'employmentUnavailable'});
  expect((await GET(new Request('http://localhost/api/home/time-off?employmentId='+other.employmentId))).status).toBe(403);
  for(const query of ['companyId='+b.companyId,'employmentId=one&employmentId=two','personId='+other.personId])expect((await GET(new Request('http://localhost/api/home/time-off?'+query))).status).toBe(400);
  await owner.db.update(appUser).set({archivedAt:new Date()}).where(eq(appUser.id,own.ctx.userId!));
  expect((await GET(new Request('http://localhost/api/home/time-off?employmentId='+own.employmentId))).status).toBe(403);
 });
});
