import {randomUUID} from 'node:crypto';
import {and,eq,inArray,isNull,sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import {assignment,company,employment,jobGrade} from '../db/schema';
import {appendEvent,actorOf} from '../db/events';
import {setEmploymentInfo} from './org';
import {hasClosedPayrollCorrectionAuthorityTx} from './closed-payroll-correction-authority';
import {assertWorkforceEmploymentTx} from './workforce-access';
import {markWorkforcePayrollInputsChangedTx} from './workforce-payroll-invalidation';
import {todayInKualaLumpur} from '../lib/hr-date';
import {alignHistoryToGroupJoinDateTx} from './movement-history';
import {isCalendarDate} from '../lib/calendar-date';

export const HIRE_EMPLOYMENT_INFORMATION_FIELDS=['companyId','hiredOn','joinDate','gradeId','employmentType'] as const;
export type HireEmploymentInformationField=typeof HIRE_EMPLOYMENT_INFORMATION_FIELDS[number];
export type HireEmploymentInformation=Partial<Record<HireEmploymentInformationField,string|null>>;
type Event={id:string;eventType:string;payload:unknown;occurredAt:Date;sequence:number};
type Version={row:typeof assignment.$inferSelect;origin:{eventType:string;payload:unknown}|null;companyId:string};
type Plan={anchor:string;chain:Version[];events:Event[]};
const object=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const tag=(event:Event)=>object(object(event.payload).movement);
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

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
 const before:Record<HireEmploymentInformationField,string|null>={companyId:first.companyId,hiredOn:master.hiredOn,joinDate:typeof joinAtHire==='string'?joinAtHire:null,gradeId:typeof gradeAtHire==='string'?gradeAtHire:null,employmentType:first.row.employmentType};
 return {before,gradeEvents,joinEvents,hired};
}
const effectiveDay=(event:Event)=>typeof tag(event).effectiveDate==='string'?String(tag(event).effectiveDate):typeof object(event.payload).effectiveDate==='string'?String(object(event.payload).effectiveDate):todayInKualaLumpur(event.occurredAt);

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
 const {before,gradeEvents,joinEvents,hired}=hireEmploymentInformationBaseline(master,plan);
 const first=plan.chain[0];
 const after={...before};
 for(const field of HIRE_EMPLOYMENT_INFORMATION_FIELDS)if(input.changes[field]!==undefined)after[field]=input.changes[field]===null?null:String(input.changes[field]).trim()||null;
 const fields=HIRE_EMPLOYMENT_INFORMATION_FIELDS.filter(field=>before[field]!==after[field]);
 if(!fields.length)return null;
 if(!after.companyId||!uuid.test(after.companyId)||after.gradeId!==null&&!uuid.test(after.gradeId))throw new Error('Choose a valid company and job grade.');
 if(!after.hiredOn||!isCalendarDate(after.hiredOn)||after.joinDate!==null&&!isCalendarDate(after.joinDate))throw new Error('Enter valid joining dates.');
 if(!['full_time','part_time','contract','intern'].includes(after.employmentType??''))throw new Error('Choose a valid Employment Type.');
 const scopes=[...new Set([master.companyId,first.companyId,after.companyId,...(fields.includes('employmentType')||fields.includes('companyId')?plan.chain.map(version=>version.companyId):[])])];
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
 const hireEnd=hireEndField?(input.endDates?.[hireEndField]!==undefined?input.endDates[hireEndField]:previousEnd?.after??master[hireEndField]):null;
 if(fields.includes('employmentType')&&hireEndField&&(!hireEnd||typeof hireEnd!=='string'||!isCalendarDate(hireEnd)||hireEnd<plan.anchor))throw new Error('The corrected original Employment Type requires a valid end date on or after the original joining date.');
 const until:Partial<Record<HireEmploymentInformationField,string|null>>={...(fields.includes('joinDate')?{joinDate:joinDates[0]??null}:{})};
 const spans=new Map<'companyId'|'employmentType',number>();
 const boundaries:{field:string;assignmentId:string;date:string;reason:string}[]=[];
 for(const field of ['companyId','employmentType'] as const){
  if(!fields.includes(field))continue;
  let count=1;
  while(count<plan.chain.length){
   const version=plan.chain[count],previous=plan.chain[count-1],payload=object(version.origin?.payload);
   const currentValue=field==='companyId'?version.companyId:version.row.employmentType,previousValue=field==='companyId'?previous.companyId:previous.row.employmentType;
   const replacesCorrection=version.origin?.eventType==='employment.information.corrected'&&Array.isArray(payload.fields)&&payload.fields.includes(field);
   const proven=!!version.origin&&['employment.assignment.changed','assignment.transferred','assignment.entity-backfilled','employment.information.corrected'].includes(version.origin.eventType);
   if(!replacesCorrection&&(!proven||currentValue!==previousValue)){
    boundaries.push({field,assignmentId:version.row.id,date:version.row.validFrom,reason:proven?'later_intentional_change':'unverified_inheritance'});break;
   }
   count++;
  }
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
 if(currentCompanyChanges||fields.includes('gradeId')&&!gradeDates.length)await tx.update(employment).set({
  ...(currentCompanyChanges?{companyId:after.companyId!,payrollPolicyId:null,costAllocation:null}:{}),
  ...(fields.includes('gradeId')&&!gradeDates.length?{gradeId:after.gradeId}:{})}).where(eq(employment.id,input.employmentId));
 const endDate=fields.includes('employmentType')&&hireEndField&&until.employmentType?{field:hireEndField,before:previousEnd?.after??null,after:hireEnd,until:until.employmentType}:null;
 const assignmentProof=replacements.map(row=>({supersededId:row.version.row.id,replacementId:row.id,insertedId:row.id,validFrom:row.version.row.validFrom,validTo:row.version.row.validTo,companyId:row.fields.includes('companyId')?after.companyId:row.version.companyId,fields:row.fields}));
 const eventId=await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'employment',aggregateId:input.employmentId,eventType:'employment.information.corrected',actor:actorOf(ctx),subjectEmploymentId:input.employmentId,
  payload:{source:'original-hire',method:'manual',hiredEventId:hired?.id??null,fromJoinDate:true,dated:true,effectiveOn:plan.anchor,before,after,fields,reason:input.reason,until,endDate,assignment:assignmentProof,inserted:assignmentProof.map(row=>row.replacementId),boundaries,
   labelsNotCurrent:fields.includes('gradeId')&&gradeDates.length?['gradeId']:[],
   ...(currentCompanyChanges?{clearedPayrollPolicyId:master.payrollPolicyId,clearedLegacyCostAllocation:master.costAllocation}:{}),
   companyAssignmentReviewRequired:fields.includes('companyId')}},{returnId:true});
 const ends=fields.map(field=>until[field]??null),end=ends.some(value=>value===null)?null:ends.filter((value):value is string=>!!value).sort().at(-1)??null;
 const from=[before.hiredOn!,after.hiredOn!,plan.anchor].sort()[0];
 if(end===null||end>from)await markWorkforcePayrollInputsChangedTx(tx,ctx,{employmentId:input.employmentId,from,until:end});
 return {eventId,before,after,fields,until,endDate,boundaries,assignment:assignmentProof,companyAssignmentReviewRequired:fields.includes('companyId')};
}
