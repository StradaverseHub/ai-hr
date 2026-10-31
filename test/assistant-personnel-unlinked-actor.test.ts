/** Exact native USER-without-PERSON parity. Authored for hosted migrated DB verification only. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import * as s from '../db/schema';
import * as vault from '../lib/pii/vault';
import {pgSqlState} from '../lib/db-error';
import {todayInKualaLumpur} from '../lib/hr-date';
import {hireEmployee} from '../core/org';
import {addQualification,addEmergencyContact,addDependent} from '../core/workforce-registers';
import {setCompensation} from '../core/comp';
import {maintainWorkforceRecord,workforceEditor,workforceEditorTx} from '../core/workforce-maintenance';
import {workforceMaintenanceFields} from '../lib/workforce-maintenance-fields';
import {requirePackFor} from '../localization/registry';
import {grantAssistant} from '../core/assistant-grant';
import {accessConfigurationStore} from '../core/access-configuration-store';
import {previewAccessConfiguration,saveAccessConfiguration} from '../core/access-configuration';
import {qualificationMaintenanceReviews,readQualificationMaintenanceChoices} from '../core/assistant-actions/qualification-maintenance-review-store';
import {compensationMaintenanceReviews,readCompensationMaintenanceChoices} from '../core/assistant-actions/compensation-maintenance-review-store';
import {emergencyContactMaintenanceReviews,readEmergencyContactMaintenanceChoices} from '../core/assistant-actions/emergency-contact-maintenance-review-store';
import {workforceProfileMaintenanceReviews,readWorkforceProfileMaintenanceChoices} from '../core/assistant-actions/workforce-profile-maintenance-review-store';
import {familyMaintenanceReviews,readFamilyMaintenanceChoices} from '../core/assistant-actions/family-maintenance-review-store';
import {bankMaintenanceReviews,readBankMaintenanceChoices} from '../core/assistant-actions/bank-maintenance-review-store';
import {adminCtx,closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
type Target={employmentId:string;personId:string};
type Review={actionId:string;reviewedDigest:string};
type Store={prepare(ctx:SessionContext,input:unknown):Promise<{review:Review}>;confirm(ctx:SessionContext,input:Review):Promise<unknown>;reopen(ctx:SessionContext,id:string):Promise<unknown>};
type Selection={query:string;employmentId:string};
type Adapter={action:string;event:string;store:Store;choices(ctx:SessionContext,selection:Selection):Promise<unknown>;input(ctx:SessionContext):Promise<unknown>;native(tx:Tx,ctx:SessionContext):Promise<unknown>};
let b:Base,target:Target,otherTarget:Target,actor:SessionContext,otherActor:SessionContext;
const root=()=>({...adminCtx(b),grants:[{role:'hr_admin' as const,companyId:null}]});
const hire=(name:string)=>hireEmployee(root(),{person:{fullName:name,primaryEmail:randomUUID()+'@fictional.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
/** A real USER and real role assignment, deliberately no staff record or synthetic Person. */
async function unlinked(role:'hr_admin'|'employee'='hr_admin'):Promise<SessionContext>{
 const [user]=await owner.db.insert(s.appUser).values({tenantId:b.tenantId,workosUserId:'user_'+randomUUID(),personId:null}).returning({id:s.appUser.id});
 await owner.db.insert(s.roleAssignment).values({tenantId:b.tenantId,appUserId:user.id,role,companyId:null});await grantAssistant(root(),{appUserId:user.id});
 return{...await entitledCtx(b,[role]),userId:user.id,personId:null,roles:[role],grants:[{role,companyId:null}]};
}
const qualification=()=>({qualification:'Bachelor',description:'Human qualification',fromYm:null,toYm:null,institute:'Fictional Institute',major:null,graduationDate:null,result:null,isHighest:false});
const emergency=()=>({fullName:'Fictional Emergency Contact',relationship:null,mobilePhone:'000-FICTIONAL',homePhone:null,address:null,remarks:'Human note',priority:'primary' as const});
const family=()=>({fullName:'Fictional Family Member',relationship:'child',dateOfBirth:'2015-01-01',gender:null,icOrPassport:null,phone:null,remarks:'Human note',passportNumber:null,residentialAddress:null,deceasedOn:null,marriageDate:null,marriageStatus:null,occupation:null,companyName:null,employerAddress:null,schoolName:null,studyLevel:null,studyCountry:null,childReliefCategory:null,isBeneficiary:false,isDeceased:false,spouseWorking:null,isStudent:null,childTaxRelief:null,childReliefPercentage:null});
const bank=()=>({bankName:requirePackFor('MY').client.bankNames[0],bankAccountNo:'000-FICTIONAL-NEW',enableCustomHolderName:false,customHolderName:null,enableCustomHolderId:false,customHolderId:null});
async function profile(ctx:SessionContext,tx?:Tx){const row=tx?await workforceEditorTx(tx,target.employmentId):await workforceEditor(ctx,target.employmentId);if(!row)throw Error('Expected native Workforce workspace');return{expectedVersion:row.profileVersion,values:{...Object.fromEntries(workforceMaintenanceFields('person','personal').map(({key})=>[key,row.profile[key as keyof typeof row.profile]])),preferredName:'Fictional reviewed name'}};}
function input(action:string,subjectId:string,extra:Record<string,unknown>){return{action,contractVersion:1,employmentId:target.employmentId,subjectId,...extra};}
const ADAPTERS:Adapter[]=[
 {action:'employees.qualification.maintain',event:'qualification.added',store:qualificationMaintenanceReviews,choices:readQualificationMaintenanceChoices,input:async()=>input('employees.qualification.maintain',target.employmentId,{operation:'add',qualificationId:null,fields:qualification()}),native:(tx,ctx)=>addQualification(ctx,{employmentId:target.employmentId,...qualification()},tx)},
 {action:'employees.compensation.maintain',event:'compensation.set',store:compensationMaintenanceReviews,choices:readCompensationMaintenanceChoices,input:async()=>input('employees.compensation.maintain',target.employmentId,{operation:'set',compensationId:null,fields:{basicSalary:'2500.00',currency:'MYR',payMode:'monthly',paymentTerm:'monthly',rateAmount:null,remarks:'Fictional human pay',effectiveFrom:todayInKualaLumpur()}}),native:(tx,ctx)=>setCompensation(ctx,{employmentId:target.employmentId,basicSalary:2500,currency:'MYR',payMode:'monthly',paymentTerm:'monthly',rateAmount:null,remarks:'Fictional human pay',effectiveFrom:todayInKualaLumpur()},tx)},
 {action:'employees.emergency_contact.maintain',event:'emergency-contact.added',store:emergencyContactMaintenanceReviews,choices:readEmergencyContactMaintenanceChoices,input:async()=>input('employees.emergency_contact.maintain',target.personId,{operation:'add',contactId:null,fields:emergency()}),native:(tx,ctx)=>addEmergencyContact(ctx,{personId:target.personId,...emergency()},tx)},
 {action:'employees.workforce_profile.maintain',event:'person.updated',store:workforceProfileMaintenanceReviews,choices:readWorkforceProfileMaintenanceChoices,input:async ctx=>input('employees.workforce_profile.maintain',target.employmentId,{section:'personal',...await profile(ctx)}),native:async(tx,ctx)=>{const p=await profile(ctx,tx);return maintainWorkforceRecord(ctx,{employmentId:target.employmentId,kind:'person',rowId:null,operation:'update',patch:p.values,expectedVersion:p.expectedVersion},tx);}},
 {action:'employees.family.maintain',event:'dependent.added',store:familyMaintenanceReviews,choices:readFamilyMaintenanceChoices,input:async()=>input('employees.family.maintain',target.personId,{operation:'add',dependentId:null,fields:family()}),native:(tx,ctx)=>addDependent(ctx,{personId:target.personId,...family()},tx)},
 {action:'employees.bank.maintain',event:'employee.bank.updated',store:bankMaintenanceReviews,choices:readBankMaintenanceChoices,input:async()=>input('employees.bank.maintain',target.personId,{fields:bank()}),native:(tx,ctx)=>requirePackFor('MY').statutory.setBank(ctx,{personId:target.personId,...bank()},tx)},
];
async function prepare(adapter:Adapter,ctx:SessionContext){
 const {review:{actionId,reviewedDigest}}=await adapter.store.prepare(ctx,await adapter.input(ctx));
 return{actionId,reviewedDigest};
}
async function business(){return{people:await owner.db.select().from(s.person).where(eq(s.person.tenantId,b.tenantId)).orderBy(s.person.id),employment:await owner.db.select().from(s.employment).where(eq(s.employment.tenantId,b.tenantId)).orderBy(s.employment.id),qualification:await owner.db.select().from(s.employeeQualification).where(eq(s.employeeQualification.tenantId,b.tenantId)).orderBy(s.employeeQualification.id),emergency:await owner.db.select().from(s.personEmergencyContact).where(eq(s.personEmergencyContact.tenantId,b.tenantId)).orderBy(s.personEmergencyContact.id),family:await owner.db.select().from(s.employeeDependent).where(eq(s.employeeDependent.tenantId,b.tenantId)).orderBy(s.employeeDependent.id),statutory:await owner.db.select().from(s.employeeStatutoryMy).where(eq(s.employeeStatutoryMy.tenantId,b.tenantId)).orderBy(s.employeeStatutoryMy.id),compensation:await owner.db.select().from(s.compensation).where(eq(s.compensation.tenantId,b.tenantId)).orderBy(s.compensation.id),events:await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.tenantId,b.tenantId)).orderBy(s.domainEvent.sequence)};}
async function ledger(id:string){const [row]=await owner.db.execute<{actorPersonId:string|null;userId:string;employmentId:string;companyId:string;subjectPersonId:string;state:string;eventId:string|null;bodies:number}>(sql`select r.person_id as "actorPersonId",r.user_id as "userId",r.employment_id as "employmentId",r.company_id as "companyId",r.decision_subject_person_id as "subjectPersonId",r.state,r.receipt_event_id as "eventId",(select count(*)::int from app.assistant_own_leave_review_content c where c.action_id=r.id) as bodies from app.assistant_own_leave_review r where r.id=${id}::uuid`);return row;}
class NativeRollback extends Error{}
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-unlinked-personnel-custody-key');await resetDb();b=await seedBase();for(const code of ['assistant','payroll','country-my'])await setModule(b.tenantId,code,'active');target=await hire('Fictional Unlinked Actor Target');otherTarget=await hire('Fictional Existing Relink Target');actor=await unlinked();otherActor=await unlinked();await requirePackFor('MY').statutory.set(root(),{personId:target.personId,icNumber:null,bankName:'Legacy Fictional Bank',bankAccountNo:'000-FICTIONAL-OLD'});});
describe('Current six Personnel kinds preserve native unlinked USER authority',()=>{
 it.each(ADAPTERS)('$action executes the SAME native command, then reviews/confirms/replays with actor Person NULL',async adapter=>{
  const before=await business();await expect(withTenant(actor,async tx=>{await adapter.native(tx,actor);throw new NativeRollback();})).rejects.toBeInstanceOf(NativeRollback);expect(await business()).toEqual(before);
  expect(await adapter.choices(actor,{query:'',employmentId:target.employmentId})).toMatchObject({kind:'choices',employees:expect.arrayContaining([expect.objectContaining({employmentId:target.employmentId})])});expect(await adapter.choices(otherActor,{query:'',employmentId:target.employmentId})).toMatchObject({kind:'choices'});
  const r=await prepare(adapter,actor);expect(await business()).toEqual(before);expect(await ledger(r.actionId)).toMatchObject({actorPersonId:null,userId:actor.userId,employmentId:target.employmentId,companyId:b.companyId,subjectPersonId:target.personId,state:'awaiting_confirmation',bodies:1});
  const unwrap=vi.spyOn(vault,'unwrapDek');await expect(adapter.store.reopen(otherActor,r.actionId)).rejects.toThrow();await expect(adapter.store.confirm(otherActor,r)).rejects.toThrow();expect(unwrap).not.toHaveBeenCalled();unwrap.mockRestore();
  expect(await adapter.store.reopen(actor,r.actionId)).toMatchObject({kind:'prepared',review:{actionId:r.actionId}});const done=await adapter.store.confirm(actor,r);expect(done).toMatchObject({kind:'completed'});expect(await adapter.store.confirm(actor,r)).toEqual(done);expect(await adapter.store.reopen(actor,r.actionId)).toEqual(done);
  const held=await ledger(r.actionId);expect(held).toMatchObject({actorPersonId:null,userId:actor.userId,employmentId:target.employmentId,companyId:b.companyId,subjectPersonId:target.personId,state:'completed',bodies:0});expect(held.eventId).toBeTruthy();const events=await owner.db.select().from(s.domainEvent).where(sql`${s.domainEvent.tenantId}=${b.tenantId}::uuid and ${s.domainEvent.actorId}=${actor.userId}::uuid and ${s.domainEvent.eventType}=${adapter.event}`);expect(events).toHaveLength(1);expect(events[0]).toMatchObject({id:held.eventId,actorType:'user',actorId:actor.userId,subjectEmploymentId:target.employmentId});
 });
 it.each(ADAPTERS)('$action refuses stale and refreshed sessions after its unlinked actor is relinked, before decrypt/effects',async adapter=>{
  const r=await prepare(adapter,actor);await owner.db.update(s.appUser).set({personId:otherTarget.personId}).where(eq(s.appUser.id,actor.userId!));const before=await business(),fresh={...actor,personId:otherTarget.personId},unwrap=vi.spyOn(vault,'unwrapDek');for(const session of [actor,fresh]){await expect(adapter.store.reopen(session,r.actionId)).rejects.toThrow();await expect(adapter.store.confirm(session,r)).rejects.toThrow();}expect(unwrap).not.toHaveBeenCalled();expect(await business()).toEqual(before);expect(await ledger(r.actionId)).toMatchObject({actorPersonId:null,state:'awaiting_confirmation',bodies:1,eventId:null});
 });
 it.each(ADAPTERS)('$action still checks the actual current native HR role before private body or effects',async adapter=>{
  const r=await prepare(adapter,actor);
  await owner.db.delete(s.roleAssignment).where(eq(s.roleAssignment.appUserId,actor.userId!));
  const before=await business(),unwrap=vi.spyOn(vault,'unwrapDek');
  expect(await adapter.choices(actor,{query:'',employmentId:target.employmentId})).toEqual({kind:'unavailable'});
  await expect(adapter.store.reopen(actor,r.actionId)).rejects.toThrow();await expect(adapter.store.confirm(actor,r)).rejects.toThrow();
  expect(unwrap).not.toHaveBeenCalled();expect(await business()).toEqual(before);expect(await ledger(r.actionId)).toMatchObject({actorPersonId:null,state:'awaiting_confirmation',bodies:1,eventId:null});
 });
 it.each(ADAPTERS)('$action still requires selected employment/company and rejects every testing-column hybrid',async adapter=>{
  const r=await prepare(adapter,actor);
  for(const column of ['employment_id','company_id','testing_execution_id','testing_run_id','testing_event_id']){let error:unknown;try{await owner.db.execute(sql`update app.assistant_own_leave_review set ${sql.identifier(column)}=${column==='employment_id'||column==='company_id'?sql`NULL`:sql`${randomUUID()}::uuid`} where id=${r.actionId}::uuid`);}catch(cause){error=cause;}expect(pgSqlState(error),column).toBe('23514');}
  expect(await ledger(r.actionId)).toMatchObject({actorPersonId:null,employmentId:target.employmentId,companyId:b.companyId,state:'awaiting_confirmation',bodies:1});
 });
 it('keeps positive unlinked non-HR Workforce authority through native profile command and review, without creating actor staff identity',async()=>{
  const who=await unlinked('employee');await owner.db.execute(sql`update access_capability set supported=true,bindings='[{"owner":"unlinked-workforce-fixture","operation":"read-write"}]'::jsonb where id in ('workforce.view','workforce.maintain')`);
  for(const capabilityId of ['workforce.view','workforce.maintain'] as const){const current=await withTenant(root(),tx=>accessConfigurationStore.loadCurrent(tx,root())),command={expectedRevision:current.snapshot.revision,command:{kind:'setOverride' as const,userId:who.userId!,capabilityId,companyId:b.companyId,effect:'allow' as const}},preview=await previewAccessConfiguration(root(),command,accessConfigurationStore);await saveAccessConfiguration(root(),{...command,previewFingerprint:preview.fingerprint},accessConfigurationStore);}
  const adapter=ADAPTERS.find(row=>row.action==='employees.workforce_profile.maintain')!;const before=await business();await expect(withTenant(who,async tx=>{await adapter.native(tx,who);throw new NativeRollback();})).rejects.toBeInstanceOf(NativeRollback);expect(await business()).toEqual(before);const r=await prepare(adapter,who);expect(await adapter.store.confirm(who,r)).toMatchObject({kind:'completed'});expect(await ledger(r.actionId)).toMatchObject({actorPersonId:null,userId:who.userId,subjectPersonId:target.personId});expect(await owner.db.select({personId:s.appUser.personId}).from(s.appUser).where(eq(s.appUser.id,who.userId!))).toEqual([{personId:null}]);expect(await owner.db.select({role:s.roleAssignment.role}).from(s.roleAssignment).where(eq(s.roleAssignment.appUserId,who.userId!))).toEqual([{role:'employee'}]);
 });
});
