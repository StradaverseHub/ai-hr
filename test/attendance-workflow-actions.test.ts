import { beforeEach, expect, it, vi } from 'vitest';
const { scope, save, preview, revalidate } = vi.hoisted(() => ({ scope: vi.fn(), save: vi.fn(), preview: vi.fn(), revalidate: vi.fn() }));
vi.mock('../lib/scope', () => ({ scopedAdmin: scope }));
vi.mock('next/cache', () => ({ revalidatePath: revalidate }));
vi.mock('next/navigation', () => ({ unstable_rethrow: vi.fn() }));
vi.mock('../packs/attendance/service', async () => ({ ...await import('../lib/attendance-workflow'), saveAttendanceWorkflow: save, previewAttendanceWorkflow: preview }));
import { saveAttendanceWorkflowAction, previewAttendanceWorkflowAction } from '../app/admin/attendance/approval-workflow/actions';
import type { AttendanceWorkflowInput } from '../lib/attendance-workflow';
const companyId = '00000000-0000-0000-0000-000000000001';
const secondId = '00000000-0000-0000-0000-000000000002';
const lineageId = '00000000-0000-0000-0000-000000000003';
const saveRequestId = '00000000-0000-4000-8000-000000000004';
const input: AttendanceWorkflowInput = { companyId, applicationType: 'self_overtime', code: 'OT', name: 'Review', priority: 100, criteria: {}, stages: [{name:'HR review',level:{kind:'hr_admin',employmentId:null,alternates:[]}}], active: false };
beforeEach(() => { vi.resetAllMocks(); scope.mockResolvedValue({ s: { actor: 'hr' }, scopeIds: [companyId] }); save.mockResolvedValue({ lineageId }); });
it('publishes on Save and invalidates affected pages after persistence', async () => {
  expect(await saveAttendanceWorkflowAction(lineageId, input, false, saveRequestId)).toEqual({ ok: true, lineageId });
  expect(save).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({active:true}),lineageId,undefined,false,saveRequestId);
  expect(revalidate.mock.calls.map(call => call[0])).toEqual(['/admin/attendance/approval-workflow', `/admin/attendance/approval-workflow/${lineageId}`, `/admin/attendance/approval-workflow/${lineageId}/edit`]);
  revalidate.mockClear(); save.mockRejectedValue(new Error('private database detail'));
  const result = await saveAttendanceWorkflowAction(lineageId, input, false, saveRequestId);
  expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain('private database'); expect(revalidate).not.toHaveBeenCalled();
});
it('returns the committed save even if refreshing its pages fails', async () => {
  revalidate.mockImplementation(() => { throw new Error('cache unavailable'); });
  expect(await saveAttendanceWorkflowAction(lineageId,input,false,saveRequestId)).toEqual({ok:true,lineageId});
});
it('refuses a forged company before save or preview writes', async () => {
  const foreign = { ...input, companyId: secondId };
  expect((await saveAttendanceWorkflowAction(null, foreign,false,saveRequestId)).ok).toBe(false);
  expect((await previewAttendanceWorkflowAction(null, foreign)).ok).toBe(false);
  expect(save).not.toHaveBeenCalled(); expect(preview).not.toHaveBeenCalled();
});
it('uses actual allowed companies for shared edits when the company switcher is narrower',async()=>{
 scope.mockResolvedValue({s:{actor:'group HR'},scopeIds:[companyId],allowedCompanyIds:[companyId,secondId]});
 const shared={...input,companyIds:[companyId,secondId]};
 expect(await saveAttendanceWorkflowAction(null,shared,false,saveRequestId)).toEqual({ok:true,lineageId});
 expect(save).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({...shared,active:true}),undefined,undefined,false,saveRequestId);
});
