import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {and,eq} from 'drizzle-orm';
import * as s from '../db/schema';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {hireEmployee} from '../core/org';
import {compensationEffectiveOn,setCompensation} from '../core/comp';
import {createMovementEvent,editMovementEvent,movementHistory,reverseMovementEvent} from '../core/movement';
import {sweepDueMovements} from '../core/movement-apply';
import {todayInKualaLumpur} from '../lib/hr-date';
import {conflictingMovementFields} from '../lib/movement-sequence-conflict';
let b:Base,id:string;
const future=()=>new Date(Date.parse(todayInKualaLumpur()+'T00:00:00Z')+30*86400000).toISOString().slice(0,10);
beforeAll(migrateTestDb);
beforeEach(async()=>{
 await resetDb();b=await seedBase();const ctx=adminCtx(b);
 id=(await hireEmployee(ctx,{person:{fullName:'Fictional Event Order',primaryEmail:'event-order@example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-01-01'})).employmentId;
 await setCompensation(ctx,{employmentId:id,basicSalary:3000,effectiveFrom:'2026-01-01'});
});
afterAll(closeAll);
describe('explicit resolution of conflicting event dates',()=>{
 it('allows independent same-day fields and refuses a silent second salary decision',async()=>{
  const ctx=adminCtx(b);
  await createMovementEvent(ctx,{employmentId:id,kind:'transfer',effectiveDate:'2026-02-01',departmentId:b.deptB});
  await createMovementEvent(ctx,{employmentId:id,kind:'increment',effectiveDate:'2026-02-01',basicSalary:3500});
  const before=await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.subjectEmploymentId,id)).orderBy(s.domainEvent.sequence);
  await expect(createMovementEvent(ctx,{employmentId:id,kind:'increment',effectiveDate:'2026-02-01',basicSalary:3600})).rejects.toThrow(/resolve the order before saving/);
  expect(await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.subjectEmploymentId,id)).orderBy(s.domainEvent.sequence)).toEqual(before);
  const selected=(await movementHistory(ctx,id)).find(row=>row.kind==='increment')!;
  await editMovementEvent(ctx,{employmentId:id,movementId:selected.id,kind:'increment',effectiveDate:'2026-02-01',basicSalary:3600,reason:'Fictional explicit replacement'});
  expect((await movementHistory(ctx,id)).find(row=>row.id===selected.id)?.reversed).toBeTruthy();
 });
 it('blocks conflicting pending events before saving a second intent',async()=>{
  const ctx=adminCtx(b),effectiveDate=future();
  await createMovementEvent(ctx,{employmentId:id,kind:'increment',effectiveDate,basicSalary:3500});
  await expect(createMovementEvent(ctx,{employmentId:id,kind:'salaryAdjustment',effectiveDate,basicSalary:3600})).rejects.toThrow(/cancel the conflicting pending event/);
  expect((await movementHistory(ctx,id)).filter(row=>row.status==='pending')).toHaveLength(1);
 });
 it('flags legacy conflicting intents, applies neither, and allows an authorized cancellation to resolve them',async()=>{
  const ctx=adminCtx(b),effectiveDate=future();
  await createMovementEvent(ctx,{employmentId:id,kind:'increment',effectiveDate,basicSalary:3500});
  const first=(await movementHistory(ctx,id)).find(row=>row.kind==='increment')!;
  // Existing installation evidence from the old last-keyed-wins behavior, not a new public write path.
  await owner.db.insert(s.domainEvent).values({tenantId:b.tenantId,aggregateType:'employment',aggregateId:id,eventType:'employment.movement.scheduled',actorType:'user',actorId:b.adminUserId,subjectEmploymentId:id,
   payload:{type:'increment',effectiveDate,endDate:null,remarks:'Fictional legacy conflict',fields:['basicSalary'],input:{basicSalary:3600},movement:{type:'increment',groupId:randomUUID(),effectiveDate}}});
  const rows=(await movementHistory(ctx,id)).filter(row=>row.kind==='increment');expect(rows.every(row=>row.orderConflict)).toBe(true);
  expect(rows.find(row=>row.id===first.id)?.canReverse).toBe(true);
  expect(await sweepDueMovements(ctx,{today:effectiveDate})).toMatchObject({applied:0,failed:1});
  await reverseMovementEvent(ctx,{employmentId:id,movementId:first.id,reason:'Fictional duplicate intent cancelled'});
  expect(await sweepDueMovements(ctx,{today:effectiveDate})).toMatchObject({applied:1,failed:0});
  const [terms]=await owner.db.select({amount:s.compensation.basicSalary}).from(s.compensation).where(and(eq(s.compensation.employmentId,id),compensationEffectiveOn(effectiveDate)));expect(terms.amount).toBe('3600.00');
 });
 it('treats company and contract-type dependencies as ordering conflicts',()=>{
  expect(conflictingMovementFields(['companyId'],['departmentId'])).toEqual(['companyId']);
  expect(conflictingMovementFields(['employmentType'],['contractEndDate'])).toEqual(['employmentType']);
  expect(conflictingMovementFields(['gradeId'],['basicSalary'])).toEqual([]);
 });
});
