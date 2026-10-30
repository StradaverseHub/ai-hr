/** Fictional canonical owner fixtures; verification is hosted only. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeEach,describe,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {createConfig,setStatus} from '../core/employee-id-config';
import {createCompany} from '../core/admin';
import {hireEmployee} from '../core/org';
import {prepareEmployeeIdTemplateStatusTx as prepareTx,confirmEmployeeIdTemplateStatusTx as confirmTx} from '../core/assistant-actions/employee-id-template-status-source';
import {EMPLOYEE_ID_TEMPLATE_STATUS_ACTION as action,EmployeeIdTemplateStatusHuman as Human} from '../lib/assistant-actions/employee-id-template-status-contract';
import {adminCtx,closeAll,createAppUser,owner,resetDb,seedBase,type Base} from './harness';
let b:Base,ctx:SessionContext,id:string;
const input=(status:'active'|'inactive'='inactive',configId=id)=>({action,contractVersion:1,configId,expectedStatus:status==='active'?'inactive':'active',status});
const prepare=(value:unknown=input(),who=ctx)=>withTenant(who,tx=>prepareTx(tx,who,value));
const confirm=(digest:string,value:unknown=input(),who=ctx)=>withTenant(who,tx=>confirmTx(tx,who,value,{action,contractVersion:1,reviewedDigest:digest}));
const row=async()=>((await owner.db.select().from(schema.employeeIdConfig).where(eq(schema.employeeIdConfig.id,id)))[0]);
beforeEach(async()=>{await resetDb();b=await seedBase();ctx=adminCtx(b);id=(await createConfig(ctx,{companyId:b.companyId,templateName:'Fictional Company Template',prefix:'FIC',suffix:'MY',startNumber:7,numberLength:4,status:'active',allowManualOverride:true})).id;});afterAll(closeAll);
describe('company Employee ID template status source',()=>{
 it('requires an opposite baseline and refuses posted counter, employee or format edits',()=>{expect(Human.safeParse({...input(),expectedStatus:'inactive'}).success).toBe(false);for(const extra of [{currentRunningNumber:9},{employmentId:id},{prefix:'OTHER'},{companyId:b.companyId}])expect(Human.safeParse({...input(),...extra}).success).toBe(false);});
 it('deactivates and reactivates through the same native owner, preserving all format and counter fields',async()=>{
  expect(ctx.personId).toBeUndefined();const before=await row(),r=await prepare(),receipt=await confirm(r.reviewedDigest);expect(receipt).toMatchObject({configId:id,companyId:b.companyId,status:'inactive'});
  const [event]=await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.id,receipt.eventId));expect(event).toMatchObject({aggregateType:'employee-id-config',aggregateId:id,eventType:'employee-id-config.deactivated',actorType:'user',actorId:ctx.userId,payload:{status:'inactive'}});
  expect(await row()).toEqual({...before,status:'inactive',updatedAt:expect.any(Date)});const back=input('active'),next=await prepare(back);expect((await confirm(next.reviewedDigest,back)).status).toBe('active');expect(await row()).toEqual({...before,updatedAt:expect.any(Date)});
 });
 it('rolls native preview rows/events back and keeps a repeat review digest stable',async()=>{const before=await row(),events=await owner.db.select().from(schema.domainEvent),a=await prepare(),again=await prepare();expect(again.reviewedDigest).toBe(a.reviewedDigest);expect(await row()).toEqual(before);expect(await owner.db.select().from(schema.domainEvent)).toEqual(events);});
 it('keeps the default native setter transaction-owning while its explicit outer transaction rolls back atomically',async()=>{
  const before=await row(),events=await owner.db.select().from(schema.domainEvent);await expect(withTenant(ctx,async tx=>{await setStatus(ctx,{id,status:'inactive'},tx);throw Error('Fictional outer abort');})).rejects.toThrow('Fictional outer abort');expect(await row()).toEqual(before);expect(await owner.db.select().from(schema.domainEvent)).toEqual(events);await setStatus(ctx,{id,status:'inactive'});expect((await row()).status).toBe('inactive');
 });
 it('refuses activation when another native template is active in the same company',async()=>{await setStatus(ctx,{id,status:'inactive'});await createConfig(ctx,{companyId:b.companyId,prefix:'OTHER',numberLength:4});await expect(prepare(input('active'))).rejects.toThrow();expect((await row()).status).toBe('inactive');});
 it('refuses activation with a native active prefix collision in another scope',async()=>{await setStatus(ctx,{id,status:'inactive'});const other=await createCompany(ctx,{legalName:'Fictional Prefix Company',country:'MY',currency:'MYR'});await createConfig(ctx,{companyId:other.id,prefix:'FIC',numberLength:4});await expect(prepare(input('active'))).rejects.toThrow();expect((await row()).status).toBe('inactive');});
 it('hands global templates to the native page instead of fabricating a company scope',async()=>{const global=(await createConfig(ctx,{prefix:'GLOBAL',numberLength:4})).id;await expect(prepare(input('inactive',global))).rejects.toThrow();});
 it('refuses another tenant before projecting its template',async()=>{const other=await seedBase(),foreign=(await createConfig(adminCtx(other),{companyId:other.companyId,prefix:'FOREIGN',numberLength:4})).id;await expect(prepare(input('inactive',foreign))).rejects.toThrow();});
 it('refuses an employee or SYSTEM carrier',async()=>{const userId=await createAppUser(b.tenantId,null,'employee'),employee={...ctx,userId,roles:['employee' as const],grants:[{role:'employee' as const,companyId:null}]};await expect(prepare(input(),employee)).rejects.toThrow();await expect(prepare(input(),{...ctx,userId:undefined})).rejects.toThrow();});
 it('refuses a company-scoped HR login outside the template company',async()=>{const other=await createCompany(ctx,{legalName:'Fictional Scope Company',country:'MY',currency:'MYR'}),userId=await createAppUser(b.tenantId,null,'hr_admin');await owner.db.update(schema.roleAssignment).set({companyId:other.id}).where(eq(schema.roleAssignment.appUserId,userId));const foreign={...ctx,userId,grants:[{role:'hr_admin' as const,companyId:other.id}]};await expect(prepare(input(),foreign)).rejects.toThrow();});
 it('refuses a stale format revision without changing the source status or counter',async()=>{const r=await prepare();await owner.db.update(schema.employeeIdConfig).set({suffix:'NEW'}).where(eq(schema.employeeIdConfig.id,id));await expect(confirm(r.reviewedDigest)).rejects.toThrow();expect(await row()).toMatchObject({status:'active',suffix:'NEW',currentRunningNumber:0});});
 it('refuses review after native issuance advances the counter and never rewrites the issued employee code',async()=>{
  const r=await prepare(),hired=await hireEmployee(ctx,{person:{fullName:'Fictional Number Holder',primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2025-01-01'});const [before]=await owner.db.select().from(schema.employment).where(eq(schema.employment.id,hired.employmentId));expect(before.employeeCode).toBe('FIC0007MY');await expect(confirm(r.reviewedDigest)).rejects.toThrow();expect((await row()).currentRunningNumber).toBe(7);expect((await owner.db.select().from(schema.employment).where(eq(schema.employment.id,hired.employmentId)))[0].employeeCode).toBe(before.employeeCode);
 });
 it('refuses an status ABA through real native setters',async()=>{const r=await prepare();await setStatus(ctx,{id,status:'inactive'});await setStatus(ctx,{id,status:'active'});await expect(confirm(r.reviewedDigest)).rejects.toThrow();expect((await row()).status).toBe('active');});
 it('serializes native activation and a competing native prefix create in the same workforce-before-row order',async()=>{
  await setStatus(ctx,{id,status:'inactive'});const other=await createCompany(ctx,{legalName:'Fictional Concurrent Prefix Company',country:'MY',currency:'MYR'});
  let release!:()=>void,ready!:(pid:number)=>void;const held=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<number>(resolve=>{ready=resolve;});
  const first=withTenant(ctx,async tx=>{await setStatus(ctx,{id,status:'active'},tx);const [backend]=await tx.execute<{pid:number}>(sql`select pg_backend_pid() as pid`);ready(backend.pid);await held;});
  const firstPid=await Promise.race([entered,first.then(()=>{throw Error('Native interval closed before readiness');})]),competing=createConfig(ctx,{companyId:other.id,prefix:'FIC',numberLength:4}).then(value=>({ok:true as const,value}),error=>({ok:false as const,error}));
  try{await expect.poll(async()=>{const [waiting]=await owner.db.execute<{blocked:boolean}>(sql`select exists(select 1 from pg_locks w join pg_locks h on h.locktype=w.locktype and h.database is not distinct from w.database and h.classid=w.classid and h.objid=w.objid and h.objsubid=w.objsubid join pg_stat_activity a on a.pid=w.pid where w.locktype='advisory' and not w.granted and h.granted and h.pid=${firstPid} and w.pid<>h.pid and a.datname=current_database()) as blocked`);return waiting.blocked;},{timeout:5000}).toBe(true);}finally{release();await first;}
  expect((await competing).ok).toBe(false);const active=await owner.db.select().from(schema.employeeIdConfig);expect(active.filter(c=>c.status==='active'&&c.prefix==='FIC')).toHaveLength(1);
 });
 it('serializes two native activations that compete for the same active prefix',async()=>{
  await setStatus(ctx,{id,status:'inactive'});const other=await createCompany(ctx,{legalName:'Fictional Activation Company',country:'MY',currency:'MYR'}),peer=(await createConfig(ctx,{companyId:other.id,prefix:'FIC',numberLength:4,status:'inactive'})).id;
  let release!:()=>void,ready!:(pid:number)=>void;const held=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<number>(resolve=>{ready=resolve;});
  const first=withTenant(ctx,async tx=>{await setStatus(ctx,{id,status:'active'},tx);const [backend]=await tx.execute<{pid:number}>(sql`select pg_backend_pid() as pid`);ready(backend.pid);await held;});
  const firstPid=await Promise.race([entered,first.then(()=>{throw Error('Native interval closed before readiness');})]),competing=setStatus(ctx,{id:peer,status:'active'}).then(value=>({ok:true as const,value}),error=>({ok:false as const,error}));
  try{await expect.poll(async()=>{const [waiting]=await owner.db.execute<{blocked:boolean}>(sql`select exists(select 1 from pg_locks w join pg_locks h on h.locktype=w.locktype and h.database is not distinct from w.database and h.classid=w.classid and h.objid=w.objid and h.objsubid=w.objsubid join pg_stat_activity a on a.pid=w.pid where w.locktype='advisory' and not w.granted and h.granted and h.pid=${firstPid} and w.pid<>h.pid and a.datname=current_database()) as blocked`);return waiting.blocked;},{timeout:5000}).toBe(true);}finally{release();await first;}
  expect((await competing).ok).toBe(false);expect((await owner.db.select().from(schema.employeeIdConfig).where(eq(schema.employeeIdConfig.id,peer)))[0].status).toBe('inactive');
 });
 it('refuses savepoint-local native event/row proof and rolls the effect back',async()=>{await expect(withTenant(ctx,async tx=>{await tx.execute(sql`savepoint fictional_template_child`);await setStatus(ctx,{id,status:'inactive'},tx);await tx.execute(sql`release savepoint fictional_template_child`);await tx.execute(sql`select app.employee_id_template_status_current_event(${id}::uuid,'inactive')`);})).rejects.toThrow();expect((await row()).status).toBe('active');});
});
