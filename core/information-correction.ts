import { lockAccessConfigurationTx } from './access-configuration-lock';
import { alignedInformationDateSql, withAlignedInformationDate } from './information-correction-date';
import {correctionAuditLabelsTx} from './information-correction-audit';
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
import {lockEmploymentStatutoryOwnerTx,wouldCreateAdminCycle,writeDirectSuperiorTx} from './org';
import {assertWorkforceEmploymentTx,assertWorkforceCompanyTx,workforceEmploymentPredicate} from './workforce-access';
import {withAccessDisplayRead} from './access-configuration-lock';
import {allocationCompanyCode} from './cost-allocation-import';
import {labelCompanyIdsSql,labelUsableByCompany,visibleLabelIdsCondition} from './system-labels';
import {todayInKualaLumpur} from '../lib/hr-date';
import {payrollPreservationRefusal} from './closed-payroll-correction-authority';
import {alignHistoryStartTx,salaryStartKeptTx,MovementHistoryError,DATED_ASSIGNMENT_FIELDS,INFORMATION_BOUNDARY_REAPPLIED_EVENT,planDatedCorrection,writeDatedCorrectionTx,closedPayrollInSpanTx,companyRecordOnTx,type CorrectionCarry,type DatedAssignmentField,type DatedCorrectionPlan} from './movement-history';
import {recordedMovementChangesTx,type RecordedMovementChange} from './movement';
import {closedPeriodsTx,overlapsClosedPeriod} from './comp';
import {contractPeriodIssues} from '../lib/contract-period';
import {isCalendarDate} from '../lib/calendar-date';
import {PERSONNEL_EMPLOYMENT_TYPES} from '../lib/personnel-choice-vocabulary';
import {INFORMATION_FIELDS,INFORMATION_SCREEN_FIELDS,INFORMATION_ALL_FIELDS,INFORMATION_ASSIGNMENT_FIELDS,INFORMATION_LABEL_FIELDS,INFORMATION_PERIOD_FIELDS,INFORMATION_PERIOD_PAIRS,INFORMATION_FIELD_CAPTIONS,type InformationField,type InformationOptions,type InformationChanges,type InformationWarning,type InformationValues,type InformationPreview,type InformationConflict,type InformationTimelineRecord,type InformationReplacedCorrection} from '../lib/information-correction';
const correctionActor=alias(person,'correction_actor'),correctionAccount=alias(appUser,'correction_account');
export const INFORMATION_CORRECTED_EVENT='employment.information.corrected';
export class InformationCorrectionError extends Error {constructor(message:string){super(message);this.name='InformationCorrectionError';}}
function fail(message:string):never {throw new InformationCorrectionError(message);}
/** Aligning the dated records to a later Group Join Date, refused in this screen's own words. */
function alignMessage(code:string){
 const [kind,...rest]=code.split(':'),detail=rest.join(':');
 if(kind==='movement_history_earlier_change')return `A change recorded on ${detail} is before the new Group Join Date. Correct or roll back that change first, or use an earlier join date.`;
 if(kind==='movement_history_payroll_company')return `Payroll for ${detail} was closed before the new Group Join Date. Reopen that payroll, or use an earlier join date.`;
 return 'The employee\'s dated records could not be aligned to the Group Join Date.';
}
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function administratorTx(tx:Tx,ctx:SessionContext,companyId:string){
 await assertWorkforceCompanyTx(tx,ctx,companyId,'maintain');
 const [gate]=await tx.execute<{ok:boolean}>(sql`select app.principal_snapshot_current() and app.is_admin_for(${companyId}::uuid) as ok`);
 if(!ctx.userId||!gate?.ok)fail('You do not have permission to correct this company.');
}
type StateMode='read'|'write';
/** 'read' is the form load and the review (inside withAccessDisplayRead): the same authority checks and values,
 * without the leave-dependency, statutory-owner and row locks that a correction holds until it commits. The save
 * repeats every check in 'write' mode and compares the fingerprint. */
async function stateTx(tx:Tx,ctx:SessionContext,id:string,mode:StateMode='write'){
 const write=mode==='write';
 await assertWorkforceEmploymentTx(tx,ctx,id,'maintain');
 if(write){await lockLeaveDependenciesTx(tx,ctx.tenantId,[id]);await lockEmploymentStatutoryOwnerTx(tx,id);}
 const employmentRow=tx.select().from(employment).where(and(eq(employment.id,id),eq(employment.tenantId,ctx.tenantId)));
 const [emp]=write?await employmentRow.for('update'):await employmentRow;
 if(!emp)fail('Employee record is unavailable.');
 await administratorTx(tx,ctx,emp.companyId);
 const assignmentRows=tx.select().from(assignment).where(and(eq(assignment.employmentId,id),isNull(assignment.supersededAt))).orderBy(asc(assignment.validFrom));
 const assignments=write?await assignmentRows.for('update'):await assignmentRows;
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
/** Presentation for the correction form, the template and the import preview: it takes no Access lock of its own, and
 * any Workforce helper reached inside joins the lock shared (withAccessDisplayRead, SCALE rule 1). */
export async function informationCorrectionOptions(ctx:SessionContext){return withAccessDisplayRead(()=>withTenant(ctx,async tx=>{
 if(!ctx.userId)fail('Sign in before reviewing employment corrections.');
 const [principal]=await tx.execute<{ok:boolean}>(sql`select app.principal_snapshot_current() and app.is_admin() as ok`);if(!principal?.ok)fail('Only an authorised HR administrator can review employment corrections.');
 const companies=await tx.select({id:company.id,label:company.companyLabel,registration:company.registrationNo,name:company.legalName}).from(company).where(and(eq(company.tenantId,ctx.tenantId),isNull(company.archivedAt),sql`app.principal_snapshot_current() and app.is_admin_for(${company.id}) and app.access_workforce_company(${company.id},'workforce.maintain')`));
 const grades=await tx.select({id:jobGrade.id,code:jobGrade.code,name:jobGrade.name}).from(jobGrade).where(and(eq(jobGrade.tenantId,ctx.tenantId),isNull(jobGrade.archivedAt)));
 const coded=companies.map(c=>({id:c.id,name:c.name,code:allocationCompanyCode(c)}));
 // ccd3a65c — the options usable by each company (the same visibility owner the Movement import catalog uses).
 // One statement per kind for every company at once (SCALE rule 2): the labels usable by any of them, with their
 // Global flag and saved company criteria, expanded per company here. A label is usable by a company exactly when
 // visibleLabelIdsCondition(table,kind,[company]) holds: Global, or assigned to that company. Order is unchanged:
 // company, then department/position/business unit, then code and id.
 const companyIds=coded.map(c=>c.id);
 const departments=await tx.select({id:department.id,code:department.name,label:department.label,isGlobal:department.isGlobal,companyIds:labelCompanyIdsSql(department,'department')}).from(department).where(and(eq(department.tenantId,ctx.tenantId),isNull(department.archivedAt),visibleLabelIdsCondition(department,'department',companyIds))).orderBy(asc(department.name),asc(department.id));
 const positions=await tx.select({id:position.id,code:position.title,label:position.label,isGlobal:position.isGlobal,companyIds:labelCompanyIdsSql(position,'position')}).from(position).where(and(eq(position.tenantId,ctx.tenantId),isNull(position.archivedAt),visibleLabelIdsCondition(position,'position',companyIds))).orderBy(asc(position.title),asc(position.id));
 const units=await tx.select({id:businessUnit.id,code:businessUnit.code,label:businessUnit.name,isGlobal:businessUnit.isGlobal,companyIds:labelCompanyIdsSql(businessUnit,'business_unit')}).from(businessUnit).where(and(eq(businessUnit.tenantId,ctx.tenantId),isNull(businessUnit.archivedAt),visibleLabelIdsCondition(businessUnit,'business_unit',companyIds))).orderBy(asc(businessUnit.name),asc(businessUnit.id));
 const kinds=[['department',departments],['position',positions],['business_unit',units]] as const,assigned=new Map<string,ReadonlySet<string>>();
 for(const [kind,rows] of kinds)for(const row of rows)assigned.set(`${kind}:${row.id}`,new Set(row.companyIds));
 const organisation:NonNullable<InformationOptions['organisation']>=[];
 for(const co of coded)for(const [kind,rows] of kinds)for(const row of rows)if(row.code&&(row.isGlobal||assigned.get(`${kind}:${row.id}`)?.has(co.id)))organisation.push({companyId:co.id,companyCode:co.code,kind,id:row.id,code:row.code,name:row.label?.trim()||row.code});
 const labels=(await tx.select({category:profileOption.category,value:profileOption.value,label:profileOption.label}).from(profileOption).where(and(eq(profileOption.tenantId,ctx.tenantId),eq(profileOption.isActive,true),inArray(profileOption.category,Object.values(LABEL_CATEGORY)))).orderBy(asc(profileOption.category),asc(profileOption.sortOrder),asc(profileOption.value)))
  .flatMap(row=>{const field=(Object.keys(LABEL_CATEGORY) as (keyof typeof LABEL_CATEGORY)[]).find(key=>LABEL_CATEGORY[key]===row.category);return field?[{field,value:row.value,label:row.label}]:[];});
 return {companies:coded,grades,employmentTypes:[...PERSONNEL_EMPLOYMENT_TYPES],organisation,labels} satisfies InformationOptions;
 }));}
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
/** Board 4604dccc — the dated fields as recorded on `day`: the assignment version covering it (or the first one,
 * for a day before the dated history starts) and the administrative line in force. Today is the current record. */
async function valuesAtTx(tx:Tx,ctx:SessionContext,s:Awaited<ReturnType<typeof stateTx>>,day:string):Promise<Partial<InformationValues>>{
 if(day>=todayInKualaLumpur())return {};
 const live=[...s.assignments].filter(v=>v.validTo===null||v.validTo>v.validFrom).sort((a,b)=>a.validFrom.localeCompare(b.validFrom));
 const row=live.filter(v=>v.validFrom<=day&&(v.validTo===null||v.validTo>day)).at(-1)??live[0];
 if(!row)return {};
 const [line]=await tx.select({managerEmploymentId:reportingLine.managerEmploymentId}).from(reportingLine).where(and(eq(reportingLine.tenantId,ctx.tenantId),eq(reportingLine.subordinateEmploymentId,s.emp.id),eq(reportingLine.lineType,'administrative'),isNull(reportingLine.supersededAt),sql`${reportingLine.validFrom}<=${day}::date`,sql`(${reportingLine.validTo} is null or ${reportingLine.validTo}>${day}::date)`)).orderBy(desc(reportingLine.validFrom),asc(reportingLine.id)).limit(1);
 return {companyId:row.companyId??s.emp.companyId,employmentType:row.employmentType,businessUnitId:row.businessUnitId,departmentId:row.departmentId,positionId:row.positionId,managerEmploymentId:line?.managerEmploymentId??null};
}
/** Loading the form may expose invalid legacy values so the user can correct them. A read: the 'maintain' check
 * joins the Access lock shared (withAccessDisplayRead, SCALE rule 1) and no row is locked. */
export function readInformationCorrection(ctx:SessionContext,employmentId:string,effectiveOn?:string){
 return withAccessDisplayRead(()=>withTenant(ctx,async tx=>{
  const state=await stateTx(tx,ctx,employmentId,'read'),today=todayInKualaLumpur(),current=values(state);
  // Board 4604dccc — the form shows the record on the chosen Effective Date (clamped to the Group Join Date..today).
  const chosen=typeof effectiveOn==='string'&&isCalendarDate(effectiveOn)&&effectiveOn<today?(effectiveOn<current.hiredOn!?current.hiredOn!:effectiveOn):today;
  const before={...current,...await valuesAtTx(tx,ctx,state,chosen)},beforeLabels=await labelsTx(tx,before);
  if(chosen!==today)return {effectiveOn:chosen,today,earliestEffectiveOn:current.hiredOn,before,beforeLabels};
  // Board 4604dccc — the Effective Date defaults to today; the earliest is the start of the dated history.
  return {effectiveOn:today,today,earliestEffectiveOn:current.hiredOn,before,beforeLabels};
 }));
}
async function validateTx(tx:Tx,ctx:SessionContext,s:Awaited<ReturnType<typeof stateTx>>,changes:InformationChanges,extended:boolean,at:Partial<InformationValues>={}){
 // Board 4604dccc — the dated fields' existing values are the record on the Effective Date, not today's.
 const before={...values(s),...at},after={...before};
 // The single-employee correction keeps its five facts; the further details are corrected through the template.
 const allowed:readonly InformationField[]=extended?INFORMATION_ALL_FIELDS:INFORMATION_SCREEN_FIELDS;
 if(!extended&&Object.keys(changes).some(field=>(INFORMATION_ALL_FIELDS as readonly string[]).includes(field)&&!(INFORMATION_SCREEN_FIELDS as readonly string[]).includes(field)))fail('Use the Information-Only Correction template to correct these details.');
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
  // Board 4604dccc — the organisation details of every record the dated company correction reaches are checked
  // against the corrected company in previewTx (datedLabelsTx), not only the current record's.
  const duplicate=await tx.select({id:employment.id}).from(employment).where(and(eq(employment.companyId,after.companyId!),eq(employment.employeeCode,s.emp.employeeCode??'')));
  if(duplicate.some(e=>e.id!==s.emp.id))fail('Employee ID is already used in the destination company.');
  if(s.assignments.some(a=>!a.companyId))fail('Historical company information is incomplete. Resolve the dated company history before correcting Company.');
 }
 return {before,after,contractStartDate};
}
/** ccd3a65c — the further details, checked against the resulting company's settings before any write. The
 * owners repeat their own checks when the correction is saved; these give the row error its column. */
async function validateExtendedTx(tx:Tx,ctx:SessionContext,s:Awaited<ReturnType<typeof stateTx>>,before:InformationValues,after:InformationValues,companyAt:string,effectiveOn:string){
 const changed=(field:InformationField)=>after[field]!==before[field];
 for(const field of INFORMATION_ASSIGNMENT_FIELDS){
  if(!changed(field))continue;
  const id=after[field]!,kind=ORGANISATION_KIND[field];
  const [row]=field==='departmentId'?await tx.select({id:department.id}).from(department).where(and(eq(department.id,id),eq(department.tenantId,ctx.tenantId),isNull(department.archivedAt)))
   :field==='positionId'?await tx.select({id:position.id}).from(position).where(and(eq(position.id,id),eq(position.tenantId,ctx.tenantId),isNull(position.archivedAt)))
   :await tx.select({id:businessUnit.id}).from(businessUnit).where(and(eq(businessUnit.id,id),eq(businessUnit.tenantId,ctx.tenantId),isNull(businessUnit.archivedAt)));
  if(!row||!await labelUsableByCompany(tx,ctx.tenantId,kind,id,companyAt))fail(`${caption(field)}: not an active option for this company. Check the reference sheet.`);
 }
 if(changed('businessUnitId')){
  const tags=await deriveCompanyOrganisationTx(tx,ctx,{companyId:companyAt,asOf:effectiveOn});
  if(tags.status!=='legacy')fail('Business Unit: the Group structure sets the Business Unit for this company. Leave this cell blank.');
 }
 for(const field of INFORMATION_LABEL_FIELDS){
  if(!changed(field))continue;
  try{await assertProfileValueAllowed(tx,LABEL_CATEGORY[field],after[field],before[field],companyAt);}
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
  // A Direct Superior may work for any company the user can view (owner decision, 15 Nov 2026), as on the Personnel record.
  if(!manager)fail('Direct Superior: the Employee ID is unknown or not visible to you.');
  if(manager.isTestRecord)fail('Direct Superior: a test record cannot be a Direct Superior.');
  if(manager.terminatedOn||manager.hiredOn>today||['resigned','blacklisted'].includes(deriveEmploymentStatus(manager,today)))fail('Direct Superior: this employee is not an active employee.');
  if(await wouldCreateAdminCycle(tx,s.emp.id,id,effectiveOn))fail('Direct Superior: this would create a reporting loop.');
 }
}
type PreviewInput={employmentId:string;changes:InformationChanges;reason:string;effectiveOn?:string};
const DATED_FIELDS=new Set<string>(DATED_ASSIGNMENT_FIELDS);
const LABEL_FIELD_SET=new Set<string>(INFORMATION_LABEL_FIELDS);
type FullAssignment=Awaited<ReturnType<typeof stateTx>>['assignments'][number];
const liveSpan=(v:{validFrom:string;validTo:string|null})=>v.validTo===null||v.validTo>v.validFrom;
const coversDay=(v:{validFrom:string;validTo:string|null},day:string)=>v.validFrom<=day&&(v.validTo===null||v.validTo>day);
/** Board 4604dccc — a later movement whose recorded Before value this correction contradicts, in the screen's words. */
export function informationConflictMessage(c:InformationConflict){
 return `${caption(c.field)}: the later ${c.label??c.kind} on ${c.date} records a change from a different value. Correct that movement first, or choose an Effective Date after ${c.date}. (Movement Event ID ${c.movementId})`;
}
function closedPayrollMessage(periods:readonly string[]){
 return `Payroll for ${periods.join(', ')} is already closed in the corrected period. Confirm that closed payroll, payslips and statutory submissions stay as issued, then save the correction again.`;
}
/** The dated placement values this correction writes. A company with a Group structure derives its Business Unit. */
async function datedAfterTx(tx:Tx,ctx:SessionContext,changed:readonly InformationField[],after:InformationValues,effectiveOn:string){
 const dated:Partial<Record<DatedAssignmentField,string|null>>={};
 for(const f of changed)if(DATED_FIELDS.has(f))dated[f as DatedAssignmentField]=after[f];
 if(changed.includes('companyId')){const tags=await deriveCompanyOrganisationTx(tx,ctx,{companyId:after.companyId!,asOf:effectiveOn});if(tags.status!=='legacy')dated.businessUnitId=tags.businessUnitId;}
 return dated;
}
/** Every record the dated correction rewrites keeps organisation details its (corrected) company can use. */
async function datedLabelsTx(tx:Tx,ctx:SessionContext,versions:readonly FullAssignment[],plan:DatedCorrectionPlan){
 for(const {index,values} of plan.affected){
  const row=versions[index],company=('companyId' in values?values.companyId:row.companyId)??null;
  if(!company)continue;
  const companyChanged='companyId' in values&&values.companyId!==row.companyId;
  for(const [kind,field] of [['department','departmentId'],['position','positionId'],['business_unit','businessUnitId']] as const){
   const id=field in values?values[field]??null:row[field];
   const fieldChanged=field in values&&values[field]!==row[field];
   if(id&&(companyChanged||fieldChanged)&&!await labelUsableByCompany(tx,ctx.tenantId,kind,id,company))fail(fieldChanged?`${caption(field)}: not an active option for this company. Check the reference sheet.`:'Existing organisation details are not usable by the corrected company. Use Employment Movement.');
  }
  if(companyChanged&&row.costCenterId&&!await labelUsableByCompany(tx,ctx.tenantId,'cost_center',row.costCenterId,company))fail('Existing organisation details are not usable by the corrected company. Use Employment Movement.');
  if(companyChanged&&row.locationId){const [loc]=await tx.execute<{ok:boolean}>(sql`select exists(select 1 from location where id=${row.locationId}::uuid and company_id=${company}::uuid and archived_at is null) as ok`);if(!loc?.ok)fail('The work location on a corrected record belongs to another company. Use Employment Movement.');}
 }
}
/*
 * Board 4604dccc r4 (ADR 2026-11-15 dated information corrections, revision 4) — the LATEST SAVED correction controls
 * each corrected field from its Effective Date onward. An earlier-saved correction no longer ends it or overrides it;
 * a recorded movement (transfer, promotion, confirmation…) still owns its own date for the fields it changes. Earlier
 * corrections stay in the correction history and the audit trail; the review names the ones this correction replaces.
 */
type CorrectionPayload={effectiveOn?:string;fields?:string[];after?:Record<string,unknown>;reportingLine?:{replacementId?:string};boundaries?:{date?:string;fields?:string[]}[]};
export type EarlierCorrection={sequence:number;eventType:string;occurredAt:Date;actorName:string|null;payload:CorrectionPayload};
/** The employee's information corrections and their re-applied boundaries, oldest saved first (one statement). */
async function earlierCorrectionsTx(tx:Tx,ctx:SessionContext,employmentId:string):Promise<EarlierCorrection[]>{
 const rows=await tx.select({sequence:domainEvent.sequence,eventType:domainEvent.eventType,occurredAt:domainEvent.occurredAt,actorName:correctionActor.fullName,payload:domainEvent.payload}).from(domainEvent)
  .leftJoin(correctionAccount,and(eq(correctionAccount.id,domainEvent.actorId),eq(correctionAccount.tenantId,ctx.tenantId))).leftJoin(correctionActor,and(eq(correctionActor.id,correctionAccount.personId),eq(correctionActor.tenantId,ctx.tenantId)))
  .where(and(eq(domainEvent.tenantId,ctx.tenantId),eq(domainEvent.subjectEmploymentId,employmentId),inArray(domainEvent.eventType,[INFORMATION_CORRECTED_EVENT,INFORMATION_BOUNDARY_REAPPLIED_EVENT]))).orderBy(asc(domainEvent.sequence));
 return rows.map(r=>({...r,payload:(r.payload??{}) as CorrectionPayload}));
}
/** Pure: per dated field this correction sets, the later boundary dates an earlier-saved correction created that no
 * recorded movement owns for that field. The correction is carried through them (planDatedCorrection). A Company
 * correction's boundary also carries its derived Business Unit. Any other writer's boundary still stops it. */
export function correctionCarry(corrections:readonly Pick<EarlierCorrection,'eventType'|'payload'>[],recorded:readonly Pick<RecordedMovementChange,'effectiveDate'|'fields'>[],fields:readonly DatedAssignmentField[],effectiveOn:string):CorrectionCarry{
 const set=new Map<string,Set<string>>();
 const add=(date:unknown,changed:unknown)=>{
  if(typeof date!=='string'||date<=effectiveOn||!Array.isArray(changed))return;
  const own=set.get(date)??new Set<string>();for(const f of changed)if(typeof f==='string'){own.add(f);if(f==='companyId')own.add('businessUnitId');}set.set(date,own);
 };
 for(const c of corrections){
  if(c.eventType===INFORMATION_CORRECTED_EVENT)add(c.payload.effectiveOn,c.payload.fields);
  else for(const b of Array.isArray(c.payload.boundaries)?c.payload.boundaries:[])add(b?.date,b?.fields);
 }
 const carry:CorrectionCarry={};
 for(const f of fields){
  const dates=[...set].filter(([date,own])=>own.has(f)&&!recorded.some(r=>r.effectiveDate===date&&r.fields.includes(f))).map(([date])=>date).sort();
  if(dates.length)carry[f]=dates;
 }
 return carry;
}
/** Pure: whether a Direct Superior line was written by an earlier information correction (bounded: the line it
 * recorded; open-ended: the line from its Effective Date to the superior it set). */
export function superiorCorrectionLines(corrections:readonly Pick<EarlierCorrection,'eventType'|'payload'>[]){
 const own=corrections.filter(c=>c.eventType===INFORMATION_CORRECTED_EVENT&&Array.isArray(c.payload.fields)&&c.payload.fields.includes('managerEmploymentId'));
 return (line:{id:string;validFrom:string;managerEmploymentId:string})=>own.some(c=>c.payload.reportingLine?.replacementId===line.id||(c.payload.effectiveOn===line.validFrom&&c.payload.after?.managerEmploymentId===line.managerEmploymentId));
}
/** Pure: the earlier corrections whose period this one now covers for a field it changes: dated on or after this
 * Effective Date and before the field's next recorded movement (`until`). Informational, never a refusal. */
export function replacedCorrectionsOf(corrections:readonly EarlierCorrection[],changed:readonly InformationField[],effectiveOn:string,until:Partial<Record<InformationField,string>>):InformationReplacedCorrection[]{
 return corrections.flatMap(c=>{
  const on=c.payload.effectiveOn;
  if(c.eventType!==INFORMATION_CORRECTED_EVENT||typeof on!=='string'||on<effectiveOn)return [];
  const fields=changed.filter(f=>(c.payload.fields??[]).includes(f)&&(until[f]===undefined||on<until[f]!));
  return fields.length?[{sequence:c.sequence,effectiveOn:on,savedAt:c.occurredAt.toISOString(),fields,actor:c.actorName??null}]:[];
 });
}
type DatedApply={labelsNotCurrent:string[];superiorUntil:string|null;superiorReplaced:string[];carry:CorrectionCarry};
async function previewTx(tx:Tx,ctx:SessionContext,input:PreviewInput,extended=false,mode:StateMode='write'){
 const reason=typeof input.reason==='string'?input.reason.trim():'';
 if(reason.length<3||reason.length>1000)fail('Provide a correction reason between 3 and 1,000 characters.');
 const write=mode==='write';
 const state=await stateTx(tx,ctx,input.employmentId,mode);
 // Board 4604dccc — the Effective Date: from the start of the dated history (the Group Join Date) up to today.
 const today=todayInKualaLumpur();
 const effectiveOn=typeof input.effectiveOn==='string'&&input.effectiveOn.trim()?input.effectiveOn.trim():today;
 if(!isCalendarDate(effectiveOn))fail('Effective Date: use a valid date in YYYY-MM-DD format.');
 if(effectiveOn>today)fail('Effective Date cannot be in the future.');
 const v=await validateTx(tx,ctx,state,input.changes,extended,await valuesAtTx(tx,ctx,state,effectiveOn));
 const earliest=v.after.hiredOn!;
 if(effectiveOn<earliest)fail(`Effective Date cannot be before ${earliest}, the Group Join Date, when the employee's history starts. If the employee joined earlier, correct the Group Join Date in this same correction.`);
 const backdated=effectiveOn<today;
 // Board 4604dccc r3 — payroll history no longer blocks a correction: app.preserve_information_payroll (migration 5690)
 // fixes each existing payslip's details from the recorded history before the write, and closed payroll is never changed.
 const companyRows=tx.select({id:company.id,label:company.companyLabel,registration:company.registrationNo,name:company.legalName,country:company.country,currency:company.currency,archivedAt:company.archivedAt}).from(company).where(inArray(company.id,[v.before.companyId!,v.after.companyId!])).orderBy(asc(company.id));
 const companyRefs=write?await companyRows.for('share'):await companyRows;
 const gradeIds=[...new Set([v.before.gradeId,v.after.gradeId].filter((id):id is string=>!!id))];
 const gradeRows=tx.select({id:jobGrade.id,code:jobGrade.code,name:jobGrade.name,archivedAt:jobGrade.archivedAt}).from(jobGrade).where(inArray(jobGrade.id,gradeIds)).orderBy(asc(jobGrade.id));
 const gradeRefs=gradeIds.length?(write?await gradeRows.for('share'):await gradeRows):[];
 const organisation=await deriveCompanyOrganisationTx(tx,ctx,{companyId:v.after.companyId!,asOf:effectiveOn});
 const beforeLabels=await labelsTx(tx,v.before),afterLabels=await labelsTx(tx,v.after);
 const changed=INFORMATION_ALL_FIELDS.filter(f=>v.before[f]!==v.after[f]);
 const live=[...state.assignments].sort((a,b)=>a.validFrom.localeCompare(b.validFrom));
 const warnings:InformationWarning[]=[];
 // Board 154511c4 — the dated records start on the Group Join Date; saving aligns them when they do not.
 const alignStart=live[0]&&v.after.hiredOn&&live[0].validFrom!==v.after.hiredOn?{from:live[0].validFrom,to:v.after.hiredOn}:undefined;
 // Board 4604dccc — the dated records as they stand after that alignment, and what this correction writes over them.
 const versions=live.filter(liveSpan).map((row,i)=>i===0&&alignStart?{...row,validFrom:alignStart.to}:row);
 const datedAfter=await datedAfterTx(tx,ctx,changed,v.after,effectiveOn);
 // Later recorded changes: the movements whose recorded "from" values must agree. Board 4604dccc r4 — and every
 // earlier correction, which the latest saved correction (this one) replaces from its Effective Date onward.
 const recorded:RecordedMovementChange[]=backdated?await recordedMovementChangesTx(tx,ctx.tenantId,state.emp.id):[];
 const corrections=await earlierCorrectionsTx(tx,ctx,state.emp.id);
 const carry:CorrectionCarry=backdated?correctionCarry(corrections,recorded,Object.keys(datedAfter) as DatedAssignmentField[],effectiveOn):{};
 let plan:DatedCorrectionPlan;
 try{plan=planDatedCorrection(versions,effectiveOn,datedAfter,carry);}
 catch(error){if(error instanceof MovementHistoryError)fail(`The employee's dated records do not cover ${effectiveOn}. Review Employment Movement.`);throw error;}
 const companyAt=(datedAfter.companyId??versions[plan.cover].companyId??state.emp.companyId)!;
 if(extended)await validateExtendedTx(tx,ctx,state,v.before,v.after,companyAt,effectiveOn);
 // HR administration of every company whose records this correction rewrites, not only today's.
 for(const id of new Set(plan.affected.filter(x=>Object.keys(x.values).length).flatMap(x=>[versions[x.index].companyId,x.values.companyId]).filter((id):id is string=>!!id)))await administratorTx(tx,ctx,id);
 await datedLabelsTx(tx,ctx,versions,plan);
 const correctionDates=corrections.filter(c=>c.eventType===INFORMATION_CORRECTED_EVENT).map(c=>c.payload).filter(p=>typeof p.effectiveOn==='string');
 const conflicts:InformationConflict[]=[];
 const until:Partial<Record<InformationField,string>>={};
 for(const f of Object.keys(datedAfter) as DatedAssignmentField[]){
  const stop=plan.stops[f]!,to=plan.ranges[f]?.to;
  if(to)until[f]=to;
  if(stop>=versions.length)continue;
  const at=versions[stop].validFrom,movement=recorded.find(r=>r.effectiveDate===at&&r.fields.includes(f));
  if(!movement)continue;
  const from=f in movement.before?movement.before[f]??null:versions[stop-1][f];
  if(from!==datedAfter[f])conflicts.push({movementId:movement.id,date:at,field:f,kind:movement.kind,label:movement.label});
 }
 // Labels (flat columns) and the Direct Superior: a later recorded movement owns the current value from its date.
 // Board 4604dccc r4 — an earlier-saved correction no longer ends this one: the newest correction's value is current
 // unless a later recorded movement changes the field.
 const labelsNotCurrent:string[]=[];
 if(backdated)for(const f of changed.filter(field=>LABEL_FIELD_SET.has(field))){
  const movement=recorded.filter(r=>r.effectiveDate>effectiveOn&&r.fields.includes(f)).sort((a,b)=>a.effectiveDate.localeCompare(b.effectiveDate))[0];
  if(!movement)continue;
  labelsNotCurrent.push(f);until[f]=movement.effectiveDate;
  if((f in movement.before?movement.before[f]??null:v.before[f])!==v.after[f])conflicts.push({movementId:movement.id,date:movement.effectiveDate,field:f,kind:movement.kind,label:movement.label});
 }
 let superiorUntil:string|null=null;const superiorReplaced:string[]=[];
 if(backdated&&changed.includes('managerEmploymentId')){
  const lines=(await tx.select({id:reportingLine.id,validFrom:reportingLine.validFrom,validTo:reportingLine.validTo,managerEmploymentId:reportingLine.managerEmploymentId}).from(reportingLine).where(and(eq(reportingLine.tenantId,ctx.tenantId),eq(reportingLine.subordinateEmploymentId,state.emp.id),eq(reportingLine.lineType,'administrative'),isNull(reportingLine.supersededAt))).orderBy(asc(reportingLine.validFrom))).filter(liveSpan);
  // Board 4604dccc r4 — a later line an earlier correction wrote is replaced; the next other line still ends this one.
  const correctionLine=superiorCorrectionLines(corrections);
  const later=lines.filter(l=>l.validFrom>effectiveOn);
  const next=later.find(l=>!correctionLine(l));
  superiorReplaced.push(...later.filter(l=>correctionLine(l)&&(!next||l.validFrom<next.validFrom)).map(l=>l.id));
  if(next){
   superiorUntil=next.validFrom;until.managerEmploymentId=next.validFrom;
   const movement=recorded.find(r=>r.effectiveDate===next.validFrom&&r.fields.includes('managerEmploymentId'));
   const previous=lines.filter(l=>coversDay(l,effectiveOn)).at(-1)?.managerEmploymentId??null;
   if(movement&&previous!==v.after.managerEmploymentId)conflicts.push({movementId:movement.id,date:next.validFrom,field:'managerEmploymentId',kind:movement.kind,label:movement.label});
  }
 }
 // Closed payroll in the corrected period: acknowledged, never recalculated (the movement acknowledgement pattern);
 // a month closed under another company contradicts the corrected company (movement_history_payroll_company).
 const datedChange=Object.keys(datedAfter).length>0||changed.some(f=>LABEL_FIELD_SET.has(f)||f==='managerEmploymentId');
 let closedPayrollPeriods:string[]=[];
 if(backdated&&datedChange){
  const ends=[...Object.values(plan.ranges).map(r=>r?.to??null),...changed.filter(f=>LABEL_FIELD_SET.has(f)||f==='managerEmploymentId').map(f=>until[f]??null)];
  const end=ends.some(e=>e===null)?null:ends.filter((e):e is string=>!!e).sort().at(-1)??null;
  closedPayrollPeriods=(await closedPeriodsTx(tx,state.emp.id)).filter(period=>overlapsClosedPeriod([period],effectiveOn,end)).sort();
  if(datedAfter.companyId){
   const contradicted=[...new Set((await closedPayrollInSpanTx(tx,state.emp.id,effectiveOn,plan.ranges.companyId?.to??'9999-12-31')).filter(r=>r.companyId!==null&&r.companyId!==datedAfter.companyId).map(r=>r.period))];
   if(contradicted.length)fail(`Payroll for ${contradicted.join(', ')} was closed under a different company. Closed payroll stays as issued, so the company cannot be corrected for that period. Choose a later Effective Date, or correct that payroll through payroll reprocessing first.`);
  }
 }
 if(changed.includes('companyId'))warnings.push({code:'companyFrom',date:effectiveOn,...(plan.ranges.companyId?.to?{to:plan.ranges.companyId.to}:{})});
 if(alignStart)warnings.push({code:'historyStartAligned',date:alignStart.to,from:alignStart.from});
 // Board 2026-11-16 — a salary record a closed payroll was paid under keeps its own start; nothing recalculates.
 const salaryKept=alignStart?await salaryStartKeptTx(tx,state.emp.id,alignStart.to):null;
 if(salaryKept)warnings.push({code:'salaryStartKept',date:salaryKept.validFrom});
 // The review's records, in Effective Date order, flagged by what this correction does to each.
 const timeline:InformationTimelineRecord[]=[];
 if(backdated){
  const correctionDays=new Set(correctionDates.filter(p=>(p.fields??[]).some(f=>DATED_FIELDS.has(f))).map(p=>p.effectiveOn!));
  const affected=new Map(plan.affected.map(a=>[a.index,a.values]));
  const ids=[...new Set(versions.flatMap((row,i)=>[row.companyId,affected.get(i)?.companyId]).filter((id):id is string=>!!id))];
  const names=new Map((ids.length?await tx.select({id:company.id,name:company.legalName}).from(company).where(inArray(company.id,ids)):[]).map(r=>[r.id,r.name]));
  const anything=datedChange;
  versions.forEach((row,i)=>{
   const movement=recorded.find(r=>r.effectiveDate===row.validFrom&&r.kind!=='hired');
   const values=affected.get(i),split=i===plan.cover&&row.validFrom<effectiveOn;
   const kind=i===0?'hired':movement?movement.kind:correctionDays.has(row.validFrom)?'informationCorrection':'record';
   const status=conflicts.some(c=>c.date===row.validFrom)?'conflict':anything&&values&&!split&&(Object.keys(values).length||i===plan.cover)?'corrected':'unchanged';
   timeline.push({date:row.validFrom,kind,label:i===0?null:movement?.label??null,company:names.get((split?row.companyId:(values?.companyId??row.companyId))??'')??null,status});
   if(split&&anything)timeline.push({date:effectiveOn,kind:'thisCorrection',label:null,company:names.get((values?.companyId??row.companyId)??'')??null,status:'corrected'});
  });
  // A later label or Direct Superior change that conflicts has no dated record of its own.
  for(const c of conflicts)if(!timeline.some(r=>r.date===c.date))timeline.push({date:c.date,kind:c.kind,label:c.label,company:null,status:'conflict'});
  timeline.sort((a,b)=>a.date.localeCompare(b.date));
 }
 if(extended&&conflicts.length)fail(informationConflictMessage(conflicts[0]));
 // Five-fact corrections keep their original fingerprint; the further details also bind the displayed labels.
 const extendedChange=changed.some(f=>!(INFORMATION_FIELDS as readonly string[]).includes(f));
 const fingerprint=hash({state:state.fingerprint,companies:companyRefs,grades:gradeRefs,effectiveOn,...(organisation.status==='legacy'?{}:{organisation}),...(extendedChange?{labels:[beforeLabels,afterLabels]}:{}),...(alignStart?{alignStart}:{})});
 const fromJoinDate=Object.keys(datedAfter).length>0&&effectiveOn===versions[0]?.validFrom;
 const replacedCorrections=replacedCorrectionsOf(corrections,changed,effectiveOn,until);
 const preview:InformationPreview={effectiveOn,employmentId:state.emp.id,employeeCode:state.emp.employeeCode??'',name:state.name,fingerprint,before:v.before,after:v.after,beforeLabels,afterLabels,reason,changed,earliestEffectiveOn:earliest,
  ...(fromJoinDate?{fromJoinDate:true as const}:{}),...(warnings.length?{warnings}:{}),...(alignStart?{alignStart}:{}),...(timeline.length?{timeline}:{}),...(conflicts.length?{conflicts}:{}),...(closedPayrollPeriods.length?{closedPayrollPeriods}:{}),...(Object.keys(until).length?{until}:{}),...(replacedCorrections.length?{replacedCorrections}:{})};
 return {state,preview,dated:{labelsNotCurrent,superiorUntil,superiorReplaced,carry}};
}
class InformationRehearsal extends Error{constructor(readonly preview:InformationPreview){super('information_preview_rollback');}}
/** Excel previews of the further details rehearse the owners' writes and roll back, so every refusal the save
 * would meet (closed payroll, reporting loop, catalog) is shown as a row error before confirmation. Every other
 * review is a read: shared Access lock and no row locks (withAccessDisplayRead, SCALE rule 1). */
export async function previewInformationCorrection(ctx:SessionContext,input:PreviewInput,options:{extended?:boolean}={}){
 if(!options.extended||!informationChangesUseOwners(input.changes))return withAccessDisplayRead(()=>withTenant(ctx,async tx=>(await previewTx(tx,ctx,input,!!options.extended,'read')).preview));
 try{await withTenant(ctx,async tx=>{
  await tx.execute(sql`select app.access_workforce_write_lock()`);await lockLeaveDependencyConfigurationTx(tx,ctx.tenantId);
  const {state,preview,dated}=await previewTx(tx,ctx,input,true);
  if(preview.changed.length)await applyTx(tx,ctx,state,preview,dated,{method:'excel'});
  throw new InformationRehearsal(preview);
 });}catch(error){if(error instanceof InformationRehearsal)return error.preview;throw error;}
 fail('The correction review could not be completed.');
}
/** No recalculation or operational workflow is called from this command. Caller may add import audit in this transaction.
 * Board 4604dccc — `effectiveOn` (default today) dates the correction; `acknowledgeClosedPayroll` confirms that closed
 * payroll in the corrected period stays as issued. */
export async function correctInformationTx(tx:Tx,ctx:SessionContext,input:{employmentId:string;changes:InformationChanges;reason:string;fingerprint:string;method:'manual'|'excel';batchId?:string;filename?:string;effectiveOn?:string;acknowledgeClosedPayroll?:boolean}){
 const extended=input.method==='excel';
 // Owner configuration locks first (the Movement import order), then the employee's own locks in stateTx.
 if(extended&&informationChangesUseOwners(input.changes)){await tx.execute(sql`select app.access_workforce_write_lock()`);await lockLeaveDependencyConfigurationTx(tx,ctx.tenantId);}
 const {state:s,preview:p,dated}=await previewTx(tx,ctx,input,extended);
 if(input.fingerprint!==p.fingerprint)fail('The employee changed after your review. Review the correction again.');
 if(p.conflicts?.length)fail(informationConflictMessage(p.conflicts[0]));
 if(!p.changed.length&&!p.alignStart)return {preview:p,changed:false};
 if(p.closedPayrollPeriods?.length&&input.acknowledgeClosedPayroll!==true)fail(closedPayrollMessage(p.closedPayrollPeriods));
 await applyTx(tx,ctx,s,p,dated,input);
 return {preview:p,changed:true};
}
async function applyTx(tx:Tx,ctx:SessionContext,s:Awaited<ReturnType<typeof stateTx>>,p:InformationPreview,dated:DatedApply,input:{method:'manual'|'excel';batchId?:string;filename?:string}){
 // The preimage protects every existing persisted output before any master information changes.
 let preserved:{count:number}|undefined;
 try{[preserved]=await tx.execute<{count:number}>(sql`select app.preserve_information_payroll(${s.emp.id}::uuid) as count`);}
 catch(error){const refusal=payrollPreservationRefusal(error);if(refusal)fail(refusal);throw error;}
 if(!preserved)fail('Historical payroll metadata could not be protected.');
 const effectiveOn=p.effectiveOn;
 // Board 154511c4 — the dated records start on the (corrected) Group Join Date. Aligned first (board 4604dccc), so
 // a correction from the Group Join Date starts on the aligned record.
 let aligned:Awaited<ReturnType<typeof alignHistoryStartTx>>|null=null;
 if(p.alignStart){
  try{aligned=await alignHistoryStartTx(tx,s.emp.id,p.alignStart.to);}
  catch(error){if(error instanceof MovementHistoryError)fail(alignMessage(error.message));throw error;}
 }
 // Board 4604dccc — the placement fields from the Effective Date until each field's next recorded change.
 const datedAfter=await datedAfterTx(tx,ctx,p.changed,p.after,effectiveOn);
 let datedWrite:Awaited<ReturnType<typeof writeDatedCorrectionTx>>|null=null;
 if(Object.keys(datedAfter).length){
  try{datedWrite=await writeDatedCorrectionTx(tx,s.emp.id,effectiveOn,datedAfter,dated.carry);}
  catch(error){if(error instanceof MovementHistoryError)fail(`The employee's dated records do not cover ${effectiveOn}. Review Employment Movement.`);throw error;}
 }
 const assignmentVersionId=datedWrite?(datedWrite.inserted[0]??datedWrite.replaced[0]?.replacementId??null):null;
 // employment.company_id is today's company: it changes only when the corrected period reaches the current record.
 const companyReachesCurrent=!!datedWrite&&datedWrite.plan.ranges.companyId!==undefined&&datedWrite.plan.ranges.companyId.to===null;
 const currentCompany=companyReachesCurrent?p.after.companyId!:s.emp.companyId;
 // 2260a06b — the type end dates live on employment. A change to Contract with no stored contract start starts it
 // on the join date (as hireEmployee does). provisional_end_on follows the internship date only while it is still
 // that date's copy (setEmploymentInfo applies the same rule), so the review and status fallbacks agree.
 const contractStartDate=p.after.employmentType==='contract'&&(p.changed.includes('employmentType')||p.changed.includes('contractEndDate'))?(s.emp.contractStartDate??p.after.joinDate??p.after.hiredOn):s.emp.contractStartDate;
 const internshipProvisional=p.changed.includes('internshipEndDate')&&p.after.internshipEndDate&&s.emp.provisionalEndOn!=null&&s.emp.provisionalEndOn===s.emp.internshipEndDate?{provisionalEndOn:p.after.internshipEndDate}:{};
 await tx.update(employment).set({companyId:currentCompany,hiredOn:p.after.hiredOn!,joinDate:p.after.joinDate,gradeId:p.after.gradeId,contractStartDate,contractEndDate:p.after.contractEndDate,internshipEndDate:p.after.internshipEndDate,...internshipProvisional}).where(eq(employment.id,s.emp.id));
 // ccd3a65c — labels, periods and Confirmation Date through their owner, untagged: no movement row is
 // projected, the catalog, date-order and closed-payroll checks apply, and employment.info.updated records it.
 // Board 4604dccc — a label a later recorded change owns today keeps its current value; the event dates the correction.
 const info=p.changed.filter(field=>((INFORMATION_LABEL_FIELDS as readonly string[]).includes(field)&&!dated.labelsNotCurrent.includes(field))||(INFORMATION_PERIOD_FIELDS as readonly string[]).includes(field));
 if(info.length){
  const patch:Record<string,string|number|null>={};for(const field of info)patch[field]=field.endsWith('Value')&&p.after[field]!==null?Number(p.after[field]):p.after[field];
  try{await writeEmploymentInfo(ctx,{employmentId:s.emp.id,...patch} as unknown as Parameters<typeof writeEmploymentInfo>[1],tx);}
  catch(error){ownerFailure(error,info.includes('confirmationDate')&&/onfirm|payroll/.test(String((error as Error)?.message))?'confirmationDate':info[0]);}
 }
 // The Direct Superior through the dated reporting-line owner from the Effective Date, untagged (no movement row).
 // Board 4604dccc — up to the next recorded line when one follows. Revision 4: over the later lines earlier
 // corrections wrote, which it replaces (superseded, never deleted).
 let superiorLine:Awaited<ReturnType<typeof boundedSuperiorTx>>|null=null;
 if(p.changed.includes('managerEmploymentId')){
  if(dated.superiorUntil||dated.superiorReplaced.length)superiorLine=await boundedSuperiorTx(tx,ctx,s.emp.id,p.after.managerEmploymentId!,effectiveOn,dated.superiorUntil,dated.superiorReplaced);
  else{
   try{await writeReportingLine(ctx,{subordinateEmploymentId:s.emp.id,managerEmploymentId:p.after.managerEmploymentId!,lineType:'administrative',validFrom:effectiveOn},tx);}
   catch(error){ownerFailure(error,'managerEmploymentId');}
  }
 }
 const replaced=[...datedWrite?.replaced??[],...aligned?.replaced??[]];
 const nextBoundary=Object.values(p.until??{}).length?Object.values(p.until!).sort()[0]:null;
 await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'employment',aggregateId:s.emp.id,eventType:INFORMATION_CORRECTED_EVENT,actor:actorOf(ctx),subjectEmploymentId:s.emp.id,payload:{
  ...(p.fromJoinDate&&p.changed.includes('companyId')?{fromJoinDate:true,spanFrom:effectiveOn}:{}),
  ...(effectiveOn<todayInKualaLumpur()?{dated:true}:{}),
  ...(replaced.length?{assignment:replaced}:{}),...(datedWrite?.inserted.length?{inserted:datedWrite.inserted}:{}),
  ...(aligned?{alignedStart:p.alignStart,aligned:aligned.aligned,...(aligned.salaryKept?{salaryKept:aligned.salaryKept}:{})}:{}),...(superiorLine?{reportingLine:superiorLine}:{}),
  employeeCode:p.employeeCode,employeeName:p.name,before:p.before,after:p.after,beforeLabels:p.beforeLabels,afterLabels:p.afterLabels,fields:p.changed,reason:p.reason,effectiveOn,nextBoundary,...(p.until?{until:p.until}:{}),
  ...(dated.labelsNotCurrent.length?{labelsNotCurrent:dated.labelsNotCurrent}:{}),...(p.closedPayrollPeriods?.length?{closedPayrollPeriods:p.closedPayrollPeriods,closedPayrollAcknowledged:true}:{}),
  ...(p.replacedCorrections?.length?{replacedCorrectionSequences:p.replacedCorrections.map(c=>c.sequence)}:{}),
  method:input.method,batchId:input.batchId??null,filename:input.filename??null,snapshotCount:preserved.count,assignmentVersionId,previousAssignmentId:s.current.id}});
 const [at]=await tx.select({companyId:assignment.companyId}).from(assignment).where(and(eq(assignment.employmentId,s.emp.id),isNull(assignment.supersededAt),sql`${assignment.validFrom}<=${effectiveOn}::date`,sql`(${assignment.validTo} is null or ${assignment.validTo}>${effectiveOn}::date)`)).orderBy(desc(assignment.validFrom)).limit(1);
 // The organisation tag owner checks the company against app.company_org_employment_company, which prefers a
 // correction's before-image to the dated record (ADR 2026-11-15, Consequences; bounded by 5696): record only where they agree.
 const tagCompany=at?.companyId??currentCompany;
 if(await companyRecordOnTx(tx,ctx.tenantId,s.emp.id,effectiveOn)===tagCompany)await recordEmploymentOrganisationTagsTx(tx,ctx,{employmentId:s.emp.id,companyId:tagCompany,asOf:effectiveOn,trigger:'correction'});
}
/** Board 4604dccc — the Direct Superior from the Effective Date until the next recorded line, which stays as it is.
 * Revision 4 — the later lines earlier corrections wrote (`replaced`) are superseded and this line runs over them,
 * to `to` (null: open-ended, when no other line follows). */
async function boundedSuperiorTx(tx:Tx,ctx:SessionContext,employmentId:string,managerId:string,from:string,to:string|null,replaced:readonly string[]=[]){
 if(await wouldCreateAdminCycle(tx,employmentId,managerId,from,to))fail('Direct Superior: this would create a reporting loop.');
 const all=(await tx.select().from(reportingLine).where(and(eq(reportingLine.tenantId,ctx.tenantId),eq(reportingLine.subordinateEmploymentId,employmentId),eq(reportingLine.lineType,'administrative'),isNull(reportingLine.supersededAt))).orderBy(asc(reportingLine.validFrom)).for('update')).filter(liveSpan);
 const replacedIds=new Set(replaced),removed=all.filter(l=>replacedIds.has(l.id)),lines=all.filter(l=>!replacedIds.has(l.id));
 if(removed.length!==replacedIds.size)fail('The employee changed after your review. Review the correction again.');
 if(removed.length)await tx.update(reportingLine).set({supersededAt:new Date()}).where(inArray(reportingLine.id,removed.map(l=>l.id)));
 const covering=lines.filter(l=>coversDay(l,from)).at(-1);
 let supersededId:string|null=null;
 if(covering){
  if(covering.validFrom===from){await tx.update(reportingLine).set({supersededAt:new Date()}).where(eq(reportingLine.id,covering.id));supersededId=covering.id;}
  else await tx.update(reportingLine).set({validTo:from}).where(eq(reportingLine.id,covering.id));
 }
 // The covering line's end, carried on through the replaced lines that followed it; a real gap still ends the line.
 let reach:string|null=covering?covering.validTo:to;
 for(const l of removed)if(reach!==null&&l.validFrom===reach)reach=l.validTo;
 const end=reach===null?to:to===null?reach:reach<to?reach:to;
 const [row]=await tx.insert(reportingLine).values({tenantId:ctx.tenantId,subordinateEmploymentId:employmentId,managerEmploymentId:managerId,lineType:'administrative',validFrom:from,validTo:end}).returning({id:reportingLine.id});
 return{supersededId,replacementId:row.id,validFrom:from,validTo:end,...(removed.length?{replacedLineIds:removed.map(l=>l.id)}:{})};
}
export function correctInformation(ctx:SessionContext,input:Parameters<typeof correctInformationTx>[2]){return withTenant(ctx,tx=>correctInformationTx(tx,ctx,input));}
export function amendDirectSuperior(ctx: SessionContext, input: {
  employmentId: string; managerEmploymentId: string | null; expectedLineId: string | null; reason: string;
}) {
  const reason = input.reason.trim();
  if (!reason || reason.length > 200) fail('Enter a correction reason of up to 200 characters.');
  return withTenant(ctx, async tx => {
    await lockAccessConfigurationTx(tx, ctx.tenantId);
    const [subject] = await tx.select({ companyId: employment.companyId }).from(employment)
      .where(and(eq(employment.id, input.employmentId), eq(employment.tenantId, ctx.tenantId))).limit(1);
    if (!subject) fail('Employee record is unavailable.');
    await administratorTx(tx, ctx, subject.companyId);
    const corrected = await writeDirectSuperiorTx(tx, ctx, input);

    await appendEvent(tx, {
      tenantId: ctx.tenantId, actor: actorOf(ctx), subjectEmploymentId: input.employmentId,
      aggregateType: 'employment', aggregateId: input.employmentId, eventType: INFORMATION_CORRECTED_EVENT,
      payload: {
        source: 'direct-superior', method: 'manual', reason, effectiveOn: corrected.from, dated: true,
        fields: ['managerEmploymentId'], before: { managerEmploymentId: corrected.previousManagerEmploymentId },
        after: { managerEmploymentId: input.managerEmploymentId },
        nextBoundary: corrected.until, until: { managerEmploymentId: corrected.until },
        reportingLine: { supersededId: corrected.supersededId, replacementId: corrected.replacementId,
          validFrom: corrected.from, validTo: corrected.until },
      },
    });
  });
}

export function informationCorrectionHistory(ctx: SessionContext, employmentId: string) {
  return withAccessDisplayRead(() => withTenant(ctx, async tx => {
    await assertWorkforceEmploymentTx(tx, ctx, employmentId, 'view');
    const [allowed] = await tx.execute<{ ok: boolean }>(sql`
      select exists(
        select 1 from employment
        where id=${employmentId}::uuid and tenant_id=${ctx.tenantId}::uuid
          and app.principal_snapshot_current() and app.is_admin_for(company_id)
      ) as ok
    `);
    if (!allowed?.ok) fail('You do not have permission to review this correction history.');
    const history = await tx.select({
      id: domainEvent.id,
      at: domainEvent.occurredAt,
      actorId: domainEvent.actorId,
      actorName: correctionActor.fullName,
      payload: domainEvent.payload,
      alignedDate: alignedInformationDateSql(),
    }).from(domainEvent)
      .leftJoin(correctionAccount, and(eq(correctionAccount.id, domainEvent.actorId), eq(correctionAccount.tenantId, ctx.tenantId)))
      .leftJoin(correctionActor, and(eq(correctionActor.id, correctionAccount.personId), eq(correctionActor.tenantId, ctx.tenantId)))
      .where(and(eq(domainEvent.tenantId, ctx.tenantId), eq(domainEvent.subjectEmploymentId, employmentId),
        eq(domainEvent.eventType, INFORMATION_CORRECTED_EVENT)))
      .orderBy(desc(domainEvent.sequence)).limit(100);
    return correctionAuditLabelsTx(tx, ctx.tenantId, history.map(({ alignedDate, ...row }) => ({
      ...row, payload: withAlignedInformationDate(row.payload, alignedDate),
    })));
  }));
}
