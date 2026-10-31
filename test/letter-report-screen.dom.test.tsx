import {afterEach,beforeEach,it,expect,vi} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
const mocks=vi.hoisted(()=>({access:vi.fn(),departments:vi.fn(),read:vi.fn()}));
vi.mock('../core/letters',()=>({letterCompanyAccess:mocks.access,letterReportDepartments:mocks.departments,readLetterReport:mocks.read}));
vi.mock('../lib/authz',()=>({requireModule:async()=>({})}));
vi.mock('../lib/scope',()=>({scopedSession:async()=>({s:{tenantId:'fixture',userId:'current-user'},scopeIds:['00000000-0000-4000-8000-000000000001']})}));
vi.mock('next-intl/server',()=>({getLocale:async()=>'en',getTranslations:async()=>((key:string)=>key)}));
import ReportsPage from '../app/(app)/letters/reports/page';
import {LetterReportDownloads} from '../components/letters/report-downloads';
const companyId='00000000-0000-4000-8000-000000000001',hash='e'.repeat(64),labels={excel:'Excel',pdf:'PDF',working:'Preparing',errors:{stale:'Refresh the changed report',permission:'Sign in and check permission',unavailable:'Try again'}};
beforeEach(()=>{vi.clearAllMocks();mocks.access.mockResolvedValue([{id:companyId,name:'Fictional company',read:true,report:true}]);mocks.departments.mockResolvedValue([]);mocks.read.mockResolvedValue({summary:{total:37,issued:4,pendingApproval:2,pendingAcknowledgement:1,approvalOverdue:1,acknowledgementOverdue:0,void:0,meanApprovalHours:null,meanIssueHours:3,meanAcknowledgementHours:null},dataHash:hash,generatedAt:'2026-10-26T12:00:00Z',generatedBy:'current-user',nextCursor:null,rows:[{id:companyId,reference:'HR/2026/00001',state:'issued',employee_name:'Fictional Employee',employee_code:'0001',company_name:'Fictional company',department_name:null,title:'Fictional title',category:'confirmation',issued_at:'2026-10-26T11:00:00Z',acknowledged_at:null,approval_hours:null,issue_hours:3,organisation_ambiguous:false,approval_overdue:false,acknowledgement_overdue:false}]});});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('shows complete-scope counts separately from the displayed page and provides labelled filters',async()=>{
 render(await ReportsPage({searchParams:Promise.resolve({companyId,from:'2026-10-01',to:'2026-10-26'})}));expect(screen.getByText('37')).toBeTruthy();expect(screen.getByText('Fictional Employee - 0001')).toBeTruthy();expect(screen.getByLabelText('company')).toBeTruthy();expect(screen.getByLabelText('department')).toBeTruthy();expect(screen.getByLabelText('from')).toBeTruthy();expect(mocks.read).toHaveBeenCalledExactlyOnceWith({tenantId:'fixture',userId:'current-user'},{companyId,companyIds:[companyId],from:'2026-10-01',to:'2026-10-26'});
});
it('shows an unavailable permission state without presenting fabricated empty report counts',async()=>{
 mocks.access.mockResolvedValue([]);render(await ReportsPage({searchParams:Promise.resolve({})}));expect(screen.getByText('noAccess')).toBeTruthy();expect(mocks.read).not.toHaveBeenCalled();expect(screen.queryByText('metrics.total')).toBeNull();
});
it('keeps a stale report export actionable without presenting a successful download',async()=>{
 const fetcher=vi.fn().mockResolvedValue({ok:false,status:409,json:async()=>({error:'stale'})});vi.stubGlobal('fetch',fetcher);render(<LetterReportDownloads query={'hash='+hash} labels={labels}/>);await userEvent.setup().click(screen.getByRole('button',{name:'Excel'}));expect((await screen.findByRole('alert')).textContent).toBe(labels.errors.stale);expect(fetcher).toHaveBeenCalledWith('/letters/reports/export?hash='+hash+'&format=xlsx',{cache:'no-store'});
});
it('does not download an authentication page as a report and never renders unknown server diagnostics',async()=>{
 const fetcher=vi.fn().mockResolvedValue({ok:true,status:200,redirected:true,headers:new Headers({'content-type':'text/html'})});vi.stubGlobal('fetch',fetcher);render(<LetterReportDownloads query={'hash='+hash} labels={labels}/>);await userEvent.setup().click(screen.getByRole('button',{name:'PDF'}));expect((await screen.findByRole('alert')).textContent).toBe(labels.errors.permission);
 fetcher.mockResolvedValue({ok:false,status:503,json:async()=>({error:'__proto__'})});await userEvent.setup().click(screen.getByRole('button',{name:'Excel'}));expect((await screen.findByRole('alert')).textContent).toBe(labels.errors.unavailable);
});

it('keeps company choices and all-company report reads inside the current company selection',async()=>{
 mocks.access.mockResolvedValue([{id:companyId,name:'Selected company',read:true,report:true},{id:'00000000-0000-4000-8000-000000000002',name:'Unselected company',read:true,report:true}]);
 render(await ReportsPage({searchParams:Promise.resolve({from:'2026-10-01',to:'2026-10-26'})}));expect(screen.queryByRole('option',{name:'Unselected company'})).toBeNull();expect(mocks.read).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({companyIds:[companyId]}));expect(mocks.departments).toHaveBeenCalledWith(expect.anything(),undefined,[companyId]);
});
