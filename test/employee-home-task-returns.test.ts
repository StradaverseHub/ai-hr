import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import type {SessionContext} from '../db/client';
import {adminCtx,closeAll,createAppUser,harnessSnapshot,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import * as s from '../db/schema';
import {hireEmployee,setReportingLine} from '../core/org';
import {requestLeave,setLeaveApprovalPolicy} from '../packs/leave/service';
import {todayInKualaLumpur} from '../lib/hr-date';
const session=vi.hoisted(()=>({current:null as SessionContext|null,companyId:''}));
class DecisionRedirect extends Error{constructor(readonly url:string){super('Fictional Next redirect');}}
vi.mock('next/navigation',()=>({redirect:(url:string)=>{throw new DecisionRedirect(url);}}));
vi.mock('next/cache',()=>({revalidatePath:vi.fn()}));
vi.mock('next-intl/server',()=>({getTranslations:async()=>(key:string)=>key}));
vi.mock('../lib/session',()=>({getSession:async()=>session.current!}));
vi.mock('../lib/scope',()=>({scopedSession:async()=>({s:session.current!,scopeIds:[session.companyId],allowedCount:1})}));
vi.mock('../app/(app)/me/actions',()=>({localizeLeaveError:async()=> 'Fictional safe failure'}));
import {approveLeaveAction} from '../app/(app)/approvals/actions';
let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();session.companyId=b.companyId;session.current=null;});
const add=(date:string,days:number)=>new Date(Date.parse(date+'T12:00:00Z')+days*86400000).toISOString().slice(0,10);
async function fixture(){
 const hired=[];
 for(const fullName of ['Fictional action subject','Fictional action manager'])hired.push(await hireEmployee(adminCtx(b),{person:{fullName,primaryEmail:randomUUID()+'@example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()}));
 const [employee,manager]=hired;
 await setReportingLine(adminCtx(b),{subordinateEmploymentId:employee.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:todayInKualaLumpur()});
 const userId=await createAppUser(b.tenantId,manager.personId,'employee');
 session.current={tenantId:b.tenantId,userId,personId:manager.personId,roles:['employee'],entitlements:harnessSnapshot(b.tenantId)};
 await owner.db.insert(s.leaveLedger).values({tenantId:b.tenantId,employmentId:employee.employmentId,leaveTypeId:b.annualLeaveTypeId,entryType:'accrual',days:'20.00',effectiveOn:todayInKualaLumpur().slice(0,4)+'-01-01'});
 // This case exercises a final workflow decision. The shipped fallback has a subsequent HR step.
 await setLeaveApprovalPolicy(adminCtx(b),{companyId:b.companyId,levels:['direct_manager']});
 let date=add(todayInKualaLumpur(),3);while([0,6].includes(new Date(date+'T12:00:00Z').getUTCDay()))date=add(date,1);
 const request=await requestLeave(adminCtx(b),{employmentId:employee.employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:date,endDate:date});
 const form=new FormData();form.set('id',request.leaveRequestId);form.set('decision','approved');form.set('category','leave');form.set('sort','oldest');
 return {employee,manager,date,request,form};
}
describe('assigned Employee-role decision feedback',()=>{
 it('keeps confirmation on Home after the final real decision removes inbox admission',async()=>{
  const f=await fixture();
  await expect(approveLeaveAction(f.form)).rejects.toMatchObject({url:'/?toast=Leave+approved'});
  expect((await owner.db.select().from(s.leaveRequest).where(eq(s.leaveRequest.id,f.request.leaveRequestId)))[0].status).toBe('approved');
 });
 it('preserves the filtered inbox and confirmation while another actual assignment remains',async()=>{
  const f=await fixture();let date=add(f.date,1);while([0,6].includes(new Date(date+'T12:00:00Z').getUTCDay()))date=add(date,1);
  const other=await requestLeave(adminCtx(b),{employmentId:f.employee.employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:date,endDate:date});
  await expect(approveLeaveAction(f.form)).rejects.toMatchObject({url:'/approvals?category=leave&sort=oldest&toast=Leave+approved'});
  expect((await owner.db.select().from(s.leaveRequest).where(eq(s.leaveRequest.id,other.leaveRequestId)))[0].status).toBe('pending');
 });
 it('keeps an administrator on the inbox after completing the same canonical workflow',async()=>{
  const f=await fixture();session.current=adminCtx(b);
  await expect(approveLeaveAction(f.form)).rejects.toMatchObject({url:'/approvals?category=leave&sort=oldest&toast=Leave+approved'});
 });
});
