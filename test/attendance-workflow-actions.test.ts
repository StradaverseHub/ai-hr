import { beforeEach, expect, it, vi } from 'vitest';
const { scope, save, preview, revalidate, searchEmployees } = vi.hoisted(() => ({ scope: vi.fn(), save: vi.fn(), preview: vi.fn(), revalidate: vi.fn(), searchEmployees: vi.fn() }));
vi.mock('../lib/scope', () => ({ scopedAdmin: scope }));
vi.mock('next/cache', () => ({ revalidatePath: revalidate }));
vi.mock('next/navigation', () => ({ unstable_rethrow: vi.fn() }));
vi.mock('../packs/attendance/service', async () => ({ ...await import('../lib/attendance-workflow'), saveAttendanceWorkflow: save, previewAttendanceWorkflow: preview, searchAttendanceWorkflowEmployees: searchEmployees }));
import { saveAttendanceWorkflowAction, previewAttendanceWorkflowAction, searchAttendanceWorkflowEmployeesAction } from '../app/admin/attendance/approval-workflow/actions';
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

// 03cb9b74: the Employee / Employees criterion search uses the approver search's guard and company-scope check.
it('searches criteria employees only inside the permitted companies and hides internal errors', async () => {
  const value = { rows: [{ id: lineageId, name: 'Fictional Person', employeeCode: 'E1', company: 'Fictional Co', terminatedOn: null }], more: false };
  searchEmployees.mockResolvedValue(value);
  expect(await searchAttendanceWorkflowEmployeesAction({ companyIds: [companyId], query: '50%_off', after: { name: 'Fictional A', id: lineageId } })).toEqual({ ok: true, value });
  expect(searchEmployees).toHaveBeenCalledWith({ actor: 'hr' }, { companyIds: [companyId], query: '50%_off', after: { name: 'Fictional A', id: lineageId } });
  searchEmployees.mockClear();
  const foreign = await searchAttendanceWorkflowEmployeesAction({ companyIds: [companyId, secondId], query: '' });
  expect(foreign.ok).toBe(false); expect(searchEmployees).not.toHaveBeenCalled();
  scope.mockResolvedValue({ s: { actor: 'group HR' }, scopeIds: [companyId], allowedCompanyIds: [companyId, secondId] });
  searchEmployees.mockResolvedValue(value);
  expect((await searchAttendanceWorkflowEmployeesAction({ companyIds: [companyId, secondId], query: '' })).ok).toBe(true);
  expect(searchEmployees).toHaveBeenLastCalledWith({ actor: 'group HR' }, { companyIds: [companyId, secondId], query: '', after: null });
  searchEmployees.mockRejectedValue(new Error('private database detail'));
  const failed = await searchAttendanceWorkflowEmployeesAction({ companyIds: [companyId], query: 'x' });
  expect(failed.ok).toBe(false); expect(JSON.stringify(failed)).not.toContain('private database');
});
