/** Client-safe transport for the information-only employment facts. 2260a06b adds the two type end dates. */
export const INFORMATION_FIELDS=['companyId','hiredOn','joinDate','gradeId','employmentType','contractEndDate','internshipEndDate'] as const;
/** The end date each Employment Type keeps; the other date does not apply to that type. */
export const INFORMATION_END_DATE_FOR_TYPE={contract:'contractEndDate',intern:'internshipEndDate'} as const;
export type InformationField=typeof INFORMATION_FIELDS[number];
export const INFORMATION_FIELD_IDS={"companyId":"employment.organisation_assignment.companyname","hiredOn":"employment.employment_dates_and_service.hiredon","joinDate":"employment.employment_dates_and_service.joindate","gradeId":"employment.organisation_assignment.gradename","employmentType":"employment.organisation_assignment.employmenttype","contractEndDate":"employment.employment_dates_and_service.contractenddate","internshipEndDate":"employment.draft_only_employment_fields.internshipenddate"} as const;
export type InformationValues=Record<InformationField,string|null>;
export type InformationChanges=Partial<Record<InformationField,string>>;
export type InformationPreview={effectiveOn:string;employmentId:string;employeeCode:string;name:string;fingerprint:string;before:InformationValues;after:InformationValues;beforeLabels:InformationValues;afterLabels:InformationValues;reason:string;changed:InformationField[]};
export type InformationOptions={companies:{id:string;code:string;name:string}[];grades:{id:string;code:string;name:string}[];employmentTypes:string[]};
export const INFORMATION_HEADERS=['Company Code','Employee ID','Employee Name','New Company Code','Group Join Date','Join Date','Job Grade','Employment Type','Contract End Date','Internship End Date','Correction Reason'] as const;
export type InformationImportRow={row:number;companyCode:string;employeeCode:string;values:Partial<Record<typeof INFORMATION_HEADERS[number],string>>;errors:string[];warnings?:string[];ignoredOrganisation?:{businessUnit?:string;parentCompany?:string};preview?:InformationPreview};
export type InformationImportPlan={version:1;previewHash:string;counts:{total:number;valid:number;invalid:number};issues:{rowNum:number;reason:string}[];rows:InformationImportRow[]};
export type InformationImportResult={attemptId:string;succeeded:number;failed:number;unchanged:number;rows:{row:number;status:'applied'|'failed'|'unchanged';errors:string[]}[]};
