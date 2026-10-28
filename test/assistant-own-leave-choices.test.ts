/** Actual current-actor/RLS/menu source cases, authored UNRUN. Requires coordinated AI controls.
 * No provider, mock authority, menu-as-effect claim or client-origin SessionContext is used. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {grantAssistant,revokeAssistant} from '../core/assistant-grant';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {readOwnLeaveChoicesTx} from '../core/assistant-actions/own-leave-choices';
import {ownLeaveFirstSliceTypeQualifies} from '../core/assistant-actions/own-leave-candidate';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'assistant','active');});
async function fixture(){
 const e=await hireEmployee(adminCtx(b),{person:{fullName:'Fictional Own Choice Person',primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const userId=await createAppUser(b.tenantId,e.personId,'employee');await grantAssistant(adminCtx(b),{appUserId:userId});
 const ctx:SessionContext={...await entitledCtx(b,['employee']),userId,personId:e.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
 return{...e,ctx};
}
const menu=(ctx:SessionContext,locale='en')=>withTenant(ctx,tx=>readOwnLeaveChoicesTx(tx,ctx,locale));
const identity={role:'annual' as const,code:'ANNUAL',country:'MY' as const,essViewConfig:null};
const type={paid:true,requiresDocument:false,balanceSourceTypeId:null as string|null};
describe('shared first-slice type qualification',()=>{
 it('keeps the exact annual/country/paid/documentless/no-derived-balance predicate',()=>{
  expect(ownLeaveFirstSliceTypeQualifies(identity,type,'MY')).toBe(true);
  expect(ownLeaveFirstSliceTypeQualifies(undefined,type,'MY')).toBe(false);
  expect(ownLeaveFirstSliceTypeQualifies({...identity,role:'sick',code:'SICK'},type,'MY')).toBe(false);
  expect(ownLeaveFirstSliceTypeQualifies(identity,type,'SG')).toBe(false);
  expect(ownLeaveFirstSliceTypeQualifies(identity,{...type,paid:false},'MY')).toBe(false);
  expect(ownLeaveFirstSliceTypeQualifies(identity,{...type,requiresDocument:true},'MY')).toBe(false);
  expect(ownLeaveFirstSliceTypeQualifies(identity,{...type,balanceSourceTypeId:randomUUID()},'MY')).toBe(false);
 });
});
describe('bounded canonical own-leave choices',()=>{
 it('bounds the actual Access wait before chooser custody, returns no private choices/effects, then succeeds after release',async()=>{
  const f=await fixture(),initial=await menu(f.ctx);expect(initial.kind).toBe('choices');
  if(initial.kind!=='choices')throw Error('Fictional chooser positive control unavailable');
  expect(initial.employments.some(row=>row.id===f.employmentId)).toBe(true);
  const before={events:await owner.db.select().from(s.domainEvent).orderBy(s.domainEvent.id),requests:await owner.db.select().from(s.leaveRequest).orderBy(s.leaveRequest.id),runs:await owner.db.select().from(s.aiModelRun).orderBy(s.aiModelRun.id),reviews:await owner.db.execute(sql`select count(*)::int as count from app.assistant_own_leave_review where tenant_id=${b.tenantId}::uuid`)};
  let release!:()=>void,ready!:()=>void,failed!:(error:unknown)=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),held=new Promise<void>((resolve,reject)=>{ready=resolve;failed=reject;});
  const holding=owner.client.begin(async tx=>{await tx`select pg_advisory_xact_lock(hashtextextended(${'access-configuration:'+b.tenantId},0))`;ready();await gate;}).catch(error=>{failed(error);throw error;});
  await held;let timer:ReturnType<typeof setTimeout>|undefined,pending:ReturnType<typeof menu>|undefined;
  try{
   pending=menu(f.ctx);const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Actual chooser Access wait was not bounded')),4000);});
   expect(await Promise.race([pending,deadline])).toEqual({kind:'unavailable'});
  }finally{if(timer)clearTimeout(timer);release();await holding;if(pending)await pending.catch(()=>undefined);}
  expect(await menu(f.ctx)).toEqual(initial);
  expect({events:await owner.db.select().from(s.domainEvent).orderBy(s.domainEvent.id),requests:await owner.db.select().from(s.leaveRequest).orderBy(s.leaveRequest.id),runs:await owner.db.select().from(s.aiModelRun).orderBy(s.aiModelRun.id),reviews:await owner.db.execute(sql`select count(*)::int as count from app.assistant_own_leave_review where tenant_id=${b.tenantId}::uuid`)}).toEqual(before);
 });
 it('keeps stricter caller timeouts while installing chooser bounds before source reads',async()=>{
  const f=await fixture();await withTenant(f.ctx,async tx=>{
   await tx.execute(sql`set local statement_timeout='3000ms'`);await tx.execute(sql`set local lock_timeout='125ms'`);
   expect((await readOwnLeaveChoicesTx(tx,f.ctx,'en')).kind).toBe('choices');
   const [limits]=await tx.execute<{statement:string;lock:string}>(sql`select (select setting from pg_catalog.pg_settings where name='statement_timeout') as statement,(select setting from pg_catalog.pg_settings where name='lock_timeout') as lock`);
   expect(limits).toEqual({statement:'3000',lock:'125'});
  });
 });

 it('projects only current own labels/IDs and canonical eligible annual types without salary/balance/actor data or effects',async()=>{
  const first=await fixture(),other=await fixture();await setCompensation(adminCtx(b),{employmentId:first.employmentId,basicSalary:9876.54,monthlyAllowance:123.45,effectiveFrom:'2020-01-01'});
  const before=await owner.db.select().from(s.domainEvent);const result=await menu(first.ctx);
  expect(result.kind).toBe('choices');if(result.kind!=='choices')throw Error('Fictional menu unavailable');
  expect(result.employments).toHaveLength(1);expect(result.employments[0].id).toBe(first.employmentId);
  expect(Object.keys(result.employments[0]).sort()).toEqual(['id','label','leaveTypes']);expect(result.employments[0].leaveTypes.some(type=>type.id===b.annualLeaveTypeId)).toBe(true);
  for(const type of result.employments[0].leaveTypes)expect(Object.keys(type).sort()).toEqual(['id','label']);
  const serialized=JSON.stringify(result);for(const value of [other.employmentId,other.personId,b.tenantId,b.companyId,first.ctx.userId!,first.personId,'9876.54','123.45','balance','salary','grants','receipt','intentDigest'])expect(serialized).not.toContain(value);
  expect(await owner.db.select().from(s.domainEvent)).toEqual(before);expect(await owner.db.select().from(s.leaveRequest)).toEqual([]);expect(await owner.db.select().from(s.aiModelRun)).toEqual([]);
 });
 it('refuses a foreign supplied person and preserves each actual login own inventory',async()=>{
  const first=await fixture(),other=await fixture();
  expect(await menu({...first.ctx,personId:other.personId})).toEqual({kind:'unavailable'});
  const foreign=await menu(other.ctx);expect(foreign.kind).toBe('choices');if(foreign.kind!=='choices')throw Error('Fictional menu unavailable');
  expect(foreign.employments.map(row=>row.id)).toEqual([other.employmentId]);expect(JSON.stringify(foreign)).not.toContain(first.employmentId);
  const tenant=await seedBase();expect(await menu({...first.ctx,tenantId:tenant.tenantId})).toEqual({kind:'unavailable'});
 });
 it('uses fresh Assistant grants and module rows instead of the supplied old snapshot',async()=>{
  const f=await fixture();expect((await menu(f.ctx)).kind).toBe('choices');
  await revokeAssistant(adminCtx(b),{appUserId:f.ctx.userId!});expect(await menu(f.ctx)).toEqual({kind:'unavailable'});
  await grantAssistant(adminCtx(b),{appUserId:f.ctx.userId!});await setModule(b.tenantId,'assistant','disabled');expect(await menu(f.ctx)).toEqual({kind:'unavailable'});
 });
 it('refuses a relinked/archived actual login and cannot retain the old person menu',async()=>{
  const first=await fixture(),other=await fixture();
  await owner.db.update(s.appUser).set({personId:other.personId}).where(eq(s.appUser.id,first.ctx.userId!));
  expect(await menu(first.ctx)).toEqual({kind:'unavailable'});
  const current=await menu({...first.ctx,personId:other.personId});expect(current.kind).toBe('choices');if(current.kind!=='choices')throw Error('Fictional menu unavailable');expect(current.employments.map(row=>row.id)).toEqual([other.employmentId]);
  await owner.db.update(s.appUser).set({archivedAt:new Date()}).where(eq(s.appUser.id,first.ctx.userId!));expect(await menu({...first.ctx,personId:other.personId})).toEqual({kind:'unavailable'});
 });
 it.each(['unpaid','document','derived'] as const)('does not offer the canonical annual type when its %s capability is outside the first slice',async kind=>{
  const f=await fixture();
  let sourceId:string|undefined;
  if(kind==='derived'){const [source]=await owner.db.select().from(s.leaveType).where(eq(s.leaveType.id,b.annualLeaveTypeId));const [other]=await owner.db.insert(s.leaveType).values({...source,id:randomUUID(),code:'FICT_BALANCE_SOURCE',name:'Fictional balance source',role:null}).returning();sourceId=other.id;}
  const values=kind==='unpaid'?{paid:false}:kind==='document'?{requiresDocument:true}:{balanceSourceTypeId:sourceId!};
  await owner.db.update(s.leaveType).set(values).where(eq(s.leaveType.id,b.annualLeaveTypeId));
  const result=await menu(f.ctx);expect(result.kind).toBe('choices');if(result.kind!=='choices')throw Error('Fictional menu unavailable');expect(result.employments.flatMap(row=>row.leaveTypes).some(row=>row.id===b.annualLeaveTypeId)).toBe(false);
 });
 it('does not offer ended own employments while another current own employment keeps the login active',async()=>{
  const f=await fixture();const [company]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional former employer',country:'MY'}).returning();
  const [department]=await owner.db.insert(s.department).values({tenantId:b.tenantId,companyId:company.id,name:'Fictional former department'}).returning();
  const ended=await hireEmployee(adminCtx(b),{person:{id:f.personId},companyId:company.id,departmentId:department.id,employmentType:'full_time',hiredOn:'2020-01-01'});
  await owner.db.update(s.employment).set({terminatedOn:'2020-01-02'}).where(eq(s.employment.id,ended.employmentId));
  const result=await menu(f.ctx);expect(result.kind).toBe('choices');if(result.kind!=='choices')throw Error('Fictional menu unavailable');
  expect(result.employments.map(row=>row.id)).toEqual([f.employmentId]);expect(JSON.stringify(result)).not.toContain('Fictional former employer');
 });
 it('refuses a missing canonical current-company proof and invalid locale instead of guessing labels',async()=>{
  const f=await fixture();expect(await menu(f.ctx,'invalid-locale')).toEqual({kind:'unavailable'});
  await owner.db.update(s.assignment).set({validTo:'2020-01-02'}).where(eq(s.assignment.employmentId,f.employmentId));expect(await menu(f.ctx)).toEqual({kind:'unavailable'});
 });
 it('rejects a canonical eligible catalogue above128 before silently omitting or truncating entries',async()=>{
  const f=await fixture();const [source]=await owner.db.select().from(s.leaveType).where(eq(s.leaveType.id,b.annualLeaveTypeId));
  await owner.db.insert(s.leaveType).values(Array.from({length:129},(_,n)=>({...source,id:randomUUID(),code:'FICT_CHOICE_'+n,name:'Fictional bounded choice '+n,role:null,eligibility:{},employeeCanApply:true,visibleToEmployee:true})));
  expect(await menu(f.ctx)).toEqual({kind:'unavailable'});
 });
 it('rejects more than16 own employment sources without returning a partial menu',async()=>{
  const f=await fixture();
  for(let n=0;n<16;n++){
   const [company]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional bounded company '+n,country:'MY'}).returning();
   const [department]=await owner.db.insert(s.department).values({tenantId:b.tenantId,companyId:company.id,name:'Fictional bounded department'}).returning();
   await hireEmployee(adminCtx(b),{person:{id:f.personId},companyId:company.id,departmentId:department.id,employmentType:'full_time',hiredOn:'2020-01-01'});
  }
  expect(await menu(f.ctx)).toEqual({kind:'unavailable'});
 });
});
