/** Shared New Event fields: form, import template and server admission consume one contract. */
import {isComparisonKind} from '../core/movement-kinds';
import {personnelFormRequired} from './personnel-form-contract';
export const MOVEMENT_FORM_IDS = {
  "companyId": "employment.organisation_assignment.companyname",
  "businessUnitId": "employment.organisation_assignment.businessunitname",
  "departmentId": "employment.organisation_assignment.departmentname",
  "positionId": "employment.organisation_assignment.positionname",
  "gradeId": "employment.organisation_assignment.gradename",
  "employmentType": "employment.organisation_assignment.employmenttype",
  "locationId": "attendance.work_location_and_shift_arrangement.locationid",
  "managerEmploymentId": "employment.direct_superior_and_history.superioremploymentid",
  "basicSalary": "payroll.basic_salary_and_salary_history.basicsalary",
  "currency": "payroll.basic_salary_and_salary_history.currency",
  "payMode": "payroll.basic_salary_and_salary_history.paymode",
  "paymentTerm": "payroll.basic_salary_and_salary_history.paymentterm",
  "orgDivision": "employment.additional_organisation_labels.orgdivision",
  "employmentCategory": "employment.additional_organisation_labels.employmentcategory",
  "orgRegion": "employment.additional_organisation_labels.orgregion",
  "orgBranch": "employment.additional_organisation_labels.orgbranch",
  "orgTeam": "employment.additional_organisation_labels.orgteam",
  "orgSection": "employment.additional_organisation_labels.orgsection",
  "orgLine": "employment.additional_organisation_labels.orgline",
  "orgBase": "employment.additional_organisation_labels.orgbase",
  "kind": "employment_history.event_information.kind",
  "effectiveDate": "employment_history.event_information.effectivefrom",
  "endDate": "employment_history.event_information.enddate",
  "terminationReasonCode": "employment_history.event_information.terminationreasoncode",
  "tenderResignationDate": "employment_history.event_information.tenderresignationdate",
  "resignationEffectiveDate": "employment_history.event_information.resignationeffectivedate",
  "resignationDate": "employment_history.event_information.resignationdate",
  "terminationNoticeDays": "employment_history.event_information.noticeserveddays",
  "blacklisted": "employment_history.event_information.blacklisted",
  "remarks": "employment_history.event_information.remarks",
  "reason": "employment_history.event_information.correctionreason"
} as const;

export type MovementFormField=Exclude<keyof typeof MOVEMENT_FORM_IDS,'reason'>;
/** Only inputs rendered by New Event may be supplied for that resolved behaviour. */
export function movementFormFields(behaviour:string,reason?:string):MovementFormField[]{
 const fields:MovementFormField[]=['kind','remarks'];
 if(behaviour!=='blacklist')fields.push('effectiveDate');
 if(isComparisonKind(behaviour))fields.push(...(['businessUnitId','departmentId','positionId','gradeId','employmentType','locationId','managerEmploymentId','basicSalary','currency','payMode','paymentTerm','orgDivision','employmentCategory','orgRegion','orgBranch','orgTeam','orgSection','orgLine','orgBase'] as const));
 if(behaviour==='entityTransfer')fields.push('companyId');
 if(['probationExtension','secondment','actingPosition','resignation','termination'].includes(behaviour))fields.push('endDate');
 if(behaviour==='resignation')fields.push('tenderResignationDate','resignationEffectiveDate');
 if(behaviour==='termination'){
  fields.push('terminationReasonCode','terminationNoticeDays');
  if(reason==='resignation')fields.push('resignationDate');
 }
 if(behaviour==='blacklist')fields.push('blacklisted');
 return fields;
}
export function movementFormRequired(field:MovementFormField,behaviour:string):boolean{
 if(field==='kind')return true;
 const id=behaviour==='termination'&&field==='endDate'?'employment_history.event_information.lastworkingdate':MOVEMENT_FORM_IDS[field];
 return personnelFormRequired(id,'record',{movementEndDate:behaviour==='probationExtension'||behaviour==='termination'});
}
