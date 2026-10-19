/** Reachable cancellation splits preserve application facts. No mixed-unpaid policy is introduced. */
import {randomUUID} from 'node:crypto';
import {and,eq,asc} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,it,expect} from 'vitest';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {requestLeaveCancellation,todayInKualaLumpur} from '../core/leave';
import {unpaidLeaveDaysForPeriod} from '../packs/payroll/service';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import type {SessionContext} from '../db/client';
let b:Base,subject:{employmentId:string;personId:string},employee:SessionContext;
let dates:string[];
const add=(day:string,count:number)=>{const date=new Date(`${day}T12:00:00Z`);date.setUTCDate(date.getUTCDate()+count);return date.toISOString().slice(0,10);};
beforeAll(migrateTestDb);
beforeEach(async()=>{
 await resetDb();b=await seedBase();
 subject=await hireEmployee(adminCtx(b),{person:{fullName:'Fictional survivor subject',primaryEmail:`survivor-${randomUUID()}@fixture.test`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:add(todayInKualaLumpur(),-400)});
 const userId=await createAppUser(b.tenantId,subject.personId,'employee');employee={tenantId:b.tenantId,userId,personId:subject.personId,roles:['employee']};
 let monday=add(todayInKualaLumpur(),30);while(new Date(`${monday}T12:00:00Z`).getUTCDay()!==1)monday=add(monday,1);
 dates=Array.from({length:5},(_,index)=>add(monday,index));
});
afterAll(closeAll);
async function approved(options:{paid?:boolean;allowanceEligible?:boolean;importedHistory?:boolean;charged?:boolean;unpaidDays?:string}={}){
 const [type]=await owner.db.insert(s.leaveType).values({tenantId:b.tenantId,code:options.allowanceEligible===false?'MATERNITY':`SURV-${randomUUID().slice(0,8)}`,name:'Fictional survivor leave',paid:options.paid??true,counting:'working_days',employeeCancelApproved:true,cancelAutoApprove:true,cancelNoticeDays:0}).returning();
 const submittedOn=add(dates[0],-10),consentAt=new Date(`${submittedOn}T08:00:00Z`);
 // An already-approved application is the fixture input; the actual employee cancellation owner
 // performs every split, ledger operation and event below. No private split helper is called.
 const [request]=await owner.db.insert(s.leaveRequest).values({tenantId:b.tenantId,employmentId:subject.employmentId,leaveTypeId:type.id,startDate:dates[0],endDate:dates[4],days:'5.00',durationType:'full_day',status:'approved',reason:'Fictional approved reason',employeeRemark:'Original employee remark',allowanceEligible:options.allowanceEligible??null,unpaidConsentAt:consentAt,unpaidConsentBy:employee.userId,survivingChildren:5,confinementDate:dates[0],unpaidDays:options.unpaidDays??null,entitlementYear:Number(dates[0].slice(0,4))-1,submittedOn,importedHistory:options.importedHistory??false,externalReference:options.importedHistory?'LEGACY-SURVIVOR-ONE':null,decidedAt:new Date(`${submittedOn}T09:00:00Z`)}).returning();
 if(options.charged)await owner.db.insert(s.leaveLedger).values({tenantId:b.tenantId,employmentId:subject.employmentId,leaveTypeId:type.id,entryType:'debit',days:'-5.00',sourceRequestId:request.id,effectiveOn:dates[0]});
 return request;
}
const allRows=()=>owner.db.select().from(s.leaveRequest).where(eq(s.leaveRequest.employmentId,subject.employmentId)).orderBy(asc(s.leaveRequest.startDate),asc(s.leaveRequest.id));
const unpaid=async()=>Number((await unpaidLeaveDaysForPeriod(adminCtx(b),dates[0],dates[4])).get(subject.employmentId)??0);
function expectFacts(row:typeof s.leaveRequest.$inferSelect,original:typeof s.leaveRequest.$inferSelect){
 expect(row).toMatchObject({employeeRemark:original.employeeRemark,unpaidConsentAt:original.unpaidConsentAt,unpaidConsentBy:original.unpaidConsentBy,survivingChildren:original.survivingChildren,confinementDate:original.confinementDate,allowanceEligible:original.allowanceEligible,unpaidDays:original.unpaidDays,entitlementYear:original.entitlementYear,submittedOn:original.submittedOn,importedHistory:original.importedHistory,decidedAt:original.decidedAt});
}
it('retains a withheld allowance on a new survivor after the first date is cancelled',async()=>{
 const original=await approved({paid:true,allowanceEligible:false});
 expect(await unpaid()).toBe(5);
 const outcome=await requestLeaveCancellation(employee,{leaveRequestId:original.id,cancelDates:[dates[0]]});expect(outcome.status).toBe('approved');
 const rows=await allRows();expect(rows).toHaveLength(2);
 const survivor=rows.find(row=>row.status==='approved')!;expect(survivor.id).not.toBe(original.id);expectFacts(survivor,original);
 expect(survivor).toMatchObject({startDate:dates[1],endDate:dates[4],days:'4.00'});
 // On the old insert the new survivor loses allowanceEligible=false and contributes zero.
 expect(await unpaid()).toBe(4);
});
it('keeps uncharged imported history outside payroll through first and repeated cancellation, without cloning its reference',async()=>{
 const original=await approved({paid:false,importedHistory:true});expect(await unpaid()).toBe(0);
 await requestLeaveCancellation(employee,{leaveRequestId:original.id,cancelDates:[dates[0]]});
 const survivor=(await allRows()).find(row=>row.status==='approved')!;
 await requestLeaveCancellation(employee,{leaveRequestId:survivor.id,cancelDates:[dates[2]]});
 const rows=await allRows();expect(rows).toHaveLength(4);for(const row of rows)expectFacts(row,original);
 expect(rows.filter(row=>row.externalReference!==null).map(row=>({id:row.id,reference:row.externalReference}))).toEqual([{id:original.id,reference:original.externalReference}]);
 expect(rows.filter(row=>row.status==='approved').reduce((total,row)=>total+Number(row.days),0)).toBe(3);expect(await unpaid()).toBe(0);
 expect(await owner.db.select().from(s.leaveLedger).where(eq(s.leaveLedger.employmentId,subject.employmentId))).toEqual([]);
 const events=await owner.db.select().from(s.domainEvent).where(and(eq(s.domainEvent.tenantId,b.tenantId),eq(s.domainEvent.subjectEmploymentId,subject.employmentId),eq(s.domainEvent.eventType,'leave-request.split'))).orderBy(asc(s.domainEvent.id));
 expect(events).toHaveLength(3);expect(events.some(event=>(event.payload as {splitFromRequestId?:string}).splitFromRequestId===original.id)).toBe(true);expect(events.some(event=>(event.payload as {splitFromRequestId?:string}).splitFromRequestId===survivor.id)).toBe(true);
});
it('retains charged imported history while reducing only the cancelled approved day',async()=>{
 const original=await approved({paid:false,importedHistory:true,charged:true});expect(await unpaid()).toBe(5);
 await requestLeaveCancellation(employee,{leaveRequestId:original.id,cancelDates:[dates[2]]});
 const rows=await allRows();for(const row of rows)expectFacts(row,original);expect(await unpaid()).toBe(4);
 const ledger=await owner.db.select().from(s.leaveLedger).where(eq(s.leaveLedger.employmentId,subject.employmentId));expect(ledger.reduce((sum,row)=>sum+Number(row.days),0)).toBe(-4);
});
it('keeps mixed unpaid partial cancellation refused without changing the application',async()=>{
 const original=await approved({unpaidDays:'2.00'});const before=await allRows();
 await expect(requestLeaveCancellation(employee,{leaveRequestId:original.id,cancelDates:[dates[2]]})).rejects.toMatchObject({refusal:'unpaid_days'});
 expect(await allRows()).toEqual(before);
});
