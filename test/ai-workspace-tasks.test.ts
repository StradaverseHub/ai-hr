/** Pure task discovery contract, authored UNRUN. No provider or authority is constructed here. */
import { describe, expect, it } from 'vitest';
import { AI_WORKSPACE_TASKS, workspaceTasksFor } from '../lib/ai/workspace-tasks';
describe('AI workspace task discovery', () => {
  it('advertises only tasks backed by the entire offered read-tool set', () => {
    expect(workspaceTasksFor([])).toEqual([]);
    expect(workspaceTasksFor(['unregistered_module_agent', 'confirm_own_leave'])).toEqual([]);
    expect(workspaceTasksFor(['my_payslip_summary'])).toEqual(['payslip']);
    expect(workspaceTasksFor(['my_pay_change'])).toEqual([]);
    expect(workspaceTasksFor(['my_payslip_summary', 'my_pay_change'])).toEqual(['payslip']);
    expect(workspaceTasksFor(['employee_profile'])).toEqual([]);
    expect(workspaceTasksFor(['my_module_work', 'employee_profile'])).toEqual(['module_overview','work_profile']);
    expect(AI_WORKSPACE_TASKS.some(task=>String(task.id)==='pay_change')).toBe(false);
    expect(workspaceTasksFor(['my_reporting_line', 'employee_profile'])).toEqual(['reporting_line']);
  });
  it('is deterministic, append-aware and does not manufacture bindings for future modules', () => {
    const all = AI_WORKSPACE_TASKS.flatMap(task => [...task.requiredTools]);
    expect(workspaceTasksFor(all)).toEqual(AI_WORKSPACE_TASKS.map(task => task.id));
    expect(workspaceTasksFor([...all].reverse().concat(all))).toEqual(workspaceTasksFor(all));
    expect(new Set(AI_WORKSPACE_TASKS.map(task => task.id)).size).toBe(AI_WORKSPACE_TASKS.length);
    expect(workspaceTasksFor(['future_module'])).toEqual([]);
  });
});
