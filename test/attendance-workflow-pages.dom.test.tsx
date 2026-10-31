import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
const companyId = '00000000-0000-0000-0000-000000000001', other = '00000000-0000-0000-0000-000000000002', lineageId = '00000000-0000-0000-0000-000000000003', departmentId = '00000000-0000-0000-0000-000000000004';
const { service, scope, form, routing } = vi.hoisted(() => ({ service: { listAttendanceWorkflows: vi.fn(), listRetiredAttendanceWorkflows:vi.fn(), listAttendanceWorkflowSettings: vi.fn(), attendanceApplicationFilterOptions: vi.fn(), getAttendanceWorkflow: vi.fn(), previewAttendanceWorkflow: vi.fn() }, scope: vi.fn(), form: vi.fn(), routing: vi.fn() }));
vi.mock('../lib/scope', () => ({ scopedAdmin: scope }));
vi.mock('../packs/attendance/service', () => service);
vi.mock('next-intl/server', () => ({ getTranslations: async (namespace: string) => createTranslator({ locale: 'en', messages: en, namespace: namespace as 'attendanceWorkflow' }) }));
vi.mock('next/navigation', () => ({ useRouter:()=>({push:vi.fn(),refresh:vi.fn()}), notFound: () => { throw new Error('NOT_FOUND'); }, redirect: (href: string) => { throw new Error(`REDIRECT ${href}`); } }));
vi.mock('../app/(app)/admin/attendance/approval-workflow/workflow-form', () => ({ WorkflowForm: (props: unknown) => { form(props); return <div>Editor</div>; }, RoutingSwitch: (props: unknown) => { routing(props); return <div>Routing control</div>; } }));
vi.mock('../app/(app)/admin/attendance/approval-workflow/actions',()=>({retireAttendanceWorkflowAction:vi.fn(),restoreAttendanceWorkflowAction:vi.fn()}));
import Page from '../app/(app)/admin/attendance/approval-workflow/page';
import NewPage from '../app/(app)/admin/attendance/approval-workflow/new/page';
import EditPage from '../app/(app)/admin/attendance/approval-workflow/[lineageId]/edit/page';
import ViewPage from '../app/(app)/admin/attendance/approval-workflow/[lineageId]/page';
const options = { companies: [{ id: companyId, name: 'Company A' }, { id: other, name: 'Company B' }], departments: [{ id: departmentId, name: 'Finance' }], businessUnits: [], grades: [], divisions: [] };
const row = { id: 'version', lineageId, companyId, version: 2, code: 'CLOCK', name: 'Clock review', description: '', applicationType: 'irregularity', criteria: { departmentIds: [departmentId] }, stages: [{ name: 'Manager review', level: { kind: 'direct_manager', employmentId: null, alternates: [{ kind: 'hr_admin', employmentId: null }] } }], active: true, priority: 100 };
const show = (element: React.ReactNode) => render(<NextIntlClientProvider locale="en" messages={en}>{element}</NextIntlClientProvider>);
beforeEach(() => { vi.clearAllMocks(); scope.mockResolvedValue({ s: { actor: 'scoped admin' }, scopeIds: [companyId, other] }); service.listAttendanceWorkflows.mockResolvedValue([row, { ...row, id: 'ot-version', code: 'OT', applicationType: 'self_overtime' }]); service.listRetiredAttendanceWorkflows.mockResolvedValue([]); service.listAttendanceWorkflowSettings.mockResolvedValue([{ companyId, applicationType: 'irregularity', enabled: true }]); service.attendanceApplicationFilterOptions.mockImplementation(async (_, ids: string[]) => ({ ...options, companies: options.companies.filter(company => ids.includes(company.id)) })); service.getAttendanceWorkflow.mockResolvedValue(row); service.previewAttendanceWorkflow.mockResolvedValue({ total: 0, rows: [], truncated: false }); });
afterEach(cleanup);
describe('workflow company navigation and scope', () => {
  it('describes a saved named-person route with per-level guidance rather than legacy manager-only guidance', async () => {
    service.getAttendanceWorkflow.mockResolvedValue({...row,routingVersion:4,cc:[],stages:[{name:'Level 1',mode:'all_required',sources:[{kind:'specific_employee',employmentIds:[other]}],hrAlternative:false}]});
    service.attendanceApplicationFilterOptions.mockResolvedValue({...options,employees:[],approverEmployees:[{id:other,name:'Fictional named approver',employeeCode:'E00042'}]});
    show(await ViewPage({params:Promise.resolve({lineageId})}));
    expect(screen.getByText(/E00042 · Fictional named approver/)).toBeVisible();
    expect(screen.getByText(en.attendanceWorkflow.v3.levelHelp)).toBeVisible();
    expect(screen.queryByText(en.attendanceWorkflow.supportedApprovers)).not.toBeInTheDocument();
  });
  it('lists each company once with counts, including a company without workflows', async () => {
    show(await Page({ searchParams: Promise.resolve({}) }));
    const rows = screen.getAllByRole('row'); expect(rows).toHaveLength(3);
    expect(within(rows[1]).getByRole('cell', { name: 'Company A' })).toBeVisible(); expect(within(rows[1]).getByText('2')).toBeVisible();
    expect(within(rows[2]).getByRole('cell', { name: 'Company B' })).toBeVisible(); expect(within(rows[2]).getByText('0')).toBeVisible();
    expect(screen.queryByText('Routing control')).toBeNull();
    expect(screen.getByRole('link', { name: 'View / Edit Company A' })).toHaveAttribute('href', `/admin/attendance/approval-workflow?companyId=${companyId}&applicationType=irregularity`);
  });
  it('shows only the selected type with readable criteria and alternatives and a matching create context', async () => {
    show(await Page({ searchParams: Promise.resolve({ companyId, applicationType: 'irregularity' }) }));
    expect(service.listAttendanceWorkflows).toHaveBeenCalledWith(expect.anything(), [companyId]);
    expect(service.attendanceApplicationFilterOptions).toHaveBeenCalledWith(expect.anything(), [companyId]);
    expect(screen.getByText('CLOCK')).toBeVisible(); expect(screen.queryByText('OT')).toBeNull();
    expect(screen.getByText('Finance', { exact: false })).toBeVisible(); expect(screen.getByText(/Direct administrative manager or HR administrators/)).toBeVisible();
    expect(routing).toHaveBeenCalledWith({ companyId, type: 'irregularity', enabled: true });
    expect(screen.getByRole('link', { name: 'Create workflow' })).toHaveAttribute('href', `/admin/attendance/approval-workflow/new?companyId=${companyId}&applicationType=irregularity`);
    expect(screen.getByRole('link', { name: 'Attendance Irregularity' })).toHaveAttribute('aria-current', 'page');
  });
  it('has a distinct empty tab and disabled routing', async () => {
    service.listAttendanceWorkflows.mockResolvedValue([row]);
    show(await Page({ searchParams: Promise.resolve({ companyId, applicationType: 'self_overtime' }) }));
    expect(screen.getByText(en.attendanceWorkflow.empty)).toBeVisible();
    expect(routing).toHaveBeenCalledWith({ companyId, type: 'self_overtime', enabled: false });
  });
  it.each([{ companyId: 'bad' }, { companyId: ['one', 'two'] }, { companyId: '00000000-0000-0000-0000-000000000099' }, { companyId, applicationType: 'leave' }, { companyId, applicationType: ['irregularity'] }, { applicationType: 'self_overtime' }])('refuses invalid or foreign company context before service reads: %j', async query => {
    await expect(Page({ searchParams: Promise.resolve(query) })).rejects.toThrow('NOT_FOUND');
    await expect(NewPage({ searchParams: Promise.resolve(query) })).rejects.toThrow('NOT_FOUND');
    expect(service.listAttendanceWorkflows).not.toHaveBeenCalled(); expect(service.attendanceApplicationFilterOptions).not.toHaveBeenCalled();
  });
  it('sends legacy creation bookmarks to company selection and fixes explicit new context', async () => {
    await expect(NewPage({ searchParams: Promise.resolve({}) })).rejects.toThrow('REDIRECT /admin/attendance/approval-workflow');
    show(await NewPage({ searchParams: Promise.resolve({ companyId, applicationType: 'self_overtime' }) }));
    expect(form).toHaveBeenCalledWith(expect.objectContaining({ initial: null, context: { companyId, applicationType: 'self_overtime' }, options: expect.objectContaining({ companies: [options.companies[0]] }) }));
  });
  it('keeps lineage view/edit links scoped to the actual stored company and type', async () => {
    show(await ViewPage({ params: Promise.resolve({ lineageId }) }));
    expect(screen.getByRole('link', { name: /Back to workflows/ })).toHaveAttribute('href', `/admin/attendance/approval-workflow?companyId=${companyId}&applicationType=irregularity`);
    cleanup(); show(await EditPage({ params: Promise.resolve({ lineageId }) }));
    expect(service.attendanceApplicationFilterOptions).toHaveBeenCalledWith(expect.anything(), [companyId]);
    expect(form).toHaveBeenCalledWith(expect.objectContaining({ context: { companyId, applicationType: 'irregularity' } }));
  });
  it('rejects malformed lineage before SQL and absent/unscoped lineages before loading options', async () => {
    for (const page of [ViewPage, EditPage]) await expect(page({ params: Promise.resolve({ lineageId: 'invalid' }) })).rejects.toThrow('NOT_FOUND');
    expect(service.getAttendanceWorkflow).not.toHaveBeenCalled();
    service.getAttendanceWorkflow.mockResolvedValue(null);
    for (const page of [ViewPage, EditPage]) await expect(page({ params: Promise.resolve({ lineageId }) })).rejects.toThrow('NOT_FOUND');
    expect(service.attendanceApplicationFilterOptions).not.toHaveBeenCalled();
  });
});
