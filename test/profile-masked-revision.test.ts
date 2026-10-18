/** Real app-role regressions for masked ESS concurrency evidence. No value-derived public token. */
import {createHash,randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {seedStoredLegacyProfileRequest} from './helpers/profile-requests';
import {addDependent,qualifyingChildReliefFor} from '../core/dependents';
import {hireEmployee} from '../core/org';
import {readOwnProfileWorkspace,submitOwnProfileEdit} from '../core/profile-edit';
import {saveProfileEditPolicy} from '../core/profile-edit-policy';
import {decideProfileChange,requestProfileChange} from '../core/profile';
import {requirePackFor} from '../localization/registry';
import {employeeStatutoryMy,person,profileChangeRequest,domainEvent,employeeDependent} from '../db/schema';
import type {SessionContext} from '../db/client';
import {todayInKualaLumpur} from '../lib/hr-date';
import type {EssProfileProposal} from '../lib/personnel-ess-model';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base;
const account='bank_statutory.bank_information.bankaccountno',passport='profile.identity_and_passport.passportnumber',holder='bank_statutory.bank_information.customholderid',ic='profile.identity_and_passport.icnumber',oldIc='profile.identity_and_passport.oldicnumber',preferred='profile.personal_details.preferredname';
const pack=()=>requirePackFor('MY'),admin=():SessionContext=>({...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]});
const raw='123456781234';
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();});afterAll(closeAll);
async function subject(){
 const e=await hireEmployee(admin(),{person:{fullName:'Masked profile fixture',primaryEmail:`masked-${randomUUID()}@example.test`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
 const userId=await createAppUser(b.tenantId,e.personId,'employee');
 const ctx:SessionContext={...admin(),userId,personId:e.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
 return {...e,ctx};
}
async function statutory(personId:string){
 await pack().statutory.set(admin(),{personId,icNumber:'900101'+randomUUID().replace(/\D/g,'').padEnd(6,'0').slice(0,6)});
 await pack().statutory.setBank(admin(),{personId,bankName:pack().client.bankNames[0],bankAccountNo:raw,enableCustomHolderId:true,customHolderId:raw});
 // Equal raw values make context separation non-vacuous; this is controlled fixture state only.
 await owner.db.update(employeeStatutoryMy).set({passportNumber:raw}).where(eq(employeeStatutoryMy.personId,personId));
}
const proposal=(fieldId:string,before:string,value:string):EssProfileProposal=>({v:2,fields:[{fieldId,before,value}],registers:[]});

describe('country-owned masked profile row revisions',()=>{
 it('returns masked View Only values without a raw-value hash and separates fields, people and own employments',async()=>{
  const a=await subject(),other=await subject();await statutory(a.personId);await statutory(other.personId);
  await saveProfileEditPolicy(admin(),{keys:[],withdrawnReason:'Fixture field closure'});
  const view=await readOwnProfileWorkspace(a.ctx,{employmentId:a.employmentId}),foreign=await readOwnProfileWorkspace(other.ctx,{employmentId:other.employmentId});
  expect(view.editable).toEqual([]);expect(JSON.stringify(view)).not.toContain(raw);
  const candidate='sha256:'+createHash('sha256').update(JSON.stringify(raw)).digest('hex');
  expect(JSON.stringify(view.baselines)).not.toContain(candidate);
  for(const id of [account,passport,holder]){expect(view.values[id]).toBe('•••• 1234');expect(view.baselines[id]).toMatch(/^profile-row:v1:[a-f0-9]{64}$/);}
  for(const id of [ic,oldIc])expect(view.baselines[id]).toMatch(/^profile-row:v1:[a-f0-9]{64}$/);
  expect(new Set([view.baselines[account],view.baselines[passport],view.baselines[holder],foreign.baselines[account]]).size).toBe(4);
  const second=await hireEmployee(admin(),{person:{id:a.personId},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
  const ownSecond=await readOwnProfileWorkspace(a.ctx,{employmentId:second.employmentId});
  expect(ownSecond.values[account]).toEqual(view.values[account]);expect(ownSecond.baselines[account]).not.toBe(view.baselines[account]);
 });
 it('detects a masked write even when updatedAt is held exactly unchanged',async()=>{
  const a=await subject();await statutory(a.personId);await saveProfileEditPolicy(admin(),{keys:[account],withdrawnReason:'Fixture field closure'});
  const view=await readOwnProfileWorkspace(a.ctx,{employmentId:a.employmentId}),before=await pack().statutory.get(admin(),a.personId);
  const snapshot=await pack().statutory.getEditSnapshot!(a.ctx,a.personId);
  expect(snapshot?.rowId).toBe(before!.id);expect(snapshot?.revision).toMatch(/^\d+$/);
  await owner.db.update(employeeStatutoryMy).set({bankAccountNo:'234567891234',updatedAt:before!.updatedAt}).where(eq(employeeStatutoryMy.personId,a.personId));
  const after=await pack().statutory.get(admin(),a.personId),changed=await pack().statutory.getEditSnapshot!(a.ctx,a.personId);
  expect(after!.updatedAt).toEqual(before!.updatedAt);expect(changed!.revision).not.toBe(snapshot!.revision);
  const reopened=await readOwnProfileWorkspace(a.ctx,{employmentId:a.employmentId});expect(reopened.values[account]).toEqual(view.values[account]);expect(reopened.baselines[account]).not.toBe(view.baselines[account]);
  await expect(submitOwnProfileEdit(a.ctx,{employmentId:a.employmentId,proposal:proposal(account,view.baselines[account],'999999999999')})).rejects.toMatchObject({code:'stale',fieldIds:[account]});
  expect(await owner.db.select().from(profileChangeRequest)).toEqual([]);expect(after!.bankAccountNo).toBe('234567891234');
 });
 it('rechecks the exact masked revision at approval before applying any other waiting field',async()=>{
  const a=await subject();await statutory(a.personId);await saveProfileEditPolicy(admin(),{keys:[account,preferred],withdrawnReason:'Fixture field closure'});
  const view=await readOwnProfileWorkspace(a.ctx,{employmentId:a.employmentId});const p=proposal(account,view.baselines[account],'999999999999');p.fields.unshift({fieldId:preferred,before:view.baselines[preferred],value:'Pending name'});
  const result=await submitOwnProfileEdit(a.ctx,{employmentId:a.employmentId,proposal:p});
  const before=await pack().statutory.get(admin(),a.personId);await owner.db.update(employeeStatutoryMy).set({bankAccountNo:'345678901234',updatedAt:before!.updatedAt}).where(eq(employeeStatutoryMy.personId,a.personId));
  await expect(decideProfileChange(admin(),{requestId:result.requestId!,decision:'approved'})).rejects.toMatchObject({code:'stale',fieldIds:[account]});
  const [master]=await owner.db.select().from(person).where(eq(person.id,a.personId)),[request]=await owner.db.select().from(profileChangeRequest).where(eq(profileChangeRequest.id,result.requestId!));
  expect(master.preferredName).toBeNull();expect(request.status).toBe('pending');expect((await pack().statutory.get(admin(),a.personId))!.bankAccountNo).toBe('345678901234');
 });
 it('refuses swapped field/person tokens and a forged subject instead of treating a token as permission',async()=>{
  const a=await subject(),other=await subject();await statutory(a.personId);await statutory(other.personId);await saveProfileEditPolicy(admin(),{keys:[account],withdrawnReason:'Fixture field closure'});
  const view=await readOwnProfileWorkspace(a.ctx,{employmentId:a.employmentId}),foreign=await readOwnProfileWorkspace(other.ctx,{employmentId:other.employmentId});
  for(const token of [view.baselines[passport],foreign.baselines[account]])await expect(submitOwnProfileEdit(a.ctx,{employmentId:a.employmentId,proposal:proposal(account,token,'999999999999')})).rejects.toMatchObject({code:'stale'});
  await expect(submitOwnProfileEdit(a.ctx,{employmentId:other.employmentId,proposal:proposal(account,foreign.baselines[account],'999999999999')})).rejects.toMatchObject({code:'permission'});
  await saveProfileEditPolicy(admin(),{keys:[],withdrawnReason:'Fixture field closure'});
  await expect(submitOwnProfileEdit(a.ctx,{employmentId:a.employmentId,proposal:proposal(account,view.baselines[account],'999999999999')})).rejects.toMatchObject({code:'fieldClosed'});
  expect(await owner.db.select().from(profileChangeRequest)).toEqual([]);
 });
 it('invalidates the target-bound absent-row marker when a statutory row appears',async()=>{
  const a=await subject();await saveProfileEditPolicy(admin(),{keys:[passport],withdrawnReason:'Fixture field closure'});
  const view=await readOwnProfileWorkspace(a.ctx,{employmentId:a.employmentId});expect(view.values[passport]).toBeNull();expect(view.baselines[passport]).toMatch(/^profile-row:v1:/);
  await pack().statutory.set(admin(),{personId:a.personId,icNumber:'900101015020'});
  await expect(submitOwnProfileEdit(a.ctx,{employmentId:a.employmentId,proposal:proposal(passport,view.baselines[passport],'A1234567')})).rejects.toMatchObject({code:'stale'});
 });
 it('never falls back to raw-value evidence when the country snapshot seam is unavailable',async()=>{
  const a=await subject();await statutory(a.personId);await saveProfileEditPolicy(admin(),{keys:[account],withdrawnReason:'Fixture field closure'});
  const statutoryOwner=pack().statutory,original=statutoryOwner.getEditSnapshot;
  try{
   statutoryOwner.getEditSnapshot=undefined;
   const view=await readOwnProfileWorkspace(a.ctx,{employmentId:a.employmentId});expect(view.values[account]).toBe('•••• 1234');expect(view.baselines[account]).toBeUndefined();
   await expect(submitOwnProfileEdit(a.ctx,{employmentId:a.employmentId,proposal:proposal(account,'sha256:'+createHash('sha256').update(JSON.stringify(raw)).digest('hex'),'999999999999')})).rejects.toMatchObject({code:'unavailable'});
  }finally{statutoryOwner.getEditSnapshot=original;}
 });
 it('refuses all new unversioned proposals without writing a request, event or master',async()=>{
  const a=await subject();await statutory(a.personId);await saveProfileEditPolicy(admin(),{keys:[account,'bank_statutory.bank_information.bankname',preferred],withdrawnReason:'Fixture field closure'});
  const before=await owner.db.select().from(employeeStatutoryMy).orderBy(employeeStatutoryMy.id),events=await owner.db.select().from(domainEvent).orderBy(domainEvent.id);
  for(const proposed of [{bankName:'Not a country bank',bankAccountNo:'999999999999'},{preferredName:'Old-form bypass'},{bankAccountNo:'999999999999'},{}])await expect(requestProfileChange(a.ctx,{employmentId:a.employmentId,proposed})).rejects.toMatchObject({code:'invalid'});
  expect(await owner.db.select().from(profileChangeRequest)).toEqual([]);expect(await owner.db.select().from(employeeStatutoryMy).orderBy(employeeStatutoryMy.id)).toEqual(before);expect(await owner.db.select().from(domainEvent).orderBy(domainEvent.id)).toEqual(events);
 });
 it.each([
  {name:'an unavailable bank',proposed:{bankName:'Not an installed country bank',bankAccountNo:'999999999999'}},
  {name:'an incomplete bank',proposed:{bankName:null}},
  {name:'a blank required name',proposed:{fullName:''}},
  {name:'a whitespace-only required name',proposed:{fullName:'   '}},
  {name:'a numeric category ignored by None',proposed:{taxCategory:3}},
 ])('refuses a stored legacy proposal for $name without deciding or partially applying it',async({proposed})=>{
  const a=await subject();await statutory(a.personId);
  await owner.db.update(employeeStatutoryMy).set({taxCircumstance:'none',taxCategory:2}).where(eq(employeeStatutoryMy.personId,a.personId));
  const before=await pack().statutory.get(admin(),a.personId);
  const request=await seedStoredLegacyProfileRequest(a.ctx,{employmentId:a.employmentId,proposed:{preferredName:'Must remain pending',...proposed}});
  await expect(decideProfileChange(admin(),{requestId:request.requestId,decision:'approved'})).rejects.toMatchObject({code:'invalid'});
  expect(await pack().statutory.get(admin(),a.personId)).toEqual(before);
  const [master]=await owner.db.select().from(person).where(eq(person.id,a.personId)),[pending]=await owner.db.select().from(profileChangeRequest).where(eq(profileChangeRequest.id,request.requestId));
  expect(master.preferredName).toBeNull();expect(pending.status).toBe('pending');
  await decideProfileChange(admin(),{requestId:request.requestId,decision:'rejected',reason:'Correct the source documents.'});
  expect(await pack().statutory.get(admin(),a.personId)).toEqual(before);
 });
 it('applies a valid stored legacy bank proposal through the country owner without inventing historical baselines',async()=>{
  const a=await subject();await statutory(a.personId);
  const legacy={bankName:pack().client.bankNames[0],bankAccountNo:'999999999999',preferredName:'Approved legacy name'};
  const request=await seedStoredLegacyProfileRequest(a.ctx,{employmentId:a.employmentId,proposed:legacy});
  await decideProfileChange(admin(),{requestId:request.requestId,decision:'approved'});
  expect(await pack().statutory.get(admin(),a.personId)).toMatchObject({bankName:legacy.bankName,bankAccountNo:legacy.bankAccountNo});
  const [stored]=await owner.db.select().from(profileChangeRequest).where(eq(profileChangeRequest.id,request.requestId));
  expect(stored.status).toBe('approved');expect(stored.proposed).toEqual(legacy);
  const events=await owner.db.select().from(domainEvent).where(eq(domainEvent.aggregateId,a.personId));
  expect(events.length).toBeGreaterThan(0);
 });
 it.each(['auto','auto_table','manual'] as const)('shows the canonical %s qualifying head count and only edits manual compatibility count',async mode=>{
  const a=await subject();await statutory(a.personId);
  await addDependent(admin(),{personId:a.personId,fullName:'Qualifying child',relationship:'child',dateOfBirth:`${Number(todayInKualaLumpur().slice(0,4))-8}-01-01`,childTaxRelief:true});
  const table={under_18:{full:1,half:1},disabled:{full:1,half:0}};
  // Deliberately stale compatibility projection: canonical automatic read must not simply echo nine.
  await owner.db.update(employeeStatutoryMy).set({numChildren:9,childReliefMode:mode,childReliefTable:table,taxCategory:2}).where(eq(employeeStatutoryMy.personId,a.personId));
  const id='bank_statutory.income_tax_pcb.numchildren';await saveProfileEditPolicy(admin(),{keys:[id],withdrawnReason:'Fixture field closure'});
  const view=await readOwnProfileWorkspace(a.ctx,{employmentId:a.employmentId});
  if(mode==='manual'){
   expect(view.values[id]).toBe(9);expect(view.fieldReadOnlyReasons?.[id]).toBeUndefined();
   const result=await submitOwnProfileEdit(a.ctx,{employmentId:a.employmentId,proposal:{v:2,fields:[{fieldId:id,before:view.baselines[id],value:4}],registers:[]}});
   await decideProfileChange(admin(),{requestId:result.requestId!,decision:'approved'});expect((await pack().statutory.get(admin(),a.personId))!.numChildren).toBe(4);
  }else{
   const relief=await qualifyingChildReliefFor(a.ctx,{personId:a.personId,country:'MY',asOf:todayInKualaLumpur()});
   const count=mode==='auto'?relief!.eligibleChildren:pack().payroll.childReliefTableHeadCount!(table);
   expect(count).toBe(mode==='auto'?1:3);expect(view.values[id]).toBe(count);expect(view.values[id]).not.toBe(9);expect(view.fieldReadOnlyReasons?.[id]).toBe('derivedChildCount');
   await expect(submitOwnProfileEdit(a.ctx,{employmentId:a.employmentId,proposal:{v:2,fields:[{fieldId:id,before:view.baselines[id],value:4}],registers:[]}})).rejects.toMatchObject({code:'invalid',fieldIds:[id]});
   const legacy=await seedStoredLegacyProfileRequest(a.ctx,{employmentId:a.employmentId,proposed:{numChildren:4}});
   await expect(decideProfileChange(admin(),{requestId:legacy.requestId,decision:'approved'})).rejects.toMatchObject({code:'invalid',fieldIds:[id]});
   expect((await pack().statutory.get(admin(),a.personId))!.numChildren).toBe(9);
  }
 });

 it('binds masked Family evidence to the exact row and catches a change with unchanged updatedAt',async()=>{
  const a=await subject(),id='family.family_and_dependents.icorpassport',passportId='family.family_and_dependents.passportnumber';
  const first=await addDependent(admin(),{personId:a.personId,fullName:'First relation',relationship:'parent',icOrPassport:raw,passportNumber:raw});
  const second=await addDependent(admin(),{personId:a.personId,fullName:'Second relation',relationship:'parent',icOrPassport:raw,passportNumber:raw});
  await saveProfileEditPolicy(admin(),{keys:[id],withdrawnReason:'Fixture field closure'});
  const view=await readOwnProfileWorkspace(a.ctx,{employmentId:a.employmentId}),row=view.registers.find(row=>row.id===first.id)!,other=view.registers.find(row=>row.id===second.id)!;
  expect(row.values[id]).toBe('•••• 1234');expect(row.values[passportId]).toBe(row.values[id]);
  expect(row.baselines[id]).toMatch(/^profile-row:v1:/);expect(row.baselines[id]).not.toBe(other.baselines[id]);expect(row.baselines[id]).not.toBe(row.baselines[passportId]);
  expect(JSON.stringify(view.registers)).not.toContain(createHash('sha256').update(JSON.stringify(raw)).digest('hex'));
  const requestFor=(before:string):EssProfileProposal=>({v:2,fields:[],registers:[{kind:'dependent',id:first.id,clientId:first.id,fields:[{fieldId:id,before,value:'New identity'}]}]});
  await expect(submitOwnProfileEdit(a.ctx,{employmentId:a.employmentId,proposal:requestFor(other.baselines[id])})).rejects.toMatchObject({code:'stale',fieldIds:[id]});
  const pending=await submitOwnProfileEdit(a.ctx,{employmentId:a.employmentId,proposal:requestFor(row.baselines[id])});
  const [before]=await owner.db.select().from(employeeDependent).where(eq(employeeDependent.id,first.id));
  await owner.db.update(employeeDependent).set({icOrPassport:'234567891234',updatedAt:before.updatedAt}).where(eq(employeeDependent.id,first.id));
  await expect(decideProfileChange(admin(),{requestId:pending.requestId!,decision:'approved'})).rejects.toMatchObject({code:'stale',fieldIds:[id]});
  const [after]=await owner.db.select().from(employeeDependent).where(eq(employeeDependent.id,first.id));expect(after.updatedAt).toEqual(before.updatedAt);expect(after.icOrPassport).toBe('234567891234');
  const [request]=await owner.db.select().from(profileChangeRequest).where(eq(profileChangeRequest.id,pending.requestId!));expect(request.status).toBe('pending');
 });
 it('creates a permitted Family record with a masked identity using new-record null evidence',async()=>{
  const a=await subject(),name='family.family_and_dependents.fullname',relation='family.family_and_dependents.relationship',identity='family.family_and_dependents.icorpassport';
  await saveProfileEditPolicy(admin(),{keys:[name,relation,identity],withdrawnReason:'Fixture field closure'});
  const proposal:EssProfileProposal={v:2,fields:[],registers:[{kind:'dependent',id:null,clientId:'new-relation',fields:[{fieldId:name,before:null,value:'New relation'},{fieldId:relation,before:null,value:'parent'},{fieldId:identity,before:null,value:raw}]}]};
  const result=await submitOwnProfileEdit(a.ctx,{employmentId:a.employmentId,proposal});await decideProfileChange(admin(),{requestId:result.requestId!,decision:'approved'});
  const view=await readOwnProfileWorkspace(a.ctx,{employmentId:a.employmentId});expect(view.registers).toHaveLength(1);expect(view.registers[0].values[identity]).toBe('•••• 1234');expect(view.registers[0].baselines[identity]).toMatch(/^profile-row:v1:/);
 });

});
