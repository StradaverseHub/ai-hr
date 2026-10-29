/** Client-safe transport for the five information-only employment facts. */
export const INFORMATION_FIELDS=['companyId','hiredOn','joinDate','gradeId','employmentType'] as const;
export type InformationField=typeof INFORMATION_FIELDS[number];
export const INFORMATION_FIELD_IDS={"companyId":"employment.organisation_assignment.companyname","hiredOn":"employment.employment_dates_and_service.hiredon","joinDate":"employment.employment_dates_and_service.joindate","gradeId":"employment.organisation_assignment.gradename","employmentType":"employment.organisation_assignment.employmenttype"} as const;
export type InformationValues=Record<InformationField,string|null>;
export type InformationChanges=Partial<Record<InformationField,string>>;
export type InformationPreview={effectiveOn:string;employmentId:string;employeeCode:string;name:string;fingerprint:string;before:InformationValues;after:InformationValues;beforeLabels:InformationValues;afterLabels:InformationValues;reason:string;changed:InformationField[]};
export type InformationOptions={companies:{id:string;code:string;name:string}[];grades:{id:string;code:string;name:string}[];employmentTypes:string[]};
export const INFORMATION_HEADERS=['Company Code','Employee ID','Employee Name','New Company Code','Group Join Date','Join Date','Job Grade','Employment Type','Correction Reason'] as const;
export type InformationImportRow={row:number;companyCode:string;employeeCode:string;values:Partial<Record<typeof INFORMATION_HEADERS[number],string>>;errors:string[];preview?:InformationPreview};
export type InformationImportPlan={version:1;previewHash:string;counts:{total:number;valid:number;invalid:number};issues:{rowNum:number;reason:string}[];rows:InformationImportRow[]};
export type InformationImportResult={attemptId:string;succeeded:number;failed:number;unchanged:number;rows:{row:number;status:'applied'|'failed'|'unchanged';errors:string[]}[]};
