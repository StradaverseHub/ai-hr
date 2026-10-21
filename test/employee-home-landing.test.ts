import * as React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {beforeEach,describe,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({
 session:{tenantId:'fictional-tenant',personId:'fictional-person',userId:'fictional-login',roles:['employee'] as string[]},
 reports:[] as {id:string}[],aggregate:vi.fn(),assistant:vi.fn(),
}));
vi.mock('@/lib/scope',()=>({scopedSession:async()=>({s:state.session,scopeIds:['fictional-company'],allowedCount:1})}));
vi.mock('@/lib/authz',()=>({isAdmin:()=>state.session.roles.includes('hr_admin')}));
vi.mock('next-intl/server',()=>({getLocale:async()=>'en',getTranslations:async()=>(key:string)=>key}));
vi.mock('next/navigation',()=>({notFound:()=>{throw Error('not-found');}}));
vi.mock('@/components/employee-home/personal-home',()=>({EmployeePersonalHome:({employmentId,teamWorkbench}:{employmentId?:string;teamWorkbench?:boolean})=>React.createElement('main',{'data-selected':employmentId,'data-team':String(teamWorkbench)},'Personal Home')}));
vi.mock('@/core/read',()=>({
 myEmployment:async()=>({employmentId:'own'}),reportingLinesFor:async()=>({reports:state.reports}),
 dashboardStats:state.aggregate,recentActivity:state.aggregate,listCompanies:state.aggregate,groupBreakdown:state.aggregate,
 recentHires:state.aggregate,upcomingHolidays:state.aggregate,awayTodayCount:state.aggregate,leaveBalances:state.aggregate,listApprovalHistory:state.aggregate,
}));
vi.mock('@/core/assistant-grant',()=>({mayUseAssistant:state.assistant}));
import DashboardPage from '../app/page';
beforeEach(()=>{
 vi.clearAllMocks();state.session.roles=['employee'];state.reports=[];
 state.aggregate.mockImplementation(()=>{throw Error('legacy aggregate must not run on personal Home');});
 state.assistant.mockImplementation(()=>{throw Error('assistant path must not run on personal Home');});
});
describe('personal web landing isolates legacy aggregate and assistant composition',()=>{
 it('lands an employee directly on personal Home, including a supplied company/employment choice',async()=>{
  const html=renderToStaticMarkup(await DashboardPage({searchParams:Promise.resolve({employmentId:'selected-own'})}));
  expect(html).toContain('Personal Home');expect(html).toContain('data-selected="selected-own"');expect(html).toContain('data-team="false"');
  expect(state.aggregate).not.toHaveBeenCalled();expect(state.assistant).not.toHaveBeenCalled();
 });
 it('keeps an actual organizational manager on personal Home by default with the separate workbench affordance',async()=>{
  state.reports=[{id:'actual-report'}];const html=renderToStaticMarkup(await DashboardPage({searchParams:Promise.resolve({})}));
  expect(html).toContain('data-team="true"');expect(state.aggregate).not.toHaveBeenCalled();expect(state.assistant).not.toHaveBeenCalled();
 });
 it('does not let an employee opt into the manager path by editing the query string',async()=>{
  const html=renderToStaticMarkup(await DashboardPage({searchParams:Promise.resolve({workspace:'team'})}));
  expect(html).toContain('Personal Home');expect(state.aggregate).not.toHaveBeenCalled();expect(state.assistant).not.toHaveBeenCalled();
 });
 it('rejects ambiguous employment selection before composing Home',async()=>{
  await expect(DashboardPage({searchParams:Promise.resolve({employmentId:['one','two']})})).rejects.toThrow('not-found');
  expect(state.aggregate).not.toHaveBeenCalled();expect(state.assistant).not.toHaveBeenCalled();
 });
});
