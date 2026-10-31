import * as React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {beforeEach,describe,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({
 session:{tenantId:'fictional-tenant',personId:'fictional-person',userId:'fictional-login',roles:['employee'] as string[],entitlements:{tenantId:'fictional-tenant',enabledModules:[] as string[],scopedModules:{},settings:{},tenantStatus:'active'}},
 reports:[] as {id:string}[],aggregate:vi.fn(),assistant:vi.fn(),legacyEmployment:vi.fn(),reporting:vi.fn(),identity:vi.fn(),
}));
vi.mock('@/lib/scope',()=>({scopedSession:async()=>({s:state.session,scopeIds:['fictional-company'],allowedCount:1})}));
vi.mock('@/lib/authz',()=>({isAdmin:()=>state.session.roles.includes('hr_admin')}));
vi.mock('next-intl/server',()=>({getLocale:async()=>'en',getTranslations:async()=>(key:string)=>key}));
vi.mock('next/navigation',()=>({notFound:()=>{throw Error('not-found');}}));
vi.mock('@/components/employee-home/personal-home',()=>({EmployeePersonalHome:({employmentId,greetingsEnabled}:{employmentId?:string;greetingsEnabled:boolean})=>React.createElement('main',{'data-selected':employmentId,'data-greetings':String(greetingsEnabled)},'Personal Home')}));
vi.mock('@/core/employee-home',()=>({readEmployeeHomeIdentity:state.identity,HomeAccessError:class extends Error{constructor(readonly code:string){super(code);}}}));
vi.mock('@/core/read',()=>({
 myEmployment:state.legacyEmployment,reportingLinesFor:state.reporting,
 dashboardStats:state.aggregate,recentActivity:state.aggregate,listCompanies:state.aggregate,groupBreakdown:state.aggregate,
 recentHires:state.aggregate,upcomingHolidays:state.aggregate,awayTodayCount:state.aggregate,leaveBalances:state.aggregate,listApprovalHistory:state.aggregate,
}));
vi.mock('@/core/assistant-grant',()=>({mayUseAssistant:state.assistant}));
import DashboardPage from '../app/(app)/page';
import {HomeAccessError} from '../core/employee-home';
beforeEach(()=>{
 vi.clearAllMocks();state.session.roles=['employee'];state.session.entitlements.enabledModules=[];state.reports=[];
 state.legacyEmployment.mockImplementation(()=>{throw Error('legacy first-employment/compensation read must not run on personal Home');});
 state.reporting.mockImplementation(async()=>({reports:state.reports}));
 state.identity.mockResolvedValue({role:'employee',selectedEmploymentId:'selected-own'});
 state.aggregate.mockImplementation(()=>{throw Error('legacy aggregate must not run on personal Home');});
 state.assistant.mockImplementation(()=>{throw Error('assistant path must not run on personal Home');});
});
describe('personal web landing isolates legacy aggregate and assistant composition',()=>{
 it.each([true,false])('passes the resolved notifications entitlement to personal Home (%s)',async(enabled)=>{
  state.session.entitlements.enabledModules=enabled?['notifications']:[];
  const html=renderToStaticMarkup(await DashboardPage({searchParams:Promise.resolve({})}));
  expect(html).toContain('data-greetings="'+String(enabled)+'"');
  expect(state.aggregate).not.toHaveBeenCalled();expect(state.assistant).not.toHaveBeenCalled();
 });
 it('lands an employee directly on personal Home, including a supplied company/employment choice',async()=>{
  const html=renderToStaticMarkup(await DashboardPage({searchParams:Promise.resolve({employmentId:'selected-own'})}));
  expect(html).toContain('Personal Home');expect(html).toContain('data-selected="selected-own"');
  expect(state.legacyEmployment).not.toHaveBeenCalled();expect(state.reporting).not.toHaveBeenCalled();expect(state.identity).not.toHaveBeenCalled();
  expect(state.aggregate).not.toHaveBeenCalled();expect(state.assistant).not.toHaveBeenCalled();
 });
 it('keeps a manager on personal Home by default without first-employment, aggregate or assistant reads',async()=>{
  state.session.roles=['manager'];const html=renderToStaticMarkup(await DashboardPage({searchParams:Promise.resolve({})}));
  expect(html).toContain('Personal Home');expect(state.legacyEmployment).not.toHaveBeenCalled();expect(state.reporting).not.toHaveBeenCalled();expect(state.aggregate).not.toHaveBeenCalled();expect(state.assistant).not.toHaveBeenCalled();
 });
 it('does not let an employee opt into the manager path by editing the query string',async()=>{
  const html=renderToStaticMarkup(await DashboardPage({searchParams:Promise.resolve({workspace:'team'})}));
  expect(html).toContain('Personal Home');expect(state.aggregate).not.toHaveBeenCalled();expect(state.assistant).not.toHaveBeenCalled();
  expect(state.identity).toHaveBeenCalledWith(state.session,undefined);expect(state.legacyEmployment).not.toHaveBeenCalled();
 });
 it('uses the proven selected own manager employment for an explicit workbench, never the legacy first one',async()=>{
  state.identity.mockResolvedValueOnce({role:'manager',selectedEmploymentId:'own-second'});state.reports=[{id:'actual-report'}];
  await expect(DashboardPage({searchParams:Promise.resolve({workspace:'team',employmentId:'own-second'})})).rejects.toThrow('legacy aggregate');
  expect(state.identity).toHaveBeenCalledWith(state.session,'own-second');
  expect(state.reporting).toHaveBeenCalledWith(state.session,'own-second');expect(state.legacyEmployment).not.toHaveBeenCalled();
 });
 it('rejects ambiguous employment selection before composing Home',async()=>{
  await expect(DashboardPage({searchParams:Promise.resolve({employmentId:['one','two']})})).rejects.toThrow('not-found');
  expect(state.aggregate).not.toHaveBeenCalled();expect(state.assistant).not.toHaveBeenCalled();
 });
 it('refuses a foreign workbench selection before any legacy or aggregate read',async()=>{
  state.identity.mockRejectedValueOnce(new HomeAccessError('employmentUnavailable'));
  await expect(DashboardPage({searchParams:Promise.resolve({workspace:'team',employmentId:'foreign'})})).rejects.toThrow('not-found');
  expect(state.legacyEmployment).not.toHaveBeenCalled();expect(state.reporting).not.toHaveBeenCalled();expect(state.aggregate).not.toHaveBeenCalled();
 });
});
