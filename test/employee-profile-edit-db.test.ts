import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest';
import {hireEmployee,setReportingLine,updatePersonProfilePartial} from '../core/org';
import {readOwnProfileWorkspace,submitOwnProfileEdit,applyProfileProposalTx} from '../core/profile-edit';
import {saveProfileEditPolicy} from '../core/profile-edit-policy';
import {decideProfileChange,requestProfileChange,listProfileChangeRequests} from '../core/profile';
import {addEmergencyContact,listEmergencyContacts} from '../core/emergency-contacts';
import {addDependent,listDependents,isChildReliefEligible} from '../core/dependents';
import {addQualification,listQualifications} from '../core/qualifications';
import {person,employment,profileChangeRequest,employeeQualification,employeeStatutoryMy} from '../db/schema';
import {withTenant,type SessionContext} from '../db/client';
import {todayInKualaLumpur} from '../lib/hr-date';
import {requirePackFor} from '../localization/registry';
import type {EssProfileProposal} from '../lib/personnel-ess-model';
import {migrateTestDb,resetDb,seedBase,owner,adminCtx,createAppUser,closeAll,type Base} from './harness';
let b:Base;
const phone='profile.contact_and_permanent_address.phone',preferred='profile.personal_details.preferredname',primary='profile.emergency_contact.fullname',priority='profile.emergency_contact.priority',highest='qualification.academic_and_professional_qualifications.highest';
const admin=()=>({...adminCtx(b),grants:[{role:'hr_admin' as const,companyId:null}]});
async function subject(role:'employee'|'manager'|'hr_admin'='employee'){
 const hired=await hireEmployee(admin(),{person:{fullName:'Profile fixture',primaryEmail:`profile-${randomUUID()}@example.test`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
 const userId=await createAppUser(b.tenantId,hired.personId,role);
 const ctx:SessionContext={...adminCtx(b),userId,personId:hired.personId,roles:[role],grants:[{role,companyId:role==='hr_admin'?b.companyId:null}]};
 return {...hired,ctx};
}
const countryPack=()=>requirePackFor('MY');
const bankField=(field:string)=>`bank_statutory.bank_information.${field.toLowerCase()}`;
const taxCategoryField='bank_statutory.income_tax_pcb.taxcategory';
const empty=():EssProfileProposal=>({v:2,fields:[],registers:[]});
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();});afterAll(closeAll);
describe('My Profile canonical transaction and scope',()=>{
 it('saves contact immediately and preserves a distinct pending master change until a separate HR decision',async()=>{
  const s=await subject();await saveProfileEditPolicy(admin(),{keys:[phone,preferred],withdrawnReason:'Field restricted'});
  const view=await readOwnProfileWorkspace(s.ctx,{employmentId:s.employmentId});
  const proposal=empty();proposal.fields=[{fieldId:phone,before:view.baselines[phone],value:'0110000000'},{fieldId:preferred,before:view.baselines[preferred],value:'Preferred fixture'}];
  const result=await submitOwnProfileEdit(s.ctx,{employmentId:s.employmentId,proposal});
  expect(result.saved).toEqual([phone]);expect(result.waiting).toEqual([preferred]);expect(result.requestId).toBeTruthy();
  const [master]=await owner.db.select().from(person).where(eq(person.id,s.personId));expect(master.phone).toBe('0110000000');expect(master.preferredName).toBeNull();
  await expect(decideProfileChange({...admin(),personId:s.personId},{requestId:result.requestId!,decision:'approved'})).rejects.toMatchObject({code:'permission'});
  await decideProfileChange(admin(),{requestId:result.requestId!,decision:'approved'});
  const [after]=await owner.db.select().from(person).where(eq(person.id,s.personId));expect(after.preferredName).toBe('Preferred fixture');expect(after.phone).toBe('0110000000');
 });
 it('rolls back the immediate contact if the later canonical request insert fails',async()=>{
  const s=await subject();await saveProfileEditPolicy(admin(),{keys:[phone,preferred],withdrawnReason:'Field restricted'});
  const view=await readOwnProfileWorkspace(s.ctx,{employmentId:s.employmentId});
  await owner.db.execute(sql.raw("CREATE FUNCTION public.test_profile_edit_refuse_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test late refusal' USING ERRCODE='23514'; END $$; CREATE TRIGGER test_profile_edit_refuse_insert BEFORE INSERT ON profile_change_request FOR EACH ROW EXECUTE FUNCTION public.test_profile_edit_refuse_insert()"));
  try{
   const proposal=empty();proposal.fields=[{fieldId:phone,before:view.baselines[phone],value:'0110000000'},{fieldId:preferred,before:view.baselines[preferred],value:'Pending fixture'}];
   await expect(submitOwnProfileEdit(s.ctx,{employmentId:s.employmentId,proposal})).rejects.toThrow();
  }finally{await owner.db.execute(sql.raw('DROP TRIGGER test_profile_edit_refuse_insert ON profile_change_request; DROP FUNCTION public.test_profile_edit_refuse_insert()'));}
  const [master]=await owner.db.select().from(person).where(eq(person.id,s.personId));expect(master.phone).toBeNull();expect(master.preferredName).toBeNull();
  expect(await owner.db.select().from(profileChangeRequest)).toHaveLength(0);
 });
 it('reuses an exact pending retry and rechecks fresh policy even with a stale session snapshot',async()=>{
  const s=await subject();await saveProfileEditPolicy(admin(),{keys:[preferred],withdrawnReason:'Field restricted'});
  const view=await readOwnProfileWorkspace(s.ctx,{employmentId:s.employmentId}),proposal=empty();proposal.fields=[{fieldId:preferred,before:view.baselines[preferred],value:'Pending fixture'}];
  const first=await requestProfileChange(s.ctx,{employmentId:s.employmentId,proposed:proposal}),second=await requestProfileChange(s.ctx,{employmentId:s.employmentId,proposed:proposal});expect(second.requestId).toBe(first.requestId);
  const denied=await saveProfileEditPolicy(admin(),{keys:[],withdrawnReason:'Field restricted'});expect(denied.withdrawn).toBe(1);
  await expect(submitOwnProfileEdit(s.ctx,{employmentId:s.employmentId,proposal})).rejects.toMatchObject({code:'fieldClosed'});
  const [retained]=await owner.db.select().from(profileChangeRequest).where(eq(profileChangeRequest.id,first.requestId));expect(retained.status).toBe('rejected');expect(retained.proposed).toEqual(proposal);
 });
 it('keeps finite legacy rights on the captured primary ID, never silently applying to its replacement',async()=>{
  const s=await subject();const first=await addEmergencyContact(admin(),{personId:s.personId,fullName:'Primary fixture',priority:'primary'});
  const view=await readOwnProfileWorkspace(s.ctx,{employmentId:s.employmentId}),record=view.registers.find(row=>row.id===first.id)!;
  const proposal=empty();proposal.registers=[{kind:'emergency',id:first.id,clientId:first.id,fields:[{fieldId:primary,before:record.baselines[primary],value:'Changed primary fixture'}]}];
  await addEmergencyContact(admin(),{personId:s.personId,fullName:'New primary fixture',priority:'primary'});
  await expect(submitOwnProfileEdit(s.ctx,{employmentId:s.employmentId,proposal})).rejects.toMatchObject({code:'fieldClosed'});
  const contacts=await listEmergencyContacts(s.ctx,{personId:s.personId});expect(contacts.find(row=>row.id===first.id)?.fullName).toBe('Primary fixture');expect(contacts.find(row=>row.priority==='primary')?.fullName).toBe('New primary fixture');
 });
 it('composes legacy primary contact and newly permitted requested priority without losing either path',async()=>{
  const s=await subject();const contact=await addEmergencyContact(admin(),{personId:s.personId,fullName:'Primary fixture',priority:'primary'});
  await saveProfileEditPolicy(admin(),{keys:['legacyPrimaryEmergency.fullName',priority],withdrawnReason:'Field restricted'});
  const view=await readOwnProfileWorkspace(s.ctx,{employmentId:s.employmentId}),record=view.registers.find(row=>row.id===contact.id)!,proposal=empty();proposal.registers=[{kind:'emergency',id:contact.id,clientId:contact.id,fields:[{fieldId:primary,before:record.baselines[primary],value:'Immediate fixture'},{fieldId:priority,before:record.baselines[priority],value:'secondary'}]}];
  const result=await submitOwnProfileEdit(s.ctx,{employmentId:s.employmentId,proposal});expect(result.saved).toEqual([primary]);expect(result.waiting).toEqual([priority]);
  await decideProfileChange(admin(),{requestId:result.requestId!,decision:'approved'});
  expect((await listEmergencyContacts(s.ctx,{personId:s.personId})).find(row=>row.id===contact.id)).toMatchObject({fullName:'Immediate fixture',priority:'secondary'});
 });
 it('applies Highest only through the canonical qualification owner after approval',async()=>{
  const s=await subject();const first=await addQualification(admin(),{employmentId:s.employmentId,qualification:'Bachelor',isHighest:true}),second=await addQualification(admin(),{employmentId:s.employmentId,qualification:'Master',isHighest:false});
  await saveProfileEditPolicy(admin(),{keys:[highest],withdrawnReason:'Field restricted'});
  const view=await readOwnProfileWorkspace(s.ctx,{employmentId:s.employmentId}),record=view.registers.find(row=>row.id===second.id)!,proposal=empty();proposal.registers=[{kind:'qualification',id:second.id,clientId:second.id,fields:[{fieldId:highest,before:record.baselines[highest],value:true}]}];
  const result=await submitOwnProfileEdit(s.ctx,{employmentId:s.employmentId,proposal});expect((await listQualifications(s.ctx,{employmentId:s.employmentId})).find(row=>row.id===first.id)?.isHighest).toBe(true);
  await decideProfileChange(admin(),{requestId:result.requestId!,decision:'approved'});
  const rows=await listQualifications(s.ctx,{employmentId:s.employmentId});expect(rows.find(row=>row.id===first.id)?.isHighest).toBe(false);expect(rows.find(row=>row.id===second.id)?.isHighest).toBe(true);
 });
 it('denies manager/HR foreign subject selections and direct use of the approval adapter',async()=>{
  const manager=await subject('manager'),employee=await subject();await setReportingLine(admin(),{subordinateEmploymentId:employee.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:todayInKualaLumpur()});
  await expect(readOwnProfileWorkspace(manager.ctx,{employmentId:employee.employmentId})).rejects.toMatchObject({code:'permission'});
  await expect(readOwnProfileWorkspace(admin(),{employmentId:employee.employmentId})).rejects.toMatchObject({code:'permission'});
  await expect(withTenant(employee.ctx,tx=>applyProfileProposalTx(tx,employee.ctx,employee.employmentId,empty()))).rejects.toMatchObject({code:'permission'});
 });
 it('keeps current register context separate from submitted values and hides subordinate requests from a manager',async()=>{
  const manager=await subject('manager'),s=await subject();await setReportingLine(admin(),{subordinateEmploymentId:s.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:todayInKualaLumpur()});
  const contact=await addEmergencyContact(admin(),{personId:s.personId,fullName:'Exact original contact',priority:'primary'});await saveProfileEditPolicy(admin(),{keys:[primary],withdrawnReason:'Field restricted'});
  const view=await readOwnProfileWorkspace(s.ctx,{employmentId:s.employmentId}),record=view.registers.find(row=>row.id===contact.id)!,proposal=empty();proposal.registers=[{kind:'emergency',id:contact.id,clientId:contact.id,fields:[{fieldId:primary,before:record.baselines[primary],value:'Requested replacement name'}]}];
  const result=await submitOwnProfileEdit(s.ctx,{employmentId:s.employmentId,proposal});
  const requests=await listProfileChangeRequests(admin(),{status:'pending'}),request=requests.find(row=>row.id===result.requestId)!;expect(request.review[`emergency:${contact.id}:${primary}`]).toEqual({value:'Exact original contact',recordName:'Exact original contact',state:'existing'});expect(request.proposed).toEqual(proposal);
  expect(await withTenant(manager.ctx,tx=>tx.select().from(profileChangeRequest).where(eq(profileChangeRequest.id,result.requestId!)))).toHaveLength(0);
  expect(await withTenant(s.ctx,tx=>tx.select().from(profileChangeRequest).where(eq(profileChangeRequest.id,result.requestId!)))).toHaveLength(1);
 });
 it('rolls back canonical Highest transfers and keeps the request pending on a late business write failure',async()=>{
  const s=await subject(),first=await addQualification(admin(),{employmentId:s.employmentId,qualification:'Bachelor',isHighest:true}),second=await addQualification(admin(),{employmentId:s.employmentId,qualification:'Master',isHighest:false});await saveProfileEditPolicy(admin(),{keys:[highest],withdrawnReason:'Field restricted'});
  const view=await readOwnProfileWorkspace(s.ctx,{employmentId:s.employmentId}),record=view.registers.find(row=>row.id===second.id)!,proposal=empty();proposal.registers=[{kind:'qualification',id:second.id,clientId:second.id,fields:[{fieldId:highest,before:record.baselines[highest],value:true}]}];const result=await submitOwnProfileEdit(s.ctx,{employmentId:s.employmentId,proposal});
  await owner.db.execute(sql.raw("CREATE FUNCTION public.test_profile_qualification_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.is_highest THEN RAISE EXCEPTION 'test late canonical refusal' USING ERRCODE='23514'; END IF; RETURN NEW; END $$; CREATE TRIGGER test_profile_qualification_failure BEFORE UPDATE ON employee_qualification FOR EACH ROW EXECUTE FUNCTION public.test_profile_qualification_failure()"));
  try{await expect(decideProfileChange(admin(),{requestId:result.requestId!,decision:'approved'})).rejects.toThrow();}finally{await owner.db.execute(sql.raw('DROP TRIGGER test_profile_qualification_failure ON employee_qualification; DROP FUNCTION public.test_profile_qualification_failure()'));}
  const rows=await owner.db.select().from(employeeQualification).where(eq(employeeQualification.employmentId,s.employmentId));expect(rows.find(row=>row.id===first.id)?.isHighest).toBe(true);expect(rows.find(row=>row.id===second.id)?.isHighest).toBe(false);const [request]=await owner.db.select().from(profileChangeRequest).where(eq(profileChangeRequest.id,result.requestId!));expect(request.status).toBe('pending');expect(request.proposed).toEqual(proposal);
 });
 it('refuses fields the canonical Family owner would ignore on the selected relationship, and applies a real child change through that owner',async()=>{
  const s=await subject(),parent=await addDependent(admin(),{personId:s.personId,fullName:'Parent fixture',relationship:'parent'}),child=await addDependent(admin(),{personId:s.personId,fullName:'Child fixture',relationship:'child',dateOfBirth:`${Number(todayInKualaLumpur().slice(0,4))-8}-01-01`,childTaxRelief:false});
  const field='family.family_and_dependents.childtaxrelief';await saveProfileEditPolicy(admin(),{keys:[field],withdrawnReason:'Field restricted'});const view=await readOwnProfileWorkspace(s.ctx,{employmentId:s.employmentId});
  const proposalFor=(id:string)=>{const row=view.registers.find(row=>row.id===id)!,proposal=empty();proposal.registers=[{kind:'dependent',id,clientId:id,fields:[{fieldId:field,before:row.baselines[field],value:true}]}];return proposal;};
  await expect(submitOwnProfileEdit(s.ctx,{employmentId:s.employmentId,proposal:proposalFor(parent.id)})).rejects.toMatchObject({code:'invalid',fieldIds:[field]});expect(await owner.db.select().from(profileChangeRequest)).toHaveLength(0);
  const result=await submitOwnProfileEdit(s.ctx,{employmentId:s.employmentId,proposal:proposalFor(child.id)});await decideProfileChange(admin(),{requestId:result.requestId!,decision:'approved'});const stored=(await listDependents(admin(),{personId:s.personId})).find(row=>row.id===child.id)!;expect(stored.childTaxRelief).toBe(true);expect(isChildReliefEligible(stored)).toBe(true);
 });
 it.each([['customHolderName','enableCustomHolderName'],['customHolderId','enableCustomHolderId']] as const)('refuses disabled %s edits, but applies explicit enable plus value through request and approval',async(field,flag)=>{
  const s=await subject(),id=bankField(field),flagId=bankField(flag);await countryPack().statutory.set(admin(),{personId:s.personId,icNumber:'900101015020'});
  await saveProfileEditPolicy(admin(),{keys:[id],withdrawnReason:'Field restricted'});
  const view=await readOwnProfileWorkspace(s.ctx,{employmentId:s.employmentId}),proposal=empty();proposal.fields=[{fieldId:id,before:view.baselines[id],value:'Fictional holder'}];
  await expect(submitOwnProfileEdit(s.ctx,{employmentId:s.employmentId,proposal})).rejects.toMatchObject({code:'invalid',fieldIds:[id]});expect(await owner.db.select().from(profileChangeRequest)).toHaveLength(0);
  await saveProfileEditPolicy(admin(),{keys:[id,flagId],withdrawnReason:'Field restricted'});
  proposal.fields.unshift({fieldId:flagId,before:view.baselines[flagId],value:true});
  const result=await submitOwnProfileEdit(s.ctx,{employmentId:s.employmentId,proposal});await decideProfileChange(admin(),{requestId:result.requestId!,decision:'approved'});
  const stored=await countryPack().statutory.get(admin(),s.personId);expect(stored?.[field]).toBe('Fictional holder');expect(stored?.[flag]).toBe(true);
  const [request]=await owner.db.select().from(profileChangeRequest).where(eq(profileChangeRequest.id,result.requestId!));expect(request.status).toBe('approved');
  await saveProfileEditPolicy(admin(),{keys:[id],withdrawnReason:'Field restricted'});const reopened=await readOwnProfileWorkspace(s.ctx,{employmentId:s.employmentId}),edit=empty();edit.fields=[{fieldId:id,before:reopened.baselines[id],value:'Updated enabled holder'}];
  const second=await submitOwnProfileEdit(s.ctx,{employmentId:s.employmentId,proposal:edit});await decideProfileChange(admin(),{requestId:second.requestId!,decision:'approved'});expect((await countryPack().statutory.get(admin(),s.personId))?.[field]).toBe('Updated enabled holder');
 });
 it.each([['customHolderName','enableCustomHolderName'],['customHolderId','enableCustomHolderId']] as const)('rechecks effective %s applicability or exact masked-row revision at approval',async(field,flag)=>{
  const s=await subject(),id=bankField(field);await countryPack().statutory.set(admin(),{personId:s.personId,icNumber:'900101015020'});
  await countryPack().statutory.setBank(admin(),{personId:s.personId,enableCustomHolderName:true,customHolderName:'Original name',enableCustomHolderId:true,customHolderId:'Original ID'});
  await saveProfileEditPolicy(admin(),{keys:[id],withdrawnReason:'Field restricted'});const view=await readOwnProfileWorkspace(s.ctx,{employmentId:s.employmentId}),proposal=empty();proposal.fields=[{fieldId:id,before:view.baselines[id],value:'Requested holder'}];
  const result=await submitOwnProfileEdit(s.ctx,{employmentId:s.employmentId,proposal});
  // Model a sparse persisted switch revocation. The proposed value is deliberately unchanged,
  // unmasked value evidence needs applicability validation; masked evidence also detects the row revision.
  await withTenant(admin(),tx=>tx.update(employeeStatutoryMy).set(flag==='enableCustomHolderName'?{enableCustomHolderName:false}:{enableCustomHolderId:false}).where(eq(employeeStatutoryMy.personId,s.personId)));
  await expect(decideProfileChange(admin(),{requestId:result.requestId!,decision:'approved'})).rejects.toMatchObject({code:field==='customHolderId'?'stale':'invalid',fieldIds:[id]});
  const stored=await countryPack().statutory.get(admin(),s.personId);expect(stored?.[flag]).toBe(false);expect(stored?.[field]).toBe(field==='customHolderName'?'Original name':'Original ID');
  const [request]=await owner.db.select().from(profileChangeRequest).where(eq(profileChangeRequest.id,result.requestId!));expect(request.status).toBe('pending');expect(request.proposed).toEqual(proposal);
 });
 it('does not approve a pending holder edit after its field policy is withdrawn',async()=>{
  const s=await subject(),id=bankField('customHolderName');await countryPack().statutory.set(admin(),{personId:s.personId,icNumber:'900101015020'});await countryPack().statutory.setBank(admin(),{personId:s.personId,enableCustomHolderName:true,customHolderName:'Original name'});
  await saveProfileEditPolicy(admin(),{keys:[id],withdrawnReason:'Field restricted'});const view=await readOwnProfileWorkspace(s.ctx,{employmentId:s.employmentId}),proposal=empty();proposal.fields=[{fieldId:id,before:view.baselines[id],value:'Requested holder'}];const result=await submitOwnProfileEdit(s.ctx,{employmentId:s.employmentId,proposal});
  await saveProfileEditPolicy(admin(),{keys:[],withdrawnReason:'Field restricted'});await expect(decideProfileChange(admin(),{requestId:result.requestId!,decision:'approved'})).rejects.toThrow();
  expect((await countryPack().statutory.get(admin(),s.personId))?.customHolderName).toBe('Original name');const [request]=await owner.db.select().from(profileChangeRequest).where(eq(profileChangeRequest.id,result.requestId!));expect(request.status).toBe('rejected');
 });
 it.each(['spouse_not_working',null] as const)('applies a numeric category proposal from saved detail %s without resubmitting that detail as authority',async(key)=>{
  const s=await subject();await countryPack().statutory.set(admin(),{personId:s.personId,icNumber:'900101015020',taxCategory:2,taxCircumstance:key});
  await saveProfileEditPolicy(admin(),{keys:[taxCategoryField],withdrawnReason:'Field restricted'});const view=await readOwnProfileWorkspace(s.ctx,{employmentId:s.employmentId}),proposal=empty();proposal.fields=[{fieldId:taxCategoryField,before:view.baselines[taxCategoryField],value:1}];
  const result=await submitOwnProfileEdit(s.ctx,{employmentId:s.employmentId,proposal});await decideProfileChange(admin(),{requestId:result.requestId!,decision:'approved'});
  expect(await countryPack().statutory.get(admin(),s.personId)).toMatchObject({taxCategory:1,taxCircumstance:null});const [request]=await owner.db.select().from(profileChangeRequest).where(eq(profileChangeRequest.id,result.requestId!));expect(request.status).toBe('approved');
 });
 it('preserves None and its dormant category, refusing both a new numeric edit and a pending edit after None is selected',async()=>{
  const s=await subject();await countryPack().statutory.set(admin(),{personId:s.personId,icNumber:'900101015020',taxCategory:2,taxCircumstance:'spouse_not_working'});
  await saveProfileEditPolicy(admin(),{keys:[taxCategoryField],withdrawnReason:'Field restricted'});const view=await readOwnProfileWorkspace(s.ctx,{employmentId:s.employmentId}),proposal=empty();proposal.fields=[{fieldId:taxCategoryField,before:view.baselines[taxCategoryField],value:1}];const result=await submitOwnProfileEdit(s.ctx,{employmentId:s.employmentId,proposal});
  await countryPack().statutory.setTax(admin(),{personId:s.personId,taxCategory:2,taxCircumstance:'none',taxResidency:'none'});
  await expect(decideProfileChange(admin(),{requestId:result.requestId!,decision:'approved'})).rejects.toMatchObject({code:'invalid',fieldIds:[taxCategoryField]});
  await expect(submitOwnProfileEdit(s.ctx,{employmentId:s.employmentId,proposal})).rejects.toMatchObject({code:'invalid',fieldIds:[taxCategoryField]});
  expect(await countryPack().statutory.get(admin(),s.personId)).toMatchObject({taxCategory:2,taxCircumstance:'none',taxResidency:'none'});const [request]=await owner.db.select().from(profileChangeRequest).where(eq(profileChangeRequest.id,result.requestId!));expect(request.status).toBe('pending');
 });
 it('keeps a future final day eligible and rejects an elapsed final day under the same stale client context',async()=>{
  const s=await subject();const today=todayInKualaLumpur(),tomorrow=new Date(Date.parse(today+'T00:00:00Z')+86400000).toISOString().slice(0,10),yesterday=new Date(Date.parse(today+'T00:00:00Z')-86400000).toISOString().slice(0,10);
  await owner.db.update(employment).set({terminatedOn:tomorrow}).where(eq(employment.id,s.employmentId));
  const view=await readOwnProfileWorkspace(s.ctx,{employmentId:s.employmentId});expect(view.editable).toContain(phone);
  await owner.db.update(employment).set({terminatedOn:yesterday}).where(eq(employment.id,s.employmentId));
  const proposal=empty();proposal.fields=[{fieldId:phone,before:view.baselines[phone],value:'0110000000'}];await expect(submitOwnProfileEdit(s.ctx,{employmentId:s.employmentId,proposal})).rejects.toMatchObject({code:'permission'});
 });
 it('retains a historical blank email on unrelated canonical partial updates while still rejecting explicit blanks',async()=>{
  const s=await subject();await owner.db.update(person).set({primaryEmail:'',phone:'0110000000'}).where(eq(person.id,s.personId));
  await updatePersonProfilePartial(admin(),{personId:s.personId,preferredName:'Recorded fixture'});
  const [master]=await owner.db.select().from(person).where(eq(person.id,s.personId));expect(master.primaryEmail).toBe('');expect(master.phone).toBe('0110000000');expect(master.preferredName).toBe('Recorded fixture');
  await expect(updatePersonProfilePartial(admin(),{personId:s.personId,fullName:' '})).rejects.toThrow('Name is required');await expect(updatePersonProfilePartial(admin(),{personId:s.personId,primaryEmail:' '})).rejects.toThrow('Email is required');await expect(updatePersonProfilePartial(admin(),{personId:s.personId,primaryEmail:'invalid-email'})).rejects.toThrow('Email is invalid');
 });
 it('removes non-CRUD and PUBLIC grants while retaining canonical request history and scoped decisions',async()=>{
  const [row]=await owner.db.execute(sql`select has_table_privilege('ai_hr_app','profile_change_request','TRUNCATE') truncate,has_table_privilege('ai_hr_app','profile_change_request','REFERENCES') references,has_table_privilege('ai_hr_app','profile_change_request','TRIGGER') trigger,has_table_privilege('ai_hr_app','profile_change_request','SELECT,INSERT,UPDATE,DELETE') crud`);
  expect(row).toMatchObject({truncate:false,references:false,trigger:false,crud:true});
 });
});
