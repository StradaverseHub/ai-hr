import {createHash} from 'node:crypto';
/** Own-profile edits compose canonical owners in ONE authenticated caller transaction. */
import {and,asc,eq,isNull,lte,sql} from 'drizzle-orm';
import {myOwnEmploymentSubjectsTx,profileEditEmploymentPredicate,employeeDetail,assignmentHistory} from './read';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {company,employment,person,employeeDependent,employeeQualification,personEmergencyContact} from '../db/schema';
import {todayInKualaLumpur} from '../lib/hr-date';
import {personnelField,PERSONNEL_FIELDS} from '../lib/personnel-field-registry';
import {parseEssProfileProposal,sameEssScalar} from '../lib/personnel-ess-contract';
import {EssProfileError,type EssProfileProposal,type EssFieldChange,type EssScalar,type EssRegisterChange} from '../lib/personnel-ess-model';
import {freshProfileEditPolicyTx} from './profile-edit-policy';
import {packFor} from '../localization/registry';
import {updatePersonProfilePartial,type PersonProfileFields} from './org';
import {setPersonComplianceFields,requestProfileChange,updateOwnContact} from './profile';
import {addDependent,updateDependent,assertDependentsValid,validateDependentInputTx,childAgeYears,isChildReliefEligible,type DependentInput} from './dependents';
import {addQualification,updateQualification,validateQualificationInputTx} from './qualifications';
import {addEmergencyContact,updateEmergencyContact,validateEmergencyContactInputTx} from './emergency-contacts';
import {assertProfileValueAllowed} from './profile-options';
import {customHolderGaps} from '../lib/custom-holder';
import {personnelChildReliefValue} from '../lib/personnel-report-value';
import {qualifyingChildReliefFor} from './dependents';
import {CHILD_RELIEF_PERCENTAGES} from '../lib/dependent-vocabulary';
import {EMERGENCY_CONTACT_PRIORITIES} from '../lib/emergency-contact-vocabulary';

export type EssRecord={kind:EssRegisterChange['kind'];id:string;values:Record<string,EssScalar>;baselines:Record<string,string>;primary:boolean};
export type EssWorkspace={employmentId:string;personId:string;country:string|null;values:Record<string,EssScalar>;baselines:Record<string,string>;registers:EssRecord[];editable:string[];legacyPrimaryEditable:string[];addressReview:boolean;legacyAddress:Record<string,string|null>;statutoryAvailable:boolean};
const scalar=(value:unknown):EssScalar=>value==null?null:typeof value==='string'||typeof value==='number'||typeof value==='boolean'?value:null;
const record=(value:object)=>value as Record<string,unknown>; // typed owner rows, used only for explicit descriptor projections
const text=(values:Record<string,EssScalar>,key:string):string|null|undefined=>{const value=values[key];if(value===undefined||value===null||typeof value==='string')return value;throw new EssProfileError('invalid');};
const boolean=(values:Record<string,EssScalar>,key:string):boolean|undefined=>{const value=values[key];if(value===undefined)return undefined;if(typeof value==='boolean')return value;throw new EssProfileError('invalid');};
const nullableBoolean=(values:Record<string,EssScalar>,key:string):boolean|null|undefined=>values[key]===null?null:boolean(values,key);
const number=(values:Record<string,EssScalar>,key:string):number|undefined=>{const value=values[key];if(value===undefined)return undefined;if(typeof value==='number')return value;if(key==='childReliefPercentage'&&typeof value==='string'&&CHILD_RELIEF_PERCENTAGES.some(share=>String(share)===value))return Number(value);throw new EssProfileError('invalid');};
function patch(fields:EssFieldChange[]){return Object.fromEntries(fields.map(change=>[personnelField(change.fieldId)!.ess.binding!.field,change.value]));}
export async function ownProfileSubjectTx(tx:Tx,ctx:SessionContext,selected?:string,forEdit=true){
 if(!ctx.personId)throw new EssProfileError('permission');
 const eligible=await myOwnEmploymentSubjectsTx(tx,ctx,{profileEdit:forEdit});
 const selectedId=selected??(eligible.length===1?eligible[0].employmentId:undefined);if(!selectedId||!eligible.some(row=>row.employmentId===selectedId))throw new EssProfileError('permission');
 const [subject]=await tx.select({id:employment.id,personId:employment.personId,companyId:employment.companyId,country:company.country}).from(employment).innerJoin(company,eq(company.id,employment.companyId)).where(and(eq(employment.id,selectedId),eq(employment.personId,ctx.personId),forEdit?profileEditEmploymentPredicate(ctx):undefined)).limit(1).for('update');
 if(!subject)throw new EssProfileError('permission');
 const [master]=await tx.select().from(person).where(and(eq(person.tenantId,ctx.tenantId),eq(person.id,subject.personId))).limit(1).for('update');
 if(!master)throw new EssProfileError('unavailable');
 return {subject,master};
}
async function mastersTx(tx:Tx,ctx:SessionContext,subject:Awaited<ReturnType<typeof ownProfileSubjectTx>>['subject']){
 const pack=packFor(subject.country);
 // Match canonical register writers: Family before statutory sync; Primary/Highest before targets.
 // Locking the statutory row first would invert updateDependent → child-relief sync.
 const dependents=await tx.select().from(employeeDependent).where(and(eq(employeeDependent.personId,subject.personId),isNull(employeeDependent.archivedAt))).orderBy(asc(employeeDependent.createdAt),asc(employeeDependent.id)).limit(501).for('update');
 const qualifications=await tx.select().from(employeeQualification).where(and(eq(employeeQualification.employmentId,subject.id),isNull(employeeQualification.archivedAt))).orderBy(sql`CASE WHEN ${employeeQualification.isHighest} THEN 0 ELSE 1 END`,asc(employeeQualification.createdAt),asc(employeeQualification.id)).limit(501).for('update');
 const emergency=await tx.select().from(personEmergencyContact).where(and(eq(personEmergencyContact.personId,subject.personId),isNull(personEmergencyContact.archivedAt))).orderBy(sql`CASE WHEN ${personEmergencyContact.priority}='primary' THEN 0 ELSE 1 END`,asc(personEmergencyContact.createdAt),asc(personEmergencyContact.id)).limit(501).for('update');
 const stat=await(pack?.statutory.get(ctx,subject.personId,tx,{forUpdate:true})??Promise.resolve(null));
 if([dependents,qualifications,emergency].some(rows=>rows.length>500))throw new EssProfileError('unavailable');
 return {pack,stat,dependents,qualifications,emergency};
}
function registryValues(owner:string,row:object){
 const values:Record<string,EssScalar>={};
 for(const field of PERSONNEL_FIELDS){if(field.ess.visibility==='visible'&&field.ess.binding?.owner===owner)values[field.id]=scalar(record(row)[field.ess.binding.field]);}
 return values;
}
function readonlyValues(owner:string,row:object){
 const values:Record<string,EssScalar>={};
 for(const field of PERSONNEL_FIELDS){
  if(field.ess.visibility!=='visible'||field.ess.binding||field.owner!==owner||field.childReliefCell)continue;
  const source=field.ownerField==='hrdfSubject'?'subjectToHrdf':field.ownerField;
  if(source in row)values[field.id]=scalar(record(row)[source]);
 }
 return values;
}
function safeValues(values:Record<string,EssScalar>){
 const baselines:Record<string,string>={};const visible:Record<string,EssScalar>={};
 for(const [id,value]of Object.entries(values)){baselines[id]=baseline(value);visible[id]=personnelField(id)?.ess.masked&&typeof value==='string'&&value?`•••• ${value.slice(-4)}`:value;}
 return {values:visible,baselines};
}
function baseline(value:EssScalar|undefined){return 'sha256:'+createHash('sha256').update(JSON.stringify(value??null)).digest('hex');}
const legacyAddress=(master:typeof person.$inferSelect)=>({addressLine1:master.addressLine1,addressLine2:master.addressLine2,addressLine3:master.addressLine3,postcode:master.postcode,city:master.city,state:master.state,country:master.country});
function addressNeedsReview(master:typeof person.$inferSelect){
 return ['AddressLine1','AddressLine2','AddressLine3','Postcode','City','State','Country'].some((part,index)=>{
  const old=Object.values(legacyAddress(master))[index],current=record(master)['permanent'+part];return Boolean(old)&&old!==current;
 });
}
/** Private workspace contains explicitly visible fields only; no admin-row spread crosses RSC. */
export function readOwnProfileWorkspace(ctx:SessionContext,p:{employmentId?:string}={}){
 return withTenant(ctx,async tx=>{
  const policy=await freshProfileEditPolicyTx(tx,ctx);const {subject,master}=await ownProfileSubjectTx(tx,policy.ctx,p.employmentId,false);
  const rows=await mastersTx(tx,policy.ctx,subject);
  const mayEdit=(await myOwnEmploymentSubjectsTx(tx,policy.ctx,{profileEdit:true})).some(row=>row.employmentId===subject.id);
  const values={...readonlyValues('person',master),...registryValues('person',master),...registryValues('compliance',master)};
  const age=PERSONNEL_FIELDS.find(field=>field.owner==='person'&&field.ownerField==='age');if(age)values[age.id]=childAgeYears(master.dateOfBirth);
  if(rows.pack&&!rows.stat)for(const field of PERSONNEL_FIELDS)if(field.ess.visibility==='visible'&&field.ess.binding&&!['person','compliance','dependent','qualification','emergency'].includes(field.ess.binding.owner))values[field.id]=null;
  if(rows.stat){Object.assign(values,readonlyValues('zakat',{status:rows.stat.zakatActive?'active':'inactive',stateAuthority:rows.stat.zakatState,method:rows.stat.zakatMethod,rate:rows.stat.zakatMethod==='fixed'?rows.stat.zakatFixed:rows.stat.zakatPercent}));Object.assign(values,readonlyValues('statutory',rows.stat));for(const owner of ['bank','identity','passport','registration','taxLegacy'])Object.assign(values,registryValues(owner,rows.stat));}
  if(rows.stat){
   const epfMode=rows.pack?.client.payroll.epfUiModeFrom;
   if(epfMode){const stat=rows.stat,numberOrNull=(value:unknown)=>value==null?null:Number(value);for(const field of PERSONNEL_FIELDS.filter(field=>field.ess.visibility==='visible'&&field.owner==='statutory'&&field.ownerField==='epfUiMode'))values[field.id]=epfMode(stat.epfMode,numberOrNull(stat.epfEmployeeRate),numberOrNull(stat.epfEmployerRate),numberOrNull(stat.epfEmployeeAmount),numberOrNull(stat.epfEmployerAmount));}
   for(const field of PERSONNEL_FIELDS)if(field.ess.visibility==='visible'&&field.childReliefCell)values[field.id]=scalar(personnelChildReliefValue(rows.stat.childReliefTable,field.childReliefCell).value);
   const relief=await qualifyingChildReliefFor(policy.ctx,{personId:subject.personId,country:subject.country??'',asOf:todayInKualaLumpur()},tx);
   if(relief)for(const field of PERSONNEL_FIELDS.filter(field=>field.ess.visibility==='visible'&&field.owner==='statutory')){
    if(field.ownerField==='qualifyingChildren')values[field.id]=relief.qualifyingChildren;
    if(field.ownerField==='childReliefAmount')values[field.id]=relief.reliefRM;
   }
  }
  const primary=rows.emergency.filter(row=>row.priority==='primary');
  const registers:EssRecord[]=[...rows.dependents.map(row=>({kind:'dependent' as const,id:row.id,...safeValues({...registryValues('dependent',row),...readonlyValues('dependent',{age:childAgeYears(row.dateOfBirth),countsTowardRelief:isChildReliefEligible(row)})}),primary:false})),...rows.qualifications.map(row=>({kind:'qualification' as const,id:row.id,...safeValues(registryValues('qualification',row)),primary:false})),...rows.emergency.map(row=>({kind:'emergency' as const,id:row.id,...safeValues(registryValues('emergency',row)),primary:primary.length===1&&primary[0].id===row.id}))];
  return {employmentId:subject.id,personId:subject.personId,country:subject.country,...safeValues(values),registers,editable:mayEdit?[...policy.editable]:[],legacyPrimaryEditable:mayEdit?[...policy.legacyPrimary]:[],addressReview:addressNeedsReview(master),legacyAddress:legacyAddress(master),statutoryAvailable:Boolean(rows.pack)} satisfies EssWorkspace;
 });
}

/** Validation and baseline comparison run again at approval, never trusting the editor or stored JSON. */
export async function prepareProfileProposalTx(tx:Tx,ctx:SessionContext,employmentId:string,raw:unknown,approval=false){
 const proposal=parseEssProfileProposal(raw);const policy=await freshProfileEditPolicyTx(tx,ctx);
 let subject:Awaited<ReturnType<typeof ownProfileSubjectTx>>['subject'],master:typeof person.$inferSelect;
 if(approval){
  if(!(ctx.roles??[]).some(role=>role==='super_admin'||role==='hr_admin'))throw new EssProfileError('permission');
  const scoped=await tx.execute(sql`select app.can_admin_employment(${employmentId}::uuid) allowed`);
  if((scoped as unknown as {allowed:boolean}[])[0]?.allowed!==true)throw new EssProfileError('permission');
  const [row]=await tx.select({id:employment.id,personId:employment.personId,companyId:employment.companyId,country:company.country}).from(employment).innerJoin(company,eq(company.id,employment.companyId)).where(and(eq(employment.tenantId,ctx.tenantId),eq(employment.id,employmentId))).limit(1).for('update');
  if(!row)throw new EssProfileError('unavailable');if(row.personId===ctx.personId)throw new EssProfileError('permission');subject=row;
  const [p]=await tx.select().from(person).where(eq(person.id,row.personId)).limit(1).for('update');if(!p)throw new EssProfileError('unavailable');master=p;
 }else({subject,master}=await ownProfileSubjectTx(tx,policy.ctx,employmentId));
 const rows=await mastersTx(tx,policy.ctx,subject);
 const current:Record<string,EssScalar>={...registryValues('person',master),...registryValues('compliance',master)};
 if(rows.stat)for(const owner of ['bank','identity','passport','registration','taxLegacy'])Object.assign(current,registryValues(owner,rows.stat));
 const cleanFields=(fields:EssFieldChange[],values:Record<string,EssScalar>,legacy=false,isNew=false)=>fields.filter(change=>{
  const field=personnelField(change.fieldId)!;
  if(!policy.editable.has(field.id)&&!(legacy&&policy.legacyPrimary.has(field.id)))throw new EssProfileError('fieldClosed',[field.id]);
  if(!(isNew&&change.before===null)&&baseline(values[field.id])!==change.before)throw new EssProfileError('stale',[field.id]);
  return !sameEssScalar(change.value,values[field.id]);
 });
 const fields=cleanFields(proposal.fields,current);
 for(const change of fields){const f=personnelField(change.fieldId)!;
  if(f.ess.binding?.owner!=='person'&&f.ess.binding?.owner!=='compliance'&&!rows.pack)throw new EssProfileError('unavailable',[f.id]);
  if(f.allowedValuesOwner?.startsWith('profile_option:'))await assertProfileValueAllowed(tx,f.allowedValuesOwner.slice(15) as Parameters<typeof assertProfileValueAllowed>[1],change.value,current[change.fieldId]);
 }
 const bankChanges=fields.filter(change=>personnelField(change.fieldId)!.ess.binding!.owner==='bank');
 if(bankChanges.length){
  if(!rows.stat)throw new EssProfileError('unavailable',bankChanges.map(field=>field.fieldId));
  const next={...rows.stat,...patch(bankChanges)};
  const bank=bankChanges.find(change=>personnelField(change.fieldId)!.ess.binding!.field==='bankName');
  if(bank&&typeof bank.value==='string'&&bank.value.trim()&&!rows.pack?.client.bankNames.includes(bank.value.trim()))throw new EssProfileError('invalid',[bank.fieldId]);
  if(Boolean(next.bankName)!==Boolean(next.bankAccountNo)||customHolderGaps({enableCustomHolderName:next.enableCustomHolderName,customHolderName:next.customHolderName,enableCustomHolderId:next.enableCustomHolderId,customHolderId:next.customHolderId}).length)throw new EssProfileError('invalid',bankChanges.map(field=>field.fieldId));
 }
 const identityChanges=fields.filter(change=>personnelField(change.fieldId)!.ess.binding?.owner==='identity');
 if(identityChanges.length){
  if(!rows.pack)throw new EssProfileError('unavailable',identityChanges.map(field=>field.fieldId));
  const previous={icNumber:rows.stat?.icNumber,oldIcNumber:rows.stat?.oldIcNumber},next={...previous,...patch(identityChanges)};
  if(!rows.pack.statutory.canApplyIcChange(previous,{icNumber:text(next,'icNumber'),oldIcNumber:text(next,'oldIcNumber')}))throw new EssProfileError('invalid',identityChanges.map(field=>field.fieldId));
 }
 const passportChanges=fields.filter(change=>personnelField(change.fieldId)!.ess.binding!.owner==='passport');
 const nationalityChange=fields.find(change=>personnelField(change.fieldId)!.ess.binding?.owner==='person'&&personnelField(change.fieldId)!.ess.binding?.field==='nationality');
 if(passportChanges.length||nationalityChange){
  if(!rows.pack)throw new EssProfileError('unavailable',[...passportChanges.map(field=>field.fieldId),...(nationalityChange?[nationalityChange.fieldId]:[])]);
  const next={passportNumber:rows.stat?.passportNumber,passportIssueDate:rows.stat?.passportIssueDate,passportExpiryDate:rows.stat?.passportExpiryDate,passportRemark:rows.stat?.passportRemark,passportIssuingCountry:rows.stat?.passportIssuingCountry,passportIssuingCountryCode:rows.stat?.passportIssuingCountryCode,...patch(passportChanges)},own=patch(fields.filter(change=>personnelField(change.fieldId)!.ess.binding!.owner==='person'));
  if(!rows.pack.statutory.validatePassport({personId:subject.personId,passportNumber:next.passportNumber,passportIssueDate:next.passportIssueDate,passportExpiryDate:next.passportExpiryDate,passportRemark:next.passportRemark,passportIssuingCountry:next.passportIssuingCountry,passportIssuingCountryCode:next.passportIssuingCountryCode},own.nationality===undefined?master.nationality:text(own,'nationality')))throw new EssProfileError('invalid',[...passportChanges.map(field=>field.fieldId),...(nationalityChange?[nationalityChange.fieldId]:[])]);
 }
 const registers:EssRegisterChange[]=[];const immediateRegisters:EssRegisterChange[]=[];
 for(const row of proposal.registers){
  const list=row.kind==='dependent'?rows.dependents:row.kind==='qualification'?rows.qualifications:rows.emergency;
  const existing=row.id?list.find(item=>item.id===row.id):null;if(row.id&&!existing)throw new EssProfileError('stale',row.fields.map(field=>field.fieldId));
  const primary=rows.emergency.filter(item=>item.priority==='primary');
  const legacy=!approval&&row.kind==='emergency'&&row.id!==null&&primary.length===1&&primary[0].id===row.id;
  const values=existing?registryValues(row.kind,existing):{};
  const changed=cleanFields(row.fields,values,legacy,row.id===null);if(!changed.length)continue;
  const merged={...(existing?record(existing):{}),...patch(changed)};
  if(row.kind==='qualification')await validateQualificationInputTx(tx,qualificationInput(merged),existing&&'qualification' in existing?existing:undefined);
  if(row.kind==='emergency')await validateEmergencyContactInputTx(tx,subject.personId,emergencyInput(merged),existing&&'relationship' in existing?existing:undefined);
  if(row.kind==='dependent')await validateDependentInputTx(tx,dependentInput(merged),rows.dependents.find(item=>item.id===row.id));
  const next={...row,fields:changed};
  const legacyFields=legacy?changed.filter(change=>!policy.editable.has(change.fieldId)&&policy.legacyPrimary.has(change.fieldId)):[];
  const requestedFields=changed.filter(change=>!legacyFields.includes(change));
  if(legacyFields.length)immediateRegisters.push({...next,fields:legacyFields});
  if(requestedFields.length)registers.push({...next,fields:requestedFields});
 }
 if(approval&&immediateRegisters.length)throw new EssProfileError('invalid');
 return {ctx:policy.ctx,proposal:{v:2 as const,fields,registers},immediateRegisters,subject,master,rows};
}
function personInput(values:Record<string,EssScalar>):PersonProfileFields{
 return {salutation:text(values,'salutation'),firstName:text(values,'firstName'),lastName:text(values,'lastName'),preferredName:text(values,'preferredName'),nationality:text(values,'nationality'),religion:text(values,'religion'),race:text(values,'race'),personalEmail:text(values,'personalEmail'),homePhone:text(values,'homePhone'),permanentAddressLine1:text(values,'permanentAddressLine1'),permanentAddressLine2:text(values,'permanentAddressLine2'),permanentAddressLine3:text(values,'permanentAddressLine3'),permanentPostcode:text(values,'permanentPostcode'),permanentCity:text(values,'permanentCity'),permanentState:text(values,'permanentState'),permanentCountry:text(values,'permanentCountry'),correspondenceAddressLine1:text(values,'correspondenceAddressLine1'),correspondenceAddressLine2:text(values,'correspondenceAddressLine2'),correspondenceAddressLine3:text(values,'correspondenceAddressLine3'),correspondencePostcode:text(values,'correspondencePostcode'),correspondenceCity:text(values,'correspondenceCity'),correspondenceState:text(values,'correspondenceState'),correspondenceCountry:text(values,'correspondenceCountry'),correspondenceMobilePhone:text(values,'correspondenceMobilePhone'),correspondenceHomePhone:text(values,'correspondenceHomePhone')};
}
function dependentInput(values:Record<string,unknown>):DependentInput{
 const p=values as Record<string,EssScalar>;const name=text(p,'fullName'),relationship=text(p,'relationship');if(!name||!relationship)throw new EssProfileError('invalid');
 return {fullName:name,relationship,dateOfBirth:text(p,'dateOfBirth'),gender:text(p,'gender'),icOrPassport:text(p,'icOrPassport'),passportNumber:text(p,'passportNumber'),phone:text(p,'phone'),residentialAddress:text(p,'residentialAddress'),isBeneficiary:boolean(p,'isBeneficiary'),isDeceased:boolean(p,'isDeceased'),marriageDate:text(p,'marriageDate'),marriageStatus:text(p,'marriageStatus'),spouseWorking:nullableBoolean(p,'spouseWorking'),isStudent:nullableBoolean(p,'isStudent'),schoolName:text(p,'schoolName'),studyLevel:text(p,'studyLevel'),studyCountry:text(p,'studyCountry'),childReliefCategory:text(p,'childReliefCategory'),childTaxRelief:nullableBoolean(p,'childTaxRelief'),childReliefPercentage:number(p,'childReliefPercentage')};
}
function qualificationInput(values:Record<string,unknown>){
 const p=values as Record<string,EssScalar>;const qualification=text(p,'qualification');if(!qualification)throw new EssProfileError('invalid');
 return {qualification,description:text(p,'description'),fromYm:text(p,'fromYm'),toYm:text(p,'toYm'),institute:text(p,'institute'),major:text(p,'major'),graduationDate:text(p,'graduationDate'),result:text(p,'result'),isHighest:boolean(p,'isHighest')};
}
function emergencyInput(values:Record<string,unknown>){
 const p=values as Record<string,EssScalar>;const fullName=text(p,'fullName');if(!fullName)throw new EssProfileError('invalid');
 const raw=text(p,'priority');const priority=raw==null?undefined:EMERGENCY_CONTACT_PRIORITIES.find(item=>item===raw);if(raw!=null&&!priority)throw new EssProfileError('invalid');
 return {fullName,relationship:text(p,'relationship'),mobilePhone:text(p,'mobilePhone'),homePhone:text(p,'homePhone'),address:text(p,'address'),priority};
}
async function applyRegisterTx(tx:Tx,ctx:SessionContext,subject:{id:string;personId:string},row:EssRegisterChange){
 const values=patch(row.fields);
 if(row.kind==='dependent'){
  if(values.childReliefPercentage!==undefined&&values.childReliefPercentage!==null)values.childReliefPercentage=number(values,'childReliefPercentage')??null;
  if(row.id)await updateDependent(ctx,{id:row.id,...values},tx);else await addDependent(ctx,{personId:subject.personId,...dependentInput(values)},tx);
 }else if(row.kind==='qualification'){
  if(row.id)await updateQualification(ctx,{id:row.id,...values},tx);else await addQualification(ctx,{employmentId:subject.id,...qualificationInput(values)},tx);
 }else{
  if(row.id)await updateEmergencyContact(ctx,{id:row.id,...values},tx);else await addEmergencyContact(ctx,{personId:subject.personId,...emergencyInput(values)},tx);
 }
}
export async function applyProfileProposalTx(tx:Tx,ctx:SessionContext,employmentId:string,raw:unknown){
 const prepared=await prepareProfileProposalTx(tx,ctx,employmentId,raw,true);
 await applyScalarFieldsTx(tx,prepared,prepared.proposal.fields);
 for(const row of prepared.proposal.registers)await applyRegisterTx(tx,prepared.ctx,prepared.subject,row);
 return prepared.proposal;
}
async function applyScalarFieldsTx(tx:Tx,prepared:Awaited<ReturnType<typeof prepareProfileProposalTx>>,fields:EssFieldChange[]){
 const {ctx,subject,master,rows}=prepared;
 const grouped=(owner:string)=>patch(fields.filter(change=>personnelField(change.fieldId)!.ess.binding!.owner===owner));
 const own=grouped('person');
 if(Object.keys(own).length&&fields.every(change=>personnelField(change.fieldId)!.ess.edit==='immediate')){await updateOwnContact(ctx,{phone:text(own,'phone'),personalEmail:text(own,'personalEmail')},tx);return;}
 if(Object.keys(own).length)await updatePersonProfilePartial(ctx,{personId:master.id,fullName:text(own,'fullName')??undefined,primaryEmail:text(own,'primaryEmail')??undefined,phone:text(own,'phone'),...personInput(own),via:'employee-profile'},tx);
 const compliance=grouped('compliance');if(Object.keys(compliance).length)await setPersonComplianceFields(ctx,{employmentId:subject.id,dateOfBirth:text(compliance,'dateOfBirth'),gender:text(compliance,'gender'),maritalStatus:text(compliance,'maritalStatus')},tx);
 const pack=rows.pack,stat=rows.stat;
 for(const owner of ['bank','identity','passport','registration','taxLegacy']){
  const values=grouped(owner);if(!Object.keys(values).length)continue;if(!pack)throw new EssProfileError('unavailable',fields.map(field=>field.fieldId));
  if(owner==='bank'){
   if(!stat)throw new EssProfileError('unavailable',fields.map(field=>field.fieldId));
   const bankName=values.bankName===undefined?stat.bankName:text(values,'bankName'),bankAccountNo=values.bankAccountNo===undefined?stat.bankAccountNo:text(values,'bankAccountNo');
   if(Boolean(bankName)!==Boolean(bankAccountNo))throw new EssProfileError('invalid',fields.map(field=>field.fieldId));
   await pack.statutory.setBank(ctx,{personId:master.id,bankName,bankAccountNo,enableCustomHolderName:boolean(values,'enableCustomHolderName')??stat.enableCustomHolderName,customHolderName:values.customHolderName===undefined?stat.customHolderName:text(values,'customHolderName'),enableCustomHolderId:boolean(values,'enableCustomHolderId')??stat.enableCustomHolderId,customHolderId:values.customHolderId===undefined?stat.customHolderId:text(values,'customHolderId')},tx);
  }else if(owner==='identity')await pack.statutory.setIc(ctx,{personId:master.id,icNumber:(values.icNumber===undefined?stat?.icNumber:text(values,'icNumber'))??'',oldIcNumber:values.oldIcNumber===undefined?stat?.oldIcNumber:text(values,'oldIcNumber')},tx);
  else if(owner==='passport')await pack.statutory.setPassport(ctx,{personId:master.id,passportNumber:values.passportNumber===undefined?stat?.passportNumber:text(values,'passportNumber'),passportIssueDate:values.passportIssueDate===undefined?stat?.passportIssueDate:text(values,'passportIssueDate'),passportExpiryDate:values.passportExpiryDate===undefined?stat?.passportExpiryDate:text(values,'passportExpiryDate'),passportIssuingCountry:values.passportIssuingCountry===undefined?stat?.passportIssuingCountry:text(values,'passportIssuingCountry'),passportIssuingCountryCode:values.passportIssuingCountryCode===undefined?stat?.passportIssuingCountryCode:text(values,'passportIssuingCountryCode'),passportRemark:stat?.passportRemark},tx);
  else if(owner==='registration'){if(!stat)throw new EssProfileError('unavailable',fields.map(field=>field.fieldId));if(!pack.statutory.setRegistrationNumbers)throw new EssProfileError('unavailable',fields.map(field=>field.fieldId));await pack.statutory.setRegistrationNumbers(ctx,{personId:master.id,epfNumber:text(values,'epfNumber'),socsoNumber:text(values,'socsoNumber')},tx);}
  else {if(!stat)throw new EssProfileError('unavailable',fields.map(field=>field.fieldId));await pack.statutory.setTax(ctx,{personId:master.id,taxNumber:values.taxNumber===undefined?stat.taxNumber:text(values,'taxNumber'),taxCategory:number(values,'taxCategory')??stat.taxCategory,numChildren:number(values,'numChildren')??stat.numChildren,taxCircumstance:stat.taxCircumstance,taxResidency:stat.taxResidency,childReliefMode:stat.childReliefMode,employerBearsTax:stat.employerBearsTax,disabledIndividual:stat.disabledIndividual,disabledSpouse:stat.disabledSpouse,childReliefTable:stat.childReliefTable},tx);}
 }
}
/** No-op/cancel do not call this owner. Omitted facts retain; explicit clears are validated. */
export function submitOwnProfileEdit(ctx:SessionContext,p:{employmentId:string;proposal:unknown}){
 return withTenant(ctx,async tx=>{
  const prepared=await prepareProfileProposalTx(tx,ctx,p.employmentId,p.proposal);
  const immediate=prepared.proposal.fields.filter(change=>personnelField(change.fieldId)!.ess.edit==='immediate');
  const waiting={v:2 as const,fields:prepared.proposal.fields.filter(change=>personnelField(change.fieldId)!.ess.edit==='approval'),registers:prepared.proposal.registers};
  // Immediate changes and request insert share this exact Tx; a late refusal rolls everything back.
  await applyScalarFieldsTx(tx,prepared,immediate);
  for(const row of prepared.immediateRegisters)await applyRegisterTx(tx,prepared.ctx,prepared.subject,row);
  const result=waiting.fields.length||waiting.registers.length?await requestProfileChange(prepared.ctx,{employmentId:prepared.subject.id,proposed:waiting},tx):null;
  return {saved:immediate.map(field=>field.fieldId).concat(prepared.immediateRegisters.flatMap(row=>row.fields.map(field=>field.fieldId))),waiting:waiting.fields.map(field=>field.fieldId).concat(waiting.registers.flatMap(row=>row.fields.map(field=>field.fieldId))),requestId:result?.requestId??null};
 });
}
