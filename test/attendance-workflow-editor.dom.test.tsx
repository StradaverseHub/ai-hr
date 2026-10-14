import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import viLocale from '../messages/vi.json';
import zh from '../messages/zh.json';
import type { AttendanceWorkflowInput } from '../lib/attendance-workflow';
const { save, preview, router } = vi.hoisted(() => ({ save: vi.fn(), preview: vi.fn(), router: { push: vi.fn(), refresh: vi.fn() } }));
vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/admin/attendance/approval-workflow/new' }));
vi.mock('../app/admin/attendance/approval-workflow/actions', () => ({ saveAttendanceWorkflowAction: save, previewAttendanceWorkflowAction: preview }));
import { WorkflowForm } from '../app/admin/attendance/approval-workflow/workflow-form';
import { __resetUnsavedGuards } from '../lib/unsaved-changes';
const companyId = '00000000-0000-0000-0000-000000000001';
const options = { companies: [{ id: companyId, name: 'Company A' }], departments: [{ id: 'd1', name: 'Finance' }, { id: 'd2', name: 'People' }], businessUnits: [{ id: 'b1', name: 'Operations' }, { id: 'b2', name: 'Services' }], grades: [{ id: 'g1', name: 'Grade 1' }, { id: 'g2', name: 'Grade 2' }], divisions: [{ id: 'v1', name: 'North' }, { id: 'v2', name: 'South' }] };
const initial = (): AttendanceWorkflowInput => ({ companyId, applicationType: 'self_overtime', code: 'OVERTIME', name: 'Overtime review', priority: 100, description: '', active: false, criteria: {}, stages: [{ name: 'Manager review', level: { kind: 'direct_manager', employmentId: null, alternates: [] } }, { name: 'Final review', level: { kind: 'hr_admin', employmentId: null, alternates: [] } }] });
function form(value: AttendanceWorkflowInput | null = initial(), messages = en) { return render(<NextIntlClientProvider locale="en" messages={messages}><WorkflowForm context={{ companyId, applicationType: 'self_overtime' }} initial={value} lineageId={value ? 'lineage' : null} options={options}/></NextIntlClientProvider>); }
beforeEach(() => { vi.clearAllMocks(); save.mockResolvedValue({ ok: true, lineageId: 'saved-lineage' }); preview.mockResolvedValue({ ok: true, preview: { total: 1, rows: [{ employmentId: 'employee', name: 'Example employee', selectedCode: 'OVERTIME', problem: null }], truncated: false } }); vi.spyOn(window, 'confirm').mockReturnValue(false); });
afterEach(() => { cleanup(); __resetUnsavedGuards(); vi.restoreAllMocks(); });
describe('company workflow editor outcomes', () => {
  it('fixes company/type for creation and saves all four multi-valued criteria without losing values when searching', async () => {
    form(null);
    expect(screen.getByLabelText('Company')).toBeDisabled();
    expect(screen.getByLabelText('Application type')).toBeDisabled();
    expect(screen.getByLabelText('Application type')).toHaveValue('self_overtime');
    for (const [label, names] of [['Department', ['Finance', 'People']], ['Business Unit', ['Operations', 'Services']], ['Job Grade', ['Grade 1', 'Grade 2']], ['Division', ['North', 'South']]] as const) {
      fireEvent.click(screen.getByRole('button', { name: label }));
      for (const name of names) { fireEvent.change(screen.getByPlaceholderText(en.admin.leave.adjustmentsSearchPlaceholder), { target: { value: name } }); fireEvent.click(screen.getByRole('checkbox', { name })); }
      fireEvent.keyDown(screen.getByPlaceholderText(en.admin.leave.adjustmentsSearchPlaceholder), { key: 'Escape' });
      for (const name of names) expect(screen.getByRole('button', { name: `Remove ${name}` })).toBeVisible();
    }
    fireEvent.change(screen.getByLabelText('Workflow code'), { target: { value: 'NEW' } });
    fireEvent.change(screen.getByLabelText('Workflow name'), { target: { value: 'New review' } });
    fireEvent.change(screen.getByLabelText('Stage name'), { target: { value: 'Review' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save workflow' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][1]).toMatchObject({ companyId, applicationType: 'self_overtime', criteria: { departmentIds: ['d1', 'd2'], businessUnitIds: ['b1', 'b2'], gradeIds: ['g1', 'g2'], orgDivision: ['v1', 'v2'] } });
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/admin/attendance/approval-workflow/saved-lineage'));
  });
  it('reopens saved selections, preserves unavailable choices, and invalidates preview when a chip is removed', async () => {
    const value = initial(); value.criteria = { departmentIds: ['d1', 'missing'] }; form(value);
    expect(screen.getByText('Unavailable (missing)')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Preview assignment' }));
    await screen.findByText('Example employee — OVERTIME');
    expect(preview.mock.calls[0][1].criteria.departmentIds).toEqual(['d1', 'missing']);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Unavailable (missing)' }));
    expect(screen.queryByText('Example employee — OVERTIME')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save workflow' }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][1].criteria.departmentIds).toEqual(['d1']);
  });
  it('keeps names with reordered stages, derives mode from alternatives, and offers only Attendance authorities', async () => {
    form();
    fireEvent.click(screen.getByRole('radio', { name: /Any one approver/ }));
    const stages = () => screen.getAllByRole('listitem');
    expect(within(stages()[0]).getByText('HR administrators', { selector: 'p' })).toBeVisible();
    fireEvent.click(within(stages()[0]).getByRole('button', { name: 'Move down' }));
    expect(within(stages()[1]).getByLabelText('Stage name')).toHaveValue('Manager review');
    fireEvent.change(within(stages()[1]).getByLabelText('Assigned approver'), { target: { value: 'hr_admin' } });
    for (const select of screen.getAllByLabelText('Assigned approver')) expect(within(select).getAllByRole('option').map(option => option.getAttribute('value'))).toEqual(['direct_manager', 'hr_admin']);
    fireEvent.click(screen.getByRole('button', { name: 'Save workflow' }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    const payload = save.mock.calls[0][1];
    expect(payload.stages.map((stage: { name: string }) => stage.name)).toEqual(['Final review', 'Manager review']);
    expect(payload.stages[1].level).toMatchObject({ kind: 'hr_admin', alternates: [{ kind: 'direct_manager', employmentId: null }] });
    expect(payload).not.toHaveProperty('mode');
  });
  it('switching to sequential removes alternatives and cancel preserves edits unless confirmed', () => {
    const value = initial(); value.stages[1].level.alternates = [{ kind: 'direct_manager', employmentId: null }]; form(value);
    expect(screen.getByRole('radio', { name: /Any one approver/ })).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: /Sequential approval/ }));
    expect(screen.queryByRole('button', { name: 'Remove alternative' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); expect(router.push).not.toHaveBeenCalled();
    vi.mocked(window.confirm).mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(router.push).toHaveBeenCalledWith(`/admin/attendance/approval-workflow?companyId=${companyId}&applicationType=self_overtime`);
    expect(save).not.toHaveBeenCalled();
  });
  it('keeps edits and prevents navigation on server refusal or network failure', async () => {
    form(); save.mockResolvedValueOnce({ ok: false, error: 'Overlapping priority' }).mockRejectedValueOnce(new Error('offline'));
    fireEvent.change(screen.getByLabelText('Workflow name'), { target: { value: 'Retain this' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save workflow' })); await screen.findByText('Overlapping priority');
    expect(screen.getByLabelText('Workflow name')).toHaveValue('Retain this');
    fireEvent.click(screen.getByRole('button', { name: 'Save workflow' })); await screen.findByText(en.attendanceWorkflow.requestFailed);
    expect(router.push).not.toHaveBeenCalled();
  });
  it.each([['en', en], ['ms', ms], ['ta', ta], ['th', th], ['vi', viLocale], ['zh', zh]] as const)('renders translated shared controls without missing messages (%s)', (_, messages) => {
    const error = vi.spyOn(console, 'error'); form(initial(), messages as typeof en);
    fireEvent.click(screen.getByRole('button', { name: messages.attendanceWorkflow.department }));
    expect(screen.getByPlaceholderText(messages.admin.leave.adjustmentsSearchPlaceholder)).toBeVisible();
    expect(screen.getByRole('radio', { name: new RegExp(messages.leaveApproval.modeSequential) })).toBeVisible();
    expect(error).not.toHaveBeenCalled();
  });
});
