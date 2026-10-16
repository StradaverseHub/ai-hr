import type {DraftActivateActionResult} from './draft-action-result';
import type {DraftTabKey} from './employee-draft-schema';
import {personnelFormLabel} from './personnel-form-contract';
import type {PersonnelLabelResolver} from './personnel-import-contract';
type ValidationResult=Extract<DraftActivateActionResult,{kind:'validation'}>;
/** Presentation maps finite owner codes, never Error.message or server-supplied prose. */
export const DRAFT_ACTIVATION_MESSAGE_KEYS = {
  "draft_unavailable": "people.wizard.activationValidation.draft_unavailable",
  "permission": "people.wizard.activationValidation.permission",
  "required_fields": "people.wizard.activationValidation.required_fields",
  "invalid_data": "people.wizard.activationValidation.invalid_data",
  "company_changed": "people.wizard.activationValidation.company_changed",
  "company_unavailable": "people.wizard.activationValidation.company_unavailable",
  "reference_invalid": "people.wizard.activationValidation.reference_invalid",
  "employee_code_invalid": "people.wizard.activationValidation.employee_code_invalid",
  "employee_code_not_allowed": "people.wizard.activationValidation.employee_code_not_allowed",
  "profile_invalid": "people.wizard.activationValidation.profile_invalid",
  "statutory_invalid": "people.wizard.activationValidation.statutory_invalid",
  "payroll_invalid": "people.wizard.activationValidation.payroll_invalid",
  "family_invalid": "people.wizard.activationValidation.family_invalid"
} as const satisfies Record<ValidationResult['code'],string>;
type FieldPresentation={fieldId:string}|{key:string}|{conditional:'provisionalEnd'};
/** Each owner pointer names an actual visible descriptor or an explicit composite input group. */
export const DRAFT_ACTIVATION_FIELD_PRESENTATION = {
  "profile": {
    "employeeCode": {
      "fieldId": "profile.personal_details.employeecode"
    },
    "fullName": {
      "fieldId": "profile.personal_details.fullname"
    },
    "primaryEmail": {
      "fieldId": "profile.contact_and_permanent_address.primaryemail"
    },
    "dateOfBirth": {
      "fieldId": "profile.personal_details.dateofbirth"
    },
    "icNumber": {
      "fieldId": "profile.identity_and_passport.icnumber"
    },
    "nationality": {
      "fieldId": "profile.personal_details.nationality"
    },
    "salutation": {
      "fieldId": "profile.personal_details.salutation"
    },
    "religion": {
      "fieldId": "profile.personal_details.religion"
    },
    "race": {
      "fieldId": "profile.personal_details.race"
    },
    "gender": {
      "fieldId": "profile.personal_details.gender"
    },
    "maritalStatus": {
      "fieldId": "profile.personal_details.maritalstatus"
    },
    "personalEmail": {
      "fieldId": "profile.contact_and_permanent_address.personalemail"
    },
    "permanentState": {
      "fieldId": "profile.contact_and_permanent_address.permanentstate"
    },
    "permanentCountry": {
      "fieldId": "profile.contact_and_permanent_address.permanentcountry"
    },
    "correspondenceState": {
      "fieldId": "profile.correspondence_address.correspondencestate"
    },
    "correspondenceCountry": {
      "fieldId": "profile.correspondence_address.correspondencecountry"
    },
    "passport": {
      "key": "people.wizard.fields.passport"
    }
  },
  "job": {
    "company": {
      "fieldId": "employment.organisation_assignment.companyname"
    },
    "department": {
      "fieldId": "employment.organisation_assignment.departmentname"
    },
    "position": {
      "fieldId": "employment.organisation_assignment.positionname"
    },
    "costCenter": {
      "fieldId": "employment.draft_only_employment_fields.costcenterid"
    },
    "grade": {
      "fieldId": "employment.organisation_assignment.gradename"
    },
    "reportingManager": {
      "fieldId": "employment.direct_superior_and_history.superioremploymentid"
    },
    "employmentType": {
      "fieldId": "employment.organisation_assignment.employmenttype"
    },
    "hiredOn": {
      "fieldId": "employment.employment_dates_and_service.hiredon"
    },
    "confirmationDate": {
      "fieldId": "employment.employment_dates_and_service.confirmationdate"
    },
    "provisionalEndOn": {
      "conditional": "provisionalEnd"
    },
    "employmentPeriods": {
      "key": "people.wizard.validationFields.employmentPeriods"
    }
  },
  "bankStatutory": {
    "customHolderName": {
      "fieldId": "bank_statutory.bank_information.customholdername"
    },
    "customHolderId": {
      "fieldId": "bank_statutory.bank_information.customholderid"
    },
    "epfMode": {
      "fieldId": "bank_statutory.epf_contribution.epfuimode"
    },
    "taxResidency": {
      "fieldId": "bank_statutory.income_tax_pcb.taxresidency"
    },
    "epfCitizenship": {
      "fieldId": "bank_statutory.epf_contribution.epfcitizenship"
    },
    "subjectToHrdf": {
      "fieldId": "bank_statutory.socso_eis_and_others_statutory.hrdfsubject"
    },
    "epfEmployeeRate": {
      "fieldId": "bank_statutory.epf_contribution.epfemployeerate"
    },
    "epfEmployerRate": {
      "fieldId": "bank_statutory.epf_contribution.epfemployerrate"
    },
    "epfEmployeeAmount": {
      "fieldId": "bank_statutory.epf_contribution.epfemployeeamount"
    },
    "epfEmployerAmount": {
      "fieldId": "bank_statutory.epf_contribution.epfemployeramount"
    },
    "epfManualReason": {
      "fieldId": "bank_statutory.epf_contribution.epfmanualreason"
    },
    "bankAccount": {
      "key": "people.wizard.fields.bankAccount"
    }
  },
  "payroll": {
    "basicSalary": {
      "fieldId": "payroll.basic_salary_and_salary_history.basicsalary"
    },
    "monthlyAllowance": {
      "fieldId": "payroll.draft_initial_monthly_allowance.monthlyallowance"
    },
    "remarks": {
      "fieldId": "payroll.basic_salary_and_salary_history.remarks"
    },
    "rateAmount": {
      "fieldId": "payroll.basic_salary_and_salary_history.rateamount"
    },
    "payMode": {
      "fieldId": "payroll.basic_salary_and_salary_history.paymode"
    },
    "paymentTerm": {
      "fieldId": "payroll.basic_salary_and_salary_history.paymentterm"
    },
    "paymentMethod": {
      "fieldId": "payroll.payment_method_and_payroll_policy.paymentmethod"
    },
    "payrollPolicyId": {
      "fieldId": "payroll.payment_method_and_payroll_policy.payrollpolicyname"
    },
    "paymentMethodBank": {
      "key": "people.wizard.fields.paymentMethodBank"
    }
  },
  "family": {
    "familyMemberName": {
      "fieldId": "family.family_and_dependents.fullname"
    },
    "familyMemberRelationship": {
      "fieldId": "family.family_and_dependents.relationship"
    },
    "familyMemberDate": {
      "fieldId": "family.family_and_dependents.dateofbirth"
    },
    "gender": {
      "fieldId": "family.family_and_dependents.gender"
    },
    "marriageStatus": {
      "fieldId": "family.family_and_dependents.marriagestatus"
    },
    "childReliefCategory": {
      "fieldId": "family.family_and_dependents.childreliefcategory"
    },
    "childReliefPercentage": {
      "fieldId": "family.family_and_dependents.childreliefpercentage"
    }
  }
} as const satisfies Record<DraftTabKey,Record<string,FieldPresentation>>;
export function draftActivationMessageKey(code:unknown):string {
  return typeof code==='string'&&Object.hasOwn(DRAFT_ACTIVATION_MESSAGE_KEYS,code)
    ? DRAFT_ACTIVATION_MESSAGE_KEYS[code as keyof typeof DRAFT_ACTIVATION_MESSAGE_KEYS]
    : DRAFT_ACTIVATION_MESSAGE_KEYS.invalid_data;
}
export function draftActivationFieldLabels(pointers:unknown,resolve:PersonnelLabelResolver,employmentType:string) {
  const out:{tab:DraftTabKey;label:string}[]=[];
  if(!Array.isArray(pointers))return out;
  for(const pointer of pointers){
    if(!pointer||typeof pointer!=='object'||typeof pointer.tab!=='string'||typeof pointer.field!=='string'||!Object.hasOwn(DRAFT_ACTIVATION_FIELD_PRESENTATION,pointer.tab))continue;
    const tab=pointer.tab as DraftTabKey,group:Record<string,FieldPresentation>=DRAFT_ACTIVATION_FIELD_PRESENTATION[tab];
    if(!Object.hasOwn(group,pointer.field))continue;
    const source=group[pointer.field];let label:string;
    if('fieldId' in source)label=personnelFormLabel(source.fieldId,resolve);
    else if('key' in source)label=resolve(source.key,'');
    else if(employmentType==='contract')label=personnelFormLabel('employment.employment_dates_and_service.contractenddate',resolve);
    else if(employmentType==='intern')label=personnelFormLabel('employment.draft_only_employment_fields.internshipenddate',resolve);
    else label=resolve('people.wizard.fields.provisionalEndOn','');
    if(label&&!out.some(item=>item.tab===tab&&item.label===label))out.push({tab,label});
  }
  return out;
}
/** The action's reference format is fixed; an unexpected payload is never displayed as diagnostic prose. */
export function draftFailureReference(value:unknown):string|null {
  return typeof value==='string'&&/^DRAFT-[0-9A-F]{8}$/.test(value)?value:null;
}
