import React, {isValidElement} from 'react';
import {beforeEach,describe,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({session:vi.fn(),operator:vi.fn(),tasks:vi.fn(),pathname:'/admin/settings/email',onboarded:true,scopeIds:[] as string[],module:vi.fn(),feedback:vi.fn(),notifications:vi.fn(),unread:vi.fn()}));
vi.mock('next/font/google',()=>{const font=()=>({variable:'fixture-font'});return {Plus_Jakarta_Sans:font,Geist_Mono:font,DM_Mono:font};});
vi.mock('next/font/local',()=>({default:()=>({variable:'fixture-schibsted-font'})}));
vi.mock('next/headers',()=>({headers:async()=>new Headers({'x-pathname':m.pathname}),cookies:async()=>({get:()=>undefined})}));
vi.mock('next-intl/server',()=>({getLocale:async()=>'en'}));
vi.mock('../lib/session',()=>({getSession:m.session}));
vi.mock('../lib/identity/email-settings',()=>({canConfigureIdentityEmail:m.operator}));
vi.mock('../lib/viewer',()=>({viewerIdentity:async()=>({name:'Fixture',employeeCode:null,employed:false})}));
vi.mock('../lib/principals',()=>({listPrincipals:async()=>[]}));
vi.mock('../lib/demo-mode',()=>({demoSwitcherEnabled:()=>true,isDemoDeployment:()=>true}));
vi.mock('../lib/scope',()=>({getScopeIds:async()=>m.scopeIds}));
vi.mock('../lib/ui-theme-server',()=>({currentUiTheme:async()=>'monolith'}));
vi.mock('../core/read',()=>({allowedCompanies:async()=>[],listApprovalHistory:async()=>[]}));
vi.mock('../core/onboarding',()=>({getOnboardingStatus:async()=>m.onboarded}));
vi.mock('../packs/lifecycle/service',()=>({onboardingTasks:async()=>[],onboardingUnreadNoticeCount:async()=>0,onboardingNotices:async()=>[],onboardingNavigation:async()=>({module:false,master:false,requisitions:false,joiners:0,checklists:0})}));
vi.mock('../components/onboarding-tour',()=>({OnboardingTour:()=>null}));
vi.mock('../core/assistant-launcher',()=>({assistantLauncherFor:async()=>null}));
vi.mock('../core/assistant-grant',()=>({mayUseAssistant:async()=>({allowed:false,reason:'no_grant'})}));
// New capability owners are independent of SMTP installation enrollment and the legacy rail.
// This shell test controls those boundaries; their actual permission algebra is covered by DB cases.
vi.mock('../core/access-configuration-editor',()=>({canConfigureAccess:async()=>false}));
vi.mock('../core/workforce-access',()=>({workforceViewScope:async()=>({canOpen:false,companyIds:[]})}));
vi.mock('../core/approvals-inbox',()=>({listPendingTasks:m.tasks}));
vi.mock('../core/notifications',()=>({dispatchNotifications:async()=>{},listNotifications:m.notifications,unreadNotificationCount:m.unread}));
vi.mock('../core/entitlements',()=>({isModuleEnabled:m.module,isModuleEnabledOrFalse:m.module,settingEnabledOrDefault:m.feedback}));
vi.mock('../components/command-bar',()=>({CommandBar:()=>null}));
vi.mock('../components/notice/notice-surfaces',()=>({NoticePopupSlot:()=>null}));
vi.mock('../components/user-menu',()=>({UserMenu:()=>null}));
vi.mock('../components/dev-identity-switcher',()=>({DevIdentitySwitcher:()=>null}));
vi.mock('../components/company-switcher',()=>({CompanySwitcher:()=>null}));
import Layout from '../app/layout';
import {NotificationCenter} from '../components/notification-center';
import {Sidebar} from '../components/sidebar';
import {OnboardingTour} from '../components/onboarding-tour';
import {NoticePopupSlot} from '../components/notice/notice-surfaces';
import {WELCOME_TOUR_ID} from '../lib/onboarding-tour';
beforeEach(()=>{m.scopeIds=[];m.module.mockReset();m.module.mockReturnValue(false);m.feedback.mockReset();m.feedback.mockReturnValue(true);m.notifications.mockReset();m.notifications.mockResolvedValue([]);m.unread.mockReset();m.unread.mockResolvedValue(0);m.tasks.mockReset();m.tasks.mockResolvedValue([]);m.pathname='/admin/settings/email';m.onboarded=true;});
function propsOf(node:React.ReactNode,target:unknown):Record<string,unknown>|undefined{
 if(Array.isArray(node)){for(const child of node){const found=propsOf(child,target);if(found)return found;}return;}
 if(!isValidElement<{children?:React.ReactNode}>(node))return;
 if(node.type===target)return node.props;
 return propsOf(node.props.children,target);
}
const sidebarProps=(node:React.ReactNode)=>propsOf(node,Sidebar);
describe('root layout SMTP preview authority',()=>{
 it.each([false,true])('passes the current tenant Feedback setting to the rail when enabled=%s',async(enabled)=>{
  const session={tenantId:'tenant',userId:'user',roles:['employee'],grants:[]};
  m.session.mockResolvedValue(session);m.operator.mockResolvedValue(false);m.feedback.mockReturnValue(enabled);
  const props=sidebarProps(await Layout({children:<span>Fixture content</span>}));
  expect(props).toBeDefined();expect(props!.feedbackAccess).toBe(enabled);
  expect(m.feedback).toHaveBeenCalledExactlyOnceWith(session,'feedback.menu_enabled');
 });
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
  expect(props!.hasAssignedApproval).toBe(true);
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
  expect(props!.hasAssignedApproval).toBe(false);
  expect(props!.canApprove).toBe(false);
  expect(props!.isAdmin).toBe(true);
 });
});


describe('personal Home opens without automatic overlays',()=>{
 it('suppresses the first-login tour and Notice popup on the employee landing path',async()=>{
  m.session.mockResolvedValue({tenantId:'tenant',userId:'employee',roles:['employee'],grants:[]});m.operator.mockResolvedValue(false);
  m.pathname='/';m.onboarded=false;
  const tree=await Layout({children:<main>Personal Home</main>});
  expect(propsOf(tree,OnboardingTour)?.autoStartTourId).toBeNull();expect(propsOf(tree,NoticePopupSlot)).toBeUndefined();
 });
 it('retains existing overlays on other routes and on the administrator workbench',async()=>{
  for(const [pathname,roles] of [['/me',['employee']],['/',['hr_admin']]] as const){
   m.session.mockResolvedValue({tenantId:'tenant',userId:'login',roles:[...roles],grants:[]});m.operator.mockResolvedValue(false);
   m.pathname=pathname;m.onboarded=false;
   const tree=await Layout({children:null});
   expect(propsOf(tree,OnboardingTour)?.autoStartTourId).toBe(WELCOME_TOUR_ID);expect(propsOf(tree,NoticePopupSlot)).toBeDefined();
  }
 });
});

it('loads account notifications for selected company entitlements without an employment or tenant-wide module',async()=>{
 const active='00000000-0000-4000-8000-000000000001',inactive='00000000-0000-4000-8000-000000000002';m.scopeIds=[active,inactive];
 m.module.mockImplementation((_ctx:unknown,code:string,companyId?:string)=>code==='notifications'&&companyId===active);
 m.session.mockResolvedValue({tenantId:'tenant',userId:'account-only-reviewer',roles:['employee'],grants:[]});m.operator.mockResolvedValue(false);
 const tree=await Layout({children:null});expect(propsOf(tree,NotificationCenter)).toBeDefined();
 expect(m.notifications).toHaveBeenCalledTimes(3);for(const [,employmentId,opts]of m.notifications.mock.calls){expect(employmentId).toBeUndefined();expect(opts).toMatchObject({letterCompanyIds:[active]});}
 expect(m.unread).toHaveBeenCalledTimes(2);for(const [,,opts]of m.unread.mock.calls)expect(opts).toMatchObject({letterCompanyIds:[active]});
});
