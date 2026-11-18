/** Binding identities are distinct from money arithmetic and approval authority. Old consumers keep
 * the assignment contract; the policy adapter must bind its real revision and dated part separately. */
import {ATTENDANCE_POLICY_DAY_CLASSES,type AttendancePolicyDayClass} from './attendance-group-policy';
import {overtimeDate,overtimeInteger,overtimeKeys,overtimeObject,overtimeRefuse,overtimeUuid} from './overtime-pattern-schema';
export type OvertimeAssignmentBinding={assignmentId:string;policyBinding?:never};
export type OvertimePolicyBinding={assignmentId:null;policyBinding:{
  kind:'attendanceGroupPolicy';revisionId:string;dayClass:AttendancePolicyDayClass;calendarDate:string;dayOffset:0|1|2;
}};
export type OvertimeBinding=OvertimeAssignmentBinding|OvertimePolicyBinding;
export type OvertimeBindingAdapter<B extends OvertimeBinding>={
  keys:string[];read:(raw:Record<string,unknown>,sourceDate:string)=>B;fallback:()=>B;
};
const zero='00000000-0000-0000-0000-000000000000';
export const overtimeAssignmentBinding:OvertimeBindingAdapter<OvertimeAssignmentBinding>={
  keys:[],fallback:()=>({assignmentId:zero}),
  read(raw){
    if(Object.hasOwn(raw,'policyBinding'))overtimeRefuse('source','policyBinding','An assignment calculation cannot assert a policy binding.');
    return {assignmentId:overtimeUuid(raw.assignmentId,'assignmentId')};
  },
};
export const overtimePolicyBinding:OvertimeBindingAdapter<OvertimePolicyBinding>={
  keys:['policyBinding'],fallback:()=>({assignmentId:null,policyBinding:{kind:'attendanceGroupPolicy',revisionId:zero,dayClass:'normal',calendarDate:'1970-01-01',dayOffset:0}}),
  read(raw,sourceDate){
    if(raw.assignmentId!==null)overtimeRefuse('source','assignmentId','A policy part is not a central-pattern assignment.');
    const value=overtimeObject(raw.policyBinding,'policyBinding');
    overtimeKeys(value,['kind','revisionId','dayClass','calendarDate','dayOffset'],'policyBinding');
    if(value.kind!=='attendanceGroupPolicy'||!ATTENDANCE_POLICY_DAY_CLASSES.includes(value.dayClass as AttendancePolicyDayClass))
      overtimeRefuse('source','policyBinding','Provide the exact policy revision and day classification.');
    const dayOffset=overtimeInteger(value.dayOffset,0,2,'policyBinding.dayOffset') as 0|1|2;
    const calendarDate=overtimeDate(value.calendarDate,'policyBinding.calendarDate');
    overtimeDate(sourceDate,'source.date');
    if(new Date(Date.parse(sourceDate+'T00:00:00Z')+dayOffset*86400000).toISOString().slice(0,10)!==calendarDate)
      overtimeRefuse('source','policyBinding.calendarDate','The dated part must belong to its parent source timeline.');
    return {assignmentId:null,policyBinding:{kind:'attendanceGroupPolicy',revisionId:overtimeUuid(value.revisionId,'policyBinding.revisionId'),
      dayClass:value.dayClass as AttendancePolicyDayClass,calendarDate,dayOffset}};
  },
};
