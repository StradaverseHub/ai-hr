import { beforeEach, expect, it, vi } from 'vitest';
const { scope, save, preview, enable, revalidate } = vi.hoisted(() => ({ scope: vi.fn(), save: vi.fn(), preview: vi.fn(), enable: vi.fn(), revalidate: vi.fn() }));
vi.mock('../lib/scope', () => ({ scopedAdmin: scope }));
vi.mock('next/cache', () => ({ revalidatePath: revalidate }));
vi.mock('../packs/attendance/service', async () => ({ ...await import('../lib/attendance-workflow'), saveAttendanceWorkflow: save, previewAttendanceWorkflow: preview, setAttendanceWorkflowEnabled: enable }));
import { saveAttendanceWorkflowAction, previewAttendanceWorkflowAction, setAttendanceWorkflowEnabledAction } from '../app/(app)/admin/attendance/approval-workflow/actions';
import type { AttendanceWorkflowInput } from '../lib/attendance-workflow';
const input: AttendanceWorkflowInput = { companyId: 'company', applicationType: 'self_overtime', code: 'OT', name: 'Review', priority: 100, criteria: {}, stages: [], active: false };
beforeEach(() => { vi.clearAllMocks(); scope.mockResolvedValue({ s: { actor: 'hr' }, scopeIds: ['company'] }); save.mockResolvedValue({ lineageId: 'stored-lineage' }); });
it('invalidates company listing and saved view/edit paths only after successful persistence', async () => {
  expect(await saveAttendanceWorkflowAction('stored-lineage', input)).toEqual({ ok: true, lineageId: 'stored-lineage' });
  expect(revalidate.mock.calls.map(call => call[0])).toEqual(['/admin/attendance/approval-workflow', '/admin/attendance/approval-workflow/stored-lineage', '/admin/attendance/approval-workflow/stored-lineage/edit']);
  revalidate.mockClear(); save.mockRejectedValue(new Error('private database detail'));
  const result = await saveAttendanceWorkflowAction('stored-lineage', input);
  expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain('private database'); expect(revalidate).not.toHaveBeenCalled();
});
it('refuses a forged company before save, preview, or routing writes', async () => {
  const foreign = { ...input, companyId: 'foreign' };
  expect((await saveAttendanceWorkflowAction(null, foreign)).ok).toBe(false);
  expect((await previewAttendanceWorkflowAction(null, foreign)).ok).toBe(false);
  expect((await setAttendanceWorkflowEnabledAction('foreign', 'irregularity', true)).ok).toBe(false);
  expect(save).not.toHaveBeenCalled(); expect(preview).not.toHaveBeenCalled(); expect(enable).not.toHaveBeenCalled();
});
