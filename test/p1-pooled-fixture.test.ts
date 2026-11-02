import {beforeEach,afterAll,it,expect} from 'vitest';
import {eq} from 'drizzle-orm';
import {hireEmployee} from '../core/org';
import * as s from '../db/schema';
import {preparePooledFixture,clearPooledFixture} from '../scripts/lib/pooled-leave-fixture';
import {adminCtx,owner,resetDb,seedBase,closeAll} from './harness';
beforeEach(resetDb);afterAll(closeAll);
async function setup(){
 const base=await seedBase();
 const employee=await hireEmployee(adminCtx(base),{companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01',person:{fullName:'Fictional pool subject',primaryEmail:'pool@test.invalid'}});
 const types=await owner.db.insert(s.leaveType).values(['SICK','HOSPITALIZATION','MATERNITY'].map(code=>({tenantId:base.tenantId,code,name:code}))).returning();
 const pool=types.find(t=>t.code==='SICK')!,borrower=types.find(t=>t.code==='HOSPITALIZATION')!;
 await owner.db.update(s.leaveType).set({balanceSourceTypeId:base.annualLeaveTypeId}).where(eq(s.leaveType.id,borrower.id));
 await owner.db.insert(s.leaveLedger).values({tenantId:base.tenantId,employmentId:employee.employmentId,leaveTypeId:pool.id,entryType:'accrual',days:'14',effectiveOn:'2026-01-01'});
 const [foreign]=await owner.db.insert(s.leaveRequest).values({tenantId:base.tenantId,employmentId:employee.employmentId,leaveTypeId:pool.id,startDate:'2026-01-12',endDate:'2026-01-13',days:'1',status:'approved'}).returning();
 const [group]=await owner.db.insert(s.leaveSharedGroup).values({tenantId:base.tenantId,name:'Unowned group',totalLimitDays:'9'}).returning();
 return {base,employee,pool,borrower,foreign,group};
}
it('rerun and clear preserve an unowned same-date/type request and restore only the owned route preimage',async()=>{
 const f=await setup(),ledger=await owner.db.select().from(s.leaveLedger).orderBy(s.leaveLedger.id);
 const receipt=await owner.db.transaction(tx=>preparePooledFixture(tx,f.base.tenantId,'2026-12-31','source-fixture'));
 expect(receipt.requests).toHaveLength(1);expect(receipt.requests[0].id).not.toBe(f.foreign.id);
 const reused=await owner.db.transaction(tx=>preparePooledFixture(tx,f.base.tenantId,'2027-01-01','source-fixture',JSON.parse(JSON.stringify(receipt))));
 expect(reused.requests.map(r=>r.id)).toEqual(receipt.requests.map(r=>r.id));
 await owner.db.transaction(tx=>clearPooledFixture(tx,f.base.tenantId,JSON.parse(JSON.stringify(receipt))));
 expect(await owner.db.select().from(s.leaveRequest).where(eq(s.leaveRequest.id,f.foreign.id))).toEqual([f.foreign]);
 expect(await owner.db.select().from(s.leaveSharedGroup)).toEqual([f.group]);
 expect((await owner.db.select().from(s.leaveType).where(eq(s.leaveType.id,f.borrower.id)))[0].balanceSourceTypeId).toBe(f.base.annualLeaveTypeId);
 expect(await owner.db.select().from(s.leaveLedger)).toEqual(ledger);
});
it('changed owned rows refuse cleanup without touching either population',async()=>{
 const f=await setup(),receipt=await owner.db.transaction(tx=>preparePooledFixture(tx,f.base.tenantId,'2026-11-02','source'));
 await owner.db.update(s.leaveRequest).set({reason:'Actual browser edit must survive'}).where(eq(s.leaveRequest.id,receipt.requests[0].id));
 const before=await owner.db.select().from(s.leaveRequest).orderBy(s.leaveRequest.id);
 await expect(owner.db.transaction(tx=>clearPooledFixture(tx,f.base.tenantId,receipt))).rejects.toThrow('changed');
 expect(await owner.db.select().from(s.leaveRequest)).toEqual(before);
});
it('a late preparation failure rolls back groups, requests and borrowed routing together',async()=>{
 const f=await setup(),before={groups:await owner.db.select().from(s.leaveSharedGroup).orderBy(s.leaveSharedGroup.id),requests:await owner.db.select().from(s.leaveRequest).orderBy(s.leaveRequest.id),types:await owner.db.select().from(s.leaveType).orderBy(s.leaveType.id)};
 await expect(owner.db.transaction(async tx=>{const prepared=await preparePooledFixture(tx,f.base.tenantId,'2026-11-02','source');expect(prepared.requests).toHaveLength(1);throw Error('late fixture failure');})).rejects.toThrow('late fixture failure');
 expect({groups:await owner.db.select().from(s.leaveSharedGroup).orderBy(s.leaveSharedGroup.id),requests:await owner.db.select().from(s.leaveRequest).orderBy(s.leaveRequest.id),types:await owner.db.select().from(s.leaveType).orderBy(s.leaveType.id)}).toEqual(before);
});
