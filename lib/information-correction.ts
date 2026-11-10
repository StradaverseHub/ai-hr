/** Client-safe transport for the five information-only employment facts. */
export const INFORMATION_FIELDS=['companyId','hiredOn','joinDate','gradeId','employmentType'] as const;
/** ccd3a65c (ADR-0163 amendment) — further employment details the Excel correction template corrects. Each is
 * written through its owning writer, untagged, so no movement event is added: the dated assignment (Business
 * Unit, Department, Position), setEmploymentInfo (labels, periods, Confirmation Date) and setReportingLine
 * (Direct Superior). Names match those owners so rollback protection matches by field name. */
export const INFORMATION_ASSIGNMENT_FIELDS=['businessUnitId','departmentId','positionId'] as const;
export const INFORMATION_LABEL_FIELDS=['orgDivision','orgBranch','orgRegion','orgLine','orgSection','orgTeam','orgBase','employmentCategory'] as const;
export const INFORMATION_PERIOD_FIELDS=['probationValue','probationUnit','extendedProbationValue','extendedProbationUnit','confirmationDate','noticeBeforeConfirmationValue','noticeBeforeConfirmationUnit','noticeAfterConfirmationValue','noticeAfterConfirmationUnit'] as const;
export const INFORMATION_REPORTING_FIELDS=['managerEmploymentId'] as const;
export const INFORMATION_EXTENDED_FIELDS=[...INFORMATION_ASSIGNMENT_FIELDS,...INFORMATION_LABEL_FIELDS,...INFORMATION_PERIOD_FIELDS,...INFORMATION_REPORTING_FIELDS] as const;
export const INFORMATION_ALL_FIELDS=[...INFORMATION_FIELDS,...INFORMATION_EXTENDED_FIELDS] as const;
export type InformationField=typeof INFORMATION_ALL_FIELDS[number];
export type InformationCoreField=typeof INFORMATION_FIELDS[number];
export const INFORMATION_FIELD_IDS={"companyId":"employment.organisation_assignment.companyname","hiredOn":"employment.employment_dates_and_service.hiredon","joinDate":"employment.employment_dates_and_service.joindate","gradeId":"employment.organisation_assignment.gradename","employmentType":"employment.organisation_assignment.employmenttype"} as const;
/** The period value/unit pairs of the template. A value without its unit (or the reverse) is refused. */
export const INFORMATION_PERIOD_PAIRS=[['probationValue','probationUnit'],['extendedProbationValue','extendedProbationUnit'],['noticeBeforeConfirmationValue','noticeBeforeConfirmationUnit'],['noticeAfterConfirmationValue','noticeAfterConfirmationUnit']] as const;
/** Fields whose correction changes what leave processing reads (core/leave.ts and core/org-criteria.ts: service
 * dates, company, grade, employment type, organisation dimensions and labels, the probation threshold). Notice
 * periods, probation lengths and the Direct Superior are not read by leave processing. */
export const INFORMATION_LEAVE_FIELDS=['companyId','hiredOn','joinDate','gradeId','employmentType',...INFORMATION_ASSIGNMENT_FIELDS,...INFORMATION_LABEL_FIELDS,'confirmationDate'] as const satisfies readonly InformationField[];
export type InformationValues=Record<InformationField,string|null>;
export type InformationChanges=Partial<Record<InformationField,string>>;
export type InformationPreview={effectiveOn:string;employmentId:string;employeeCode:string;name:string;fingerprint:string;before:InformationValues;after:InformationValues;beforeLabels:InformationValues;afterLabels:InformationValues;reason:string;changed:InformationField[]};
export type InformationOptions={companies:{id:string;code:string;name:string}[];grades:{id:string;code:string;name:string}[];employmentTypes:string[];organisation?:{companyId:string;companyCode:string;kind:'department'|'position'|'business_unit';id:string;code:string;name:string}[];labels?:{field:typeof INFORMATION_LABEL_FIELDS[number];value:string;label:string}[]};
/** Version 1 (five facts) stays readable so an old file's ignored Business Unit never starts writing. */
export const INFORMATION_HEADERS=['Company Code','Employee ID','Employee Name','New Company Code','Group Join Date','Join Date','Job Grade','Employment Type','Correction Reason'] as const;
/** Version 2 Corrections sheet (ccd3a65c), detected by its exact header row. */
export const INFORMATION_HEADERS_V2=['Company Code','Employee ID','Employee Name','New Company Code','Group Join Date','Join Date','Job Grade','Employment Type','Business Unit','Department','Position','Division','Branch','Region','Line','Section','Team','Base','Category','Probation Period','Probation Period Unit','Extended Probation Period','Extended Probation Period Unit','Confirmation Date','Notice Before Confirmation','Notice Before Confirmation Unit','Notice After Confirmation','Notice After Confirmation Unit','Direct Superior','Correction Reason'] as const;
export type InformationHeader=typeof INFORMATION_HEADERS_V2[number];
/** The template column that carries each field; row errors name these captions. */
export const INFORMATION_FIELD_CAPTIONS:Record<InformationField,InformationHeader>={companyId:'New Company Code',hiredOn:'Group Join Date',joinDate:'Join Date',gradeId:'Job Grade',employmentType:'Employment Type',businessUnitId:'Business Unit',departmentId:'Department',positionId:'Position',orgDivision:'Division',orgBranch:'Branch',orgRegion:'Region',orgLine:'Line',orgSection:'Section',orgTeam:'Team',orgBase:'Base',employmentCategory:'Category',probationValue:'Probation Period',probationUnit:'Probation Period Unit',extendedProbationValue:'Extended Probation Period',extendedProbationUnit:'Extended Probation Period Unit',confirmationDate:'Confirmation Date',noticeBeforeConfirmationValue:'Notice Before Confirmation',noticeBeforeConfirmationUnit:'Notice Before Confirmation Unit',noticeAfterConfirmationValue:'Notice After Confirmation',noticeAfterConfirmationUnit:'Notice After Confirmation Unit',managerEmploymentId:'Direct Superior'};
export type InformationImportRow={row:number;companyCode:string;employeeCode:string;values:Partial<Record<InformationHeader,string>>;errors:string[];warnings?:string[];ignoredOrganisation?:{businessUnit?:string;parentCompany?:string};preview?:InformationPreview};
export type InformationImportPlan={version:1;templateVersion?:1|2;previewHash:string;counts:{total:number;valid:number;invalid:number};issues:{rowNum:number;reason:string}[];rows:InformationImportRow[]};
export type InformationImportResult={attemptId:string;succeeded:number;failed:number;unchanged:number;rows:{row:number;status:'applied'|'failed'|'unchanged';errors:string[]}[]};
/** ccd3a65c — one row of the Import Log of an Information-Only Correction file. */
export type InformationLogRow={row:number;employeeCode:string;name:string|null;result:'saved'|'unchanged'|'not_saved'|'not_confirmed';changes:{field:InformationField;before:string|null;after:string|null}[];reason:string|null;errors:string[]};
