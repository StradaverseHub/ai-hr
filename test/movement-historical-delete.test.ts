import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {and,eq,isNull} from 'drizzle-orm';
import * as s from '../db/schema';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {createMovementEvent,editMovementEvent,movementCurrentState,movementHistory,reverseMovementEvent} from '../core/movement';
let b:Base,id:string;
beforeAll(migrateTestDb);
beforeEach(async()=>{
 await resetDb();b=await seedBase();const ctx=adminCtx(b);
 id=(await hireEmployee(ctx,{person:{fullName:'Fictional Historical Delete',primaryEmail:'historical-delete@example.test'},companyId:b.companyId,departmentId:b.deptA,positionId:b.positionId,employmentType:'full_time',hiredOn:'2026-01-01'})).employmentId;
 await setCompensation(ctx,{employmentId:id,basicSalary:3000,effectiveFrom:'2026-01-01'});
});
afterAll(closeAll);
async function live(kind:string){return (await movementHistory(adminCtx(b),id)).find(row=>row.kind===kind&&!row.reversed)!;}
describe('historical event deletion and effective-order replay',()=>{
 it('corrects and deletes earlier placement without reversing an independent blacklist override',async()=>{
  const ctx=adminCtx(b);
  const [correctedDepartment]=await owner.db.insert(s.department).values({tenantId:b.tenantId,companyId:b.companyId,name:'Fictional Corrected Earlier Department'}).returning();
  await createMovementEvent(ctx,{employmentId:id,kind:'transfer',effectiveDate:'2026-02-01',departmentId:b.deptB});
  const original=await live('transfer');
  await createMovementEvent(ctx,{employmentId:id,kind:'blacklist',blacklisted:true,remarks:'Fictional independent access restriction'});
  const restriction=await live('blacklist');
  const [before]=await owner.db.select({blacklistedAt:s.employment.blacklistedAt}).from(s.employment).where(eq(s.employment.id,id));
  expect(before.blacklistedAt).not.toBeNull();
  await editMovementEvent(ctx,{employmentId:id,movementId:original.id,kind:'transfer',effectiveDate:'2026-02-01',departmentId:correctedDepartment.id,remarks:'Fictional corrected earlier placement',reason:'Fictional earlier correction'});
  const corrected=await live('transfer');
  expect((await movementCurrentState(ctx,id)).departmentId).toBe(correctedDepartment.id);
  await reverseMovementEvent(ctx,{employmentId:id,movementId:corrected.id,reason:'Fictional earlier placement removed'});
  expect((await movementHistory(ctx,id)).find(row=>row.id===restriction.id)?.reversed).toBeNull();
  expect((await owner.db.select({blacklistedAt:s.employment.blacklistedAt}).from(s.employment).where(eq(s.employment.id,id)))[0]).toEqual(before);
 });

 it('deletes an earlier placement decision while retaining the later explicit salary decision',async()=>{
  const ctx=adminCtx(b);
  await createMovementEvent(ctx,{employmentId:id,kind:'transfer',effectiveDate:'2026-02-01',departmentId:b.deptB});
  const original=await live('transfer');
  await createMovementEvent(ctx,{employmentId:id,kind:'increment',effectiveDate:'2026-03-01',basicSalary:4000});
  const later=await live('increment');
  await reverseMovementEvent(ctx,{employmentId:id,movementId:original.id,reason:'Fictional earlier decision removed'});
  expect(await movementCurrentState(ctx,id)).toMatchObject({departmentId:b.deptA,basicSalary:'4000.00'});
  expect((await movementHistory(ctx,id)).find(row=>row.id===original.id)?.reversed).toMatchObject({corrected:false,reason:'Fictional earlier decision removed'});
  expect((await movementHistory(ctx,id)).find(row=>row.id===later.id)?.reversed).toMatchObject({corrected:true});
  expect(await live('increment')).toMatchObject({effectiveDate:'2026-03-01'});
  expect(await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.id,original.id))).toHaveLength(1);
 });
 it('replays an Entity Transfer after an earlier correction and carries only inherited placement values',async()=>{
  const ctx=adminCtx(b);
  const [beta]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional Beta',companyLabel:'BETA'}).returning();
  await owner.db.insert(s.labelCompanyAssignment).values([b.deptA,b.deptB].map(labelId=>({tenantId:b.tenantId,labelKind:'department' as const,labelId,companyId:beta.id})));
  await owner.db.insert(s.labelCompanyAssignment).values({tenantId:b.tenantId,labelKind:'position',labelId:b.positionId,companyId:beta.id});
  await createMovementEvent(ctx,{employmentId:id,kind:'transfer',effectiveDate:'2026-02-01',departmentId:b.deptB});
  const original=await live('transfer');
  await createMovementEvent(ctx,{employmentId:id,kind:'entityTransfer',effectiveDate:'2026-03-01',companyId:beta.id});
  await reverseMovementEvent(ctx,{employmentId:id,movementId:original.id,reason:'Fictional original placement removed'});
  expect(await movementCurrentState(ctx,id)).toMatchObject({companyId:beta.id,departmentId:b.deptA});
  const timeline=await owner.db.select({companyId:s.assignment.companyId,departmentId:s.assignment.departmentId,from:s.assignment.validFrom,to:s.assignment.validTo}).from(s.assignment).where(and(eq(s.assignment.employmentId,id),isNull(s.assignment.supersededAt)));
  expect(timeline).toEqual(expect.arrayContaining([{companyId:b.companyId,departmentId:b.deptA,from:'2026-01-01',to:'2026-03-01'},{companyId:beta.id,departmentId:b.deptA,from:'2026-03-01',to:null}]));
 });
 it('keeps an earlier salary editable across a later Entity Transfer',async()=>{
  const ctx=adminCtx(b),[beta]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional Second Company'}).returning();
  await owner.db.insert(s.labelCompanyAssignment).values([{tenantId:b.tenantId,labelKind:'department',labelId:b.deptA,companyId:beta.id},{tenantId:b.tenantId,labelKind:'position',labelId:b.positionId,companyId:beta.id}]);
  await createMovementEvent(ctx,{employmentId:id,kind:'increment',effectiveDate:'2026-02-01',basicSalary:3500});const original=await live('increment');
  await createMovementEvent(ctx,{employmentId:id,kind:'entityTransfer',effectiveDate:'2026-03-01',companyId:beta.id});
  await editMovementEvent(ctx,{employmentId:id,movementId:original.id,kind:'increment',effectiveDate:'2026-02-01',basicSalary:3600,reason:'Fictional corrected amount'});
  expect(await movementCurrentState(ctx,id)).toMatchObject({companyId:beta.id,basicSalary:'3600.00'});
 });
});
