import {contractPeriodIssues} from '../lib/contract-period';
import {MOVEMENT_EMPLOYMENT_PERIOD_FIELDS,MOVEMENT_EMPLOYMENT_PERIODS} from '../lib/movement-employment-periods';
import {MOVEMENT_FLAT_FIELDS} from '../lib/movement-pending-input';
import {movementInformationEvidence} from '../lib/movement-information-evidence';
import {withExitDateAuthorityTx} from './exit-date-authority';
import {randomUUID} from 'node:crypto';
import {and,eq,inArray,isNull,sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import {assignment,company,employment,jobGrade} from '../db/schema';
import {appendEvent,actorOf} from '../db/events';
import {setEmploymentInfo,assertEmploymentInformationLabelsTx} from './org';
import {assertEmploymentInformationDateOrder} from '../lib/employment-information-date-order';
import {hasClosedPayrollCorrectionAuthorityTx} from './closed-payroll-correction-authority';
import {assertWorkforceEmploymentTx} from './workforce-access';
import {markWorkforcePayrollInputsChangedTx} from './workforce-payroll-invalidation';
import {todayInKualaLumpur} from '../lib/hr-date';
import {alignHistoryToGroupJoinDateTx} from './movement-history';
import {isCalendarDate} from '../lib/calendar-date';

export const HIRE_SCALAR_INFORMATION_FIELDS=[...MOVEMENT_FLAT_FIELDS,...MOVEMENT_EMPLOYMENT_PERIOD_FIELDS,'confirmationDate','extendedConfirmationDate','contractStartDate','tenderResignationDate','resignationDate','lastWorkingDate'] as const;
export const HIRE_EMPLOYMENT_INFORMATION_FIELDS=['companyId','hiredOn','joinDate','gradeId','employmentType',...HIRE_SCALAR_INFORMATION_FIELDS] as const;
const COMPANY_LABELS=[
 {field:'orgDivision',column:'org_division',category:'division'}, {field:'orgRegion',column:'org_region',category:'region'},
 {field:'orgBranch',column:'org_branch',category:'branch'}, {field:'orgTeam',column:'org_team',category:'team'},
 {field:'orgSection',column:'org_section',category:'section'}, {field:'orgLine',column:'org_line',category:'line'},
 {field:'orgBase',column:'org_base',category:'base'}, {field:'employmentCategory',column:'employment_category',category:'category'},
] as const;
export type HireEmploymentInformationField=typeof HIRE_EMPLOYMENT_INFORMATION_FIELDS[number];
export type HireEmploymentInformation=Partial<Record<HireEmploymentInformationField,string|null>>;
type Event={id:string;eventType:string;payload:unknown;occurredAt:Date;sequence:number};
type Version={row:typeof assignment.$inferSelect;origin:{eventType:string;payload:unknown}|null;companyId:string};
type Plan={anchor:string;chain:Version[];events:Event[]};
const object=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const tag=(event:Event)=>object(object(event.payload).movement);
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function inheritedLength(plan:Plan,field:'companyId'|'employmentType'){
 let count=1;
 while(count<plan.chain.length){
  const version=plan.chain[count],previous=plan.chain[count-1],payload=object(version.origin?.payload);
  const currentValue=field==='companyId'?version.companyId:version.row.employmentType,previousValue=field==='companyId'?previous.companyId:previous.row.employmentType;
  const replacesCorrection=version.origin?.eventType==='employment.information.corrected'&&Array.isArray(payload.fields)&&payload.fields.includes(field);
  const proven=!!version.origin&&['employment.assignment.changed','assignment.transferred','assignment.entity-backfilled','employment.information.corrected'].includes(version.origin.eventType);
  if(!replacesCorrection&&(!proven||currentValue!==previousValue))break;
  count++;
 }
 return count;
}

/** Original-hire values and later intentional boundaries, shared by the form and the writer. */
export function hireEmploymentInformationBaseline(master:{companyId:string;hiredOn:string;joinDate:string|null;gradeId:string|null},plan:Plan){
 const events=plan.events,first=plan.chain[0];
 if(!first)throw new Error('The original hire assignment is unavailable.');
 const reversed=new Set(events.filter(event=>event.eventType==='employment.movement.reversed').map(event=>String(object(event.payload).movementId)));
 const reversedGroups=new Set(events.filter(event=>reversed.has(event.id)).map(event=>String(tag(event).groupId??event.id)));
 const primaryGroups=new Set(events.filter(event=>tag(event).secondary!==true&&!reversed.has(event.id)).map(event=>String(tag(event).groupId??event.id)));
 const active=(event:Event)=>!tag(event).groupId||!reversedGroups.has(String(tag(event).groupId))&&primaryGroups.has(String(tag(event).groupId));
 const gradeEvents=events.filter(event=>event.eventType==='employment.grade.changed'&&active(event));
 const joinEvents=events.filter(event=>active(event)&&(event.eventType==='employment.info.updated'&&Array.isArray(object(event.payload).fields)&&(object(event.payload).fields as unknown[]).includes('joinDate')||event.eventType==='employment.company.transferred'));
 const hired=events.find(event=>event.eventType==='employment.hired');
 const correctionOf=(field:string)=>[...events].reverse().find(event=>event.eventType==='employment.information.corrected'&&object(event.payload).source==='original-hire'&&Array.isArray(object(event.payload).fields)&&(object(event.payload).fields as unknown[]).includes(field));
 const gradeCorrection=correctionOf('gradeId'),joinCorrection=correctionOf('joinDate');
 const originalJoin=joinEvents.find(event=>Object.hasOwn(object(object(event.payload).before),'joinDate'));
 const gradeAtHire=gradeCorrection?object(object(gradeCorrection.payload).after).gradeId:hired&&Object.hasOwn(object(hired.payload),'gradeId')?object(hired.payload).gradeId:gradeEvents.length?object(gradeEvents[0].payload).before:master.gradeId;
 const joinAtHire=joinCorrection?object(object(joinCorrection.payload).after).joinDate:originalJoin?object(object(originalJoin.payload).before).joinDate:master.joinDate;
 const scalarFacts=movementInformationEvidence(events,plan.anchor,Number.MAX_SAFE_INTEGER);
 const before:Record<HireEmploymentInformationField,string|null>={...Object.fromEntries(HIRE_SCALAR_INFORMATION_FIELDS.map(field=>[field,scalarFacts[field].value])) as Record<typeof HIRE_SCALAR_INFORMATION_FIELDS[number],string|null>,companyId:first.companyId,hiredOn:master.hiredOn,joinDate:typeof joinAtHire==='string'?joinAtHire:null,gradeId:typeof gradeAtHire==='string'?gradeAtHire:null,employmentType:first.row.employmentType};
 return {before,gradeEvents,joinEvents,hired,activeEvents:events.filter(active)};
}
const effectiveDay=(event:Event)=>typeof tag(event).effectiveDate==='string'?String(tag(event).effectiveDate):typeof object(event.payload).effectiveOn==='string'?String(object(event.payload).effectiveOn):typeof object(event.payload).effectiveDate==='string'?String(object(event.payload).effectiveDate):todayInKualaLumpur(event.occurredAt);

/** This is the hire correction's private information leg. It reuses the same assignment lineage and
 * supersedes/reinserts in one batch, carrying corrected values only through proven inherited versions.
 * The existing Hired event and every finalized payroll row remain untouched. */
export async function correctHireEmploymentInformationTx(tx:Tx,ctx:SessionContext,input:{employmentId:string;changes:HireEmploymentInformation;reason:string;endDates?:Partial<Record<'contractEndDate'|'internshipEndDate',string|null>>},readPlan:()=>Promise<Plan>){
 if(!hasClosedPayrollCorrectionAuthorityTx(tx,input.employmentId))throw new Error('Hire information correction requires the canonical preservation owner.');
 await assertWorkforceEmploymentTx(tx,ctx,input.employmentId,'maintain');
 if(Object.keys(input.changes).some(field=>!(HIRE_EMPLOYMENT_INFORMATION_FIELDS as readonly string[]).includes(field)))throw new Error('An unsupported hire information field was supplied.');
 const [master]=await tx.select().from(employment).where(eq(employment.id,input.employmentId));
 if(!master)throw new Error('Employee record is unavailable.');
 let plan=await readPlan();
 const {before,gradeEvents,joinEvents,hired,activeEvents}=hireEmploymentInformationBaseline(master,plan);
 const first=plan.chain[0];
 const after={...before};
 for(const field of HIRE_EMPLOYMENT_INFORMATION_FIELDS)if(input.changes[field]!==undefined)after[field]=input.changes[field]===null?null:String(input.changes[field]).trim()||null;
 if(after.employmentType==='contract'&&before.employmentType!=='contract'&&after.contractStartDate===null)after.contractStartDate=after.joinDate??after.hiredOn;
 if(input.changes.hiredOn!==undefined&&input.changes.joinDate===undefined&&before.joinDate===before.hiredOn)after.joinDate=after.hiredOn;
 for(const period of MOVEMENT_EMPLOYMENT_PERIODS){
  if(input.changes[period.value]===undefined&&input.changes[period.unit]===undefined)continue;
  if(after[period.unit]!==null)after[period.unit]=after[period.unit]!.toLowerCase();
  if(after[period.value]!==null&&/^\d+$/.test(after[period.value]!))after[period.value]=String(Number(after[period.value]));
  if(after[period.value]===null)after[period.unit]=null;
  else if(after[period.unit]===null)throw new Error('Choose Day, Week or Month for the corrected employment period.');
 }
 const fields=HIRE_EMPLOYMENT_INFORMATION_FIELDS.filter(field=>before[field]!==after[field]);
 const endFieldAtHire=after.employmentType==='contract'?'contractEndDate':after.employmentType==='intern'?'internshipEndDate':null;
 const originalTypeEndsAt=plan.chain[inheritedLength(plan,'employmentType')-1].row.validTo;
 const historicalEndPosted=!!endFieldAtHire&&input.endDates?.[endFieldAtHire]!==undefined&&originalTypeEndsAt!==null;
 if(!fields.length&&!historicalEndPosted)return null;
 if(!after.companyId||!uuid.test(after.companyId)||after.gradeId!==null&&!uuid.test(after.gradeId))throw new Error('Choose a valid company and job grade.');
 if(!after.hiredOn||!isCalendarDate(after.hiredOn)||after.joinDate!==null&&!isCalendarDate(after.joinDate))throw new Error('Enter valid joining dates.');
 if(!['full_time','part_time','contract','intern'].includes(after.employmentType??''))throw new Error('Choose a valid Employment Type.');
 const affectedLength=Math.max(fields.includes('companyId')?inheritedLength(plan,'companyId'):0,fields.includes('employmentType')?inheritedLength(plan,'employmentType'):0);
 for(const field of HIRE_SCALAR_INFORMATION_FIELDS){
  if(!fields.includes(field)||after[field]===null)continue;
  const next=after[field]!;
  if(field.endsWith('Date')&&!isCalendarDate(next))throw new Error('Enter valid employment dates in YYYY-MM-DD format.');
  if(field.endsWith('Value')&&(!/^\d+$/.test(next)||!Number.isSafeInteger(Number(next))))throw new Error('Employment periods must be whole numbers greater than or equal to zero.');
  if(field.endsWith('Unit')&&!['day','week','month'].includes(next))throw new Error('Period unit must be Month, Week or Day.');
 }
 assertEmploymentInformationDateOrder({hire:after.hiredOn,join:after.joinDate,confirmation:after.confirmationDate,extendedConfirmation:after.extendedConfirmationDate,tender:after.tenderResignationDate,resignation:after.resignationDate,lastWorking:after.lastWorkingDate});
 await assertEmploymentInformationLabelsTx(tx,Object.fromEntries(fields.filter(field=>HIRE_SCALAR_INFORMATION_FIELDS.includes(field as typeof HIRE_SCALAR_INFORMATION_FIELDS[number])).map(field=>[field,after[field]])),before,after.companyId);
 const scopes=[...new Set([master.companyId,first.companyId,after.companyId,...plan.chain.slice(0,affectedLength).map(version=>version.companyId)])];
 const companies=await tx.select({id:company.id,country:company.country,archivedAt:company.archivedAt,allowed:sql<boolean>`app.is_admin_for(${company.id}) and app.access_workforce_company(${company.id},'workforce.maintain')`}).from(company).where(and(eq(company.tenantId,ctx.tenantId),inArray(company.id,scopes)));
 if(companies.length!==scopes.length||companies.some(row=>!row.allowed))throw new Error('You must maintain every company whose hire history this correction affects.');
 if(fields.includes('companyId')&&companies.find(row=>row.id===after.companyId)?.archivedAt)throw new Error('Choose an active corrected hire company.');
 if(fields.includes('companyId')&&companies.find(row=>row.id===first.companyId)?.country!==companies.find(row=>row.id===after.companyId)?.country)throw new Error('A hire correction cannot change the statutory country. Use the relevant employment lifecycle workflow.');
 if(fields.includes('gradeId')&&after.gradeId){
  const [grade]=await tx.select({id:jobGrade.id}).from(jobGrade).where(and(eq(jobGrade.id,after.gradeId),eq(jobGrade.tenantId,ctx.tenantId),isNull(jobGrade.archivedAt),sql`app.system_label_scope_applies(${jobGrade.scopeCompanyIds},${after.companyId}::uuid)`));
  if(!grade)throw new Error('Choose an active job grade available for the corrected hire company.');
 }
 const joinDates=joinEvents.map(effectiveDay).filter(date=>date>=plan.anchor).sort();
 if(after.joinDate&&joinDates[0]&&after.joinDate>joinDates[0])throw new Error('The corrected original Join Date falls after a later joining decision. Resolve that date conflict first.');
 if(fields.includes('hiredOn')){
  await setEmploymentInfo(ctx,{employmentId:input.employmentId,hiredOn:after.hiredOn!,movement:{type:'groupJoinDateCorrection',groupId:randomUUID(),secondary:true,effectiveDate:after.hiredOn!,remarks:input.reason}},tx);
  await alignHistoryToGroupJoinDateTx(tx,ctx,input.employmentId,'groupJoinDateCorrection',message=>new Error(message));
 }
 if(fields.includes('joinDate')&&!joinDates.length){
  await setEmploymentInfo(ctx,{employmentId:input.employmentId,joinDate:after.joinDate,movement:{type:'joinDateChange',groupId:randomUUID(),secondary:true,effectiveDate:plan.anchor,remarks:input.reason}},tx);
 }else if(fields.includes('hiredOn')&&joinDates.length&&master.joinDate===master.hiredOn){
  // A later independently recorded Join Date remains authoritative even when it coincidentally
  // equals the previous Group Join Date (the native group-date owner normally carries that equality).
  await setEmploymentInfo(ctx,{employmentId:input.employmentId,joinDate:master.joinDate,movement:{type:'joinDateChange',groupId:randomUUID(),secondary:true,effectiveDate:plan.anchor,remarks:input.reason}},tx);
 }
 if(fields.includes('hiredOn')||fields.includes('joinDate'))plan=await readPlan();

 const hireEndField=after.employmentType==='contract'?'contractEndDate':after.employmentType==='intern'?'internshipEndDate':null;
 const previousEnd=hireEndField?[...plan.events].reverse().map(event=>object(object(event.payload).endDate)).find(end=>end.field===hireEndField):null;
 const initialInformation=object(object(hired?.payload).employmentInformation);
 const endBeforeKnown=!!hireEndField&&(!!previousEnd||Object.hasOwn(initialInformation,hireEndField)||originalTypeEndsAt===null&&before.employmentType===after.employmentType);
 const endBefore=hireEndField?(previousEnd?.after??(Object.hasOwn(initialInformation,hireEndField)?initialInformation[hireEndField]:originalTypeEndsAt===null&&before.employmentType===after.employmentType?master[hireEndField]:null)):null;
 const hireEnd=hireEndField?(input.endDates?.[hireEndField]!==undefined?input.endDates[hireEndField]:previousEnd?.after??master[hireEndField]):null;
 if((fields.includes('employmentType')||historicalEndPosted)&&hireEndField&&(!hireEnd||typeof hireEnd!=='string'||!isCalendarDate(hireEnd)||hireEnd<plan.anchor))throw new Error('The corrected original Employment Type requires a valid end date on or after the original joining date.');
 if(fields.includes('contractStartDate')||fields.includes('employmentType')&&after.employmentType==='contract'){
  const issues=contractPeriodIssues({contract:after.employmentType==='contract',requireBoth:false,hiredOn:after.hiredOn,start:after.contractStartDate,end:hireEndField==='contractEndDate'&&typeof hireEnd==='string'?hireEnd:null});
  if(issues.length)throw new Error(issues[0].message);
 }
 const until:Partial<Record<HireEmploymentInformationField,string|null>>={...(fields.includes('joinDate')?{joinDate:joinDates[0]??null}:{})};
 const spans=new Map<'companyId'|'employmentType',number>();
 const boundaries:{field:string;assignmentId:string;date:string;reason:string}[]=[];
 for(const field of ['companyId','employmentType'] as const){
  if(!fields.includes(field))continue;
  const count=inheritedLength(plan,field),boundary=plan.chain[count];
  if(boundary)boundaries.push({field,assignmentId:boundary.row.id,date:boundary.row.validFrom,reason:boundary.origin?'later_intentional_change':'unverified_inheritance'});
  spans.set(field,count);until[field]=plan.chain[count-1].row.validTo;
 }
 const replacements=plan.chain.flatMap((version,index)=>{
  const changed=(['companyId','employmentType'] as const).filter(field=>index<(spans.get(field)??0));
  return changed.length?[{version,fields:changed,id:randomUUID()}]:[];
 });
 if(replacements.length){
  const removed=await tx.update(assignment).set({supersededAt:new Date()}).where(and(inArray(assignment.id,replacements.map(row=>row.version.row.id)),isNull(assignment.supersededAt))).returning({id:assignment.id});
  if(removed.length!==replacements.length)throw new Error('Hire history changed. Reload and review the correction.');
  await tx.insert(assignment).values(replacements.map(({version,fields,id})=>({id,tenantId:ctx.tenantId,employmentId:input.employmentId,departmentId:version.row.departmentId,positionId:version.row.positionId,businessUnitId:version.row.businessUnitId,costCenterId:version.row.costCenterId,locationId:version.row.locationId,
   companyId:fields.includes('companyId')?after.companyId!:version.row.companyId,employmentType:(fields.includes('employmentType')?after.employmentType:version.row.employmentType) as typeof version.row.employmentType,validFrom:version.row.validFrom,validTo:version.row.validTo})));
 }
 const currentCompanyChanges=replacements.some(row=>row.version.row.validTo===null&&row.fields.includes('companyId'));
 const gradeDates=gradeEvents.map(effectiveDay).filter(date=>date>=plan.anchor).sort();
 if(fields.includes('gradeId'))until.gradeId=gradeDates[0]??null;
 const gradeToProject=fields.includes('gradeId')&&!gradeDates.length?after.gradeId:master.gradeId;
 let clearedGradeId:string|null=null;
 if(currentCompanyChanges&&gradeToProject){
  const [available]=await tx.select({valid:sql<boolean>`app.system_label_scope_applies(${jobGrade.scopeCompanyIds},${after.companyId}::uuid)`}).from(jobGrade).where(and(eq(jobGrade.id,gradeToProject),eq(jobGrade.tenantId,ctx.tenantId)));
  if(!available?.valid)clearedGradeId=gradeToProject;
 }
 const invalidCurrentLabels=currentCompanyChanges?await tx.execute<{field:typeof MOVEMENT_FLAT_FIELDS[number]}>(sql`
  select field from jsonb_to_recordset(${JSON.stringify(COMPANY_LABELS.map(label=>({...label,value:master[label.field]})))}::jsonb) as picked(field text,category text,value text)
  where value is not null and not app.system_label_value_scope_allowed(category,value,${after.companyId}::uuid)`):[];
 const clearedCompanyValues=Object.fromEntries(invalidCurrentLabels.map(label=>[label.field,master[label.field]]));
 if(currentCompanyChanges||fields.includes('gradeId')&&!gradeDates.length)await tx.update(employment).set({
  ...(currentCompanyChanges?{companyId:after.companyId!,payrollPolicyId:null,costAllocation:null}:{}),
  ...(fields.includes('gradeId')&&!gradeDates.length?{gradeId:after.gradeId}:{}),
  ...(clearedGradeId?{gradeId:null}:{}),...Object.fromEntries(invalidCurrentLabels.map(label=>[label.field,null]))}).where(eq(employment.id,input.employmentId));
 const scalarPatch:Record<string,string|number|null>={};
 for(const field of HIRE_SCALAR_INFORMATION_FIELDS){
  if(!fields.includes(field))continue;
  const period=MOVEMENT_EMPLOYMENT_PERIODS.find(period=>period.value===field||period.unit===field);
  const relatedFields:readonly string[]=period?[period.value,period.unit]:field==='contractStartDate'?[field,'employmentType']:[field];
  const later=activeEvents.filter(event=>{
   if(event.eventType!=='employment.info.updated'&&event.eventType!=='employment.information.corrected'&&event.eventType!=='employment.movement.scheduled'&&event.eventType!=='employment.assignment.changed'&&event.eventType!=='assignment.transferred')return false;
   const payload=object(event.payload);
   if(payload.source==='original-hire')return false;
   if(event.eventType==='employment.info.updated'&&!tag(event).groupId&&hired&&event.occurredAt.getTime()===hired.occurredAt.getTime())return false;
   const changedFields=Array.isArray(payload.fields)?payload.fields:Object.keys(object(payload.after??payload.to)).filter(key=>object(payload.after??payload.to)[key]!==object(payload.before??payload.from)[key]);
   return changedFields.some(changed=>typeof changed==='string'&&relatedFields.includes(changed))&&effectiveDay(event)>plan.anchor;
  }).map(effectiveDay).sort()[0]??null;
  until[field]=later;
  if(later&&later<=todayInKualaLumpur())continue;
  const next=after[field];
  if(field.endsWith('Value')&&MOVEMENT_EMPLOYMENT_PERIOD_FIELDS.includes(field as typeof MOVEMENT_EMPLOYMENT_PERIOD_FIELDS[number])){
   if(next!==null&&!/^\d+$/.test(next))throw new Error('Employment periods must use whole numbers greater than or equal to zero.');
   scalarPatch[field]=next===null?null:Number(next);
  }else scalarPatch[field]=next;
 }
 if(hireEndField&&originalTypeEndsAt===null&&(fields.includes('employmentType')||'contractStartDate' in scalarPatch)&&typeof hireEnd==='string')scalarPatch[hireEndField]=hireEnd;
 if(Object.keys(scalarPatch).length){
  // Canonical validation owns configured labels, period pairs, lifecycle ordering and signed-case guards.
  const write=()=>setEmploymentInfo(ctx,{employmentId:input.employmentId,...scalarPatch,movement:{type:fields.includes('extendedConfirmationDate')?'probationExtension':'orgAssignmentChange',groupId:randomUUID(),secondary:true,effectiveDate:plan.anchor,remarks:input.reason}},tx);
  if(['tenderResignationDate','resignationDate','lastWorkingDate'].some(field=>field in scalarPatch))await withExitDateAuthorityTx(tx,input.employmentId,write);else await write();
 }
 const endUntil=fields.includes('employmentType')?until.employmentType:originalTypeEndsAt;
 const endDate=(fields.includes('employmentType')||historicalEndPosted)&&hireEndField&&endUntil?{field:hireEndField,before:endBefore,beforeKnown:endBeforeKnown,after:hireEnd,until:endUntil}:null;
 if(!fields.length&&endDate?.before===endDate?.after)return null;
 const assignmentProof=replacements.map(row=>({supersededId:row.version.row.id,replacementId:row.id,insertedId:row.id,validFrom:row.version.row.validFrom,validTo:row.version.row.validTo,companyId:row.fields.includes('companyId')?after.companyId:row.version.companyId,fields:row.fields}));
 const reviewFields:string[]=[];
 if(fields.includes('companyId')){
  if(currentCompanyChanges&&master.payrollPolicyId)reviewFields.push('payrollPolicyId');
  if(after.gradeId){const [grade]=await tx.select({valid:sql<boolean>`${jobGrade.archivedAt} is null and app.system_label_scope_applies(${jobGrade.scopeCompanyIds},${after.companyId}::uuid)`}).from(jobGrade).where(eq(jobGrade.id,after.gradeId));if(!grade?.valid)reviewFields.push('gradeId');}
  const [allocation]=await tx.execute<{mismatch:boolean}>(sql`select exists(select 1 from employment_cost_allocation_set s where s.tenant_id=${ctx.tenantId}::uuid and s.employment_id=${input.employmentId}::uuid and s.superseded_at is null
   and s.company_id<>${after.companyId}::uuid and (s.valid_to is null or s.valid_to>${plan.anchor}::date) and (${until.companyId??null}::date is null or s.valid_from<${until.companyId??null}::date)) as mismatch`);
  if(allocation?.mismatch)reviewFields.push('costAllocation');
  reviewFields.push(...invalidCurrentLabels.map(label=>label.field));
  if(clearedGradeId&&!reviewFields.includes('gradeId'))reviewFields.push('gradeId');
 }
 const eventId=await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'employment',aggregateId:input.employmentId,eventType:'employment.information.corrected',actor:actorOf(ctx),subjectEmploymentId:input.employmentId,
  payload:{source:'original-hire',method:'manual',hiredEventId:hired?.id??null,fromJoinDate:true,dated:true,effectiveOn:plan.anchor,before:{...before,...(endDate?{[endDate.field]:endDate.before}:{})},after:{...after,...(endDate?{[endDate.field]:endDate.after}:{})},fields:[...fields,...(endDate?[endDate.field]:[])],reason:input.reason,until:{...until,...(endDate?{[endDate.field]:endDate.until}:{})},endDate,assignment:assignmentProof,inserted:assignmentProof.map(row=>row.replacementId),boundaries,
   labelsNotCurrent:fields.includes('gradeId')&&gradeDates.length?['gradeId']:[],
   ...(currentCompanyChanges?{clearedPayrollPolicyId:master.payrollPolicyId,clearedLegacyCostAllocation:master.costAllocation,clearedGradeId,clearedCompanyValues}:{}),
   reviewFields,companyAssignmentReviewRequired:reviewFields.length>0}},{returnId:true});
 const ends=[...fields.map(field=>until[field]??null),...(endDate?[endDate.until]:[])],end=ends.some(value=>value===null)?null:ends.filter((value):value is string=>!!value).sort().at(-1)??null;
 const from=[before.hiredOn!,after.hiredOn!,plan.anchor].sort()[0];
 if(end===null||end>from)await markWorkforcePayrollInputsChangedTx(tx,ctx,{employmentId:input.employmentId,from,until:end});
 return {eventId,before,after,fields,until,endDate,boundaries,assignment:assignmentProof,reviewFields,companyAssignmentReviewRequired:reviewFields.length>0};
}

/** Follow-up is derived from the existing assignment, grade, policy and allocation owners. Correcting
 * a later field clears its finding naturally; no independent permanent "reviewed" flag owns a fact. */
export async function hireCompanyCorrectionReviewTx(tx:Tx,ctx:SessionContext,input:{employmentId:string;companyId:string;gradeId:string|null;anchor:string}){
 const [row]=await tx.execute<{grade:boolean;policy:boolean;allocation:boolean;labels:string[]}>(sql`
  with correction as (
   select id,payload,sequence from domain_event where tenant_id=${ctx.tenantId}::uuid and subject_employment_id=${input.employmentId}::uuid
    and event_type='employment.information.corrected' and payload->>'source'='original-hire' and payload->'fields' ? 'companyId'
   order by sequence desc limit 1
  ) select
   (exists(select 1 from correction where ${input.gradeId}::uuid is not null and not exists(select 1 from job_grade g where g.id=${input.gradeId}::uuid and g.tenant_id=${ctx.tenantId}::uuid and g.archived_at is null and app.system_label_scope_applies(g.scope_company_ids,${input.companyId}::uuid)))
    or exists(select 1 from correction c join employment e on e.id=${input.employmentId}::uuid and e.tenant_id=${ctx.tenantId}::uuid where c.payload->>'clearedGradeId' is not null and e.company_id=${input.companyId}::uuid and e.grade_id is null
     and not exists(select 1 from domain_event decided where decided.tenant_id=e.tenant_id and decided.subject_employment_id=e.id and decided.sequence>c.sequence
      and (decided.event_type='employment.grade.changed' or decided.event_type='employment.information.corrected' and decided.payload->'fields' ? 'gradeId'
       and coalesce(decided.payload->>'effectiveOn','9999-12-31')<=${todayInKualaLumpur()} and (decided.payload->'until'->>'gradeId' is null or decided.payload->'until'->>'gradeId'>${todayInKualaLumpur()}))))) as grade,
   array(select picked.field from correction c join employment e on e.id=${input.employmentId}::uuid and e.tenant_id=${ctx.tenantId}::uuid
    cross join jsonb_to_recordset(${JSON.stringify(COMPANY_LABELS)}::jsonb) as picked(field text,"column" text)
    where e.company_id=${input.companyId}::uuid and c.payload->'clearedCompanyValues' ? picked.field and to_jsonb(e)->>picked."column" is null) as labels,
   exists(select 1 from correction c join employment e on e.id=${input.employmentId}::uuid and e.tenant_id=${ctx.tenantId}::uuid where c.payload->>'clearedPayrollPolicyId' is not null and e.company_id=${input.companyId}::uuid and e.payroll_policy_id is null) as policy,
   exists(select 1 from correction c join employment_cost_allocation_set s on s.employment_id=${input.employmentId}::uuid and s.tenant_id=${ctx.tenantId}::uuid
    where s.superseded_at is null and s.company_id<>${input.companyId}::uuid and (s.valid_to is null or s.valid_to>${input.anchor}::date)
     and ((c.payload->'until'->>'companyId') is null or s.valid_from<(c.payload->'until'->>'companyId')::date))
    or exists(select 1 from correction c join domain_event marker on marker.tenant_id=${ctx.tenantId}::uuid and marker.subject_employment_id=${input.employmentId}::uuid
     and marker.event_type='employment.cost-allocations.company-corrected' and marker.payload->>'correctionId'=c.id::text and marker.payload->>'requiresReview'='true'
     join employment_cost_allocation_set s on s.id::text=marker.payload->>'reviewSetId' and s.tenant_id=marker.tenant_id and s.employment_id=marker.subject_employment_id and s.superseded_at is null) as allocation
 `);
 return [row?.grade?'gradeId':null,row?.policy?'payrollPolicyId':null,row?.allocation?'costAllocation':null,...(row?.labels??[])].filter((field):field is string=>field!==null);
}
