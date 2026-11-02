/** ADR-0169 phase B: the Assistant's approval-queue read over the canonical inbox, minimized to counts. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import type {SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee,setReportingLine} from '../core/org';
import {requestLeave,decideLeave} from '../packs/leave/service';
import {listPendingTasks} from '../core/approvals-inbox';
import {approvalQueueFor} from '../core/product-context/approval-queue';
import {runContextTool} from '../core/product-context/tools';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,harnessSnapshot,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();});
const add=(date:string,days:number)=>new Date(Date.parse(date+'T12:00:00Z')+days*86400000).toISOString().slice(0,10);
const NAMES=['Fictional Queue Requester','Fictional Queue Manager'];
async function worker(name:string){
 const hired=await hireEmployee(adminCtx(b),{person:{fullName:name,primaryEmail:randomUUID()+'@example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
 const ctx:SessionContext={tenantId:b.tenantId,userId:await createAppUser(b.tenantId,hired.personId,'employee'),personId:hired.personId,roles:['employee'],entitlements:harnessSnapshot(b.tenantId)};
 return {...hired,ctx};
}
async function pendingLeave(){
 const employee=await worker(NAMES[0]),manager=await worker(NAMES[1]);
 await setReportingLine(adminCtx(b),{subordinateEmploymentId:employee.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:todayInKualaLumpur()});
 await owner.db.insert(s.leaveLedger).values({tenantId:b.tenantId,employmentId:employee.employmentId,leaveTypeId:b.annualLeaveTypeId,entryType:'accrual',days:'20.00',effectiveOn:todayInKualaLumpur().slice(0,4)+'-01-01'});
 let date=add(todayInKualaLumpur(),3);while([0,6].includes(new Date(date+'T12:00:00Z').getUTCDay()))date=add(date,1);
 const request=await requestLeave(employee.ctx,{employmentId:employee.employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:date,endDate:date});
 return {employee,manager,request};
}
describe('Assistant approval queue (counts only)',()=>{
 it('counts the work actually assigned to the person, with the queue page and review action, and no names or ids',async()=>{
  const {employee,manager,request}=await pendingLeave();
  const canonical=await listPendingTasks(manager.ctx,[b.companyId],{attendance:false,claims:false,performance:false,rewards:false},{noticeAcknowledgements:false});
  expect(canonical.map(row=>row.kind)).toEqual(['leave']);
  const summary=await approvalQueueFor(manager.ctx,b.companyId);
  expect(summary.total).toBe(1);expect(summary.groups).toHaveLength(1);
  expect(summary.groups[0]).toMatchObject({kind:'leave',count:1,reviewAction:'approvals.leave.decide'});
  expect(summary.groups[0].href).toMatch(/^\/approvals(\?category=[a-z_-]+)?$/);
  const body=JSON.stringify(summary);for(const name of NAMES)expect(body.includes(name),name).toBe(false);expect(body.includes(request.leaveRequestId)).toBe(false);
  // The requester's own request is not their work.
  expect(await approvalQueueFor(employee.ctx,b.companyId)).toEqual({total:0,groups:[]});
  const tool=await runContextTool(manager.ctx,'approval_queue',{},{companyId:b.companyId,locale:'en'});
  expect(tool).toEqual({ok:true,content:summary});
  await decideLeave(manager.ctx,{leaveRequestId:request.leaveRequestId,decision:'approved'});
  expect(await approvalQueueFor(manager.ctx,b.companyId)).toEqual({total:0,groups:[]});
 });
});
