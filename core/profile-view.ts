/** Own-only safe projections over canonical owners. No administrator row crosses this boundary. */
import {projectEssVisible,essFactVisible} from '../lib/personnel-ess-visibility';
import {freshProfileEditPolicyTx,type ProfilePresentationPolicy} from './profile-edit-policy';
import {eq} from 'drizzle-orm';
import {attendanceRule,shift} from '../db/schema';
import type {SessionContext} from '../db/client';
import {withTenant} from '../db/client';
import {myOwnEmploymentSubjects,employeeDetail,assignmentHistory,ownReportingManagersTx,leaveRequestsFor} from './read';
import {compensationHistoryDetailed} from './comp';
import {movementHistory,movementDetail} from './movement';
import {listAllProfileOptions} from './profile-options';
import {listEmploymentPayComponents,listCp38} from '../packs/payroll/service';
import {shiftArrangementHistory,scheduleGroupLookupTx,scheduleGroupDisplayName} from '../packs/attendance/service';
import {leaveBalancesTx,leaveEntitlementBreakdownTx,benefitSchemeViewTx,serviceYearsMonthsDaysAt} from '../packs/leave/service';
import {isModuleEnabled} from './entitlements';
import {todayInKualaLumpur} from '../lib/hr-date';
import {PERSONNEL_FIELDS} from '../lib/personnel-field-registry';
import {EssProfileError,type EssScalar} from '../lib/personnel-ess-model';
import {hasPersonPhoto} from './person-photo';
export type EssReadRecord={key:string;tab:string;section:string;context?:'before'|'after';date?:string;detailId?:string;values:Record<string,EssScalar>};
function project(owner:string,row:Record<string,unknown>){
 const values:Record<string,EssScalar>={};
 for(const field of PERSONNEL_FIELDS){
  if(field.ess.visibility!=='visible'||field.owner!==owner||!(field.ownerField in row)||field.childReliefCell)continue;
  const value=row[field.ownerField];
  if(value!==null&&typeof value!=='string'&&typeof value!=='number'&&typeof value!=='boolean')continue;
  values[field.id]=field.ess.masked&&typeof value==='string'&&value?`•••• ${value.slice(-4)}`:value;
 }
 return values;
}
export async function readOwnProfileFacts(ctx:SessionContext,employmentId:string,presentation?:ProfilePresentationPolicy){
 const subjects=await myOwnEmploymentSubjects(ctx);const subject=subjects.find(row=>row.employmentId===employmentId);if(!subject)throw new EssProfileError('permission');
 const policy=presentation??await withTenant(ctx,tx=>freshProfileEditPolicyTx(tx,ctx));ctx=policy.ctx;const visible=policy.visible;
 const payrollOn=isModuleEnabled(ctx,'payroll'),leaveOn=isModuleEnabled(ctx,'leave'),attendanceOn=isModuleEnabled(ctx,'attendance');
 const today=todayInKualaLumpur();
 const [emp,assignments,salaries,lines,movements,catalog,photo,payItems,cp38,shifts,leave,requests]=await Promise.all([
  employeeDetail(ctx,employmentId),assignmentHistory(ctx,employmentId),compensationHistoryDetailed(ctx,employmentId),withTenant(ctx,tx=>ownReportingManagersTx(tx,employmentId)),movementHistory(ctx,employmentId),
  listAllProfileOptions(ctx,{activeOnly:true}),hasPersonPhoto(ctx,subject.personId),
  payrollOn?listEmploymentPayComponents(ctx,employmentId):[],payrollOn?listCp38(ctx,{employmentId}):[],attendanceOn?shiftArrangementHistory(ctx,employmentId):[],
  leaveOn?withTenant(ctx,async tx=>{
   const balances=await leaveBalancesTx(tx,ctx,employmentId,undefined,{asOf:today});
   const breakdowns=await Promise.all(balances.map(row=>leaveEntitlementBreakdownTx(tx,employmentId,row.leaveTypeId,today,undefined,{})));
   return {balances,breakdowns,scheme:await benefitSchemeViewTx(tx,ctx,employmentId,today)};
  }):null,
  leaveOn?leaveRequestsFor(ctx,employmentId):[],
 ]);
 if(!emp)throw new EssProfileError('unavailable');
 const applicable=assignments.filter(row=>row.validFrom<=today&&(!row.validTo||row.validTo>today));
 const current=applicable.length===1?applicable[0]:null;
 const salaryRows=salaries.filter(row=>row.validFrom<=today&&(!row.validTo||row.validTo>today));const salary=salaryRows.length===1?salaryRows[0]:null;
 const managers=lines.filter(row=>row.lineType==='administrative');const manager=managers.length===1?managers[0]:null;
 const values={...project('employment',emp),...project('employmentStatus',{status:subject.status}),
  ...project('assignment',{companyName:subject.companyProof.companyId===subject.currentCompanyId?emp.company:null,businessUnitName:current?.businessUnit??null,departmentName:current?.department??null,positionName:current?.position??null,gradeName:emp.gradeName,employmentType:current?.employmentType??null,locationCode:current?.locationCode??null,locationName:current?.locationName??null,locationEffectiveFrom:current?.locationEffectiveFrom??null}),
  ...project('directSuperior',{employeeCode:manager?.employeeCode??null,fullName:manager?.name??null}),
  ...project('attendanceProfile',{holidayGroupName:emp.holidayGroupName,attendancePhotoSetting:emp.attendancePhotoSetting,shiftType:emp.shiftType}),
  ...project('compensation',salary?{validFrom:salary.validFrom,basicSalary:salary.basicSalary,currency:salary.currency,payMode:salary.payMode,paymentTerm:salary.paymentTerm,rateAmount:salary.rateAmount}:{}),
  ...project('payrollProfile',{paymentMethod:emp.paymentMethod,payrollPolicyName:emp.payrollPolicyName})};
 const records:EssReadRecord[]=[];
 const add=(owner:string,key:string,row:Record<string,unknown>)=>{
  const fields=PERSONNEL_FIELDS.filter(field=>field.owner===owner&&field.ess.visibility==='visible');
  if(!fields.length)return;const record:EssReadRecord={key,tab:fields[0].tab,section:fields[0].section,values:project(owner,row)};records.push(record);return record;
 };
 for(const row of movements){const record=add('movement',row.id,{kind:row.kind,effectiveFrom:row.effectiveDate,endDate:row.endDate,status:row.status,jobTitle:row.jobTitle});if(record)record.detailId=row.id;}
 for(const row of payItems)add('payItem',row.id,{componentName:row.name,amount:row.amount,currency:row.currency,validFrom:row.validFrom,validTo:row.validTo,prorate:row.prorateOverride??row.prorates});
 for(const row of cp38.filter(row=>!row.supersededAt))add('cp38',row.id,{reference:row.cp38Ref,monthlyAmount:row.amount,validFrom:row.validFrom,validTo:row.validTo,status:row.validTo&&row.validTo.slice(0,7)<today.slice(0,7)?'closed':'active'});
 for(const row of shifts)add('shiftHistory',row.id,{previousShiftCode:row.previousShiftCode,previousShiftName:row.previousShiftName,newShiftCode:row.shiftCode,newShiftName:row.shiftName,changedAt:row.changedAt});
 if(leave){
  add('benefitScheme','benefitScheme',{gradeName:emp.gradeName,schemeName:leave.scheme.schemeName,effectiveFrom:leave.scheme.effectiveFrom,serviceYears:leave.scheme.serviceYears,unmatchedLeaveTypes:leave.scheme.unmatched.filter(type=>leave.balances.some(balance=>balance.leaveTypeId===type.leaveTypeId)).map(type=>type.leaveTypeName).join(', ')});
  for(const row of requests)add('leaveRequest',row.id,{leaveTypeName:row.leaveType,startDate:row.startDate,endDate:row.endDate,days:row.days,status:row.status});
  for(const row of leave.balances){
   const breakdown=leave.breakdowns.find(item=>item?.leaveTypeId===row.leaveTypeId);
   const facts:Record<string,unknown>={leaveTypeName:row.leaveType,asOf:today,entitlementStatus:breakdown?.entitlementStatus,entitlementTable:breakdown?.entitlementTemplateName,sharedBalanceSource:row.sharedBalance?.sourceLeaveTypeName??null};
   if(breakdown){
    const show=breakdown.essView;
    if(show.eligible)facts.entitlement=breakdown.entitlement.displayEntitlementDays;
    if(show.ytdEntitled){facts.earnedToDate=breakdown.currentYearEntitlement;facts.roundedEarnedToDate=breakdown.currentYearEntitlementRounded;}
    if(show.broughtForward)facts.broughtForward=breakdown.broughtForward;
    if(show.adjustment)facts.adjustments=breakdown.adjustments;
    if(show.total)facts.total=breakdown.totalEntitlement;
    if(show.taken)facts.taken=breakdown.takenThisCycle;
    if(show.pendingApproval)facts.pendingApproval=breakdown.pendingApproval;
    if(show.forfeited){facts.broughtForwardForfeited=breakdown.forfeitedThisCycle;facts.expiryDate=breakdown.carryForwardExpiryDate;}
    if(show.available)facts.availableBalance=breakdown.totalAvailable;
   }
   add('leaveBalance',row.leaveTypeId,facts);
   const scheme=leave.scheme.perType.find(item=>item.leaveTypeId===row.leaveTypeId);
   if(scheme)add('benefitScheme',`scheme:${row.leaveTypeId}`,{leaveTypeName:scheme.leaveTypeName,pickedUpBy:scheme.ruleName??scheme.templateName,...(row.essView.eligible?{days:scheme.daysAtService}:{})});
  }
 }
 if(attendanceOn){
  const profile=await withTenant(ctx,async tx=>{
   const groupOn=await scheduleGroupLookupTx(tx,[employmentId],today,today),groupId=groupOn(employmentId,today);
   const [group]=groupId?await tx.select({name:attendanceRule.name,label:attendanceRule.label}).from(attendanceRule).where(eq(attendanceRule.id,groupId)).limit(1):[];
   const periods=shifts.filter(row=>row.effectiveFrom<=today&&(!row.effectiveTo||row.effectiveTo>=today));
   const current=periods.length===1?periods[0]:null;
   const [legacyShift]=!shifts.length&&emp.defaultShiftId?await tx.select({code:shift.code,name:shift.name}).from(shift).where(eq(shift.id,emp.defaultShiftId)).limit(1):[];
   return {scheduleGroupName:group?scheduleGroupDisplayName(group):null,backupShiftCode:current?.shiftCode??legacyShift?.code??null,backupShiftName:current?.shiftName??legacyShift?.name??null,shiftEffectiveFrom:current?.effectiveFrom??null};
  });Object.assign(values,project('attendanceProfile',profile));
 }
 const choices:Record<string,{value:string;label:string}[]>={};
 for(const field of PERSONNEL_FIELDS){
  if(field.ess.visibility!=='visible'||!field.allowedValuesOwner?.startsWith('profile_option:'))continue;
  const category=field.allowedValuesOwner.slice('profile_option:'.length);
  const options=Object.entries(catalog).find(([key])=>key===category)?.[1]??[];
  choices[field.id]=options.map(option=>({value:option.value,label:option.label}));
 }
 const may=(owner:string,field:string)=>essFactVisible(visible,owner,field);
 return {values:projectEssVisible(values,visible),records:records.map(row=>({...row,values:projectEssVisible(row.values,visible)})).filter(row=>Object.keys(row.values).length>0),choices:projectEssVisible(choices,visible),service:{group:may('employment','hiredOn')&&may('employment','groupService')?serviceYearsMonthsDaysAt(emp.hiredOn,today):null,company:may('employment','joinDate')&&may('employment','companyService')?serviceYearsMonthsDaysAt(emp.joinDate??emp.hiredOn,today):null},header:{name:may('person','fullName')?subject.personName:'',employeeCode:may('employment','employeeCode')?subject.employeeCode:null,company:may('assignment','companyName')?subject.company:null,department:may('assignment','departmentName')?current?.department??null:null,position:may('assignment','positionName')?current?.position??null:null,superior:may('directSuperior','fullName')?manager?.name??null:null,status:may('employmentStatus','status')?subject.status:null,photo:may('person','photo')&&photo,service:may('employment','hiredOn')?serviceYearsMonthsDaysAt(emp.hiredOn,today):null},modules:{payroll:payrollOn,leave:leaveOn,attendance:attendanceOn}};
}

/** One selected immutable history event, loaded on demand instead of replaying every event per page. */
export async function readOwnProfileMovementComparison(ctx:SessionContext,p:{employmentId:string;movementId:string}):Promise<EssReadRecord[]>{
 if(!(await myOwnEmploymentSubjects(ctx)).some(row=>row.employmentId===p.employmentId))throw new EssProfileError('permission');
 const policy=await withTenant(ctx,tx=>freshProfileEditPolicyTx(tx,ctx));ctx=policy.ctx;
 const detail=await movementDetail(ctx,p.employmentId,p.movementId);if(!detail)throw new EssProfileError('unavailable');
 return (['before','after'] as const).flatMap(side=>{
  const snapshot=detail[side];if(!snapshot)return [];
  const comparison={companyName:snapshot.company,businessUnitName:snapshot.businessUnit,departmentName:snapshot.department,positionName:snapshot.position,gradeName:snapshot.grade,employmentType:snapshot.employmentType,...Object.fromEntries(detail.flatChanges.map(change=>[change.field,change[side]]))};
  return [{key:`${p.movementId}:${side}`,tab:'Employment History',section:'Before Changes and After Changes',context:side,...(essFactVisible(policy.visible,'movement','effectiveFrom')?{date:detail.row.effectiveDate}:{}),values:projectEssVisible(project('movementComparison',comparison),policy.visible)}];
 });
}
