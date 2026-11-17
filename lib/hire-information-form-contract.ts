/** Original-hire information uses the same Personnel facts with explicit changed-only transport names. */
import type {HireEmploymentInformationField} from '../core/hire-employment-information';
export const HIRE_INFORMATION_FORM_IDS = {
  "companyId": "employment.organisation_assignment.companyname",
  "hiredOn": "employment.employment_dates_and_service.hiredon",
  "joinDate": "employment.employment_dates_and_service.joindate",
  "gradeId": "employment.organisation_assignment.gradename",
  "employmentType": "employment.organisation_assignment.employmenttype",
  "orgDivision": "employment.additional_organisation_labels.orgdivision",
  "employmentCategory": "employment.additional_organisation_labels.employmentcategory",
  "orgRegion": "employment.additional_organisation_labels.orgregion",
  "orgBranch": "employment.additional_organisation_labels.orgbranch",
  "orgTeam": "employment.additional_organisation_labels.orgteam",
  "orgSection": "employment.additional_organisation_labels.orgsection",
  "orgLine": "employment.additional_organisation_labels.orgline",
  "orgBase": "employment.additional_organisation_labels.orgbase",
  "probationValue": "employment.employment_dates_and_service.probationvalue",
  "probationUnit": "employment.employment_dates_and_service.probationunit",
  "extendedProbationValue": "employment.employment_dates_and_service.extendedprobationvalue",
  "extendedProbationUnit": "employment.employment_dates_and_service.extendedprobationunit",
  "noticeBeforeConfirmationValue": "employment.employment_dates_and_service.noticebeforeconfirmationvalue",
  "noticeBeforeConfirmationUnit": "employment.employment_dates_and_service.noticebeforeconfirmationunit",
  "noticeAfterConfirmationValue": "employment.employment_dates_and_service.noticeafterconfirmationvalue",
  "noticeAfterConfirmationUnit": "employment.employment_dates_and_service.noticeafterconfirmationunit",
  "confirmationDate": "employment.employment_dates_and_service.confirmationdate",
  "extendedConfirmationDate": "employment.employment_dates_and_service.extendedconfirmationdate",
  "contractStartDate": "employment.employment_dates_and_service.contractstartdate",
  "tenderResignationDate": "employment.employment_dates_and_service.tenderresignationdate",
  "resignationDate": "employment.employment_dates_and_service.resignationdate",
  "lastWorkingDate": "employment.employment_dates_and_service.lastworkingdate"
} as const satisfies Record<HireEmploymentInformationField,string>;
export const HIRE_INFORMATION_FORM_FIELDS = ["companyId", "hiredOn", "joinDate", "gradeId", "employmentType", "orgDivision", "employmentCategory", "orgRegion", "orgBranch", "orgTeam", "orgSection", "orgLine", "orgBase", "probationValue", "probationUnit", "extendedProbationValue", "extendedProbationUnit", "noticeBeforeConfirmationValue", "noticeBeforeConfirmationUnit", "noticeAfterConfirmationValue", "noticeAfterConfirmationUnit", "confirmationDate", "extendedConfirmationDate", "contractStartDate", "tenderResignationDate", "resignationDate", "lastWorkingDate"] as const;
