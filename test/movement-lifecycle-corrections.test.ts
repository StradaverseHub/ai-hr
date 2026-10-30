import {randomUUID} from 'node:crypto';
import {asc,eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {employment,domainEvent} from '../db/schema';
import {hireEmployee,setEmploymentBlacklist} from '../core/org';
import {createMovementEvent,editMovementEvent,movementHistory,movementPendingEditInput,reverseMovementEvent} from '../core/movement';
import {setMovementEventTypeActive} from '../core/movement-type';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base;beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();});afterAll(closeAll);
const day=(n:number)=>new Date(Date.parse(todayInKualaLumpur()+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
const hire=()=>hireEmployee(adminCtx(b),{person:{fullName:'Fictional lifecycle correction',primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:day(-90)});
const employee=async(id:string)=>(await owner.db.select().from(employment).where(eq(employment.id,id)))[0];
const facts=async(id:string)=>({employee:await employee(id),events:await owner.db.select().from(domainEvent).where(eq(domainEvent.subjectEmploymentId,id)).orderBy(asc(domainEvent.sequence))});
describe('646355e5 — known lifecycle events have audited inverses',()=>{
 it.each(['joinDateChange','groupJoinDateCorrection'] as const)('edits and deletes %s through the date owner while keeping the original hire',async kind=>{
  const e=await hire(),ctx=adminCtx(b),before=await employee(e.employmentId),field=kind==='joinDateChange'?'joinDate':'hiredOn',originalDate=day(kind==='joinDateChange'?-80:-100),correctedDate=day(kind==='joinDateChange'?-81:-101);
  await createMovementEvent(ctx,{employmentId:e.employmentId,kind,effectiveDate:originalDate,remarks:'Fictional original date'});
  const row=(await movementHistory(ctx,e.employmentId)).find(r=>r.kind===kind)!;expect(row).toMatchObject({canEdit:true,canReverse:true});
  await setMovementEventTypeActive(ctx,{code:kind,active:false});
  await editMovementEvent(ctx,{employmentId:e.employmentId,movementId:row.id,kind,effectiveDate:correctedDate,reason:'Fictional date correction'});
  expect((await employee(e.employmentId))[field]).toBe(correctedDate);
  if(kind==='groupJoinDateCorrection')expect((await employee(e.employmentId)).joinDate).toBe(correctedDate);
  const current=(await movementHistory(ctx,e.employmentId)).find(r=>r.kind===kind&&r.status==='applied')!;
  await reverseMovementEvent(ctx,{employmentId:e.employmentId,movementId:current.id,reason:'Fictional incorrect date event'});
  expect((await employee(e.employmentId))[field]).toBe(before[field]);
  expect((await employee(e.employmentId)).joinDate).toBe(before.joinDate);
  expect((await movementHistory(ctx,e.employmentId)).filter(r=>r.kind==='hired')).toHaveLength(1);
 });
 it('corrects a probation extension and restores both the original extension and the derived final date on Delete',async()=>{
  const e=await hire(),ctx=adminCtx(b),before=await employee(e.employmentId);
  await createMovementEvent(ctx,{employmentId:e.employmentId,kind:'probationExtension',effectiveDate:day(-2),endDate:day(45)});
  const row=(await movementHistory(ctx,e.employmentId)).find(r=>r.kind==='probationExtension')!;expect(row).toMatchObject({canEdit:true,canReverse:true});
  await editMovementEvent(ctx,{employmentId:e.employmentId,movementId:row.id,kind:'probationExtension',effectiveDate:day(-2),endDate:day(60),reason:'Fictional corrected probation end'});
  expect(await employee(e.employmentId)).toMatchObject({extendedConfirmationDate:day(60),finalConfirmationDate:day(60)});
  const current=(await movementHistory(ctx,e.employmentId)).find(r=>r.kind==='probationExtension'&&r.status==='applied')!;
  await reverseMovementEvent(ctx,{employmentId:e.employmentId,movementId:current.id,reason:'Fictional undo extension'});
  expect(await employee(e.employmentId)).toMatchObject({extendedConfirmationDate:before.extendedConfirmationDate,finalConfirmationDate:before.finalConfirmationDate});
 });
 it('edits blacklist information and deletes its effect without erasing the original ledger record',async()=>{
  const e=await hire(),ctx=adminCtx(b);
  await createMovementEvent(ctx,{employmentId:e.employmentId,kind:'blacklist',effectiveDate:todayInKualaLumpur(),blacklisted:true,remarks:'Fictional original reason'});
  const row=(await movementHistory(ctx,e.employmentId)).find(r=>r.kind==='blacklist')!;expect(row).toMatchObject({canEdit:true,canReverse:true});
  expect(await movementPendingEditInput(ctx,e.employmentId,row.id)).toMatchObject({values:{blacklisted:'true'},unavailable:false});
  await editMovementEvent(ctx,{employmentId:e.employmentId,movementId:row.id,kind:'blacklist',effectiveDate:'',blacklisted:true,remarks:'Fictional corrected reason',reason:'Fictional correction audit reason'});
  expect((await employee(e.employmentId)).blacklistReason).toBe('Fictional corrected reason');
  const current=(await movementHistory(ctx,e.employmentId)).find(r=>r.kind==='blacklist'&&r.status==='applied')!;
  await reverseMovementEvent(ctx,{employmentId:e.employmentId,movementId:current.id,reason:'Fictional incorrect blacklist'});
  expect(await employee(e.employmentId)).toMatchObject({blacklistedAt:null,blacklistReason:null});
  expect((await movementHistory(ctx,e.employmentId)).find(r=>r.id===row.id)?.status).toBe('reversed');
 });
 it('Delete of a blacklist-clear event restores its exact previous date and reason',async()=>{
  const e=await hire(),ctx=adminCtx(b);
  await setEmploymentBlacklist(ctx,{employmentId:e.employmentId,blacklisted:true,reason:'Fictional retained original'});
  const blocked=await employee(e.employmentId);
  await setEmploymentBlacklist(ctx,{employmentId:e.employmentId,blacklisted:false});
  const clear=(await movementHistory(ctx,e.employmentId)).find(r=>r.kind==='blacklistCleared')!;expect(clear).toMatchObject({canEdit:true,canReverse:true,correctionKind:'blacklist'});
  await reverseMovementEvent(ctx,{employmentId:e.employmentId,movementId:clear.id,reason:'Fictional accidental clearance'});
  expect(await employee(e.employmentId)).toMatchObject({blacklistedAt:blocked.blacklistedAt,blacklistReason:blocked.blacklistReason});
 });
 it('refuses an older blacklist inverse after a later conflicting change and retains all facts',async()=>{
  const e=await hire(),ctx=adminCtx(b);
  await setEmploymentBlacklist(ctx,{employmentId:e.employmentId,blacklisted:true,reason:'Fictional initial block'});
  const row=(await movementHistory(ctx,e.employmentId)).find(r=>r.kind==='blacklist')!;
  await setEmploymentBlacklist(ctx,{employmentId:e.employmentId,blacklisted:false});const before=await facts(e.employmentId);
  await expect(reverseMovementEvent(ctx,{employmentId:e.employmentId,movementId:row.id,reason:'Fictional conflicting older removal'})).rejects.toThrow(/later blacklist change/);
  expect(await facts(e.employmentId)).toEqual(before);
 });
});
