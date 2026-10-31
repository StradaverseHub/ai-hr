import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import type {SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,harnessSnapshot,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base,CALLER:SessionContext;
vi.mock('../lib/session',()=>({getSession:async()=>CALLER}));
vi.mock('next/cache',()=>({revalidatePath:vi.fn(),revalidateTag:vi.fn()}));
vi.mock('next/navigation',()=>({redirect:(href:string)=>{throw Object.assign(new Error('Redirect'),{href});}}));
vi.mock('next-intl/server',()=>({getLocale:async()=>'en',getTranslations:async()=>(key:string)=>key}));
const {requestLeaveAction,leaveApplySummaryAction}=await import('../app/(app)/leave/actions');
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();});
const today=()=>todayInKualaLumpur(),add=(n:number)=>new Date(Date.parse(today()+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);
async function fixture(){
 const first=await hireEmployee(adminCtx(b),{person:{fullName:'Fictional selected applicant',primaryEmail:randomUUID()+'@example.test'},
  companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:String(Number(today().slice(0,4))-1)+'-01-01'});
 CALLER={tenantId:b.tenantId,userId:await createAppUser(b.tenantId,first.personId,'employee'),personId:first.personId,roles:['employee'],entitlements:harnessSnapshot(b.tenantId)};
 const [company]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional selected employer'}).returning();
 const [department]=await owner.db.insert(s.department).values({tenantId:b.tenantId,companyId:company.id,name:'Fictional selected department'}).returning();
 const second=await hireEmployee(adminCtx(b),{person:{id:first.personId},companyId:company.id,departmentId:department.id,employmentType:'full_time',hiredOn:today()});
 const [type]=await owner.db.insert(s.leaveType).values({tenantId:b.tenantId,name:'Fictional selected leave',code:'HOME_'+randomUUID().slice(0,7).toUpperCase(),counting:'calendar_days',paid:true,visibleToEmployee:true}).returning();
 for(const employmentId of [first.employmentId,second.employmentId])await owner.db.insert(s.leaveLedger).values({tenantId:b.tenantId,employmentId,leaveTypeId:type.id,entryType:'accrual',days:'20.00',effectiveOn:today().slice(0,4)+'-01-01'});
 const form=new FormData();for(const [key,value] of Object.entries({employmentId:second.employmentId,leaveTypeId:type.id,startDate:add(1),endDate:add(2),durationType:'full_day'}))form.set(key,value);
 return {first,second,type,form};
}
describe('Home selected employment continues through the existing leave application',()=>{
 it('submits and returns to the selected second own employment rather than the first',async()=>{
  const {first,second,form}=await fixture();
  await expect(requestLeaveAction(form)).rejects.toMatchObject({href:expect.stringContaining('employmentId='+second.employmentId)});
  const selected=await owner.db.select().from(s.leaveRequest).where(eq(s.leaveRequest.employmentId,second.employmentId));
  expect(selected).toHaveLength(1);expect(selected[0]).toMatchObject({startDate:add(1),endDate:add(2),status:'pending'});
  expect(await owner.db.select().from(s.leaveRequest).where(eq(s.leaveRequest.employmentId,first.employmentId))).toEqual([]);
 });
 it('keeps the second own employment subject to the same hidden-figure settings',async()=>{
  const {first,second,type}=await fixture();
  await owner.db.update(s.leaveType).set({essViewConfig:{available:false,pendingApproval:false,taken:false}}).where(eq(s.leaveType.id,type.id));
  for(const employmentId of [first.employmentId,second.employmentId])expect(await leaveApplySummaryAction({employmentId,leaveTypeId:type.id})).toMatchObject({available:null,balance:null,pending:null,taken:null});
 });
 it('refuses duplicate subject fields before making a request',async()=>{
  const {first,form}=await fixture();form.append('employmentId',first.employmentId);
  await expect(requestLeaveAction(form)).rejects.toMatchObject({href:expect.stringContaining('error=')});
  expect(await owner.db.select().from(s.leaveRequest)).toEqual([]);
 });
});
