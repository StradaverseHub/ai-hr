/** Explicit canonical bindings. Catalogue presence never manufactures an executable capability. */
export const MODULE_READ_CAPABILITIES = [
  ['employees', 'own_work_profile'], ['org', 'own_reporting_lines'], ['leave', 'own_leave_balances'],
  ['ess', 'own_record_readiness'], ['approvals', 'own_leave_decisions'], ['knowledge_base', 'published_document_index'],
  ['payroll', 'own_released_payslips'], ['attendance', 'own_attendance_status'], ['claims', 'own_claim_statuses'],
  ['performance', 'own_review_status'], ['rewards', 'authorized_reward_cycle_status'], ['lifecycle', 'own_onboarding_progress'],
  ['toil', 'own_replacement_credit_ledger'], ['multi_cycle_payroll', 'own_released_run_index'],
  ['typed_pay_components', 'own_stored_pay_components'], ['country-my', 'own_malaysian_record_readiness'],
  ['notifications', 'own_notification_delivery_status'], ['system_explorer', 'authorized_schema_inventory'],
  ['assistant', 'current_assistant_capabilities'], ['system_testing', 'own_testing_assignment_status'],
] as const;
export type ModuleReadCode = typeof MODULE_READ_CAPABILITIES[number][0];
export type ModuleReadCapability = typeof MODULE_READ_CAPABILITIES[number][1];
export const MODULE_READ_CODES = Object.freeze(MODULE_READ_CAPABILITIES.map(([code]) => code));
export function isModuleReadCode(value: unknown): value is ModuleReadCode {
  return typeof value === 'string' && MODULE_READ_CODES.some(code => code === value);
}
/** Unknown future modules are explicitly unsupported until a real canonical binding is shipped. */
export function moduleReadCoverage(catalogue: readonly { code: string }[]) {
  return catalogue.map(({ code }) => ({ code, capability: MODULE_READ_CAPABILITIES.find(entry => entry[0] === code)?.[1] ?? null }));
}

/** Compatibility names for in-flight consumers; these are read bindings, not autonomous actors. */
export const MODULE_AGENT_CAPABILITIES=MODULE_READ_CAPABILITIES;
export const AGENT_MODULE_CODES=MODULE_READ_CODES;
export const isAgentModuleCode=isModuleReadCode;
export const moduleAgentCoverage=moduleReadCoverage;
export type AgentModuleCode=ModuleReadCode;
export type AgentCapability=ModuleReadCapability;
