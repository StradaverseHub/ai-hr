/** Closed source adapters. Configuration may select these keys, never a table, column, SQL or code. */
import {PERSONNEL_FIELDS} from './personnel-field-registry';
import type {FormulaType} from './pay-formula-registry';
export const PAY_FORMULA_PERSONNEL_REGISTRY_VERSION='personnel-formula-fields-2';
export const PAY_FORMULA_PERSONNEL_PROVIDER_VERSION='personnel-period-sources-2';
export type PersonnelFormulaAdapter={key:string;fieldId:string;group:'profile'|'employee';type:FormulaType;adapter:'person'|'employment'|'statutory'|'company'|'assignment'|'derived';column:string;dateBasis:'current-only'|'effective-date'};
export const PAY_FORMULA_PERSONNEL_ADAPTERS:readonly PersonnelFormulaAdapter[] = [
  {
    "key": "profile.personal_details.salutation",
    "fieldId": "profile.personal_details.salutation",
    "group": "employee",
    "type": "string",
    "adapter": "person",
    "column": "salutation",
    "dateBasis": "current-only"
  },
  {
    "key": "profile.personal_details.fullname",
    "fieldId": "profile.personal_details.fullname",
    "group": "employee",
    "type": "string",
    "adapter": "person",
    "column": "full_name",
    "dateBasis": "current-only"
  },
  {
    "key": "profile.personal_details.firstname",
    "fieldId": "profile.personal_details.firstname",
    "group": "employee",
    "type": "string",
    "adapter": "person",
    "column": "first_name",
    "dateBasis": "current-only"
  },
  {
    "key": "profile.personal_details.lastname",
    "fieldId": "profile.personal_details.lastname",
    "group": "employee",
    "type": "string",
    "adapter": "person",
    "column": "last_name",
    "dateBasis": "current-only"
  },
  {
    "key": "profile.personal_details.preferredname",
    "fieldId": "profile.personal_details.preferredname",
    "group": "employee",
    "type": "string",
    "adapter": "person",
    "column": "preferred_name",
    "dateBasis": "current-only"
  },
  {
    "key": "profile.personal_details.religion",
    "fieldId": "profile.personal_details.religion",
    "group": "employee",
    "type": "string",
    "adapter": "person",
    "column": "religion",
    "dateBasis": "current-only"
  },
  {
    "key": "profile.personal_details.race",
    "fieldId": "profile.personal_details.race",
    "group": "employee",
    "type": "string",
    "adapter": "person",
    "column": "race",
    "dateBasis": "current-only"
  },
  {
    "key": "profile.personal_details.age",
    "fieldId": "profile.personal_details.age",
    "group": "employee",
    "type": "decimal",
    "adapter": "derived",
    "column": "age",
    "dateBasis": "current-only"
  },
  {
    "key": "profile.identity_and_passport.icnumber",
    "fieldId": "profile.identity_and_passport.icnumber",
    "group": "employee",
    "type": "string",
    "adapter": "statutory",
    "column": "ic_number",
    "dateBasis": "current-only"
  },
  {
    "key": "profile.identity_and_passport.oldicnumber",
    "fieldId": "profile.identity_and_passport.oldicnumber",
    "group": "employee",
    "type": "string",
    "adapter": "statutory",
    "column": "old_ic_number",
    "dateBasis": "current-only"
  },
  {
    "key": "profile.identity_and_passport.passportnumber",
    "fieldId": "profile.identity_and_passport.passportnumber",
    "group": "employee",
    "type": "string",
    "adapter": "statutory",
    "column": "passport_number",
    "dateBasis": "current-only"
  },
  {
    "key": "profile.identity_and_passport.passportissuedate",
    "fieldId": "profile.identity_and_passport.passportissuedate",
    "group": "employee",
    "type": "date",
    "adapter": "statutory",
    "column": "passport_issue_date",
    "dateBasis": "current-only"
  },
  {
    "key": "profile.identity_and_passport.passportexpirydate",
    "fieldId": "profile.identity_and_passport.passportexpirydate",
    "group": "employee",
    "type": "date",
    "adapter": "statutory",
    "column": "passport_expiry_date",
    "dateBasis": "current-only"
  },
  {
    "key": "profile.identity_and_passport.passportissuingcountry",
    "fieldId": "profile.identity_and_passport.passportissuingcountry",
    "group": "employee",
    "type": "string",
    "adapter": "statutory",
    "column": "passport_issuing_country",
    "dateBasis": "current-only"
  },
  {
    "key": "profile.identity_and_passport.passportissuingcountrycode",
    "fieldId": "profile.identity_and_passport.passportissuingcountrycode",
    "group": "employee",
    "type": "string",
    "adapter": "statutory",
    "column": "passport_issuing_country_code",
    "dateBasis": "current-only"
  },
  {
    "key": "profile.identity_and_passport.passportremark",
    "fieldId": "profile.identity_and_passport.passportremark",
    "group": "employee",
    "type": "string",
    "adapter": "statutory",
    "column": "passport_remark",
    "dateBasis": "current-only"
  },
  {
    "key": "profile.contact_and_permanent_address.primaryemail",
    "fieldId": "profile.contact_and_permanent_address.primaryemail",
    "group": "employee",
    "type": "string",
    "adapter": "person",
    "column": "primary_email",
    "dateBasis": "current-only"
  },
  {
    "key": "profile.contact_and_permanent_address.phone",
    "fieldId": "profile.contact_and_permanent_address.phone",
    "group": "employee",
    "type": "string",
    "adapter": "person",
    "column": "phone",
    "dateBasis": "current-only"
  },
  {
    "key": "profile.contact_and_permanent_address.homephone",
    "fieldId": "profile.contact_and_permanent_address.homephone",
    "group": "employee",
    "type": "string",
    "adapter": "person",
    "column": "home_phone",
    "dateBasis": "current-only"
  },
  {
    "key": "profile.contact_and_permanent_address.personalemail",
    "fieldId": "profile.contact_and_permanent_address.personalemail",
    "group": "employee",
    "type": "string",
    "adapter": "person",
    "column": "personal_email",
    "dateBasis": "current-only"
  },
  {
    "key": "profile.contact_and_permanent_address.permanentaddressline1",
    "fieldId": "profile.contact_and_permanent_address.permanentaddressline1",
    "group": "employee",
    "type": "string",
    "adapter": "person",
    "column": "permanent_address_line1",
    "dateBasis": "current-only"
  },
  {
    "key": "profile.contact_and_permanent_address.permanentaddressline2",
    "fieldId": "profile.contact_and_permanent_address.permanentaddressline2",
    "group": "employee",
    "type": "string",
    "adapter": "person",
    "column": "permanent_address_line2",
    "dateBasis": "current-only"
  },
  {
    "key": "profile.contact_and_permanent_address.permanentaddressline3",
    "fieldId": "profile.contact_and_permanent_address.permanentaddressline3",
    "group": "employee",
    "type": "string",
    "adapter": "person",
    "column": "permanent_address_line3",
    "dateBasis": "current-only"
  },
  {
    "key": "profile.contact_and_permanent_address.permanentpostcode",
    "fieldId": "profile.contact_and_permanent_address.permanentpostcode",
    "group": "employee",
    "type": "string",
    "adapter": "person",
    "column": "permanent_postcode",
    "dateBasis": "current-only"
  },
  {
    "key": "profile.contact_and_permanent_address.permanentcity",
    "fieldId": "profile.contact_and_permanent_address.permanentcity",
    "group": "employee",
    "type": "string",
    "adapter": "person",
    "column": "permanent_city",
    "dateBasis": "current-only"
  },
  {
    "key": "profile.contact_and_permanent_address.permanentstate",
    "fieldId": "profile.contact_and_permanent_address.permanentstate",
    "group": "employee",
    "type": "string",
    "adapter": "person",
    "column": "permanent_state",
    "dateBasis": "current-only"
  },
  {
    "key": "profile.contact_and_permanent_address.permanentcountry",
    "fieldId": "profile.contact_and_permanent_address.permanentcountry",
    "group": "employee",
    "type": "string",
    "adapter": "person",
    "column": "permanent_country",
    "dateBasis": "current-only"
  },
  {
    "key": "profile.correspondence_address.correspondenceaddressline1",
    "fieldId": "profile.correspondence_address.correspondenceaddressline1",
    "group": "employee",
    "type": "string",
    "adapter": "person",
    "column": "correspondence_address_line1",
    "dateBasis": "current-only"
  },
  {
    "key": "profile.correspondence_address.correspondenceaddressline2",
    "fieldId": "profile.correspondence_address.correspondenceaddressline2",
    "group": "employee",
    "type": "string",
    "adapter": "person",
    "column": "correspondence_address_line2",
    "dateBasis": "current-only"
  },
  {
    "key": "profile.correspondence_address.correspondenceaddressline3",
    "fieldId": "profile.correspondence_address.correspondenceaddressline3",
    "group": "employee",
    "type": "string",
    "adapter": "person",
    "column": "correspondence_address_line3",
    "dateBasis": "current-only"
  },
  {
    "key": "profile.correspondence_address.correspondencepostcode",
    "fieldId": "profile.correspondence_address.correspondencepostcode",
    "group": "employee",
    "type": "string",
    "adapter": "person",
    "column": "correspondence_postcode",
    "dateBasis": "current-only"
  },
  {
    "key": "profile.correspondence_address.correspondencecity",
    "fieldId": "profile.correspondence_address.correspondencecity",
    "group": "employee",
    "type": "string",
    "adapter": "person",
    "column": "correspondence_city",
    "dateBasis": "current-only"
  },
  {
    "key": "profile.correspondence_address.correspondencestate",
    "fieldId": "profile.correspondence_address.correspondencestate",
    "group": "employee",
    "type": "string",
    "adapter": "person",
    "column": "correspondence_state",
    "dateBasis": "current-only"
  },
  {
    "key": "profile.correspondence_address.correspondencecountry",
    "fieldId": "profile.correspondence_address.correspondencecountry",
    "group": "employee",
    "type": "string",
    "adapter": "person",
    "column": "correspondence_country",
    "dateBasis": "current-only"
  },
  {
    "key": "profile.correspondence_address.correspondencemobilephone",
    "fieldId": "profile.correspondence_address.correspondencemobilephone",
    "group": "employee",
    "type": "string",
    "adapter": "person",
    "column": "correspondence_mobile_phone",
    "dateBasis": "current-only"
  },
  {
    "key": "profile.correspondence_address.correspondencehomephone",
    "fieldId": "profile.correspondence_address.correspondencehomephone",
    "group": "employee",
    "type": "string",
    "adapter": "person",
    "column": "correspondence_home_phone",
    "dateBasis": "current-only"
  },
  {
    "key": "employment.additional_organisation_labels.orgdivision",
    "fieldId": "employment.additional_organisation_labels.orgdivision",
    "group": "profile",
    "type": "string",
    "adapter": "employment",
    "column": "org_division",
    "dateBasis": "current-only"
  },
  {
    "key": "employment.additional_organisation_labels.orgbranch",
    "fieldId": "employment.additional_organisation_labels.orgbranch",
    "group": "profile",
    "type": "string",
    "adapter": "employment",
    "column": "org_branch",
    "dateBasis": "current-only"
  },
  {
    "key": "employment.additional_organisation_labels.orgregion",
    "fieldId": "employment.additional_organisation_labels.orgregion",
    "group": "profile",
    "type": "string",
    "adapter": "employment",
    "column": "org_region",
    "dateBasis": "current-only"
  },
  {
    "key": "employment.additional_organisation_labels.orgline",
    "fieldId": "employment.additional_organisation_labels.orgline",
    "group": "profile",
    "type": "string",
    "adapter": "employment",
    "column": "org_line",
    "dateBasis": "current-only"
  },
  {
    "key": "employment.additional_organisation_labels.orgsection",
    "fieldId": "employment.additional_organisation_labels.orgsection",
    "group": "profile",
    "type": "string",
    "adapter": "employment",
    "column": "org_section",
    "dateBasis": "current-only"
  },
  {
    "key": "employment.additional_organisation_labels.orgteam",
    "fieldId": "employment.additional_organisation_labels.orgteam",
    "group": "profile",
    "type": "string",
    "adapter": "employment",
    "column": "org_team",
    "dateBasis": "current-only"
  },
  {
    "key": "employment.additional_organisation_labels.orgbase",
    "fieldId": "employment.additional_organisation_labels.orgbase",
    "group": "profile",
    "type": "string",
    "adapter": "employment",
    "column": "org_base",
    "dateBasis": "current-only"
  },
  {
    "key": "employment.additional_organisation_labels.employmentcategory",
    "fieldId": "employment.additional_organisation_labels.employmentcategory",
    "group": "profile",
    "type": "string",
    "adapter": "employment",
    "column": "employment_category",
    "dateBasis": "current-only"
  },
  {
    "key": "employment.employment_dates_and_service.groupservice",
    "fieldId": "employment.employment_dates_and_service.groupservice",
    "group": "profile",
    "type": "decimal",
    "adapter": "derived",
    "column": "groupService",
    "dateBasis": "effective-date"
  },
  {
    "key": "employment.employment_dates_and_service.companyservice",
    "fieldId": "employment.employment_dates_and_service.companyservice",
    "group": "profile",
    "type": "decimal",
    "adapter": "derived",
    "column": "companyService",
    "dateBasis": "effective-date"
  },
  {
    "key": "employment.employment_dates_and_service.yearofservice",
    "fieldId": "employment.employment_dates_and_service.yearofservice",
    "group": "profile",
    "type": "decimal",
    "adapter": "derived",
    "column": "yearOfService",
    "dateBasis": "effective-date"
  },
  {
    "key": "employment.employment_dates_and_service.probationvalue",
    "fieldId": "employment.employment_dates_and_service.probationvalue",
    "group": "profile",
    "type": "decimal",
    "adapter": "employment",
    "column": "probation_value",
    "dateBasis": "current-only"
  },
  {
    "key": "employment.employment_dates_and_service.probationunit",
    "fieldId": "employment.employment_dates_and_service.probationunit",
    "group": "profile",
    "type": "string",
    "adapter": "employment",
    "column": "probation_unit",
    "dateBasis": "current-only"
  },
  {
    "key": "employment.employment_dates_and_service.extendedprobationvalue",
    "fieldId": "employment.employment_dates_and_service.extendedprobationvalue",
    "group": "profile",
    "type": "decimal",
    "adapter": "employment",
    "column": "extended_probation_value",
    "dateBasis": "current-only"
  },
  {
    "key": "employment.employment_dates_and_service.extendedprobationunit",
    "fieldId": "employment.employment_dates_and_service.extendedprobationunit",
    "group": "profile",
    "type": "string",
    "adapter": "employment",
    "column": "extended_probation_unit",
    "dateBasis": "current-only"
  },
  {
    "key": "employment.employment_dates_and_service.finalconfirmationdate",
    "fieldId": "employment.employment_dates_and_service.finalconfirmationdate",
    "group": "profile",
    "type": "date",
    "adapter": "employment",
    "column": "final_confirmation_date",
    "dateBasis": "current-only"
  },
  {
    "key": "employment.employment_dates_and_service.contractstartdate",
    "fieldId": "employment.employment_dates_and_service.contractstartdate",
    "group": "profile",
    "type": "date",
    "adapter": "employment",
    "column": "contract_start_date",
    "dateBasis": "current-only"
  },
  {
    "key": "employment.employment_dates_and_service.contractenddate",
    "fieldId": "employment.employment_dates_and_service.contractenddate",
    "group": "profile",
    "type": "date",
    "adapter": "employment",
    "column": "contract_end_date",
    "dateBasis": "current-only"
  },
  {
    "key": "employment.employment_dates_and_service.contractremark",
    "fieldId": "employment.employment_dates_and_service.contractremark",
    "group": "profile",
    "type": "string",
    "adapter": "employment",
    "column": "contract_remark",
    "dateBasis": "current-only"
  },
  {
    "key": "employment.employment_dates_and_service.noticebeforeconfirmationvalue",
    "fieldId": "employment.employment_dates_and_service.noticebeforeconfirmationvalue",
    "group": "profile",
    "type": "decimal",
    "adapter": "employment",
    "column": "notice_before_confirmation_value",
    "dateBasis": "current-only"
  },
  {
    "key": "employment.employment_dates_and_service.noticebeforeconfirmationunit",
    "fieldId": "employment.employment_dates_and_service.noticebeforeconfirmationunit",
    "group": "profile",
    "type": "string",
    "adapter": "employment",
    "column": "notice_before_confirmation_unit",
    "dateBasis": "current-only"
  },
  {
    "key": "employment.employment_dates_and_service.noticeafterconfirmationvalue",
    "fieldId": "employment.employment_dates_and_service.noticeafterconfirmationvalue",
    "group": "profile",
    "type": "decimal",
    "adapter": "employment",
    "column": "notice_after_confirmation_value",
    "dateBasis": "current-only"
  },
  {
    "key": "employment.employment_dates_and_service.noticeafterconfirmationunit",
    "fieldId": "employment.employment_dates_and_service.noticeafterconfirmationunit",
    "group": "profile",
    "type": "string",
    "adapter": "employment",
    "column": "notice_after_confirmation_unit",
    "dateBasis": "current-only"
  },
  {
    "key": "employment.employment_dates_and_service.tenderresignationdate",
    "fieldId": "employment.employment_dates_and_service.tenderresignationdate",
    "group": "profile",
    "type": "date",
    "adapter": "employment",
    "column": "tender_resignation_date",
    "dateBasis": "current-only"
  },
  {
    "key": "companyId",
    "fieldId": "employment.organisation_assignment.companyname",
    "group": "profile",
    "type": "string",
    "adapter": "company",
    "column": "id",
    "dateBasis": "effective-date"
  },
  {
    "key": "companyName",
    "fieldId": "employment.organisation_assignment.companyname",
    "group": "profile",
    "type": "string",
    "adapter": "company",
    "column": "legal_name",
    "dateBasis": "current-only"
  },
  {
    "key": "businessUnitId",
    "fieldId": "employment.organisation_assignment.businessunitname",
    "group": "profile",
    "type": "string",
    "adapter": "assignment",
    "column": "business_unit_id",
    "dateBasis": "effective-date"
  },
  {
    "key": "departmentId",
    "fieldId": "employment.organisation_assignment.departmentname",
    "group": "profile",
    "type": "string",
    "adapter": "assignment",
    "column": "department_id",
    "dateBasis": "effective-date"
  },
  {
    "key": "positionId",
    "fieldId": "employment.organisation_assignment.positionname",
    "group": "profile",
    "type": "string",
    "adapter": "assignment",
    "column": "position_id",
    "dateBasis": "effective-date"
  },
  {
    "key": "gradeId",
    "fieldId": "employment.organisation_assignment.gradename",
    "group": "profile",
    "type": "string",
    "adapter": "employment",
    "column": "grade_id",
    "dateBasis": "current-only"
  }
];
export function personnelFormulaAdapter(code:string,key:string){if(code!=='EmployeeProfile'&&code!=='EmployeeInformation')return undefined;return PAY_FORMULA_PERSONNEL_ADAPTERS.find(a=>a.key===key&&(code==='EmployeeProfile'?'profile':'employee')===a.group);}
export type PersonnelFormulaRegistration={id:string;sourceKey:string;label:string;description:string;ordinal:number;enabled:boolean};
export const PAY_FORMULA_PERSONNEL_INVENTORY=PERSONNEL_FIELDS.filter(field=>field.tab==='Profile'||field.tab==='Employment').map(field=>({fieldId:field.id,label:field.label,labelKey:field.labelKey,section:field.section,group:field.tab==='Profile'?'employee' as const:'profile' as const,type:field.type,history:field.history,sensitivity:field.sensitivity,grain:field.grain,unavailableReason:field.grain==='many'?'repeating':field.type==='file'?'file':field.owner==='draft'?'draft':null}));
export const PAY_FORMULA_LEGACY_PERSONNEL_FIELDS={
 profile:{joinDate:'employment.employment_dates_and_service.joindate',groupJoinDate:'employment.employment_dates_and_service.hiredon',resignationDate:'employment.employment_dates_and_service.resignationdate',confirmationDate:'employment.employment_dates_and_service.confirmationdate',lastWorkingDate:'employment.employment_dates_and_service.lastworkingdate',employmentType:'employment.organisation_assignment.employmenttype',employeeNo:'profile.personal_details.employeecode',departmentCode:'employment.organisation_assignment.departmentname',positionCode:'employment.organisation_assignment.positionname',gradeCode:'employment.organisation_assignment.gradename'},
 employee:{dateOfBirth:'profile.personal_details.dateofbirth',gender:'profile.personal_details.gender',nationality:'profile.personal_details.nationality',maritalStatus:'profile.personal_details.maritalstatus'},
};
export type PersonnelFormulaLibraryField={fieldId:string;key:string;label:string;labelKey:string;section:string;group:'profile'|'employee';type:string;history:string;sensitivity:string;grain:string;unavailableReason:string|null;description:string;formulaType:FormulaType;functionCode:string;dateBasis:string;enabled:boolean;listValues:{value:string;label:string}[]};

/** Code-owned display descriptor shared by editors; no catalogue or employee values. */
export function personnelFormulaFieldDescriptor(code:string,key:string){
 if(code!=='EmployeeProfile'&&code!=='EmployeeInformation')return undefined;
 const group=code==='EmployeeProfile'?'profile':'employee',fieldId=personnelFormulaAdapter(code,key)?.fieldId??(PAY_FORMULA_LEGACY_PERSONNEL_FIELDS[group] as Record<string,string>)[key];
 return PERSONNEL_FIELDS.find(field=>field.id===fieldId);
}
