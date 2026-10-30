/** Task discovery metadata, not authority or an execution plan. Every execution re-authorizes.
 * The workspace only advertises actual read-tool bindings; adding a catalogue module does not
 * manufacture an agent or imply verified support. Effect/review commands never enter this list.
 */
export const AI_WORKSPACE_TASKS = [
  { id: 'module_overview', module: 'assistant', requiredTools: ['my_module_work'] },
  { id: 'leave_available', module: 'leave', requiredTools: ['my_leave_balances'] },
  { id: 'leave_requests', module: 'leave', requiredTools: ['my_leave_requests'] },
  { id: 'claim_statuses', module: 'claims', requiredTools: ['my_claim_statuses'] },
  { id: 'holidays', module: 'org', requiredTools: ['upcoming_holidays'] },
  { id: 'reporting_line', module: 'org', requiredTools: ['my_reporting_line'] },
  { id: 'work_profile', module: 'employees', requiredTools: ['my_module_work', 'employee_profile'] },
  { id: 'payslip', module: 'payroll', requiredTools: ['my_payslip_summary'] },
] as const;
// Historical stored task IDs remain representable, but unsupported causal pay analysis is not offered.
export type AiWorkspaceTaskId = typeof AI_WORKSPACE_TASKS[number]['id'] | 'pay_change';

/** Pure offered-set projection. No reader, provider, mutation or inferred permission is invoked. */
export function workspaceTasksFor(offeredNames: readonly string[]): AiWorkspaceTaskId[] {
  const offered = new Set(offeredNames);
  return AI_WORKSPACE_TASKS.filter(task => task.requiredTools.every(name => offered.has(name))).map(task => task.id);
}
