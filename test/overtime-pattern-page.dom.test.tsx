import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import Page from '../app/admin/attendance/settings/overtime-patterns/page';
const m=vi.hoisted(()=>({scope:vi.fn(),companies:vi.fn(),list:vi.fn(),setup:vi.fn(),groups:vi.fn(),detail:vi.fn()}));
vi.mock('../lib/scope',()=>({scopedAdmin:m.scope}));
vi.mock('next-intl/server',()=>({getTranslations:async()=>((key:string)=>key.split('.').reduce((value:any,part)=>value?.[part],en.overtimePatterns)??key)}));
vi.mock('../packs/attendance/service',()=>({overtimePatternWorkspaceCompanies:m.companies,listOvertimePatterns:m.list,overtimePatternSetup:m.setup,listAttendanceRules:m.groups,getOvertimePattern:m.detail,attendanceGroupPolicyReview:vi.fn(),OvertimeOwnerError:class extends Error{}}));
vi.mock('../components/overtime-patterns/starter-initializer',()=>({OvertimeStarterInitializer:()=>null}));
vi.mock('../components/overtime-patterns/group-policy-review',()=>({OvertimeGroupPolicyReview:()=>null}));
vi.mock('../components/overtime-patterns/workspace',()=>({OvertimeWorkspace:()=>null}));
const active='10000000-0000-4000-8000-000000000001',archived='10000000-0000-4000-8000-000000000002',session={tenantId:'tenant'};
afterEach(cleanup);beforeEach(()=>{
 vi.clearAllMocks();m.scope.mockResolvedValue({s:session,scopeIds:[active,archived]});m.companies.mockResolvedValue([{id:active,name:'Active fictional company',currency:'MYR',minorScale:2}]);m.list.mockResolvedValue({items:[],nextCursor:null});m.setup.mockResolvedValue({companies:[],employees:[],earningItems:[],choices:{}});m.groups.mockResolvedValue([]);
});
describe('Overtime workspace tolerates historical company selections',()=>{
 it('passes only active currently-administrable selected companies to strict configuration owners',async()=>{
  render(<NextIntlClientProvider locale="en" messages={en}>{await Page({searchParams:Promise.resolve({})})}</NextIntlClientProvider>);
  expect(await screen.findByText(en.overtimePatterns.empty)).toBeVisible();expect(m.list).toHaveBeenCalledWith(session,expect.objectContaining({companyIds:[active]}));expect(m.setup).toHaveBeenCalledWith(session,{companyIds:[active],limit:100});
  expect(screen.getByRole('link',{name:en.overtimePatterns.create})).toBeVisible();
 });
 it('does not widen an empty eligible intersection to every company or mislabel it an empty tenant',async()=>{
  m.scope.mockResolvedValue({s:session,scopeIds:[archived]});render(<NextIntlClientProvider locale="en" messages={en}>{await Page({searchParams:Promise.resolve({})})}</NextIntlClientProvider>);
  expect(screen.getByRole('status')).toHaveTextContent(en.overtimePatterns.noActiveAdminScope);expect(m.list).not.toHaveBeenCalled();expect(m.setup).not.toHaveBeenCalled();expect(m.detail).not.toHaveBeenCalled();expect(screen.queryByText(en.overtimePatterns.empty)).toBeNull();expect(screen.queryByRole('link',{name:en.overtimePatterns.create})).toBeNull();
 });
});
