/** Fixed action-title keys only. No model text, caller label or HR value becomes navigation copy. */
import {moduleHumanActionHandoffs} from './module-human-handoffs';
import {isAgentModuleCode} from './module-agents';
export const PERSONNEL_REVIEW_TITLE_KEYS=Object.freeze({
 'employees.compensation.maintain':'assistant.workspace.compensationMaintenance.title',
 'employees.profile_request.reject':'assistant.workspace.profileRequestRejection.title',
 'employees.code.maintain':'assistant.workspace.employeeCodeMaintenance.title',
 'employees.workforce_profile.maintain':'assistant.workspace.workforceProfileMaintenance.title',
 'employees.bank.maintain':'assistant.workspace.bankMaintenance.title',
 'employees.document_metadata.maintain':'assistant.workspace.documentMetadata.title',
 'employees.fixed_item.archive':'assistant.workspace.fixedItemArchive.title',
 'employees.cost_allocation.maintain':'assistant.workspace.costAllocationMaintenance.title',
 'employees.payment_method.maintain':'assistant.workspace.paymentMethodMaintenance.title',
 'employees.tp3_opening.maintain':'assistant.workspace.tp3OpeningMaintenance.title',
 'employees.passport.maintain':'assistant.workspace.passportMaintenance.title',
 'employees.emergency_contact.maintain':'assistant.workspace.emergencyContactMaintenance.title',
 'employees.family.maintain':'assistant.workspace.familyMaintenance.title',
 'employees.qualification.maintain':'assistant.workspace.qualificationMaintenance.title',
 'employees.draft.discard':'assistant.workspace.employeeDraftDiscard.title',
 'employees.draft.activate':'assistant.workspace.employeeDraftActivation.title',
} as const);
/** Labels are available only for an exact currently allowlisted module/route/action correlation.
 * Existing generic copy remains the caller's fallback for every other module or unknown route. */
export function personnelReviewTitleKey(module:string,route:string|undefined):string|null{
 if(module!=='employees'||!route||!isAgentModuleCode(module))return null;
 const handoff=moduleHumanActionHandoffs(module).find(row=>row.route===route);
 if(!handoff||!Object.prototype.hasOwnProperty.call(PERSONNEL_REVIEW_TITLE_KEYS,handoff.action))return null;
 return PERSONNEL_REVIEW_TITLE_KEYS[handoff.action as keyof typeof PERSONNEL_REVIEW_TITLE_KEYS];
}
