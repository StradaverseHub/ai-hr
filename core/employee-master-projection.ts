/** Bounded typed report projection. Stored facts are read under the caller's explicit scoped snapshot.
 * Owner derivations (status, service, movements, Leave, encashment and country statutory) are reused.
 * Descriptors never become SQL identifiers; every source table and relationship is closed below.
 */
import { and, asc, eq, getTableColumns, inArray, isNull, lte, or, type SQL } from 'drizzle-orm';
import type { AnyPgColumn, AnyPgTable } from 'drizzle-orm/pg-core';
import type { SessionContext, Tx } from '../db/client';
import * as schema from '../db/schema';
import {personnelChildReliefCell,personnelChildReliefValue,personnelReportValueKey} from '../lib/personnel-report-value';
import type { PersonnelFieldDescriptor } from '../lib/personnel-field-registry';
import type { EmployeeMasterSpec, MasterCell, MasterOwnerRecord, MasterSubject } from '../lib/employee-master-report';
import { draftFamily, draftProvisionalEndOn, withSameAsPermanent, type EmployeeDraftData } from '../lib/employee-draft-schema';
import { completedYearsAt } from '../lib/completed-years';
import { todayInKualaLumpur } from '../lib/hr-date';
import { companyOnDate, dayBefore, provenCompanySegmentsForPeriodBulkTx, employedByCompanyDuring, provenCompanyDatesTx } from './employment-company';
import { deriveEmploymentStatus } from './employment-status';
import { hireCorrectionViewTx } from './hire-correction';
import { movementHistoryTx, movementDetailTx } from './movement';
import { isChildReliefEligible, qualifyingChildReliefFor } from './dependents';
import { packFor } from '../localization/registry';
import { benefitSchemeViewTx, encashmentSnapshotForEmploymentTx, leaveBalancesTx, leaveEntitlementBreakdownTx, serviceYearsMonthsDaysAt } from '../packs/leave/service';

const nextDay=(value:unknown):string|null=>{const v=date(value);if(!v)return null;const d=new Date(v+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+1);return d.toISOString().slice(0,10);};
const nextMonth=(value:unknown):string|null=>{const v=text(value)?.slice(0,7);if(!v)return null;const d=new Date(v+'-01T00:00:00Z');d.setUTCMonth(d.getUTCMonth()+1);return d.toISOString().slice(0,10);};
const SUBJECT_LIMIT=2000, RECORD_LIMIT=50_000;
type Row=Record<string,unknown>;
const text=(value:unknown):string|null=>typeof value==='string'?value:value instanceof Date?value.toISOString():null;
const date=(value:unknown):string|null=>text(value)?.slice(0,10)??null;
const object=(value:unknown):Row=>value&&typeof value==='object'&&!Array.isArray(value)?value as Row:{};
const scalar=(value:unknown):MasterCell=>value===undefined?{value:null,unavailable:'not-recorded'}:value===null?{value:null}:typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value)?{value}:value instanceof Date?{value:value.toISOString()}:{value:null,unavailable:'not-recorded'};
const duration=(from:unknown,asAt:string):string|null=>{
  if(typeof from!=='string')return null;const value=serviceYearsMonthsDaysAt(from,asAt);
  return `${value.years}y ${value.months}m ${value.days}d`;
};
/** Metadata only: bytes and protected file URLs never enter report data. */
async function rowsFor(tx:Tx,table:AnyPgTable,key:AnyPgColumn,ids:string[],extra?:SQL,omit:string[]=[]):Promise<Row[]>{
  if(!ids.length)return [];
  const columns={...getTableColumns(table)};for(const field of omit)delete columns[field];
  const rows=await tx.select(columns).from(table).where(and(inArray(key,ids),extra)).limit(RECORD_LIMIT+1);
  if(rows.length>RECORD_LIMIT)throw new Error('Too many records. Narrow the report company/employee conditions.');
  return rows as Row[];
}

export async function employeeMasterSubjectsTx(tx:Tx,ctx:SessionContext,spec:EmployeeMasterSpec,fields:readonly PersonnelFieldDescriptor[],catalogue:readonly PersonnelFieldDescriptor[],options:{includeWithoutCompany?:boolean}={}):Promise<MasterSubject[]>{
  const today=todayInKualaLumpur(),started=Date.now();
  const needed=new Set(fields.filter(f=>spec.asAt===today||f.history!=='current'&&f.history!=='none').map(f=>f.owner));
  const candidates=await tx.select().from(schema.employment).where(and(lte(schema.employment.hiredOn,spec.asAt),or(...spec.companyIds.map(id=>employedByCompanyDuring(id,spec.asAt,spec.asAt))))).orderBy(asc(schema.employment.id)).limit(SUBJECT_LIMIT+1);
  if(candidates.length>SUBJECT_LIMIT)throw new Error('This report matches more than 2,000 employments. Narrow its company/employee conditions.');
  // Canonical termination closes assignment.validTo at terminatedOn (exclusive). An ended report
  // subject needs strict proof of its last effective company day, never today's mutable employer.
  // If that day precedes hire or has missing history, the shared proof resolver still refuses it.
  const scopeDates=new Map(candidates.map(row=>[row.id,row.terminatedOn&&row.terminatedOn<=spec.asAt?dayBefore(row.terminatedOn):spec.asAt]));
  const proofs=await provenCompanyDatesTx(tx,candidates.map(row=>({employmentId:row.id,date:scopeDates.get(row.id)!})));
  const unknownScope:MasterSubject[]=[];
  const employments=candidates.filter(row=>{
    const date=scopeDates.get(row.id)!,proof=proofs.get(row.id+'|'+date);
    // Today's mutable company is a current fact. A past date or ended employment needs dated proof.
    if(date===today||proof?.companyId)return true;
    // Only count an already-visible CURRENT member of a selected/read-authorized company. Other
    // companies' unknown historical membership cannot leak through an excluded-scope count.
    if(spec.companyIds.includes(row.companyId))unknownScope.push({id:row.id,kind:'employment',personId:row.personId,companyId:row.companyId,owners:{},scopeUnavailable:'historical-company-unavailable'});
    return false;
  });
  const ids=employments.map(e=>e.id),personIds=[...new Set(employments.map(e=>e.personId))];
  const earliest=employments.reduce((value,row)=>row.hiredOn<value?row.hiredOn:value,spec.asAt);
  const companySegments=await provenCompanySegmentsForPeriodBulkTx(tx,ids,earliest,spec.asAt);
  const load=(owner:string,table:AnyPgTable,key:AnyPgColumn,keys:string[],extra?:SQL,omit:string[]=[])=>needed.has(owner)?rowsFor(tx,table,key,keys,extra,omit):Promise.resolve([] as Row[]);
  const [people,assignments,compensations,dependents,emergency,superiors,payItems,cp38,qualifications,documents,shiftHistory,recalc,leaveRequests,reviews,reviewDocuments,events]=await Promise.all([
    needed.has('person')?rowsFor(tx,schema.person,schema.person.id,personIds):Promise.resolve([]),
    rowsFor(tx,schema.assignment,schema.assignment.employmentId,ids,isNull(schema.assignment.supersededAt)),
    load('compensation',schema.compensation,schema.compensation.employmentId,ids,isNull(schema.compensation.supersededAt)),
    load('dependent',schema.employeeDependent,schema.employeeDependent.personId,personIds,isNull(schema.employeeDependent.archivedAt)),
    load('emergencyContact',schema.personEmergencyContact,schema.personEmergencyContact.personId,personIds,isNull(schema.personEmergencyContact.archivedAt)),
    needed.has('directSuperior')||needed.has('superiorHistory')||needed.has('delegation')?rowsFor(tx,schema.reportingLine,schema.reportingLine.subordinateEmploymentId,ids,isNull(schema.reportingLine.supersededAt)):Promise.resolve([]),
    load('payItem',schema.employmentPayComponent,schema.employmentPayComponent.employmentId,ids,isNull(schema.employmentPayComponent.supersededAt)),
    load('cp38',schema.employeeCp38,schema.employeeCp38.employmentId,ids,isNull(schema.employeeCp38.supersededAt)),
    load('qualification',schema.employeeQualification,schema.employeeQualification.employmentId,ids,isNull(schema.employeeQualification.archivedAt)),
    load('document',schema.employeeDocument,schema.employeeDocument.employmentId,ids,undefined,['content']),
    needed.has('shiftHistory')||needed.has('attendanceProfile')?rowsFor(tx,schema.employmentShiftArrangement,schema.employmentShiftArrangement.employmentId,ids,isNull(schema.employmentShiftArrangement.supersededAt)):Promise.resolve([]),
    load('leaveRecalc',schema.leaveEntitlementRecalcAudit,schema.leaveEntitlementRecalcAudit.employmentId,ids),
    load('leaveRequest',schema.leaveRequest,schema.leaveRequest.employmentId,ids),
    load('review',schema.employmentReview,schema.employmentReview.employmentId,ids),
    load('review',schema.reviewDocument,schema.reviewDocument.employmentId,ids,undefined,['content']),
    load('audit',schema.domainEvent,schema.domainEvent.subjectEmploymentId,ids),
  ]);
  const referenceRows=await Promise.all([
    tx.select().from(schema.company),tx.select().from(schema.department),tx.select().from(schema.businessUnit),
    tx.select().from(schema.position),tx.select().from(schema.jobGrade),tx.select().from(schema.location),
    tx.select().from(schema.holidayGroup),tx.select().from(schema.attendanceRule),tx.select().from(schema.shift),
    needed.has('payItem')?tx.select().from(schema.payComponent):Promise.resolve([]),
    needed.has('payrollProfile')?tx.select().from(schema.payrollPolicy):Promise.resolve([]),
    needed.has('leaveRecalc')||needed.has('leaveRequest')?tx.select().from(schema.leaveType):Promise.resolve([]),
  ]);
  const refs=referenceRows.map(rows=>new Map(rows.map(row=>[row.id,row as unknown as Row])));
  const refCell=(index:number,id:unknown,field='name'):MasterCell=>({value:text(id==null?null:refs[index].get(String(id))?.[field]),referenceId:text(id),...(id!=null&&refs[index].get(String(id))?.[field]==null?{display:'Reference label unavailable'}:{}),...(spec.asAt!==today?{labelIsCurrent:true}:{})});
  const ref=(index:number,id:unknown,field='name')=>id==null?null:refs[index].get(String(id))?.[field]??null;
  const relatedIds=[...new Set(superiors.map(row=>String(row.managerEmploymentId)))];
  const related=relatedIds.length?await tx.select({id:schema.employment.id,employeeCode:schema.employment.employeeCode,fullName:schema.person.fullName}).from(schema.employment).innerJoin(schema.person,eq(schema.person.id,schema.employment.personId)).where(inArray(schema.employment.id,relatedIds)):[];
  const relatedById=new Map(related.map(row=>[row.id,row]));
  const actors=needed.has('document')||needed.has('movement')||needed.has('movementComparison')||needed.has('audit')||needed.has('shiftHistory')?await tx.select({id:schema.appUser.id,name:schema.person.fullName}).from(schema.appUser).leftJoin(schema.person,eq(schema.person.id,schema.appUser.personId)):[];
  const actorNames=new Map(actors.map(actor=>[actor.id,actor.name]));
  const actorName=(id:unknown)=>actorNames.get(String(id))??null;
  const clockLinks=needed.has('clockingLocation')?await tx.select({employmentId:schema.employeeClockingLocation.employmentId,site:schema.clockingLocation}).from(schema.employeeClockingLocation).innerJoin(schema.clockingLocation,eq(schema.clockingLocation.id,schema.employeeClockingLocation.clockingLocationId)).where(inArray(schema.employeeClockingLocation.employmentId,ids.length?ids:['00000000-0000-0000-0000-000000000000'])):[];
  // This cache belongs to one projection/snapshot. Group each source once instead of scanning
  // up to 50,000 owner rows again for every employment; fresh slices preserve caller sort semantics.
  const rowIndexes=new Map<Row[],Map<string,Map<unknown,Row[]>>>();
  const grouped=(rows:Row[],key:string,value:unknown)=>{
    let keys=rowIndexes.get(rows);if(!keys){keys=new Map();rowIndexes.set(rows,keys);}
    let index=keys.get(key);if(!index){index=new Map();for(const row of rows){const bucket=index.get(row[key])??[];bucket.push(row);index.set(row[key],bucket);}keys.set(key,index);}
    return (index.get(value)??[]).slice();
  };
  const fieldsByOwner=new Map<string,typeof fields>();
  for(const field of fields){const owned=fieldsByOwner.get(field.owner)??[];owned.push(field);fieldsByOwner.set(field.owner,owned);}
  const results:MasterSubject[]=[...unknownScope];
  for(const employment of employments){
    if(Date.now()-started>30_000)throw new Error('This report took too long. Narrow its companies/conditions before running it again.');
    const scopeDate=scopeDates.get(employment.id)!,companyId=proofs.get(employment.id+'|'+scopeDate)?.companyId??(scopeDate===today?await companyOnDate(tx,employment.id,scopeDate):null);if(!companyId||!spec.companyIds.includes(companyId))continue;
    const subject:MasterSubject={id:employment.id,kind:'employment',personId:employment.personId,companyId,owners:{}};
    const e=employment as unknown as Row;
    const own=(rows:Row[],key='employmentId')=>grouped(rows,key,employment.id);
    const personOwn=(rows:Row[])=>grouped(rows,'personId',employment.personId);
    const install=(owner:string,rows:Row[],overrides:(row:Row,index:number,all:Row[])=>Row=()=>({}))=>{
      if(!needed.has(owner))return;
      const ownerFields=fieldsByOwner.get(owner)??[];
      const scopedRows=rows.filter(row=>{
        if(!['assignment','compensation','payItem','cp38','shiftHistory','movement','movementComparison','leaveRecalc','leaveRequest','hireCorrection'].includes(owner))return true;
        const rawStart=date(row.validFrom??row.effectiveFrom??row.effectiveDate??row.startDate??row.changeEffectiveOn??row.effectiveOn),start=owner==='cp38'&&rawStart?.length===7?rawStart+'-01':rawStart;
        if(!start){if(spec.companyIds.includes(employment.companyId))subject.historyScopeUnavailable=true;return false;}
        const point=['movement','movementComparison','leaveRecalc','hireCorrection'].includes(owner);
        const exitSource=object(object(row.recordedExit).source);
        // The canonical termination effect closes its own exclusive company interval. Only that
        // recorded effect uses the subject's strictly proved last day for coverage; its date stays intact.
        const scopeStart=owner==='movement'&&exitSource.eventType==='employment.terminated'&&exitSource.role==='effect'&&start===employment.terminatedOn&&start<=spec.asAt?scopeDate:start;
        const rawEnd=date(row.reportEffectiveTo??row.validTo??row.endDate);
        const end=point?scopeStart:owner==='cp38'&&rawEnd?.length===7?new Date(new Date(nextMonth(rawEnd)!+'T00:00:00Z').getTime()-86_400_000).toISOString().slice(0,10):rawEnd&&['assignment','compensation','payItem'].includes(owner)?new Date(new Date(rawEnd+'T00:00:00Z').getTime()-86_400_000).toISOString().slice(0,10):rawEnd??spec.asAt;
        // Current open facts may use the recorded CURRENT employer; this never proves earlier history.
        if(!point&&spec.asAt===today&&spec.companyIds.includes(employment.companyId)&&start<=today&&end>=today)return true;
        const allowed=(companySegments.get(employment.id)??[]).some(segment=>segment.companyId!=null&&spec.companyIds.includes(segment.companyId)&&segment.from<=end&&segment.to>=scopeStart);
        if(!allowed&&spec.companyIds.includes(employment.companyId)&&(companySegments.get(employment.id)??[]).some(segment=>segment.companyId==null&&segment.from<=end&&segment.to>=scopeStart))subject.historyScopeUnavailable=true;
        return allowed;
      });
      subject.owners[owner]=scopedRows.map((row,index,all)=>{
        const merged={...row,...overrides(row,index,all)},values:Record<string,MasterCell>={};
        for(const field of ownerFields){
          const childCell=personnelChildReliefCell(field);
          const cell=childCell?personnelChildReliefValue(merged.childReliefTable,childCell):merged[field.ownerField];
          let result=cell&&typeof cell==='object'&&'value' in cell?cell as MasterCell:scalar(cell);
          if(['number','currency'].includes(field.type)&&result.value!=null&&(typeof result.value!=='number'&&typeof result.value!=='string'||!Number.isFinite(Number(result.value))))result={value:null,unavailable:'not-recorded'};
          const referenceKeys:Record<string,string>={companyName:'companyId',departmentName:'departmentId',businessUnitName:'businessUnitId',positionName:'positionId',gradeName:'gradeId',locationName:'locationId',leaveTypeName:'leaveTypeId',componentName:'componentId'};
          const referenceKey=referenceKeys[field.ownerField];
          if(field.type==='date'&&field.unit==='instant'&&typeof result.value==='string')result={...result,display:new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kuala_Lumpur',dateStyle:'medium',timeStyle:'medium'}).format(new Date(result.value))+' MYT'};
          values[personnelReportValueKey(field)]={...result,...(!result.unavailable&&['choice','status'].includes(field.type)&&typeof result.value==='string'&&!result.referenceId?{display:result.value.replaceAll('_',' ').replace(/^./,value=>value.toUpperCase())}:{}),...(referenceKey&&merged[referenceKey]?{referenceId:text(merged[referenceKey])}:{}),...(field.type==='currency'?{currency:text(merged.currency)}:{}),...(field.unit?{unit:field.unit}:{}),...(spec.asAt!==today&&['companyName','departmentName','businessUnitName','positionName','gradeName','locationName','componentName','actorName','recordedByName','changedByName','reversedByName','managerName','fullName'].includes(field.ownerField)?{labelIsCurrent:true}:{})};
        }
        if(owner==='movementComparison')for(const field of ownerFields){
          const value=merged['before:'+field.ownerField];
          const cell=value&&typeof value==='object'&&'value' in value?value as MasterCell:scalar(value);
          values['before:'+field.ownerField]={...cell,...(field.type==='currency'?{currency:text(merged['before:currency'])}:{}),...(field.unit?{unit:field.unit}:{})};
        }
        return {id:String(merged.id??`${owner}:${employment.id}`),effectiveFrom:date(merged.validFrom??merged.effectiveFrom),effectiveTo:date(merged.reportEffectiveTo??merged.validTo??merged.effectiveTo),createdAt:text(merged.createdAt??merged.recordedAt),currency:text(merged.currency),values};
      });
    };
    const activeAssignment=own(assignments).filter(row=>String(row.validFrom)<=spec.asAt&&(!row.validTo||String(row.validTo)>spec.asAt)).sort((a,b)=>String(b.validFrom).localeCompare(String(a.validFrom))||String(b.id).localeCompare(String(a.id)))[0];
    install('employment',[e],row=>({companyName:refCell(0,companyId,'legalName'),gradeName:spec.asAt===today?refCell(4,employment.gradeId):{value:null,unavailable:'historical-unavailable'},employmentType:activeAssignment?.employmentType,groupService:duration(row.hiredOn,spec.asAt),companyService:duration(row.joinDate??row.hiredOn,spec.asAt),yearOfService:duration(row.joinDate??row.hiredOn,spec.asAt)}));
    install('employmentStatus',[{id:employment.id,validFrom:employment.hiredOn,status:deriveEmploymentStatus(employment,spec.asAt)}]);
    install('person',people.filter(row=>row.id===employment.personId),row=>({age:completedYearsAt(text(row.dateOfBirth),spec.asAt)}));
    install('assignment',own(assignments),row=>({companyName:refCell(0,row.companyId??companyId,'legalName'),businessUnitName:refCell(2,row.businessUnitId,'name'),departmentName:refCell(1,row.departmentId,'name'),positionName:refCell(3,row.positionId,'title'),gradeName:spec.asAt===today?refCell(4,employment.gradeId):{value:null,unavailable:'historical-unavailable'},locationCode:ref(5,row.locationId,'code'),locationName:ref(5,row.locationId),locationEffectiveFrom:row.validFrom}));
    const salaries=own(compensations).sort((a,b)=>String(a.validFrom).localeCompare(String(b.validFrom))||String(a.id).localeCompare(String(b.id)));
    install('compensation',salaries,(row,index,all)=>{
      const previous=index>0?all[index-1]:null,sameCurrency=typeof row.currency==='string'&&!!row.currency&&previous?.currency===row.currency;
      const difference=previous&&sameCurrency?(Math.round(Number(row.basicSalary)*100)-Math.round(Number(previous.basicSalary)*100))/100:null;
      return {previousSalary:previous?(sameCurrency?previous.basicSalary:{value:null,unavailable:'mixed-currency'}):null,incrementAmount:difference,incrementPercent:difference!=null&&Number(previous?.basicSalary)>0?Number((difference/Number(previous?.basicSalary)*100).toFixed(6)):null,status:String(row.validFrom)>spec.asAt?'future':row.validTo&&String(row.validTo)<=spec.asAt?'past':'active'};
    });
    install('dependent',personOwn(dependents),row=>({age:completedYearsAt(text(row.dateOfBirth),spec.asAt),countsTowardRelief:isChildReliefEligible(row as never,new Date(spec.asAt+'T00:00:00Z'))}));
    install('emergencyContact',personOwn(emergency));
    const lines=own(superiors,'subordinateEmploymentId');
    const lineValues=(row:Row)=>{const manager=relatedById.get(String(row.managerEmploymentId));return {employeeCode:manager?.employeeCode,fullName:manager?.fullName,managerName:manager?.fullName,managerEmployeeCode:manager?.employeeCode};};
    install('directSuperior',lines.filter(row=>row.lineType==='administrative'),lineValues);
    install('superiorHistory',lines.filter(row=>row.lineType==='administrative'),lineValues);
    install('delegation',lines.filter(row=>row.lineType==='delegate'),lineValues);
    const shiftPeriod=own(shiftHistory).filter(row=>String(row.validFrom)<=spec.asAt&&(!row.validTo||String(row.validTo)>=spec.asAt)).sort((a,b)=>String(b.validFrom).localeCompare(String(a.validFrom))||String(b.id).localeCompare(String(a.id)))[0];
    install('attendanceProfile',[e],row=>({shiftEffectiveFrom:shiftPeriod?.validFrom,shiftType:shiftPeriod?.shiftType??row.shiftType,holidayGroupName:ref(6,row.holidayGroupId)??row.workState,scheduleGroupName:ref(7,row.attendanceRuleId,'label')??ref(7,row.attendanceRuleId),backupShiftCode:ref(8,shiftPeriod?.shiftId??row.defaultShiftId,'code'),backupShiftName:ref(8,shiftPeriod?.shiftId??row.defaultShiftId)}));
    install('clockingLocation',clockLinks.filter(link=>link.employmentId===employment.id).map(link=>link.site as unknown as Row),row=>({clockingLocationCode:ref(5,row.locationId,'code'),clockingLocationName:row.name,clockingLocationAddress:row.address,geofenceRadiusM:row.radiusM,clockingLocationStatus:row.archivedAt?'inactive':'active'}));
    install('shiftHistory',own(shiftHistory).sort((a,b)=>String(a.validFrom).localeCompare(String(b.validFrom))||String(a.id).localeCompare(String(b.id))),(row,index,all)=>({previousShiftCode:ref(8,all[index-1]?.shiftId,'code'),previousShiftName:ref(8,all[index-1]?.shiftId),newShiftCode:ref(8,row.shiftId,'code'),newShiftName:ref(8,row.shiftId),changedByName:actorName(row.createdBy),changedAt:row.createdAt,reportEffectiveTo:nextDay(row.validTo)}));
    install('payItem',own(payItems),row=>({componentName:ref(9,row.componentId),prorate:row.prorateOverride??ref(9,row.componentId,'prorates')}));
    install('cp38',own(cp38),row=>({reference:row.cp38Ref,monthlyAmount:row.amount,currency:'MYR',status:String(row.validFrom)>spec.asAt?'future':row.validTo&&String(row.validTo).slice(0,7)<spec.asAt.slice(0,7)?'ended':'active',reportEffectiveTo:nextMonth(row.validTo)}));
    install('payrollProfile',[e],row=>({payrollPolicyName:ref(10,row.payrollPolicyId)}));
    install('qualification',own(qualifications),row=>({level:row.qualification,highest:row.isHighest}));
    install('document',own(documents),row=>({createdByName:actorName(row.uploadedByUserId),updatedByName:actorName(row.updatedByUserId)}));
    install('leaveRecalc',own(recalc),row=>({effectiveFrom:row.changeEffectiveOn??row.effectiveOn,leaveTypeName:ref(11,row.leaveTypeId),previousGradeName:ref(4,row.previousGradeId),newGradeName:ref(4,row.newGradeId),previousDays:row.previousEntitlement,newDays:row.newEntitlement,changeDays:row.delta}));
    install('leaveRequest',own(leaveRequests),row=>({leaveTypeName:ref(11,row.leaveTypeId),effectiveFrom:row.startDate}));
    const reviewRows=own(reviews).flatMap(row=>{
      const files=reviewDocuments.filter(file=>file.reviewId===row.id);
      return (files.length?files:[null]).map(file=>({...row,id:String(row.id)+(file?':'+file.id:''),type:row.reviewType,employmentType:own(assignments).find(a=>String(a.validFrom)<=spec.asAt&&(!a.validTo||String(a.validTo)>spec.asAt))?.employmentType,documentKind:file?.kind,documentFileName:file?.fileName}));
    });
    install('review',reviewRows);
    const reliefNeeded=needed.has('childRelief')||needed.has('statutory')&&fields.some(field=>field.owner==='statutory'&&['qualifyingChildren','childReliefAmount'].includes(field.ownerField));
    const reliefCountry=text(ref(0,companyId,'country'));
    const childRelief=reliefNeeded&&reliefCountry?await qualifyingChildReliefFor(ctx,{personId:employment.personId,country:reliefCountry,asOf:spec.asAt},tx):null;
    if(['statutory','bank','declaredChildRelief','tp3','zakat'].some(owner=>needed.has(owner))){
      const country=text(ref(0,companyId,'country'));
      const statutory=country?await packFor(country)?.statutory.get(ctx,employment.personId,tx):null;
      const row=statutory as unknown as Row|undefined|null;
      if(row){
        const taxNeeded=fields.some(field=>field.owner==='statutory'&&['taxResidency','employerName','selectionConfirmationRequired'].includes(field.ownerField));
        const tax=taxNeeded&&country?await packFor(country)?.statutory.getTaxSelection?.(ctx,employment.id,undefined,{tx,readOnly:true}):null;
        install('statutory',[row],()=>({hrdfSubject:row.subjectToHrdf,qualifyingChildren:childRelief?.qualifyingChildren,childReliefAmount:childRelief?.reliefRM,currency:'MYR',...(taxNeeded?{taxResidency:tax?.transitionState==='resolved'?tax.scheme:{value:null,unavailable:'not-recorded'},employerName:tax?.companyName,selectionConfirmationRequired:tax?tax.transitionState==='confirmation_required':null}:{})}));install('bank',[row]);
        const grid=object(row.childReliefTable),declared:Row={id:employment.personId};
        const categories:Record<string,string>={under18:'under_18',preUniversity:'study_preu',tertiary:'study_tertiary',disabled:'disabled',disabledStudy:'disabled_study'};
        for(const [label,key]of Object.entries(categories))for(const share of ['full','half'])declared[label+(share==='full'?'Full':'Half')]=object(grid[key])[share]??null;
        install('declaredChildRelief',[declared]);
        install('tp3',[{id:employment.personId,year:row.tp3Year,netRemuneration:row.tp3NetRemuneration,epfClaimed:row.tp3EpfClaimed,pcbPaid:row.tp3PcbPaid,currency:'MYR'}]);
        install('zakat',[{id:employment.personId,status:row.zakatActive,stateAuthority:row.zakatState,method:row.zakatMethod,rate:row.zakatMethod==='fixed'?row.zakatFixed:row.zakatPercent,currency:row.zakatMethod==='fixed'?'MYR':null}]);
      }
    }
    if(childRelief)install('childRelief',childRelief.breakdown.map((row,index)=>({id:employment.personId+':relief:'+index,item:row.name??row.kind,category:row.category,share:row.sharePercent,qualifyingUnits:row.units,reliefAmount:row.amountRM,currency:'MYR'})));
    if(needed.has('encashment')){
      const snapshot=await encashmentSnapshotForEmploymentTx(tx,ctx,employment.id);
      if(snapshot)install('encashment',[snapshot as unknown as Row],row=>({rawBalance:row.balanceDays,autoDays:row.encashableDays,effectiveDays:row.days,asOf:row.calculatedAsOf,adjustedDays:row.overrideDays,reason:row.overrideReason}));
    }
    if(needed.has('benefitScheme')){
      const view=await benefitSchemeViewTx(tx,ctx,employment.id,spec.asAt);
      install('benefitScheme',view.perType.map(type=>({id:type.leaveTypeId,gradeName:ref(4,employment.gradeId),schemeName:view.schemeName,effectiveFrom:view.effectiveFrom,serviceYears:view.serviceYears,leaveTypeName:type.leaveTypeName,pickedUpBy:type.ruleName??type.templateName,days:type.daysAtService,unmatchedLeaveTypes:view.unmatched.map(type=>type.leaveTypeName).join(', ')})));
    }
    if(needed.has('leaveBalance')||needed.has('leaveEligibility')||needed.has('leaveFormula')){
      const balances=await leaveBalancesTx(tx,ctx,employment.id,undefined,{includeHidden:true,includeArchived:true,includeIneligible:true,asOf:spec.asAt});
      const balanceRows:Row[]=[],explanations:Row[]=[];
      for(const balance of balances){
        const breakdown=await leaveEntitlementBreakdownTx(tx,employment.id,balance.leaveTypeId,spec.asAt,undefined,{derivation:needed.has('leaveFormula')});
        if(!breakdown)continue;
        const raw=breakdown as unknown as Row;
        balanceRows.push({...raw,id:balance.leaveTypeId,leaveTypeName:breakdown.leaveType,asOf:spec.asAt,entitlement:breakdown.eligibleDays,earnedToDate:breakdown.currentYearEntitlement,roundedEarnedToDate:breakdown.currentYearEntitlementRounded,taken:breakdown.takenThisCycle,broughtForwardForfeited:breakdown.forfeitedThisCycle,expiryDate:breakdown.carryForwardExpiryDate,total:raw.totalEntitlement,availableBalance:raw.totalAvailable,entitlementTable:raw.entitlementTemplateName,sharedBalanceSource:object(object(balance).sharedBalance).sourceLeaveTypeName});
        const eligibility=object(raw.eligibility);
        const rules=Array.isArray(eligibility.rules)?eligibility.rules:[];
        for(const [index,rule]of rules.entries())explanations.push({...object(rule),id:balance.leaveTypeId+':rule:'+index,ruleName:object(rule).name,nonMatchReason:object(rule).failsOnCombination?'Criteria do not match the same assignment record':object(rule).failingAxisValue??object(rule).failingAxis});
        for(const [key,entry]of Object.entries(breakdown.formulaExplanations??{}))if(entry)explanations.push({...entry,explanation:entry.formula,id:balance.leaveTypeId+':formula:'+key,balanceLine:key});
      }
      install('leaveBalance',balanceRows);install('leaveEligibility',explanations.filter(row=>String(row.id).includes(':rule:')));install('leaveFormula',explanations.filter(row=>String(row.id).includes(':formula:')));
    }
    if(needed.has('hireCorrectionContext')){
      const view=await hireCorrectionViewTx(tx,ctx,employment.id),values:Row={id:employment.id};
      const names:Record<string,string>={businessUnitId:'businessUnitName',departmentId:'departmentName',positionId:'positionName',costCenterId:'costCenterName',locationId:'locationName',managerEmploymentId:'managerName'};
      for(const field of view.fields)if(names[field.field])values[names[field.field]]={value:field.currentLabel,referenceId:field.currentId};
      const managerId=view.fields.find(field=>field.field==='managerEmploymentId')?.currentId;
      if(managerId){const [manager]=await tx.select({code:schema.employment.employeeCode}).from(schema.employment).where(eq(schema.employment.id,managerId)).limit(1);values.managerEmployeeCode=manager?.code;}
      install('hireCorrectionContext',[values]);
    }
    if(needed.has('movement')||needed.has('movementComparison')||needed.has('hireCorrection')){
      const history=await movementHistoryTx(tx,ctx,employment.id);
      const movementRows:Row[]=[],comparisons:Row[]=[],corrections:Row[]=[];
      for(const movement of history){
        if(movement.effectiveDate>spec.asAt)continue;
        const detail=await movementDetailTx(tx,ctx,employment.id,movement.id);
        const exit=movement.recordedExit;
        const exitCell=(value:{known:boolean;value:string|number|null}|undefined):MasterCell=>value?.known?{value:value.value,...(exit?{recordedKind:exit.source.role}:{})}:{value:null,unavailable:'not-recorded',...(exit?{recordedKind:exit.source.role}:{})};
        movementRows.push({...movement,id:movement.id,effectiveFrom:movement.effectiveDate,recordedAt:detail?.occurredAt,recordedByName:detail?.actorName,jobTitle:movement.jobTitle,basicSalary:movement.basicAmount,currency:movement.currency,reversedByName:movement.reversed?.by,reversedAt:movement.reversed?.at,reversalReason:movement.reversed?.reason,
          terminationReasonCode:exitCell(exit?.terminationReasonCode),noticeServedDays:exitCell(exit?.terminationNoticeDays)});
        if(detail){
          const snapshot=(snap:typeof detail.after|null):Row=>snap?{companyName:snap.company,businessUnitName:snap.businessUnit,departmentName:snap.department,positionName:snap.position,gradeName:snap.grade,employmentType:snap.employmentType,managerName:snap.manager,basicSalary:snap.salaryAmount===undefined?{value:null,unavailable:'not-recorded'}:snap.salaryAmount,currency:snap.currency}:{};
          const after=snapshot(detail.after),before=snapshot(detail.before);
          for(const change of detail.flatChanges){after[change.field]=change.after;before[change.field]=change.before;}
          comparisons.push({id:movement.id,effectiveFrom:movement.effectiveDate,...after,...Object.fromEntries(Object.entries(before).map(([key,value])=>['before:'+key,value]))});
          const correction=object(detail.hireCorrection);
          const changes=Array.isArray(correction.fields)?correction.fields:Array.isArray(correction.changes)?correction.changes:[];
          for(const [index,change]of changes.entries())corrections.push({...object(change),id:movement.id+':'+index,effectiveFrom:movement.effectiveDate,originalValue:String(object(change).field??'').replace(/Id$/,'').replace(/([a-z])([A-Z])/g,'$1 $2')+': '+String(object(change).original??''),correctedValue:String(object(change).field??'').replace(/Id$/,'').replace(/([a-z])([A-Z])/g,'$1 $2')+': '+String(object(change).corrected??''),recordedByName:correction.by,recordedAt:correction.at,reason:correction.reason});
        }
      }
      install('movement',movementRows);install('movementComparison',comparisons);install('hireCorrection',corrections);
    }
    if(needed.has('audit')){
      const auditRows:Row[]=[];
      const allowedOwners=new Set(catalogue.map(field=>field.owner));
      const ownerForAggregate:Record<string,string>={person:'person',employment:'employment',compensation:'compensation','employee-dependent':'dependent','employee-document':'document','employee-qualification':'qualification'};
      for(const event of own(events,'subjectEmploymentId')){
        const eventOwner=ownerForAggregate[String(event.aggregateType)];if(eventOwner&&!allowedOwners.has(eventOwner))continue;
        const payload=object(event.payload),before=object(payload.before),after=object(payload.after);
        const changes=Array.isArray(payload.changes)?payload.changes:[];
        const values=changes.length?changes:Object.keys(after).map(key=>({field:key,before:before[key],after:after[key]}));
        for(const [index,value]of (values.length?values:[null]).entries()){
          const change=object(value),changedField=typeof change.field==='string'?change.field:null;
          const declared=changedField?catalogue.find(field=>field.owner===eventOwner&&field.ownerField===changedField):undefined;
          if(changedField&&!declared)continue;
          auditRows.push({id:String(event.id)+':'+index,eventType:event.eventType,action:String(event.eventType).split('.').pop(),actorType:event.actorType,actorName:actorName(event.actorId),module:eventOwner??event.aggregateType,aggregateType:event.aggregateType,occurredAt:event.occurredAt,createdAt:event.occurredAt,sequence:event.sequence,changedField:declared?.label,previousValue:declared?scalar(change.before):{value:null,unavailable:'not-recorded'},newValue:declared?scalar(change.after):{value:null,unavailable:'not-recorded'},highImpact:payload.highImpact});
        }
      }
      install('audit',auditRows);
    }
    results.push(subject);
  }
  if(spec.includeDrafts&&spec.asAt===today){
    const draftScope=options.includeWithoutCompany?or(inArray(schema.employeeDraft.companyId,spec.companyIds),isNull(schema.employeeDraft.companyId)):inArray(schema.employeeDraft.companyId,spec.companyIds);
    const drafts=await tx.select().from(schema.employeeDraft).where(draftScope).orderBy(asc(schema.employeeDraft.id)).limit(SUBJECT_LIMIT+1);
    if(drafts.length+results.length>SUBJECT_LIMIT)throw new Error('Too many employees/drafts. Narrow report conditions.');
    for(const draft of drafts){
      const data=draft.data as EmployeeDraftData,profile=withSameAsPermanent(data.profile),job=data.employment??{},pay=data.payroll??{},stat=data.statutory??{};
      const end=draftProvisionalEndOn(job).date;
      const sources:Record<string,Row[]>={
        person:[{...profile,age:completedYearsAt(profile.dateOfBirth??null,spec.asAt)}],
        employment:[{...job,employeeCode:draft.reservedEmployeeCode}],employmentStatus:[{status:'draft'}],
        assignment:[{...job,companyName:ref(0,draft.companyId,'legalName'),departmentName:ref(1,job.departmentId),positionName:ref(3,job.positionId,'title'),gradeName:ref(4,job.gradeId)}],
        statutory:[{...profile,...stat}],bank:[{...stat}],compensation:[{...pay}],payrollProfile:[{...pay}],
        dependent:draftFamily(data).map(member=>({...member,age:completedYearsAt(member.dateOfBirth??null,spec.asAt)})),
        draft:[{provisionalEndOn:end,sameAsPermanent:profile.sameAsPermanent,costCenterId:job.costCenterId,internshipEndDate:job.employmentType==='intern'?end:null,probationEndDate:job.employmentType==='full_time'?end:null,monthlyAllowance:pay.monthlyAllowance}],
      };
      const subject:MasterSubject={id:draft.id,kind:'draft',personId:null,companyId:draft.companyId,owners:{}};
      for(const owner of needed){
        const ownerFields=fieldsByOwner.get(owner)??[];
        subject.owners[owner]=(sources[owner]??[{}]).map((row,index)=>{
          const values:Record<string,MasterCell>={};
          for(const field of ownerFields){
            const childCell=personnelChildReliefCell(field);
            let raw=childCell?personnelChildReliefValue(row.childReliefTable,childCell):row[field.ownerField];
            if(raw!=null&&raw!==''){
              if(field.type==='boolean')raw=raw==='yes'?true:raw==='no'?false:raw;
              if(['number','currency'].includes(field.type)&&typeof raw==='string')raw=/^-?\d+(?:\.\d+)?$/.test(raw)?Number(raw):{value:null,unavailable:'draft-unfinished'};
            }
            values[personnelReportValueKey(field)]=raw==null||raw===''?{value:null,unavailable:'draft-unfinished'}:raw&&typeof raw==='object'&&'value' in raw?raw as MasterCell:scalar(raw);
            if(field.type==='currency')values[personnelReportValueKey(field)].currency=text(row.currency);
          }
          // A draft owns its own identities; no employment/person ID is manufactured.
          return {id:draft.id+':'+owner+':'+index,createdAt:draft.createdAt.toISOString(),values};
        });
      }
      results.push(subject);
    }
  }
  return results;
}
