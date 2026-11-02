/** Code-owned action cells. A cell names real service and SQL owners; this is never a posted grant. */
export const WORKFORCE_ACTIONS=['view','add','edit','delete'] as const;
export type WorkforceAction=typeof WORKFORCE_ACTIONS[number];
export const WORKFORCE_ACTION_BINDINGS=Object.freeze({
 view:{capability:'workforce.view',owners:['app.access_workforce_projection_company','app.access_workforce_list_rows','app.access_workforce_record','core/workforce-access.ts'],subjects:['employment','person']},
 add:{capability:'workforce.add',owners:['app.access_workforce_hire_insert','app.access_workforce_maintain_record','app.access_profile_value_guard','app.access_workforce_document_write','core/org.ts:hireEmployee','core/workforce-registers.ts'],subjects:['new-employment','new-person','register-row','employee-document','employee-draft']},
 edit:{capability:'workforce.edit',owners:['app.access_workforce_employment_action_guard','app.access_workforce_maintain_record','app.access_profile_value_guard','app.access_workforce_structure_write','app.access_workforce_set_employee_code','core/workforce-commands.ts'],subjects:['employment','person','register-row','employee-document','employee-draft']},
 delete:{capability:'workforce.delete',owners:['app.access_workforce_employment_action_guard','app.access_workforce_maintain_record','app.access_profile_value_guard','app.access_workforce_document_write','core/workforce-registers.ts'],subjects:['employment','register-row','employee-document','employee-draft']},
} as const);
/** Independent employment decisions, ESS proposals, privacy erasure and derived payroll facts retain
 * exact private witnesses. Their SQL guards adjudicate complete deltas rather than falling back to a role. */
export const INDEPENDENT_ACTION_OWNERS=Object.freeze([
 'app.access_profile_value_approved','app.profile_direct_value_matches','app.access_privacy_value_intent_allowed',
 'app.access_termination_intent','app.my_sync_family_child_relief',
] as const);
export function isWorkforceWriteCapability(id:string){return ['workforce.add','workforce.edit','workforce.delete'].includes(id);}
