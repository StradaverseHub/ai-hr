import React, {isValidElement} from 'react';
import {beforeEach,describe,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({session:vi.fn(),operator:vi.fn(),tasks:vi.fn()}));
vi.mock('next/font/google',()=>{const font=()=>({variable:'fixture-font'});return {Plus_Jakarta_Sans:font,Geist_Mono:font,DM_Mono:font};});
vi.mock('next/font/local',()=>({default:()=>({variable:'fixture-schibsted-font'})}));
vi.mock('next/headers',()=>({headers:async()=>new Headers({'x-pathname':'/admin/settings/email'}),cookies:async()=>({get:()=>undefined})}));
vi.mock('next-intl/server',()=>({getLocale:async()=>'en'}));
vi.mock('../lib/session',()=>({getSession:m.session}));
vi.mock('../lib/identity/email-settings',()=>({canConfigureIdentityEmail:m.operator}));
vi.mock('../lib/viewer',()=>({viewerIdentity:async()=>({name:'Fixture',employeeCode:null,employed:false})}));
vi.mock('../lib/principals',()=>({listPrincipals:async()=>[]}));
vi.mock('../lib/demo-mode',()=>({demoSwitcherEnabled:()=>true,isDemoDeployment:()=>true}));
vi.mock('../lib/scope',()=>({getScopeIds:async()=>[]}));
vi.mock('../lib/ui-theme-server',()=>({currentUiTheme:async()=>'monolith'}));
vi.mock('../core/read',()=>({allowedCompanies:async()=>[],listApprovalHistory:async()=>[]}));
// New capability owners are independent of SMTP installation enrollment and the legacy rail.
// This shell test controls those boundaries; their actual permission algebra is covered by DB cases.
vi.mock('../core/access-configuration-editor',()=>({canConfigureAccess:async()=>false}));
vi.mock('../core/workforce-access',()=>({workforceViewScope:async()=>({canOpen:false,companyIds:[]})}));
vi.mock('../core/onboarding',()=>({getOnboardingStatus:async()=>true}));
vi.mock('../core/approvals-inbox',()=>({listPendingTasks:m.tasks}));
vi.mock('../core/notifications',()=>({dispatchNotifications:async()=>{},listNotifications:async()=>[],unreadNotificationCount:async()=>0}));
vi.mock('../core/entitlements',()=>({isModuleEnabled:()=>false,isModuleEnabledOrFalse:()=>false}));
vi.mock('../components/command-bar',()=>({CommandBar:()=>null}));
vi.mock('../components/notice/notice-surfaces',()=>({NoticePopupSlot:()=>null}));
vi.mock('../components/user-menu',()=>({UserMenu:()=>null}));
vi.mock('../components/dev-identity-switcher',()=>({DevIdentitySwitcher:()=>null}));
vi.mock('../components/company-switcher',()=>({CompanySwitcher:()=>null}));
import Layout from '../app/layout';
import {Sidebar} from '../components/sidebar';
beforeEach(()=>{m.tasks.mockReset();m.tasks.mockResolvedValue([]);});
function sidebarProps(node:React.ReactNode):Record<string,unknown>|undefined{
 if(Array.isArray(node)){for(const child of node){const found=sidebarProps(child);if(found)return found;}return;}
 if(!isValidElement<{children?:React.ReactNode}>(node))return;
 if(node.type===Sidebar)return node.props;
 return sidebarProps(node.props.children);
}
describe('root layout SMTP preview authority',()=>{
 it.each([
  {roles:['hr_admin'],preview:true,rail:true},
  {roles:['super_admin'],preview:true,rail:true},
  {roles:['payroll_partner'],preview:false,rail:true},
  {roles:['performance_comp_partner'],preview:false,rail:true},
  {roles:['manager','payroll_partner'],preview:false,rail:true},
  {roles:['employee'],preview:false,rail:false},
 ])('keeps preview eligibility separate from the broader rail for $roles',async({roles,preview,rail})=>{
  m.session.mockResolvedValue({tenantId:'tenant',userId:'user',roles,grants:roles.map(role=>({role,companyId:null}))});m.operator.mockResolvedValue(false);
  const props=sidebarProps(await Layout({children:<span>Fixture content</span>}));expect(props).toBeDefined();expect(props!.isAdmin).toBe(rail);expect(props!.canPreviewIdentityEmail).toBe(preview);expect(props!.canReviewProfileChanges).toBe(preview);expect(props!.canConfigureIdentityEmail).toBe(false);
 });
 it('passes enrolled installation authority independently of HR role',async()=>{
  m.session.mockResolvedValue({tenantId:'tenant',userId:'operator',roles:['employee'],grants:[]});m.operator.mockResolvedValue(true);
  const props=sidebarProps(await Layout({children:null}));expect(props).toBeDefined();expect(props!.isAdmin).toBe(false);expect(props!.canPreviewIdentityEmail).toBe(false);expect(props!.canReviewProfileChanges).toBe(false);expect(props!.canConfigureIdentityEmail).toBe(true);
 });
});

describe('root layout assigned Attendance inbox navigation',()=>{
 it.each(['attendance','leave'])('reuses canonical %s task data without granting manager or team authority',async kind=>{
  m.session.mockResolvedValue({tenantId:'tenant',userId:'employee',roles:['employee'],grants:[]});
  m.operator.mockResolvedValue(false);
  m.tasks.mockResolvedValue([{id:'fictional-task',kind,subjectName:'Fictional colleague',createdAt:new Date().toISOString(),linkPath:'/approvals'}]);
  const props=sidebarProps(await Layout({children:null}));
  expect(m.tasks).toHaveBeenCalledTimes(1);
  expect(props!.hasAssignedAttendanceApproval).toBe(kind==='attendance');
  expect(props!.canApprove).toBe(false);
  expect(props!.canAccessTeam).toBe(false);
  expect(props!.isAdmin).toBe(false);
  expect(props!.approvalCount).toBe(1);
 });
 it('keeps relocated Profile Changes in My tasks while counting only Approval Items destinations',async()=>{
  m.session.mockResolvedValue({tenantId:'tenant',userId:'hr',roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]});
  m.operator.mockResolvedValue(false);
  const createdAt=new Date().toISOString();
  m.tasks.mockResolvedValue([
   {id:'fictional-attendance',kind:'attendance',subjectName:'Fictional colleague',createdAt,linkPath:'/approvals#attendance'},
   {id:'fictional-profile',kind:'profile',subjectName:'Fictional colleague',createdAt,linkPath:'/admin/personnel/profile-changes#request-fictional-profile'},
  ]);
  const props=sidebarProps(await Layout({children:null}));
  expect(m.tasks).toHaveBeenCalledTimes(1);
  expect(props!.taskCount).toBe(2);
  expect(props!.approvalCount).toBe(1);
  expect(props!.hasAssignedAttendanceApproval).toBe(false);
  expect(props!.canApprove).toBe(false);
  expect(props!.isAdmin).toBe(true);
 });
});
