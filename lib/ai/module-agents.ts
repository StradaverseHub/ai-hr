/** Explicit canonical bindings. Catalogue presence never manufactures an executable capability. */
export const MODULE_AGENT_CAPABILITIES = [
  ['employees', 'own_work_profile'], ['org', 'own_reporting_lines'], ['leave', 'own_leave_balances'],
  ['ess', 'own_record_readiness'], ['approvals', 'own_leave_decisions'], ['knowledge_base', 'published_document_index'],
  ['payroll', 'own_released_payslips'], ['attendance', 'own_attendance_status'], ['claims', 'own_claim_statuses'],
  ['performance', 'own_review_status'], ['rewards', 'authorized_reward_cycle_status'], ['lifecycle', 'own_onboarding_progress'],
  ['toil', 'own_replacement_credit_ledger'], ['multi_cycle_payroll', 'own_released_run_index'],
  ['typed_pay_components', 'own_stored_pay_components'], ['country-my', 'own_malaysian_record_readiness'],
  ['notifications', 'own_notification_delivery_status'], ['system_explorer', 'authorized_schema_inventory'],
  ['assistant', 'current_assistant_capabilities'], ['system_testing', 'own_testing_assignment_status'],
] as const;
export type AgentModuleCode = typeof MODULE_AGENT_CAPABILITIES[number][0];
export type AgentCapability = typeof MODULE_AGENT_CAPABILITIES[number][1];
export const AGENT_MODULE_CODES = Object.freeze(MODULE_AGENT_CAPABILITIES.map(([code]) => code));
export function isAgentModuleCode(value: unknown): value is AgentModuleCode {
  return typeof value === 'string' && AGENT_MODULE_CODES.some(code => code === value);
}
/** Unknown future modules are explicitly unsupported until a real canonical binding is shipped. */
export function moduleAgentCoverage(catalogue: readonly { code: string }[]) {
  return catalogue.map(({ code }) => ({ code, capability: MODULE_AGENT_CAPABILITIES.find(entry => entry[0] === code)?.[1] ?? null }));
}
