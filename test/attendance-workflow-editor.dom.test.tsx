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
import type { AttendanceWorkflowInput, AttendanceWorkflowOptions } from '../lib/attendance-workflow';
const { save, preview, router, searchEmployees, searchApprovers } = vi.hoisted(() => ({ save: vi.fn(), preview: vi.fn(), router: { push: vi.fn(), refresh: vi.fn() }, searchEmployees: vi.fn(), searchApprovers: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/admin/attendance/approval-workflow/new' }));
vi.mock('../app/admin/attendance/approval-workflow/actions', () => ({ saveAttendanceWorkflowAction: save, previewAttendanceWorkflowAction: preview, searchAttendanceWorkflowEmployeesAction: searchEmployees, searchAttendanceApproversAction: searchApprovers }));
import { WorkflowForm } from '../app/admin/attendance/approval-workflow/workflow-form';
import { __resetUnsavedGuards } from '../lib/unsaved-changes';
import { attendanceWorkflowConfiguration } from '../lib/attendance-workflow-config';
const companyId = '00000000-0000-0000-0000-000000000001';
const options = { companies: [{ id: companyId, name: 'Company A' }], departments: [{ id: 'd1', name: 'Finance' }, { id: 'd2', name: 'People' }], businessUnits: [{ id: 'b1', name: 'Operations' }, { id: 'b2', name: 'Services' }], grades: [{ id: 'g1', name: 'Grade 1' }, { id: 'g2', name: 'Grade 2' }], divisions: [{ id: 'v1', name: 'North' }, { id: 'v2', name: 'South' }] };
const initial = (): AttendanceWorkflowInput => ({ companyId, applicationType: 'self_overtime', code: 'OVERTIME', name: 'Overtime review', priority: 100, description: '', active: false, criteria: {}, stages: [{ name: 'Manager review', level: { kind: 'direct_manager', employmentId: null, alternates: [] } }, { name: 'Final review', level: { kind: 'hr_admin', employmentId: null, alternates: [] } }] });
function form(value: AttendanceWorkflowInput | null = initial(), messages = en, catalogues: AttendanceWorkflowOptions = options) { return render(<NextIntlClientProvider locale="en" messages={messages}><WorkflowForm context={{ companyId, applicationType: 'self_overtime' }} initial={value} lineageId={value ? 'lineage' : null} options={catalogues}/></NextIntlClientProvider>); }
beforeEach(() => { vi.clearAllMocks(); save.mockResolvedValue({ ok: true, lineageId: 'saved-lineage' }); preview.mockResolvedValue({ ok: true, preview: { total: 1, rows: [{ employmentId: 'employee', name: 'Example employee', selectedCode: 'OVERTIME', problem: null }], truncated: false } }); vi.spyOn(window, 'confirm').mockReturnValue(false); });
afterEach(() => { cleanup(); __resetUnsavedGuards(); vi.restoreAllMocks(); });
describe('company workflow editor outcomes', () => {
  it('fixes company/type for creation and saves all four multi-valued criteria without losing values when searching', async () => {
    form(null);
    expect(screen.getByRole('button',{name:'Company'})).toBeEnabled();
    // 03cb9b74: the fixed application type is read-only text; its value still travels in the saved input.
    expect(screen.getByLabelText('Application type')).toHaveTextContent('Self Overtime');
    expect(screen.queryByRole('combobox', { name: 'Application type' })).toBeNull();
    fireEvent.click(screen.getByText(/^More conditions/, { selector: 'summary' }));
    for (const [label, names] of [['Department', ['Finance', 'People']], ['Business Unit', ['Operations', 'Services']], ['Job Grade', ['Grade 1', 'Grade 2']], ['Division', ['North', 'South']]] as const) {
      fireEvent.click(screen.getByRole('button', { name: label }));
      for (const name of names) { fireEvent.change(screen.getByPlaceholderText(en.admin.leave.adjustmentsSearchPlaceholder), { target: { value: name } }); fireEvent.click(screen.getByRole('checkbox', { name })); }
      fireEvent.keyDown(screen.getByPlaceholderText(en.admin.leave.adjustmentsSearchPlaceholder), { key: 'Escape' });
      for (const name of names) expect(screen.getByRole('button', { name: `Remove ${name}` })).toBeVisible();
    }
    fireEvent.change(screen.getByLabelText('Workflow code'), { target: { value: 'NEW' } });
    fireEvent.change(screen.getByLabelText('Workflow name'), { target: { value: 'New review' } });
    expect(screen.queryByLabelText('Stage name')).not.toBeInTheDocument();
    expect(screen.getByText('Level 1')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Save workflow' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][1]).toMatchObject({ companyId, applicationType: 'self_overtime', criteria: { departmentIds: ['d1', 'd2'], businessUnitIds: ['b1', 'b2'], gradeIds: ['g1', 'g2'], orgDivision: ['v1', 'v2'] } });
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/admin/attendance/approval-workflow/saved-lineage?notice=saved'));
  });
  it('reopens saved selections, preserves unavailable choices, and invalidates preview when a chip is removed', async () => {
    const value = initial(); value.criteria = { departmentIds: ['d1', 'missing'] }; form(value);
    expect(screen.getByText('Unavailable (missing)')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Preview assignment' }));
    await screen.findByText('Example employee — OVERTIME');
    await waitFor(() => expect(screen.getByLabelText('Workflow name')).not.toBeDisabled());
    expect(preview.mock.calls[0][1].criteria.departmentIds).toEqual(['d1', 'missing']);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Unavailable (missing)' }));
    expect(screen.queryByText('Example employee — OVERTIME')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save workflow' }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][1].criteria.departmentIds).toEqual(['d1']);
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/admin/attendance/approval-workflow/saved-lineage?notice=saved'));
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
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/admin/attendance/approval-workflow/saved-lineage?notice=saved'));
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
    // Feedback can render while the async transition still disables editing and shows Saving.
    await waitFor(() => expect(screen.getByLabelText('Workflow name')).not.toBeDisabled());
    expect(screen.getByRole('alert').parentElement).toContainElement(screen.getByRole('button', { name: 'Save workflow' }));
    expect(screen.getByLabelText('Workflow name')).toHaveValue('Retain this');
    fireEvent.click(screen.getByRole('button', { name: 'Save workflow' })); await screen.findByText(en.attendanceWorkflow.requestFailed);
    await waitFor(() => expect(screen.getByLabelText('Workflow name')).not.toBeDisabled());
    expect(screen.getByLabelText('Workflow name')).toHaveValue('Retain this');
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[0][3]).toBeTypeOf('string');
    expect(save.mock.calls[1][3]).toBe(save.mock.calls[0][3]);
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


describe('797ba70b: auto levels and complete assignment controls', () => {
  it('adds/removes/reorders independent levels without custom names and saves explicit routing v4', async () => {
    form(null);
    fireEvent.change(screen.getByLabelText('Workflow code'), { target: { value: 'SEQUENTIAL' } });
    fireEvent.change(screen.getByLabelText('Workflow name'), { target: { value: 'Sequential review' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Approval Level' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Approval Level' }));
    const levels = () => screen.getAllByRole('heading',{name:/^Level \d+$/}).map(heading=>heading.closest('li')!);
    expect(levels().map(li => within(li).getByRole('heading').textContent)).toEqual(['Level 1', 'Level 2', 'Level 3']);
    fireEvent.change(within(levels()[0]).getByLabelText('Superior depth'), { target: { value: '5' } });
    fireEvent.click(within(levels()[0].firstElementChild as HTMLElement).getByRole('button', { name: 'Move down' }));
    expect(within(levels()[1]).getByLabelText('Superior depth')).toHaveValue('5');
    fireEvent.click(within(levels()[0]).getByRole('button', { name: 'Remove Level 1' }));
    expect(levels().map(li => within(li).getByRole('heading').textContent)).toEqual(['Level 1', 'Level 2']);
    expect(screen.queryByLabelText('Stage name')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save workflow' })); await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][1].routingVersion).toBe(4);
    expect(save.mock.calls[0][1].stages.map((s: { name: string }) => s.name)).toEqual(['Level 1', 'Level 2']);
  });
  it('keeps legacy behavior until explicit conversion and does not lose configured alternatives', async () => {
    const value = initial(); value.stages[0].level.alternates = [{ kind: 'hr_admin', employmentId: null }]; form(value);
    expect(screen.getAllByLabelText('Stage name')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Use sequential hierarchy for new submissions' }));
    expect(screen.queryByLabelText('Stage name')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save workflow' })); await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][1]).toMatchObject({ routingVersion: 2, stages: [{ name: 'Level 1', level: { alternates: [{ kind: 'hr_admin', employmentId: null }] } }, { name: 'Level 2' }] });
  });
  it('shows every added Personnel axis and distinguishes selectable employees by code and name', async () => {
    searchEmployees.mockResolvedValue({ ok: true, value: { rows: [{ id: 'e1', name: 'Duplicate name', employeeCode: 'D00001', company: 'Company A' }, { id: 'e2', name: 'Duplicate name', employeeCode: 'A00001', company: 'Company A' }], more: false } });
    form(null, en, { ...options, positions: [{ id: 'p1', name: 'Analyst' }], employees: [], profileFields: { orgBranch: [{ id: 'b', name: 'Branch code' }], orgRegion: [], orgLine: [], orgSection: [], orgTeam: [], orgBase: [], employmentCategory: [] } });
    fireEvent.change(screen.getByLabelText('Workflow code'), { target: { value: 'PERSONNEL' } });
    fireEvent.change(screen.getByLabelText('Workflow name'), { target: { value: 'Personnel review' } });
    // 03cb9b74: the eight organisation conditions sit under "More conditions"; Employee / Employees is a search.
    for (const key of ['position', 'employmentType', 'employees'] as const) expect(screen.getByRole('button', { name: en.attendanceWorkflow[key] })).toBeVisible();
    const more = screen.getByText(/^More conditions/, { selector: 'summary' });
    expect(more.closest('details')).not.toHaveAttribute('open');
    expect(more).toHaveTextContent('Division, Branch, Region, Line, Section, Team, Base, Category');
    fireEvent.click(more);
    for (const key of ['division', 'branch', 'region', 'line', 'section', 'team', 'base', 'category'] as const) expect(screen.getByRole('button', { name: en.attendanceWorkflow[key] })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Employee / Employees' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: /D00001 · Duplicate name/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /A00001 · Duplicate name/ }));
    expect(searchEmployees).toHaveBeenCalledWith({ companyIds: [companyId], query: '', after: null });
    expect(screen.getByText('Matches: Employee / Employees is D00001 · Duplicate name or A00001 · Duplicate name')).toBeVisible();
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Save workflow' })); await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][1].criteria.employeeIds).toEqual(['e1', 'e2']);
  });
});

it('defaults new organisation-wide workflows to All Company and restores explicit saved scope',async()=>{
 const catalogues={...options,canManageAllCompanies:true,companies:[...options.companies,{id:'00000000-0000-0000-0000-000000000002',name:'Company B'}]};
 form(null,en,catalogues);
 expect(screen.getByRole('checkbox',{name:'All Company'})).toBeChecked();
 fireEvent.click(screen.getByRole('checkbox',{name:'All Company'}));
 expect(screen.getByRole('checkbox',{name:'All Company'})).not.toBeChecked();
 cleanup();form(initial(),en,catalogues);
 expect(screen.getByRole('checkbox',{name:'All Company'})).not.toBeChecked();
});
it('explains the organisation-wide permission requirement for company-scoped administrators',()=>{
 form(null);expect(screen.getByRole('checkbox',{name:'All Company'})).toBeDisabled();
 expect(screen.getByText(en.attendanceWorkflow.allCompanyRestricted)).toBeVisible();
});
describe('4452ba3c: OR groups, default superior depth and copied workflows',()=>{
 it('adds an OR group, saves the groups and starts a new level at the next superior depth',async()=>{
  form(null);
  expect(screen.queryByText('Group 2')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Add Approval Level'}));
  const depths=screen.getAllByLabelText('Superior depth') as HTMLSelectElement[];
  expect(depths.map(select=>select.value)).toEqual(['1','2']);
  fireEvent.click(screen.getByRole('button',{name:'+ Add OR group'}));
  expect(screen.getByText('Group 2')).toBeVisible();
  const second=screen.getByRole('group',{name:'Group 2'});
  fireEvent.click(within(second).getByRole('button',{name:'Department'}));
  fireEvent.click(screen.getByRole('checkbox',{name:'Finance'}));
  fireEvent.keyDown(screen.getByPlaceholderText(en.admin.leave.adjustmentsSearchPlaceholder),{key:'Escape'});
  fireEvent.change(screen.getByLabelText('Workflow code'),{target:{value:'GROUPED'}});
  fireEvent.change(screen.getByLabelText('Workflow name'),{target:{value:'Grouped review'}});
  fireEvent.click(screen.getByRole('button',{name:'Save workflow'}));
  await waitFor(()=>expect(save).toHaveBeenCalledTimes(1));
  expect(save.mock.calls[0][1].criteria).toEqual({groups:[{},{departmentIds:['d1']}]});
  expect(save.mock.calls[0][1].stages.map((stage:{sources:unknown})=>stage.sources)).toEqual([[{kind:'direct_manager',depth:1}],[{kind:'direct_manager',depth:2}]]);
  expect(screen.getByRole('button',{name:'Remove group 1'})).toBeInTheDocument();
 });
 it('shows the copy banner, keeps the copied priority and sends provenance on save',async()=>{
  const copied={...initial(),code:'',name:'',description:'',priority:7};
  render(<NextIntlClientProvider locale="en" messages={en}><WorkflowForm context={{companyId,applicationType:'self_overtime'}} initial={copied} lineageId={null} options={options} copiedFrom={{lineageId:'00000000-0000-0000-0000-0000000000aa',version:4,code:'WF-DESIGN-01'}}/></NextIntlClientProvider>);
  expect(screen.getByText(/Copied from WF-DESIGN-01 \(version 4\)/)).toBeVisible();
  expect(screen.getByLabelText('Workflow code')).toHaveValue('');
  fireEvent.change(screen.getByLabelText('Workflow code'),{target:{value:'WF-COPY'}});
  fireEvent.change(screen.getByLabelText('Workflow name'),{target:{value:'Copied review'}});
  fireEvent.click(screen.getByRole('button',{name:'Save workflow'}));
  await waitFor(()=>expect(save).toHaveBeenCalledTimes(1));
  expect(save.mock.calls[0]).toEqual([null,expect.objectContaining({code:'WF-COPY',priority:7}),false,expect.any(String),{lineageId:'00000000-0000-0000-0000-0000000000aa',version:4}]);
 });
});

describe('03cb9b74: the redesigned form saves an existing workflow exactly as it was stored', () => {
  const second = '00000000-0000-0000-0000-000000000002';
  const [a1, a2, a3, e1, e2, d1, d2, g1, b1] = Array.from({ length: 9 }, (_, i) => `00000000-0000-4000-8000-00000000010${i}`);
  const stored = { companyId, companyIds: [companyId, second], allCompanies: false, version: 6, applicationType: 'irregularity', code: 'STORED', name: 'Stored workflow', description: 'Kept as saved', priority: 12, active: true };
  // Stored rows of every routing version, read the way the Edit page reads them (attendanceWorkflowConfiguration).
  const rows = {
    v1: { ...stored, routingVersion: 1, criteria: { departmentIds: [d2, d1], gradeIds: [g1] }, stages: [{ name: 'Manager review', level: { kind: 'direct_manager', employmentId: null, alternates: [{ kind: 'hr_admin', employmentId: null }] } }, { name: 'Final review', level: { kind: 'hr_admin', employmentId: null, alternates: [] } }] },
    v2: { ...stored, routingVersion: 2, criteria: { groups: [{ businessUnitIds: [b1] }, { orgDivision: ['v2'] }] }, stages: [{ name: 'Level 1', level: { kind: 'direct_manager', employmentId: null, alternates: [] } }, { name: 'Level 2', level: { kind: 'hr_admin', employmentId: null, alternates: [] } }] },
    v3: { ...stored, routingVersion: 3, criteria: { employeeIds: [e2, e1] }, stages: [{ name: 'Level 1', mode: 'sequential', source: { kind: 'specific_employee', employmentIds: [a2, a1] }, hrAlternative: false }, { name: 'Level 2', mode: 'any_one', source: { kind: 'direct_manager', depth: 2 }, hrAlternative: true }] },
    v4: { ...stored, routingVersion: 4, criteria: { groups: [{ departmentIds: [d1], employmentTypes: ['contract', 'full_time'], employeeIds: [e1] }, { orgBranch: ['br'], employeeIds: [e2, e1] }] },
      cc: [{ kind: 'direct_manager', depth: 2 }, { kind: 'specific_employee', employmentIds: [a3] }, { kind: 'custom_email', addresses: ['payroll@example.com', 'ops@example.com'] }],
      stages: [{ name: 'Level 1', mode: 'all_required', sources: [{ kind: 'direct_manager', depth: 1 }, { kind: 'specific_employee', employmentIds: [a1, a2] }], hrAlternative: false, escalateAfterDays: 4 },
        { name: 'Level 2', mode: 'any_one', sources: [{ kind: 'direct_manager', depth: 3 }], hrAlternative: true }] },
  } as const;
  const catalogues: AttendanceWorkflowOptions = { ...options, companies: [...options.companies, { id: second, name: 'Company B' }], departments: [{ id: d1, name: 'Finance' }, { id: d2, name: 'People' }], grades: [{ id: g1, name: 'Grade 1' }], businessUnits: [{ id: b1, name: 'Operations' }], profileFields: { orgBranch: [{ id: 'br', name: 'Port Klang' }] },
    employees: [{ id: e1, name: 'Fictional Criteria One', employeeCode: 'C001' }, { id: e2, name: 'Fictional Criteria Two', employeeCode: 'C002' }],
    approverEmployees: [{ id: a1, name: 'Fictional Approver One', employeeCode: 'A001' }, { id: a2, name: 'Fictional Approver Two', employeeCode: 'A002' }, { id: a3, name: 'Fictional CC Three', employeeCode: 'A003' }] };
  it.each(Object.keys(rows) as (keyof typeof rows)[])('opens and re-saves a stored %s workflow byte for byte', async version => {
    const configuration = attendanceWorkflowConfiguration(rows[version] as unknown as Parameters<typeof attendanceWorkflowConfiguration>[0]);
    const expected = JSON.stringify(configuration);
    render(<NextIntlClientProvider locale="en" messages={en}><WorkflowForm context={{ companyId, applicationType: 'irregularity' }} initial={configuration} lineageId="00000000-0000-0000-0000-0000000000ee" options={catalogues}/></NextIntlClientProvider>);
    // Looking around changes nothing: open and close every "More conditions", open and close a people search.
    for (const summary of screen.getAllByText(/^More conditions/, { selector: 'summary' })) { fireEvent.click(summary); fireEvent.click(summary); }
    searchEmployees.mockResolvedValue({ ok: true, value: { rows: [], more: false } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Employee / Employees' })[0]);
    await screen.findByText(en.attendanceWorkflow.noEmployeeMatches);
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' });
    expect(screen.queryByText(en.attendanceWorkflow.form.unsaved)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save workflow' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(save.mock.calls[0][1])).toBe(expected);
    expect(save.mock.calls[0][0]).toBe('00000000-0000-0000-0000-0000000000ee');
  });
  it('labels saved people and summarises each group from the saved choices', () => {
    const configuration = attendanceWorkflowConfiguration(rows.v4 as unknown as Parameters<typeof attendanceWorkflowConfiguration>[0]);
    render(<NextIntlClientProvider locale="en" messages={en}><WorkflowForm context={{ companyId, applicationType: 'irregularity' }} initial={configuration} lineageId="00000000-0000-0000-0000-0000000000ee" options={catalogues}/></NextIntlClientProvider>);
    expect(screen.getByText('Matches: Department is Finance, Employment Type is Contract or Full-time, and Employee / Employees is C001 · Fictional Criteria One')).toBeVisible();
    expect(screen.getByText(/^Matches: Branch is Port Klang/)).toBeVisible();
    // A group with an organisation condition opens "More conditions" by itself and counts it.
    const summaries = screen.getAllByText(/^More conditions/, { selector: 'summary' });
    expect(summaries[0].closest('details')).not.toHaveAttribute('open');
    expect(summaries[1].closest('details')).toHaveAttribute('open');
    expect(summaries[1]).toHaveTextContent('1 set');
    expect(screen.getByText('1. A001 · Fictional Approver One')).toBeVisible();
    expect(screen.getByText('1. A003 · Fictional CC Three')).toBeVisible();
    // Five numbered sections with live counts, and the CC sources in their own section.
    const index = screen.getByRole('navigation', { name: en.attendanceWorkflow.form.sections });
    expect(within(index).getAllByRole('link').map(link => link.getAttribute('href'))).toEqual(['#workflow-details', '#workflow-assignment', '#workflow-levels', '#workflow-cc', '#workflow-save']);
    expect(within(index).getByRole('link', { name: /Who it applies to/ })).toHaveTextContent('2 groups');
    expect(within(index).getByRole('link', { name: /Approval levels/ })).toHaveTextContent('2 levels');
    expect(within(screen.getByRole('region', { name: /CC recipients/ })).getByText('CC 3')).toBeVisible();
    expect(screen.getByText(`${en.attendanceWorkflow.v4.allRequired} – First-Level Direct Superior and 1 more source`)).toBeVisible();
    fireEvent.change(screen.getByLabelText('Workflow name'), { target: { value: 'Changed' } });
    expect(screen.getByText(en.attendanceWorkflow.form.unsaved)).toBeVisible();
  });
});
