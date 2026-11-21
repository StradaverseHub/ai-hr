import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createFormatter, createTranslator, NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
const companyId = '00000000-0000-0000-0000-000000000001', other = '00000000-0000-0000-0000-000000000002', lineageId = '00000000-0000-0000-0000-000000000003', departmentId = '00000000-0000-0000-0000-000000000004';
const { service, scope, form } = vi.hoisted(() => ({ service: { listAttendanceWorkflows: vi.fn(), listRetiredAttendanceWorkflows:vi.fn(), attendanceApplicationFilterOptions: vi.fn(), getAttendanceWorkflow: vi.fn(), previewAttendanceWorkflow: vi.fn(),attendanceWorkflowWarningPage:vi.fn(), getAttendanceWorkflowPreview: vi.fn(), listAttendanceWorkflowPreviews: vi.fn() }, scope: vi.fn(), form: vi.fn() }));
vi.mock('../lib/scope', () => ({ scopedAdmin: scope }));
vi.mock('../packs/attendance/service', () => service);
vi.mock('next-intl/server', () => ({ getTranslations: async (namespace: string) => createTranslator({ locale: 'en', messages: en, namespace: namespace as 'attendanceWorkflow' }), getFormatter:async()=>createFormatter({locale:'en'}) }));
vi.mock('next/navigation', () => ({ useRouter:()=>({push:vi.fn(),refresh:vi.fn()}), notFound: () => { throw new Error('NOT_FOUND'); }, redirect: (href: string) => { throw new Error(`REDIRECT ${href}`); } }));
vi.mock('../app/admin/attendance/approval-workflow/workflow-form', () => ({ WorkflowForm: (props: unknown) => { form(props); return <div>Editor</div>; } }));
vi.mock('../app/admin/attendance/approval-workflow/actions',()=>({retireAttendanceWorkflowAction:vi.fn(),restoreAttendanceWorkflowAction:vi.fn(),archiveAttendanceWorkflowAction:vi.fn(),attendanceWorkflowWarningPageAction:vi.fn(),generateAttendanceWorkflowPreviewAction:vi.fn()}));
import Page from '../app/admin/attendance/approval-workflow/page';
import NewPage from '../app/admin/attendance/approval-workflow/new/page';
import EditPage from '../app/admin/attendance/approval-workflow/[lineageId]/edit/page';
import ViewPage from '../app/admin/attendance/approval-workflow/[lineageId]/page';
import PreviewsPage from '../app/admin/attendance/approval-workflow/[lineageId]/previews/page';
const options = { companies: [{ id: companyId, name: 'Company A' }, { id: other, name: 'Company B' }], departments: [{ id: departmentId, name: 'Finance' }], businessUnits: [], grades: [], divisions: [] };
const row = { companyIds:[companyId], id: 'version', lineageId, companyId, version: 2, code: 'CLOCK', name: 'Clock review', description: '', applicationType: 'irregularity', criteria: { departmentIds: [departmentId] }, stages: [{ name: 'Manager review', level: { kind: 'direct_manager', employmentId: null, alternates: [{ kind: 'hr_admin', employmentId: null }] } }], active: true, priority: 100 };
const show = (element: React.ReactNode) => render(<NextIntlClientProvider locale="en" messages={en}>{element}</NextIntlClientProvider>);
beforeEach(() => { vi.clearAllMocks(); scope.mockResolvedValue({ s: { actor: 'scoped admin' }, scopeIds: [companyId, other] }); service.listAttendanceWorkflows.mockResolvedValue([row, { ...row, id: 'ot-version', code: 'OT', applicationType: 'self_overtime' }]); service.listRetiredAttendanceWorkflows.mockResolvedValue([]); service.attendanceApplicationFilterOptions.mockImplementation(async (_, ids: string[]) => ({ ...options, companies: options.companies.filter(company => ids.includes(company.id)) })); service.getAttendanceWorkflow.mockResolvedValue(row); service.previewAttendanceWorkflow.mockResolvedValue({ total: 0, rows: [], truncated: false }); service.attendanceWorkflowWarningPage.mockResolvedValue({rows:[],total:0,offset:0,hasMore:false}); service.getAttendanceWorkflowPreview.mockResolvedValue(null); service.listAttendanceWorkflowPreviews.mockResolvedValue([]); });
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
  it('opens the workflow configuration directly with separate categories and assigned companies',async()=>{
    service.listAttendanceWorkflows.mockResolvedValue([{...row,companyIds:[companyId,other]}]);
    show(await Page({searchParams:Promise.resolve({})}));
    expect(screen.getByText('CLOCK')).toBeVisible();
    expect(screen.getByRole('cell',{name:'Company A, Company B'})).toBeVisible();
    expect(screen.getByRole('link',{name:'Attendance Irregularity'})).toHaveAttribute('aria-current','page');
    expect(screen.getByRole('link',{name:'Self Overtime'})).toHaveAttribute('href','/admin/attendance/approval-workflow?applicationType=self_overtime');
    expect(screen.queryByRole('link',{name:'View / Edit Company A'})).toBeNull();
    expect(screen.getByRole('link',{name:'Create workflow'})).toHaveAttribute('href','/admin/attendance/approval-workflow/new?applicationType=irregularity');
  });
  it('keeps bookmarks scoped while loading all permitted choices for shared configuration',async()=>{
    show(await Page({searchParams:Promise.resolve({companyId,applicationType:'irregularity'})}));
    expect(service.listAttendanceWorkflows).toHaveBeenCalledWith(expect.anything(),[companyId]);
    expect(service.attendanceApplicationFilterOptions).toHaveBeenCalledWith(expect.anything(),[companyId,other]);
    expect(screen.getByText('CLOCK')).toBeVisible();expect(screen.queryByText('OT')).toBeNull();
    expect(screen.queryByText(en.attendanceWorkflow.disableRouting)).toBeNull();
  });
  it('has a distinct empty tab without a routing control', async () => {
    service.listAttendanceWorkflows.mockResolvedValue([row]);
    show(await Page({ searchParams: Promise.resolve({ companyId, applicationType: 'self_overtime' }) }));
    expect(screen.getByText(en.attendanceWorkflow.empty)).toBeVisible();
    expect(screen.queryByText(en.attendanceWorkflow.enableRouting)).toBeNull();
  });
  it.each([{ companyId: 'bad' }, { companyId: ['one', 'two'] }, { companyId: '00000000-0000-0000-0000-000000000099' }, { companyId, applicationType: 'leave' }, { companyId, applicationType: ['irregularity'] }])('refuses invalid or foreign company context before service reads: %j', async query => {
    await expect(Page({ searchParams: Promise.resolve(query) })).rejects.toThrow('NOT_FOUND');
    await expect(NewPage({ searchParams: Promise.resolve(query) })).rejects.toThrow('NOT_FOUND');
    expect(service.listAttendanceWorkflows).not.toHaveBeenCalled(); expect(service.attendanceApplicationFilterOptions).not.toHaveBeenCalled();
  });
  it('opens creation directly and offers all permitted company assignments',async()=>{
    show(await NewPage({searchParams:Promise.resolve({applicationType:'self_overtime'})}));
    expect(form).toHaveBeenCalledWith(expect.objectContaining({initial:null,context:{companyId,applicationType:'self_overtime'},options:expect.objectContaining({companies:options.companies})}));
  });
  it('keeps lineage view/edit links scoped to the actual stored company and type', async () => {
    show(await ViewPage({ params: Promise.resolve({ lineageId }) }));
    expect(screen.getByRole('link', { name: /Back to workflows/ })).toHaveAttribute('href', `/admin/attendance/approval-workflow?companyId=${companyId}&applicationType=irregularity`);
    cleanup(); show(await EditPage({ params: Promise.resolve({ lineageId }) }));
    expect(service.attendanceApplicationFilterOptions).toHaveBeenCalledWith(expect.anything(), [companyId,other],[]);
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

describe('4452ba3c: Copy Workflow, OR groups and stored Preview History',()=>{
  const previewId='00000000-0000-0000-0000-000000000005',older='00000000-0000-0000-0000-000000000006';
  const stored={id:previewId,lineageId,templateVersion:1,generatedAt:new Date('2026-11-10T06:05:00Z'),totalMatching:42,warningCount:2,truncated:true,generatedBy:'Fictional HR Administrator',companyIds:[companyId],
    warnings:[{employmentId:'e1',employeeCode:'EMP-0052',name:'Fictional Daniel',companyId,levelIndex:0,source:{kind:'direct_manager',depth:1},approverName:'Fictional Farid',approverCode:'EMP-0012',problem:{code:'missing_or_ambiguous_login',levelIndex:0},superiorProblem:'no_login',superiorDepth:null,conflict:null},
      {employmentId:'e2',employeeCode:'EMP-0015',name:'Fictional Siti',companyId,levelIndex:1,source:{kind:'direct_manager',depth:2},approverName:'Fictional Kevin',approverCode:'EMP-0020',problem:{code:'inactive_superior',levelIndex:1},superiorProblem:'superior_inactive',superiorDepth:null,conflict:null}],
    employees:[{employmentId:'e3',employeeCode:'EMP-0007',name:'Fictional Jason',companyId,selectedCode:'CLOCK',outcome:'routed',levels:[{level:1,state:'resolved',approvers:[{name:'Fictional Mei Ling',employeeCode:'EMP-0018',kind:'direct_manager'}]},{level:2,state:'skipped',approvers:[]},{level:3,state:'skipped',approvers:[]}]},
      {employmentId:'e1',employeeCode:'EMP-0052',name:'Fictional Daniel',companyId,selectedCode:'CLOCK',outcome:'warning',levels:[]}]};
  it('lists Copy and Preview History for each workflow row',async()=>{
    show(await Page({searchParams:Promise.resolve({})}));
    expect(screen.getByRole('link',{name:'Copy workflow CLOCK'})).toHaveAttribute('href',`/admin/attendance/approval-workflow/new?applicationType=irregularity&copyFrom=${lineageId}`);
    expect(screen.getByRole('link',{name:'Preview history for CLOCK'})).toHaveAttribute('href',`/admin/attendance/approval-workflow/${lineageId}/previews`);
  });
  it('opens Create Workflow from a copy with code, name and description blank and every other setting kept',async()=>{
    service.getAttendanceWorkflow.mockResolvedValue({...row,routingVersion:4,cc:[],allCompanies:false,companyIds:[companyId,other],description:'Original description',criteria:{groups:[{departmentIds:[departmentId]},{employmentTypes:['contract']}]},stages:[{name:'Level 1',mode:'sequential',sources:[{kind:'direct_manager',depth:1}],hrAlternative:false},{name:'Level 2',mode:'any_one',sources:[{kind:'direct_manager',depth:2}],hrAlternative:true}]});
    show(await NewPage({searchParams:Promise.resolve({applicationType:'irregularity',copyFrom:lineageId})}));
    const props=form.mock.calls.at(-1)![0] as {initial:Record<string,unknown>;lineageId:string|null;copiedFrom:unknown;context:unknown};
    expect(props.lineageId).toBeNull();
    expect(props.copiedFrom).toEqual({lineageId,version:2,code:'CLOCK'});
    expect(props.context).toEqual({companyId,applicationType:'irregularity'});
    expect(props.initial).toMatchObject({code:'',name:'',description:'',priority:100,companyIds:[companyId,other],routingVersion:4,criteria:{groups:[{departmentIds:[departmentId]},{employmentTypes:['contract']}]},stages:[{mode:'sequential'},{mode:'any_one',hrAlternative:true,sources:[{kind:'direct_manager',depth:2}]}]});
    expect(props.initial).not.toHaveProperty('expectedVersion');
  });
  it('refuses to copy a workflow outside the administrator scope or of another application type',async()=>{
    service.getAttendanceWorkflow.mockResolvedValue(null);
    await expect(NewPage({searchParams:Promise.resolve({applicationType:'irregularity',copyFrom:lineageId})})).rejects.toThrow('NOT_FOUND');
    service.getAttendanceWorkflow.mockResolvedValue(row);
    await expect(NewPage({searchParams:Promise.resolve({applicationType:'self_overtime',copyFrom:lineageId})})).rejects.toThrow('NOT_FOUND');
    await expect(NewPage({searchParams:Promise.resolve({copyFrom:'not-a-workflow'})})).rejects.toThrow('NOT_FOUND');
  });
  it('opens the saved workflow without recalculating and shows OR groups and the latest stored preview with an older-version banner',async()=>{
    service.getAttendanceWorkflow.mockResolvedValue({...row,criteria:{groups:[{departmentIds:[departmentId]},{employmentTypes:['contract']}]}});
    service.getAttendanceWorkflowPreview.mockResolvedValue(stored);
    show(await ViewPage({params:Promise.resolve({lineageId}),searchParams:Promise.resolve({notice:'saved'})}));
    expect(service.previewAttendanceWorkflow).not.toHaveBeenCalled();expect(service.attendanceWorkflowWarningPage).not.toHaveBeenCalled();
    expect(screen.getByText('Group 1')).toBeVisible();expect(screen.getByText('Group 2')).toBeVisible();expect(screen.getByText('OR')).toBeVisible();
    expect(screen.getByText(en.attendanceWorkflow.previewHistory.savedHint)).toBeVisible();
    expect(screen.getByText(/This preview was generated for version 1\. The workflow has been saved since and is now version 2/)).toBeVisible();
    expect(screen.getByRole('button',{name:'Generate new preview'})).toBeEnabled();
    expect(screen.getByRole('link',{name:'Open preview history'})).toHaveAttribute('href',`/admin/attendance/approval-workflow/${lineageId}/previews?id=${previewId}`);
  });
  it('renders Preview History with specific warnings, the approver and source, skipped levels and earlier previews',async()=>{
    service.getAttendanceWorkflowPreview.mockResolvedValue(stored);
    service.listAttendanceWorkflowPreviews.mockResolvedValue([{...stored,id:previewId},{...stored,id:older,templateVersion:1,generatedAt:new Date('2026-11-06T01:40:00Z')}]);
    show(await PreviewsPage({params:Promise.resolve({lineageId}),searchParams:Promise.resolve({id:previewId})}));
    expect(service.getAttendanceWorkflowPreview).toHaveBeenCalledWith(expect.anything(),lineageId,[companyId,other],previewId);
    expect(screen.getByRole('heading',{name:'Configuration Warnings (2)'})).toBeVisible();
    expect(screen.getByRole('heading',{name:'Matching Employees (42)'})).toBeVisible();
    expect(screen.getByText('First-Level Direct Superior: Fictional Farid · EMP-0012')).toBeVisible();
    expect(screen.getByText(en.attendanceWorkflow.previewHistory.problems.no_login)).toBeVisible();
    expect(screen.getByText(en.attendanceWorkflow.previewHistory.problems.superior_inactive)).toBeVisible();
    expect(screen.queryByText(en.attendanceWorkflow.v3.identityUnavailable)).toBeNull();
    expect(screen.getAllByText(en.attendanceWorkflow.previewHistory.notRequired)).toHaveLength(2);
    expect(screen.getByText('Fictional Mei Ling · EMP-0018')).toBeVisible();
    expect(screen.getByText(/Showing the first 2 of 42 employees/)).toBeVisible();
    expect(screen.getByText(/This preview was generated for version 1/)).toBeVisible();
    expect(screen.getByRole('link',{current:'page'})).toHaveAttribute('href',`/admin/attendance/approval-workflow/${lineageId}/previews?id=${previewId}`);
  });
  it('returns not found for an unknown preview or an unmanaged workflow',async()=>{
    await expect(PreviewsPage({params:Promise.resolve({lineageId}),searchParams:Promise.resolve({id:previewId})})).rejects.toThrow('NOT_FOUND');
    await expect(PreviewsPage({params:Promise.resolve({lineageId}),searchParams:Promise.resolve({id:'bad'})})).rejects.toThrow('NOT_FOUND');
    service.getAttendanceWorkflow.mockResolvedValue(null);
    await expect(PreviewsPage({params:Promise.resolve({lineageId})})).rejects.toThrow('NOT_FOUND');
  });
});
