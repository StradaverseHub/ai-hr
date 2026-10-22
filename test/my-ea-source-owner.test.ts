/** Source-eligibility fixtures only: these rows are not a payroll calculation or a PDF parity witness. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {eq} from 'drizzle-orm';
import {type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {myEaSources,myEaStatement} from '../core/reporting';
import {myPayslipDetail} from '../packs/payroll/service';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,createAppUser,migrateTestDb,closeAll,resetDb,seedBase,owner,type Base} from './harness';
let base:Base;
const year=()=>todayInKualaLumpur().slice(0,4);
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();base=await seedBase();});
async function own(role:'employee'|'hr_admin'='employee') {
 const hired=await hireEmployee(adminCtx(base),{person:{fullName:'Fictional EA metadata employee',primaryEmail:`${randomUUID()}@example.invalid`},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:`${Number(year())-2}-01-01`});
 const userId=await createAppUser(base.tenantId,hired.personId,role),ctx:SessionContext={...adminCtx(base),userId,personId:hired.personId,roles:[role],grants:[{role,companyId:base.companyId}]};return{...hired,ctx};
}
async function source(employee:Awaited<ReturnType<typeof own>>,period:string,status:'draft'|'processed'|'closed'='closed',releasedAt:Date|null=null,companyId=base.companyId) {
 const [parent]=await owner.db.insert(schema.payPeriod).values({tenantId:base.tenantId,companyId,period}).returning();
 const [batch]=await owner.db.insert(schema.payrollBatch).values({tenantId:base.tenantId,companyId,payPeriodId:parent.id,payPeriod:period,batchDate:todayInKualaLumpur(),status,releasedAt}).returning();
 const [slip]=await owner.db.insert(schema.payslip).values({tenantId:base.tenantId,batchId:batch.id,employmentId:employee.employmentId,basicSalary:'100.00',grossPay:'100.00',statutory:{},totalDeductions:'0.00',netPay:'100.00',employerCost:'100.00'}).returning();return{parent,batch,slip};
}
describe('Mine EA sees whole-year eligibility metadata beyond the canonical released-payslip read',()=>{
 it('requires actual evidence and retains historical years with legacy-null release compatibility',async()=>{const e=await own();expect(await myEaSources(e.ctx)).toEqual([]);await source(e,`${Number(year())-1}-01`);await source(e,`${year()}-01`,'closed',new Date(Date.now()-60_000));const rows=await myEaSources(e.ctx);expect(rows.map(row=>[row.year,row.available,row.employmentId,row.companyId])).toEqual([[year(),true,e.employmentId,base.companyId],[String(Number(year())-1),true,e.employmentId,base.companyId]]);});
 it.each(['draft','processed'] as const)('withholds the entire own year when a %s source is hidden from the canonical payslip read',async(status)=>{const e=await own();const released=await source(e,`${year()}-01`),hidden=await source(e,`${year()}-02`,status);expect(await myPayslipDetail(e.ctx,released.slip.id)).not.toBeNull();expect(await myPayslipDetail(e.ctx,hidden.slip.id)).toBeNull();expect(await myEaSources(e.ctx)).toEqual([expect.objectContaining({year:year(),available:false})]);expect(await myEaStatement(e.ctx,{employmentId:e.employmentId,companyId:base.companyId,year:year()})).toBeNull();});
 it('withholds future release and rechecks availability for the same selection after a late payroll source',async()=>{const e=await own();await source(e,`${year()}-01`);expect((await myEaSources(e.ctx))[0].available).toBe(true);await source(e,`${year()}-02`,'closed',new Date(Date.now()+86_400_000));expect((await myEaSources(e.ctx))[0].available).toBe(false);expect(await myEaStatement(e.ctx,{employmentId:e.employmentId,year:year(),companyId:base.companyId})).toBeNull();});
 it.each([()=>`${year()}-xx`,()=>year(),()=>`${year()}garbled`,()=>`not-a-period`])('does not offer a partial year after an attributable or unassignable malformed source',async(bad)=>{const e=await own();await source(e,`${year()}-01`);await source(e,bad());expect((await myEaSources(e.ctx)).find(row=>row.year===year())?.available).toBe(false);expect(await myEaStatement(e.ctx,{employmentId:e.employmentId,companyId:base.companyId,year:year()})).toBeNull();});
 it('keeps separate own employments and paying employers without pooling their availability',async()=>{const e=await own();const [company]=await owner.db.insert(schema.company).values({tenantId:base.tenantId,legalName:'Fictional second paying employer',country:'MY'}).returning();const [department]=await owner.db.insert(schema.department).values({tenantId:base.tenantId,companyId:company.id,name:'Fictional second department'}).returning();const second=await hireEmployee(adminCtx(base),{person:{id:e.personId},companyId:company.id,departmentId:department.id,employmentType:'full_time',hiredOn:`${Number(year())-1}-01-01`});await source(e,`${year()}-01`);await source({...second,ctx:e.ctx},`${year()}-01`,'draft',null,company.id);const rows=await myEaSources(e.ctx);expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({employmentId:e.employmentId,companyId:base.companyId,available:true}),expect.objectContaining({employmentId:second.employmentId,companyId:company.id,available:false})]));});
 it('keeps the Mine boundary even for payroll staff and refuses foreign or substituted identities',async()=>{const e=await own('hr_admin'),other=await own();await source(e,`${year()}-01`);await source(other,`${year()}-02`);expect((await myEaSources(e.ctx)).map(row=>row.employmentId)).toEqual([e.employmentId]);expect(await myEaSources({...e.ctx,personId:other.personId})).toEqual([]);expect(await myEaStatement(e.ctx,{employmentId:other.employmentId,companyId:base.companyId,year:year()})).toBeNull();expect(await myEaStatement(e.ctx,{employmentId:e.employmentId,companyId:other.employmentId,year:year()})).toBeNull();await owner.db.update(schema.appUser).set({archivedAt:new Date()}).where(eq(schema.appUser.id,e.ctx.userId!));expect(await myEaSources(e.ctx)).toEqual([]);});
});
