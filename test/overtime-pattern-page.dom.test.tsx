import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import Page from '../app/admin/attendance/settings/overtime-patterns/page';
const m=vi.hoisted(()=>({scope:vi.fn(),companies:vi.fn(),list:vi.fn(),setup:vi.fn(),groups:vi.fn(),detail:vi.fn(),workspace:vi.fn((_props:unknown)=>null)}));
vi.mock('../lib/scope',()=>({scopedAdmin:m.scope}));
vi.mock('next-intl/server',()=>({getTranslations:async()=>((key:string)=>key.split('.').reduce((value:any,part)=>value?.[part],en.overtimePatterns)??key)}));
vi.mock('../packs/attendance/service',()=>({overtimePatternWorkspaceCompanies:m.companies,listOvertimePatterns:m.list,overtimePatternSetup:m.setup,listAttendanceRules:m.groups,getOvertimePattern:m.detail,attendanceGroupPolicyReview:vi.fn(),OvertimeOwnerError:class extends Error{}}));
vi.mock('../components/overtime-patterns/starter-initializer',()=>({OvertimeStarterInitializer:()=>null}));
vi.mock('../components/overtime-patterns/group-policy-review',()=>({OvertimeGroupPolicyReview:()=>null}));
vi.mock('../components/overtime-patterns/workspace',()=>({OvertimeWorkspace:(props:unknown)=>m.workspace(props)}));
vi.mock('../app/admin/attendance/settings/overtime-patterns/legacy-bands',()=>({LegacyOvertimeBands:()=>null}));
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
 it('files a new pattern under the single selected company and asks for one company otherwise (b31981c0)',async()=>{
  render(<NextIntlClientProvider locale="en" messages={en}>{await Page({searchParams:Promise.resolve({new:'1'})})}</NextIntlClientProvider>);
  expect(m.workspace).toHaveBeenCalled();expect(m.workspace.mock.lastCall![0]).toMatchObject({detail:null,newPatternCompany:{id:active,currency:'MYR'}});
  cleanup();m.workspace.mockClear();
  const second='10000000-0000-4000-8000-000000000003';
  m.scope.mockResolvedValue({s:session,scopeIds:[active,second]});m.companies.mockResolvedValue([{id:active,name:'Active fictional company',currency:'MYR',minorScale:2},{id:second,name:'Second fictional company',currency:'SGD',minorScale:2}]);
  render(<NextIntlClientProvider locale="en" messages={en}>{await Page({searchParams:Promise.resolve({new:'1'})})}</NextIntlClientProvider>);
  expect(m.workspace.mock.lastCall![0]).toMatchObject({detail:null,newPatternCompany:null});
 });
 // 2f803985 — a legacy (Schedule Group) pattern opens on 1. General Settings with its group's band editor.
 it('mounts the relocated band editor for a legacy pattern only, carrying the group, pattern and refusal',async()=>{
  const {LegacyOvertimeBands}=await import('../app/admin/attendance/settings/overtime-patterns/legacy-bands');
  const pattern='20000000-0000-4000-8000-000000000001',group='30000000-0000-4000-8000-000000000001',version='40000000-0000-4000-8000-000000000001';
  m.detail.mockResolvedValue({pattern:{id:pattern,kind:'legacy',legacyRuleId:group},versions:[{id:version,ordinal:1,status:'active'}],assignments:[],writable:false});
  render(<NextIntlClientProvider locale="en" messages={en}>{await Page({searchParams:Promise.resolve({pattern,bandError:'Refused ladder',saveAck:'0'.repeat(32)})})}</NextIntlClientProvider>);
  const props=m.workspace.mock.lastCall![0] as {legacyEditor:{type:unknown;props:Record<string,unknown>}};
  expect(props.legacyEditor.type).toBe(LegacyOvertimeBands);
  expect(props.legacyEditor.props).toMatchObject({ruleId:group,patternId:pattern,error:'Refused ladder',savedReceipt:'0'.repeat(32)});
  cleanup();m.workspace.mockClear();
  m.detail.mockResolvedValue({pattern:{id:pattern,kind:'formula',legacyRuleId:null},versions:[{id:version,ordinal:1,status:'draft'}],assignments:[],writable:true});
  render(<NextIntlClientProvider locale="en" messages={en}>{await Page({searchParams:Promise.resolve({pattern,saveAck:'not-a-receipt'})})}</NextIntlClientProvider>);
  expect((m.workspace.mock.lastCall![0] as {legacyEditor?:unknown}).legacyEditor).toBeUndefined();
 });
});
