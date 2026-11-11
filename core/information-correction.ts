import {deriveCompanyOrganisationTx,recordEmploymentOrganisationTagsTx} from './company-organisation';
/** Approved 8550b282: one transactional owner for manual and Excel information-only correction. */
import {createHash} from 'node:crypto';
import {alias} from 'drizzle-orm/pg-core';
import {and,asc,desc,eq,inArray,isNull,sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {appendEvent,actorOf} from '../db/events';
import {employment,assignment,company,jobGrade,person,appUser,domainEvent,department,position,businessUnit,reportingLine,profileOption} from '../db/schema';
import {setEmploymentInfo as writeEmploymentInfo,setReportingLine as writeReportingLine} from './workforce-commands';
import {assertProfileValueAllowed} from './profile-options';
import {deriveEmploymentStatus} from './employment-status';
import {publicErrorMessage} from '../lib/public-error';
import {EMPLOYMENT_PERIOD_UNITS} from '../lib/employment-period';
import {lockLeaveDependenciesTx,lockLeaveDependencyConfigurationTx} from './leave-dependency-lock';
import {lockEmploymentStatutoryOwnerTx,wouldCreateAdminCycle} from './org';
import {assertWorkforceEmploymentTx,assertWorkforceCompanyTx,workforceEmploymentPredicate} from './workforce-access';
import {allocationCompanyCode} from './cost-allocation-import';
import {labelUsableByCompany,visibleLabelIdsCondition} from './system-labels';
import {todayInKualaLumpur} from '../lib/hr-date';
import {contractPeriodIssues} from '../lib/contract-period';
import {isCalendarDate} from '../lib/calendar-date';
import {PERSONNEL_EMPLOYMENT_TYPES} from '../lib/personnel-choice-vocabulary';
import {INFORMATION_FIELDS,INFORMATION_ALL_FIELDS,INFORMATION_ASSIGNMENT_FIELDS,INFORMATION_LABEL_FIELDS,INFORMATION_PERIOD_FIELDS,INFORMATION_PERIOD_PAIRS,INFORMATION_FIELD_CAPTIONS,type InformationField,type InformationOptions,type InformationChanges,type InformationValues,type InformationPreview} from '../lib/information-correction';
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
 // ccd3a65c — the open Direct Superior line is part of the reviewed state, so a concurrent superior change
 // invalidates the preview.
 const [line]=await tx.select({id:reportingLine.id,managerEmploymentId:reportingLine.managerEmploymentId,validFrom:reportingLine.validFrom}).from(reportingLine).where(and(eq(reportingLine.tenantId,ctx.tenantId),eq(reportingLine.subordinateEmploymentId,id),eq(reportingLine.lineType,'administrative'),isNull(reportingLine.validTo),isNull(reportingLine.supersededAt))).orderBy(desc(reportingLine.validFrom),asc(reportingLine.id)).limit(1);
 return {emp,current:current[0],assignments,line:line??null,name:identity.name,fingerprint:hash({emp,assignments,line:line??null,marker:marker?.sequence??0})};
}
export async function informationCorrectionOptions(ctx:SessionContext){return withTenant(ctx,async tx=>{
 if(!ctx.userId)fail('Sign in before reviewing employment corrections.');
 const [principal]=await tx.execute<{ok:boolean}>(sql`select app.principal_snapshot_current() and app.is_admin() as ok`);if(!principal?.ok)fail('Only an authorised HR administrator can review employment corrections.');
 const companies=await tx.select({id:company.id,label:company.companyLabel,registration:company.registrationNo,name:company.legalName}).from(company).where(and(eq(company.tenantId,ctx.tenantId),isNull(company.archivedAt),sql`app.principal_snapshot_current() and app.is_admin_for(${company.id}) and app.access_workforce_company(${company.id},'workforce.maintain')`));
 const grades=await tx.select({id:jobGrade.id,code:jobGrade.code,name:jobGrade.name}).from(jobGrade).where(and(eq(jobGrade.tenantId,ctx.tenantId),isNull(jobGrade.archivedAt)));
 const coded=companies.map(c=>({id:c.id,name:c.name,code:allocationCompanyCode(c)}));
 // ccd3a65c — the options usable by each company (the same visibility owner the Movement import catalog uses).
 const organisation:NonNullable<InformationOptions['organisation']>=[];
 for(const co of coded){
  const departments=await tx.select({id:department.id,code:department.name,label:department.label}).from(department).where(and(eq(department.tenantId,ctx.tenantId),isNull(department.archivedAt),visibleLabelIdsCondition(department,'department',[co.id]))).orderBy(asc(department.name),asc(department.id));
  const positions=await tx.select({id:position.id,code:position.title,label:position.label}).from(position).where(and(eq(position.tenantId,ctx.tenantId),isNull(position.archivedAt),visibleLabelIdsCondition(position,'position',[co.id]))).orderBy(asc(position.title),asc(position.id));
  const units=await tx.select({id:businessUnit.id,code:businessUnit.code,label:businessUnit.name}).from(businessUnit).where(and(eq(businessUnit.tenantId,ctx.tenantId),isNull(businessUnit.archivedAt),visibleLabelIdsCondition(businessUnit,'business_unit',[co.id]))).orderBy(asc(businessUnit.name),asc(businessUnit.id));
  for(const [kind,rows] of [['department',departments],['position',positions],['business_unit',units]] as const)for(const row of rows)if(row.code)organisation.push({companyId:co.id,companyCode:co.code,kind,id:row.id,code:row.code,name:row.label?.trim()||row.code});
 }
 const labels=(await tx.select({category:profileOption.category,value:profileOption.value,label:profileOption.label}).from(profileOption).where(and(eq(profileOption.tenantId,ctx.tenantId),eq(profileOption.isActive,true),inArray(profileOption.category,Object.values(LABEL_CATEGORY)))).orderBy(asc(profileOption.category),asc(profileOption.sortOrder),asc(profileOption.value)))
  .flatMap(row=>{const field=(Object.keys(LABEL_CATEGORY) as (keyof typeof LABEL_CATEGORY)[]).find(key=>LABEL_CATEGORY[key]===row.category);return field?[{field,value:row.value,label:row.label}]:[];});
 return {companies:coded,grades,employmentTypes:[...PERSONNEL_EMPLOYMENT_TYPES],organisation,labels} satisfies InformationOptions;
 });}
const text=(value:number|string|null|undefined)=>value==null?null:String(value);
function values(s:Awaited<ReturnType<typeof stateTx>>):InformationValues{const e=s.emp;return {companyId:e.companyId,hiredOn:e.hiredOn,joinDate:e.joinDate,gradeId:e.gradeId,employmentType:s.current.employmentType,contractEndDate:e.contractEndDate,internshipEndDate:e.internshipEndDate,
 businessUnitId:s.current.businessUnitId,departmentId:s.current.departmentId,positionId:s.current.positionId,
 orgDivision:e.orgDivision,orgBranch:e.orgBranch,orgRegion:e.orgRegion,orgLine:e.orgLine,orgSection:e.orgSection,orgTeam:e.orgTeam,orgBase:e.orgBase,employmentCategory:e.employmentCategory,
 probationValue:text(e.probationValue),probationUnit:e.probationUnit,extendedProbationValue:text(e.extendedProbationValue),extendedProbationUnit:e.extendedProbationUnit,confirmationDate:e.confirmationDate,
 noticeBeforeConfirmationValue:text(e.noticeBeforeConfirmationValue),noticeBeforeConfirmationUnit:e.noticeBeforeConfirmationUnit,noticeAfterConfirmationValue:text(e.noticeAfterConfirmationValue),noticeAfterConfirmationUnit:e.noticeAfterConfirmationUnit,
 managerEmploymentId:s.line?.managerEmploymentId??null};}
const UNIT_LABELS:Record<string,string>={month:'Month',week:'Week',day:'Day'};
async function labelsTx(tx:Tx,v:InformationValues):Promise<InformationValues>{
 const [co]=await tx.select({name:company.legalName}).from(company).where(eq(company.id,v.companyId!));
 const [grade]=v.gradeId?await tx.select({name:jobGrade.name}).from(jobGrade).where(eq(jobGrade.id,v.gradeId)):[];
 const [dept]=v.departmentId?await tx.select({name:department.name,label:department.label}).from(department).where(eq(department.id,v.departmentId)):[];
 const [pos]=v.positionId?await tx.select({name:position.title,label:position.label}).from(position).where(eq(position.id,v.positionId)):[];
 const [unit]=v.businessUnitId?await tx.select({name:businessUnit.name,label:businessUnit.label}).from(businessUnit).where(eq(businessUnit.id,v.businessUnitId)):[];
 const [manager]=v.managerEmploymentId?await tx.select({code:employment.employeeCode,name:person.fullName}).from(employment).innerJoin(person,eq(person.id,employment.personId)).where(eq(employment.id,v.managerEmploymentId)):[];
 const named=(row:{name:string|null;label:string|null}|undefined,fallback:string|null)=>row?(row.label?.trim()||row.name||fallback):fallback;
 const unitLabel=(value:string|null)=>value?UNIT_LABELS[value]??value:value;
 return {...v,companyId:co?.name??v.companyId,gradeId:grade?.name??v.gradeId,departmentId:named(dept,v.departmentId),positionId:named(pos,v.positionId),businessUnitId:named(unit,v.businessUnitId),
  managerEmploymentId:manager?[manager.code,manager.name].filter(Boolean).join(' · '):v.managerEmploymentId,
  probationUnit:unitLabel(v.probationUnit),extendedProbationUnit:unitLabel(v.extendedProbationUnit),noticeBeforeConfirmationUnit:unitLabel(v.noticeBeforeConfirmationUnit),noticeAfterConfirmationUnit:unitLabel(v.noticeAfterConfirmationUnit)};
}
const LABEL_CATEGORY={orgDivision:'division',orgBranch:'branch',orgRegion:'region',orgLine:'line',orgSection:'section',orgTeam:'team',orgBase:'base',employmentCategory:'category'} as const;
const ORGANISATION_KIND={departmentId:'department',positionId:'position',businessUnitId:'business_unit'} as const;
const caption=(field:InformationField)=>INFORMATION_FIELD_CAPTIONS[field];
/** Owner refusals become row errors that name the template column. */
function ownerFailure(error:unknown,field:InformationField):never{
 if(error instanceof InformationCorrectionError)throw error;
 fail(`${caption(field)}: ${publicErrorMessage(error)}`);
}
/** Extended fields need the owners' Access/leave configuration locks; take them before any row lock. */
const OWNER_FIELDS=new Set<string>([...INFORMATION_LABEL_FIELDS,...INFORMATION_PERIOD_FIELDS,'managerEmploymentId']);
export const informationChangesUseOwners=(changes:InformationChanges)=>Object.keys(changes).some(field=>OWNER_FIELDS.has(field));
/** Loading the form may expose invalid legacy values so the user can correct them. */
export function readInformationCorrection(ctx:SessionContext,employmentId:string){
 return withTenant(ctx,async tx=>{
  const state=await stateTx(tx,ctx,employmentId),before=values(state),beforeLabels=await labelsTx(tx,before);
  return {effectiveOn:todayInKualaLumpur(),before,beforeLabels};
 });
}
async function validateTx(tx:Tx,ctx:SessionContext,s:Awaited<ReturnType<typeof stateTx>>,changes:InformationChanges,extended:boolean){
 const before=values(s),after={...before};
 // The single-employee correction keeps its five facts; the further details are corrected through the template.
 const allowed:readonly InformationField[]=extended?INFORMATION_ALL_FIELDS:INFORMATION_FIELDS;
 if(!extended&&Object.keys(changes).some(field=>(INFORMATION_ALL_FIELDS as readonly string[]).includes(field)&&!(INFORMATION_FIELDS as readonly string[]).includes(field)))fail('Use the Information-Only Correction template to correct these details.');
 for(const field of allowed){const value=changes[field];if(value!==undefined){if(typeof value!=='string'||!value.trim())fail('Empty correction values cannot clear existing information.');after[field]=value.trim();}}
 for(const key of ['hiredOn','joinDate','contractEndDate','internshipEndDate'] as const)if(after[key]&&!isCalendarDate(after[key]!))fail('Use a valid date in YYYY-MM-DD format.');
 if(after.hiredOn!>todayInKualaLumpur()||(after.joinDate&&after.joinDate>todayInKualaLumpur()))fail('Joining dates cannot be in the future.');
 if(after.joinDate&&after.joinDate<after.hiredOn!)fail('Join Date cannot precede Group Join Date.');
 if(after.confirmationDate!==before.confirmationDate&&!isCalendarDate(after.confirmationDate!))fail('Confirmation Date: use YYYY-MM-DD or an Excel date.');
 if(after.confirmationDate!==before.confirmationDate&&after.confirmationDate!<after.hiredOn!)fail('Confirmation Date: cannot be earlier than the Group Join Date.');
 const endDates=[s.emp.terminatedOn,s.emp.probationEndDate,s.emp.contractStartDate,after.contractEndDate,after.internshipEndDate,after.confirmationDate,s.emp.resignationDate,s.emp.lastWorkingDate].filter((x):x is string=>!!x);
 if(endDates.some(date=>date<after.hiredOn!))fail('The corrected date conflicts with existing employment dates. Use the relevant workflow.');
 if(after.confirmationDate&&after.confirmationDate!==before.confirmationDate){
  if(s.emp.extendedConfirmationDate&&s.emp.extendedConfirmationDate<after.confirmationDate)fail('Confirmation Date: cannot be later than the extended confirmation date. Use Employment Movement for the probation extension.');
 }
 if(!PERSONNEL_EMPLOYMENT_TYPES.includes(after.employmentType as typeof PERSONNEL_EMPLOYMENT_TYPES[number]))fail('Employment Type is not a valid system code.');
 // 2260a06b — the type end dates are corrected here too, for the type this correction leaves the employee with.
 // Their prerequisites still apply only when the correction changes Employment Type or the date itself: a legacy
 // contract with no end date can still have its grade, dates or company corrected. The date may arrive in the
 // same correction that changes the type, which is what lets a change to Intern succeed at all. The contract
 // order rule is 1859cce0's single owner (lib/contract-period.ts).
 const typeChanged=after.employmentType!==before.employmentType;
 const contractEndChanged=after.contractEndDate!==before.contractEndDate,internshipEndChanged=after.internshipEndDate!==before.internshipEndDate;
 if(contractEndChanged&&after.employmentType!=='contract')fail('Contract End Date applies only to Contract employees.');
 if(internshipEndChanged&&after.employmentType!=='intern')fail('Internship End Date applies only to Intern employees.');
 const started=after.joinDate??after.hiredOn!;
 let contractStartDate:string|null=s.emp.contractStartDate;
 if(after.employmentType==='contract'&&(typeChanged||contractEndChanged)){
  // A correction says the employee was on contract all along, so a missing contract start is the join date,
  // exactly as hireEmployee seeds it.
  contractStartDate??=started;
  if(!after.contractEndDate)fail('Contract employment requires valid contract start and end dates.');
  const order=contractPeriodIssues({contract:true,requireBoth:false,start:contractStartDate,end:after.contractEndDate});
  if(order.length)fail(order[0].message);
 }
 if(after.employmentType==='intern'&&(typeChanged||internshipEndChanged)){
  if(!after.internshipEndDate)fail('Intern employment requires an internship end date.');
  if(after.internshipEndDate<=started)fail('Internship end date must be later than the join date.');
 }
 if(contractEndChanged||contractStartDate!==s.emp.contractStartDate){
  const [open]=await tx.execute<{open:boolean}>(sql`select app.contract_renewal_open(${s.emp.id}::uuid) as open`);
  if(open?.open)fail('A contract renewal is in progress for this employee. Change the contract dates through that renewal in Contract Management.');
 }
 await administratorTx(tx,ctx,after.companyId!);
 const companies=await tx.select().from(company).where(and(eq(company.tenantId,ctx.tenantId),inArray(company.id,[before.companyId!,after.companyId!]),isNull(company.archivedAt)));
 const source=companies.find(c=>c.id===before.companyId),destination=companies.find(c=>c.id===after.companyId);
 if(!source||!destination)fail('Company is unavailable.');
 if(source.country!==destination.country)fail('A cross-country company change requires the operational transfer workflow.');
 if(after.gradeId&&after.gradeId!==before.gradeId){const [grade]=await tx.select({id:jobGrade.id}).from(jobGrade).where(and(eq(jobGrade.id,after.gradeId),eq(jobGrade.tenantId,ctx.tenantId),isNull(jobGrade.archivedAt)));if(!grade)fail('Job Grade is not an active system code.');}
 if(after.companyId!==before.companyId){
  const tags=await deriveCompanyOrganisationTx(tx,ctx,{companyId:after.companyId!,asOf:todayInKualaLumpur()});
  for(const [kind,id] of [['department',after.departmentId],['position',after.positionId],['business_unit',tags.status==='legacy'?after.businessUnitId:tags.businessUnitId],['cost_center',s.current.costCenterId]] as const)if(id&&!await labelUsableByCompany(tx,ctx.tenantId,kind,id,after.companyId!))fail('Existing organisation details are not usable by the corrected company. Use Employment Movement.');
  if(s.current.locationId) {const [loc]=await tx.execute<{ok:boolean}>(sql`select exists(select 1 from location where id=${s.current.locationId}::uuid and company_id=${after.companyId}::uuid and archived_at is null) as ok`);if(!loc?.ok)fail('The current work location belongs to another company. Use Employment Movement.');}
  const duplicate=await tx.select({id:employment.id}).from(employment).where(and(eq(employment.companyId,after.companyId!),eq(employment.employeeCode,s.emp.employeeCode??'')));
  if(duplicate.some(e=>e.id!==s.emp.id))fail('Employee ID is already used in the destination company.');
  if(s.assignments.some(a=>!a.companyId))fail('Historical company information is incomplete. Resolve the dated company history before correcting Company.');
 }
 if(extended)await validateExtendedTx(tx,ctx,s,before,after);
 return {before,after,contractStartDate};
}
/** ccd3a65c — the further details, checked against the resulting company's settings before any write. The
 * owners repeat their own checks when the correction is saved; these give the row error its column. */
async function validateExtendedTx(tx:Tx,ctx:SessionContext,s:Awaited<ReturnType<typeof stateTx>>,before:InformationValues,after:InformationValues){
 const changed=(field:InformationField)=>after[field]!==before[field];
 for(const field of INFORMATION_ASSIGNMENT_FIELDS){
  if(!changed(field))continue;
  const id=after[field]!,kind=ORGANISATION_KIND[field];
  const [row]=field==='departmentId'?await tx.select({id:department.id}).from(department).where(and(eq(department.id,id),eq(department.tenantId,ctx.tenantId),isNull(department.archivedAt)))
   :field==='positionId'?await tx.select({id:position.id}).from(position).where(and(eq(position.id,id),eq(position.tenantId,ctx.tenantId),isNull(position.archivedAt)))
   :await tx.select({id:businessUnit.id}).from(businessUnit).where(and(eq(businessUnit.id,id),eq(businessUnit.tenantId,ctx.tenantId),isNull(businessUnit.archivedAt)));
  if(!row||!await labelUsableByCompany(tx,ctx.tenantId,kind,id,after.companyId!))fail(`${caption(field)}: not an active option for this company. Check the reference sheet.`);
 }
 if(changed('businessUnitId')){
  const tags=await deriveCompanyOrganisationTx(tx,ctx,{companyId:after.companyId!,asOf:todayInKualaLumpur()});
  if(tags.status!=='legacy')fail('Business Unit: the Group structure sets the Business Unit for this company. Leave this cell blank.');
 }
 for(const field of INFORMATION_LABEL_FIELDS){
  if(!changed(field))continue;
  try{await assertProfileValueAllowed(tx,LABEL_CATEGORY[field],after[field],before[field],after.companyId);}
  catch{fail(`${caption(field)}: "${after[field]}" is not an active ${caption(field)} option for this company. Check the reference sheet.`);}
 }
 for(const [value,unit] of INFORMATION_PERIOD_PAIRS){
  if(changed(value)){if(!/^\d{1,4}$/.test(after[value]!))fail(`${caption(value)}: enter a whole number of 0 or more.`);after[value]=String(Number(after[value]));}
  if(changed(unit)){const normal=after[unit]!.toLowerCase();if(!(EMPLOYMENT_PERIOD_UNITS as readonly string[]).includes(normal))fail(`${caption(unit)}: use Month, Week or Day.`);after[unit]=normal;}
  if((changed(value)||changed(unit))&&(after[value]===null)!==(after[unit]===null))fail(`${caption(value)}: enter the period and its unit together.`);
 }
 if(changed('managerEmploymentId')){
  const id=after.managerEmploymentId!;
  if(id===s.emp.id)fail('Direct Superior: an employee cannot report to themselves.');
  const today=todayInKualaLumpur();
  const [manager]=await tx.select({id:employment.id,companyId:employment.companyId,hiredOn:employment.hiredOn,terminatedOn:employment.terminatedOn,resignationDate:employment.resignationDate,lastWorkingDate:employment.lastWorkingDate,blacklistedAt:employment.blacklistedAt,isTestRecord:employment.isTestRecord})
   .from(employment).where(and(eq(employment.id,id),eq(employment.tenantId,ctx.tenantId),workforceEmploymentPredicate(sql`${employment.id}`,'view'))).limit(1);
  // An unknown and an invisible superior read the same, so the preview reveals nobody the user cannot view.
  if(!manager||manager.companyId!==after.companyId)fail('Direct Superior: the Employee ID is unknown in this company or not visible to you.');
  if(manager.isTestRecord)fail('Direct Superior: a test record cannot be a Direct Superior.');
  if(manager.terminatedOn||manager.hiredOn>today||['resigned','blacklisted'].includes(deriveEmploymentStatus(manager,today)))fail('Direct Superior: this employee is not an active employee.');
  if(await wouldCreateAdminCycle(tx,s.emp.id,id,today))fail('Direct Superior: this would create a reporting loop.');
 }
}
async function previewTx(tx:Tx,ctx:SessionContext,input:{employmentId:string;changes:InformationChanges;reason:string},extended=false){
 const reason=typeof input.reason==='string'?input.reason.trim():'';
 if(reason.length<3||reason.length>1000)fail('Provide a correction reason between 3 and 1,000 characters.');
 const state=await stateTx(tx,ctx,input.employmentId),v=await validateTx(tx,ctx,state,input.changes,extended);
 if(INFORMATION_ALL_FIELDS.some(f=>v.before[f]!==v.after[f])){const [history]=await tx.execute<{ready:boolean}>(sql`select app.information_payroll_ready(${state.emp.id}::uuid) as ready`);if(!history?.ready)fail('Original historical information cannot be verified after intervening changes. Ask the payroll administrator to reconcile the historical document evidence before correcting this record.');}
 const companyRefs=await tx.select({id:company.id,label:company.companyLabel,registration:company.registrationNo,name:company.legalName,country:company.country,currency:company.currency,archivedAt:company.archivedAt}).from(company).where(inArray(company.id,[v.before.companyId!,v.after.companyId!])).orderBy(asc(company.id)).for('share');
 const gradeIds=[...new Set([v.before.gradeId,v.after.gradeId].filter((id):id is string=>!!id))];
 const gradeRefs=gradeIds.length?await tx.select({id:jobGrade.id,code:jobGrade.code,name:jobGrade.name,archivedAt:jobGrade.archivedAt}).from(jobGrade).where(inArray(jobGrade.id,gradeIds)).orderBy(asc(jobGrade.id)).for('share'):[];
 const effectiveOn=todayInKualaLumpur();
 const organisation=await deriveCompanyOrganisationTx(tx,ctx,{companyId:v.after.companyId!,asOf:effectiveOn});
 const beforeLabels=await labelsTx(tx,v.before),afterLabels=await labelsTx(tx,v.after);
 const changed=INFORMATION_ALL_FIELDS.filter(f=>v.before[f]!==v.after[f]);
 // Five-fact corrections keep their original fingerprint; the further details also bind the displayed labels.
 const extendedChange=changed.some(f=>!(INFORMATION_FIELDS as readonly string[]).includes(f));
 const fingerprint=hash({state:state.fingerprint,companies:companyRefs,grades:gradeRefs,effectiveOn,...(organisation.status==='legacy'?{}:{organisation}),...(extendedChange?{labels:[beforeLabels,afterLabels]}:{})});
 const preview:InformationPreview={effectiveOn,employmentId:state.emp.id,employeeCode:state.emp.employeeCode??'',name:state.name,fingerprint,before:v.before,after:v.after,beforeLabels,afterLabels,reason,changed};
 return {state,preview};
}
class InformationRehearsal extends Error{constructor(readonly preview:InformationPreview){super('information_preview_rollback');}}
/** Excel previews of the further details rehearse the owners' writes and roll back, so every refusal the save
 * would meet (closed payroll, reporting loop, catalog) is shown as a row error before confirmation. */
export async function previewInformationCorrection(ctx:SessionContext,input:{employmentId:string;changes:InformationChanges;reason:string},options:{extended?:boolean}={}){
 if(!options.extended||!informationChangesUseOwners(input.changes))return withTenant(ctx,async tx=>(await previewTx(tx,ctx,input,!!options.extended)).preview);
 try{await withTenant(ctx,async tx=>{
  await tx.execute(sql`select app.access_workforce_write_lock()`);await lockLeaveDependencyConfigurationTx(tx,ctx.tenantId);
  const {state,preview}=await previewTx(tx,ctx,input,true);
  if(preview.changed.length)await applyTx(tx,ctx,state,preview,{method:'excel'});
  throw new InformationRehearsal(preview);
 });}catch(error){if(error instanceof InformationRehearsal)return error.preview;throw error;}
 fail('The correction review could not be completed.');
}
/** No recalculation or operational workflow is called from this command. Caller may add import audit in this transaction. */
export async function correctInformationTx(tx:Tx,ctx:SessionContext,input:{employmentId:string;changes:InformationChanges;reason:string;fingerprint:string;method:'manual'|'excel';batchId?:string;filename?:string}){
 const extended=input.method==='excel';
 // Owner configuration locks first (the Movement import order), then the employee's own locks in stateTx.
 if(extended&&informationChangesUseOwners(input.changes)){await tx.execute(sql`select app.access_workforce_write_lock()`);await lockLeaveDependencyConfigurationTx(tx,ctx.tenantId);}
 const {state:s,preview:p}=await previewTx(tx,ctx,input,extended);
 if(input.fingerprint!==p.fingerprint)fail('The employee changed after your review. Review the correction again.');
 if(!p.changed.length)return {preview:p,changed:false};
 await applyTx(tx,ctx,s,p,input);
 return {preview:p,changed:true};
}
async function applyTx(tx:Tx,ctx:SessionContext,s:Awaited<ReturnType<typeof stateTx>>,p:InformationPreview,input:{method:'manual'|'excel';batchId?:string;filename?:string}){
 // The preimage protects every existing persisted output before any master information changes.
 const [preserved]=await tx.execute<{count:number}>(sql`select app.preserve_information_payroll(${s.emp.id}::uuid) as count`);
 if(!preserved)fail('Historical payroll metadata could not be protected.');
 const effectiveOn=p.effectiveOn;
 let assignmentVersionId:string|null=null;
 if(p.changed.some(field=>field==='companyId'||field==='employmentType'||(INFORMATION_ASSIGNMENT_FIELDS as readonly string[]).includes(field))){
  const {id:_id,createdAt:_created,recordedAt:_recorded,supersededAt:_superseded,...prior}=s.current;
  if(s.current.validFrom===effectiveOn)await tx.update(assignment).set({supersededAt:new Date()}).where(eq(assignment.id,s.current.id));
  else await tx.update(assignment).set({validTo:effectiveOn}).where(eq(assignment.id,s.current.id));
  const tags=await deriveCompanyOrganisationTx(tx,ctx,{companyId:p.after.companyId!,asOf:effectiveOn});
  const [version]=await tx.insert(assignment).values({...prior,departmentId:p.after.departmentId??prior.departmentId,positionId:p.after.positionId,businessUnitId:p.after.businessUnitId,...(tags.status==='legacy'?{}:{businessUnitId:tags.businessUnitId}),validFrom:effectiveOn,validTo:null,companyId:p.after.companyId,employmentType:p.after.employmentType as typeof s.current.employmentType}).returning({id:assignment.id});
  assignmentVersionId=version.id;
 }
 // 2260a06b — the type end dates live on employment. A change to Contract with no stored contract start starts it
 // on the join date (as hireEmployee does). provisional_end_on follows the internship date only while it is still
 // that date's copy (setEmploymentInfo applies the same rule), so the review and status fallbacks agree.
 const contractStartDate=p.after.employmentType==='contract'&&(p.changed.includes('employmentType')||p.changed.includes('contractEndDate'))?(s.emp.contractStartDate??p.after.joinDate??p.after.hiredOn):s.emp.contractStartDate;
 const internshipProvisional=p.changed.includes('internshipEndDate')&&p.after.internshipEndDate&&s.emp.provisionalEndOn!=null&&s.emp.provisionalEndOn===s.emp.internshipEndDate?{provisionalEndOn:p.after.internshipEndDate}:{};
 await tx.update(employment).set({companyId:p.after.companyId!,hiredOn:p.after.hiredOn!,joinDate:p.after.joinDate,gradeId:p.after.gradeId,contractStartDate,contractEndDate:p.after.contractEndDate,internshipEndDate:p.after.internshipEndDate,...internshipProvisional}).where(eq(employment.id,s.emp.id));
 // ccd3a65c — labels, periods and Confirmation Date through their owner, untagged: no movement row is
 // projected, the catalog, date-order and closed-payroll checks apply, and employment.info.updated records it.
 const info=p.changed.filter(field=>(INFORMATION_LABEL_FIELDS as readonly string[]).includes(field)||(INFORMATION_PERIOD_FIELDS as readonly string[]).includes(field));
 if(info.length){
  const patch:Record<string,string|number|null>={};for(const field of info)patch[field]=field.endsWith('Value')&&p.after[field]!==null?Number(p.after[field]):p.after[field];
  try{await writeEmploymentInfo(ctx,{employmentId:s.emp.id,...patch} as unknown as Parameters<typeof writeEmploymentInfo>[1],tx);}
  catch(error){ownerFailure(error,info.includes('confirmationDate')&&/onfirm|payroll/.test(String((error as Error)?.message))?'confirmationDate':info[0]);}
 }
 // The Direct Superior through the dated reporting-line owner from today, untagged (no movement row).
 if(p.changed.includes('managerEmploymentId')){
  try{await writeReportingLine(ctx,{subordinateEmploymentId:s.emp.id,managerEmploymentId:p.after.managerEmploymentId!,lineType:'administrative',validFrom:effectiveOn},tx);}
  catch(error){ownerFailure(error,'managerEmploymentId');}
 }
 await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'employment',aggregateId:s.emp.id,eventType:INFORMATION_CORRECTED_EVENT,actor:actorOf(ctx),subjectEmploymentId:s.emp.id,payload:{employeeCode:p.employeeCode,before:p.before,after:p.after,beforeLabels:p.beforeLabels,afterLabels:p.afterLabels,fields:p.changed,reason:p.reason,effectiveOn,method:input.method,batchId:input.batchId??null,filename:input.filename??null,snapshotCount:preserved.count,assignmentVersionId,previousAssignmentId:s.current.id}});
 await recordEmploymentOrganisationTagsTx(tx,ctx,{employmentId:s.emp.id,companyId:p.after.companyId!,asOf:effectiveOn,trigger:'correction'});
}
export function correctInformation(ctx:SessionContext,input:Parameters<typeof correctInformationTx>[2]){return withTenant(ctx,tx=>correctInformationTx(tx,ctx,input));}
export function informationCorrectionHistory(ctx:SessionContext,employmentId:string){return withTenant(ctx,async tx=>{await assertWorkforceEmploymentTx(tx,ctx,employmentId,'view');const [allowed]=await tx.execute<{ok:boolean}>(sql`select exists(select 1 from employment where id=${employmentId}::uuid and tenant_id=${ctx.tenantId}::uuid and app.principal_snapshot_current() and app.is_admin_for(company_id)) as ok`);if(!allowed?.ok)fail('You do not have permission to review this correction history.');return tx.select({id:domainEvent.id,at:domainEvent.occurredAt,actorId:domainEvent.actorId,actorName:correctionActor.fullName,payload:domainEvent.payload}).from(domainEvent).leftJoin(correctionAccount,and(eq(correctionAccount.id,domainEvent.actorId),eq(correctionAccount.tenantId,ctx.tenantId))).leftJoin(correctionActor,and(eq(correctionActor.id,correctionAccount.personId),eq(correctionActor.tenantId,ctx.tenantId))).where(and(eq(domainEvent.subjectEmploymentId,employmentId),eq(domainEvent.eventType,INFORMATION_CORRECTED_EVENT))).orderBy(desc(domainEvent.sequence)).limit(100);});}
