/** Real native app-login/RLS/transaction tests. No browser lease or release claim. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import * as s from '../db/schema';
import {createCompany} from '../core/admin';
import {createConfig} from '../core/employee-id-config';
import {hireEmployee} from '../core/workforce-commands';
import {createEmployeeDraftWithReservedCode,getEmployeeDraft,getEmployeeDraftPresentation,getEmployeeDraftPresentationTx,saveEmployeeDraft,type EmployeeDraftDetail} from '../core/employee-draft';
import type {EmployeeDraftData} from '../lib/employee-draft-schema';
import {pgSqlState} from '../lib/db-error';
import {closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

beforeAll(migrateTestDb);beforeEach(resetDb);afterAll(closeAll);
const copy=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))});
async function currentContext(b:Base,userId=b.adminUserId):Promise<SessionContext>{
 const [principal]=await owner.client<{tenant:string;person:string|null;grants:{role:string;companyId:string|null}[]}[]>`
  select tenant_id as tenant,person_id as person,grants from app.principal(${userId}::uuid)`;
 expect(principal).toBeDefined();expect(principal.tenant).toBe(b.tenantId);
 const grants=principal.grants.map(grant=>({...grant})),roles=[...new Set(grants.map(grant=>grant.role))];
 return {...await entitledCtx(b,roles),userId,personId:principal.person,roles,grants};
}
async function createDraft(ctx:SessionContext,companyId:string,name:string):Promise<{expected:EmployeeDraftDetail;data:EmployeeDraftData}>{
 const email=randomUUID()+'@example.invalid',draft=await createEmployeeDraftWithReservedCode(ctx,{companyId,fullName:name,primaryEmail:email});
 const data:EmployeeDraftData={creationDefaultsVersion:1,
  profile:{fullName:name,primaryEmail:email,employeeCode:draft.employeeCode,employeeIdMode:'auto',personalEmail:''},
  employment:{companyId},statutory:{bankName:'Fictional retained bank',bankAccountNo:'FICTIONAL-ONLY',subjectToSkbbk:'no'},
  payroll:{basicSalary:'4321.09',monthlyAllowance:'0.00'}};
 await saveEmployeeDraft(ctx,{id:draft.id,data,currentStep:4});
 return{data,expected:{id:draft.id,data,currentStep:4,companyId,reservedEmployeeCode:draft.employeeCode}};
}
async function fixture(){
 const b=await seedBase(),ctx=await currentContext(b);
 const second=(await createCompany(ctx,{legalName:'Fictional Draft company B',country:'MY',currency:'MYR'})).id;
 await createConfig(ctx,{companyId:b.companyId,prefix:'DRA',startNumber:1,numberLength:5,increment:1,allowManualOverride:true});
 await createConfig(ctx,{companyId:second,prefix:'DRB',startNumber:1,numberLength:5,increment:1,allowManualOverride:true});
 const first=await createDraft(ctx,b.companyId,'Draft தமிழ் / First'),other=await createDraft(ctx,second,'Draft company B');
 return{b,ctx,second,first:first.expected,other:other.expected};
}
const snapshot=(ctx:SessionContext,work:(tx:Tx)=>Promise<unknown>)=>withTenant(ctx,work,{readOnlySnapshot:true});
async function carrier(tx:Tx){
 const [row]=await tx.execute<{login:string;role:string;bypass:boolean;tableOwner:boolean;isolation:string;readOnly:boolean;pid:number;started:string;root:string;snapshot:string}>(sql`
  select session_user::text as login,current_user::text as role,
   (select rolsuper or rolbypassrls from pg_roles where rolname=current_user)as bypass,
   current_user::regrole::oid=(select relowner from pg_class where oid='public.employee_draft'::regclass)as "tableOwner",
   current_setting('transaction_isolation')as isolation,current_setting('transaction_read_only')='on'as "readOnly",
   pg_backend_pid()as pid,(select backend_start::text from pg_stat_activity where pid=pg_backend_pid())as started,
   (select virtualxid::text from pg_locks where pid=pg_backend_pid()and locktype='virtualxid'and granted and mode='ExclusiveLock')as root,
   pg_current_snapshot()::text as snapshot`);
 expect(row).toMatchObject({login:'ai_hr_app',role:'ai_hr_app',bypass:false,tableOwner:false,isolation:'repeatable read',readOnly:true});
 expect(row.pid).toBeGreaterThan(1);expect(row.started.length).toBeGreaterThan(20);expect(row.root).toMatch(/^[0-9]+\/[0-9]+$/);return row;
}
async function effects(){
 const [row]=await owner.client`select jsonb_build_object(
  'drafts',(select coalesce(jsonb_agg(jsonb_build_object('row',to_jsonb(t),'xmin',t.xmin::text)order by to_jsonb(t)::text),'[]'::jsonb)from employee_draft t),
  'codes',(select coalesce(jsonb_agg(jsonb_build_object('row',to_jsonb(t),'xmin',t.xmin::text)order by to_jsonb(t)::text),'[]'::jsonb)from employee_id_config t),
  'counters',(select coalesce(jsonb_agg(jsonb_build_object('row',to_jsonb(t),'xmin',t.xmin::text)order by to_jsonb(t)::text),'[]'::jsonb)from tenant_counter t),
  'people',(select coalesce(jsonb_agg(jsonb_build_object('row',to_jsonb(t),'xmin',t.xmin::text)order by to_jsonb(t)::text),'[]'::jsonb)from person t),
  'employment',(select coalesce(jsonb_agg(jsonb_build_object('row',to_jsonb(t),'xmin',t.xmin::text)order by to_jsonb(t)::text),'[]'::jsonb)from employment t),
  'assignments',(select coalesce(jsonb_agg(jsonb_build_object('row',to_jsonb(t),'xmin',t.xmin::text)order by to_jsonb(t)::text),'[]'::jsonb)from assignment t),
  'compensation',(select coalesce(jsonb_agg(jsonb_build_object('row',to_jsonb(t),'xmin',t.xmin::text)order by to_jsonb(t)::text),'[]'::jsonb)from compensation t),
  'events',(select coalesce(jsonb_agg(jsonb_build_object('row',to_jsonb(t),'xmin',t.xmin::text)order by to_jsonb(t)::text),'[]'::jsonb)from domain_event t),
  'notifications',(select coalesce(jsonb_agg(jsonb_build_object('row',to_jsonb(t),'xmin',t.xmin::text)order by to_jsonb(t)::text),'[]'::jsonb)from notification t),
  'delivery',(select coalesce(jsonb_agg(jsonb_build_object('row',to_jsonb(t),'xmin',t.xmin::text)order by to_jsonb(t)::text),'[]'::jsonb)from notification_delivery t))as value`;
 return row.value;
}

it('returns the complete independently created DTO through one real nonowner RR/RO borrowed carrier and the legacy owner',async()=>{
 const {ctx,first}=await fixture(),before=await effects();
 expect(await getEmployeeDraft(ctx,first.id)).toEqual(first);
 await snapshot(ctx,async tx=>{
  const initial=await carrier(tx);
  expect(await getEmployeeDraftPresentationTx(tx,ctx,first.id)).toEqual(first);
  expect(await getEmployeeDraftPresentationTx(tx,ctx,first.id)).toEqual(first);
  expect(await carrier(tx)).toEqual(initial);
 });
 expect(await getEmployeeDraftPresentation(ctx,first.id)).toEqual(first);expect(await effects()).toEqual(before);
});

it('preserves native scoped-company, unassigned and foreign-tenant null outcomes without treating them as a 404',async()=>{
 const {b,ctx,second,first,other}=await fixture(),user=await createAppUser(b.tenantId,null,'hr_admin');
 await owner.db.update(s.roleAssignment).set({companyId:b.companyId}).where(eq(s.roleAssignment.appUserId,user));
 const scoped=await currentContext(b,user),unassigned=await saveEmployeeDraft(ctx,{data:{profile:{fullName:'Fictional unassigned'}},currentStep:1});
 expect(await getEmployeeDraftPresentation(scoped,first.id)).toEqual(first);
 for(const id of [other.id,unassigned.id,randomUUID()]){
  expect(await getEmployeeDraft(scoped,id)).toBeNull();expect(await getEmployeeDraftPresentation(scoped,id)).toBeNull();
 }
 expect(await getEmployeeDraftPresentation(ctx,other.id)).toEqual(other);
 expect(await getEmployeeDraftPresentation(ctx,unassigned.id)).toEqual({id:unassigned.id,data:{creationDefaultsVersion:1,profile:{fullName:'Fictional unassigned'}},currentStep:1,companyId:null,reservedEmployeeCode:null});
 const foreign=await seedBase(),foreignCtx=await currentContext(foreign);
 expect(await getEmployeeDraftPresentation(foreignCtx,first.id)).toBeNull();expect(second).not.toBe(foreign.companyId);
});

it('retains a real own-author read after the author loses HR status without granting access to a colleague draft',async()=>{
 const {b,ctx,first}=await fixture(),hired=await hireEmployee(ctx,{person:{fullName:'Fictional Draft author',primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const user=await createAppUser(b.tenantId,hired.personId,'hr_admin'),author=await currentContext(b,user);
 const {expected}=await createDraft(author,b.companyId,'Fictional authored Draft');
 await owner.db.update(s.roleAssignment).set({role:'employee',companyId:null}).where(eq(s.roleAssignment.appUserId,user));
 const current=await currentContext(b,user),before=await effects();expect(current.roles).toEqual(['employee']);
 expect(await getEmployeeDraft(current,expected.id)).toEqual(expected);expect(await getEmployeeDraftPresentation(current,expected.id)).toEqual(expected);
 expect(await getEmployeeDraftPresentation(current,first.id)).toBeNull();expect(await effects()).toEqual(before);
});

it('refuses forged carrier identity and stale current grants, then respects the actual new company on a fresh probe',async()=>{
 const {b,ctx,second,first,other}=await fixture(),user=await createAppUser(b.tenantId,null,'hr_admin');
 await owner.db.update(s.roleAssignment).set({companyId:b.companyId}).where(eq(s.roleAssignment.appUserId,user));
 const scoped=await currentContext(b,user);expect(await getEmployeeDraftPresentation(scoped,first.id)).toEqual(first);
 for(const changed of [{...ctx,personId:randomUUID()},{...ctx,userId:randomUUID()},{...ctx,tenantId:randomUUID()},{...ctx,entitlementsExempt:'platform' as const},{...ctx,statutoryOverride:'fictional-not-authority'}]){
  await expect(snapshot(ctx,tx=>getEmployeeDraftPresentationTx(tx,changed,first.id))).rejects.toThrow('calling authority');
 }
 await owner.db.update(s.roleAssignment).set({companyId:second}).where(eq(s.roleAssignment.appUserId,user));
 await expect(getEmployeeDraftPresentation(scoped,first.id)).rejects.toThrow('calling authority');
 const current=await currentContext(b,user);expect(await getEmployeeDraftPresentation(current,first.id)).toBeNull();expect(await getEmployeeDraftPresentation(current,other.id)).toEqual(other);
 await owner.db.update(s.appUser).set({archivedAt:new Date()}).where(eq(s.appUser.id,user));
 await expect(getEmployeeDraftPresentation(current,other.id)).rejects.toThrow('calling authority');
});

it('lets an already admitted native snapshot finish and refuses the next fresh probe after a real grant revocation',async()=>{
 const {b,ctx,first}=await fixture(),before=await effects();
 await snapshot(ctx,async tx=>{
  expect(await getEmployeeDraftPresentationTx(tx,ctx,first.id)).toEqual(first);
  expect(await owner.db.delete(s.roleAssignment).where(eq(s.roleAssignment.appUserId,b.adminUserId)).returning({id:s.roleAssignment.id})).toHaveLength(1);
  expect(await getEmployeeDraftPresentationTx(tx,ctx,first.id)).toEqual(first);
 });
 await expect(getEmployeeDraftPresentation(ctx,first.id)).rejects.toThrow('calling authority');expect(await effects()).toEqual(before);
});

it('finishes an admitted snapshot while a canonical save commits and the next legacy and presentation reads see the new DTO',async()=>{
 const {ctx,first}=await fixture(),updated:EmployeeDraftData={...first.data,profile:{...first.data.profile,fullName:'Fictional committed newer Draft'},payroll:{basicSalary:'7654.32',monthlyAllowance:'1.25'}};
 await snapshot(ctx,async tx=>{
  const initial=await carrier(tx);expect(await getEmployeeDraftPresentationTx(tx,ctx,first.id)).toEqual(first);
  await saveEmployeeDraft(ctx,{id:first.id,data:updated,currentStep:7});
  expect(await getEmployeeDraftPresentationTx(tx,ctx,first.id)).toEqual(first);expect(await carrier(tx)).toEqual(initial);
 });
 const expected={...first,data:updated,currentStep:7};expect(await getEmployeeDraft(ctx,first.id)).toEqual(expected);expect(await getEmployeeDraftPresentation(ctx,first.id)).toEqual(expected);
});

it('enforces the actual RR/RO purpose and denies native writes and row locks without poisoning its valid parent read',async()=>{
 const {ctx,first}=await fixture(),before=await effects();
 await expect(withTenant(ctx,tx=>getEmployeeDraftPresentationTx(tx,ctx,first.id))).rejects.toThrow('calling authority');
 await expect(withTenant(ctx,async tx=>{await tx.execute(sql`set transaction read only`);return getEmployeeDraftPresentationTx(tx,ctx,first.id);})).rejects.toThrow('calling authority');
 await snapshot(ctx,async tx=>{
  for(const operation of [
   (nested:Tx)=>nested.update(s.employeeDraft).set({currentStep:9}).where(eq(s.employeeDraft.id,first.id)),
   (nested:Tx)=>nested.select({id:s.employeeDraft.id}).from(s.employeeDraft).where(eq(s.employeeDraft.id,first.id)).for('update'),
  ]){
   const error=await tx.transaction(async nested=>{await operation(nested);}).then(()=>undefined,error=>error);expect(pgSqlState(error)).toBe('25006');
   expect(await getEmployeeDraftPresentationTx(tx,ctx,first.id)).toEqual(first);
  }
 });
 expect(await effects()).toEqual(before);
});

it('reads behind real open Access and draft-row writers without joining their advisory or row-lock barriers',async()=>{
 const {b,ctx,first}=await fixture(),before=await effects();
 await owner.client.begin(async writer=>{
  await writer`select pg_advisory_xact_lock(hashtextextended(${'access-configuration:'+b.tenantId},0))`;
  expect(await writer`select id from employee_draft where id=${first.id}::uuid for update`).toHaveLength(1);
  await snapshot(ctx,async tx=>{
   await tx.execute(sql`set local lock_timeout='300ms'`);await tx.execute(sql`set local statement_timeout='3s'`);
   expect(await getEmployeeDraftPresentationTx(tx,ctx,first.id)).toEqual(first);
   const [locks]=await tx.execute<{advisory:number}>(sql`select count(*)::int as advisory from pg_locks where pid=pg_backend_pid()and locktype='advisory'`);expect(locks.advisory).toBe(0);
  });
  const commandError=await withTenant(ctx,async tx=>{
   await tx.execute(sql`set local lock_timeout='300ms'`);await tx.execute(sql`set local statement_timeout='3s'`);
   return saveEmployeeDraft(ctx,{id:first.id,data:first.data,currentStep:8},tx);
  }).then(()=>undefined,error=>error);
  expect(pgSqlState(commandError)).toBe('55P03');
 });
 expect(await effects()).toEqual(before);
 await saveEmployeeDraft(ctx,{id:first.id,data:first.data,currentStep:8});
 expect(await getEmployeeDraftPresentation(ctx,first.id)).toEqual({...first,currentStep:8});
 const updates=await owner.db.select({payload:s.domainEvent.payload}).from(s.domainEvent)
  .where(sql`${s.domainEvent.aggregateId}=${first.id}::uuid and ${s.domainEvent.eventType}='employee-draft.updated'`);
 expect(updates).toHaveLength(2);expect(updates).toEqual(expect.arrayContaining([{payload:expect.objectContaining({currentStep:8})}]));
});

it('captures mutable roles and grant entries before queued standalone or borrowed work can observe caller changes',async()=>{
 const {ctx,second,first}=await fixture(),mutable=copy(ctx),pending=getEmployeeDraftPresentation(mutable,first.id);
 mutable.roles![0]='employee';mutable.grants![0].companyId=second;
 expect(await pending).toEqual(first);
 await snapshot(ctx,async tx=>{
  const supplied=copy(ctx),reading=getEmployeeDraftPresentationTx(tx,supplied,first.id);
  supplied.roles![0]='employee';supplied.grants![0].companyId=second;expect(await reading).toEqual(first);
 });
});

it('refuses an aborted read and blocks the row query after an actual principal statement settles into cancellation',async()=>{
 const {ctx,first}=await fixture(),abort=new AbortController(),primary=Error('Fictional request disconnected'),before=await effects();abort.abort(primary);
 expect(()=>getEmployeeDraftPresentation(ctx,first.id,abort.signal)).toThrow(primary);
 await expect(snapshot(ctx,tx=>getEmployeeDraftPresentationTx(tx,ctx,first.id,abort.signal))).rejects.toBe(primary);
 await snapshot(ctx,async tx=>{
  const during=new AbortController();let selects=0;
  const observed=new Proxy(tx,{get(target,key,receiver){
   if(key==='execute')return async(query:Parameters<Tx['execute']>[0])=>{const result=await target.execute(query);during.abort(primary);return result;};
   if(key==='select')return (...args:Parameters<Tx['select']>)=>{selects++;return Reflect.apply(target.select,target,args);};
   const value=Reflect.get(target,key,receiver);return typeof value==='function'?value.bind(target):value;
  }});
  await expect(getEmployeeDraftPresentationTx(observed,ctx,first.id,during.signal)).rejects.toBe(primary);expect(selects).toBe(0);
  expect(await getEmployeeDraftPresentationTx(tx,ctx,first.id)).toEqual(first);
 });
 expect(await effects()).toEqual(before);
});
