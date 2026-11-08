/** Actual native app-role workspace adapter checks; no live page/purpose or speed acceptance. */
import {createHash,randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {addDependent} from '../core/dependents';
import {addQualification} from '../core/qualifications';
import {addEmergencyContact} from '../core/emergency-contacts';
import {readOwnProfileWorkspace,readOwnProfileWorkspacePresentationTx} from '../core/profile-edit';
import {saveProfileEditPolicy,saveProfileVisibilityPolicy} from '../core/profile-edit-policy';
import {essVisibleFields} from '../lib/personnel-ess-contract';
import {pgSqlState} from '../lib/db-error';
import {requirePackFor} from '../localization/registry';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base,admin:SessionContext,ctx:SessionContext,e:Awaited<ReturnType<typeof hireEmployee>>;
const account='bank_statutory.bank_information.bankaccountno',preferred='profile.personal_details.preferredname',raw='123456781234';
beforeAll(migrateTestDb);beforeEach(async()=>{
 await resetDb();b=await seedBase();admin={...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]};
 e=await hireEmployee(admin,{companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01',person:{fullName:'Fictional workspace subject',primaryEmail:randomUUID()+'@example.invalid'}});
 ctx={tenantId:b.tenantId,userId:await createAppUser(b.tenantId,e.personId,'employee'),personId:e.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
});afterAll(closeAll);
async function identity(tx:Tx){
 const [row]=await tx.execute<{login:string;role:string;bypass:boolean;tableOwner:boolean;isolation:string;readOnly:boolean;pid:number;started:string;root:string;tenant:string;user:string}>(sql`
  select session_user::text as login,current_user::text as role,
   (select rolsuper or rolbypassrls from pg_roles where rolname=current_user) as bypass,
   current_user::regrole::oid=(select relowner from pg_class where oid='public.person'::regclass) as "tableOwner",
   current_setting('transaction_isolation') as isolation,current_setting('transaction_read_only')='on' as "readOnly",
   pg_backend_pid() as pid,(select backend_start::text from pg_stat_activity where pid=pg_backend_pid()) as started,
   (select virtualxid::text from pg_locks where pid=pg_backend_pid() and locktype='virtualxid' and granted and mode='ExclusiveLock') as root,
   current_setting('app.tenant_id') as tenant,current_setting('app.user_id') as "user"`);
 expect(row).toMatchObject({login:'ai_hr_app',role:'ai_hr_app',bypass:false,tableOwner:false,isolation:'read committed',readOnly:true,tenant:b.tenantId,user:ctx.userId});
 expect(row.pid).toBeGreaterThan(1);expect(row.started).toBeTruthy();expect(row.root).toMatch(/^[0-9]+\/[0-9]+$/);return row;
}
async function read(context=ctx,employmentId=e.employmentId){
 return withTenant(context,async tx=>{
  await tx.execute(sql`SET TRANSACTION READ ONLY`);
  return readOwnProfileWorkspacePresentationTx(tx,context,{employmentId});
 });
}
async function populated(){
 const pack=requirePackFor('MY');await pack.statutory.set(admin,{personId:e.personId,icNumber:'900101015020'});
 await pack.statutory.setBank(admin,{personId:e.personId,bankName:pack.client.bankNames[0],bankAccountNo:raw});
 const dependent=await addDependent(admin,{personId:e.personId,fullName:'Fictional Family',relationship:'child',dateOfBirth:'2010-01-01',icOrPassport:raw});
 const qualification=await addQualification(admin,{employmentId:e.employmentId,qualification:'Bachelor',institute:'Fictional Institute',isHighest:true});
 const emergency=await addEmergencyContact(admin,{personId:e.personId,fullName:'Fictional Primary',priority:'primary',mobilePhone:'0123456789'});
 return{dependent:dependent.id,qualification:qualification.id,emergency:emergency.id};
}
async function effects(){
 // Fixture/private comparisons only: no raw row, identifier, value or revision is exported.
 const [row]=await owner.client`select jsonb_build_object(
  'person',(select coalesce(jsonb_agg(jsonb_build_object('row',to_jsonb(t),'xmin',t.xmin::text) order by t.id),'[]'::jsonb) from person t),
  'employment',(select coalesce(jsonb_agg(jsonb_build_object('row',to_jsonb(t),'xmin',t.xmin::text) order by t.id),'[]'::jsonb) from employment t),
  'statutory',(select coalesce(jsonb_agg(jsonb_build_object('row',to_jsonb(t),'xmin',t.xmin::text) order by t.id),'[]'::jsonb) from employee_statutory_my t),
  'family',(select coalesce(jsonb_agg(jsonb_build_object('row',to_jsonb(t),'xmin',t.xmin::text) order by t.id),'[]'::jsonb) from employee_dependent t),
  'qualification',(select coalesce(jsonb_agg(jsonb_build_object('row',to_jsonb(t),'xmin',t.xmin::text) order by t.id),'[]'::jsonb) from employee_qualification t),
  'emergency',(select coalesce(jsonb_agg(jsonb_build_object('row',to_jsonb(t),'xmin',t.xmin::text) order by t.id),'[]'::jsonb) from person_emergency_contact t),
  'events',(select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]'::jsonb) from domain_event t),
  'requests',(select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]'::jsonb) from profile_change_request t)) as value`;
 return row.value;
}
it('preserves the entire populated legacy DTO, register order and exact native masked CAS tokens on one real app carrier',async()=>{
 const ids=await populated(),before=await effects(),expected=await readOwnProfileWorkspace(ctx,{employmentId:e.employmentId});
 const actual=await withTenant(ctx,async tx=>{
  await tx.execute(sql`SET TRANSACTION READ ONLY`);const before=await identity(tx);
  const value=await readOwnProfileWorkspacePresentationTx(tx,ctx,{employmentId:e.employmentId});expect(await identity(tx)).toEqual(before);return value;
 });
 expect(actual).toEqual(expected);expect(actual.employmentId).toBe(e.employmentId);expect(actual.personId).toBe(e.personId);expect(actual.country).toBe('MY');
 expect(actual.visible!.length).toBeGreaterThan(0);expect(actual.registers.map(row=>row.id)).toEqual([ids.dependent,ids.qualification,ids.emergency]);
 expect(actual.registers[2].primary).toBe(true);expect(actual.values[account]).toBe('•••• 1234');expect(actual.baselines[account]).toMatch(/^profile-row:v1:[a-f0-9]{64}$/);
 const snapshot=await requirePackFor('MY').statutory.getEditSnapshot!(ctx,e.personId);
 const tuple=['profile-row:v1',b.tenantId,e.personId,e.employmentId,'MY','statutory',snapshot!.rowId,snapshot!.revision,account];
 expect(actual.baselines[account]).toBe('profile-row:v1:'+createHash('sha256').update(JSON.stringify(tuple)).digest('hex'));
 expect(JSON.stringify(actual)).not.toContain(raw);expect(await effects()).toEqual(before);
});
it('observes actual new MVCC revisions while retaining masks when a fixture write keeps updatedAt unchanged',async()=>{
 await populated();const first=await read(),old=await requirePackFor('MY').statutory.get(admin,e.personId);
 await owner.db.update(s.employeeStatutoryMy).set({bankAccountNo:'234567891234',updatedAt:old!.updatedAt}).where(eq(s.employeeStatutoryMy.personId,e.personId));
 const before=await effects(),next=await read();expect(next).toEqual(await readOwnProfileWorkspace(ctx,{employmentId:e.employmentId}));
 expect(next.values[account]).toBe(first.values[account]);expect(next.baselines[account]).not.toBe(first.baselines[account]);expect(await effects()).toEqual(before);
});
it('reads current policy itself and strips newly hidden values and baseline metadata',async()=>{
 await populated();await saveProfileEditPolicy(admin,{keys:[preferred],withdrawnReason:'Fictional editable field'});
 expect((await read()).editable).toContain(preferred);
 const fields=Object.fromEntries(essVisibleFields().map(field=>[field.id,'viewOnly']));fields[account]='hide';fields[preferred]='hide';
 await saveProfileVisibilityPolicy(admin,{policy:{version:3,fields,primaryOnly:[]},withdrawnReason:'Fictional visibility change'});
 const before=await effects(),actual=await read();expect(actual).toEqual(await readOwnProfileWorkspace(ctx,{employmentId:e.employmentId}));
 expect(actual.values).not.toHaveProperty(account);expect(actual.baselines).not.toHaveProperty(account);expect(actual.values).not.toHaveProperty(preferred);expect(actual.editable).toEqual([]);expect(await effects()).toEqual(before);
});
it('refuses foreign employments and forged person/tenant contexts on the actual owner carrier',async()=>{
 const other=await hireEmployee(admin,{companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01',person:{fullName:'Fictional foreign subject',primaryEmail:randomUUID()+'@example.invalid'}});
 const foreign=await seedBase(),before=await effects();
 await expect(read(ctx,other.employmentId)).rejects.toMatchObject({code:'permission'});
 for(const forged of [{...ctx,personId:other.personId},{...ctx,tenantId:foreign.tenantId}])await expect(withTenant(ctx,async tx=>{
  await tx.execute(sql`SET TRANSACTION READ ONLY`);return readOwnProfileWorkspacePresentationTx(tx,forged,{employmentId:e.employmentId});
 })).rejects.toThrow('calling authority');
 expect(await effects()).toEqual(before);
});
it('refuses a stale grant or archived login rather than accepting serialized caller identity',async()=>{
 const before=await effects();await owner.db.delete(s.roleAssignment).where(eq(s.roleAssignment.appUserId,ctx.userId!));
 await expect(read()).rejects.toThrow('calling authority');
 await owner.db.insert(s.roleAssignment).values({tenantId:b.tenantId,appUserId:ctx.userId!,role:'employee',companyId:null});
 await owner.db.update(s.appUser).set({archivedAt:new Date()}).where(eq(s.appUser.id,ctx.userId!));await expect(read()).rejects.toThrow('calling authority');
 expect(await effects()).toEqual(before);
});
it('requires actual native RC/RO and refuses writes and row locks while preserving a settled parent read',async()=>{
 const before=await effects();
 expect(await withTenant(ctx,tx=>readOwnProfileWorkspacePresentationTx(tx,ctx,{employmentId:e.employmentId})).then(()=>null,pgSqlState)).toBe('42501');
 expect(await withTenant(ctx,tx=>readOwnProfileWorkspacePresentationTx(tx,ctx,{employmentId:e.employmentId}),{readOnlySnapshot:true}).then(()=>null,pgSqlState)).toBe('42501');
 await withTenant(ctx,async tx=>{
  await tx.execute(sql`SET TRANSACTION READ ONLY`);const value=await readOwnProfileWorkspacePresentationTx(tx,ctx,{employmentId:e.employmentId});
  for(const operation of [(nested:Tx)=>nested.update(s.person).set({preferredName:'Forbidden'}).where(eq(s.person.id,e.personId)),(nested:Tx)=>nested.select().from(s.person).where(eq(s.person.id,e.personId)).for('update')]){
   const error=await tx.transaction(async nested=>{await operation(nested);}).then(()=>undefined,error=>error);expect(pgSqlState(error)).toBe('25006');
   expect(await readOwnProfileWorkspacePresentationTx(tx,ctx,{employmentId:e.employmentId})).toEqual(value);
  }
 });expect(await effects()).toEqual(before);
});
it('overlaps independent physical row writers and shared policy readers while the legacy command course retains FOR UPDATE',async()=>{
 const ids=await populated(),expected=await read(),before=await effects();
 await owner.client.begin(async holder=>{
  for(const namespace of ['access-configuration:','profile-edit-policy:'])await holder`select pg_advisory_xact_lock_shared(hashtextextended(${namespace+b.tenantId},0))`;
  expect(await holder`select id from employment where id=${e.employmentId}::uuid for update`).toHaveLength(1);
  expect(await holder`select id from person where id=${e.personId}::uuid for update`).toHaveLength(1);
  expect(await holder`select id from employee_statutory_my where person_id=${e.personId}::uuid for update`).toHaveLength(1);
  expect(await holder`select id from employee_dependent where id=${ids.dependent}::uuid for update`).toHaveLength(1);
  expect(await holder`select id from employee_qualification where id=${ids.qualification}::uuid for update`).toHaveLength(1);
  expect(await holder`select id from person_emergency_contact where id=${ids.emergency}::uuid for update`).toHaveLength(1);
  await withTenant(ctx,async tx=>{
   await tx.execute(sql`SET TRANSACTION READ ONLY`);await tx.execute(sql`set local lock_timeout='300ms'`);await tx.execute(sql`set local statement_timeout='3s'`);
   expect(await readOwnProfileWorkspacePresentationTx(tx,ctx,{employmentId:e.employmentId})).toEqual(expected);
  });
  // Supplied presentation metadata never turns an existing command carrier into display.
  const presentation={ctx,editable:new Set<string>(),legacyPrimary:new Set<string>(),visible:new Set(expected.visible)};
  const error=await withTenant(ctx,async tx=>{
   await tx.execute(sql`set local lock_timeout='300ms'`);return readOwnProfileWorkspace(ctx,{employmentId:e.employmentId},presentation,tx);
  }).then(()=>null,pgSqlState);expect(error).toBe('55P03');
 });expect(await effects()).toEqual(before);
});
it('preserves shared Access and profile barriers against actual exclusive metadata writers',async()=>{
 const before=await effects();
 for(const namespace of ['access-configuration:','profile-edit-policy:'])await owner.client.begin(async holder=>{
  await holder`select pg_advisory_xact_lock(hashtextextended(${namespace+b.tenantId},0))`;
  const state=await withTenant(ctx,async tx=>{
   await tx.execute(sql`SET TRANSACTION READ ONLY`);await tx.execute(sql`set local lock_timeout='300ms'`);
   return readOwnProfileWorkspacePresentationTx(tx,ctx,{employmentId:e.employmentId});
  }).then(()=>null,pgSqlState);expect(state).toBe('55P03');
 });expect(await effects()).toEqual(before);
});
it.each(['dependent','qualification','emergency'] as const)('keeps the exact 500-row bound and 501-row refusal for %s without exposing partial data',async kind=>{
 // Direct owner fixture population exercises the existing hard bound, not a production write path.
 const values=Array.from({length:500},(_,i)=>({tenantId:b.tenantId,fullName:'Fictional bounded '+i,personId:e.personId}));
 if(kind==='dependent')await owner.db.insert(s.employeeDependent).values(values.map(row=>({...row,relationship:'other'})));
 if(kind==='qualification')await owner.db.insert(s.employeeQualification).values(values.map(row=>({tenantId:row.tenantId,employmentId:e.employmentId,qualification:'Bachelor',description:row.fullName})));
 if(kind==='emergency')await owner.db.insert(s.personEmergencyContact).values(values);
 const actual=await read();expect(actual.registers).toHaveLength(500);expect(actual).toEqual(await readOwnProfileWorkspace(ctx,{employmentId:e.employmentId}));
 if(kind==='dependent')await owner.db.insert(s.employeeDependent).values({...values[0],fullName:'Fictional overflow',relationship:'other'});
 if(kind==='qualification')await owner.db.insert(s.employeeQualification).values({tenantId:b.tenantId,employmentId:e.employmentId,qualification:'Bachelor',description:'Fictional overflow'});
 if(kind==='emergency')await owner.db.insert(s.personEmergencyContact).values({...values[0],fullName:'Fictional overflow'});
 const before=await effects();await expect(read()).rejects.toMatchObject({code:'unavailable'});await expect(readOwnProfileWorkspace(ctx,{employmentId:e.employmentId})).rejects.toMatchObject({code:'unavailable'});expect(await effects()).toEqual(before);
});
