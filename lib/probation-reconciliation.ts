/** Stable adjudication codes. They carry no names, addresses or raw database errors. */
export const PROBATION_INTAKE_REASONS = ['settings','form','route','activation','grade_missing','grade_ineligible','assignment','employment_type','no_probation','period_review','eligibility_review','excluded','cutover','prior_case','retry'] as const;
export type ProbationIntakeReason = typeof PROBATION_INTAKE_REASONS[number];
export type ProbationPersonnelDiscrepancy = {
 employmentId:string;employeeName:string;employeeCode:string|null;companyId:string;companyName:string;
 grade:string;reasons:ProbationIntakeReason[];missingBusinessUnit:boolean;
};
export type ProbationReconciliationView = {
 rows:ProbationPersonnelDiscrepancy[];total:number;offset:number;limit:number;
 lastSuccessfulCheck:string|null;checkStale:boolean;
};
export function probationBusinessUnitMissing(facts:{organisationMapping?:string;businessGroupId:string|null;businessUnitId:string|null}):boolean{
 return (facts.organisationMapping==='personnel-v2'?facts.businessGroupId:facts.businessUnitId)==null;
}
export const probationReasonPage = (reason:ProbationIntakeReason,employmentId:string):string => {
 if(reason==='settings'||reason==='grade_ineligible')return '/lifecycle/probation/settings';
 if(reason==='form')return '/lifecycle/probation/forms';
 if(reason==='route')return '/lifecycle/probation/routes';
 if(['grade_missing','assignment','employment_type','no_probation'].includes(reason))return '/admin/personnel/'+employmentId;
 return '/lifecycle/probation/intake';
};
