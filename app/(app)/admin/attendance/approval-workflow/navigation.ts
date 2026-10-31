import type { AttendanceApplicationType } from '@/lib/attendance-workflow';
export const workflowRoot = '/admin/attendance/approval-workflow';
export const isWorkflowId = (id: string) => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id);
export type WorkflowQuery = { companyId?: string | string[]; applicationType?: string | string[]; notice?: string | string[] };
/** Reject repeated or foreign context before passing an identifier to the scoped service. */
export function workflowContext(query: WorkflowQuery, scopeIds: readonly string[]) {
  if (query.companyId === undefined && query.applicationType === undefined) return null;
  if (typeof query.companyId !== 'string' || !isWorkflowId(query.companyId) || !scopeIds.includes(query.companyId)) throw new Error('Invalid workflow company');
  const applicationType = query.applicationType ?? 'irregularity';
  if (applicationType !== 'irregularity' && applicationType !== 'self_overtime') throw new Error('Invalid workflow application type');
  return { companyId: query.companyId, applicationType } as { companyId: string; applicationType: AttendanceApplicationType };
}
export function companyWorkflowHref(companyId: string, applicationType: AttendanceApplicationType, create = false) {
  return `${workflowRoot}${create ? '/new' : ''}?${new URLSearchParams({ companyId, applicationType })}`;
}
