/** Approved 8550b282: one transactional owner for manual and Excel information-only correction. */
import {createHash} from 'node:crypto';
import {alias} from 'drizzle-orm/pg-core';
import {and,asc,desc,eq,inArray,isNull,sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {appendEvent,actorOf} from '../db/events';
import {employment,assignment,company,jobGrade,person,appUser,domainEvent} from '../db/schema';
import {lockLeaveDependenciesTx} from './leave-dependency-lock';
import {lockEmploymentStatutoryOwnerTx} from './org';
import {assertWorkforceEmploymentTx,assertWorkforceCompanyTx} from './workforce-access';
import {allocationCompanyCode} from './cost-allocation-import';
import {labelUsableByCompany} from './system-labels';
import {todayInKualaLumpur} from '../lib/hr-date';
import {isCalendarDate} from '../lib/calendar-date';
import {PERSONNEL_EMPLOYMENT_TYPES} from '../lib/personnel-choice-vocabulary';
import {INFORMATION_FIELDS,type InformationChanges,type InformationValues,type InformationPreview} from '../lib/information-correction';
const correctionActor=alias(person,'correction_actor'),correctionAccount=alias(appUser,'correction_account');
export const INFORMATION_CORRECTED_EVENT='employment.information.corrected';
export class InformationCorrectionError extends Error {constructor(message:string){super(message);this.name='InformationCorrectionError';}}
function fail(message:string):never {throw new InformationCorrectionError(message);}
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function administratorTx(tx:Tx,ctx:SessionContext,companyId:string){
 await assertWorkforceCompanyTx(tx,ctx,companyId,'maintain');
 const [gate]=await tx.execute<{ok:boolean}>(sql`select app.principal_snapshot_current() and app.is_admin_for(${companyId}::uuid) as ok`);
 if(!ctx.userId||!gate?.ok)fail('You do not have permission to correct this company.');
}
async function stateTx(tx:Tx,ctx:SessionContext,id:string){
 await assertWorkforceEmploymentTx(tx,ctx,id,'maintain');
 await lockLeaveDependenciesTx(tx,ctx.tenantId,[id]);
 await lockEmploymentStatutoryOwnerTx(tx,id);
 const [emp]=await tx.select().from(employment).where(and(eq(employment.id,id),eq(employment.tenantId,ctx.tenantId))).for('update');
 if(!emp)fail('Employee record is unavailable.');
 await administratorTx(tx,ctx,emp.companyId);
 const assignments=await tx.select().from(assignment).where(and(eq(assignment.employmentId,id),isNull(assignment.supersededAt))).orderBy(asc(assignment.validFrom)).for('update');
 const current=assignments.filter(a=>a.validTo===null);
 if(current.length!==1||current[0].validFrom>todayInKualaLumpur())fail('A unique current assignment is required. Review Employment Movement.');
 if(current[0].companyId&&current[0].companyId!==emp.companyId)fail('Current company and dated assignment disagree. Reconcile the employment history before correcting information.');
 if(emp.terminatedOn&&emp.terminatedOn<=todayInKualaLumpur())fail('Use the employment lifecycle workflow for a terminated employee.');
 const [identity]=await tx.select({name:person.fullName}).from(person).where(eq(person.id,emp.personId));
 if(!identity)fail('Employee identity is unavailable.');
 const [marker]=await tx.select({sequence:domainEvent.sequence}).from(domainEvent).where(and(eq(domainEvent.tenantId,ctx.tenantId),eq(domainEvent.subjectEmploymentId,id))).orderBy(desc(domainEvent.sequence)).limit(1);
 return {emp,current:current[0],assignments,name:identity.name,fingerprint:hash({emp,assignments,marker:marker?.sequence??0})};
}
export async function informationCorrectionOptions(ctx:SessionContext){return withTenant(ctx,async tx=>{
 if(!ctx.userId)fail('Sign in before reviewing employment corrections.');
 const [principal]=await tx.execute<{ok:boolean}>(sql`select app.principal_snapshot_current() and app.is_admin() as ok`);if(!principal?.ok)fail('Only an authorised HR administrator can review employment corrections.');
 const companies=await tx.select({id:company.id,label:company.companyLabel,registration:company.registrationNo,name:company.legalName}).from(company).where(and(eq(company.tenantId,ctx.tenantId),isNull(company.archivedAt),sql`app.principal_snapshot_current() and app.is_admin_for(${company.id}) and app.access_workforce_company(${company.id},'workforce.maintain')`));
 const grades=await tx.select({id:jobGrade.id,code:jobGrade.code,name:jobGrade.name}).from(jobGrade).where(and(eq(jobGrade.tenantId,ctx.tenantId),isNull(jobGrade.archivedAt)));
 return {companies:companies.map(c=>({id:c.id,name:c.name,code:allocationCompanyCode(c)})),grades,employmentTypes:[...PERSONNEL_EMPLOYMENT_TYPES]};
 });}
function values(s:Awaited<ReturnType<typeof stateTx>>):InformationValues{return {companyId:s.emp.companyId,hiredOn:s.emp.hiredOn,joinDate:s.emp.joinDate,gradeId:s.emp.gradeId,employmentType:s.current.employmentType};}
async function labelsTx(tx:Tx,v:InformationValues):Promise<InformationValues>{
 const [co]=await tx.select({name:company.legalName}).from(company).where(eq(company.id,v.companyId!));
 const [grade]=v.gradeId?await tx.select({name:jobGrade.name}).from(jobGrade).where(eq(jobGrade.id,v.gradeId)):[];
 return {...v,companyId:co?.name??v.companyId,gradeId:grade?.name??v.gradeId};
}
async function validateTx(tx:Tx,ctx:SessionContext,s:Awaited<ReturnType<typeof stateTx>>,changes:InformationChanges){
 const before=values(s),after={...before};
 for(const field of INFORMATION_FIELDS){const value=changes[field];if(value!==undefined){if(typeof value!=='string'||!value.trim())fail('Empty correction values cannot clear existing information.');after[field]=value.trim();}}
 for(const key of ['hiredOn','joinDate'] as const)if(after[key]&&!isCalendarDate(after[key]!))fail('Use a valid date in YYYY-MM-DD format.');
 if(after.hiredOn!>todayInKualaLumpur()||(after.joinDate&&after.joinDate>todayInKualaLumpur()))fail('Joining dates cannot be in the future.');
 if(after.joinDate&&after.joinDate<after.hiredOn!)fail('Join Date cannot precede Group Join Date.');
 const endDates=[s.emp.terminatedOn,s.emp.probationEndDate,s.emp.contractStartDate,s.emp.contractEndDate,s.emp.internshipEndDate,s.emp.confirmationDate,s.emp.resignationDate,s.emp.lastWorkingDate].filter((x):x is string=>!!x);
 if(endDates.some(date=>date<after.hiredOn!))fail('The corrected date conflicts with existing employment dates. Use the relevant workflow.');
 if(!PERSONNEL_EMPLOYMENT_TYPES.includes(after.employmentType as typeof PERSONNEL_EMPLOYMENT_TYPES[number]))fail('Employment Type is not a valid system code.');
 if(after.employmentType==='contract'&&(!s.emp.contractStartDate||!s.emp.contractEndDate))fail('Contract employment requires valid contract start and end dates.');
 if(after.employmentType==='intern'&&!s.emp.internshipEndDate)fail('Intern employment requires an internship end date.');
 await administratorTx(tx,ctx,after.companyId!);
 const companies=await tx.select().from(company).where(and(eq(company.tenantId,ctx.tenantId),inArray(company.id,[before.companyId!,after.companyId!]),isNull(company.archivedAt)));
 const source=companies.find(c=>c.id===before.companyId),destination=companies.find(c=>c.id===after.companyId);
 if(!source||!destination)fail('Company is unavailable.');
 if(source.country!==destination.country)fail('A cross-country company change requires the operational transfer workflow.');
 if(after.gradeId&&after.gradeId!==before.gradeId){const [grade]=await tx.select({id:jobGrade.id}).from(jobGrade).where(and(eq(jobGrade.id,after.gradeId),eq(jobGrade.tenantId,ctx.tenantId),isNull(jobGrade.archivedAt)));if(!grade)fail('Job Grade is not an active system code.');}
 if(after.companyId!==before.companyId){
  for(const [kind,id] of [['department',s.current.departmentId],['position',s.current.positionId],['business_unit',s.current.businessUnitId],['cost_center',s.current.costCenterId]] as const)if(id&&!await labelUsableByCompany(tx,ctx.tenantId,kind,id,after.companyId!))fail('Existing organisation details are not usable by the corrected company. Use Employment Movement.');
  if(s.current.locationId) {const [loc]=await tx.execute<{ok:boolean}>(sql`select exists(select 1 from location where id=${s.current.locationId}::uuid and company_id=${after.companyId}::uuid and archived_at is null) as ok`);if(!loc?.ok)fail('The current work location belongs to another company. Use Employment Movement.');}
  const duplicate=await tx.select({id:employment.id}).from(employment).where(and(eq(employment.companyId,after.companyId!),eq(employment.employeeCode,s.emp.employeeCode??'')));
  if(duplicate.some(e=>e.id!==s.emp.id))fail('Employee ID is already used in the destination company.');
  if(s.assignments.some(a=>!a.companyId))fail('Historical company information is incomplete. Resolve the dated company history before correcting Company.');
 }
 return {before,after};
}
async function previewTx(tx:Tx,ctx:SessionContext,input:{employmentId:string;changes:InformationChanges;reason:string}){
 const reason=typeof input.reason==='string'?input.reason.trim():'';
 if(reason.length<3||reason.length>1000)fail('Provide a correction reason between 3 and 1,000 characters.');
 const state=await stateTx(tx,ctx,input.employmentId),v=await validateTx(tx,ctx,state,input.changes);
 if(INFORMATION_FIELDS.some(f=>v.before[f]!==v.after[f])){const [history]=await tx.execute<{ready:boolean}>(sql`select app.information_payroll_ready(${state.emp.id}::uuid) as ready`);if(!history?.ready)fail('Original historical information cannot be verified after intervening changes. Ask the payroll administrator to reconcile the historical document evidence before correcting this record.');}
 const companyRefs=await tx.select({id:company.id,label:company.companyLabel,registration:company.registrationNo,name:company.legalName,country:company.country,currency:company.currency,archivedAt:company.archivedAt}).from(company).where(inArray(company.id,[v.before.companyId!,v.after.companyId!])).orderBy(asc(company.id)).for('share');
 const gradeIds=[...new Set([v.before.gradeId,v.after.gradeId].filter((id):id is string=>!!id))];
 const gradeRefs=gradeIds.length?await tx.select({id:jobGrade.id,code:jobGrade.code,name:jobGrade.name,archivedAt:jobGrade.archivedAt}).from(jobGrade).where(inArray(jobGrade.id,gradeIds)).orderBy(asc(jobGrade.id)).for('share'):[];
 const effectiveOn=todayInKualaLumpur();
 const fingerprint=hash({state:state.fingerprint,companies:companyRefs,grades:gradeRefs,effectiveOn});
 const preview:InformationPreview={effectiveOn,employmentId:state.emp.id,employeeCode:state.emp.employeeCode??'',name:state.name,fingerprint,...v,beforeLabels:await labelsTx(tx,v.before),afterLabels:await labelsTx(tx,v.after),reason,changed:INFORMATION_FIELDS.filter(f=>v.before[f]!==v.after[f])};
 return {state,preview};
}
export function previewInformationCorrection(ctx:SessionContext,input:{employmentId:string;changes:InformationChanges;reason:string}){return withTenant(ctx,async tx=>(await previewTx(tx,ctx,input)).preview);}
/** No recalculation or operational workflow is called from this command. Caller may add import audit in this transaction. */
export async function correctInformationTx(tx:Tx,ctx:SessionContext,input:{employmentId:string;changes:InformationChanges;reason:string;fingerprint:string;method:'manual'|'excel';batchId?:string;filename?:string}){
 const {state:s,preview:p}=await previewTx(tx,ctx,input);
 if(input.fingerprint!==p.fingerprint)fail('The employee changed after your review. Review the correction again.');
 if(!p.changed.length)return {preview:p,changed:false};
 // The preimage protects every existing persisted output before any master information changes.
 const [preserved]=await tx.execute<{count:number}>(sql`select app.preserve_information_payroll(${s.emp.id}::uuid) as count`);
 if(!preserved)fail('Historical payroll metadata could not be protected.');
 const effectiveOn=p.effectiveOn;
 let assignmentVersionId:string|null=null;
 if(p.changed.includes('companyId')||p.changed.includes('employmentType')){
  const {id:_id,createdAt:_created,recordedAt:_recorded,supersededAt:_superseded,...prior}=s.current;
  if(s.current.validFrom===effectiveOn)await tx.update(assignment).set({supersededAt:new Date()}).where(eq(assignment.id,s.current.id));
  else await tx.update(assignment).set({validTo:effectiveOn}).where(eq(assignment.id,s.current.id));
  const [version]=await tx.insert(assignment).values({...prior,validFrom:effectiveOn,validTo:null,companyId:p.after.companyId,employmentType:p.after.employmentType as typeof s.current.employmentType}).returning({id:assignment.id});
  assignmentVersionId=version.id;
 }
 await tx.update(employment).set({companyId:p.after.companyId!,hiredOn:p.after.hiredOn!,joinDate:p.after.joinDate,gradeId:p.after.gradeId}).where(eq(employment.id,s.emp.id));
 await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'employment',aggregateId:s.emp.id,eventType:INFORMATION_CORRECTED_EVENT,actor:actorOf(ctx),subjectEmploymentId:s.emp.id,payload:{employeeCode:p.employeeCode,before:p.before,after:p.after,beforeLabels:p.beforeLabels,afterLabels:p.afterLabels,fields:p.changed,reason:p.reason,effectiveOn,method:input.method,batchId:input.batchId??null,filename:input.filename??null,snapshotCount:preserved.count,assignmentVersionId,previousAssignmentId:s.current.id}});
 return {preview:p,changed:true};
}
export function correctInformation(ctx:SessionContext,input:Parameters<typeof correctInformationTx>[2]){return withTenant(ctx,tx=>correctInformationTx(tx,ctx,input));}
export function informationCorrectionHistory(ctx:SessionContext,employmentId:string){return withTenant(ctx,async tx=>{await assertWorkforceEmploymentTx(tx,ctx,employmentId,'view');const [allowed]=await tx.execute<{ok:boolean}>(sql`select exists(select 1 from employment where id=${employmentId}::uuid and tenant_id=${ctx.tenantId}::uuid and app.principal_snapshot_current() and app.is_admin_for(company_id)) as ok`);if(!allowed?.ok)fail('You do not have permission to review this correction history.');return tx.select({id:domainEvent.id,at:domainEvent.occurredAt,actorId:domainEvent.actorId,actorName:correctionActor.fullName,payload:domainEvent.payload}).from(domainEvent).leftJoin(correctionAccount,and(eq(correctionAccount.id,domainEvent.actorId),eq(correctionAccount.tenantId,ctx.tenantId))).leftJoin(correctionActor,and(eq(correctionActor.id,correctionAccount.personId),eq(correctionActor.tenantId,ctx.tenantId))).where(and(eq(domainEvent.subjectEmploymentId,employmentId),eq(domainEvent.eventType,INFORMATION_CORRECTED_EVENT))).orderBy(desc(domainEvent.sequence)).limit(100);});}
