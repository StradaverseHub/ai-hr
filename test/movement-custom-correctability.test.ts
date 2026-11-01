import {randomUUID} from 'node:crypto';
import {and,asc,eq} from 'drizzle-orm';
import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest';
import {assignment,domainEvent,employment,movementEventType} from '../db/schema';
import {hireEmployee} from '../core/org';
import {createDepartment} from '../core/admin';
import {createMovementEvent,editMovementEvent,reverseMovementEvent,movementHistory,movementCurrentState,MovementNoChangeError,MovementNotCorrectableError} from '../core/movement';
import {saveMovementEventType,setMovementEventTypeActive} from '../core/movement-type';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

let b:Base;
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();});afterAll(closeAll);
const day=(offset:number)=>new Date(Date.parse(todayInKualaLumpur()+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10);
const hire=()=>hireEmployee(adminCtx(b),{person:{fullName:'Fictional custom correction',primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:day(-30)});
const state=async(id:string)=>({
 employment:await owner.db.select().from(employment).where(eq(employment.id,id)).orderBy(asc(employment.id)),
 assignments:await owner.db.select().from(assignment).where(eq(assignment.employmentId,id)).orderBy(asc(assignment.id)),
 events:await owner.db.select().from(domainEvent).where(eq(domainEvent.subjectEmploymentId,id)).orderBy(asc(domainEvent.sequence)),
});
describe('custom Movement correction uses canonical behavior and retains recorded code identity',()=>{
 it('edits and reverses the latest inactive custom comparison without relabelling history or accepting an unchanged replay',async()=>{
  const e=await hire(),ctx=adminCtx(b),type=await saveMovementEventType(ctx,{label:'Fictional career promotion',behaviourKind:'promotion'});
  const third=await createDepartment(ctx,{companyId:b.companyId,name:'Fictional correction destination'});
  await createMovementEvent(ctx,{employmentId:e.employmentId,kind:type.code,effectiveDate:day(-2),departmentId:b.deptB});
  await setMovementEventTypeActive(ctx,{code:type.code,active:false});
  const original=(await movementHistory(ctx,e.employmentId)).find(row=>row.kind===type.code)!;
  expect(original).toMatchObject({status:'applied',canEdit:true,canReverse:true});
  const before=await state(e.employmentId);
  await expect(editMovementEvent(ctx,{employmentId:e.employmentId,movementId:original.id,kind:type.code,effectiveDate:day(-2),departmentId:b.deptB,reason:'Fictional unchanged correction'})).rejects.toBeInstanceOf(MovementNoChangeError);
  expect(await state(e.employmentId)).toEqual(before);
  expect((await editMovementEvent(ctx,{employmentId:e.employmentId,movementId:original.id,kind:type.code,effectiveDate:day(-2),departmentId:third.id,reason:'Fictional corrected destination'})).behaviourKind).toBe('promotion');
  const history=await movementHistory(ctx,e.employmentId),live=history.filter(row=>row.kind===type.code&&row.status==='applied');
  expect(history.find(row=>row.id===original.id)?.status).toBe('reversed');expect(live).toHaveLength(1);
  expect((await movementCurrentState(ctx,e.employmentId)).departmentId).toBe(third.id);
  await reverseMovementEvent(ctx,{employmentId:e.employmentId,movementId:live[0].id,reason:'Fictional final rollback'});
  expect((await movementCurrentState(ctx,e.employmentId)).departmentId).toBe(b.deptA);
  expect((await movementHistory(ctx,e.employmentId)).find(row=>row.id===live[0].id)).toMatchObject({kind:type.code,status:'reversed'});
 });
 it('646355e5 — an older custom comparison edit that changes nothing is refused without writing',async()=>{
  const e=await hire(),ctx=adminCtx(b),type=await saveMovementEventType(ctx,{label:'Fictional older promotion',behaviourKind:'promotion'});
  await createMovementEvent(ctx,{employmentId:e.employmentId,kind:type.code,effectiveDate:day(-2),departmentId:b.deptB});
  const original=(await movementHistory(ctx,e.employmentId)).find(row=>row.kind===type.code)!;
  await createMovementEvent(ctx,{employmentId:e.employmentId,kind:'transfer',effectiveDate:day(-1),departmentId:b.deptA});
  expect((await movementHistory(ctx,e.employmentId)).find(row=>row.id===original.id)?.canEdit).toBe(true);
  const before=await state(e.employmentId);
  await expect(editMovementEvent(ctx,{employmentId:e.employmentId,movementId:original.id,kind:type.code,effectiveDate:day(-2),remarks:'Fictional older correction',reason:'Fictional refusal'})).rejects.toThrow(/leave nothing changed/);
  expect(await state(e.employmentId)).toEqual(before);
 });
 it('preserves ordinary record-only custom correction and its exact catalogue code',async()=>{
  const e=await hire(),ctx=adminCtx(b),type=await saveMovementEventType(ctx,{label:'Fictional temporary assignment',behaviourKind:'secondment'});
  await createMovementEvent(ctx,{employmentId:e.employmentId,kind:type.code,effectiveDate:day(-2),remarks:'Original fictional assignment'});
  const original=(await movementHistory(ctx,e.employmentId)).find(row=>row.kind===type.code)!;
  expect(original).toMatchObject({canEdit:true,canReverse:true});
  expect((await editMovementEvent(ctx,{employmentId:e.employmentId,movementId:original.id,kind:type.code,effectiveDate:day(-1),remarks:'Corrected fictional assignment',reason:'Fictional date correction'})).behaviourKind).toBe('secondment');
  const history=await movementHistory(ctx,e.employmentId),live=history.filter(row=>row.kind===type.code&&row.status==='applied');
  expect(history.find(row=>row.id===original.id)?.status).toBe('reversed');expect(live).toEqual([expect.objectContaining({kind:type.code,effectiveDate:day(-1),remarks:'Corrected fictional assignment'})]);
  await reverseMovementEvent(ctx,{employmentId:e.employmentId,movementId:live[0].id,reason:'Fictional record rollback'});
  expect((await movementCurrentState(ctx,e.employmentId)).departmentId).toBe(b.deptA);
 });
 // 1d58019a Step 2 (ADR-0166) — Termination is a configurable custom behaviour now, so the corrupt-mapping case
 // uses a lifecycle kind that is still out of reach; the re-pointed-to-Termination case is pinned separately below.
 it.each(['not_a_builtin','probationExtension'])('renders existing history but grants no correction authority for corrupt custom behavior %s',async behaviourKind=>{
  const e=await hire(),ctx=adminCtx(b),type=await saveMovementEventType(ctx,{label:'Fictional corrupt reference',behaviourKind:'secondment'});
  await createMovementEvent(ctx,{employmentId:e.employmentId,kind:type.code,effectiveDate:day(-2)});
  // Malformed fixture only: exercise canonical read-side refusal rather than weakening type writes.
  await owner.db.update(movementEventType).set({behaviourKind}).where(and(eq(movementEventType.tenantId,b.tenantId),eq(movementEventType.code,type.code)));
  const history=await movementHistory(ctx,e.employmentId),row=history.find(item=>item.kind===type.code)!;
  expect(history.some(item=>item.kind==='hired')).toBe(true);expect(row).toMatchObject({kind:type.code,canEdit:false,canReverse:false});
  const before=await state(e.employmentId);
  await expect(editMovementEvent(ctx,{employmentId:e.employmentId,movementId:row.id,kind:type.code,effectiveDate:day(-1),reason:'Fictional corrupt correction'})).rejects.toThrow('Unknown movement event type');
  await expect(reverseMovementEvent(ctx,{employmentId:e.employmentId,movementId:row.id,reason:'Fictional corrupt rollback'})).rejects.toBeInstanceOf(MovementNotCorrectableError);
  expect(await state(e.employmentId)).toEqual(before);
 });
 it('grants no correction authority to a recorded custom movement re-pointed to Termination around the service',async()=>{
  const e=await hire(),ctx=adminCtx(b),type=await saveMovementEventType(ctx,{label:'Fictional repointed reference',behaviourKind:'secondment'});
  await createMovementEvent(ctx,{employmentId:e.employmentId,kind:type.code,effectiveDate:day(-2)});
  // The service refuses this re-point once the type is used (1d58019a Step 2); the fixture writes around it.
  await expect(saveMovementEventType(ctx,{code:type.code,label:'Fictional repointed reference',behaviourKind:'termination'})).rejects.toThrow(/already used by recorded movements/i);
  await owner.db.update(movementEventType).set({behaviourKind:'termination'}).where(and(eq(movementEventType.tenantId,b.tenantId),eq(movementEventType.code,type.code)));
  const history=await movementHistory(ctx,e.employmentId),row=history.find(item=>item.kind===type.code)!;
  expect(row).toMatchObject({kind:type.code,canEdit:false,canReverse:false});
  const before=await state(e.employmentId);
  await expect(editMovementEvent(ctx,{employmentId:e.employmentId,movementId:row.id,kind:type.code,effectiveDate:day(-1),endDate:day(-1),terminationReasonCode:'misconduct',reason:'Fictional repointed correction'})).rejects.toBeInstanceOf(MovementNotCorrectableError);
  await expect(reverseMovementEvent(ctx,{employmentId:e.employmentId,movementId:row.id,reason:'Fictional repointed rollback'})).rejects.toBeInstanceOf(MovementNotCorrectableError);
  expect(await state(e.employmentId)).toEqual(before);
 });
 it('validates incomplete destination inputs and tenant subject visibility for a custom comparison',async()=>{
  const e=await hire(),ctx=adminCtx(b),type=await saveMovementEventType(ctx,{label:'Fictional protected promotion',behaviourKind:'promotion'});
  await createMovementEvent(ctx,{employmentId:e.employmentId,kind:type.code,effectiveDate:day(-2),departmentId:b.deptB});
  const row=(await movementHistory(ctx,e.employmentId)).find(item=>item.kind===type.code)!,before=await state(e.employmentId);
  for(const kind of ['entityTransfer','termination'])await expect(editMovementEvent(ctx,{employmentId:e.employmentId,movementId:row.id,kind,effectiveDate:day(-2),reason:'Fictional incomplete replacement'})).rejects.toThrow();
  const foreign=await seedBase();
  await expect(editMovementEvent(adminCtx(foreign),{employmentId:e.employmentId,movementId:row.id,kind:'transfer',effectiveDate:day(-2),reason:'Fictional foreign access'})).rejects.toThrow();
  await expect(reverseMovementEvent(adminCtx(foreign),{employmentId:e.employmentId,movementId:row.id,reason:'Fictional foreign access'})).rejects.toThrow();
  expect(await state(e.employmentId)).toEqual(before);
 });
});
