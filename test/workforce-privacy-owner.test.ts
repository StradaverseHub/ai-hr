/** Prepared actual-runtime privacy/Workforce compatibility cases. Requires all three leases. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {withTenant,type SessionContext} from '../db/client';
import {person,employment,employeeDependent,personEmergencyContact,employeeStatutoryMy,domainEvent} from '../db/schema';
import {hireEmployee} from '../core/org';
import {erasePersonPii,RETENTION_YEARS} from '../core/pdpa';
import {accessConfigurationStore} from '../core/access-configuration-store';
import {previewAccessConfiguration,saveAccessConfiguration} from '../core/access-configuration';
import {todayInKualaLumpur} from '../lib/hr-date';
import {pgSqlState} from '../lib/db-error';

let b:Base;
const admin=()=>({...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]});
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();await owner.db.execute(sql`update access_capability set supported=false,bindings='[]'::jsonb where id in ('workforce.view','workforce.maintain')`);});
afterAll(async()=>{try{await owner.db.execute(sql`update access_capability set supported=false,bindings='[]'::jsonb where id in ('workforce.view','workforce.maintain')`);}finally{await closeAll();}});
async function override(userId:string,effect:'allow'|'deny',capabilityId:'workforce.view'|'workforce.maintain'='workforce.maintain'){
 const before=await withTenant(admin(),tx=>accessConfigurationStore.loadCurrent(tx,admin()));
 const edit={expectedRevision:before.snapshot.revision,command:{kind:'setOverride' as const,userId,capabilityId,companyId:b.companyId,effect}};
 const preview=await previewAccessConfiguration(admin(),edit,accessConfigurationStore);
 await saveAccessConfiguration(admin(),{...edit,previewFingerprint:preview.fingerprint},accessConfigurationStore);
}
async function fixture(deny=true){
 const subject=await hireEmployee(admin(),{person:{fullName:'Fictional privacy subject',primaryEmail:`${randomUUID()}@example.invalid`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
 await owner.db.update(person).set({phone:'0123456789',personalEmail:'private@example.invalid',dateOfBirth:'1990-05-05'}).where(eq(person.id,subject.personId));
 await owner.db.insert(employeeDependent).values({tenantId:b.tenantId,personId:subject.personId,fullName:'Fictional family',relationship:'child',phone:'0199999999',icOrPassport:'FICTIONAL-DEPENDENT-ID'});
 await owner.db.insert(personEmergencyContact).values({tenantId:b.tenantId,personId:subject.personId,fullName:'Fictional contact',mobilePhone:'0188888888',priority:'primary'});
 await owner.db.insert(employeeStatutoryMy).values({tenantId:b.tenantId,personId:subject.personId,icNumber:'950505051234',bankName:'Fictional bank',bankAccountNo:'FICTIONAL-BANK'}).onConflictDoUpdate({target:employeeStatutoryMy.personId,set:{bankName:'Fictional bank',bankAccountNo:'FICTIONAL-BANK'}});
 await owner.db.execute(sql`update access_capability set supported=true,bindings='[{"owner":"privacy-compatibility-fixture","operation":"read-write"}]'::jsonb where id in ('workforce.view','workforce.maintain')`);
 if(deny)await override(b.adminUserId,'deny');
 return subject;
}
async function snapshot(personId:string){
 return {
  person:await owner.db.select().from(person).where(eq(person.id,personId)),
  family:await owner.db.select().from(employeeDependent).where(eq(employeeDependent.personId,personId)).orderBy(employeeDependent.id),
  contacts:await owner.db.select().from(personEmergencyContact).where(eq(personEmergencyContact.personId,personId)).orderBy(personEmergencyContact.id),
  statutory:await owner.db.select().from(employeeStatutoryMy).where(eq(employeeStatutoryMy.personId,personId)),
  events:await owner.db.select({id:domainEvent.id}).from(domainEvent).orderBy(domainEvent.id),
 };
}
async function refused(work:Promise<unknown>){
 const error=await work.then(()=>null,error=>error);expect(error).not.toBeNull();expect(pgSqlState(error)).toBe('42501');
}
const input=(employmentId:string)=>({subjectEmploymentId:employmentId,scope:'contact' as const,reason:'Fictional privacy request',requestRef:'FICTIONAL-DPO-REFERENCE'});
describe('independent privacy owner and finite erasure witnesses',()=>{
 it('keeps actual admin contact erasure while direct Workforce values refuse; retained identity/statutory facts are unchanged',async()=>{
  const subject=await fixture();const before=await snapshot(subject.personId);
  await refused(withTenant(admin(),tx=>tx.update(person).set({phone:null}).where(eq(person.id,subject.personId))));
  expect(await snapshot(subject.personId)).toEqual(before);
  const result=await erasePersonPii(admin(),input(subject.employmentId));
  expect(result.erased).toEqual(expect.arrayContaining(['phone','personalEmail','dependent.phone','emergencyContacts']));
  const after=await snapshot(subject.personId);
  expect(after.person[0]).toMatchObject({phone:null,personalEmail:null,dateOfBirth:'1990-05-05'});
  expect(after.family[0]).toMatchObject({phone:null,icOrPassport:'FICTIONAL-DEPENDENT-ID'});
  expect(after.contacts).toEqual([]);expect(after.statutory).toEqual(before.statutory);
  expect(after.events.length).toBeGreaterThan(before.events.length);
  expect((await owner.db.select({id:domainEvent.id}).from(domainEvent).where(eq(domainEvent.eventType,'pii.erased')))).toHaveLength(1);
  await refused(withTenant(admin(),tx=>tx.update(person).set({phone:'NEW-UNAUTHORIZED-VALUE'}).where(eq(person.id,subject.personId))));
  // A prior successful transaction's private proof cannot authorize later raw nulling either.
  await owner.db.update(person).set({phone:'FICTIONAL-REPOPULATED'}).where(eq(person.id,subject.personId));
  await refused(withTenant(admin(),tx=>tx.update(person).set({phone:null}).where(eq(person.id,subject.personId))));
 });
 it('preserves statutory retention in all-scope erasure under the separate privacy authority',async()=>{
  const subject=await fixture();const before=await snapshot(subject.personId);
  const result=await erasePersonPii(admin(),{...input(subject.employmentId),scope:'all'});
  expect(result.withheld.map(row=>row.field)).toEqual(expect.arrayContaining(['dateOfBirth','bankName','bankAccountNo']));
  const after=await snapshot(subject.personId);
  expect(after.person[0].dateOfBirth).toBe('1990-05-05');expect(after.statutory[0].bankAccountNo).toBe(before.statutory[0].bankAccountNo);
  expect(RETENTION_YEARS).toBe(7);
 });
 it('retains the same independent erasure course after the existing statutory hold has lifted',async()=>{
  const subject=await fixture();
  const terminatedOn=`${Number(todayInKualaLumpur().slice(0,4))-RETENTION_YEARS-1}-01-01`;
  await owner.db.update(employment).set({hiredOn:'2000-01-01',terminatedOn}).where(eq(employment.id,subject.employmentId));
  const result=await erasePersonPii(admin(),{...input(subject.employmentId),scope:'all'});
  expect(result.withheld).toEqual([]);
  const after=await snapshot(subject.personId);
  expect(after.person[0].dateOfBirth).toBeNull();expect(after.statutory[0].bankAccountNo).toBeNull();
  expect(after.family[0].icOrPassport).toBeNull();expect(after.contacts).toEqual([]);
 });
 it('does not turn positive non-HR maintenance, a forged role snapshot or a definer into privacy authority',async()=>{
  const subject=await fixture(false);const userId=await createAppUser(b.tenantId,subject.personId,'employee');
  await override(userId,'allow');
  await override(userId,'allow','workforce.view');
  const ctx:SessionContext={...admin(),userId,personId:subject.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
  const [positive]=await withTenant(ctx,tx=>tx.execute<{allowed:boolean}>(sql`select app.access_workforce_command_allowed(${subject.employmentId}::uuid) as allowed`));
  expect(positive.allowed).toBe(true);
  const [raw]=await withTenant(ctx,tx=>tx.execute<{allowed:boolean}>(sql`select app.access_workforce_employment(${subject.employmentId}::uuid,'workforce.maintain') as allowed`));
  expect(raw.allowed).toBe(false);
  const before=await snapshot(subject.personId);
  for(const actor of [ctx,{...ctx,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]}])await refused(erasePersonPii(actor,input(subject.employmentId)));
  await owner.db.execute(sql`create function public.privacy_borrowed_owner(p uuid) returns timestamptz language sql security definer set search_path=pg_catalog,public as $$select app.access_privacy_erasure_begin(p,'contact','FICTIONAL-DPO-REFERENCE','Fictional privacy request')$$`);
  await owner.db.execute(sql`grant execute on function public.privacy_borrowed_owner(uuid) to ai_hr_app`);
  try{await refused(withTenant(ctx,tx=>tx.execute(sql`select public.privacy_borrowed_owner(${subject.employmentId}::uuid)`)));}
  finally{await owner.db.execute(sql`drop function public.privacy_borrowed_owner(uuid)`);}
  expect(await snapshot(subject.personId)).toEqual(before);
 });
 it.each(['missing-audit','arbitrary-value','retained-dob','partial-effects'] as const)('refuses %s without leaving values or an erasure event',async kind=>{
  const subject=await fixture();const before=await snapshot(subject.personId);
  await refused(withTenant(admin(),async tx=>{
   await tx.execute(sql`select app.access_privacy_erasure_begin(${subject.employmentId}::uuid,'contact','FICTIONAL-DPO-REFERENCE','Fictional privacy request')`);
   await tx.update(person).set(kind==='arbitrary-value'?{phone:'NOT-AN-ERASURE'}:kind==='retained-dob'?{dateOfBirth:null}:{phone:null}).where(eq(person.id,subject.personId));
   if(kind==='partial-effects')await tx.insert(domainEvent).values({tenantId:b.tenantId,aggregateType:'person',aggregateId:subject.personId,subjectEmploymentId:subject.employmentId,eventType:'pii.erased',actorType:'user',actorId:b.adminUserId,payload:{scope:'contact',requestRef:'FICTIONAL-DPO-REFERENCE',reason:'Fictional privacy request',erasedFields:['phone'],withheld:[]}});
  }));
  expect(await snapshot(subject.personId)).toEqual(before);
 });
 it.each(['scope','requestRef','reason'] as const)('requires the real completed audit to retain its prepared %s',async key=>{
  const subject=await fixture();const before=await snapshot(subject.personId);
  // key is the closed test-case enum above; a PostgreSQL function body cannot bind outer parameters.
  await owner.db.execute(sql.raw(`create function public.privacy_audit_drift() returns trigger language plpgsql as $$begin if NEW.event_type='pii.erased' then NEW.payload:=jsonb_set(NEW.payload,ARRAY['${key}'],to_jsonb('DRIFTED'::text));end if;return NEW;end$$`));
  await owner.db.execute(sql`create trigger privacy_audit_drift before insert on domain_event for each row execute function public.privacy_audit_drift()`);
  try{await refused(erasePersonPii(admin(),input(subject.employmentId)));}
  finally{await owner.db.execute(sql`drop trigger privacy_audit_drift on domain_event`);await owner.db.execute(sql`drop function public.privacy_audit_drift()`);}
  expect(await snapshot(subject.personId)).toEqual(before);
 });
 it('keeps proof storage and the erasure field-policy owner private to their actual owner',async()=>{
  await fixture();
  await refused(withTenant(admin(),tx=>tx.execute(sql`select * from app.access_privacy_value_intent`)));
  await refused(withTenant(admin(),tx=>tx.execute(sql`select app.access_privacy_erasure_policy()`)));
 });
});
