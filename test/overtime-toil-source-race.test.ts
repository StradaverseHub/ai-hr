/** Real app-role transactions: raw Attendance writers intentionally do not take the employee advisory. */
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {randomUUID} from 'node:crypto';
import {migrateTestDb,closeAll,resetDb,seedBase,setModule,entitledCtx,owner,type Base} from './harness';
import {withTenant,type Tx} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {setRestDay} from '../core/roster';
import {setToilPolicy,bankToilCreditTx,accrueToil,leaveCreditClaimReview} from '../core/toil';
import {checkIn,checkOut,setAttendancePolicy,saveOvertimePatternDraft,validateOvertimePatternActivation,activateOvertimePattern,saveOvertimePatternAssignment,createOvertimeCalculationOwner,canonicalOvertimeInputTx,readOvertimeCalculationTx,resolveOvertimeToilDurationTx,readOvertimeSettlementForDayTx} from '../packs/attendance/service';
import {createPayComponent} from '../packs/payroll/service';
import {submitLeaveCreditRequest,listPendingReplacementLeaveRequests,decideReplacementLeaveRequest} from '../packs/leave/service';
import {requirePackFor} from '../localization/registry';
import {todayInKualaLumpur} from '../lib/hr-date';
import type {OvertimePattern} from '../lib/overtime-pattern-model';
let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'attendance','active');await setModule(b.tenantId,'toil','active');await setModule(b.tenantId,'payroll','active');});
function barrier<T=void>() {let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
async function pid(tx:Tx){return (await tx.execute(sql`select pg_backend_pid() as pid`) as unknown as {pid:number}[])[0].pid;}
async function blocked(backend:number){
 const until=Date.now()+5000;
 while(Date.now()<until){const rows=await owner.db.execute(sql`select wait_event_type from pg_stat_activity where pid=${backend}`) as unknown as {wait_event_type:string|null}[];if(rows[0]?.wait_event_type==='Lock')return;await new Promise(done=>setTimeout(done,20));}
 throw new Error('Expected the second app-role session to wait on the source row lock.');
}
async function fixture(kind:'rest_day'|'workday'='rest_day',formulaMinutes?:string){
 const ctx=await entitledCtx(b),date=todayInKualaLumpur();
 const e=await hireEmployee(ctx,{person:{fullName:'Fictional TOIL source race',primaryEmail:'fictional-toil-race@example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2024-01-01'});
 await setCompensation(ctx,{employmentId:e.employmentId,basicSalary:5000,monthlyAllowance:0,effectiveFrom:'2024-01-01'});
 await setAttendancePolicy(ctx,{companyId:b.companyId,workStart:'09:00',workEnd:'17:00',breakMinutes:0,lateAfter:'09:00',halfDayBefore:'13:00',workingDays:[1,2,3,4,5,6,7]});
 if(kind==='rest_day')await setRestDay(ctx,{employmentId:e.employmentId,shiftDate:date});
 // A recorded ordinary workday with only pre-shift raw work cannot become a rest credit after a roster edit.
 await checkIn(ctx,{employmentId:e.employmentId,date,time:kind==='workday'?'07:00':'09:00'});await checkOut(ctx,{employmentId:e.employmentId,date,time:kind==='workday'?'09:00':'11:00'});
 const seed=requirePackFor('MY').payComponents.defaults.find(item=>item.code===requirePackFor('MY').payComponents.backfillCodes.overtime)!;
 const earning=await createPayComponent(ctx,{...seed,code:'RACE_'+randomUUID().slice(0,8),name:'Fictional race OT',label:'Fictional race OT'});
 const definition:OvertimePattern={v:1,currency:{code:'MYR',minorScale:2},definitions:[],eligibilityBasis:'day',durationAllocation:'latest',eligibility:{id:'eligible',type:'constant',value:true},eligibleMinutes:null,durationCap:null,durationRounding:null,deductions:[],rates:[{id:'rate',name:'Synthetic race rate',description:'Fictional',priority:0,when:{id:'rate-when',type:'constant',value:true},timeBand:null,accumulation:'day',tierMode:'marginal',tiers:[{id:'tier',from:'0',to:null,mapping:{earningItemId:earning.id,currency:'MYR'},payment:{method:'hourly',rate:{id:'rate-value',type:'literal',unit:'moneyPerHour',currency:'MYR',value:'12'},multiplier:{id:'multiplier',type:'literal',unit:'scalar',value:'1'}}}]}],paymentCap:null,moneyRounding:{stage:'dayMapping',mode:'halfUp'}};
 if(formulaMinutes)definition.eligibleMinutes={id:'review-minutes',type:'literal',unit:'minutes',value:formulaMinutes};
 const saved=await saveOvertimePatternDraft(ctx,{draft:{code:'RACE_'+randomUUID().slice(0,8),creationCompanyId:b.companyId,companyIds:[b.companyId],name:'Fictional race policy',definition}});
 const validation=await validateOvertimePatternActivation(ctx,{versionId:saved.versionId,expectedRevision:saved.revision});expect(validation.validationDigest).not.toBeNull();
 await activateOvertimePattern(ctx,{versionId:saved.versionId,expectedRevision:saved.revision,validationDigest:validation.validationDigest!,effectiveFrom:date});
 await saveOvertimePatternAssignment(ctx,{versionId:saved.versionId,target:{type:'individual',employmentIds:[e.employmentId]},priority:1,from:date,to:null});
 const api=createOvertimeCalculationOwner(canonicalOvertimeInputTx);
 await withTenant(ctx,async tx=>{const prepared=await api.prepareTx(tx,ctx,{employmentId:e.employmentId,date});const read=await readOvertimeCalculationTx(tx,ctx,{employmentId:e.employmentId,date});const result=await api.recordTx(tx,ctx,{prepared,expectedCurrentRevision:read!.source.revision});expect(result.status).toBe('recorded');if(result.status==='recorded')expect(result.duration?.status).toBe('ready');});
 await setToilPolicy(ctx,{companyId:b.companyId,enabled:true,accrualBasis:'hours_worked',expiryDays:90,onExpiry:'convert_to_pay',allowFirstScheduleEligible:false,autoAccrueOnApproval:false,carryForwardAtYearEnd:false,employeeRequestEnabled:true,extendedHoursEnabled:true,extendedHalfDayMinutes:60,extendedFullDayMinutes:120});
 return {ctx,date,employmentId:e.employmentId};
}
describe('duration-only Leave Credit review uses the same formula source and keeps writes authoritative',()=>{
 it('refuses a601-minute entered claim against60 without inventing a credit or banking anything',async()=>{
  const f=await fixture('rest_day','60');
  const review=await leaveCreditClaimReview(f.ctx,{employmentId:f.employmentId,workedDate:f.date,claimStart:'09:00',claimEnd:'19:01'});
  expect(review).toMatchObject({basis:'formula',status:'refused',reason:'exceedsBound',claimedMinutes:601,boundMinutes:60,eligibleMinutes:null,creditDays:null});
  expect(JSON.stringify(review)).not.toMatch(/salary|MYR|amountMinor|hourlyRate/);
  expect(await owner.db.select().from(s.toilAccrual).where(eq(s.toilAccrual.employmentId,f.employmentId))).toEqual([]);
  const subset=await leaveCreditClaimReview(f.ctx,{employmentId:f.employmentId,workedDate:f.date,claimStart:'09:00',claimEnd:'10:00'});
  expect(subset).toMatchObject({basis:'formula',status:'ready',boundMinutes:60,eligibleMinutes:60,creditDays:0.5});
  expect(await owner.db.select().from(s.toilAccrual).where(eq(s.toilAccrual.employmentId,f.employmentId))).toEqual([]);
 });
 it('explains the existing employee pending claim to an approver while unchanged banking refuses it atomically',async()=>{
  const f=await fixture('rest_day','60');
  const submitted=await submitLeaveCreditRequest(f.ctx,{employmentId:f.employmentId,rows:[{workedDate:f.date,dayType:'rest_day',claimStart:'09:00',claimEnd:'19:01'}],reason:'Fictional employee window for review',today:f.date});
  const requests=await listPendingReplacementLeaveRequests(f.ctx),request=requests.find(row=>row.id===submitted.requestId);
  expect(request?.dates[0].claimReview).toMatchObject({basis:'formula',status:'refused',reason:'exceedsBound',claimedMinutes:601,boundMinutes:60,creditDays:null});
  expect(request?.totalDays).toBe(1); // stored original claim remains evidence, never silently capped
  await expect(decideReplacementLeaveRequest(f.ctx,{requestId:submitted.requestId,decision:'approved'})).rejects.toThrow('reviewed subset');
  expect((await owner.db.select().from(s.replacementLeaveRequest).where(eq(s.replacementLeaveRequest.id,submitted.requestId)))[0].status).toBe('pending');
  expect(await owner.db.select().from(s.toilAccrual).where(eq(s.toilAccrual.employmentId,f.employmentId))).toEqual([]);
 });
 it('retains pending formula requests as unavailable after canonical TOIL module removal and fresh context',async()=>{
  const f=await fixture('rest_day','60');
  const submitted=await submitLeaveCreditRequest(f.ctx,{employmentId:f.employmentId,rows:[{workedDate:f.date,dayType:'rest_day',claimStart:'09:00',claimEnd:'19:01'}],reason:'Fictional retained pending review',today:f.date});
  await setModule(b.tenantId,'toil','disabled');
  const fresh=await entitledCtx(b);
  const requests=await listPendingReplacementLeaveRequests(fresh),request=requests.find(row=>row.id===submitted.requestId);
  expect(request).toBeDefined();expect(request?.totalDays).toBe(1);
  expect(request?.dates[0].claimReview).toEqual({basis:'unavailable',reason:'unavailable'});
  expect((await owner.db.select().from(s.replacementLeaveRequest).where(eq(s.replacementLeaveRequest.id,submitted.requestId)))[0].status).toBe('pending');
  expect(await owner.db.select().from(s.toilAccrual).where(eq(s.toilAccrual.employmentId,f.employmentId))).toEqual([]);
 });
 it('uses canonical post-shift intersection rather than a typed ordinary-day window',async()=>{
  const f=await fixture('workday');
  expect(await leaveCreditClaimReview(f.ctx,{employmentId:f.employmentId,workedDate:f.date,claimStart:'18:00',claimEnd:'23:00'})).toMatchObject({basis:'formula',status:'refused',reason:'belowThreshold',eligibleMinutes:0,creditDays:null});
 });
 it('shows changed source evidence as unavailable rather than reusing legacy claim arithmetic',async()=>{
  const f=await fixture('rest_day','60');await withTenant(f.ctx,tx=>tx.update(s.attendance).set({workedMinutes:119}).where(eq(s.attendance.employmentId,f.employmentId)));
  expect(await leaveCreditClaimReview(f.ctx,{employmentId:f.employmentId,workedDate:f.date,claimStart:'09:00',claimEnd:'10:00'})).toMatchObject({basis:'unavailable'});
 });
});
describe('source row lock serializes actual TOIL against direct raw Attendance writes',()=>{
 it('TOIL wins: the waiting raw app-role write sees the committed active claim and refuses',async()=>{
  const f=await fixture(),held=barrier(),release=barrier(),rawPid=barrier<number>();
  const banking=withTenant(f.ctx,async tx=>{const proof=await resolveOvertimeToilDurationTx(tx,f.ctx,{employmentId:f.employmentId,date:f.date});expect(proof.kind).toBe('formula');held.resolve();await release.promise;return bankToilCreditTx(tx,f.ctx,{employmentId:f.employmentId,workedDate:f.date,companyId:b.companyId,country:'MY',dayType:'rest_day',workedDayKind:'rest_day',otMinutes:120,source:'roster'});});
  await Promise.race([held.promise,banking.then(()=>{throw new Error('Banking ended before the lock barrier.');})]);
  const raw=withTenant(f.ctx,async tx=>{rawPid.resolve(await pid(tx));await tx.update(s.attendance).set({workedMinutes:121}).where(eq(s.attendance.employmentId,f.employmentId));}).then(()=>({ok:true}),error=>({ok:false,error}));
  try {await blocked(await rawPid.promise);release.resolve();const bank=await banking;expect(bank.accrualId).toBeTruthy();expect((await raw).ok).toBe(false);
   const claim=await withTenant(f.ctx,tx=>readOvertimeSettlementForDayTx(tx,f.ctx,{employmentId:f.employmentId,date:f.date}));expect(claim?.settlement).toMatchObject({mode:'toil',toilAccrualId:bank.accrualId});
  }finally{release.resolve();await Promise.allSettled([banking,raw]);}
 },20000);
 it('raw writer wins: TOIL waits, rereads committed Attendance and refuses stale duration without an accrual',async()=>{
  const f=await fixture(),held=barrier(),release=barrier(),toilPid=barrier<number>();
  const raw=withTenant(f.ctx,async tx=>{await tx.update(s.attendance).set({workedMinutes:121}).where(eq(s.attendance.employmentId,f.employmentId));held.resolve();await release.promise;});
  await Promise.race([held.promise,raw.then(()=>{throw new Error('Raw write ended before the lock barrier.');})]);
  const banking=withTenant(f.ctx,async tx=>{toilPid.resolve(await pid(tx));return bankToilCreditTx(tx,f.ctx,{employmentId:f.employmentId,workedDate:f.date,companyId:b.companyId,country:'MY',dayType:'rest_day',workedDayKind:'rest_day',otMinutes:120,source:'roster'});}).then(()=>({ok:true}),error=>({ok:false,error}));
  try {await blocked(await toilPid.promise);release.resolve();await raw;expect((await banking).ok).toBe(false);expect(await owner.db.select().from(s.toilAccrual).where(eq(s.toilAccrual.employmentId,f.employmentId))).toHaveLength(0);
  }finally{release.resolve();await Promise.allSettled([raw,banking]);}
 },20000);
 it('recorded workday remains workday after current roster becomes rest, so pre-shift-only duration cannot bank',async()=>{
  const f=await fixture('workday');await owner.db.insert(s.rosterAssignment).values({tenantId:b.tenantId,employmentId:f.employmentId,shiftDate:f.date,isRestDay:true});
  await expect(accrueToil(f.ctx,{employmentId:f.employmentId,workedDate:f.date})).rejects.toThrow();expect(await owner.db.select().from(s.toilAccrual).where(eq(s.toilAccrual.employmentId,f.employmentId))).toHaveLength(0);
 });
 it('recorded rest remains rest after current roster becomes workday',async()=>{
  const f=await fixture();await owner.db.delete(s.rosterAssignment).where(eq(s.rosterAssignment.employmentId,f.employmentId));
  expect((await accrueToil(f.ctx,{employmentId:f.employmentId,workedDate:f.date})).daysCredited).toBe(0.25);
  expect((await owner.db.select().from(s.toilAccrual).where(eq(s.toilAccrual.employmentId,f.employmentId)))[0].workedDayKind).toBe('rest_day');
 });
});
